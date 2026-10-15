// cell-app-http.hpp — the web service mode of the shell, built on the
// servic.cpp server + router components (third_party/include/{servic.hpp,
// router/router.hpp}).
//
//   GET  /              the same single-page UI the desktop shell renders
//   POST /api/cmd/:name the command bus (JSON body in, JSON out)
//   GET  /api/state     convenience: the full state snapshot
//   GET  /api/events    server-sent events: the same event stream the
//                       WebView view receives, one `data: {...}` per event
//   GET  /api/themes    third-party theme manifest (there are no built-in
//                       themes: the default look is the page's own :root,
//                       themes live in <exe dir>/.cell/theme/<name>/,
//                       the same root as config/sessions/vault)
//   GET  /api/theme/:name  a third-party theme's theme.css
//
// The service shares the app_core with any open desktop window: one agent,
// many viewers. Anything that mutates state goes through exec_command, so
// the two transports can never disagree about ordering.
#pragma once

#include "servic.hpp"

#include <boost/asio.hpp>
#include <filesystem>
#include <fstream>
#include <map>
#include <thread>

namespace app
{
    namespace asio = boost::asio;

    // =====================================================================
    //  主题系统（桌面外壳功能，CLI 不涉及）
    //
    //  没有内置主题：默认外观内置于 UI 页面（:root 浅色 + 跟随系统的深色，
    //  与 cell.cpp /export 导出页同一套令牌）。唯一的主题来源是第三方：
    //
    //      <exe 目录>/.cell/theme/<name>/theme.json   {"label","type","desc"}
    //      <exe 目录>/.cell/theme/<name>/theme.css    覆盖 CSS 自定义属性
    //
    //  即 cell::root/theme（cell::root = 可执行文件目录/.cell，与
    //  config.json / sessions / vault 同源）。前端把 theme.css 注入
    //  样式表末尾，只重定义变量即可完整换肤（含深浅）。
    // =====================================================================
    inline bool theme_name_ok(const std::string &n)
    {
        if (n.empty() || n.size() > 64)
            return false;
        for (unsigned char c : n)
            if (!(std::isalnum(c) || c == '-' || c == '_' || c == '.'))
                return false;
        return n.front() != '.';
    }

    struct theme_info
    {
        std::string name, label, type = "dark", desc;
        std::vector<std::string> swatch; // 主题代表色，供选择器做色板预览
    };

    // 扫描一个主题目录：每个子目录是一个主题，theme.json 提供元数据
    inline void scan_theme_dir(const std::filesystem::path &base, std::map<std::string, theme_info> &out)
    {
        std::error_code ec;
        if (!std::filesystem::is_directory(base, ec))
            return;
        auto it = std::filesystem::directory_iterator(base, ec);
        for (; !ec && it != std::filesystem::directory_iterator(); it.increment(ec))
        {
            if (!it->is_directory(ec))
                continue;
            std::string name = it->path().filename().string();
            if (!theme_name_ok(name) || out.count(name))
                continue; // 前面的目录已收录同名主题
            if (!std::filesystem::exists(it->path() / "theme.css", ec))
                continue; // 没有样式的主题无法应用
            theme_info t;
            t.name = name;
            t.label = name;
            std::ifstream jf(it->path() / "theme.json", std::ios::binary);
            if (jf)
            {
                auto j = nlohmann::json::parse(std::istreambuf_iterator<char>(jf), std::istreambuf_iterator<char>(), nullptr, false);
                if (j.is_object())
                {
                    if (j.value("label", "").size())
                        t.label = j["label"].get<std::string>();
                    if (j.value("type", "") == "light")
                        t.type = "light";
                    t.desc = j.value("desc", "");
                    if (j.contains("swatch") && j["swatch"].is_array())
                        for (auto &c : j["swatch"])
                            if (c.is_string() && t.swatch.size() < 4)
                                t.swatch.push_back(c.get<std::string>());
                }
            }
            out.emplace(name, t);
        }
    }

    // 完整主题清单：只有扫描到的第三方主题（默认外观不在清单里）
    inline std::vector<theme_info> list_themes()
    {
        std::map<std::string, theme_info> ext;
        scan_theme_dir(cell::root / "theme", ext); // 与配置/会话/凭据同目录
        std::vector<theme_info> out;
        for (auto &[name, t] : ext)
            out.push_back(t);
        return out;
    }

    // one live SSE connection; the bus sink writes through it under mx, the
    // handler thread waits on cv until the connection dies
    struct sse_conn
    {
        std::mutex mx;
        std::condition_variable cv;
        bool alive = true;
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

        std::mutex conns_mx;
        std::vector<std::weak_ptr<sse_conn>> conns;

        explicit http_service(app_core &c) : core(c) {}

        // ---- helpers ------------------------------------------------------
        static std::string http_response(const std::string &status, const std::string &ctype,
                                         const std::string &body, bool cors = false)
        {
            std::string r = "HTTP/1.1 " + status + "\r\nContent-Type: " + ctype + "\r\n";
            if (cors)
                r += "Access-Control-Allow-Origin: *\r\n"
                     "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                     "Access-Control-Allow-Headers: Content-Type\r\n"
                     "Access-Control-Allow-Private-Network: true\r\n";
            r += std::format("Content-Length: {}\r\nConnection: close\r\n\r\n", body.size());
            r += body;
            return r;
        }
        static std::string http_json(const nlohmann::json &j)
        {
            return http_response("200 OK", "application/json; charset=utf-8",
                                 j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), true);
        }
        // split a raw request into method / path / body
        static void parse_request(const std::string &raw, std::string &method, std::string &path, std::string &body)
        {
            method.clear();
            path.clear();
            body.clear();
            size_t line_end = raw.find_first_of("\r\n");
            if (line_end == std::string::npos)
                return;
            std::istringstream iss(raw.substr(0, line_end));
            std::string target, version;
            if (iss >> method >> target >> version)
            {
                size_t q = target.find('?');
                path = q == std::string::npos ? target : target.substr(0, q);
            }
            size_t hdr_end = raw.find("\r\n\r\n");
            if (hdr_end != std::string::npos)
                body = raw.substr(hdr_end + 4);
        }

        // ---- lifecycle -----------------------------------------------------
        // returns "" on success, else the failure reason
        std::string start(int port, int n_threads)
        {
            // -- routes ------------------------------------------------------
            ros.on("", [this](std::string &, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
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
                    {
                        cell::sys::logger::instance().warn("http", std::format("--ui file unreadable, serving the embedded page: {}", ui_path));
                    }
                }
                std::string r = http_response("200 OK", "text/html; charset=utf-8", html);
                if (from_disk)
                {
                    // dev mode: never cache, the file changes under us
                    size_t head = r.find("\r\n\r\n");
                    r.insert(head, "\r\nCache-Control: no-store");
                }
                out = std::move(r);
                return rt::FLAG_DONE; });

            ros.on("favicon.ico", [](std::string &, std::string &out, const std::map<std::string, std::string> &) -> int
                  {
                out = "HTTP/1.1 204 No Content\r\n\r\n";
                return rt::FLAG_DONE; });

            // GET /api/themes — 第三方主题清单（设置页主题选择器用）
            ros.on("api/themes", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                  {
                std::string method, path, body;
                parse_request(req, method, path, body);
                if (method == "OPTIONS")
                {
                    out = http_response("204 No Content", "text/plain", "", true);
                    return rt::FLAG_DONE;
                }
                nlohmann::json r = nlohmann::json{{"ok", true}};
                nlohmann::json arr = nlohmann::json::array();
                for (auto &t : list_themes())
                    arr.push_back({{"name", t.name}, {"label", t.label}, {"type", t.type},
                                   {"desc", t.desc}, {"swatch", t.swatch}});
                r["themes"] = std::move(arr);
                out = http_json(r);
                return rt::FLAG_DONE; });

            // GET /api/theme/:name — 第三方主题的 theme.css
            ros.on("api/theme/:name", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &params) -> int
                  {
                std::string method, path, body;
                parse_request(req, method, path, body);
                if (method == "OPTIONS")
                {
                    out = http_response("204 No Content", "text/plain", "", true);
                    return rt::FLAG_DONE;
                }
                std::string name = params.count("name") ? params.at("name") : "";
                if (!theme_name_ok(name))
                {
                    out = http_response("400 Bad Request", "text/plain; charset=utf-8", "bad theme name", true);
                    return rt::FLAG_DONE;
                }
                // 主题目录与配置/会话/凭据一致：<exe 目录>/.cell/theme/
                for (const auto &base : {cell::root / "theme"})
                {
                    std::error_code ec;
                    auto dir = std::filesystem::weakly_canonical(base / name, ec);
                    auto css = dir / "theme.css";
                    if (!std::filesystem::is_regular_file(css, ec))
                        continue;
                    std::ifstream f(css, std::ios::binary);
                    if (!f)
                        continue;
                    std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                    if (text.empty())
                        continue;
                    out = http_response("200 OK", "text/css; charset=utf-8", text, true);
                    // 第三方主题常改常试：不缓存，刷新即生效
                    size_t head = out.find("\r\n\r\n");
                    out.insert(head, "\r\nCache-Control: no-store");
                    return rt::FLAG_DONE;
                }
                out = http_response("404 Not Found", "text/plain; charset=utf-8", "theme not found", true);
                return rt::FLAG_DONE; });

            // POST /api/cmd/:name — the command bus
            ros.on("api/cmd/:name", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &params) -> int
                   {
                std::string method, path, body;
                parse_request(req, method, path, body);
                if (method == "OPTIONS")
                {
                    out = http_response("204 No Content", "text/plain", "", true);
                    return rt::FLAG_DONE;
                }
                std::string cmd = params.count("name") ? params.at("name") : "";
                nlohmann::json args = nlohmann::json::object();
                if (!body.empty())
                {
                    auto j = nlohmann::json::parse(body, nullptr, false);
                    if (j.is_object())
                        args = std::move(j);
                }
                out = http_json(core.exec_command(cmd, args));
                return rt::FLAG_DONE; });

            // GET /api/state — full snapshot
            ros.on("api/state", [this](std::string &req, std::string &out, const std::map<std::string, std::string> &) -> int
                   {
                std::string method, path, body;
                parse_request(req, method, path, body);
                if (method == "OPTIONS")
                {
                    out = http_response("204 No Content", "text/plain", "", true);
                    return rt::FLAG_DONE;
                }
                out = http_json(core.exec_command("state", nlohmann::json::object()));
                return rt::FLAG_DONE; });

            // GET /api/events — SSE stream
            ros.on_stream("api/events", [this](std::string &, rt::WriteCallback write, const std::map<std::string, std::string> &)
                          {
                write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                      "Cache-Control: no-cache\r\nConnection: keep-alive\r\n"
                      "Access-Control-Allow-Origin: *\r\n\r\n");
                write(": connected\n\n");
                auto conn = std::make_shared<sse_conn>();
                conn->write = [write](const std::string &s) { write(s); };
                {
                    std::lock_guard<std::mutex> lk(conns_mx);
                    conns.push_back(conn);
                }
                int sink_id = core.bus.add([conn](const std::string &line)
                {
                    std::lock_guard<std::mutex> lk(conn->mx);
                    if (!conn->alive)
                        return;
                    try
                    {
                        conn->write("data: " + line + "\n\n");
                    }
                    catch (...)
                    {
                        conn->alive = false;
                        conn->cv.notify_all();
                    }
                });
                // keep the coroutine parked until the client goes away: the
                // sink marks us dead on the first failed write, the heartbeat
                // catches half-open connections
                {
                    std::unique_lock<std::mutex> lk(conn->mx);
                    while (conn->alive)
                    {
                        if (conn->cv.wait_for(lk, std::chrono::seconds(15), [&] { return !conn->alive; }))
                            break;
                        try
                        {
                            conn->write(": ping\n\n");
                        }
                        catch (...)
                        {
                            conn->alive = false;
                            break;
                        }
                    }
                }
                core.bus.remove(sink_id);
                return; });

            // -- start ------------------------------------------------------
            try
            {
                // large enough for base64 uploads (~48 MiB file cap)
                server = std::make_unique<servic::Server>(io, (short)port, 72 * 1024 * 1024);
            }
            catch (const std::exception &e)
            {
                server.reset();
                return std::format("cannot listen on port {}: {}", port, e.what());
            }
            if (n_threads < 1)
                n_threads = 1;
            work.emplace(asio::make_work_guard(io)); // see the member comment
            threads.emplace_back([this]
                                 { server->run(ros); });
            for (int i = 1; i < n_threads; i++)
                threads.emplace_back([this]
                                     { io.run(); });
            return "";
        }

        void stop()
        {
            // release every SSE handler first, otherwise their blocking waits
            // would keep io_context threads parked forever
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
            work.reset(); // the guard must go before stop(), or run()s never return
            io.stop();
            for (auto &t : threads)
                if (t.joinable())
                    t.join();
            threads.clear();
        }
    };
} // namespace app
