// cell-app-term.hpp — real interactive terminal sessions (PTY) for the shell
// ============================================================================
//
// The workbench terminal used to be a one-shot command runner (term.exec). This
// header adds the piece that makes it a *real* terminal: a long-lived shell
// attached to a pseudo terminal (Windows ConPTY / POSIX forkpty), streamed to
// the page over the existing event bus, with input, resize and lifecycle
// commands. The page renders the VT stream itself (src/ui/src/js/08c-term.js).
//
//      term.open    {ws?, cwd?, cols?, rows?, shell?, force?}
//                   -> {ok,id,ws,cwd,shell,cols,rows,pid,alive,seq,backlog}
//                   one live session per workspace: an existing one is reused
//                   and its recent output (<=512 KiB, base64) is replayed, so a
//                   refreshed page reattaches to the same shell.
//      term.input   {ws?,id,data|text}  data = base64(bytes), text = raw UTF-8
//      term.resize  {ws?,id,cols,rows}
//      term.close   {ws?,id}            (id may be omitted inside a ws)
//      term.list    {ws?}               -> {ok,sessions:[...]}
//
// Events posted on the bus (same JSON shape as every other event):
//
//      {"t":"term.out",  "ws":..,"id":..,"seq":N,"d":"<base64 bytes>"}
//      {"t":"term.exit", "ws":..,"id":..,"code":N}
//      {"t":"term.error","ws":..,"id":..,"error":"..."}
//
// Design notes
//   * The reader thread NEVER blocks indefinitely on the pty: Windows uses a
//     PeekNamedPipe poll, POSIX a poll() with a bounded timeout. That keeps
//     close()/shutdown() free of "cancel a blocked read" tricks and keeps the
//     shell responsive when the pipe drains.
//   * Output is byte-exact: chunks are base64-encoded and the page decodes them
//     with a streaming UTF-8 decoder, so a multi-byte character split across two
//     reads still renders correctly.
//   * term.exec is untouched and still available on the same bus.
//
// Include order: cell-app-tools.hpp includes this header, and the application
// includes cell.cpp first (cell::sys::logger, cell::plat). Nothing here is used
// before that point.
// ============================================================================
#pragma once

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h> // forkpty
#else
#include <pty.h> // forkpty (link -lutil)
#endif
#endif

namespace app::term
{
    using json = nlohmann::json;
    using post_fn = std::function<void(const json &)>;

    inline json tok() { return json{{"ok", true}}; }
    inline json terr(const std::string &e) { return json{{"ok", false}, {"error", e}}; }

    // ---------------------------------------------------------------------
    //  base64 — the wire format for terminal bytes in both directions
    // ---------------------------------------------------------------------
    inline std::string b64_encode(const void *data, size_t n)
    {
        static const char *T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const unsigned char *p = static_cast<const unsigned char *>(data);
        std::string o;
        o.reserve(((n + 2) / 3) * 4);
        size_t i = 0;
        for (; i + 3 <= n; i += 3)
        {
            uint32_t v = (uint32_t(p[i]) << 16) | (uint32_t(p[i + 1]) << 8) | uint32_t(p[i + 2]);
            o.push_back(T[(v >> 18) & 63]);
            o.push_back(T[(v >> 12) & 63]);
            o.push_back(T[(v >> 6) & 63]);
            o.push_back(T[v & 63]);
        }
        if (i + 1 == n)
        {
            uint32_t v = uint32_t(p[i]) << 16;
            o.push_back(T[(v >> 18) & 63]);
            o.push_back(T[(v >> 12) & 63]);
            o.push_back('=');
            o.push_back('=');
        }
        else if (i + 2 == n)
        {
            uint32_t v = (uint32_t(p[i]) << 16) | (uint32_t(p[i + 1]) << 8);
            o.push_back(T[(v >> 18) & 63]);
            o.push_back(T[(v >> 12) & 63]);
            o.push_back(T[(v >> 6) & 63]);
            o.push_back('=');
        }
        return o;
    }

    inline int b64_val(unsigned char c)
    {
        if (c >= 'A' && c <= 'Z')
            return c - 'A';
        if (c >= 'a' && c <= 'z')
            return c - 'a' + 26;
        if (c >= '0' && c <= '9')
            return c - '0' + 52;
        if (c == '+')
            return 62;
        if (c == '/')
            return 63;
        return -1;
    }

    // Lenient decoder: whitespace and '=' end/are skipped, invalid bytes fail.
    inline bool b64_decode(std::string_view in, std::string &out)
    {
        out.clear();
        out.reserve(in.size() / 4 * 3 + 3);
        uint32_t acc = 0;
        int bits = 0;
        for (unsigned char c : in)
        {
            if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t')
                continue;
            int v = b64_val(c);
            if (v < 0)
                return false;
            acc = (acc << 6) | (uint32_t)v;
            bits += 6;
            if (bits >= 8)
            {
                bits -= 8;
                out.push_back(char((acc >> bits) & 0xFF));
            }
        }
        return true;
    }

    inline int clamp_int(long long v, int lo, int hi)
    {
        if (v < lo)
            return lo;
        if (v > hi)
            return hi;
        return (int)v;
    }

    // ---- defensive JSON accessors -------------------------------------
    // request JSON comes from clients: a wrongly typed field must never throw
    // out of a command ({"cols":"80"} must still open a terminal).
    inline std::string jstr(const json &o, const char *k, std::string def = {})
    {
        if (!o.is_object())
            return def;
        auto it = o.find(k);
        if (it == o.end() || it->is_null() || !it->is_string())
            return def;
        return it->get<std::string>();
    }

    inline long long jint(const json &o, const char *k, long long def)
    {
        if (!o.is_object())
            return def;
        auto it = o.find(k);
        if (it == o.end() || it->is_null())
            return def;
        try
        {
            if (it->is_number_unsigned())
            {
                unsigned long long v = it->get<unsigned long long>();
                return v > (unsigned long long)0x7FFFFFFFFFFFFFFFLL ? def : (long long)v;
            }
            if (it->is_number_integer())
                return it->get<long long>();
            if (it->is_number_float())
                return (long long)it->get<double>();
            if (it->is_boolean())
                return it->get<bool>() ? 1 : 0;
            if (it->is_string())
                return std::stoll(it->get<std::string>());
        }
        catch (...)
        {
        }
        return def;
    }

    inline bool jbool(const json &o, const char *k, bool def)
    {
        if (!o.is_object())
            return def;
        auto it = o.find(k);
        if (it == o.end() || it->is_null())
            return def;
        if (it->is_boolean())
            return it->get<bool>();
        if (it->is_number())
            return it->get<double>() != 0.0;
        if (it->is_string())
        {
            std::string s = it->get<std::string>();
            for (char &c : s)
                c = (char)std::tolower((unsigned char)c);
            return s == "1" || s == "true" || s == "yes" || s == "on";
        }
        return def;
    }

    // a user-supplied shell path may arrive padded with spaces
    inline std::string trim_shell(const std::string &s)
    {
        size_t b = 0, e = s.size();
        while (b < e && (unsigned char)s[b] <= ' ')
            ++b;
        while (e > b && (unsigned char)s[e - 1] <= ' ')
            --e;
        return s.substr(b, e - b);
    }

    // =====================================================================
    //  session — one shell attached to a pty
    // =====================================================================
    struct session
    {
        static constexpr size_t kMaxBacklog = 512 * 1024; // replayed on reattach
        static constexpr size_t kReadBuf = 32 * 1024;

        std::string id, ws, cwd, shell;
        int cols = 80, rows = 24;
        long long pid = 0;

        std::atomic<bool> alive{true};   // process is running
        std::atomic<bool> closed{false}; // reader must stop / handles are gone
        long long seq = 0;               // guarded by mx
        std::atomic<bool> exit_sent{false}; // term.exit is announced exactly once

        // The listener that receives this session's events can change while the
        // shell runs (page refresh, a second tab attaches). The reader thread
        // copies the callback under pmx for every event instead of reading a
        // std::function that another thread is assigning.
        std::mutex pmx;
        post_fn post;
        void set_post(post_fn p)
        {
            std::lock_guard<std::mutex> lk(pmx);
            post = std::move(p);
        }
        void emit(const json &e)
        {
            post_fn p;
            {
                std::lock_guard<std::mutex> lk(pmx);
                p = post;
            }
            if (p)
                p(e);
        }

        std::mutex mx; // guards backlog/seq
        std::deque<std::string> backlog;
        size_t backlog_bytes = 0;

        std::mutex wmx; // serialises input writes / resize / handle teardown
        std::thread reader;

#ifdef _WIN32
        HANDLE in = nullptr;   // we write here (pty input)
        HANDLE out = nullptr;  // we read here (pty output)
        void *pc = nullptr;    // HPCON
        HANDLE proc = nullptr; // child process
        HANDLE job = nullptr;  // kills the whole tree
#else
        // The reader polls/reads master; write_input/resize/close use it under
        // wmx. Atomic so a resize cannot tear the fd while the reader polls, and
        // the pid is cleared once waitpid() reaped it (no kill on a reused pid).
        std::atomic<int> master{-1};
        std::atomic<long long> child{0};
#endif

        ~session() { shutdown(); }

#ifdef _WIN32
        // ---- ConPTY entry points, resolved at runtime: MinGW SDK headers
        // predate the API in some toolchains and the app must still build ----
        struct pty_api
        {
            HRESULT(WINAPI *create)(COORD, HANDLE, HANDLE, DWORD, void **) = nullptr;
            HRESULT(WINAPI *resize)(void *, COORD) = nullptr;
            void(WINAPI *close)(void *) = nullptr;
            bool ok() const { return create && resize && close; }
        };
        static const pty_api &api()
        {
            static pty_api a = []()
            {
                pty_api r;
                HMODULE k = GetModuleHandleW(L"kernel32.dll");
                if (!k)
                    return r;
                r.create = (HRESULT(WINAPI *)(COORD, HANDLE, HANDLE, DWORD, void **))
                    (void *)GetProcAddress(k, "CreatePseudoConsole");
                r.resize = (HRESULT(WINAPI *)(void *, COORD))
                    (void *)GetProcAddress(k, "ResizePseudoConsole");
                r.close = (void(WINAPI *)(void *))
                    (void *)GetProcAddress(k, "ClosePseudoConsole");
                return r;
            }();
            return a;
        }

        static std::wstring wide(const std::string &s)
        {
            if (s.empty())
                return std::wstring();
            int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
            std::wstring o((size_t)(n > 0 ? n : 0), L'\0');
            if (n > 0)
                MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), o.data(), n);
            return o;
        }

        static bool ci_less(const std::wstring &a, const std::wstring &b)
        {
            size_t n = a.size() < b.size() ? a.size() : b.size();
            for (size_t i = 0; i < n; i++)
            {
                wchar_t x = a[i], y = b[i];
                if (x >= L'A' && x <= L'Z')
                    x = wchar_t(x - L'A' + L'a');
                if (y >= L'A' && y <= L'Z')
                    y = wchar_t(y - L'A' + L'a');
                if (x != y)
                    return x < y;
            }
            return a.size() < b.size();
        }

        // child environment: inherit ours, force a terminal-capable TERM
        static std::vector<wchar_t> env_block()
        {
            std::vector<std::wstring> items;
            if (LPWCH e = GetEnvironmentStringsW())
            {
                for (LPWCH p = e; *p;)
                {
                    std::wstring s(p);
                    p += s.size() + 1;
                    if (s.rfind(L"TERM=", 0) == 0 || s.rfind(L"COLORTERM=", 0) == 0)
                        continue;
                    items.push_back(std::move(s));
                }
                FreeEnvironmentStringsW(e);
            }
            items.push_back(L"TERM=xterm-256color");
            items.push_back(L"COLORTERM=truecolor");
            std::sort(items.begin(), items.end(), ci_less);
            std::vector<wchar_t> block;
            for (auto &s : items)
            {
                block.insert(block.end(), s.begin(), s.end());
                block.push_back(0);
            }
            block.push_back(0);
            return block;
        }

        static std::string default_shell()
        {
            wchar_t buf[MAX_PATH + 1] = {0};
            DWORD n = GetEnvironmentVariableW(L"COMSPEC", buf, MAX_PATH);
            if (n > 0 && n <= MAX_PATH)
            {
                std::wstring w(buf, n);
                int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
                std::string s((size_t)(need > 0 ? need : 0), '\0');
                if (need > 0)
                    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), need, nullptr, nullptr);
                if (!s.empty())
                    return s;
            }
            return "cmd.exe";
        }

        bool start(const std::string &shell_override, std::string &err)
        {
            const pty_api &a = api();
            if (!a.ok())
            {
                err = "pseudoconsole API unavailable (Windows 10 1809+ required)";
                return false;
            }
            shell = shell_override.empty() ? default_shell() : shell_override;

            SECURITY_ATTRIBUTES sa{};
            sa.nLength = sizeof(sa);
            sa.bInheritHandle = TRUE;
            HANDLE in_r = nullptr, in_w = nullptr, out_r = nullptr, out_w = nullptr;
            if (!CreatePipe(&in_r, &in_w, &sa, 0))
            {
                err = "CreatePipe failed";
                return false;
            }
            if (!CreatePipe(&out_r, &out_w, &sa, 0))
            {
                CloseHandle(in_r);
                CloseHandle(in_w);
                err = "CreatePipe failed";
                return false;
            }
            COORD size{(SHORT)cols, (SHORT)rows};
            void *pc_tmp = nullptr;
            HRESULT hr = a.create(size, in_r, out_w, 0, &pc_tmp);
            if (FAILED(hr) || !pc_tmp)
            {
                CloseHandle(in_r);
                CloseHandle(in_w);
                CloseHandle(out_r);
                CloseHandle(out_w);
                err = "CreatePseudoConsole failed";
                return false;
            }

            SIZE_T list_bytes = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &list_bytes);
            auto *list = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, list_bytes ? list_bytes : 1);
            STARTUPINFOEXW si{};
            si.StartupInfo.cb = sizeof(si);
            bool list_ok = list && InitializeProcThreadAttributeList(list, 1, 0, &list_bytes);
            if (list_ok)
                list_ok = !!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                                      pc_tmp, sizeof(pc_tmp), nullptr, nullptr);
            if (!list_ok)
            {
                if (list)
                    HeapFree(GetProcessHeap(), 0, list);
                a.close(pc_tmp);
                CloseHandle(in_r);
                CloseHandle(in_w);
                CloseHandle(out_r);
                CloseHandle(out_w);
                err = "process attribute setup failed";
                return false;
            }
            si.lpAttributeList = list;
            // Measured on Windows 10/11 with this toolchain: the pseudoconsole
            // attribute alone leaves the client on the parent's console (or with
            // no console at all in a GUI-subsystem host, where cmd.exe then exits
            // immediately). Handing the pty ends over as the standard handles
            // makes the client attach for real — a genuine console: programs see
            // isTTY, mode con reports the pty size, VT output flows. bInheritHandles
            // stays FALSE (with TRUE the client never attaches to the pty).
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = in_r;
            si.StartupInfo.hStdOutput = out_w;
            si.StartupInfo.hStdError = out_w;

            std::wstring cmd = L"\"" + wide(shell) + L"\"";
            std::vector<wchar_t> env = env_block();
            std::wstring wcwd = wide(cwd);
            PROCESS_INFORMATION pi{};
            BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                                     EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                                     env.data(), wcwd.empty() ? nullptr : wcwd.c_str(),
                                     &si.StartupInfo, &pi);
            DeleteProcThreadAttributeList(list);
            HeapFree(GetProcessHeap(), 0, list);
            // the client holds the pty-side ends from here on
            CloseHandle(in_r);
            CloseHandle(out_w);
            if (!ok)
            {
                DWORD e = GetLastError();
                a.close(pc_tmp);
                CloseHandle(in_w);
                CloseHandle(out_r);
                err = "CreateProcess failed (win32 " + std::to_string((unsigned long long)e) + ")";
                return false;
            }
            CloseHandle(pi.hThread);

            in = in_w;
            out = out_r;
            pc = pc_tmp;
            proc = pi.hProcess;
            pid = (long long)pi.dwProcessId;
            // kill the whole tree when the session goes away (best effort)
            if (HANDLE j = CreateJobObjectW(nullptr, nullptr))
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl{};
                jl.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (SetInformationJobObject(j, JobObjectExtendedLimitInformation, &jl, sizeof(jl)) &&
                    AssignProcessToJobObject(j, proc))
                    job = j;
                else
                    CloseHandle(j);
            }
            return true;
        }

        void set_size(int c, int r)
        {
            std::lock_guard<std::mutex> lk(wmx);
            cols = c;
            rows = r;
            if (pc && !closed.load())
                api().resize(pc, COORD{(SHORT)cols, (SHORT)rows});
        }

        bool write_input(const std::string &bytes, std::string &err)
        {
            std::lock_guard<std::mutex> lk(wmx);
            if (!in || closed.load())
            {
                err = "session is not writable";
                return false;
            }
            size_t off = 0;
            while (off < bytes.size())
            {
                DWORD chunk = (DWORD)std::min<size_t>(bytes.size() - off, 1u << 20);
                DWORD wrote = 0;
                if (!WriteFile(in, bytes.data() + off, chunk, &wrote, nullptr) || wrote == 0)
                {
                    err = "write to the session failed";
                    return false;
                }
                off += wrote;
            }
            return true;
        }

        void pump()
        {
            std::vector<char> buf(kReadBuf);
            for (;;)
            {
                DWORD avail = 0;
                if (!out || !PeekNamedPipe(out, nullptr, 0, nullptr, &avail, nullptr))
                    break; // pipe gone
                if (avail == 0)
                {
                    if (closed.load())
                        break;
                    if (proc && WaitForSingleObject(proc, 0) == WAIT_OBJECT_0)
                    {
                        // The client is gone; ConPTY/conhost can still flush its
                        // last bytes after the process object signals, so keep
                        // draining briefly until the pipe reports failure.
                        ULONGLONG deadline = GetTickCount64() + 400;
                        for (;;)
                        {
                            if (closed.load())
                                break;
                            DWORD a2 = 0;
                            if (!PeekNamedPipe(out, nullptr, 0, nullptr, &a2, nullptr))
                                break; // pipe closed: everything was drained
                            if (a2 == 0)
                            {
                                if (GetTickCount64() >= deadline)
                                    break;
                                Sleep(2);
                                continue;
                            }
                            DWORD want = (DWORD)std::min<size_t>(a2, buf.size());
                            DWORD got = 0;
                            if (!ReadFile(out, buf.data(), want, &got, nullptr) || got == 0)
                                break;
                            feed(buf.data(), got);
                        }
                        break;
                    }
                    Sleep(8);
                    continue;
                }
                DWORD want = (DWORD)std::min<size_t>(avail, buf.size());
                DWORD got = 0;
                if (!ReadFile(out, buf.data(), want, &got, nullptr) || got == 0)
                    break;
                feed(buf.data(), got);
            }
            // A close() stops the loop deliberately: the session is already
            // gone, so there is no exit event left to report.
            if (!closed.load())
            {
                DWORD code = 0;
                if (proc)
                    GetExitCodeProcess(proc, &code);
                finish((long long)code);
            }
        }

        void shutdown()
        {
            if (closed.exchange(true))
                return;
            alive.store(false);
            {
                std::lock_guard<std::mutex> lk(wmx);
                if (job && proc)
                    TerminateJobObject(job, 1); // the whole child tree
                if (proc)
                    TerminateProcess(proc, 1);
                if (pc)
                {
                    api().close(pc);
                    pc = nullptr;
                }
            }
            // The reader only touches the pipe, never pc: it notices `closed`
            // and exits on its own, then the pipe handles go.
            if (reader.joinable() && reader.get_id() != std::this_thread::get_id())
                reader.join();
            {
                std::lock_guard<std::mutex> lk(wmx);
                if (in)
                {
                    CloseHandle(in);
                    in = nullptr;
                }
                if (out)
                {
                    CloseHandle(out);
                    out = nullptr;
                }
                if (proc)
                {
                    CloseHandle(proc);
                    proc = nullptr;
                }
                if (job)
                {
                    CloseHandle(job);
                    job = nullptr;
                }
            }
        }
#else // ---------------------------------------------------------------- POSIX
        bool start(const std::string &shell_override, std::string &err)
        {
            shell = shell_override.empty() ? std::string(getenv("SHELL") ? getenv("SHELL") : "/bin/sh") : shell_override;
            struct winsize wsz{};
            wsz.ws_col = (unsigned short)cols;
            wsz.ws_row = (unsigned short)rows;
            int m = -1;
            pid_t c = forkpty(&m, nullptr, nullptr, &wsz);
            if (c < 0)
            {
                err = "forkpty failed";
                return false;
            }
            if (c == 0)
            {
                ::setenv("TERM", "xterm-256color", 1);
                ::setenv("COLORTERM", "truecolor", 1);
                if (!cwd.empty())
                    (void)!::chdir(cwd.c_str());
                const char *sh = shell.c_str();
                ::execl(sh, sh, "-i", (char *)nullptr);
                ::_exit(127);
            }
            master.store(m);
            child.store((long long)c);
            pid = (long long)c;
            return true;
        }

        void set_size(int c, int r)
        {
            std::lock_guard<std::mutex> lk(wmx);
            cols = c;
            rows = r;
            int m = master.load();
            if (m < 0 || closed.load())
                return;
            struct winsize wsz{};
            wsz.ws_col = (unsigned short)cols;
            wsz.ws_row = (unsigned short)rows;
            ioctl(m, TIOCSWINSZ, &wsz);
            long long c2 = child.load();
            if (c2 > 0)
                kill((pid_t)c2, SIGWINCH);
        }

        bool write_input(const std::string &bytes, std::string &err)
        {
            std::lock_guard<std::mutex> lk(wmx);
            int m = master.load();
            if (m < 0 || closed.load())
            {
                err = "session is not writable";
                return false;
            }
            size_t off = 0;
            while (off < bytes.size())
            {
                ssize_t n = ::write(m, bytes.data() + off, bytes.size() - off);
                if (n < 0)
                {
                    if (errno == EINTR)
                        continue;
                    err = "write to the session failed";
                    return false;
                }
                off += (size_t)n;
            }
            return true;
        }

        void pump()
        {
            std::vector<char> buf(kReadBuf);
            for (;;)
            {
                if (closed.load())
                    break;
                int m = master.load();
                if (m < 0)
                    break;
                struct pollfd pfd{};
                pfd.fd = m;
                pfd.events = POLLIN;
                int pr = ::poll(&pfd, 1, 60);
                if (pr < 0)
                {
                    if (errno == EINTR)
                        continue;
                    break;
                }
                if (pr == 0)
                    continue;
                if (pfd.revents & (POLLHUP | POLLERR | POLLNVAL))
                {
                    // drain what is still buffered before leaving
                    ssize_t n = ::read(m, buf.data(), buf.size());
                    if (n > 0)
                        feed(buf.data(), (size_t)n);
                    break;
                }
                if (pfd.revents & POLLIN)
                {
                    ssize_t n = ::read(m, buf.data(), buf.size());
                    if (n > 0)
                        feed(buf.data(), (size_t)n);
                    else if (n == 0)
                        break;
                    else if (errno != EINTR && errno != EAGAIN)
                        break;
                }
            }
            int st = 0;
            long long code = 0;
            long long c = child.load();
            // A deliberate close() stops this loop while the shell may still be
            // alive: never block waiting for it in that case.
            int flags = closed.load() ? WNOHANG : 0;
            if (c > 0)
            {
                pid_t r = waitpid((pid_t)c, &st, flags);
                if (r == (pid_t)c)
                {
                    child.store(0);
                    if (WIFEXITED(st))
                        code = WEXITSTATUS(st);
                    else if (WIFSIGNALED(st))
                        code = 128 + WTERMSIG(st);
                }
            }
            if (!closed.load())
                finish(code);
        }

        void shutdown()
        {
            if (closed.exchange(true))
                return;
            alive.store(false);
            long long c = child.load();
            if (c > 0)
                kill((pid_t)c, SIGHUP);
            // The reader wakes up within one poll tick and reaps the shell if it
            // is gone; only after it stopped is the master fd closed.
            if (reader.joinable() && reader.get_id() != std::this_thread::get_id())
                reader.join();
            std::lock_guard<std::mutex> lk(wmx);
            int m = master.load();
            if (m >= 0)
            {
                ::close(m);
                master.store(-1);
            }
            c = child.load();
            if (c > 0)
            {
                int st = 0;
                if (waitpid((pid_t)c, &st, WNOHANG) == 0)
                {
                    kill((pid_t)c, SIGKILL);
                    waitpid((pid_t)c, &st, 0);
                }
                child.store(0);
            }
        }
#endif

        // ---- shared plumbing --------------------------------------------
        void feed(const char *p, size_t n)
        {
            if (closed.load())
                return; // the session is going away; late bytes are not events
            long long sq;
            {
                std::lock_guard<std::mutex> lk(mx);
                backlog.emplace_back(p, n);
                backlog_bytes += n;
                while (backlog_bytes > kMaxBacklog && backlog.size() > 1)
                {
                    backlog_bytes -= backlog.front().size();
                    backlog.pop_front();
                }
                sq = ++seq;
            }
            emit(json{{"t", "term.out"}, {"ws", ws}, {"id", id}, {"seq", sq},
                      {"d", b64_encode(p, n)}});
        }

        // Exactly one term.exit per session: a natural child exit and an explicit
        // term.close can race, and the UI must not draw the exit notice twice.
        void announce_exit(long long code)
        {
            if (exit_sent.exchange(true))
                return;
            emit(json{{"t", "term.exit"}, {"ws", ws}, {"id", id}, {"code", code}});
        }

        void finish(long long code)
        {
            alive.store(false);
            if (!closed.load())
                announce_exit(code);
        }

        std::string backlog_b64()
        {
            std::lock_guard<std::mutex> lk(mx);
            std::string all;
            all.reserve(backlog_bytes);
            for (auto &c : backlog)
                all += c;
            return b64_encode(all.data(), all.size());
        }

        json info() const
        {
            json r = tok();
            r["id"] = id;
            r["ws"] = ws;
            r["cwd"] = cwd;
            r["shell"] = shell;
            r["cols"] = cols;
            r["rows"] = rows;
            r["pid"] = pid;
            r["alive"] = alive.load();
            return r;
        }
    };

    // =====================================================================
    //  registry — one live session per workspace, addressable by id
    // =====================================================================
    struct registry
    {
        std::mutex mx;
        std::map<std::string, std::shared_ptr<session>> by_id;
        std::map<std::string, std::string> ws_to_id;
        long long seq = 0;
    };

    inline registry &reg()
    {
        static registry r;
        return r;
    }

    inline std::shared_ptr<session> find_locked(const std::string &id)
    {
        registry &r = reg();
        auto it = r.by_id.find(id);
        return it == r.by_id.end() ? nullptr : it->second;
    }

    inline json open(const json &args, const std::string &cwd, const std::string &ws, const post_fn &post)
    {
        int cols = clamp_int(jint(args, "cols", 80), 2, 1000);
        int rows = clamp_int(jint(args, "rows", 24), 2, 500);
        bool force = jbool(args, "force", false);
        std::string shell_arg = trim_shell(jstr(args, "shell"));
        // one live shell per workspace; with no workspace selected the resolved
        // directory is the key, so a client that only passes cwd still reattaches
        std::string key = ws.empty() ? cwd : ws;

        registry &r = reg();
        std::shared_ptr<session> s, dead;
        bool announce_dead = false;
        {
            std::lock_guard<std::mutex> lk(r.mx);
            if (!key.empty())
            {
                auto wit = r.ws_to_id.find(key);
                if (wit != r.ws_to_id.end())
                {
                    auto sit = r.by_id.find(wit->second);
                    if (sit == r.by_id.end())
                        r.ws_to_id.erase(wit); // stale mapping
                    else if (!force && sit->second->alive.load())
                        s = sit->second; // reattach to the live shell
                    else
                    {
                        // force: replace the running shell; dead: clean up first
                        dead = sit->second;
                        announce_dead = dead->alive.load(); // force kicks a live shell
                        r.by_id.erase(sit);
                        r.ws_to_id.erase(wit);
                    }
                }
            }
        }
        if (dead)
        {
            // Clients still showing the replaced shell get one last exit event
            // so the page can say so instead of silently dropping their input.
            if (announce_dead)
                dead->announce_exit(0);
            dead->shutdown();
        }

        bool reused = (bool)s;
        if (!s)
        {
            auto fresh = std::make_shared<session>();
            fresh->ws = ws;
            fresh->cwd = cwd;
            fresh->cols = cols;
            fresh->rows = rows;
            fresh->set_post(post);
            {
                std::lock_guard<std::mutex> lk(r.mx);
                fresh->id = "t" + std::to_string(++r.seq);
            }
            std::string err;
            if (!fresh->start(shell_arg, err))
                return terr(err);

            // Two clients can race term.open for the same workspace while the
            // shell above is being spawned. The registry has the final word:
            // whoever registered first wins and the loser's shell is dropped.
            std::shared_ptr<session> winner;
            {
                std::lock_guard<std::mutex> lk(r.mx);
                if (!key.empty())
                {
                    auto wit = r.ws_to_id.find(key);
                    if (wit != r.ws_to_id.end())
                    {
                        auto sit = r.by_id.find(wit->second);
                        if (sit != r.by_id.end() && sit->second->alive.load())
                            winner = sit->second;
                    }
                }
                if (!winner)
                {
                    r.by_id[fresh->id] = fresh;
                    if (!key.empty())
                        r.ws_to_id[key] = fresh->id;
                }
            }
            if (winner)
            {
                fresh->shutdown();
                s = winner;
                reused = true;
            }
            else
            {
                s = fresh;
                s->reader = std::thread([s]()
                                        { s->pump(); });
                cell::sys::logger::instance().info(
                    "term", std::format("session open id={} ws={} pid={} {}x{} cwd={} shell={}",
                                        s->id, s->ws, s->pid, s->cols, s->rows, s->cwd, s->shell));
            }
        }
        if (reused && s)
            s->set_post(post); // a refreshed page may be the listener now
        if (reused && (s->cols != cols || s->rows != rows))
            s->set_size(cols, rows);

        json r_out = s->info();
        r_out["reused"] = reused;
        {
            std::lock_guard<std::mutex> lk(s->mx);
            r_out["seq"] = s->seq;
        }
        r_out["backlog"] = s->backlog_b64();
        return r_out;
    }

    inline json input(const json &args)
    {
        std::string id = jstr(args, "id");
        std::shared_ptr<session> s;
        {
            registry &r = reg();
            std::lock_guard<std::mutex> lk(r.mx);
            s = find_locked(id);
        }
        if (!s)
            return terr("unknown terminal session");
        if (!s->alive.load())
            return terr("terminal session has exited");
        std::string data;
        if (args.is_object() && args.contains("text") && args["text"].is_string())
            data = args["text"].get<std::string>();
        else
        {
            std::string b64 = jstr(args, "data");
            if (!b64_decode(b64, data))
                return terr("data is not valid base64");
        }
        std::string err;
        if (!s->write_input(data, err))
            return terr(err);
        return tok();
    }

    inline json resize(const json &args)
    {
        std::string id = jstr(args, "id");
        int cols = clamp_int(jint(args, "cols", 80), 2, 1000);
        int rows = clamp_int(jint(args, "rows", 24), 2, 500);
        std::shared_ptr<session> s;
        {
            registry &r = reg();
            std::lock_guard<std::mutex> lk(r.mx);
            s = find_locked(id);
        }
        if (!s)
            return terr("unknown terminal session");
        s->set_size(cols, rows);
        json r_out = tok();
        r_out["cols"] = cols;
        r_out["rows"] = rows;
        return r_out;
    }

    inline json close(const json &args)
    {
        std::string id = jstr(args, "id");
        std::string ws = jstr(args, "ws");
        std::shared_ptr<session> s;
        registry &r = reg();
        {
            std::lock_guard<std::mutex> lk(r.mx);
            if (id.empty() && !ws.empty())
            {
                auto wit = r.ws_to_id.find(ws);
                if (wit != r.ws_to_id.end())
                    id = wit->second;
            }
            s = find_locked(id);
            if (s)
            {
                r.by_id.erase(id);
                for (auto it = r.ws_to_id.begin(); it != r.ws_to_id.end();)
                    it = (it->second == id) ? r.ws_to_id.erase(it) : std::next(it);
            }
        }
        if (!s)
            return terr("unknown terminal session");
        // A close is a deliberate end of the session, but other clients may still
        // be attached to it (multi-tab): announce it the same way a shell exit is
        // announced, then tear the pty down.
        if (s->alive.load())
            s->announce_exit(0);
        s->shutdown();
        cell::sys::logger::instance().info("term", std::format("session close id={} ws={}", s->id, s->ws));
        json r_out = tok();
        r_out["closed"] = true;
        return r_out;
    }

    inline json list(const json &args)
    {
        std::string ws = jstr(args, "ws");
        json arr = json::array();
        registry &r = reg();
        std::lock_guard<std::mutex> lk(r.mx);
        for (auto &[id, s] : r.by_id)
        {
            if (!ws.empty() && s->ws != ws)
                continue;
            arr.push_back(s->info());
        }
        json out = tok();
        out["sessions"] = std::move(arr);
        return out;
    }

    // Close every session (process exit). Safe to call more than once.
    inline void shutdown_all()
    {
        std::vector<std::shared_ptr<session>> all;
        {
            registry &r = reg();
            std::lock_guard<std::mutex> lk(r.mx);
            for (auto &[id, s] : r.by_id)
                all.push_back(s);
            r.by_id.clear();
            r.ws_to_id.clear();
        }
        for (auto &s : all)
            s->shutdown();
    }

    // one dispatcher for the term.* verbs this module owns (term.exec stays in
    // cell-app-tools.hpp; the caller resolves ws/cwd before calling here)
    inline json handle(const std::string &name, const json &args, const std::string &cwd,
                       const std::string &ws, const post_fn &post)
    {
        if (name == "term.open")
            return open(args, cwd, ws, post);
        if (name == "term.input")
            return input(args);
        if (name == "term.resize")
            return resize(args);
        if (name == "term.close")
            return close(args);
        if (name == "term.list")
            return list(args);
        return terr("unknown command: " + name);
    }
} // namespace app::term
