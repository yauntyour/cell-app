// cell-app-term.hpp — real interactive terminal sessions (PTY).
//
//      term.open    {ws?, cwd?, cols?, rows?, shell?, force?, new?, id?, name?}
//                   -> {ok,id,ws,cwd,shell,name,cols,rows,pid,alive,seq,backlog}
//      term.input   {ws?,id,data|text}  data = base64(bytes), text = raw UTF-8
//      term.resize  {ws?,id,cols,rows}
//      term.close   {ws?,id}            (id may be omitted inside a ws)
//      term.list    {ws?}               -> {ok,sessions:[...]}
//
// Events (same JSON shape as every other event on the bus):
//      {"t":"term.out",  "ws":..,"id":..,"seq":N,"d":"<base64 bytes>"}
//      {"t":"term.exit", "ws":..,"id":..,"code":N}
//      {"t":"term.error","ws":..,"id":..,"error":"..."}
//
// A workspace may own several shells (one tab each): `new` always spawns, `id`
// reattaches to a running one (page refresh replays recent output), neither
// reuses the newest live shell of the workspace.
//
// The reader never blocks indefinitely on the pty (a PeekNamedPipe poll on
// Windows, poll() with a timeout on POSIX), so close() needs no
// cancel-a-blocked-read trick. Bytes travel as base64, so a multi-byte
// character split across two reads still renders correctly.
//
// Included by cell-app-tools.hpp after cell.cpp (cell::plat, cell::text).
#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "cell-app-util.hpp"

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
    using js::clamp_int, js::fail, js::jbool, js::jint, js::jstr, js::ok;

    // "C:\Windows\…\powershell.exe" -> "powershell": the label under the tab.
    inline std::string shell_label(std::string_view s)
    {
        // npos + 1 wraps to 0: no separator means "the whole path is the name"
        std::string name{s.substr(std::min(s.find_last_of("/\\") + 1, s.size()))};
        if (name.size() > 4 && js::starts_with_ci(std::string_view{name}.substr(name.size() - 4), ".exe"))
            name.resize(name.size() - 4);
        return name.empty() ? std::string{"shell"} : name;
    }

    // =====================================================================
    //  session — one shell attached to a pty
    // =====================================================================
    struct session
    {
        static constexpr size_t kMaxBacklog = 512 * 1024; // replayed on reattach
        static constexpr size_t kReadBuf = 32 * 1024;

        std::string id, ws, cwd, shell;
        std::string name;   // display label ("powershell"), set once the shell is spawned
        std::string reg_key; // registry key of the ws this session belongs to (ws or cwd)
        long long ord = 0;  // creation order (monotonic): "newest shell of the ws"
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

        static bool ci_less(const std::wstring &a, const std::wstring &b)
        {
            const size_t n = std::min(a.size(), b.size());
            for (size_t i = 0; i < n; i++)
            {
                const wchar_t x = std::towlower(a[i]), y = std::towlower(b[i]);
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
                    if (s.starts_with(L"TERM=") || s.starts_with(L"COLORTERM="))
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
            wchar_t buf[MAX_PATH + 1]{};
            const DWORD n = GetEnvironmentVariableW(L"COMSPEC", buf, MAX_PATH);
            if (n > 0 && n <= MAX_PATH)
                if (std::string s = cell::plat::wide_to_utf8(std::wstring_view{buf, n}); !s.empty())
                    return s;
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
            // The pseudoconsole attribute alone leaves the client attached to the
            // parent's console (or to none at all in a GUI-subsystem host, where
            // cmd.exe then exits at once). Handing it the pty ends as its standard
            // handles makes it a genuine console: isTTY, resizable, VT output.
            // bInheritHandles stays FALSE — with TRUE the client never attaches.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = in_r;
            si.StartupInfo.hStdOutput = out_w;
            si.StartupInfo.hStdError = out_w;

            std::wstring cmd = L"\"" + cell::plat::utf8_to_wide(shell) + L"\"";
            std::vector<wchar_t> env = env_block();
            const std::wstring wcwd = cell::plat::utf8_to_wide(cwd);
            PROCESS_INFORMATION pi{};
            const BOOL spawned = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                                                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                                                env.data(), wcwd.empty() ? nullptr : wcwd.c_str(),
                                                &si.StartupInfo, &pi);
            DeleteProcThreadAttributeList(list);
            HeapFree(GetProcessHeap(), 0, list);
            // the client holds the pty-side ends from here on
            CloseHandle(in_r);
            CloseHandle(out_w);
            if (!spawned)
            {
                const DWORD e = GetLastError();
                a.close(pc_tmp);
                CloseHandle(in_w);
                CloseHandle(out_r);
                err = std::format("CreateProcess failed (win32 {})", (unsigned long long)e);
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
                      {"d", b64_encode(std::string_view{p, n})}});
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
            for (const auto &chunk : backlog)
                all += chunk;
            return b64_encode(all);
        }

        json info() const
        {
            json r = ok();
            r["id"] = id;
            r["ws"] = ws;
            r["cwd"] = cwd;
            r["shell"] = shell;
            r["name"] = name;
            r["cols"] = cols;
            r["rows"] = rows;
            r["pid"] = pid;
            r["alive"] = alive.load();
            return r;
        }
    };


    // ---- registry -------------------------------------------------------
    // by_id holds every running shell (a workspace may own several); ws_to_id
    // remembers the newest one, so a plain term.open without `id` or `new`
    // still reattaches to it.
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

    // The shared_ptr keeps the session alive after the registry lock is gone.
    inline std::shared_ptr<session> find(std::string_view id)
    {
        registry &r = reg();
        std::lock_guard<std::mutex> lk(r.mx);
        const auto it = r.by_id.find(std::string{id});
        return it == r.by_id.end() ? nullptr : it->second;
    }

    // The live shell a plain term.open would reattach to. Caller holds r.mx.
    inline std::shared_ptr<session> live_default(registry &r, const std::string &key)
    {
        const auto wit = r.ws_to_id.find(key);
        if (wit == r.ws_to_id.end())
            return nullptr;
        const auto sit = r.by_id.find(wit->second);
        return sit != r.by_id.end() && sit->second->alive.load() ? sit->second : nullptr;
    }

    // The pty size a request asks for, clamped to what an OS terminal accepts.
    inline std::pair<int, int> grid_of(const json &args)
    {
        return {clamp_int(jint(args, "cols", 80), 2, 1000),
                clamp_int(jint(args, "rows", 24), 2, 500)};
    }

    inline json open(const json &args, const std::string &cwd, const std::string &ws, const post_fn &post)
    {
        const auto [cols, rows] = grid_of(args);
        const bool spawn_new = jbool(args, "new", false);
        const std::string attach_id = jstr(args, "id");
        const std::string want_name = jstr(args, "name");
        const std::string shell_arg = cell::text::trim(jstr(args, "shell"));
        const std::string key = ws.empty() ? cwd : ws; // cwd fallback: cwd-only clients

        registry &r = reg();
        std::shared_ptr<session> s, replaced;
        bool announce_replaced = false;
        if (!attach_id.empty())
        {
            std::lock_guard<std::mutex> lk(r.mx);
            const auto it = r.by_id.find(attach_id);
            if (it == r.by_id.end())
                return fail("unknown terminal session: " + attach_id);
            if (!it->second->alive.load())
                return fail("terminal session has exited: " + attach_id);
            s = it->second;
        }
        else if (!spawn_new && !key.empty())
        {
            std::lock_guard<std::mutex> lk(r.mx);
            if ((s = live_default(r, key)) && jbool(args, "force", false))
            {
                // force: drop the running shell and spawn a fresh one
                replaced = std::exchange(s, nullptr);
                announce_replaced = replaced->alive.load();
            }
            if (!s && !replaced)
            {
                // no live shell, but a dead/stale entry may still hold the key
                if (const auto wit = r.ws_to_id.find(key); wit != r.ws_to_id.end())
                {
                    const auto sit = r.by_id.find(wit->second);
                    replaced = sit == r.by_id.end() ? nullptr : sit->second;
                    r.by_id.erase(wit->second);
                    r.ws_to_id.erase(wit);
                }
            }
        }
        if (replaced)
        {
            // whoever still shows the replaced shell gets one exit event, so the
            // page can say so instead of silently dropping its input
            if (announce_replaced)
                replaced->announce_exit(0);
            replaced->shutdown();
        }

        bool reused = s != nullptr;
        if (!s)
        {
            auto fresh = std::make_shared<session>();
            fresh->ws = ws;
            fresh->cwd = cwd;
            fresh->cols = cols;
            fresh->rows = rows;
            fresh->set_post(post);
            fresh->reg_key = key;
            {
                std::lock_guard<std::mutex> lk(r.mx);
                fresh->ord = ++r.seq;
                fresh->id = std::format("t{}", fresh->ord);
            }
            std::string err;
            if (!fresh->start(shell_arg, err))
                return fail(err);
            fresh->name = want_name.empty() ? shell_label(fresh->shell) : want_name;

            // Two clients can race term.open while the shell is being spawned:
            // whoever registered first wins and the loser's shell is dropped.
            // `new` opts out — every tab is its own shell.
            std::shared_ptr<session> winner;
            {
                std::lock_guard<std::mutex> lk(r.mx);
                if (!spawn_new && !key.empty())
                    winner = live_default(r, key);
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
                s = std::move(winner);
                reused = true;
            }
            else
            {
                s = std::move(fresh);
                s->reader = std::thread([s]
                                        { s->pump(); });
                cell::sys::logger::instance().info(
                    "term", std::format("session open id={} ws={} pid={} {}x{} cwd={} shell={}",
                                        s->id, s->ws, s->pid, s->cols, s->rows, s->cwd, s->shell));
            }
        }
        if (reused)
        {
            s->set_post(post); // a refreshed page may be the listener now
            if (s->cols != cols || s->rows != rows)
                s->set_size(cols, rows);
        }

        json out = s->info();
        out["reused"] = reused;
        out["backlog"] = s->backlog_b64();
        {
            std::lock_guard<std::mutex> lk(s->mx);
            out["seq"] = s->seq;
        }
        return out;
    }

    inline json input(const json &args)
    {
        const auto s = find(jstr(args, "id"));
        if (!s)
            return fail("unknown terminal session");
        if (!s->alive.load())
            return fail("terminal session has exited");
        std::string data;
        if (const json *text = js::field(args, "text"); text && text->is_string())
            data = text->get<std::string>();
        else if (!b64_decode(jstr(args, "data"), data))
            return fail("data is not valid base64");
        std::string err;
        if (!s->write_input(data, err))
            return fail(err);
        return ok();
    }

    inline json resize(const json &args)
    {
        const auto s = find(jstr(args, "id"));
        if (!s)
            return fail("unknown terminal session");
        const auto [cols, rows] = grid_of(args);
        s->set_size(cols, rows);
        json out = ok();
        out["cols"] = cols;
        out["rows"] = rows;
        return out;
    }

    inline json close(const json &args)
    {
        std::string id = jstr(args, "id");
        const std::string ws = jstr(args, "ws");
        registry &r = reg();
        std::shared_ptr<session> s;
        {
            std::lock_guard<std::mutex> lk(r.mx);
            if (id.empty() && !ws.empty())
                if (const auto wit = r.ws_to_id.find(ws); wit != r.ws_to_id.end())
                    id = wit->second;
            const auto it = r.by_id.find(id);
            if (it == r.by_id.end())
                return fail("unknown terminal session");
            s = it->second;
            r.by_id.erase(it);
            std::erase_if(r.ws_to_id, [&](const auto &kv)
                          { return kv.second == id; });
            // the workspace keeps its other shells: the default must fall back
            // to the newest one still alive, or a plain term.open would spawn a
            // third shell instead of reattaching
            if (!s->reg_key.empty() && !r.ws_to_id.contains(s->reg_key))
            {
                std::shared_ptr<session> best;
                for (auto &[sid, other] : r.by_id)
                    if (other->reg_key == s->reg_key && other->alive.load() &&
                        (!best || other->ord > best->ord))
                        best = other;
                if (best)
                    r.ws_to_id[s->reg_key] = best->id;
            }
        }
        // other tabs may still be attached: announce the end like a shell exit
        if (s->alive.load())
            s->announce_exit(0);
        s->shutdown();
        cell::sys::logger::instance().info("term", std::format("session close id={} ws={}", s->id, s->ws));
        json out = ok();
        out["closed"] = true;
        return out;
    }

    inline json list(const json &args)
    {
        const std::string ws = jstr(args, "ws");
        json sessions = json::array();
        registry &r = reg();
        std::lock_guard<std::mutex> lk(r.mx);
        for (const auto &[id, s] : r.by_id)
            if (ws.empty() || s->ws == ws)
                sessions.push_back(s->info());
        json out = ok();
        out["sessions"] = std::move(sessions);
        return out;
    }

    // Close every session (process exit). Safe to call more than once.
    inline void shutdown_all()
    {
        std::vector<std::shared_ptr<session>> all;
        {
            registry &r = reg();
            std::lock_guard<std::mutex> lk(r.mx);
            for (const auto &[id, s] : r.by_id)
                all.push_back(s);
            r.by_id.clear();
            r.ws_to_id.clear();
        }
        for (const auto &s : all)
            s->shutdown();
    }

    // The verbs this module owns (term.exec stays in cell-app-tools.hpp; the
    // caller resolves ws/cwd beforehand).
    inline json handle(const std::string &name, const json &args, const std::string &cwd,
                       const std::string &ws, const post_fn &post)
    {
        if (name == "term.open")
            return open(args, cwd, ws, post);
        if (name == "term.list")
            return list(args);
        if (name == "term.input")
            return input(args);
        if (name == "term.resize")
            return resize(args);
        if (name == "term.close")
            return close(args);
        return fail("unknown command: " + name);
    }
} // namespace app::term
