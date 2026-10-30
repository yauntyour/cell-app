// cell-app.cpp — the desktop shell (WebView2) and web service entry point
// for cell.cpp.
//
//   cell-app.exe                    the desktop app
//   cell-app.exe --serve [PORT]     desktop app + HTTP service (default 8787)
//   cell-app.exe --headless [PORT]  HTTP service only, no window
//
// The single-file CLI (cell.cpp) is included verbatim with its main()
// renamed; the shared runtime (app_core, the command bus and the event bus)
// lives in cell-app-core.hpp, the HTTP service in cell-app-http.hpp and the
// embedded frontend in cell-ui.hpp.
//
//   JS  -> C++ :  host_pick_folder (sync: native folder picker -> path JSON)
//   C++ -> JS  :  none — the page is a pure HTTP/SSE client, exactly like any
//                 browser. (The old host_ready/host_cmd JS bridge was never
//                 called by the shipped page and has been removed.)
//
// Threading: the agent turn runs on one worker thread; commands run on
// short-lived threads (or the asio pool when they arrive over HTTP); every
// event is marshalled onto the UI thread with webview::dispatch.
#define main original_main
#include "cell.cpp/cell.cpp"
#undef main

#include "webview/webview.h"

#include "cell-ui.hpp"
#include "cell-app-core.hpp"
#include "cell-app-http.hpp"

#include <csignal>
#include <cstdlib> // std::strtol for the --serve/--headless port parser
#ifdef _WIN32
#include <shellapi.h> // NOTIFYICONDATAW / Shell_NotifyIconW — the tray icon
#include <shobjidl.h> // IFileOpenDialog — the native picker behind host_pick_folder
#endif

namespace app
{
    // =====================================================================
    //  open_url — hand a web link to the OS default handler, i.e. a real
    //  browser process (ShellExecuteW / xdg-open / open), never a window
    //  derived from the shell: WebView2 has no NewWindowRequested handler, so
    //  window.open there only ever spawns a child window of this app.
    //  Only http(s) and only characters that are safe to hand to a shell —
    //  the link comes from a remote page.
    // =====================================================================
    static bool open_url(const std::string &url, void *owner)
    {
        if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0)
            return false;
        for (unsigned char ch : url)
            if (ch <= 0x20 || ch >= 0x7f || std::string_view("\"'`<>|^&;\\").find((char)ch) != std::string_view::npos)
                return false;
#ifdef _WIN32
        const std::wstring w = cell::plat::utf8_to_wide(url);
        // `open` = the user's default handler for the protocol, so the default
        // browser comes up as its own window; owner only anchors any dialog
        const INT_PTR rc = reinterpret_cast<INT_PTR>(ShellExecuteW(reinterpret_cast<HWND>(owner), L"open", w.c_str(),
                                                                  nullptr, nullptr, SW_SHOWNORMAL));
        if (rc <= 32) // nothing else reports this: keep the reason in the log
            cell::sys::logger::instance().warn(
                "app", std::format("open_url failed: ShellExecute={} url={}", rc, url));
        return rc > 32;
#elif defined(__APPLE__)
        (void)owner;
        return std::system(("open '" + url + "' >/dev/null 2>&1").c_str()) == 0;
#else
        (void)owner;
        return std::system(("xdg-open '" + url + "' >/dev/null 2>&1 &").c_str()) == 0;
#endif
    }

#ifdef _WIN32
    // =====================================================================
    //  pick_folder — the native folder picker behind the host_pick_folder
    //  binding (the "open workspace" dialog's 浏览… button). It runs on the
    //  UI thread: the webview dispatches every binding call there, and that
    //  thread is STA (win32_edge_engine::window_init), which is what
    //  IFileOpenDialog requires. Show() pumps its own modal loop, so the
    //  window stays responsive while the dialog is up.
    //  Returns {"ok":true,"path":...}, or {"ok":false} on cancel/failure.
    // =====================================================================
    static std::string pick_folder(HWND owner)
    {
        std::string out = "{\"ok\":false}";
        IFileOpenDialog *dlg = nullptr;
        if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                    IID_PPV_ARGS(&dlg))))
            return out;
        FILEOPENDIALOGOPTIONS opts = 0;
        if (SUCCEEDED(dlg->GetOptions(&opts)))
            dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (SUCCEEDED(dlg->Show(owner)))
        {
            IShellItem *item = nullptr;
            if (SUCCEEDED(dlg->GetResult(&item)) && item)
            {
                PWSTR p = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p)
                {
                    out = nlohmann::json{{"ok", true},
                                         {"path", cell::plat::wide_to_utf8(p)}}
                              .dump();
                    CoTaskMemFree(p);
                }
                item->Release();
            }
        }
        dlg->Release();
        return out;
    }

    // =====================================================================
    //  tray — closing the window parks the app in the notification area
    //  instead of quitting. webview.h destroys the window on WM_CLOSE (and
    //  that tears the process down), so the window proc is replaced with one
    //  that only hides it: agent turns, the HTTP service and the notice
    //  watcher keep running. The icon is owned by a hidden window of our own,
    //  so the shell callbacks never depend on the WebView2 window.
    // =====================================================================
    namespace tray
    {
        constexpr UINT kMsg = WM_APP + 17;  // shell callback message
        constexpr UINT kShow = 1;           // menu ids
        constexpr UINT kQuit = 2;
        constexpr UINT kIconId = 1;

        static HWND g_main = nullptr;         // the webview window
        static WNDPROC g_main_proc = nullptr; // its original window proc
        static HWND g_msg = nullptr;          // hidden helper window owning the icon
        static HICON g_icon = nullptr;
        static UINT g_taskbar_created = 0;    // broadcast when Explorer restarts
        static bool g_quitting = false;       // a real close is in flight
        static bool g_balloon = false;        // "still running" hint, shown once
        // the "close parks in the tray" preference (.cell/cell-app.json). The
        // window proc stays hooked either way and just consults this flag, so
        // the setting can be flipped while the app runs.
        static std::atomic<bool> g_enabled{true};

        static NOTIFYICONDATAW icon_data()
        {
            NOTIFYICONDATAW nid{};
            nid.cbSize = sizeof(nid);
            nid.hWnd = g_msg;
            nid.uID = kIconId;
            return nid;
        }

        static bool add_icon()
        {
            if (!g_msg)
                return false;
            NOTIFYICONDATAW nid = icon_data();
            nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
            nid.uCallbackMessage = kMsg;
            nid.hIcon = g_icon;
            wcsncpy(nid.szTip, L"cell", sizeof(nid.szTip) / sizeof(nid.szTip[0]) - 1);
            return Shell_NotifyIconW(NIM_ADD, &nid) != FALSE;
        }

        static void remove_icon()
        {
            if (!g_msg)
                return;
            NOTIFYICONDATAW nid = icon_data();
            Shell_NotifyIconW(NIM_DELETE, &nid);
        }

        static void restore()
        {
            if (!g_main || !IsWindow(g_main))
                return;
            ShowWindow(g_main, IsIconic(g_main) ? SW_RESTORE : SW_SHOW);
            SetForegroundWindow(g_main);
            SwitchToThisWindow(g_main, TRUE); // foreground lock fallback
        }

        static void quit()
        {
            g_quitting = true;
            remove_icon();
            // WM_DESTROY (not WM_CLOSE — that one now hides) ends webview's loop
            if (g_main && IsWindow(g_main))
                DestroyWindow(g_main);
        }

        static void balloon_once()
        {
            if (g_balloon || !g_msg)
                return;
            g_balloon = true;
            NOTIFYICONDATAW nid = icon_data();
            nid.uFlags = NIF_INFO;
            nid.dwInfoFlags = NIIF_INFO;
            wcsncpy(nid.szInfoTitle, L"cell", sizeof(nid.szInfoTitle) / sizeof(nid.szInfoTitle[0]) - 1);
            wcsncpy(nid.szInfo, L"窗口已关闭，程序仍在后台运行；单击托盘图标可恢复。",
                    sizeof(nid.szInfo) / sizeof(nid.szInfo[0]) - 1);
            Shell_NotifyIconW(NIM_MODIFY, &nid);
        }

        static void show_menu(HWND owner)
        {
            HMENU m = CreatePopupMenu();
            if (!m)
                return;
            AppendMenuW(m, MF_STRING, kShow, L"显示主窗口");
            AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
            AppendMenuW(m, MF_STRING, kQuit, L"退出");
            SetMenuDefaultItem(m, kShow, FALSE);
            POINT pt{};
            GetCursorPos(&pt);
            // the owner must be foreground or the menu ignores outside clicks
            SetForegroundWindow(owner);
            TrackPopupMenuEx(m, TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
                             pt.x, pt.y, owner, nullptr);
            PostMessageW(owner, WM_NULL, 0, 0);
            DestroyMenu(m);
        }

        static LRESULT CALLBACK msg_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
        {
            if (msg == kMsg)
            {
                // no NIM_SETVERSION: lParam carries the plain mouse message
                switch (LOWORD(lp))
                {
                case WM_LBUTTONUP:
                case WM_LBUTTONDBLCLK:
                    restore();
                    break;
                case WM_RBUTTONUP:
                case WM_CONTEXTMENU:
                    show_menu(hwnd);
                    break;
                }
                return 0;
            }
            if (g_taskbar_created && msg == g_taskbar_created)
            {
                if (g_enabled.load())
                    add_icon(); // Explorer restarted and took the icon with it
                return 0;
            }
            if (msg == WM_COMMAND)
            {
                switch (LOWORD(wp))
                {
                case kShow:
                    restore();
                    return 0;
                case kQuit:
                    quit();
                    return 0;
                }
            }
            return DefWindowProcW(hwnd, msg, wp, lp);
        }

        static LRESULT CALLBACK main_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
        {
            if (msg == WM_CLOSE && !g_quitting && g_enabled.load())
            {
                ShowWindow(hwnd, SW_HIDE);
                balloon_once();
                return 0;
            }
            return CallWindowProcW(g_main_proc, hwnd, msg, wp, lp);
        }

        // Hook a live webview window: icon + close interception. Must run on
        // the UI thread (the one run() pumps messages on) before run().
        // `enabled` is the persisted preference: off means the hook stays inert
        // (WM_CLOSE quits) and no icon is installed.
        static bool attach(HWND main, bool enabled)
        {
            if (!main || g_main)
                return false;
            HINSTANCE inst = GetModuleHandleW(nullptr);
            g_icon = reinterpret_cast<HICON>(
                LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON,
                           GetSystemMetrics(SM_CXSMICON),
                           GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
            if (!g_icon)
                // the build is not UNICODE, so IDI_APPLICATION is an A-flavoured
                // MAKEINTRESOURCE — cast it for the explicit W entry point
                g_icon = LoadIconW(nullptr, reinterpret_cast<LPCWSTR>(IDI_APPLICATION));

            WNDCLASSEXW wc{};
            wc.cbSize = sizeof(wc);
            wc.hInstance = inst;
            wc.lpszClassName = L"cell_tray";
            wc.lpfnWndProc = msg_proc;
            RegisterClassExW(&wc);
            // a plain hidden window, not HWND_MESSAGE: the tray menu calls
            // SetForegroundWindow(owner) so an outside click dismisses it, and
            // a message-only window can never be foreground
            g_msg = CreateWindowExW(WS_EX_TOOLWINDOW, L"cell_tray", L"", WS_POPUP,
                                    0, 0, 0, 0, nullptr, nullptr, inst, nullptr);
            if (!g_msg)
                return false;
            g_enabled.store(enabled);
            g_taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
            if (enabled && !add_icon())
            {
                // no icon means no way back from a hidden window: stay inert
                g_enabled.store(false);
                DestroyWindow(g_msg);
                g_msg = nullptr;
                return false;
            }

            g_main_proc = reinterpret_cast<WNDPROC>(
                SetWindowLongPtrW(main, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(main_proc)));
            if (!g_main_proc)
            {
                DestroyWindow(g_msg);
                g_msg = nullptr;
                return false;
            }
            g_main = main;
            return true;
        }

        // runtime switch for the preference: the icon comes and goes, the
        // window proc stays hooked. Turning it off while the window is parked
        // must not strand it — bring it back before dropping the only way
        // (the icon) to reach it.
        static void set_enabled(bool on)
        {
            if (g_enabled.exchange(on) == on)
                return;
            if (on)
            {
                if (!add_icon())
                    g_enabled.store(false); // no icon = nothing to restore the window with
                return;
            }
            remove_icon();
            if (g_main && IsWindow(g_main) && !IsWindowVisible(g_main))
                restore();
        }

        static void detach()
        {
            g_quitting = true;
            remove_icon();
            if (g_msg)
            {
                DestroyWindow(g_msg);
                g_msg = nullptr;
            }
        }
    } // namespace tray
#endif

    static void print_usage()
    {
        printf("cell — desktop shell + web service\n\n");
        printf("usage: cell-app.exe [options]\n\n");
        printf("  --serve [PORT]    also expose the same UI and API over HTTP\n");
        printf("                    (default port 8787)\n");
        printf("  --headless [PORT] start only the HTTP service, no window\n");
        printf("  --ui FILE         serve the UI page from this file (dev mode:\n");
        printf("                    edit + refresh, no rebuild; default: embedded)\n");
        printf("  --update-check    compare this build with the newest GitHub release\n");
        printf("                    and print the verdict (no window; exit codes:\n");
        printf("                    0 = up to date, 1 = update available, 2 = no answer)\n");
        printf("  --help            show this help\n\n");
        printf("Smoke tests (isolated data root, exit automatically):\n");
        printf("  --smoke           UI bridge only\n");
        printf("  --smoke-engine    UI bridge + one engine turn\n");
        printf("  --smoke-ws        UI bridge + two workspaces in parallel\n\n");
        printf("Configuration, sessions and the credential vault are shared with\n");
        printf("the CLI (they live in <exe dir>\\.cell); run the CLI once to add\n");
        printf("a provider if none is configured yet.\n");
    }

    // SIGINT/SIGTERM flag for --headless
    static std::atomic<bool> g_signal_stop{false};

    int gui_main(int argc, char const *argv[])
    {
        std::string ui_arg; // --ui FILE: serve the page from disk (dev mode)
        int smoke = 0;
        int serve_port = 0; // 0 = no HTTP service
        bool headless = false;
        bool update_check = false; // --update-check: probe and print, then leave
        for (int i = 1; i < argc; i++)
        {
            std::string a = argv[i];
            // --serve / --headless take an optional port in 1..65535. A
            // non-numeric/out-of-range value used to become 0 (silently no
            // service, headless spun forever) - reject the command line instead.
            auto port_arg = [&](const char *flag) -> int
            {
                if (i + 1 < argc && argv[i + 1][0] != '-')
                {
                    const char *s = argv[++i];
                    char *end = nullptr;
                    long v = std::strtol(s, &end, 10);
                    if (!end || *end != '\0' || v < 1 || v > 65535)
                    {
                        fprintf(stderr, "invalid port for %s: '%s' (expected 1..65535)\n", flag, s);
                        return -1;
                    }
                    return (int)v;
                }
                return 8787;
            };
            if (a == "--ui" && i + 1 < argc)
                ui_arg = argv[++i];
            else if (a == "--serve")
            {
                serve_port = port_arg("--serve");
                if (serve_port < 0)
                    return 2;
            }
            else if (a == "--headless")
            {
                headless = true;
                serve_port = port_arg("--headless");
                if (serve_port < 0)
                    return 2;
            }
            else if (a == "--smoke")
                smoke = 1;
            else if (a == "--smoke-engine")
                smoke = 2;
            else if (a == "--smoke-ws")
                smoke = 3;
            else if (a == "--update-check")
                update_check = true;
            else if (a == "--help" || a == "-h")
            {
                print_usage();
                return 0;
            }
            else
            {
                fprintf(stderr, "unknown argument: %s\n", a.c_str());
                print_usage();
                return 1;
            }
        }
        if (update_check)
        {
            // probe only: no window, no config, no session — the desktop app
            // asks the same question once per launch (app_core::start_update_check)
            curl_global_init(CURL_GLOBAL_DEFAULT);
            nlohmann::json r = update::probe();
            printf("%s\n", r.dump(2).c_str());
            fflush(stdout);
            cell::net::curl_global_shutdown();
            const std::string state = r.value("state", "error");
            return state == "current" ? 0 : state == "available" ? 1 : 2;
        }
#ifdef _WIN32
        // 进程唯一性（桌面窗口模式）：重复启动 = 把焦点交给已运行实例的窗口
        // 然后退出——两个 GUI 进程会抢同一个数据根、反复绑定服务端口。
        // --headless / --smoke 是开发与自动化通道（可用不同数据根/端口），
        // 不在单实例约束内。
        if (!smoke && !headless)
        {
            // GetLastError() 必须紧跟 CreateMutexW() 读取：此前写成 static 局部
            // 初始化，C++ 的静态守卫例程（__cxa_guard_*）会清掉 last-error，
            // 守卫永远读不到 ERROR_ALREADY_EXISTS。句柄刻意不关——它把
            // 「本进程持有单实例锁」保持到进程退出。
            HANDLE inst = CreateMutexW(nullptr, FALSE, L"Local\\cell-app-desktop");
            DWORD inst_err = GetLastError();
            if (inst && inst_err == ERROR_ALREADY_EXISTS)
            {
                if (HWND h = FindWindowW(L"webview", nullptr))
                {
                    // a window parked in the tray is hidden, not iconic — it
                    // needs an explicit show or the relaunch looks like a no-op
                    if (!IsWindowVisible(h) || IsIconic(h))
                        ShowWindow(h, SW_RESTORE);
                    SetForegroundWindow(h);
                    SwitchToThisWindow(h, TRUE); // 前台锁失效时的兜底
                }
                printf("cell-app already running - switched to the existing instance\n");
                return 0;
            }
        }
#endif

        // smoke runs use a throwaway data root so no real session, config or
        // log is touched (must happen before the logger singleton initializes,
        // otherwise it opens its file under the real root)
        if (smoke)
            cell::root = std::filesystem::temp_directory_path() / "cell-desktop-smoke";

        auto &log = cell::sys::logger::instance();
        cell::sys::install_handlers();

        curl_global_init(CURL_GLOBAL_DEFAULT);
        int sodium_rc = sodium_init();
        (void)sodium_rc;

        app_core core;

        if (auto res = cell::config::load())
            core.cfg = *res;
        else
            log.warn("app", std::format("config load: {}", res.error()));

        // apply the exec sandbox mode from config (default: full-access)
        {
            std::string m = cell::text::trim(core.cfg.sandbox_mode);
            if (m == "read-only" || m == "readonly")
                cell::box::sandbox_mode() = cell::box::SandboxMode::ReadOnly;
            else if (m == "edit-only" || m == "edit")
                cell::box::sandbox_mode() = cell::box::SandboxMode::EditOnly;
            else if (m == "full-access" || m == "full")
                cell::box::sandbox_mode() = cell::box::SandboxMode::FullAccess;
            else
            {
                log.warn("app", std::format("unknown sandbox mode '{}' - using full-access", m));
                core.cfg.sandbox_mode = "full-access";
            }
            cell::box::autoallow_enabled() = core.cfg.autoallow && cell::box::sandbox_mode() == cell::box::SandboxMode::FullAccess;
        }

        // configure the read-only tool worker pool from config.json
        cell::sys::pool_max_setting() = std::clamp(core.cfg.max_threads, (size_t)1, (size_t)16);

        // The shell starts with NO workspace open: the user picks a directory
        // (工作区 / ➕ 新会话 / /workspace). Previously the launch directory was
        // auto-opened here, which created a session as a side effect of merely
        // starting the app — surprising, and it left a stray session behind for
        // anyone who launched the shell from an arbitrary directory.
        //
        // Smoke runs are the one exception: they need a live context to drive
        // (--smoke-engine queues a turn on every open workspace, and they run
        // against a throwaway data root anyway).
        if (smoke)
        {
            std::string err;
            workspace_ctx *boot = core.ensure_workspace(cell::workdir().string(), &err);
            if (!boot)
                log.warn("app", std::format("workspace open failed: {}", err));
            else
            {
                core.active_ws = boot->cwd_key;
                // smoke runs never resume: everything below must start clean
                boot->h.forget_current();
                boot->prompt = boot->eng->ensure_prompt();
            }
        }
        // live notice delivery: idle sessions see cross-session notices the
        // moment they land (peek-only, ~0.7s cadence; see app_core)
        core.start_notice_watcher();
        if (cell::stats::prune())
            log.info("stats", "boot pruned orphaned session usage records");

        // ---- HTTP service (--serve / --headless) --------------------------
        // NOTE: in desktop mode the service starts only AFTER the window has
        // been created. WebView2's initialization pairs WSAStartup with
        // WSACleanup; with a statically linked runtime that can drop the
        // process-wide winsock reference count to zero, which silently kills
        // an acceptor that was already running (its sockets stop delivering
        // events while the port still shows as LISTENING).
        http_service http(core);
        http.ui_path = ui_arg; // --ui FILE: serve the page from disk instead
        auto start_http = [&]() -> bool
        {
            if (serve_port <= 0)
                return true;
            std::string err = http.start(serve_port, 4);
            if (!err.empty())
            {
                log.error("http", err);
                return false;
            }
            log.info("http", std::format("serving on http://127.0.0.1:{}/ (desktop={})", serve_port, !headless));
            return true;
        };

        int rc = 0;
        {
            // RAII exit guard: persists the session + config and cleans up
            // libcurl no matter how the shell leaves this scope
            auto on_exit = cell::sys::make_scoped_exit([&]
                                                       {
                try
                {
                    for (auto *c : core.all_ctxs())
                    {
                        cell::chat::repair_tool_pairing(c->h.now().msg());
                        c->h.now().unload();
                    }
                }
                catch (const std::exception &)
                {
                }
                if (!smoke)
                    core.save_cfg(); // one active-session entry per workspace
                cell::async_io::flush(); // drain queued session/config/index writes
                // a background teamwork run may still be in flight
                cell::teamwork::bg_shutdown();
                cell::sys::pool().shutdown(); // join tool workers before curl cleanup
                cell::net::curl_global_shutdown(); });

            if (headless)
            {
                // service-only mode: run until Ctrl+C / a termination signal
                if (!start_http())
                {
                    core.shutdown();
                    return 1;
                }
                std::signal(SIGINT, [](int)
                            { g_signal_stop.store(true); });
                std::signal(SIGTERM, [](int)
                            { g_signal_stop.store(true); });
                log.info("app", "headless mode: Ctrl+C to stop");
                while (!g_signal_stop.load())
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));

                core.begin_shutdown();
                http.stop();
                core.wait_idle(std::chrono::seconds(30));
                // every pty shell and its reader thread goes down with the app
                app::term::shutdown_all();
                core.shutdown();
            }
            else
            {
                // one update probe per process, and only for the desktop app:
                // --headless and the smoke runs are automation channels. Runs
                // off this thread; the page reads the verdict from its boot
                // `state`, or receives it as a live "update" event.
                if (!smoke)
                    core.start_update_check();

                // ---- desktop window ---------------------------------------
                webview::webview w(false, nullptr);
                w.set_title("cell");
                w.set_size(900, 600, WEBVIEW_HINT_MIN);
                w.set_size(1160, 800, WEBVIEW_HINT_NONE);
                // WebView2 has finished its one-time initialization by now (it
                // runs inside the constructor): safe to bring the HTTP service
                // up without its winsock cleanup racing the acceptor (see the
                // note above). The window then loads the same page a browser
                // gets: one page, one transport (HTTP + SSE).
                bool served = false;
                if (serve_port > 0)
                {
                    served = start_http();
                }
                else
                {
                    for (int p = 8787; p <= 8806 && !served; p++)
                    {
                        serve_port = p;
                        served = start_http();
                    }
                    if (!served)
                        log.error("http", "no free port in 8787..8806 - the embedded page has no HTTP "
                                          "backend and boots in demo mode (set --serve PORT)");

                }

                // smoke tests: the page announces itself by issuing its boot
                // `state` command over HTTP; the first one flips this switch
                auto smoke_fired = std::make_shared<std::atomic<bool>>(false);
                if (smoke)
                    core.on_command = [&w, &core, smoke, smoke_fired](const std::string &name)
                    {
                        if (name != "state" || smoke_fired->exchange(true))
                            return;
                        if (smoke == 1)
                        {
                            printf("SMOKE_UI_OK\n");
                            fflush(stdout);
                            w.dispatch([&w]()
                                       { w.terminate(); });
                        }
                        else if (smoke == 2)
                        {
                            // the stack is live: drive one engine round. No
                            // provider is configured in the throwaway root, so
                            // the round takes the immediate "no model" error
                            // path and still exercises the full pipeline.
                            printf("SMOKE_UI_OK (probing engine)\n");
                            fflush(stdout);
                            core.bus.add([&w](const std::string &line)
                                         {
                                if (line.find("\"turn_end\"") != std::string::npos)
                                {
                                    printf("SMOKE_ENGINE_OK\n");
                                    fflush(stdout);
                                    w.dispatch([&w]() { w.terminate(); });
                                } });
                            for (auto *c : core.all_ctxs())
                                c->queue_turn("hello from the desktop-shell smoke test");
                        }
                        else if (smoke == 3)
                        {
                            // two workspaces in parallel: each gets one turn and
                            // must produce its own (ws-tagged) turn_end
                            printf("SMOKE_UI_OK (probing two workspaces)\n");
                            fflush(stdout);
                            std::error_code sec;
                            std::filesystem::path wa = cell::root / "smoke-ws-a";
                            std::filesystem::path wb = cell::root / "smoke-ws-b";
                            std::filesystem::create_directories(wa, sec);
                            std::filesystem::create_directories(wb, sec);
                            std::string werr;
                            workspace_ctx *ca = core.ensure_workspace(wa.string(), &werr);
                            workspace_ctx *cb = core.ensure_workspace(wb.string(), &werr);
                            if (!ca || !cb)
                            {
                                printf("SMOKE_WS_FAIL (%s)\n", werr.c_str());
                                fflush(stdout);
                                w.dispatch([&]()
                                           { w.terminate(); });
                            }
                            else
                            {
                                const std::string ka = ca->cwd_key, kb = cb->cwd_key;
                                auto seen = std::make_shared<std::set<std::string>>();
                                core.bus.add([&w, seen, ka, kb](const std::string &line)
                                             {
                                    if (line.find("\"turn_end\"") == std::string::npos)
                                        return;
                                    auto j = nlohmann::json::parse(line, nullptr, false);
                                    if (!j.is_object())
                                        return;
                                    std::string ws = j.value("ws", "");
                                    if (ws != ka && ws != kb)
                                        return;
                                    seen->insert(ws);
                                    if (seen->size() == 2)
                                    {
                                        printf("SMOKE_WS_OK\n");
                                        fflush(stdout);
                                        w.dispatch([&w]() { w.terminate(); });
                                    } });
                                ca->queue_turn("hello from smoke workspace A");
                                cb->queue_turn("hello from smoke workspace B");
                            }
                        }
                    };

                // Only the native folder picker goes through the JS bridge; the
                // page itself is a pure HTTP/SSE client like any browser tab.
#ifdef _WIN32
                // host_pick_folder — native folder picker for the "open
                // workspace" dialog. Synchronous on purpose: the modal
                // dialog must own the UI thread's message loop while up.
                w.bind("host_pick_folder", [&w](std::string) -> std::string
                       {
                    HWND owner = nullptr;
                    if (auto win = w.window(); win.ok())
                        owner = reinterpret_cast<HWND>(win.value());
                    return pick_folder(owner); });
#endif
                // host_open_url — the update chip: the page hands the release
                // link over and the shell pops the user's default browser.
                // A sync binding receives the raw JSON argument array
                // ("[\"https://…\"]"), not the unwrapped first argument.
                w.bind("host_open_url", [&w](std::string args) -> std::string
                       {
                    std::string url;
                    auto a = nlohmann::json::parse(args, nullptr, false);
                    if (a.is_array() && !a.empty() && a[0].is_string())
                        url = a[0].get<std::string>();
                    else if (a.is_string())
                        url = a.get<std::string>();
                    void *owner = nullptr;
                    if (auto win = w.window(); win.ok())
                        owner = reinterpret_cast<void *>(win.value());
                    return open_url(url, owner) ? "{\"ok\":true}" : "{\"ok\":false}"; });

                if (served)
                {
                    try
                    {
                        w.navigate(std::format("http://127.0.0.1:{}/", serve_port));
                    }
                    catch (const std::exception &e)
                    {
                        log.warn("app", std::format("navigate failed ({}), using the embedded page", e.what()));
                        served = false;
                    }
                }
                if (!served)
                {
                    w.set_html(app::kUiHtml);
                    if (smoke)
                    {
                        printf("SMOKE_FAIL (no HTTP page to probe)\n");
                        fflush(stdout);
                        w.dispatch([&]()
                                   { w.terminate(); });
                    }
                }

                log.info("app", std::format("window up: workspaces={} active={} model={} providers={} sandbox={} serve={}",
                                            core.ctxs.size(), core.active_ws, core.cfg.model_label(), core.cfg.providers.size(),
                                            cell::box::mode_name(cell::box::sandbox_mode()), serve_port));
#ifdef _WIN32
                // desktop shell only: smoke runs terminate themselves and must
                // not leave an icon (or a close that hides) behind
                if (!smoke)
                {
                    HWND hwnd = nullptr;
                    if (auto win = w.window(); win.ok())
                        hwnd = reinterpret_cast<HWND>(win.value());
                    // 设置 → 关于 → 桌面 → 关闭窗口后驻留托盘: on parks the app
                    // in the notification area, off makes a close quit like any
                    // other window. Flips at runtime dispatch to the UI thread.
                    core.on_tray = [&w](bool on)
                    { w.dispatch([on] { tray::set_enabled(on); }); };
                    if (!tray::attach(hwnd, core.prefs.tray))
                        log.warn("app", "tray: icon install failed - closing the window will quit");
                    else if (core.prefs.tray)
                        log.info("app", "tray: closing the window parks the app in the notification area");
                    else
                        log.info("app", "tray: off - closing the window quits");
                }
#endif
                w.run(); // blocks until the window is destroyed (tray → 退出)
#ifdef _WIN32
                tray::detach();
#endif

                // window closed: refuse new commands, stop the service (no
                // command can arrive afterwards), drain in-flight commands,
                // then join the workspace workers. The old order - shutdown()
                // before http.stop() - could leave a workspace opened in the
                // gap with a joinable worker thread, aborting the process on
                // exit.
                core.begin_shutdown();
                http.stop();
                core.wait_idle(std::chrono::seconds(30));
                // every pty shell and its reader thread goes down with the app
                app::term::shutdown_all();
                core.shutdown();
                long long reqs = 0, tools = 0;
                for (auto *c : core.all_ctxs())
                    if (c->eng)
                    {
                        reqs += c->eng->llm_requests();
                        tools += c->eng->tool_calls();
                    }
                log.info("exit", std::format("llm_requests={} tool_calls={}", reqs, tools));
            }
        }
        return rc;
    }
} // namespace app

int main(int argc, char const *argv[])
{
    return app::gui_main(argc, argv);
}
