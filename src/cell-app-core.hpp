// cell-app-core.hpp — the shared runtime of the desktop shell and the web
// service. Everything here is transport-agnostic:
//
//   - event_bus      : one JSON event stream, many sinks (WebView view,
//                      SSE connections, future integrations)
//   - workspace_ctx  : ONE ENGINE CONTEXT PER WORKING DIRECTORY. Each context
//                      owns its own history, runner, turn queue, worker thread,
//                      approval rendezvous and box state, so different
//                      directories run agent turns truly in parallel.
//                      (same cwd = one working session; use Teamwork to
//                      parallelise inside a directory)
//   - app_core       : the workspace registry, config/vault, the command bus
//                      and the approval routing
//   - exec_command   : the entire control surface behind one function, so
//                      window.host_cmd (WebView) and POST /api/cmd/<name>
//                      (HTTP) are the same protocol on two transports.
//                      Commands take an optional "ws" (workspace key); when
//                      omitted they act on the active workspace.
//
// Every event carries "ws" (the workspace key), so one SSE stream can feed
// every tab of the frontend.
//
// Included by cell-app.cpp (desktop) and cell-app-http.hpp (service).
#pragma once

#include <condition_variable>
#include <deque>
#include <map>
#include <set>

namespace app
{
    // =====================================================================
    //  event_bus — serialized JSON events, delivered to every registered
    //  sink. Publish never blocks on a slow sink: each sink owns its own
    //  queueing. A throwing sink is dropped silently (it unregisters
    //  itself).
    // =====================================================================
    class event_bus
    {
    public:
        using sink_fn = std::function<void(const std::string &json_line)>;
        int add(sink_fn fn)
        {
            std::lock_guard<std::mutex> lk(mx_);
            int id = next_++;
            sinks_.emplace(id, std::move(fn));
            return id;
        }
        void remove(int id)
        {
            std::lock_guard<std::mutex> lk(mx_);
            sinks_.erase(id);
        }
        void post(const nlohmann::json &ev)
        {
            // non-UTF-8 bytes must not take the whole event down
            std::string line = ev.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
            std::vector<sink_fn> copy;
            {
                std::lock_guard<std::mutex> lk(mx_);
                copy.reserve(sinks_.size());
                for (auto &[id, fn] : sinks_)
                    copy.push_back(fn);
            }
            for (auto &fn : copy)
            {
                try
                {
                    fn(line);
                }
                catch (...)
                {
                }
            }
        }

    private:
        std::mutex mx_;
        std::map<int, sink_fn> sinks_;
        int next_ = 1;
    };

    // =====================================================================
    //  workspace_ctx — one engine context per working directory.
    // =====================================================================
    struct workspace_ctx
    {
        std::string cwd;     // absolute workspace directory
        std::string cwd_key; // session-group key (cell::cwd_id_of)
        cell::chat::history h;      // session history bound to this cwd
        cell::box::context box_ctx; // per-context box state (read log / caches)
        std::unique_ptr<cell::engine::runner> eng;
        cell::engine::runner::prompt_info prompt;

        // ---- turn worker (one turn at a time per workspace) --------------
        std::mutex qmx;
        std::condition_variable qcv;
        std::deque<std::string> turns;
        bool quit = false;
        std::thread worker;
        std::atomic<bool> stop{false};
        std::atomic<bool> busy{false};

        // ---- approval rendezvous (per workspace) -------------------------
        // the engine thread blocks on acv until any client answers; the id
        // set tracks which ids this context is actually waiting for
        std::mutex amx;
        std::condition_variable acv;
        std::set<std::string> ap_pending;
        std::map<std::string, int> ap_answers;

        explicit workspace_ctx(std::string dir)
            : cwd(std::move(dir)), cwd_key(cell::cwd_id_of(cwd)), h(cwd)
        {
            h.set_box_context(&box_ctx);
        }
        workspace_ctx(const workspace_ctx &) = delete;
        workspace_ctx &operator=(const workspace_ctx &) = delete;

        void queue_turn(std::string text)
        {
            if (text.empty())
                return;
            std::lock_guard<std::mutex> lk(qmx);
            turns.push_back(std::move(text));
            qcv.notify_all();
        }
        void request_stop() { stop.store(true); }
    };

    // =====================================================================
    //  app_core — everything an instance of the shell owns.
    // =====================================================================
    struct app_core
    {
        cell::config::settings cfg; // global (shared by every workspace)
        cell::encrypt::crypt vault; // global
        event_bus bus;              // global
        // optional observer for every incoming command name (the smoke tests
        // hook here to detect the page's boot sequence)
        std::function<void(const std::string &)> on_command;

        // ---- workspace registry -----------------------------------------
        std::mutex ctx_mx;
        std::map<std::string, std::unique_ptr<workspace_ctx>> ctxs; // key = cwd_key
        std::string active_ws;

        std::atomic<int> ap_seq{0}; // approval ids are globally unique

        // ---- command serialization --------------------------------------
        // guards cfg / vault / ctx lifecycle across the UI thread and the
        // HTTP threads; one command runs at a time
        std::mutex cmd_mx;

        // commands in flight across all transports; the exit path waits for
        // them before tearing the process down
        std::atomic<int> inflight{0};
        std::mutex inflight_mx;
        std::condition_variable inflight_cv;
        std::atomic<bool> shutting_down{false};

        void wait_idle(std::chrono::milliseconds timeout = std::chrono::milliseconds(10000))
        {
            std::unique_lock<std::mutex> lk(inflight_mx);
            inflight_cv.wait_for(lk, timeout, [&]
                                 { return inflight.load() == 0; });
        }

        // -----------------------------------------------------------------
        //  workspace lifecycle
        // -----------------------------------------------------------------
        workspace_ctx *find_ws(const std::string &ws)
        {
            std::lock_guard<std::mutex> lk(ctx_mx);
            auto it = ctxs.find(ws);
            return it == ctxs.end() ? nullptr : it->second.get();
        }
        workspace_ctx *target_ctx(const nlohmann::json &args)
        {
            std::string ws = args.value("ws", "");
            std::lock_guard<std::mutex> lk(ctx_mx);
            auto it = ws.empty() ? ctxs.find(active_ws) : ctxs.find(ws);
            return it == ctxs.end() ? nullptr : it->second.get();
        }
        std::vector<workspace_ctx *> all_ctxs()
        {
            std::vector<workspace_ctx *> out;
            std::lock_guard<std::mutex> lk(ctx_mx);
            for (auto &[k, c] : ctxs)
                out.push_back(c.get());
            return out;
        }
        // open (or return) the context of a directory; callers hold cmd_mx
        workspace_ctx *ensure_workspace(const std::string &dir, std::string *err, const std::string &prefer_session = "")
        {
            std::error_code ec;
            std::filesystem::path p = std::filesystem::absolute(dir, ec);
            if (ec || p.empty())
            {
                if (err)
                    *err = "invalid directory: " + dir;
                return nullptr;
            }
            if (!std::filesystem::is_directory(p, ec))
            {
                if (err)
                    *err = "not a directory: " + p.string();
                return nullptr;
            }
            std::string key = cell::cwd_id_of(p);
            {
                std::lock_guard<std::mutex> lk(ctx_mx);
                if (auto it = ctxs.find(key); it != ctxs.end())
                    return it->second.get();
            }
            auto u = std::make_unique<workspace_ctx>(p.string());
            // resume a session: explicit request wins, then the last-used
            // record of this directory, then the newest transcript in it
            std::string boot = prefer_session;
            if (!boot.empty() && (!cell::is_valid_session_id(boot) || cell::session_prefix(boot) != key))
                boot.clear();
            if (boot.empty())
                if (auto it = cfg.active_sessions.find(key); it != cfg.active_sessions.end())
                    if (cell::is_valid_session_id(it->second) && cell::session_prefix(it->second) == key)
                        boot = it->second;
            if (boot.empty())
                boot = cell::chat::latest_session_id_for_cwd(key);
            if (!boot.empty())
                u->h.use(boot);
            if (size_t recovered = cell::teamwork::recover_interrupted(u->h.now().id()))
                cell::sys::logger::instance().warn("teamwork", std::format("boot recovery marked {} job(s) failed ws={}", recovered, key));
            cfg.active_sessions[key] = u->h.now().id();
            u->eng = std::make_unique<cell::engine::runner>(cfg, vault, u->h);
            u->prompt = u->eng->ensure_prompt();
            u->worker = std::thread([this, ptr = u.get()]
                                    { worker_loop(*ptr); });
            {
                std::lock_guard<std::mutex> lk(ctx_mx);
                ctxs[key] = std::move(u);
                return ctxs[key].get();
            }
        }
        // remember every context's current session (the CLI writes the same
        // map from its exit path; a multi-workspace shell maintains one entry
        // per directory itself and saves with track_active=false)
        void sync_active_sessions()
        {
            for (auto *c : all_ctxs())
                cfg.active_sessions[c->cwd_key] = c->h.now().id();
        }
        bool save_cfg()
        {
            sync_active_sessions();
            return cell::config::save(cfg, false);
        }
        void shutdown()
        {
            shutting_down.store(true);
            auto all = all_ctxs();
            for (auto *c : all)
            {
                c->stop.store(true);
                {
                    std::lock_guard<std::mutex> lk(c->qmx);
                    c->quit = true;
                }
                c->qcv.notify_all();
                c->acv.notify_all();
            }
            for (auto *c : all)
                if (c->worker.joinable())
                    c->worker.join();
        }

        // -----------------------------------------------------------------
        //  approval routing (any client answers; every client hears it)
        // -----------------------------------------------------------------
        bool request_approval(workspace_ctx &ctx, const std::string &tool, const std::string &args, std::string &reason)
        {
            if (shutting_down.load())
            {
                reason = "shutting down";
                return false;
            }
            std::string id = std::format("ap-{}", ++ap_seq);
            {
                std::lock_guard<std::mutex> lk(ctx.amx);
                ctx.ap_pending.insert(id);
            }
            nlohmann::json e = {{"t", "approval"},
                                {"id", id},
                                {"ws", ctx.cwd_key},
                                {"tool", tool},
                                {"args", args.size() > 4096 ? args.substr(0, 4096) + "..." : args}};
            bus.post(e);
            std::unique_lock<std::mutex> lk(ctx.amx);
            ctx.acv.wait(lk, [&]
                         { return ctx.ap_answers.count(id) > 0 || shutting_down.load(); });
            ctx.ap_pending.erase(id);
            auto it = ctx.ap_answers.find(id);
            if (it == ctx.ap_answers.end()) // shutting down
            {
                reason = "shutting down";
                return false;
            }
            int ans = it->second;
            ctx.ap_answers.erase(it);
            if (!ans)
            {
                reason = "rejected by user";
                return false;
            }
            return true;
        }
        // called from any client; the first answer wins, all clients hear it
        void resolve_approval(const std::string &ws, const std::string &id, bool allow)
        {
            std::vector<workspace_ctx *> candidates;
            {
                std::lock_guard<std::mutex> lk(ctx_mx);
                if (!ws.empty())
                {
                    if (auto it = ctxs.find(ws); it != ctxs.end())
                        candidates.push_back(it->second.get());
                }
                else
                    for (auto &[k, c] : ctxs)
                        candidates.push_back(c.get());
            }
            for (auto *c : candidates)
            {
                {
                    std::lock_guard<std::mutex> lk(c->amx);
                    if (!c->ap_pending.count(id))
                        continue;
                    if (c->ap_answers.count(id))
                        return; // already answered
                    c->ap_answers[id] = allow ? 1 : 0;
                }
                c->acv.notify_all();
                nlohmann::json e = {{"t", "approval_resolved"}, {"id", id}, {"ws", c->cwd_key}, {"allow", allow}};
                bus.post(e);
                return;
            }
        }

        // -----------------------------------------------------------------
        //  engine events -> bus (every event tagged with its workspace)
        // -----------------------------------------------------------------
        cell::engine::events make_events(workspace_ctx &ctx)
        {
            const std::string ws = ctx.cwd_key;
            auto post = [this, ws](nlohmann::json e)
            { e["ws"] = ws; bus.post(e); };
            cell::engine::events ev;
            ev.on_answer = [post](std::string_view d)
            { post({{"t", "answer"}, {"d", std::string(d)}}); };
            ev.on_reason = [post](std::string_view d)
            { post({{"t", "reason"}, {"d", std::string(d)}}); };
            ev.on_summary = [post](std::string_view d)
            { post({{"t", "summary"}, {"d", std::string(d)}}); };
            ev.on_answer_begin = [post]()
            { post({{"t", "answer_begin"}}); };
            ev.on_progress = [post](long long ms)
            { post({{"t", "progress"}, {"ms", ms}}); };
            ev.on_status = [post](std::string_view d)
            { post({{"t", "status"}, {"d", std::string(d)}}); };
            ev.on_error = [post](std::string_view d)
            { post({{"t", "error"}, {"d", std::string(d)}}); };
            // structured notices carry the rendered text AND the raw record
            // (the frontends fold/group by from/topic themselves)
            ev.on_notice_msg = [post](const cell::notice::message &m)
            { post({{"t", "notice"},
                    {"d", cell::notice::render(m)},
                    {"nid", m.id},
                    {"from", m.from},
                    {"topic", m.topic},
                    {"body", m.body},
                    {"created_at", m.created_at}}); };
            ev.on_round_end = [post](const cell::engine::round_view &r)
            { post({{"t", "round"},
                    {"round", r.round},
                    {"tok_in", r.tok_in},
                    {"tok_out", r.tok_out},
                    {"cache", r.cache_hit},
                    {"sec", r.seconds},
                    {"ttft", r.ttft}}); };
            ev.on_tool_begin = [post](const cell::engine::tool_view &tv)
            { post({{"t", "tool_begin"}, {"seq", tv.seq}, {"name", tv.name}, {"args", tv.args}, {"policy", tv.policy}}); };
            ev.on_tool_end = [post](const cell::engine::tool_view &tv)
            { post({{"t", "tool_end"},
                    {"seq", tv.seq},
                    {"name", tv.name},
                    {"status", tv.status},
                    {"display", tv.display},
                    {"marker", tv.marker},
                    {"sec", tv.sec},
                    {"chars", tv.chars},
                    {"multimodal", tv.multimodal}}); };
            ev.on_approval = [this, &ctx](const std::string &tool, const std::string &args, std::string &reason) -> bool
            { return request_approval(ctx, tool, args, reason); };
            ev.cancelled = [this, &ctx]() -> bool
            { return ctx.stop.load() || shutting_down.load(); };
            ev.cancel_reason = "interrupted by the user (stop button) during streaming";
            ev.on_turn_end = [post](const cell::engine::turn_view &tv)
            { post({{"t", "turn_end"},
                    {"natural", tv.natural_end},
                    {"rounds", tv.rounds},
                    {"tool_calls", tv.tool_calls}}); };
            return ev;
        }

        // -----------------------------------------------------------------
        //  turn worker: one queued user message at a time per workspace
        // -----------------------------------------------------------------
        void worker_loop(workspace_ctx &ctx)
        {
            auto &log = cell::sys::logger::instance();
            while (true)
            {
                std::string text;
                {
                    std::unique_lock<std::mutex> lk(ctx.qmx);
                    ctx.qcv.wait(lk, [&]
                                 { return ctx.quit || !ctx.turns.empty(); });
                    if (ctx.quit && ctx.turns.empty())
                        return;
                    text = std::move(ctx.turns.front());
                    ctx.turns.pop_front();
                }
                ctx.stop.store(false);
                ctx.busy.store(true);
                {
                    nlohmann::json e = {{"t", "turn_begin"}, {"ws", ctx.cwd_key}};
                    bus.post(e);
                }
                auto ev = make_events(ctx);
                try
                {
                    ctx.eng->run_turn(text, false, ev);
                }
                catch (const std::exception &e)
                {
                    log.error("app", std::format("turn crashed ws={}: {}", ctx.cwd_key, e.what()));
                    nlohmann::json er = {{"t", "error"}, {"ws", ctx.cwd_key}, {"d", std::format("unhandled error: {}", e.what())}};
                    bus.post(er);
                    nlohmann::json te = {{"t", "turn_end"}, {"ws", ctx.cwd_key}, {"natural", false}, {"rounds", 0}, {"tool_calls", 0}};
                    bus.post(te);
                }
                ctx.busy.store(false);
            }
        }

        // -----------------------------------------------------------------
        //  state snapshots
        // -----------------------------------------------------------------
        nlohmann::json providers_json() const
        {
            nlohmann::json arr = nlohmann::json::array();
            for (size_t i = 0; i < cfg.providers.size(); i++)
            {
                auto &p = cfg.providers[i];
                bool cur = (p.name == cfg.current_provider) || (cfg.current_provider.empty() && i == 0);
                arr.push_back({{"name", p.name},
                               {"api_style", p.api_style},
                               {"base", p.base},
                               {"proxy", p.proxy},
                               {"has_key", !p.key_id.empty() && vault.has(p.key_id)},
                               {"current", cur}});
            }
            return arr;
        }
        nlohmann::json settings_json() const
        {
            nlohmann::json s;
            s["think_level"] = cfg.think_level;
            s["tools"] = cfg.tools;
            s["sandbox_mode"] = cell::box::mode_name(cell::box::sandbox_mode());
            s["autoallow"] = cfg.autoallow;
            s["compact_auto"] = cfg.compact_auto;
            s["compact_provider"] = cfg.compact_provider;
            s["compact_model"] = cfg.compact_model;
            s["system_prompt"] = cfg.system_prompt;
            s["teamwork_max_children"] = cfg.teamwork_max_children;
            s["max_threads"] = cfg.max_threads;
            return s;
        }
        nlohmann::json workspaces_json()
        {
            nlohmann::json arr = nlohmann::json::array();
            std::lock_guard<std::mutex> lk(ctx_mx);
            for (auto &[k, c] : ctxs)
                arr.push_back({{"ws", k},
                               {"cwd", c->cwd},
                               {"session", c->h.now().id()},
                               {"busy", c->busy.load()},
                               {"active", k == active_ws}});
            return arr;
        }
        // transcript preview: user/assistant text only, newest last.
        // Only safe while no turn is running (the worker owns the array).
        static nlohmann::json history_json(workspace_ctx &c, size_t cap = 40)
        {
            nlohmann::json hist = nlohmann::json::array();
            std::vector<nlohmann::json> recent;
            for (auto &m : c.h.now().msg())
            {
                if (!m.is_object())
                    continue;
                std::string text = cell::chat::message_display_text(m);
                if (text.empty())
                    continue;
                recent.push_back({{"role", m.value("role", "")}, {"text", text}});
            }
            size_t start = recent.size() > cap ? recent.size() - cap : 0;
            for (size_t i = start; i < recent.size(); i++)
                hist.push_back(recent[i]);
            return hist;
        }
        // ---- transcript shaping for the detail view ----------------------
        // plain text of a message content (string, or the text blocks of an
        // array); "" when there is none
        static std::string content_text(const nlohmann::json &m)
        {
            auto it = m.find("content");
            if (it == m.end() || it->is_null())
                return "";
            if (it->is_string())
                return it->get<std::string>();
            if (!it->is_array())
                return "";
            std::string text;
            for (auto &b : *it)
            {
                if (!b.is_object())
                    continue;
                if (b.value("type", "") != "text" || !b.contains("text") || !b["text"].is_string())
                    continue;
                if (!text.empty())
                    text += "\n";
                text += b["text"].get_ref<const std::string &>();
            }
            return text;
        }
        // tool results carried by one message, in order: role=tool bodies and
        // user tool_result blocks (the Anthropic-style carrier)
        static void tool_results_of(const nlohmann::json &m, std::vector<std::string> &results)
        {
            std::string role = m.value("role", "");
            if (role == "tool")
            {
                results.push_back(content_text(m));
                return;
            }
            if (role != "user")
                return;
            auto it = m.find("content");
            if (it == m.end() || !it->is_array())
                return;
            for (auto &b : *it)
            {
                if (!b.is_object() || b.value("type", "") != "tool_result")
                    continue;
                auto c = b.find("content");
                if (c == b.end() || c->is_null())
                    continue;
                if (c->is_string())
                    results.push_back(c->get<std::string>());
                else if (c->is_array())
                    results.push_back(content_text(nlohmann::json::object({{"content", *c}})));
            }
        }
        static std::string cap_text(std::string s, size_t cap = 8000)
        {
            if (s.size() <= cap)
                return s;
            size_t cut = cap;
            while (cut > 0 && ((unsigned char)s[cut] & 0xC0) == 0x80)
                cut--; // never split a UTF-8 sequence
            return s.substr(0, cut) + "\n…";
        }
        // --------------------------------------------------------------
        //  compaction summary (see cell::engine::runner::compact and the
        //  teamwork worker path): the summary is stored as an ordinary
        //  {"role":"assistant","content": …} message whose content starts
        //  with one of these headings — the UI renders it as a collapsed
        //  "上下文摘要" card instead of a normal assistant turn. Older
        //  sessions may carry the same block folded into the system prompt,
        //  so the split works on any message text.
        // --------------------------------------------------------------
        static const std::vector<std::string> &summary_marks()
        {
            static const std::vector<std::string> kMarks = {
                "# Here is a summary that captures the previous conversation:",
                "# Context was compacted to fit the model window.",
            };
            return kMarks;
        }
        // returns npos when the text holds no compaction summary
        static size_t summary_mark_at(const std::string &text)
        {
            size_t best = std::string::npos;
            for (const auto &m : summary_marks())
            {
                size_t p = text.find(m);
                if (p != std::string::npos && (best == std::string::npos || p < best))
                    best = p;
            }
            return best;
        }

        // shape a whole transcript into ordered UI entries: user/assistant
        // text, system notices, and tool calls paired with their results
        static nlohmann::json history_entries(const nlohmann::json &messages)
        {
            nlohmann::json out = nlohmann::json::array();
            for (size_t i = 0; i < messages.size(); i++)
            {
                const auto &m = messages[i];
                if (!m.is_object())
                    continue;
                std::string role = m.value("role", "");
                if (role == "system")
                {
                    std::string text = content_text(m);
                    // an old session can carry the compaction summary inside
                    // the folded system block: split it back out
                    size_t at = summary_mark_at(text);
                    if (at != std::string::npos)
                    {
                        std::string pre = text.substr(0, at);
                        while (!pre.empty() && (pre.back() == '\n' || pre.back() == ' '))
                            pre.pop_back();
                        if (!pre.empty())
                            out.push_back({{"role", "system"}, {"kind", "system"}, {"text", cap_text(pre)}});
                        out.push_back({{"role", "system"}, {"kind", "summary"}, {"text", cap_text(text.substr(at))}});
                        continue;
                    }
                    if (!text.empty())
                        out.push_back({{"role", "system"}, {"kind", "system"}, {"text", cap_text(text)}});
                    continue;
                }
                if (role == "user" || role == "tool")
                {
                    std::vector<std::string> results;
                    tool_results_of(m, results);
                    if (results.empty() && role == "tool")
                        results.push_back(content_text(m));
                    if (!results.empty())
                    {
                        for (auto &r : results)
                            if (!r.empty())
                                out.push_back({{"role", "tool"}, {"kind", "tool_result"}, {"text", cap_text(r)}});
                        continue;
                    }
                    std::string text = content_text(m);
                    if (!text.empty())
                        out.push_back({{"role", "user"}, {"kind", "user"}, {"text", cap_text(text)}});
                    continue;
                }
                if (role != "assistant")
                    continue;
                auto content = m.find("content");
                if (content != m.end() && content->is_array())
                {
                    // 内容块按落盘顺序展开：reasoning/thinking → 思考条目，
                    // text → 正文/摘要条目。数组形式（reasoning_content_array）
                    // 里思考块在前、正文在后，逐块输出才能保留这个顺序——
                    // content_text() 只取 text 块，会把思考整段丢掉。
                    for (auto &b : *content)
                    {
                        if (!b.is_object())
                            continue;
                        std::string bt = b.value("type", "");
                        if (bt == "reasoning" || bt == "thinking")
                        {
                            std::string body = b.value(bt, std::string());
                            if (!body.empty())
                                out.push_back({{"role", "assistant"}, {"kind", "reasoning"}, {"text", cap_text(body)}});
                            continue;
                        }
                        if (bt != "text")
                            continue;
                        std::string text = b.value("text", std::string());
                        size_t at = summary_mark_at(text);
                        if (at != std::string::npos)
                        {
                            std::string pre = text.substr(0, at);
                            while (!pre.empty() && (pre.back() == '\n' || pre.back() == ' '))
                                pre.pop_back();
                            if (!pre.empty())
                                out.push_back({{"role", "assistant"}, {"kind", "assistant"}, {"text", cap_text(pre)}});
                            out.push_back({{"role", "assistant"}, {"kind", "summary"}, {"text", cap_text(text.substr(at))}});
                        }
                        else if (!text.empty())
                            out.push_back({{"role", "assistant"}, {"kind", "assistant"}, {"text", cap_text(text)}});
                    }
                }
                else
                {
                    std::string text = content_text(m);
                    // the compaction summary is an assistant message: surface it
                    // as its own entry so the UI can fold it into a summary card
                    size_t at = summary_mark_at(text);
                    if (at != std::string::npos)
                    {
                        std::string pre = text.substr(0, at);
                        while (!pre.empty() && (pre.back() == '\n' || pre.back() == ' '))
                            pre.pop_back();
                        if (!pre.empty())
                            out.push_back({{"role", "assistant"}, {"kind", "assistant"}, {"text", cap_text(pre)}});
                        out.push_back({{"role", "assistant"}, {"kind", "summary"}, {"text", cap_text(text.substr(at))}});
                    }
                    else if (!text.empty())
                        out.push_back({{"role", "assistant"}, {"kind", "assistant"}, {"text", cap_text(text)}});
                }
                auto tc = m.find("tool_calls");
                if (tc == m.end() || !tc->is_array() || tc->empty())
                    continue;
                std::vector<std::string> names, args;
                for (auto &c : *tc)
                {
                    if (!c.is_object())
                        continue;
                    std::string fn = "tool", a;
                    if (c.contains("function") && c["function"].is_object())
                    {
                        fn = c["function"].value("name", "tool");
                        a = c["function"].value("arguments", "");
                    }
                    else
                    {
                        fn = c.value("name", "tool");
                        auto in = c.find("input");
                        if (in != c.end())
                            a = in->is_string() ? in->get<std::string>() : in->dump();
                    }
                    names.push_back(fn);
                    args.push_back(a);
                }
                if (names.empty())
                    continue;
                // pair the calls with the results that follow in transcript order
                std::vector<std::string> results;
                for (size_t j = i + 1; j < messages.size() && results.size() < names.size(); j++)
                {
                    const auto &m2 = messages[j];
                    if (!m2.is_object())
                        break;
                    std::string r2 = m2.value("role", "");
                    if (r2 != "tool" && r2 != "user")
                        break;
                    std::vector<std::string> rs;
                    tool_results_of(m2, rs);
                    if (rs.empty())
                        break;
                    for (auto &r : rs)
                        results.push_back(r);
                    i = j;
                }
                for (size_t k = 0; k < names.size(); k++)
                {
                    nlohmann::json e = {{"role", "tool"}, {"kind", "tool"},
                                        {"name", names[k]}, {"args", cap_text(args[k], 4000)}};
                    if (k < results.size())
                    {
                        e["result"] = cap_text(results[k]);
                        e["status"] = "ok";
                    }
                    out.push_back(std::move(e));
                }
            }
            return out;
        }
        // list a session's compaction archives (saved/*.jsonl): name, mtime,
        // msgs — no transcript read, so the dock shelf can refresh cheaply
        static void read_session_archives(const std::string &id, nlohmann::json &archives)
        {
            std::error_code ec;
            auto saved = cell::session_dir(id) / "saved";
            if (!std::filesystem::is_directory(saved, ec))
                return;
            for (auto &e : std::filesystem::directory_iterator(saved, ec))
            {
                if (ec)
                    break;
                if (!e.is_regular_file(ec) || e.path().extension() != ".jsonl")
                    continue;
                std::ifstream af(e.path(), std::ios::binary);
                size_t n = (size_t)std::count(std::istreambuf_iterator<char>(af),
                                              std::istreambuf_iterator<char>(), '\n');
                auto ft = std::filesystem::last_write_time(e.path(), ec);
                long long mt = 0;
                if (!ec)
                    mt = (long long)std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::clock_cast<std::chrono::system_clock>(ft).time_since_epoch())
                             .count();
                archives.push_back({{"name", e.path().filename().string()}, {"mtime", mt}, {"msgs", n}});
            }
            std::sort(archives.begin(), archives.end(), [](const nlohmann::json &a, const nlohmann::json &b)
                      { return a.value("name", "") > b.value("name", ""); });
        }
        // read a session transcript + its compaction archives from disk
        static void read_session_files(const std::string &id, nlohmann::json &messages, nlohmann::json &archives)
        {
            std::error_code ec;
            auto dir = cell::session_dir(id);
            auto file = dir / "messages.jsonl";
            if (std::filesystem::exists(file, ec))
            {
                std::ifstream f(file, std::ios::binary);
                std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                messages = cell::chat::parse_messages_jsonl(text);
            }
            read_session_archives(id, archives);
        }
        nlohmann::json build_state_for(workspace_ctx *c, bool with_history, bool with_teamwork = true)
        {
            nlohmann::json st;
            st["t"] = "hello"; // the frontends rebuild their whole view on this
            st["workspaces"] = workspaces_json();
            st["active"] = c ? c->cwd_key : "";
            // 全局状态与工作区无关：零工作区启动是常态，供应商列表 / 设置
            // 必须在无工作区的 hello 里就带出去，否则设置页永远显示为空
            st["model"] = cfg.model_label();
            st["provider"] = cfg.providers.empty()
                                 ? ""
                                 : (cfg.current_provider.empty() ? cfg.providers[0].name : cfg.current_provider);
            st["sandbox"] = cell::box::mode_name(cell::box::sandbox_mode());
            st["tools"] = cfg.tools;
            st["providers"] = providers_json();
            st["settings"] = settings_json();
            if (!c)
            {
                st["session"] = "";
                st["cwd"] = "";
                st["busy"] = false;
                st["history"] = nlohmann::json::array();
                st["teamwork"] = nlohmann::json::array();
                return st;
            }
            st["ws"] = c->cwd_key;
            st["session"] = c->h.now().id();
            st["cwd"] = c->cwd;
            st["busy"] = c->busy.load();
            st["promptChars"] = c->prompt.prompt_chars;
            st["skills"] = c->prompt.skill_count;
            st["promptInjected"] = c->prompt.injected;
            if (with_history)
                st["history"] = c->busy.load() ? nlohmann::json() : history_json(*c);
            if (with_teamwork)
                st["teamwork"] = teamwork_list(*c);
            return st;
        }
        nlohmann::json build_state(bool with_history, bool with_teamwork = true)
        {
            workspace_ctx *c = nullptr;
            {
                std::lock_guard<std::mutex> lk(ctx_mx);
                if (auto it = ctxs.find(active_ws); it != ctxs.end())
                    c = it->second.get();
            }
            return build_state_for(c, with_history, with_teamwork);
        }

        // -----------------------------------------------------------------
        //  sessions
        // -----------------------------------------------------------------
        // the first user message of a transcript, truncated: the sidebar title
        static std::string session_title(const std::filesystem::path &file, size_t max_lines = 200)
        {
            std::ifstream f(file, std::ios::binary);
            if (!f)
                return "";
            std::string line;
            for (size_t i = 0; i < max_lines && std::getline(f, line); i++)
            {
                auto j = nlohmann::json::parse(line, nullptr, false);
                if (!j.is_object() || j.value("role", "") != "user")
                    continue;
                std::string text = cell::chat::message_display_text(j);
                if (text.empty())
                    continue;
                std::string flat;
                flat.reserve(text.size());
                for (char ch : text)
                    flat += (ch == '\n' || ch == '\t' || ch == '\r') ? ' ' : ch;
                if (flat.size() > 80)
                {
                    // truncate on a UTF-8 boundary so the JSON stays valid
                    size_t cut = 80;
                    while (cut > 0 && ((unsigned char)flat[cut] & 0xC0) == 0x80)
                        cut--;
                    flat = flat.substr(0, cut) + "...";
                }
                return flat;
            }
            return "";
        }
        nlohmann::json sessions_list(size_t cap = 200)
        {
            struct row
            {
                std::string id, group, cwd, title;
                long long mtime = 0;
                size_t msgs = 0, jobs = 0, archives = 0;
            };
            std::vector<row> rows;
            std::error_code ec;
            std::filesystem::path base = cell::root / "sessions";
            if (std::filesystem::is_directory(base, ec))
                for (auto &g : std::filesystem::directory_iterator(base, ec))
                {
                    if (ec)
                        break;
                    if (!g.is_directory(ec))
                        continue;
                    for (auto &s : std::filesystem::directory_iterator(g.path(), ec))
                    {
                        if (ec)
                            break;
                        if (!s.is_directory(ec))
                            continue;
                        row r;
                        r.id = s.path().filename().string();
                        r.group = g.path().filename().string();
                        r.cwd = cell::cwd_for_key(cell::session_prefix(r.id));
                        std::error_code tec;
                        auto tf = s.path() / "messages.jsonl";
                        if (std::filesystem::exists(tf, tec))
                        {
                            auto ft = std::filesystem::last_write_time(tf, tec);
                            if (!tec)
                            {
                                // file_clock's epoch is not unix time (it is not
                                // even monotone across toolchains); clock_cast
                                // is the portable way to compare/display it
                                auto sys = std::chrono::clock_cast<std::chrono::system_clock>(ft);
                                r.mtime = (long long)std::chrono::duration_cast<std::chrono::seconds>(sys.time_since_epoch()).count();
                            }
                            std::ifstream mf(tf, std::ios::binary);
                            r.msgs = (size_t)std::count(std::istreambuf_iterator<char>(mf),
                                                        std::istreambuf_iterator<char>(), '\n');
                            r.title = session_title(tf);
                        }
                        // Teamwork 记录数（供侧栏徽标与详情视图判断）
                        auto twf = s.path() / "teamworks.json";
                        if (std::filesystem::is_regular_file(twf, tec) && std::filesystem::file_size(twf, tec) < 4u * 1024 * 1024)
                        {
                            std::ifstream jf(twf, std::ios::binary);
                            auto j = nlohmann::json::parse(jf, nullptr, false);
                            if (j.is_object() && j.contains("jobs") && j["jobs"].is_object())
                                r.jobs = j["jobs"].size();
                        }
                        // 压缩前的历史存档数
                        auto sv = s.path() / "saved";
                        if (std::filesystem::is_directory(sv, tec))
                            for (auto &a : std::filesystem::directory_iterator(sv, tec))
                            {
                                if (tec)
                                    break;
                                if (a.is_regular_file(tec) && a.path().extension() == ".jsonl")
                                    r.archives++;
                            }
                        rows.push_back(std::move(r));
                    }
                }
            std::sort(rows.begin(), rows.end(), [](const row &a, const row &b)
                      { return a.mtime > b.mtime; });
            nlohmann::json out = nlohmann::json::array();
            for (size_t i = 0; i < rows.size() && i < cap; i++)
            {
                workspace_ctx *cur = find_ws(rows[i].group);
                out.push_back({{"id", rows[i].id},
                               {"ws", rows[i].group},
                               {"group", rows[i].group},
                               {"cwd", rows[i].cwd},
                               {"title", rows[i].title},
                               {"mtime", rows[i].mtime},
                               {"msgs", rows[i].msgs},
                               {"jobs", rows[i].jobs},
                               {"archives", rows[i].archives},
                               {"active", cur && cur->h.now().id() == rows[i].id},
                               {"busy", cur && cur->busy.load()},
                               {"open", cur != nullptr}});
            }
            return out;
        }

        // -----------------------------------------------------------------
        //  teamwork (structured views of a workspace's job store)
        // -----------------------------------------------------------------
        static nlohmann::json teamwork_list(workspace_ctx &ctx)
        {
            nlohmann::json out = nlohmann::json::array();
            nlohmann::json store = cell::teamwork::load_store(ctx.h.now().id());
            auto jobs = store.find("jobs");
            if (jobs == store.end() || !jobs->is_object())
                return out;
            for (auto &[id, job] : jobs->items())
            {
                if (!job.is_object())
                    continue;
                nlohmann::json j;
                j["id"] = id;
                j["status"] = job.value("status", "pending");
                j["work_type"] = job.value("work_type", "serial");
                j["created_at"] = job.value("created_at", 0LL);
                if (job.contains("provider") && job["provider"].is_string())
                    j["provider"] = job["provider"];
                if (job.contains("model") && job["model"].is_string())
                    j["model"] = job["model"];
                if (job.contains("error") && job["error"].is_string())
                    j["error"] = job["error"];
                if (job.contains("workflow") && job["workflow"].is_object())
                {
                    auto &wf = job["workflow"];
                    if (wf.contains("stages") && wf["stages"].is_array())
                        j["stages"] = wf["stages"];
                    if (wf.contains("file") && wf["file"].is_string())
                        j["workflow_file"] = wf["file"];
                }
                if (job.contains("current_stage"))
                    j["current_stage"] = job.value("current_stage", -1LL);
                if (job.contains("next_stage"))
                    j["next_stage"] = job.value("next_stage", 0LL);
                nlohmann::json ws = nlohmann::json::array();
                auto list = job.find("list");
                if (list != job.end() && list->is_array())
                {
                    size_t idx = 0;
                    for (auto &w : *list)
                    {
                        if (!w.is_object())
                            continue;
                        nlohmann::json wj;
                        std::string wname = w.value("name", std::format("worker_{}", idx));
                        idx++;
                        wj["name"] = wname;
                        for (const char *k : {"background", "works", "provider", "model", "reuse", "edit_rules", "stage", "stage_name"})
                            if (w.contains(k) && w[k].is_string())
                                wj[k] = w[k];
                        if (w.contains("think") && w["think"].is_number_integer())
                            wj["think"] = cell::config::settings::think_level_name((int)w["think"].get<long long>());
                        if (w.contains("editable") && w["editable"].is_array())
                            wj["editable"] = w["editable"];
                        if (job.contains("summary_reports") && job["summary_reports"].is_object())
                        {
                            auto r = job["summary_reports"].find(wname);
                            if (r != job["summary_reports"].end() && r->is_object())
                            {
                                wj["report_status"] = r->value("status", "");
                                wj["rounds"] = r->value("rounds", 0LL);
                                wj["tool_calls"] = r->value("tool_calls", 0LL);
                                wj["reviews_approved"] = r->value("reviews_approved", 0LL);
                                wj["reviews_denied"] = r->value("reviews_denied", 0LL);
                                wj["has_report"] = true;
                            }
                        }
                        ws.push_back(std::move(wj));
                    }
                }
                j["workers"] = ws;
                out.push_back(std::move(j));
            }
            std::sort(out.begin(), out.end(), [](const nlohmann::json &a, const nlohmann::json &b)
                      { return a.value("created_at", 0LL) > b.value("created_at", 0LL); });
            return out;
        }
        static std::string teamwork_report(workspace_ctx &ctx, const std::string &job_id, const std::string &worker, std::string &report)
        {
            if (job_id.empty() || worker.empty())
                return "job and worker are required";
            if (!cell::teamwork::get_report(job_id, worker, report, ctx.h.now().id()))
                return report.empty() ? "report not found" : report;
            return "";
        }
        // a child's live transcript for the worker viewer: reads the same
        // file the runner persists per round, so "since" enables tailing
        static std::string teamwork_worker(workspace_ctx &ctx, const std::string &job_id, const std::string &worker_name,
                                           size_t since, nlohmann::json &delta, nlohmann::json &meta)
        {
            std::string sid = ctx.h.now().id();
            nlohmann::json store = cell::teamwork::load_store(sid);
            nlohmann::json *job = cell::teamwork::find_job(store, job_id);
            if (!job)
                return "job not found";
            auto list = job->find("list");
            size_t idx = 0;
            bool found = false;
            if (list != job->end() && list->is_array())
                for (auto &it : *list)
                {
                    if (!it.is_object())
                        continue;
                    std::string n = it.value("name", std::format("worker_{}", idx));
                    if (n == worker_name)
                    {
                        found = true;
                        break;
                    }
                    idx++;
                }
            if (!found)
                return "worker not found";
            cell::async_io::flush();
            auto path = cell::teamwork::worker_file_path(
                cell::teamwork::job_dir_of(*job, cell::teamwork::store_path(sid)), worker_name, idx);
            std::ifstream f(path, std::ios::binary);
            if (!f)
                return "worker transcript not written yet";
            auto j = nlohmann::json::parse(f, nullptr, false);
            if (!j.is_object())
                return "worker transcript unreadable";
            nlohmann::json messages = j.value("messages", nlohmann::json::array());
            meta = {{"status", j.value("status", "")},
                    {"rounds", j.value("rounds", 0LL)},
                    {"tool_calls", j.value("tool_calls", 0LL)},
                    {"total", messages.size()}};
            delta = nlohmann::json::array();
            if (since < messages.size())
                for (size_t i = since; i < messages.size(); i++)
                    delta.push_back(messages[i]);
            return "";
        }

        // -----------------------------------------------------------------
        //  key resolution (mirrors engine's private helper)
        // -----------------------------------------------------------------
        cell::encrypt::secure_string resolve_key(const cell::config::provider_entry &p)
        {
            if (!p.key_id.empty())
            {
                auto k = vault.get(p.key_id);
                if (!k.empty())
                    return k;
            }
            const char *env = std::getenv(p.api_style == "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
            if (env && *env)
                return cell::encrypt::secure_string(env);
            return vault.get("api_key");
        }

        // -----------------------------------------------------------------
        //  commands (the entire control surface, transport-independent).
        //  Every command accepts an optional "ws"; commands that act on a
        //  session default to the active workspace.
        // -----------------------------------------------------------------
        nlohmann::json exec_command(const std::string &name, const nlohmann::json &args)
        {
            // track the command so the exit path can drain in-flight work
            struct inflight_guard
            {
                app_core *self;
                explicit inflight_guard(app_core *s) : self(s) { self->inflight.fetch_add(1); }
                ~inflight_guard()
                {
                    if (self->inflight.fetch_sub(1) == 1)
                        self->inflight_cv.notify_all();
                }
            } guard{this};
            try
            {
                if (on_command)
                    on_command(name);

                // ---- workspace management ---------------------------------
                if (name == "workspace.open")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string dir = cell::text::trim(args.value("cwd", ""));
                    if (dir.empty())
                        return ok_error("cwd is required");
                    std::string err;
                    workspace_ctx *c = ensure_workspace(dir, &err);
                    if (!c)
                        return ok_error(err);
                    {
                        std::lock_guard<std::mutex> lk2(ctx_mx);
                        active_ws = c->cwd_key;
                    }
                    broadcast_state();
                    nlohmann::json r = ok();
                    r["ws"] = c->cwd_key;
                    r["cwd"] = c->cwd;
                    r["session"] = c->h.now().id();
                    return r;
                }
                if (name == "workspace.close")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string ws = args.value("ws", "");
                    if (ws.empty())
                        return ok_error("ws is required");
                    workspace_ctx *c = find_ws(ws);
                    if (!c)
                        return ok_error("unknown workspace");
                    if (c->busy.load())
                        return ok_error("a turn is running in this workspace - stop it first");
                    c->stop.store(true);
                    {
                        std::lock_guard<std::mutex> lk2(c->qmx);
                        c->quit = true;
                    }
                    c->qcv.notify_all();
                    if (c->worker.joinable())
                        c->worker.join();
                    c->h.now().unload();
                    cell::async_io::flush();
                    {
                        std::lock_guard<std::mutex> lk2(ctx_mx);
                        ctxs.erase(ws);
                        if (active_ws == ws)
                            active_ws = ctxs.empty() ? "" : ctxs.begin()->first;
                    }
                    broadcast_state();
                    return ok();
                }
                // 删除工作区：移除它在全局数据根下的全部会话记录（sessions/<ws>）
                // 并关闭上下文；工作区目录本身保留（源码/文件不动）。会话记录一经
                // 删除不可恢复 —— 必须由前端显式传入 confirm == 工作区全路径才执行。
                if (name == "workspace.delete")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string ws = args.value("ws", "");
                    if (ws.empty())
                        return ok_error("ws is required");
                    workspace_ctx *c = find_ws(ws);
                    // 工作区未打开时（侧栏里属于已关闭/从未打开的工作区的分组）没有
                    // 上下文：目录从 sessions 索引反查，与前端侧栏拿到的 cwd 同源
                    std::string cwd = c ? c->cwd : cell::cwd_for_key(ws);
                    if (cwd.empty())
                        return ok_error("unknown workspace");
                    if (args.value("confirm", "") != cwd)
                        return ok_error("confirm mismatch - pass confirm=<full cwd path>");
                    if (c)
                    {
                        // 先关闭并卸载上下文（同 workspace.close）：unload() 会把
                        // 内存里的转录写回 messages.jsonl，顺序反了（先删记录）它
                        // 会把刚删掉的会话目录重建出来 —— 侧栏分组永远删不净
                        if (c->busy.load())
                            c->request_stop();
                        c->stop.store(true);
                        {
                            std::lock_guard<std::mutex> lk2(c->qmx);
                            c->quit = true;
                        }
                        c->qcv.notify_all();
                        if (c->worker.joinable())
                            c->worker.join();
                        c->h.now().unload();
                        cell::async_io::flush();
                        {
                            std::lock_guard<std::mutex> lk2(ctx_mx);
                            ctxs.erase(ws);
                            if (active_ws == ws)
                                active_ws = ctxs.empty() ? "" : ctxs.begin()->first;
                        }
                    }
                    // 移除该工作区的全部会话记录（cwd 目录本身保留）
                    std::error_code ec;
                    std::filesystem::remove_all(cell::root / "sessions" / ws, ec);
                    if (!ec)
                    {
                        // 摘掉 cwd 索引（sessions/sessions.json）里它的记录：否则
                        // cwd_for_key() 仍能反查出已删除的工作区（用户可见的
                        // 「记录未清除」）。索引写入是异步的，flush 后再收尾。
                        // 删不干净时保留索引，便于修复后重试删除。
                        cell::forget_cwd(ws);
                        cell::async_io::flush();
                    }
                    // 摘掉可能指向它的 active_sessions 记录：否则下次打开该
                    // 工作区会把已删除记录里的 id 当 boot
                    for (auto it = cfg.active_sessions.begin(); it != cfg.active_sessions.end();)
                        it = (it->first == ws) ? cfg.active_sessions.erase(it) : std::next(it);
                    save_cfg();
                    // ctx 已关闭：即使记录没删干净，视图也要立即跟上（前端按 hello 重绘）
                    broadcast_state();
                    if (ec)
                        return ok_error("failed to delete workspace records: " + ec.message());
                    cell::sys::logger::instance().info("ws", std::format("deleted workspace records ws={} dir_kept={}", ws, cwd));
                    return ok();
                }
                if (name == "workspace.activate")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string ws = args.value("ws", "");
                    {
                        std::lock_guard<std::mutex> lk2(ctx_mx);
                        if (!ctxs.count(ws))
                            return ok_error("unknown workspace");
                        active_ws = ws;
                    }
                    broadcast_state();
                    return ok();
                }
                if (name == "workspace.list")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    nlohmann::json r = ok();
                    r["workspaces"] = workspaces_json();
                    return r;
                }

                // ---- turns -------------------------------------------------
                if (name == "send")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    std::string text = args.value("text", "");
                    if (text.empty())
                        return ok_error("empty message");
                    cfg.active_sessions[c->cwd_key] = c->h.now().id();
                    c->queue_turn(std::move(text));
                    return ok();
                }
                if (name == "stop")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    c->request_stop();
                    return ok();
                }
                if (name == "approve")
                {
                    std::string id = args.value("id", "");
                    std::string ws = args.value("ws", "");
                    bool allow = false;
                    if (args.contains("allow"))
                        allow = args["allow"].is_boolean() ? args["allow"].get<bool>() : args["allow"].get<int>() != 0;
                    if (id.empty())
                        return ok_error("missing approval id");
                    resolve_approval(ws, id, allow);
                    return ok();
                }

                // ---- state -------------------------------------------------
                if (name == "state")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string ws = args.value("ws", "");
                    if (!ws.empty())
                    {
                        workspace_ctx *c = find_ws(ws);
                        if (!c)
                            return ok_error("unknown workspace");
                        return ok_with(build_state_for(c, true));
                    }
                    return ok_with(build_state(true));
                }
                if (name == "settings.get")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    nlohmann::json r = ok();
                    r["settings"] = settings_json();
                    return r;
                }
                if (name == "settings.set")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return apply_settings(args.value("patch", nlohmann::json::object()));
                }
                if (name == "providers.add")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return providers_add(args);
                }
                if (name == "providers.rm")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return providers_rm(args.value("name", ""));
                }
                if (name == "providers.select")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return providers_select(args.value("name", ""));
                }
                if (name == "provider.set_key")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return provider_set_key(args.value("name", ""), args.value("key", ""));
                }
                if (name == "models.fetch")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    return models_fetch();
                }
                if (name == "model.set")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string m = args.value("model", "");
                    if (m.empty())
                        return ok_error("empty model name");
                    cfg.current_model = m;
                    save_cfg();
                    return ok();
                }

                // ---- sessions ----------------------------------------------
                if (name == "sessions.list")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    nlohmann::json r = ok();
                    r["sessions"] = sessions_list();
                    return r;
                }
                if (name == "session.select")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string id = args.value("id", "");
                    std::string ws = args.value("ws", "");
                    if (id.empty() || !cell::is_valid_session_id(id))
                        return ok_error("invalid session id");
                    if (ws.empty())
                        ws = cell::session_prefix(id);
                    workspace_ctx *c = find_ws(ws);
                    if (!c)
                    {
                        // the session may live in a directory that has no open
                        // context yet: open it on demand from the cwd index
                        std::string dir = cell::cwd_for_key(ws);
                        if (dir.empty())
                            return ok_error("unknown session group");
                        std::string err;
                        c = ensure_workspace(dir, &err, id);
                        if (!c)
                            return ok_error(err);
                    }
                    if (c->busy.load())
                        return ok_error("a turn is running - wait for it to finish");
                    if (c->h.now().id() != id)
                    {
                        c->h.now().unload();
                        cell::async_io::flush(); // the target file must reflect queued writes
                        c->h.use(id);
                        c->eng->ensure_prompt();
                        cell::sys::logger::instance().info("sess", std::format("switched to={} msgs={}", id, (long long)c->h.now().msg().size()));
                    }
                    cfg.active_sessions[c->cwd_key] = id;
                    {
                        std::lock_guard<std::mutex> lk2(ctx_mx);
                        active_ws = c->cwd_key;
                    }
                    broadcast_state();
                    return ok();
                }
                if (name == "session.new")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    if (c->busy.load())
                        return ok_error("a turn is running - wait for it to finish");
                    std::string old_id = c->h.now().id();
                    c->h.now().unload();
                    cell::async_io::flush(); // the old session must survive a crash
                    c->h.forget_current();
                    c->eng->ensure_prompt();
                    cfg.active_sessions[c->cwd_key] = c->h.now().id();
                    cell::sys::logger::instance().info("sess", std::format("new id={} previous={} kept=true ws={}", c->h.now().id(), old_id, c->cwd_key));
                    broadcast_state();
                    return ok();
                }
                // 清空当前会话上下文（对应 CLI /clear）；用户选择“强制中断并清空”
                if (name == "session.clear")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    if (c->busy.load())
                        c->request_stop();
                    long long before = (long long)c->h.now().msg().size();
                    c->h.now().msg().clear();
                    c->h.now().clear_interrupt(); // 可恢复的半截回合已不存在
                    cell::box::reset_read_log(c->h.box_context());
                    // 清 teamwork：删除所有 job 目录并重置 store
                    {
                        std::error_code rec;
                        nlohmann::json store = cell::teamwork::load_store(c->h.now().id());
                        if (auto jobs = store.find("jobs"); jobs != store.end() && jobs->is_object())
                            for (auto &[jid, job] : jobs->items())
                            {
                                (void)jid;
                                std::filesystem::remove_all(cell::teamwork::job_storage_dir(job, c->h.now().id()), rec);
                            }
                        cell::teamwork::save_store(c->h.now().id(), nlohmann::json::object());
                    }
                    // 清空会话 = 连通知记录一起清（对齐 CLI 机制：待投递的丢弃、
                    // 审计轨归档到 saved/ 后清空；归档失败只记日志，不挡上下文清空）
                    {
                        cell::notice::clear(c->h.now().id());
                        std::filesystem::path narc;
                        std::string nerr;
                        cell::notice::clear_seen(c->h.now().id(), narc, nerr);
                        if (!nerr.empty())
                            cell::sys::logger::instance().warn("notice", std::format("clear_seen failed sid={} err={}", c->h.now().id(), nerr));
                    }
                    c->eng->ensure_prompt();
                    c->h.now().unload(); // 空消息随下次落盘覆盖旧 transcript
                    cell::async_io::flush();
                    cell::sys::logger::instance().info("sess", std::format("cleared id={} msgs_before={}", c->h.now().id(), before));
                    broadcast_state();
                    return ok();
                }
                // 删除一条会话（仅其转录 + 压缩存档，不动源码）；删除当前会话则
                // 自动开一条新会话，避免仍指向已被删除的目录
                if (name == "session.delete")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string id = args.value("id", "");
                    std::string ws = args.value("ws", "");
                    if (!cell::is_valid_session_id(id))
                        return ok_error("invalid session id");
                    if (ws.empty())
                        ws = cell::session_prefix(id);
                    if (cell::session_prefix(id) != ws)
                        return ok_error("session does not belong to this workspace");
                    nlohmann::json a;
                    a["ws"] = ws;
                    workspace_ctx *c = target_ctx(a);
                    if (!c)
                    {
                        // 工作区未打开（侧栏里属于已关闭/从未打开的工作区的会话）：
                        // 存档只存在于磁盘，直接删除即可 —— 不为它创建工作区上下文，
                        // 也不触碰任何源码
                        std::error_code ec;
                        auto dir = cell::session_dir(id);
                        if (!std::filesystem::is_directory(dir, ec))
                            return ok_error("session not found");
                        std::filesystem::remove_all(dir, ec);
                        if (ec)
                            return ok_error("failed to delete session: " + ec.message());
                        // 摘掉可能指向它的 active_sessions 记录：否则下次打开该
                        // 工作区会把已删除的 id 当 boot，把空会话复活
                        if (auto it = cfg.active_sessions.find(ws); it != cfg.active_sessions.end() && it->second == id)
                        {
                            cfg.active_sessions.erase(it);
                            save_cfg();
                        }
                        cell::sys::logger::instance().info("sess", std::format("deleted session id={} (ws not open)", id));
                        broadcast_state();
                        return ok();
                    }
                    bool active = (c->h.now().id() == id);
                    if (active && c->busy.load())
                        c->request_stop();
                    // 先把当前会话落盘关闭，再删目录 —— 否则 unload/flush 会重建它
                    if (active)
                    {
                        c->h.now().unload();
                        cell::async_io::flush();
                    }
                    std::error_code ec;
                    std::filesystem::remove_all(cell::session_dir(id), ec);
                    if (ec)
                        return ok_error("failed to delete session: " + ec.message());
                    if (active)
                    {
                        c->h.forget_current();
                        c->eng->ensure_prompt();
                        cfg.active_sessions[c->cwd_key] = c->h.now().id();
                        cell::sys::logger::instance().info("sess", std::format("deleted active session, new id={}", c->h.now().id()));
                    }
                    cell::sys::logger::instance().info("sess", std::format("deleted session id={} active={}", id, active));
                    broadcast_state();
                    return ok();
                }
                // full transcript of one session (any session, not just the
                // active one) plus its compaction archives — the detail view
                if (name == "session.history")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string id = args.value("id", "");
                    std::string ws = args.value("ws", "");
                    if (id.empty())
                    {
                        workspace_ctx *c = target_ctx(args);
                        if (!c)
                            return ok_error("no workspace open");
                        id = c->h.now().id();
                        ws = c->cwd_key;
                    }
                    if (!cell::is_valid_session_id(id))
                        return ok_error("invalid session id");
                    if (ws.empty())
                        ws = cell::session_prefix(id);
                    if (cell::session_prefix(id) != ws)
                        return ok_error("session does not belong to this workspace");
                    cell::async_io::flush(); // the file must reflect queued writes
                    nlohmann::json messages = nlohmann::json::array(), archives = nlohmann::json::array();
                    read_session_files(id, messages, archives);
                    nlohmann::json r = ok();
                    r["id"] = id;
                    r["ws"] = ws;
                    r["total"] = messages.size();
                    r["entries"] = history_entries(messages);
                    r["archives"] = std::move(archives);
                    return r;
                }
                // one compaction archive (saved/<name>.jsonl) of a session
                if (name == "session.archive")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string id = args.value("id", "");
                    std::string arc = args.value("name", "");
                    if (!cell::is_valid_session_id(id))
                        return ok_error("invalid session id");
                    // the archive name is a plain file name: reject path-like input
                    if (arc.empty() || arc.size() > 128 || arc.find_first_of("/\\") != std::string::npos ||
                        arc.front() == '.' || arc.find("..") != std::string::npos)
                        return ok_error("invalid archive name");
                    cell::async_io::flush();
                    std::error_code ec;
                    auto file = cell::session_dir(id) / "saved" / arc;
                    if (!std::filesystem::is_regular_file(file, ec))
                        return ok_error("archive not found");
                    std::ifstream f(file, std::ios::binary);
                    std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                    nlohmann::json r = ok();
                    r["name"] = arc;
                    // notice 归档（notice-*.jsonl，清空通知/清空上下文时由
                    // notice::clear_seen 产出）的行是 {id,from,topic,body,state}
                    // 形状，不是消息 JSONL——按名字分派，否则会被消息解析器
                    // 读成空集（浮窗显示「存档为空」）
                    if (arc.rfind("notice-", 0) == 0)
                    {
                        nlohmann::json arr = nlohmann::json::array();
                        std::istringstream in(text);
                        std::string line;
                        while (std::getline(in, line))
                        {
                            if (!line.empty() && line.back() == '\r')
                                line.pop_back();
                            if (line.empty())
                                continue;
                            auto j = nlohmann::json::parse(line, nullptr, false);
                            if (j.is_discarded() || !j.is_object())
                                continue;
                            arr.push_back({{"id", j.value("id", "")},
                                           {"from", j.value("from", "")},
                                           {"topic", j.value("topic", "")},
                                           {"body", j.value("body", "")},
                                           {"created_at", j.value("created_at", 0LL)},
                                           {"state", j.value("state", "")}});
                        }
                        r["notices"] = std::move(arr);
                        return r;
                    }
                    r["entries"] = history_entries(cell::chat::parse_messages_jsonl(text));
                    return r;
                }
                // list only the compaction archives of a session (no transcript
                // read) — the dock's archive shelf refreshes from this, also
                // after a turn that may have compacted the context
                if (name == "session.archives")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string id = args.value("id", "");
                    std::string ws = args.value("ws", "");
                    if (id.empty())
                    {
                        workspace_ctx *c = target_ctx(args);
                        if (!c)
                            return ok_error("no workspace open");
                        id = c->h.now().id();
                        ws = c->cwd_key;
                    }
                    if (!cell::is_valid_session_id(id))
                        return ok_error("invalid session id");
                    if (ws.empty())
                        ws = cell::session_prefix(id);
                    if (cell::session_prefix(id) != ws)
                        return ok_error("session does not belong to this workspace");
                    cell::async_io::flush();
                    nlohmann::json archives = nlohmann::json::array();
                    read_session_archives(id, archives);
                    nlohmann::json r = ok();
                    r["id"] = id;
                    r["ws"] = ws;
                    r["archives"] = std::move(archives);
                    return r;
                }
                // deep content search across every session: transcripts,
                // compaction archives, teamwork stores, notices, worker files.
                // Reuses the built-in rg walker (literal, case-insensitive).
                if (name == "sessions.search")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    std::string q = cell::text::trim(args.value("q", ""));
                    nlohmann::json empty = ok();
                    empty["results"] = nlohmann::json::array();
                    empty["total"] = 0;
                    if (q.empty())
                        return empty;
                    if (q.size() > 100)
                        q.resize(100);
                    std::string pattern;
                    for (char ch : q)
                    {
                        if (std::string("\\.^$|?*+()[]{}").find(ch) != std::string::npos)
                            pattern.push_back('\\');
                        pattern.push_back(ch);
                    }
                    std::string out;
                    cell::box::rg(pattern, (cell::root / "sessions").string(), 400, out, true, 0, "", false);
                    struct hit
                    {
                        std::string kind, role, text;
                        long long line = 0;
                    };
                    std::map<std::string, std::vector<hit>> by_sess;
                    std::string cur;
                    std::istringstream iss(out);
                    std::string line;
                    std::string qlow = q;
                    cell::lower_ascii(qlow);
                    while (std::getline(iss, line))
                    {
                        if (line.size() > 9 && line.rfind("=== ", 0) == 0 && line.substr(line.size() - 4) == " ===")
                        {
                            cur = line.substr(4, line.size() - 8);
                            continue;
                        }
                        if (cur.empty())
                            continue;
                        auto pos = line.find(": ");
                        if (pos == std::string::npos)
                            continue;
                        long long ln = 0;
                        try
                        {
                            ln = std::stoll(line.substr(0, pos));
                        }
                        catch (...)
                        {
                            continue;
                        }
                        std::string content = line.substr(pos + 2);
                        // rel path: <group>/<session>/<rest...>
                        auto s1 = cur.find('/');
                        if (s1 == std::string::npos)
                            continue;
                        auto s2 = cur.find('/', s1 + 1);
                        if (s2 == std::string::npos)
                            continue;
                        std::string group = cur.substr(0, s1), sid = cur.substr(s1 + 1, s2 - s1 - 1), rest = cur.substr(s2 + 1);
                        if (!cell::is_valid_session_id(sid))
                            continue;
                        std::string kind = "other", role, text = content;
                        if (rest == "messages.jsonl")
                        {
                            kind = "chat";
                            auto j = nlohmann::json::parse(content, nullptr, false);
                            if (j.is_object())
                            {
                                role = j.value("role", "");
                                text = cell::chat::message_display_text(j);
                                if (text.empty())
                                    text = content_text(j);
                            }
                        }
                        else if (rest.rfind("saved/", 0) == 0)
                            kind = "archive";
                        else if (rest == "teamworks.json")
                            kind = "teamwork";
                        else if (rest.rfind("notices/", 0) == 0)
                            kind = "notice";
                        else if (rest.rfind("tw-", 0) == 0)
                            kind = "workflow";
                        // snippet: a window around the first match
                        std::string low = text;
                        cell::lower_ascii(low);
                        auto m = low.find(qlow);
                        if (m == std::string::npos)
                            continue;
                        // the window must cut on UTF-8 boundaries, never inside
                        // a multi-byte sequence
                        size_t from = m > 90 ? m - 90 : 0;
                        while (from > 0 && ((unsigned char)text[from] & 0xC0) == 0x80)
                            from--;
                        size_t to = std::min(text.size(), from + 260);
                        while (to > from && to < text.size() && ((unsigned char)text[to] & 0xC0) == 0x80)
                            to++;
                        std::string snip = (from ? "…" : "") + text.substr(from, to - from) +
                                           (to < text.size() ? "…" : "");
                        by_sess[group + "/" + sid].push_back({kind, role, snip, ln});
                    }
                    nlohmann::json results = nlohmann::json::array();
                    size_t total = 0;
                    for (auto &[key, hits] : by_sess)
                    {
                        total += hits.size();
                        auto slash = key.find('/');
                        std::string sid = key.substr(slash + 1);
                        std::error_code tec;
                        auto tf = cell::session_dir(sid) / "messages.jsonl";
                        long long mt = 0;
                        auto ft = std::filesystem::last_write_time(tf, tec);
                        if (!tec)
                            mt = (long long)std::chrono::duration_cast<std::chrono::seconds>(
                                     std::chrono::clock_cast<std::chrono::system_clock>(ft).time_since_epoch())
                                     .count();
                        nlohmann::json jhits = nlohmann::json::array();
                        for (size_t k = 0; k < hits.size() && k < 6; k++)
                            jhits.push_back({{"kind", hits[k].kind}, {"role", hits[k].role},
                                             {"text", hits[k].text}, {"line", hits[k].line}});
                        results.push_back({{"id", sid},
                                           {"ws", key.substr(0, slash)},
                                           {"cwd", cell::cwd_for_key(key.substr(0, slash))},
                                           {"title", session_title(tf)},
                                           {"mtime", mt},
                                           {"hits", std::move(jhits)},
                                           {"more", hits.size() > 6 ? (long long)(hits.size() - 6) : 0}});
                    }
                    std::sort(results.begin(), results.end(), [](const nlohmann::json &a, const nlohmann::json &b)
                              { return a.value("mtime", 0LL) > b.value("mtime", 0LL); });
                    if (results.size() > 60)
                        results.erase(results.begin() + 60, results.end());
                    nlohmann::json r = ok();
                    r["results"] = std::move(results);
                    r["total"] = (long long)total;
                    return r;
                }

                // ---- teamwork ----------------------------------------------
                if (name == "teamwork.list")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    nlohmann::json r = ok();
                    r["jobs"] = teamwork_list(*c);
                    return r;
                }
                if (name == "teamwork.report")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    std::string report;
                    std::string err = teamwork_report(*c, args.value("job", ""), args.value("worker", ""), report);
                    if (!err.empty())
                        return ok_error(err);
                    nlohmann::json r = ok();
                    r["report"] = report;
                    return r;
                }
                if (name == "teamwork.worker")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    nlohmann::json delta = nlohmann::json::array(), meta = nlohmann::json::object();
                    std::string err;
                    {
                        cell::exec_context_guard g(c->cwd, &c->box_ctx);
                        err = teamwork_worker(*c, args.value("job", ""), args.value("worker", ""),
                                              (size_t)args.value("since", 0), delta, meta);
                    }
                    if (!err.empty())
                        return ok_error(err);
                    nlohmann::json r = ok();
                    r.update(meta);
                    r["messages"] = delta;
                    return r;
                }
                if (name == "teamwork.create")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    nlohmann::json input = nlohmann::json::object();
                    for (const char *k : {"workflow", "list", "work_type", "provider", "model", "think", "editable", "edit_rules"})
                        if (args.contains(k))
                            input[k] = args[k];
                    if (!input.contains("workflow") && !input.contains("list"))
                        return ok_error("workflow or list is required");
                    std::string out;
                    bool okc = false;
                    {
                        cell::exec_context_guard g(c->cwd, &c->box_ctx);
                        okc = cell::teamwork::new_job(input, cfg.teamwork_max_children, out, c->h.now().id());
                    }
                    if (!okc)
                        return ok_error(out);
                    bus.post({{"t", "teamwork_changed"}, {"ws", c->cwd_key}});
                    nlohmann::json r = ok();
                    r["job"] = out;
                    return r;
                }
                if (name == "teamwork.run" || name == "teamwork.resume")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    std::string job_id = args.value("id", "");
                    if (job_id.empty())
                        return ok_error("id is required");
                    std::string out;
                    bool okr = false;
                    {
                        cell::exec_context_guard g(c->cwd, &c->box_ctx);
                        okr = cell::teamwork::run_job_bg(c->eng->team_rt(), job_id, out);
                    }
                    bus.post({{"t", "teamwork_changed"}, {"ws", c->cwd_key}});
                    if (!okr)
                        return ok_error(out);
                    nlohmann::json r = ok();
                    r["message"] = out;
                    return r;
                }
                if (name == "teamwork.stop")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    std::string job_id = args.value("id", "");
                    if (job_id.empty())
                        return ok_error("id is required");
                    cell::teamwork::request_stop(job_id);
                    bus.post({{"t", "teamwork_changed"}, {"ws", c->cwd_key}});
                    nlohmann::json r = ok();
                    r["message"] = "stop requested";
                    return r;
                }

                // ---- attachments -------------------------------------------
                if (name == "upload")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    std::string nm = args.value("name", "file.bin");
                    std::string b64 = args.value("data_b64", "");
                    if (b64.empty())
                        return ok_error("empty upload");
                    std::string safe;
                    for (char ch : nm)
                        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-')
                            safe += ch;
                    if (safe.empty() || safe == "." || safe == "..")
                        safe = "upload.bin";
                    std::string raw = cell::encrypt::b64_decode(b64);
                    if (raw.empty())
                        return ok_error("bad base64 payload");
                    if (raw.size() > 48u * 1024 * 1024)
                        return ok_error("upload too large (48 MiB max)");
                    std::error_code ec;
                    auto dir = std::filesystem::path(c->cwd) / ".cell" / "uploads";
                    std::filesystem::create_directories(dir, ec);
                    long long stamp = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
                                          std::chrono::system_clock::now().time_since_epoch())
                                          .count();
                    auto path = dir / std::format("{}-{}", stamp, safe);
                    std::ofstream out(path, std::ios::binary);
                    if (!out)
                        return ok_error("cannot write the upload");
                    out.write(raw.data(), (std::streamsize)raw.size());
                    out.close();
                    nlohmann::json r = ok();
                    r["path"] = path.string();
                    r["name"] = safe;
                    r["size"] = (long long)raw.size();
                    return r;
                }

                // ---- notices ----------------------------------------------
                if (name == "notice.list")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    nlohmann::json arr = nlohmann::json::array();
                    std::filesystem::path base = cell::session_dir(c->h.now().id()) / "notices";
                    std::error_code ec;
                    // delivered history first, then whatever is still pending
                    std::ifstream se(base / "seen.jsonl", std::ios::binary);
                    std::vector<std::string> lines;
                    std::string line;
                    while (std::getline(se, line))
                        lines.push_back(line);
                    size_t start = lines.size() > 200 ? lines.size() - 200 : 0;
                    for (size_t i = start; i < lines.size(); i++)
                    {
                        auto j = nlohmann::json::parse(lines[i], nullptr, false);
                        if (!j.is_object())
                            continue;
                        arr.push_back({{"id", j.value("id", "")},
                                       {"from", j.value("from", "")},
                                       {"topic", j.value("topic", "")},
                                       {"body", j.value("body", "")},
                                       {"created_at", j.value("created_at", 0LL)},
                                       {"pending", false}});
                    }
                    if (std::filesystem::is_directory(base / "pending", ec))
                        for (auto &e : std::filesystem::directory_iterator(base / "pending", ec))
                        {
                            std::ifstream f(e.path(), std::ios::binary);
                            auto j = nlohmann::json::parse(f, nullptr, false);
                            if (!j.is_object())
                                continue;
                            arr.push_back({{"id", j.value("id", "")},
                                           {"from", j.value("from", "")},
                                           {"topic", j.value("topic", "")},
                                           {"body", j.value("body", "")},
                                           {"created_at", j.value("created_at", 0LL)},
                                           {"pending", true}});
                        }
                    nlohmann::json r = ok();
                    r["notices"] = arr;
                    return r;
                }
                // 清空该会话的通知记录（对齐 CLI 的 /notices clear + /notices seen
                // clear：待投递的丢弃并记为 dropped，已投递的审计轨归档到 saved/
                // 后清空）——GUI 通知面板展示的正是这两者的合并
                if (name == "notice.clear")
                {
                    std::lock_guard<std::mutex> lk(cmd_mx);
                    workspace_ctx *c = target_ctx(args);
                    if (!c)
                        return ok_error("no workspace open");
                    size_t dropped = cell::notice::clear(c->h.now().id());
                    std::filesystem::path archived;
                    std::string nerr;
                    size_t seen = cell::notice::clear_seen(c->h.now().id(), archived, nerr);
                    if (!nerr.empty())
                        return ok_error(nerr);
                    nlohmann::json r = ok();
                    r["dropped"] = dropped;
                    r["seen"] = seen;
                    r["archived"] = archived.string();
                    cell::sys::logger::instance().info("notice", std::format("cleared via ui sid={} dropped={} seen={}", c->h.now().id(), dropped, seen));
                    return r;
                }

                return ok_error("unknown command: " + name);
            }
            catch (const std::exception &e)
            {
                return ok_error(std::string("command failed: ") + e.what());
            }
        }

        // push a fresh state snapshot to every connected client (workspace
        // set / active / session changes)
        void broadcast_state()
        {
            nlohmann::json st = build_state(true);
            st["rebuild"] = true; // frontends replace their chat view
            bus.post(st);
        }

    private:
        static nlohmann::json ok() { return nlohmann::json{{"ok", true}}; }
        static nlohmann::json ok_error(const std::string &e) { return nlohmann::json{{"ok", false}, {"error", e}}; }
        static nlohmann::json ok_with(nlohmann::json payload)
        {
            payload["ok"] = true;
            return payload;
        }

        // ---- settings ----------------------------------------------------
        nlohmann::json apply_settings(const nlohmann::json &p)
        {
            if (!p.is_object())
                return ok_error("patch must be an object");
            if (p.contains("think_level"))
            {
                int lv = p["think_level"].get<int>();
                if (lv < 0 || lv > 4)
                    return ok_error("think_level must be 0..4");
                cfg.think_level = lv;
            }
            if (p.contains("tools"))
                cfg.tools = p["tools"].get<bool>();
            if (p.contains("sandbox_mode"))
            {
                std::string m = p["sandbox_mode"].get<std::string>();
                if (m == "read-only" || m == "readonly")
                    cell::box::sandbox_mode() = cell::box::SandboxMode::ReadOnly;
                else if (m == "edit-only" || m == "edit")
                    cell::box::sandbox_mode() = cell::box::SandboxMode::EditOnly;
                else if (m == "full-access" || m == "full")
                    cell::box::sandbox_mode() = cell::box::SandboxMode::FullAccess;
                else
                    return ok_error("unknown sandbox mode: " + m);
                cfg.sandbox_mode = m;
            }
            if (p.contains("autoallow"))
                cfg.autoallow = p["autoallow"].get<bool>();
            if (p.contains("compact_auto"))
                cfg.compact_auto = p["compact_auto"].get<bool>();
            if (p.contains("compact_provider"))
                cfg.compact_provider = cell::text::trim(p["compact_provider"].get<std::string>());
            if (p.contains("compact_model"))
                cfg.compact_model = cell::text::trim(p["compact_model"].get<std::string>());
            if (p.contains("system_prompt"))
                cfg.system_prompt = p["system_prompt"].get<std::string>();
            if (p.contains("teamwork_max_children"))
            {
                long long n = p["teamwork_max_children"].get<long long>();
                if (n < 1 || n > 100)
                    return ok_error("teamwork_max_children must be 1..100");
                cfg.teamwork_max_children = (size_t)n;
            }
            if (p.contains("max_threads"))
            {
                long long n = p["max_threads"].get<long long>();
                if (n < 1 || n > 16)
                    return ok_error("max_threads must be 1..16");
                cfg.max_threads = (size_t)n;
                cell::sys::pool_max_setting() = (size_t)n;
            }
            // autoallow is only effective in full-access mode
            cell::box::autoallow_enabled() = cfg.autoallow && cell::box::sandbox_mode() == cell::box::SandboxMode::FullAccess;
            save_cfg();
            cell::sys::logger::instance().info("app", "settings updated via ui");
            nlohmann::json r = ok();
            r["settings"] = settings_json();
            return r;
        }

        // ---- providers ---------------------------------------------------
        nlohmann::json providers_add(const nlohmann::json &a)
        {
            std::string style_name = cell::text::trim(a.value("api_style", ""));
            std::string canonical = cell::config::provider_entry::parse_api_style(style_name);
            if (canonical.empty())
                return ok_error("unknown api style: " + style_name);
            std::string base = cell::text::trim(a.value("base", ""));
            if (base.empty())
                return ok_error("api base url is required");
            std::string name_arg = cell::text::trim(a.value("name", ""));
            std::string key = a.value("key", "");
            std::string proxy = cell::text::trim(a.value("proxy", ""));
            std::string name = cell::config::unique_name(cfg, name_arg.empty() ? canonical : name_arg);
            cell::config::provider_entry ne;
            ne.name = name;
            ne.set_api_style(canonical);
            ne.base = base;
            ne.proxy = proxy;
            if (!key.empty())
            {
                std::string kid = "provider:" + name;
                if (!vault.set(kid, key))
                    return ok_error("failed to store the api key");
                ne.key_id = kid;
            }
            cfg.providers.push_back(std::move(ne));
            cfg.current_model.clear(); // the model belonged to the previous provider
            cell::config::select_provider(cfg, name);
            save_cfg();
            cell::sys::logger::instance().info("provider", std::format("added name={} style={} base={} key={} via ui",
                                                                       name, canonical, base, key.empty() ? "none" : "stored"));
            nlohmann::json r = ok();
            r["name"] = name;
            r["providers"] = providers_json();
            return r;
        }
        nlohmann::json providers_rm(const std::string &name)
        {
            int idx = cell::config::find(cfg, name);
            if (idx < 0)
                return ok_error("provider not found: " + name);
            std::string kid = cfg.providers[(size_t)idx].key_id;
            if (!kid.empty() && vault.remove(kid) > 0)
                cell::sys::logger::instance().info("vault", std::format("removed key id={}", kid));
            bool was_current = (cfg.providers[(size_t)idx].name == cfg.current_provider) ||
                               (cfg.current_provider.empty() && idx == 0);
            std::string removed = cfg.providers[(size_t)idx].name;
            cfg.providers.erase(cfg.providers.begin() + idx);
            if (was_current)
            {
                if (cfg.providers.empty())
                {
                    cfg.current_provider.clear();
                    cfg.current_model.clear();
                }
                else
                {
                    cfg.current_provider = cfg.providers[0].name;
                    cfg.current_model.clear(); // the model belonged to the removed provider
                }
            }
            save_cfg();
            nlohmann::json r = ok();
            r["providers"] = providers_json();
            return r;
        }
        nlohmann::json providers_select(const std::string &name)
        {
            if (cell::config::find(cfg, name) < 0)
                return ok_error("provider not found: " + name);
            cell::config::select_provider(cfg, name);
            save_cfg();
            nlohmann::json r = ok();
            r["providers"] = providers_json();
            return r;
        }
        nlohmann::json provider_set_key(const std::string &name, const std::string &key)
        {
            int idx = cell::config::find(cfg, name);
            if (idx < 0)
                return ok_error("provider not found: " + name);
            if (key.empty())
                return ok_error("empty key");
            auto &p = cfg.providers[(size_t)idx];
            std::string kid = p.key_id.empty() ? "provider:" + p.name : p.key_id;
            if (!vault.set(kid, key))
                return ok_error("failed to store the api key");
            p.key_id = kid;
            save_cfg();
            cell::sys::logger::instance().info("provider", std::format("key updated name={} via ui", name));
            nlohmann::json r = ok();
            r["providers"] = providers_json();
            return r;
        }

        // ---- models (fetch the provider's list; mirrors the CLI's probe) --
        // Log the CA bundle once per process; it is invisible otherwise and it is
        // the first thing to check when an https provider fails to answer.
        void log_ca_once()
        {
            static std::once_flag once;
            std::call_once(once, []
                           {
                               const char *ca = cell::net::ca_bundle();
                               cell::sys::logger::instance().info(
                                   "net", std::string("tls ca bundle: ") + (ca && *ca ? ca : "(curl default)"));
                           });
        }

        nlohmann::json models_fetch()
        {
            const cell::config::provider_entry *p = cfg.current_provider_entry();
            if (!p)
                return ok_error("no provider configured");
            // the resolved CA bundle is the usual suspect when a probe fails, so
            // record it once: a static libcurl's baked-in path is a POSIX one and
            // simply does not exist on Windows (see cell::net::ca_bundle)
            log_ca_once();
            cell::encrypt::secure_string key = resolve_key(*p);
            auto candidates = p->model_list_candidates();
            std::string buf;
            long code = 0, last_code = 0;
            bool got = false;
            std::string err;
            CURL *c = curl_easy_init();
            for (const auto &[url, anthropic_auth] : candidates)
            {
                std::vector<std::string> hdrs;
                if (anthropic_auth)
                    hdrs = {"x-api-key: " + std::string(key.data(), key.size()), "anthropic-version: 2023-06-01"};
                else
                    hdrs = {"Authorization: Bearer " + std::string(key.data(), key.size())};
                buf.clear();
                code = 0;
                err.clear();
                bool okc = c && cell::net::CURL_get(c, url.c_str(), hdrs, buf, &code, &err,
                                                    p->proxy.empty() ? nullptr : p->proxy.c_str(), 5);
                for (auto &hh : hdrs)
                    cell::encrypt::wipe(hh);
                if (okc && code == 200)
                {
                    got = true;
                    break;
                }
                last_code = code;
                if (err.empty())
                    err = std::format("HTTP {}", code);
                if (code != 404) // only a missing route is worth another endpoint
                    break;
            }
            curl_easy_cleanup(c);
            if (!got)
                return ok_error(err.empty() ? "request failed" : err);
            nlohmann::json models = nlohmann::json::array();
            try
            {
                auto j = nlohmann::json::parse(buf);
                if (j.contains("data") && j["data"].is_array())
                    for (auto &m : j["data"])
                        if (m.contains("id") && m["id"].is_string())
                            models.push_back(m["id"].get<std::string>());
            }
            catch (const std::exception &e)
            {
                return ok_error(std::format("response parse error: {}", e.what()));
            }
            nlohmann::json r = ok();
            r["models"] = models;
            return r;
        }
    };
} // namespace app
