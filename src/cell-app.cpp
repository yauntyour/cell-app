// cell-app.cpp — the desktop shell (WebView2) and web service entry point
// for cell.cpp.
//
//   cell-app.exe                    the desktop app
//   cell-app.exe --serve [PORT]     desktop app + HTTP service (default: random port)
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

        static UINT hit_code(std::string_view dir)
        {
            static constexpr std::pair<std::string_view, UINT> kHit[] = {
                {"n", HTTOP}, {"s", HTBOTTOM}, {"w", HTLEFT}, {"e", HTRIGHT},
                {"nw", HTTOPLEFT}, {"ne", HTTOPRIGHT}, {"sw", HTBOTTOMLEFT}, {"se", HTBOTTOMRIGHT}};
            const auto it = std::ranges::find(kHit, dir, &std::pair<std::string_view, UINT>::first);
            return it == std::end(kHit) ? 0u : it->second;
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
            if (what == "min" || what == "max" || what == "restore")
            {
                static constexpr std::pair<std::string_view, int> kShow[] = {
                    {"min", SW_MINIMIZE}, {"max", SW_MAXIMIZE}, {"restore", SW_RESTORE}};
                const auto it = std::ranges::find(kShow, std::string_view{what},
                                                  &std::pair<std::string_view, int>::first);
                ShowWindow(hwnd, it->second);
            }
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
        printf("                    (default: an OS-assigned random port, printed/logged)\n");
        printf("  --headless [PORT] start only the HTTP service, no window\n");
        printf("                    (default: an OS-assigned random port)\n");
        printf("  --ui FILE         serve the UI page from this file (dev mode:\n");
        printf("                    edit + refresh, no rebuild; default: embedded)\n");
        printf("  --root DIR        use DIR as the data root instead of <exe dir>/.cell\n");
        printf("  --update-check    compare this build with the newest GitHub release\n");
        printf("                    and print the verdict (no window; exit codes:\n");
        printf("                    0 = up to date, 1 = update available, 2 = no answer)\n");
        printf("  --help            show this help\n\n");
        printf("Smoke tests (isolated data root, exit automatically):\n");
        printf("  --smoke           UI bridge only\n");
        printf("  --smoke-engine    UI bridge + one engine turn\n");
        printf("  --smoke-ws        UI bridge + two workspaces in parallel\n");
        printf("  --smoke-flowlink  two cells: discovery, pairing, mail, rpc\n\n");
        printf("Configuration, sessions and the credential vault are shared with\n");
        printf("the CLI (they live in <exe dir>\\.cell); run the CLI once to add\n");
        printf("a provider if none is configured yet.\n");
    }

    // SIGINT/SIGTERM flag for --headless
    static std::atomic<bool> g_signal_stop{false};

    // =====================================================================
    //  --smoke-flowlink: two cells in one process, talking over the loopback.
    //  No provider, no window, no network beyond 127.0.0.1: it exercises the
    //  parts that are easy to get wrong — the pairing code, the Argon2id PSK,
    //  the handshake MAC, the encrypted frames, the key file on disk, both
    //  directions of the RPC, and a reconnect from the stored link key.
    // =====================================================================
    static int flowlink_smoke()
    {
        using namespace cell::flowlink;
        int passed = 0, failed = 0;
        auto check = [&](bool cond, const std::string &what)
        {
            printf("  %-4s %s\n", cond ? "ok" : "FAIL", what.c_str());
            fflush(stdout); // a crash further down must not swallow the log
            cond ? ++passed : ++failed;
        };
        const auto base = std::filesystem::temp_directory_path() / "cell-flowlink-smoke";
        std::error_code ec;
        std::filesystem::remove_all(base, ec);
        std::filesystem::create_directories(base / "a", ec);
        std::filesystem::create_directories(base / "b", ec);
        printf("flowlink smoke: root=%s\n", base.string().c_str());

        service::options oa;
        oa.root = base / "a";
        oa.name = "cell-a";
        oa.port = 0; // ephemeral: the test runs beside a real instance
        // discovery on a port of its own, so the run never collides with a real
        // instance (both cells share it — that is how they find each other)
        oa.announce = true;
        oa.mdns_port = 47851;
        // CELL_FLOWLINK_SMOKE_VERBOSE=1 traces the handshake/session decisions of
        // a failing smoke run without changing the pass/fail output.
        if (const char *verbose = std::getenv("CELL_FLOWLINK_SMOKE_VERBOSE"); verbose && *verbose)
            oa.on_log = [](const std::string &level, const std::string &msg)
            { fprintf(stderr, "[flowlink %s] %s\n", level.c_str(), msg.c_str()); };
        // both sides record the events they receive: the remote console streams
        // its output as peer_event cli.out, the workspace picker as ws.state
        std::mutex ev_mx;
        std::vector<nlohmann::json> events;
        auto collect = [&](const nlohmann::json &e)
        {
            std::lock_guard<std::mutex> lk(ev_mx);
            events.push_back(e);
        };
        oa.on_event = collect;
        service::options ob = oa;
        ob.root = base / "b";
        ob.name = "cell-b";
        ob.on_event = collect;
        // B offers a remote console; A drives it further down
        ob.accept_remote = true;
        ob.on_cli = [](const std::string &line, const cell::flowlink::output_fn &sink, std::string &)
        {
            sink("ran: " + line + "\n");
            return true;
        };
        service a(oa), b(ob);
        std::string err;
        if (!a.start(err))
        {
            printf("FAIL cell A did not start: %s\n", err.c_str());
            return 1;
        }
        if (!b.start(err))
        {
            printf("FAIL cell B did not start: %s\n", err.c_str());
            return 1;
        }
        const int port_a = a.status().value("port", 0);
        const std::string addr_a = "127.0.0.1:" + std::to_string(port_a);
        check(port_a > 0, "cell A listens on an ephemeral port");
        check(a.client_id().size() == 32, "client_id is 32 hex characters (libsodium randombytes)");
        check(a.client_id() != b.client_id(), "the two cells have distinct client ids");
        // Both cells announce and browse. Two instances on one host share the
        // DNS-SD port (SO_REUSEADDR) and keep their own transport ports; what
        // must hold is that both are actually running discovery and can name
        // their own addresses for the A/AAAA records.
        const auto st_a = a.status();
        const auto st_b = b.status();
        const auto md_a = st_a["mdns"];
        const auto md_b = st_b["mdns"];
        check(md_a.value("on", false) && md_b.value("on", false),
              "both cells run mDNS discovery");
        check(md_a.value("bound4", 0) > 0 && md_b.value("bound4", 0) > 0,
              "both cells bound the DNS-SD port");
        check(md_a["addresses"].is_array() && !md_a["addresses"].empty(),
              "the status reports local addresses (the A/AAAA records)");
        check(md_a.value("state", "") == "active" || md_a.value("state", "") == "degraded",
              "the status reports a discovery state");
        check(st_b.value("discovery_port", 0) == 47851,
              "the configured DNS-SD port is reported");

        // ---- a wrong pairing code must not pair --------------------------
        {
            auto code = a.pair_begin(120);
            std::string wrong = code.value("raw", "");
            if (!wrong.empty())
                wrong[0] = (wrong[0] == 'A') ? 'B' : 'A';
            std::string why;
            auto r = b.pair_join(wrong, addr_a, why);
            check(!why.empty() || r.empty(), "a wrong pairing code is refused (" + why + ")");
        }
        // ---- discovery: B finds A through DNS-SD -------------------------
        // (a host without a usable multicast path simply skips the address-free
        //  pairing below and uses the known address instead)
        bool found_a = false;
        for (int i = 0; i < 25 && !found_a; i++)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            b.scan();
            for (const auto &f : b.discovered())
                if (f.value("client_id", "") == a.client_id() && f.value("port", 0) == port_a)
                    found_a = true;
        }
        if (!found_a)
        {
            // three different failures look the same from here: a bound4 that is
            // not the shared port, a shared port whose multicast reaches only one
            // of the sockets (A's rx_query stays 0), or a query arriving with no
            // answer coming back
            const auto sa = a.status()["mdns"], sb = b.status()["mdns"];
            printf("     discovery detail: A bound4=%d rx_q=%lld rx_r=%lld | "
                   "B bound4=%d rx_q=%lld rx_r=%lld | B saw %zu peer(s)\n",
                   sa.value("bound4", 0), sa.value("rx_query", 0LL), sa.value("rx_response", 0LL),
                   sb.value("bound4", 0), sb.value("rx_query", 0LL), sb.value("rx_response", 0LL),
                   b.discovered().size());
        }
        check(found_a, "B discovers A through mDNS (client id + SRV port)");
        // ---- mutual pairing: one code each, then a link exists ------------
        {
            auto code_a = a.pair_begin(120);
            check(code_a.value("ok", false), "cell A opens a pairing window");
            check(code_a.value("code", "").find(' ') != std::string::npos, "the code is shown in readable groups");
            std::string why;
            // no address when discovery worked: exactly the "type their code and
            // nothing else" flow
            auto r = b.pair_join(code_a.value("raw", ""), found_a ? std::string{} : addr_a, why);
            check(why.empty() && r.is_object() && r.value("ok", false), "B proves A's code (pairing request)" + (why.empty() ? "" : ": " + why));
            const bool pending = r.is_object() && r.value("pending", false);
            check(pending, "the request stays pending until A types B's code");
            if (r.is_object())
                check(r.value("client_id", "") == a.client_id(), "B learned A's client id");
            const std::string b_code = r.is_object() ? r.value("code", "") : std::string{};
            check(!b_code.empty(), "B has a code of its own to give A");
            // A only lists the request after B proved knowledge of A's code
            bool listed = false;
            for (int i = 0; i < 60 && !listed; i++)
            {
                const auto st = a.status();
                for (const auto &q : st["pairing"].value("requests", nlohmann::json::array()))
                    if (q.value("client_id", "") == b.client_id())
                        listed = true;
                if (!listed)
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            check(listed, "A lists B's request (B proved A's code)");
            check(!std::filesystem::exists(base / "a" / "links" / b.client_id() / ".key") &&
                      !std::filesystem::exists(base / "b" / "links" / a.client_id() / ".key"),
                  "no link key exists while only one code has been exchanged");
            if (!b_code.empty())
            {
                std::string bad = b_code;
                for (auto &ch : bad)
                    if (ch != ' ')
                    {
                        ch = (ch == 'A') ? 'B' : 'A';
                        break;
                    }
                std::string berr;
                auto br = a.pair_approve(bad, b.client_id(), berr);
                check(!berr.empty() && !(br.is_object() && br.value("paired", false)),
                      "a wrong code does not approve the request (" + berr + ")");
                std::string aerr;
                auto ok = a.pair_approve(b_code, b.client_id(), aerr);
                check(aerr.empty() && ok.is_object() && ok.value("paired", false),
                      "A approves with B's code" + (aerr.empty() ? "" : ": " + aerr));
                for (int i = 0; i < 80 && !std::filesystem::exists(base / "b" / "links" / a.client_id() / ".key"); i++)
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                check(std::filesystem::exists(base / "b" / "links" / a.client_id() / ".key"),
                      "B stored its link key once both codes were exchanged");
            }
        }
        check(std::filesystem::exists(base / "a" / "links" / b.client_id() / ".key"),
              "A stored the link key in .cell/links/<client_id>/.key");
        check(std::filesystem::exists(base / "b" / "links" / a.client_id() / ".key"),
              "B stored the link key in .cell/links/<client_id>/.key");
        check(std::filesystem::exists(base / "a" / "links" / "links.json"),
              "the link registry lives in .cell/links/links.json");
        {
            std::ifstream f(base / "b" / "links" / a.client_id() / ".key");
            const std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
            check(text.find("argon2id") != std::string::npos, "the link key file is sealed like the vault (argon2id)");
            // Regression: the AES-GCM branch used to write nonce/ct under the
            // wrong JSON keys, producing null fields and an unreadable key file on
            // any CPU with AES-NI (resume then threw inside the io worker).
            const nlohmann::json sealed = nlohmann::json::parse(text, nullptr, false);
            check(sealed.is_object() && sealed["nonce"].is_string() && !sealed["nonce"].get<std::string>().empty() &&
                      sealed["ct"].is_string() && !sealed["ct"].get<std::string>().empty(),
                  "the sealed key file carries a real nonce and ciphertext (readable on resume)");
        }
        // ---- transfer B -> A --------------------------------------------
        {
            std::string why;
            nlohmann::json item{{"from", b.client_id()}, {"from_name", "cell-b"},
                                {"subject", "hello"}, {"note", ""}, {"kind", "text"},
                                {"session", ""},
                                {"messages", nlohmann::json::array({{{"role", "user"}, {"text", "ping from b"}}})}};
            b.send_transfer(a.client_id(), item, why);
            check(why.empty(), "B sends a transfer to A" + (why.empty() ? "" : ": " + why));
            auto list = a.transmissions();
            check(list.is_array() && list.size() == 1, "A's transfer list holds exactly one entry");
            if (list.is_array() && list.size() == 1)
            {
                auto m = a.read_transmission(list[0].value("id", ""));
                check(m.value("subject", "") == "hello", "the subject survives the round trip");
                check(m.contains("messages") && m["messages"].is_array() &&
                          m["messages"][0].value("text", "") == "ping from b",
                      "the body survives the encrypted round trip (JSONL)");
                const std::string file = m.value("file", "");
                check(std::filesystem::exists(base / "a" / "links" / b.client_id() / file),
                      "the transfer is stored as a JSONL file next to the sender's .key");
                check(std::filesystem::exists(base / "a" / "links" / "transmission.json"),
                      "links/transmission.json indexes the transfer");
            }
        }
        // ---- rpc in the other direction, plus a reconnect ---------------
        {
            b.on("echo", [](const nlohmann::json &p, std::string &e) -> nlohmann::json
                 { (void)e; return nlohmann::json{{"echo", p}}; });
            std::string why;
            auto r = a.call(b.client_id(), "echo", {{"n", 42}}, 15000, why);
            check(why.empty() && r.value("echo", nlohmann::json::object()).value("n", 0) == 42,
                  "A -> B rpc over the encrypted channel" + (why.empty() ? "" : ": " + why));
        }
        {
            const std::string id = a.client_id();
            a.stop();
            std::string why;
            if (!a.start(why))
                check(false, "A restarts: " + why);
            else
            {
                check(a.client_id() == id, "the client id persists across restarts");
                auto r = a.call(b.client_id(), "echo", {{"n", 7}}, 20000, why);
                check(why.empty() && r.value("echo", nlohmann::json::object()).value("n", 0) == 7,
                      "A reconnects with the stored link key, no code needed" + (why.empty() ? "" : ": " + why));
            }
        }
        // ---- an unpaired peer is refused --------------------------------
        {
            std::string why;
            b.call("00000000000000000000000000000000", "echo", nlohmann::json::object(), 3000, why);
            check(!why.empty(), "an unpaired client id is refused (" + why + ")");
        }
        // ---- the core command surface -----------------------------------
        // /link lives in the core (cell::link), so its operations answer even
        // with no service mounted — that is what the CLI's REPL gets.
        {
            auto st = cell::flowlink::op("status", nlohmann::json::object());
            check(!st.value("enabled", false), "/link status reports the service as off (it is opt-in)");
            bool ok = true;
            const std::string text = cell::flowlink::run({"/link", "peers"}, "", ok);
            check(!ok, "/link peers without a service explains how to enable it (" + text + ")");
        }
        // ---- mount through the core, exactly as `/link on` does ----------
        {
            cell::flowlink::mount_options mo;
            mo.root = base / "cli";
            mo.name = "cell-cli";
            mo.port = 0;
            mo.discovery = 47852;
            mo.announce = false;
            mo.accept_remote = false;
            std::string e2;
            check(cell::flowlink::enable(mo, e2), "cell::link mounts the service" + (e2.empty() ? "" : ": " + e2));
            check(cell::flowlink::op("status", nlohmann::json::object()).value("enabled", false),
                  "/link status reports it running");
            auto pr = cell::flowlink::op("pair", {{"ttl", 60}});
            check(pr.value("ok", false) && !pr.value("code", "").empty(), "/link pair returns a code");
            auto pe = cell::flowlink::op("peers", nlohmann::json::object());
            check(pe.value("ok", false) && pe["peers"].is_array(), "/link peers answers");
            auto in = cell::flowlink::op("inbox", nlohmann::json::object());
            check(in.value("ok", false) && in["items"].is_array(), "/link inbox answers");
            bool ok2 = true;
            const std::string txt = cell::flowlink::run({"/link", "pair", "60"}, "", ok2);
            check(ok2 && txt.find("pairing code") != std::string::npos, "/link run renders the pairing code");
            cell::flowlink::op("off", nlohmann::json::object());
            check(!cell::flowlink::status().value("enabled", false), "/link off unmounts the service");
        }
        // ---- the remote console (cli.exec + streamed cli.out) ------------
        {
            std::string why;
            auto r = a.call(b.client_id(), "cli.exec", {{"line", "/help"}, {"rid", "smoke-1"}},
                            15000, why);
            check(why.empty() && r.value("ok", false),
                  "A runs a console line on B" + (why.empty() ? "" : ": " + why));
            bool streamed = false;
            for (int i = 0; i < 40 && !streamed; i++)
            {
                {
                    std::lock_guard<std::mutex> lk(ev_mx);
                    for (const auto &e : events)
                        if (e.value("type", "") == "peer_event" &&
                            e.value("method", "") == "cli.out" &&
                            e.value("params", nlohmann::json::object())
                                    .value("text", "")
                                    .find("ran: /help") != std::string::npos)
                            streamed = true;
                }
                if (!streamed)
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            check(streamed, "B streams the console output back over the session");
        }
        // ---- the open-workspace list -------------------------------------
        {
            b.publish_workspaces(nlohmann::json::array(
                {{{"ws", "w1"}, {"cwd", "/tmp/w1"}, {"active", true}}}));
            std::string why;
            auto r = a.call(b.client_id(), "ws.list", nlohmann::json::object(), 10000, why);
            check(why.empty() && r["workspaces"].is_array() && r["workspaces"].size() == 1,
                  "A reads B's published workspace list" + (why.empty() ? "" : ": " + why));
            check(a.remote_workspaces(b.client_id()).size() == 1,
                  "the pushed list is cached for the picker");
        }
        a.stop();
        b.stop();
        std::filesystem::remove_all(base, ec);
        printf("flowlink smoke: %d passed, %d failed\n", passed, failed);
        return failed == 0 ? 0 : 1;
    }

    // 桌面壳默认绑定的回环端口。挑一个高位端口：既不撞常见服务，也避开
    // FlowLink 的 47821/47822 与本仓的 8787（--headless 的开发口）。
    constexpr int kDesktopPort = 47900;

    int gui_main(int argc, char const *argv[])
    {
        std::string ui_arg; // --ui FILE: serve the page from disk (dev mode)
        std::string root_arg; // --root DIR: use another .cell data root
        int smoke = 0;
        // 桌面壳默认绑**固定**回环端口。页面的 localStorage 按来源
        // （scheme+host+port）分仓，主题 / 动画等级 / 窗口透明度 / 面板比例 /
        // 侧栏与分组的折叠状态全在里面 —— 端口每次随机，来源就每次不同，
        // 那些设置等于每次启动都清零（2026-11-03 用户主诉「设置页改完下次
        // 启动又回去了」）。端口被占时下面会回退到随机端口，只影响那一次运行。
        // --serve / --headless 不带值时仍按文档绑随机端口（开发/多实例）。
        int serve_port = kDesktopPort;
        bool headless = false;
        bool update_check = false; // --update-check: probe and print, then leave
        for (int i = 1; i < argc; i++)
        {
            std::string a = argv[i];
            // --serve / --headless take an optional port in 1..65535. Without a
            // value the service binds port 0 (the OS picks a random free port),
            // so a second instance never fights over a fixed 8787. A
            // non-numeric/out-of-range value rejects the command line instead of
            // silently becoming "no service" (headless then spun forever).
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
                return 0; // OS-assigned (random) port
            };
            if (a == "--ui" && i + 1 < argc)
                ui_arg = argv[++i];
            else if (a == "--root" && i + 1 < argc)
                root_arg = argv[++i];
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
            else if (a == "--smoke-flowlink")
            {
                // self-contained: it brings its own data root and needs no window
                return app::flowlink_smoke();
            }
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
        // --root DIR: run against another data root (portable installs, and the
        // two-instance FlowLink tests). Same rule: before the logger opens.
        if (!root_arg.empty())
            cell::root = std::filesystem::absolute(root_arg);

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
        // keep paired links warm: a peer whose address changed (DHCP) is
        // re-discovered and re-dialed instead of reading "offline" forever
        core.start_fl_probe();
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
        // Bind the HTTP service. preferred == 0 asks the OS for a random free
        // port; a positive value must bind that exact port (the caller decides
        // whether to retry). serve_port becomes the ACTUAL bound port, so the
        // webview navigates to the right URL even when the port was assigned.
        auto start_http = [&](int preferred) -> bool
        {
            std::string err = http.start(preferred, 4);
            if (!err.empty())
            {
                log.error("http", err);
                return false;
            }
            serve_port = http.bound_port;
            log.info("http", std::format("serving on http://127.0.0.1:{}/ (desktop={})", serve_port, !headless));
            return true;
        };

        int rc = 0;
        // FlowLink is opt-in and off by default: nothing is created here unless
        // the user switched it on. It starts at the same point as the HTTP
        // service, and for the same reason — WebView2's one-time winsock
        // init/cleanup would otherwise tear down sockets opened before it.
        // The core owns the service; this shell only says how to mount it. The
        // hooks are what the core's /link command calls, so `/link on` works
        // here exactly as it does in the CLI.
        // FlowLink's own settings live in .cell/links/links.json now; move the
        // keys older builds kept in config.json before anything reads them.
        cell::flowlink::migrate_legacy_settings();
        cell::flowlink::mount_hook() = [&core](std::string &err) -> bool
        {
            if (!core.fl_start(err))
                return false;
            cell::flowlink::set_enabled(true);
            core.fl_tools_dirty();
            return true;
        };
        cell::flowlink::unmount_hook() = [&core]
        {
            core.fl_stop();
            cell::flowlink::set_enabled(false);
            core.fl_tools_dirty();
        };
        auto start_flowlink = [&]()
        {
            if (!cell::flowlink::settings().value("enabled", false))
                return;
            std::string err;
            if (!core.fl_start(err))
            {
                log.error("flowlink", "could not start: " + err);
                return;
            }
            const nlohmann::json st = core.fl_status();
            log.info("flowlink", std::format("flowlink listening on {} (discovery {}, id {})",
                                             st.value("port", 0), st.value("discovery_port", 0),
                                             st.value("client_id", "")));
        };
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
                // service-only mode: run until Ctrl+C / a termination signal.
                // A random port (0) is the default; an explicit port must work.
                if (!start_http(serve_port))
                {
                    if (serve_port > 0)
                        log.error("http", std::format("port {} is not available", serve_port));
                    core.shutdown();
                    return 1;
                }
                std::signal(SIGINT, [](int)
                            { g_signal_stop.store(true); });
                std::signal(SIGTERM, [](int)
                            { g_signal_stop.store(true); });
                start_flowlink();
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
                // the native window handle, or nullptr before the window exists
                auto native = [&w]() -> void *
                {
                    const auto h = w.window();
                    return h.ok() ? reinterpret_cast<void *>(h.value()) : nullptr;
                };
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
                // The desktop default is a fixed loopback port (kDesktopPort):
                // the page's localStorage is keyed by origin, so a random port
                // would wipe every UI preference on each launch. A busy port
                // falls back to a random one for that run only.
                bool served = start_http(serve_port);
                if (!served && serve_port > 0)
                {
                    log.warn("http", std::format("requested port {} is busy; using a random port", serve_port));
                    serve_port = 0;
                    served = start_http(0);
                }
                if (!served)
                    log.error("http", "the embedded page has no HTTP backend and boots in demo "
                                      "mode (set --serve PORT to force one)");
                // the window exists, so WebView2 has finished its winsock
                // init/cleanup cycle: FlowLink may open its sockets now
                start_flowlink();

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
                w.bind("host_pick_folder", [&](std::string) -> std::string
                       { return pick_folder(static_cast<HWND>(native())); });

                // host_pick_splash — the custom splash image picker: the chosen
                // file is copied into .cell/splash/ and its name returned (the
                // page then records it with prefs.set).
                w.bind("host_pick_splash", [&](std::string) -> std::string
                       { return pick_splash_image(static_cast<HWND>(native())); });

                // host_win — the borderless window's operations. The page draws
                // its own title bar, so minimise / maximise / close / drag /
                // resize all come through here into the system (see frame).
                w.bind("host_win", [&](std::string args) -> std::string
                       { return frame::op(static_cast<HWND>(native()), args); });
#endif
                // host_open_url — the update chip: the page hands the release
                // link over and the shell pops the user's default browser.
                // A sync binding receives the raw JSON argument array
                // ("[\"https://…\"]"), not the unwrapped first argument.
                w.bind("host_open_url", [&w, &native](std::string args) -> std::string
                       {
                    std::string url;
                    auto a = nlohmann::json::parse(args, nullptr, false);
                    if (a.is_array() && !a.empty() && a[0].is_string())
                        url = a[0].get<std::string>();
                    else if (a.is_string())
                        url = a.get<std::string>();
                    void *owner = native();
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
                    const HWND hwnd = static_cast<HWND>(native());
                    // Settings → About → Desktop → keep running in the tray: on
                    // parks the app in the notification area, off makes a close
                    // quit like any other window. Runtime flips run on the UI thread.
                    core.on_tray = [&w](bool on)
                    { w.dispatch([on] { tray::set_enabled(on); }); };
                    // Borderless: the page draws its own title bar, so the system
                    // one goes first - tray::attach chains onto our procedure and
                    // then onto the webview's.
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
