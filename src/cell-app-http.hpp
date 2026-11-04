// cell-app-http.hpp — the web service: the same page and the same command bus
// over HTTP + SSE, built on servic.hpp + router.
//
//   GET  /                 the embedded UI (or --ui FILE, a dev loop)
//   POST /api/cmd/:name    the command bus: JSON body in, JSON out
//   GET  /api/state        the full state snapshot
//   GET  /api/events       server-sent events, one `data: {…}` per event
//   GET  /api/themes       third-party theme manifests
//   GET  /api/theme/:name  a theme's theme.css
//   GET  /api/splash/asset the custom splash image  (.cell/splash/<name>)
//   GET  /api/splash/page  a whole-page splash       (.cell/splash/index.html)
//
// Security: the service is a local control surface for a full-access agent, so
// it must never be reachable from a web page or from the LAN. The listener
// binds 127.0.0.1 only; every request must carry a loopback Host header (DNS
// rebinding) and a same-origin or absent Origin, browsers additionally tag
// cross-site requests, and there is no CORS: the page is always served from
// this origin, so a cross-origin fetch/EventSource dies in the browser before
// any of these checks run.
#pragma once

#include "servic.hpp"

#include <boost/asio.hpp>
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <thread>

#include "cell-app-util.hpp"

namespace app
{
    namespace asio = boost::asio;

    // ---- themes ----------------------------------------------------------
    // There is no built-in theme: the default look is the page's own :root, and
    // every entry here comes from <root>/theme/<name>/{theme.json,theme.css}.
    struct theme_info
    {
        std::string name, label, type = "dark", desc;
        std::vector<std::string> swatch; // preview colours for the picker
    };

    inline bool theme_name_ok(std::string_view n)
    {
        return !n.empty() && n.size() <= 64 && n.front() != '.' &&
               std::ranges::all_of(n, [](unsigned char c)
                                   { return std::isalnum(c) || c == '-' || c == '_' || c == '.'; });
    }

    // theme.json is third-party input: every field is type-checked (a
    // {"label":123} used to make /api/themes throw and drop the connection).
    inline theme_info read_theme(const std::filesystem::path &dir, const std::string &name)
    {
        theme_info t;
        t.name = t.label = name;
        std::ifstream jf(dir / "theme.json", std::ios::binary);
        if (!jf)
            return t;
        const auto j = nlohmann::json::parse(jf, nullptr, false);
        if (!j.is_object())
            return t; // a broken theme.json only loses the metadata
        if (const auto it = j.find("label"); it != j.end() && it->is_string() && !it->get<std::string>().empty())
            t.label = it->get<std::string>();
        if (j.value("type", std::string{}) == "light")
            t.type = "light";
        if (const auto it = j.find("desc"); it != j.end() && it->is_string())
            t.desc = it->get<std::string>();
        if (const auto it = j.find("swatch"); it != j.end() && it->is_array())
            for (const auto &c : *it)
                if (c.is_string() && t.swatch.size() < 4)
                    t.swatch.push_back(c.get<std::string>());
        return t;
    }

    // Only the scanned third-party themes: the default look is not a theme.
    inline std::vector<theme_info> list_themes()
    {
        std::vector<theme_info> out;
        std::error_code ec;
        for (std::filesystem::directory_iterator it(cell::root / "theme", ec), end; !ec && it != end; it.increment(ec))
        {
            const std::string name = it->path().filename().string();
            if (it->is_directory(ec) && theme_name_ok(name) &&
                std::filesystem::exists(it->path() / "theme.css", ec)) // no style = not applicable
                out.push_back(read_theme(it->path(), name));
        }
        std::ranges::sort(out, {}, &theme_info::name);
        return out;
    }

    // ---- static assets ---------------------------------------------------
    inline std::string_view splash_mime(std::string_view name)
    {
        const size_t dot = name.rfind('.');
        if (dot == std::string_view::npos)
            return {};
        static constexpr std::pair<std::string_view, std::string_view> kMime[] = {
            {"png", "image/png"}, {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"},
            {"gif", "image/gif"}, {"webp", "image/webp"}, {"avif", "image/avif"},
            {"bmp", "image/bmp"}, {"svg", "image/svg+xml"}};
        const std::string ext = js::lower_ascii(name.substr(dot + 1));
        const auto it = std::ranges::find(kMime, ext, &std::pair<std::string_view, std::string_view>::first);
        return it == std::end(kMime) ? std::string_view{} : it->second;
    }

    // Read a small file; the cap guards against a mis-pointed configuration.
    inline bool read_small_file(const std::filesystem::path &p, size_t max_bytes, std::string &out)
    {
        std::error_code ec;
        if (!std::filesystem::is_regular_file(p, ec))
            return false;
        const auto size = std::filesystem::file_size(p, ec);
        if (ec || size == 0 || size > max_bytes)
            return false;
        std::ifstream f(p, std::ios::binary);
        if (!f)
            return false;
        out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
        return !out.empty();
    }

    // one live SSE connection: the bus sink only enqueues (never writes, so a
    // slow client can never block an event publisher); the handler's worker
    // thread drains the queue and writes the socket.
    struct sse_conn
    {
        static constexpr size_t kMaxQueue = 4096;
        std::mutex mx;
        std::condition_variable cv;
        bool alive = true;
        std::deque<std::string> q;
        std::function<void(const std::string &)> write; // throws on disconnect
    };

    struct http_service
    {
        app_core &core;
        asio::io_context io;
        std::unique_ptr<servic::Server> server;
        rt::router ros;
        std::vector<std::thread> threads;
        // Keeps the io_context alive from before the first run() until stop():
        // a run() that starts with no work returns immediately AND marks the
        // context stopped, after which every later run() (and the accept
        // coroutine) is dead on arrival. Without this guard the worker-thread
        // start order is a race.
        std::optional<asio::executor_work_guard<asio::io_context::executor_type>> work;
        // --ui FILE: serve the UI page from this file on every request
        // (dev loop: edit the HTML and hit refresh, no rebuild). Empty =
        // the embedded page.
        std::string ui_path;
        // the port actually bound; the request gate validates Host against it
        int bound_port = 0;

        std::mutex conns_mx;
        std::vector<std::weak_ptr<sse_conn>> conns;

        explicit http_service(app_core &c) : core(c) {}
        ~http_service() { stop(); }

        // ---- responses -----------------------------------------------------
        static std::string http_response(std::string_view status, std::string_view ctype, std::string_view body)
        {
            return std::format("HTTP/1.1 {}\r\nContent-Type: {}\r\nX-Content-Type-Options: nosniff\r\n"
                               "Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                               status, ctype, body.size(), body);
        }
        static std::string text_response(std::string_view status, std::string_view body)
        {
            return http_response(status, "text/plain; charset=utf-8", body);
        }
        static std::string http_json(const nlohmann::json &j)
        {
            return http_response("200 OK", "application/json; charset=utf-8",
                                 j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
        }
        // The dev surfaces (page, theme.css, splash) change on disk under us.
        static std::string no_store(std::string r)
        {
            if (const size_t head = r.find("\r\n\r\n"); head != std::string::npos)
                r.insert(head, "\r\nCache-Control: no-store");
            return r;
        }

        // ---- the request gate ----------------------------------------------
        // loopback host forms accepted in the Host header / Origin
        bool host_allowed(std::string_view host) const
        {
            const std::string h = js::lower_ascii(host), p = std::to_string(bound_port);
            return h == "127.0.0.1:" + p || h == "localhost:" + p || h == "[::1]:" + p;
        }
        bool origin_allowed(std::string_view origin) const
        {
            constexpr std::string_view kScheme = "http://";
            return origin.starts_with(kScheme) && host_allowed(origin.substr(kScheme.size()));
        }
        // "" = allowed, otherwise a ready-to-send refusal.
        std::string check_request(const std::string &raw, std::string_view want_method) const
        {
            if (servic::request_method(raw) != want_method)
                return text_response("405 Method Not Allowed", "method not allowed");
            if (!host_allowed(servic::header_value(raw, "Host")))
                return text_response("403 Forbidden", "loopback Host header required");
            const std::string origin = servic::header_value(raw, "Origin");
            if (!origin.empty() && !origin_allowed(origin))
                return text_response("403 Forbidden", "cross-origin request refused");
            if (js::lower_ascii(servic::header_value(raw, "Sec-Fetch-Site")) == "cross-site")
                return text_response("403 Forbidden", "cross-site request refused");
            return "";
        }
        // Every route starts with the same three lines; this keeps them out of
        // the handlers. False = the refusal is already in `out`.
        bool gate(const std::string &req, std::string &out, std::string_view method) const
        {
            std::string bad = check_request(req, method);
            if (bad.empty())
                return true;
            out = std::move(bad);
            return false;
        }
        // The body follows the first blank line of the raw request.
        static std::string request_body(const std::string &raw)
        {
            const size_t hdr_end = raw.find("\r\n\r\n");
            return hdr_end == std::string::npos ? std::string{} : raw.substr(hdr_end + 4);
        }

        // A themed file response, or "" when it is missing/unreadable.
        static std::string file_response(const std::filesystem::path &p, std::string_view mime, size_t max_bytes)
        {
            std::string body;
            if (!read_small_file(p, max_bytes, body))
                return {};
            return no_store(http_response("200 OK", mime, body));
        }

        // ---- lifecycle -----------------------------------------------------
        // returns "" on success, else the failure reason
        std::string start(int port, int n_threads)
        {
            ros.on("", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (!gate(req, out, "GET"))
                    return rt::FLAG_DONE;
                std::string html = app::kUiHtml;
                bool from_disk = false;
                if (!ui_path.empty())
                {
                    std::ifstream f(ui_path, std::ios::binary);
                    if (f)
                    {
                        html.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
                        from_disk = true;
                    }
                    else
                        cell::sys::logger::instance().warn("http", std::format("--ui file unreadable, serving the embedded page: {}", ui_path));
                }
                out = http_response("200 OK", "text/html; charset=utf-8", html);
                if (from_disk)
                    out = no_store(std::move(out));
                return rt::FLAG_DONE; });

            ros.on("favicon.ico", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (gate(req, out, "GET"))
                    out = "HTTP/1.1 204 No Content\r\n\r\n";
                return rt::FLAG_DONE; });

            // GET /api/themes — the manifests behind the theme picker
            ros.on("api/themes", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (!gate(req, out, "GET"))
                    return rt::FLAG_DONE;
                nlohmann::json arr = nlohmann::json::array();
                try
                {
                    for (auto &t : list_themes())
                        arr.push_back({{"name", t.name}, {"label", t.label}, {"type", t.type},
                                       {"desc", t.desc}, {"swatch", t.swatch}});
                }
                catch (const std::exception &e)
                {
                    out = text_response("500 Internal Server Error", e.what());
                    return rt::FLAG_DONE;
                }
                out = http_json({{"ok", true}, {"themes", std::move(arr)}});
                return rt::FLAG_DONE; });

            // GET /api/theme/:name — one theme's theme.css
            ros.on("api/theme/:name", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &params) -> int
                   {
                if (!gate(req, out, "GET"))
                    return rt::FLAG_DONE;
                const auto it = params.find("name");
                const std::string name = it == params.end() ? std::string{} : it->second;
                if (!theme_name_ok(name))
                {
                    out = text_response("400 Bad Request", "bad theme name");
                    return rt::FLAG_DONE;
                }
                // defence in depth: the resolved directory must be a direct child
                // of the theme root (also blocks junction/symlink tricks)
                std::error_code ec;
                const auto base = std::filesystem::weakly_canonical(cell::root / "theme", ec);
                const auto dir = std::filesystem::weakly_canonical(cell::root / "theme" / name, ec);
                if (!ec && dir != base && dir.parent_path() == base)
                    if (std::string css = file_response(dir / "theme.css", "text/css; charset=utf-8", 4u * 1024 * 1024); !css.empty())
                    {
                        out = std::move(css);
                        return rt::FLAG_DONE;
                    }
                out = text_response("404 Not Found", "theme not found");
                return rt::FLAG_DONE; });

            // GET /api/splash/asset — the custom splash image. Only the plain
            // file name recorded in the prefs is fetched (path separators are
            // rejected when it is stored), and the extension decides the MIME.
            ros.on("api/splash/asset", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (!gate(req, out, "GET"))
                    return rt::FLAG_DONE;
                const std::string name = app::prefs::load().splash_image;
                const std::string_view mime = splash_mime(name);
                if (mime.empty() || !app::prefs::plain_name_ok(name))
                    out = text_response("404 Not Found", "no splash image");
                else if (std::string body = file_response(app::prefs::splash_dir() / name, mime, 32u * 1024 * 1024); !body.empty())
                    out = std::move(body);
                else
                    out = text_response("404 Not Found", "no splash image");
                return rt::FLAG_DONE; });

            // GET /api/splash/page — a whole-page splash, framed by the page
            ros.on("api/splash/page", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (!gate(req, out, "GET"))
                    return rt::FLAG_DONE;
                std::string page = file_response(app::prefs::splash_dir() / "index.html", "text/html; charset=utf-8", 4u * 1024 * 1024);
                out = page.empty() ? text_response("404 Not Found", "no custom splash page") : std::move(page);
                return rt::FLAG_DONE; });

            // POST /api/cmd/:name — the command bus
            ros.on("api/cmd/:name", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &params) -> int
                   {
                if (!gate(req, out, "POST"))
                    return rt::FLAG_DONE;
                const std::string body = request_body(req);
                const auto it = params.find("name");
                const std::string cmd = it == params.end() ? std::string{} : it->second;
                nlohmann::json args = nlohmann::json::object();
                if (!body.empty())
                    if (auto j = nlohmann::json::parse(body, nullptr, false); j.is_object())
                        args = std::move(j);
                out = http_json(core.exec_command(cmd, args));
                return rt::FLAG_DONE; });

            // GET /api/state — the full snapshot
            ros.on("api/state", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                if (gate(req, out, "GET"))
                    out = http_json(core.exec_command("state", nlohmann::json::object()));
                return rt::FLAG_DONE; });

            // GET /api/events — SSE stream. The handler runs on its own worker
            // thread (see servic::Session); the bus sink only enqueues here and
            // this thread drains the queue, so neither the engine nor a command
            // ever blocks on a slow client.
            ros.on_stream("api/events", [this](std::string &req, rt::WriteCallback write, const std::map<std::string, std::string> &)
                          {
                if (std::string bad = check_request(req, "GET"); !bad.empty())
                {
                    write(bad);
                    return;
                }
                write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                      "Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n");
                write(": connected\n\n");
                auto conn = std::make_shared<sse_conn>();
                conn->write = [write](const std::string &s) { write(s); };
                int sink_id = core.bus.add([conn](const std::string &line)
                {
                    std::lock_guard<std::mutex> lk(conn->mx);
                    if (!conn->alive)
                        return;
                    if (conn->q.size() >= sse_conn::kMaxQueue)
                    {
                        // a client that cannot keep up is dropped; it reconnects
                        // and resyncs the state instead of growing memory here
                        conn->alive = false;
                        conn->cv.notify_all();
                        return;
                    }
                    conn->q.push_back(line);
                    conn->cv.notify_one();
                });
                {
                    std::lock_guard<std::mutex> lk(conns_mx);
                    conns.push_back(conn);
                }
                std::unique_lock<std::mutex> lk(conn->mx);
                auto beat = std::chrono::steady_clock::now() + std::chrono::seconds(15);
                while (conn->alive)
                {
                    if (!conn->q.empty())
                    {
                        std::deque<std::string> batch;
                        batch.swap(conn->q);
                        lk.unlock();
                        const bool failed = !write_batch(batch, conn->write);
                        lk.lock();
                        if (failed)
                        {
                            conn->alive = false;
                            break;
                        }
                        continue;
                    }
                    if (conn->cv.wait_until(lk, beat, [&]
                                            { return !conn->alive || !conn->q.empty(); }))
                    {
                        if (!conn->alive)
                            break;
                        continue;
                    }
                    lk.unlock();
                    bool failed = false;
                    try
                    {
                        conn->write(": ping\n\n");
                    }
                    catch (...)
                    {
                        failed = true;
                    }
                    lk.lock();
                    if (failed)
                    {
                        conn->alive = false;
                        break;
                    }
                    beat = std::chrono::steady_clock::now() + std::chrono::seconds(15);
                }
                lk.unlock();
                core.bus.remove(sink_id); });

            // -- start ------------------------------------------------------
            try
            {
                // large enough for base64 uploads (~48 MiB file cap)
                server = std::make_unique<servic::Server>(io, "127.0.0.1", (unsigned short)port, 72 * 1024 * 1024);
            }
            catch (const std::exception &e)
            {
                server.reset();
                bound_port = 0;
                return std::format("cannot listen on 127.0.0.1:{}: {}", port, e.what());
            }
            // port 0 means "let the OS pick": the Host/Origin gate and the page's
            // own URLs must use the port actually bound, not the request.
            bound_port = server->local_port();
            if (bound_port == 0)
            {
                server.reset();
                return "cannot determine the bound HTTP port";
            }
            n_threads = std::max(n_threads, 1);
            work.emplace(asio::make_work_guard(io)); // see the member comment
            threads.emplace_back([this]
                                 { server->run(ros); });
            for (int i = 1; i < n_threads; i++)
                threads.emplace_back([this]
                                     { io.run(); });
            return "";
        }

        // Writes one drained batch; false as soon as the client is gone.
        template <typename Write>
        static bool write_batch(std::deque<std::string> &batch, const Write &write)
        {
            for (auto &line : batch)
            {
                try
                {
                    write("data: " + line + "\n\n");
                }
                catch (...)
                {
                    return false;
                }
            }
            return true;
        }

        void stop()
        {
            // release every SSE handler first, otherwise their blocking waits
            // would keep their worker threads parked
            std::vector<std::shared_ptr<sse_conn>> live;
            {
                std::lock_guard<std::mutex> lk(conns_mx);
                for (auto &w : conns)
                    if (auto s = w.lock())
                        live.push_back(std::move(s));
                conns.clear();
            }
            for (auto &c : live)
            {
                std::lock_guard<std::mutex> lk(c->mx);
                c->alive = false;
            }
            for (auto &c : live)
                c->cv.notify_all();
            // no new handler threads, and wait for the ones still running
            if (server)
                server->stop_handlers(15000);
            work.reset(); // the guard must go before stop(), or run()s never return
            io.stop();
            for (auto &t : threads)
                if (t.joinable())
                    t.join();
            threads.clear();
            server.reset();
            bound_port = 0;
        }
    };
} // namespace app
