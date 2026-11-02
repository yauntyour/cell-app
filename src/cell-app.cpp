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
#include <dwmapi.h>   // DwmSetWindowAttribute — 圆角 / 深色窗口框（frame）
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

    // =====================================================================
    //  frame — 真·无边框窗口（页面自绘标题栏）
    //
    //  Windows 上**保留** WS_CAPTION / WS_THICKFRAME：DWM 的投影、贴边分屏、
    //  最大化动画都挂在它们身上。真正去掉标题栏的是 WM_NCCALCSIZE
    //  —— 它把非客户区算成 0，于是客户区就是整个窗口，边框和标题栏都不再
    //  占位也不被绘制。窗口看上去只剩内容，但仍然是系统眼里的"正常窗口"。
    //
    //  鼠标交互由页面负责：WebView2 是覆盖整个客户区的子窗口，父窗口根本
    //  收不到 WM_NCHITTEST，所以拖拽/缩放只能由页面发起 —— 页面的拖拽区调
    //  host_win {op:"drag"}，这里换发 WM_NCLBUTTONDOWN + HTCAPTION，走的是
    //  系统自己的移动循环，Aero Snap、拖到边缘分屏、最大化后拖拽还原全部
    //  照旧。缩放同理（HTLEFT / HTTOPLEFT / …）。
    // =====================================================================
    namespace frame
    {
        static HWND g_win = nullptr;
        static WNDPROC g_prev = nullptr; // webview.h 原来的窗口过程
        static bool g_page_ready = false;
        static std::function<void(const std::string &)> g_eval; // UI 线程上的 eval
        static void *g_controller = nullptr;                    // ICoreWebView2Controller*
        static int frame_pad()
        {
            return GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
        }

        // 最大化状态变了就告诉页面：窗口按钮要在 最大化 ⇄ 还原 之间切换，
        // 而 Win+↑ / 双击 / 贴边分屏都不经过页面，只能由这里广播。
        static void notify_state()
        {
            if (!g_win || !g_page_ready || !g_eval)
                return;
            const bool maxed = IsZoomed(g_win) != 0;
            g_eval(std::string("window.__cellWinState&&window.__cellWinState({maximized:") +
                   (maxed ? "true" : "false") + "})");
        }

        static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
        {
            switch (msg)
            {
            case WM_NCCALCSIZE:
                // 唯一的"去边框"动作：客户区 = 窗口矩形。
                // 最大化时系统给的矩形比屏幕大一圈（正是边框厚度），不减掉
                // 内容会溢出到屏幕外、底部被任务栏切掉。
                if (wp)
                {
                    if (IsZoomed(hwnd))
                    {
                        auto *p = reinterpret_cast<NCCALCSIZE_PARAMS *>(lp);
                        const int b = frame_pad();
                        p->rgrc[0].left += b;
                        p->rgrc[0].right -= b;
                        p->rgrc[0].top += b;
                        p->rgrc[0].bottom -= b;
                    }
                }
                return 0;
            case WM_SIZE:
                if (wp != SIZE_MINIMIZED)
                    notify_state();
                break;
            case WM_NCACTIVATE:
                // 没有非客户区可重绘：直接放行会闪一下旧边框
                if (wp == FALSE)
                    return TRUE;
                break;
            case WM_ERASEBKGND:
                // 透明窗口不能擦背景：擦一次就是一帧不透明的底色
                return 1;
            case WM_SYSKEYDOWN:
                // WS_SYSMENU 被摘掉后（见 paint_dwm）DefWindowProc 不再把
                // Alt+F4 翻成 SC_CLOSE，这里自己补上，行为与系统窗口一致。
                if (wp == VK_F4 && (lp & (1 << 29)))
                {
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return 0;
                }
                break;
            default:
                break;
            }
            return CallWindowProcW(g_prev, hwnd, msg, wp, lp);
        }

        // 系统背衬（磨砂）的开关。Win11 只给整档：丙烯酸 / 没有背衬，模糊半径
        // 不可调，所以页面上那个"磨砂"只能是开关而不是滑杆。
        //   开 = Win11 丙烯酸：壁纸在窗后取景并被磨砂，页面的 alpha 叠在磨砂层上；
        //   关 = 去掉背衬，改用**整窗统一 alpha**（WS_EX_LAYERED + LWA_ALPHA）。
        //        实测：没有背衬时，客户区里 WebView2 的透明像素会露出窗口自己的
        //        底色（build 时 paint_client 刷的 #111113），整窗漆黑一片 ——
        //        所以这条路只能是"页面不透明 + 整窗半透明"，也就是 VSCode 的
        //        窗口透明（文字跟着一起淡），而不是"背景单独透、文字不漏"。
        static void set_backdrop(HWND hwnd, bool on, int alpha = 255)
        {
            constexpr DWORD kBackdrop = 38; // DWMWA_SYSTEMBACKDROP_TYPE
            constexpr int kNone = 1;        // DWMSBT_NONE
            constexpr int kAcrylic = 3;     // DWMSBT_TRANSIENTWINDOW（丙烯酸）
            int backdrop = on ? kAcrylic : kNone;
            DwmSetWindowAttribute(hwnd, kBackdrop, &backdrop, sizeof(backdrop));

            LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if (on)
            {
                if (ex & WS_EX_LAYERED)
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
            }
            else
            {
                if (!(ex & WS_EX_LAYERED))
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
                SetLayeredWindowAttributes(hwnd, 0,
                                           static_cast<BYTE>(alpha < 0 ? 0 : alpha > 255 ? 255 : alpha),
                                           LWA_ALPHA);
            }
            // 背衬 / 分层属性换了要立刻重画一次，否则旧材质会留到下一次 SetWindowPos
            SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                         SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                             SWP_NOACTIVATE);
        }

        static void paint_dwm(HWND hwnd)
        {
            // Win11：圆角 + 深色窗口框；旧系统上这两个属性不存在，失败无妨
            constexpr DWORD kCorner = 33; // DWMWA_WINDOW_CORNER_PREFERENCE
            constexpr int kRound = 2;     // DWMWCP_ROUND
            int pref = kRound;
            DwmSetWindowAttribute(hwnd, kCorner, &pref, sizeof(pref));
            BOOL dark = TRUE;
            DwmSetWindowAttribute(hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &dark, sizeof(dark));

            // 整窗透明：整块客户区交给 DWM 的「系统背衬」，壁纸在窗后直接取景。
            // 页面不再画不透明底（见 01-base.css），只用自己的 alpha 叠在背衬上，
            // 于是玻璃面板下看到的是磨砂过的桌面，而不是一张静态截图。
            // 背衬要铺满客户区，必须把边框整个扩展出去（-1 = 整窗都是边框）；
            // 不扩展时背衬只盖住边框，客户区看到的是**没磨砂的桌面**（2026-10-31 实测）。
            // 左上角那条 8px 浅灰带是 DWM 画的调整边框，靠下面的 BORDER_COLOR=none 去掉。
            MARGINS m{-1, -1, -1, -1};
            DwmExtendFrameIntoClientArea(hwnd, &m);
            set_backdrop(hwnd, true);
            // 边框线也去掉：无边框窗口不该有那 1px 的系统描边
            constexpr DWORD kBorder = 34;          // DWMWA_BORDER_COLOR
            constexpr DWORD kNoBorder = 0xFFFFFFFE; // DWMWA_COLOR_NONE
            DwmSetWindowAttribute(hwnd, kBorder, &kNoBorder, sizeof(kNoBorder));
            // 这里原来装的是实色画刷（#111113）：它会盖住背衬，透明窗口不能有底色。
            // 首帧的深色由页面自己的 scrim（--glass-scrim）负责，不再靠窗口刷子。
            SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, 0);

            // 窗口按钮的重影：边框整窗扩展后，DWM 会把**自己的**最小化/最大化/
            // 关闭也画进这块边框里；客户区一透明，它们就从页面那三颗按钮底下透
            // 出来（右上角一组错位的 10px 字形，2026-10-31 用户截图）。
            // WS_SYSMENU 就是那三颗系统按钮的开关：摘掉它 DWM 不再画
            // （DWMWA_CAPTION_BUTTON_BOUNDS 宽度 185→0 实测），其余全部保留 ——
            // WS_CAPTION / WS_THICKFRAME / MIN·MAXBOX 在位，投影、贴边分屏、
            // 最大化动画以及 SC_MINIMIZE/MAXIMIZE/RESTORE/CLOSE 都不受影响；
            // 只有 DefWindowProc 的 Alt+F4→SC_CLOSE 翻译没了，由 proc 补上。
            const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~WS_SYSMENU);
        }

        // 只画 WebView2 没覆盖到的缝：子窗口会把属于自己的区域裁掉，所以这层
        // 底色不会顶替页面的透明区（玻璃照旧取 DWM 背衬）。
        static void paint_client(HWND hwnd, COLORREF rgb)
        {
            HBRUSH br = CreateSolidBrush(rgb);
            if (!br)
                return;
            RECT rc{};
            GetClientRect(hwnd, &rc);
            if (HDC dc = GetDC(hwnd))
            {
                FillRect(dc, &rc, br);
                ReleaseDC(hwnd, dc);
            }
            DeleteObject(br);
        }

        // 页面底色：WebView2 默认铺一层不透明白底，不关掉它，DWM 背衬永远被盖在
        // 一张白纸后面。但**首帧必须是实色**：alpha=0 的第一帧在没有背衬的时候
        // 会让窗口最上面几像素留成白色，所以启动时先给页面一层 #111113，等页面
        // ready（Win.ready() → op "ready"）再切成全透明。切透明那一刻，客户区里
        // 没被 WebView2 盖住的缝会露出建窗时的浅色底 —— 由 op "glass" 里的
        // paint_client 先刷成同一个深色（2026-10-31）。
        static void page_background(unsigned char alpha)
        {
            auto *c = static_cast<ICoreWebView2Controller *>(g_controller);
            if (!c)
                return;
            ICoreWebView2Controller2 *c2 = nullptr;
            if (FAILED(c->QueryInterface(IID_ICoreWebView2Controller2, reinterpret_cast<void **>(&c2))) || !c2)
                return;
            COREWEBVIEW2_COLOR col{alpha, 0x11, 0x11, 0x13}; // A R G B
            c2->put_DefaultBackgroundColor(col);
            c2->Release();
        }

        // 装到活的 webview 窗口上（UI 线程、run() 之前）。必须在 tray::attach
        // 之前调用：tray 的过程会链到这里的 proc，再链到 webview 自己的。
        static void set_controller(void *controller) { g_controller = controller; }

        static bool install(HWND hwnd, std::function<void(const std::string &)> eval)
        {
            if (!hwnd || g_win)
                return false;
            g_eval = std::move(eval);
            g_prev = reinterpret_cast<WNDPROC>(
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(proc)));
            if (!g_prev)
                return false;
            g_win = hwnd;
            paint_dwm(hwnd);
            // 让系统按新的非客户区立刻重算一次（否则要等下次 SetWindowPos）
            SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                         SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            return true;
        }

        static UINT hit_code(const std::string &dir)
        {
            if (dir == "n")
                return HTTOP;
            if (dir == "s")
                return HTBOTTOM;
            if (dir == "w")
                return HTLEFT;
            if (dir == "e")
                return HTRIGHT;
            if (dir == "nw")
                return HTTOPLEFT;
            if (dir == "ne")
                return HTTOPRIGHT;
            if (dir == "sw")
                return HTBOTTOMLEFT;
            if (dir == "se")
                return HTBOTTOMRIGHT;
            return 0;
        }

        static std::string state_json(HWND hwnd)
        {
            const bool maxed = hwnd && IsZoomed(hwnd);
            return std::string("{\"ok\":true,\"maximized\":") + (maxed ? "true" : "false") +
                   ",\"minimized\":false}";
        }

        // host_win 的实现：{"op":"drag"|"resize"|"min"|"max"|"restore"|
        // "toggle"|"close"|"ready"|"state", "dir":"nw"}
        static std::string op(HWND hwnd, const std::string &args)
        {
            if (!hwnd || !IsWindow(hwnd))
                return "{\"ok\":false}";
            nlohmann::json a = nlohmann::json::parse(args, nullptr, false);
            if (a.is_array() && !a.empty())
                a = a[0];
            if (!a.is_object())
                a = nlohmann::json::object();
            const std::string what = a.value("op", "state");
            if (what == "drag")
            {
                // 系统自己的移动循环：松手前不返回（绑定是同步的，页面等它）
                POINT pt{};
                GetCursorPos(&pt);
                ReleaseCapture();
                SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION,
                             MAKELPARAM(pt.x, pt.y));
                return state_json(hwnd);
            }
            if (what == "resize")
            {
                const UINT hit = hit_code(a.value("dir", ""));
                if (!hit || IsZoomed(hwnd))
                    return state_json(hwnd);
                POINT pt{};
                GetCursorPos(&pt);
                ReleaseCapture();
                SendMessageW(hwnd, WM_NCLBUTTONDOWN, hit, MAKELPARAM(pt.x, pt.y));
                return state_json(hwnd);
            }
            if (what == "min")
                ShowWindow(hwnd, SW_MINIMIZE);
            else if (what == "max")
                ShowWindow(hwnd, SW_MAXIMIZE);
            else if (what == "restore")
                ShowWindow(hwnd, SW_RESTORE);
            else if (what == "toggle")
                ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
            else if (what == "close")
                // 走 WM_CLOSE：tray::main_proc 会把它变成"收到托盘"或真退出
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            else if (what == "ready")
                g_page_ready = true;
            else if (what == "glass")
            {
                // 切透明之前先把客户区刷成页面的 scrim 色：建窗时系统刷的那层
                // 浅灰底没人会再画，WebView2 一变透明就从标题栏左上角透出来
                // 一条 129×7 的浅灰带（2026-10-31 用户截图，hide+show 才会掉）。
                paint_client(hwnd, RGB(0x11, 0x11, 0x13));
                page_background(0); // 页面首帧画完才切透明（见 page_background）
            }
            else if (what == "blur")
                // 磨砂开关：on=false 时用整窗 alpha（见 set_backdrop）
                set_backdrop(hwnd, a.value("on", true),
                             a.value("alpha", 230));
            return state_json(hwnd);
        }
    } // namespace frame

    // =====================================================================
    //  pick_image — 启动页自定义图片的选择框（host_pick_splash 绑定）。
    //  选中的文件被复制到 .cell/splash/ 下（HTTP 路由只从那里取图），返回
    //  文件名；页面随后用 prefs.set 把它记进配置。
    // =====================================================================
    static std::string pick_splash_image(HWND owner)
    {
        std::string out = "{\"ok\":false}";
        IFileOpenDialog *dlg = nullptr;
        if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                    IID_PPV_ARGS(&dlg))))
            return out;
        FILEOPENDIALOGOPTIONS opts = 0;
        if (SUCCEEDED(dlg->GetOptions(&opts)))
            dlg->SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
        const COMDLG_FILTERSPEC types[] = {
            {L"图片", L"*.png;*.jpg;*.jpeg;*.gif;*.webp;*.avif;*.bmp;*.svg"},
            {L"所有文件", L"*.*"}};
        dlg->SetFileTypes(2, types);
        if (SUCCEEDED(dlg->Show(owner)))
        {
            IShellItem *item = nullptr;
            if (SUCCEEDED(dlg->GetResult(&item)) && item)
            {
                PWSTR p = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p)
                {
                    std::filesystem::path src(p);
                    CoTaskMemFree(p);
                    // 文件名清洗：只留字母数字和 . - _，其余换下划线
                    std::string name = src.filename().string();
                    for (char &c : name)
                        if (!(std::isalnum((unsigned char)c) || c == '.' || c == '-' || c == '_'))
                            c = '_';
                    if (!name.empty() && app::prefs::plain_name_ok(name))
                    {
                        std::error_code ec;
                        auto dir = app::prefs::splash_dir();
                        std::filesystem::create_directories(dir, ec);
                        std::filesystem::copy_file(src, dir / name,
                                                   std::filesystem::copy_options::overwrite_existing, ec);
                        if (!ec)
                            out = nlohmann::json{{"ok", true}, {"name", name}}.dump();
                    }
                }
                item->Release();
            }
        }
        dlg->Release();
        return out;
    }
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
        // background exec tasks (exec background=true) push their list to the
        // page whenever one starts or finishes
        core.start_task_watcher();
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
#ifdef _WIN32
                // 页面底色必须在导航之前定下来：alpha=0 的第一帧会让窗口最上面
                // 几像素留成白色（见 frame::page_background）。先铺实色，页面
                // ready 后再切透明 —— 顺序反了那条白带就洗不掉了。
                if (auto c = w.browser_controller(); c.ok())
                {
                    frame::set_controller(c.value());
                    frame::page_background(255);
                }
#endif
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

                // host_pick_splash — 启动页自定义图片的选择框：选中的图被复制到
                // .cell/splash/，返回文件名（页面随后用 prefs.set 记住它）。
                w.bind("host_pick_splash", [&w](std::string) -> std::string
                       {
                    HWND owner = nullptr;
                    if (auto win = w.window(); win.ok())
                        owner = reinterpret_cast<HWND>(win.value());
                    return pick_splash_image(owner); });

                // host_win — 无边框窗口的窗口操作。页面自绘标题栏，最小化 /
                // 最大化 / 关闭 / 拖拽 / 缩放都从这里进系统（见 frame）。
                w.bind("host_win", [&w](std::string args) -> std::string
                       {
                    HWND hwnd = nullptr;
                    if (auto win = w.window(); win.ok())
                        hwnd = reinterpret_cast<HWND>(win.value());
                    return frame::op(hwnd, args); });
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

                // 启动页的开关必须在页面首次绘制前生效：页面里 #splash 是静
                // 态的、默认就画出来，关掉后要等 state 回来才隐藏 —— 那之前
                // 会白闪一屏。开关走 URL（页面 <head> 里的内联脚本读它，外
                // 链脚本都晚于首次绘制）；没有 HTTP 时的内嵌页直接把同一段
                // 脚本插进 <head>。
                const bool show_splash = core.prefs.splash;
                auto embedded_html = [&]() -> std::string
                {
                    std::string html = app::kUiHtml;
                    if (show_splash)
                        return html;
                    const auto at = html.find("<head>");
                    if (at == std::string::npos)
                        return html;
                    html.insert(at + 6,
                                "<script>document.documentElement.classList.add('no-splash')</script>");
                    return html;
                };

                if (served)
                {
                    try
                    {
                        w.navigate(std::format("http://127.0.0.1:{}/{}", serve_port,
                                               show_splash ? "" : "?splash=0"));
                    }
                    catch (const std::exception &e)
                    {
                        log.warn("app", std::format("navigate failed ({}), using the embedded page", e.what()));
                        served = false;
                    }
                }
                if (!served)
                {
                    w.set_html(embedded_html());
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
                    // 真·无边框：页面自绘标题栏，系统标题栏在这里被去掉。
                    // 必须在 tray::attach 之前 —— tray 的过程会链到这里，再链回
                    // webview 自己的过程。
                    if (!frame::install(hwnd, [&w](const std::string &js)
                                        { w.eval(js); }))
                        log.warn("app", "frame: could not go borderless - keeping the system title bar");
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
