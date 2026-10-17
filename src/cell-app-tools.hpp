// ============================================================================
//  cell-app-tools.hpp — desktop-workbench commands behind the command bus
// ============================================================================
//
//  The shell exposes the agent runtime through one JSON command bus
//  (app_core::exec_command). This header adds the commands the desktop
//  workbench needs on top of the agent verbs:
//
//      git.status          worktree state + changed files + worktree list
//      git.worktrees       worktree inventory
//      git.worktree.add    create a worktree (new or existing branch)
//      git.worktree.remove remove a worktree
//      git.branches        local branches + current branch
//      git.log             recent commits
//      git.numstat         per-file added/deleted line counts
//      git.diff            diff text (worktree or index)
//      git.init            initialise a repository
//      fs.list             one directory of the workspace
//      fs.read             a text file (bounded, binary-aware)
//      fs.find             file search under the workspace
//      term.exec           run a shell command in the workspace
//
//  Every command takes an optional "ws" (workspace key, default: the active
//  workspace) and an optional "cwd" (absolute directory, default: that
//  workspace's cwd). "cwd" makes the commands work on a directory that is not
//  open as a workspace, which is what the Git panel does while browsing.
//
//  Response protocol: {"ok":true,...} or {"ok":false,"error":"..."}. The exact
//  shapes are documented in docs/api-tools.md (contract: docs/ui-redesign.md 6).
//
//  Isolation / safety:
//    * fs.*  resolve every path against the workspace cwd, canonicalise it
//            (symlinks/junctions included) and refuse anything outside
//            (no "..", no absolute escape);
//    * git.* validate branch names against a strict whitelist and quote every
//            argument they hand to the shell; diff paths must stay in the repo;
//    * child processes go through cell::plat::spawn_cmd — the same runner as
//            the agent's exec tool (timeout, whole-process-tree kill, bounded
//            capture); outputs are additionally capped here (diff/term 256 KiB,
//            fs.read 512 KiB / 5000 lines).
//
//  Include order: this header is included by cell-app-core.hpp, which the
//  application includes AFTER cell.cpp (cell::plat::spawn_cmd lives there).
//  It purposely does not include cell.cpp itself.
// ============================================================================
#pragma once

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace app::tools
{
    namespace fs = std::filesystem;
    using json = nlohmann::json;

    // =====================================================================
    //  small text / JSON helpers
    // =====================================================================
    inline json jok() { return json{{"ok", true}}; }
    inline json jerr(const std::string &e) { return json{{"ok", false}, {"error", e}}; }

    inline std::string trim_copy(std::string_view s)
    {
        size_t b = 0, e = s.size();
        while (b < e && std::isspace((unsigned char)s[b]))
            ++b;
        while (e > b && std::isspace((unsigned char)s[e - 1]))
            --e;
        return std::string(s.substr(b, e - b));
    }

    inline std::string lower_ascii(std::string s)
    {
        for (char &c : s)
            if (c >= 'A' && c <= 'Z')
                c = char(c - 'A' + 'a');
        return s;
    }

    inline bool starts_with(const std::string &s, const char *prefix)
    {
        return s.rfind(prefix, 0) == 0;
    }

    inline bool ends_with(const std::string &s, const char *suffix)
    {
        size_t n = std::strlen(suffix);
        return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
    }

    // Cut a string to cap bytes without slicing a UTF-8 sequence in half.
    // Returns true when something was cut.
    inline bool cap_text(std::string &s, size_t cap)
    {
        if (s.size() <= cap)
            return false;
        s.resize(cap);
        while (!s.empty() && ((unsigned char)s.back() & 0xC0) == 0x80)
            s.pop_back();
        return true;
    }

    inline std::string jstr(const json &o, const char *key, std::string def = {})
    {
        if (!o.is_object())
            return def;
        auto it = o.find(key);
        if (it == o.end() || !it->is_string())
            return def;
        return it->get<std::string>();
    }

    inline long long jint(const json &o, const char *key, long long def)
    {
        if (!o.is_object())
            return def;
        auto it = o.find(key);
        if (it == o.end())
            return def;
        try
        {
            if (it->is_number_unsigned())
            {
                unsigned long long v = it->get<unsigned long long>();
                return v > (unsigned long long)std::numeric_limits<long long>::max() ? def : (long long)v;
            }
            if (it->is_number_integer())
                return it->get<long long>();
            if (it->is_number_float())
                return (long long)it->get<double>();
            if (it->is_boolean())
                return it->get<bool>() ? 1 : 0;
            if (it->is_string())
                return std::stoll(trim_copy(it->get<std::string>()));
        }
        catch (const std::exception &)
        {
        }
        return def;
    }

    inline double jnum(const json &o, const char *key, double def)
    {
        if (!o.is_object())
            return def;
        auto it = o.find(key);
        if (it == o.end())
            return def;
        try
        {
            if (it->is_number())
                return it->get<double>();
            if (it->is_string())
                return std::stod(trim_copy(it->get<std::string>()));
        }
        catch (const std::exception &)
        {
        }
        return def;
    }

    inline bool jbool(const json &o, const char *key, bool def)
    {
        if (!o.is_object())
            return def;
        auto it = o.find(key);
        if (it == o.end())
            return def;
        if (it->is_boolean())
            return it->get<bool>();
        if (it->is_number())
            return it->get<double>() != 0.0;
        if (it->is_string())
        {
            std::string s = lower_ascii(trim_copy(it->get<std::string>()));
            if (s == "1" || s == "true" || s == "yes" || s == "on")
                return true;
            if (s == "0" || s == "false" || s == "no" || s == "off")
                return false;
        }
        return def;
    }

    inline std::vector<std::string> split_lines(const std::string &s)
    {
        std::vector<std::string> out;
        size_t pos = 0;
        while (pos < s.size())
        {
            size_t nl = s.find('\n', pos);
            std::string line = nl == std::string::npos ? s.substr(pos) : s.substr(pos, nl - pos);
            pos = nl == std::string::npos ? s.size() : nl + 1;
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            out.push_back(std::move(line));
        }
        return out;
    }

    inline long long to_ll(const std::string &s)
    {
        try
        {
            return std::stoll(s);
        }
        catch (const std::exception &)
        {
            return 0;
        }
    }

    // "2026-10-17T09:07:31Z" (UTC) for an epoch second; empty for unknown.
    inline std::string iso_utc(long long epoch)
    {
        if (epoch <= 0)
            return {};
        std::time_t t = (std::time_t)epoch;
        std::tm tmv{};
#ifdef _WIN32
        if (gmtime_s(&tmv, &t) != 0)
            return {};
#else
        if (!gmtime_r(&t, &tmv))
            return {};
#endif
        char buf[40];
        std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02dZ",
                      tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                      tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
        return buf;
    }

    // Chinese relative time for the commit list / worktree badges.
    inline std::string rel_time(long long epoch)
    {
        if (epoch <= 0)
            return {};
        long long now = (long long)std::chrono::duration_cast<std::chrono::seconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
        long long d = now - epoch;
        if (d < 0)
            d = 0;
        if (d < 60)
            return "刚刚";
        if (d < 3600)
            return std::to_string(d / 60) + " 分钟前";
        if (d < 86400)
            return std::to_string(d / 3600) + " 小时前";
        if (d < 86400LL * 30)
            return std::to_string(d / 86400) + " 天前";
        if (d < 86400LL * 365)
            return std::to_string(d / (86400LL * 30)) + " 个月前";
        return std::to_string(d / (86400LL * 365)) + " 年前";
    }

    // =====================================================================
    //  paths
    // =====================================================================
    inline std::string norm_key(const fs::path &p)
    {
        std::string s = p.lexically_normal().generic_string();
#ifdef _WIN32
        s = lower_ascii(std::move(s));
#endif
        return s;
    }

    // Native-style string (backslashes on Windows), used for absolute paths in
    // JSON so the frontend sees the same shape as workspace.cwd.
    inline std::string native_str(const fs::path &p)
    {
        fs::path q = p;
#ifdef _WIN32
        q.make_preferred();
#endif
        return q.lexically_normal().string();
    }

    inline bool path_under(const fs::path &root, const fs::path &p)
    {
        std::string r = norm_key(root);
        std::string q = norm_key(p);
        while (!r.empty() && r.back() == '/')
            r.pop_back();
        if (q == r)
            return true;
        return q.size() > r.size() && q.compare(0, r.size(), r) == 0 && q[r.size()] == '/';
    }

    // Path of p relative to base (generic, '/'), empty for base itself.
    inline std::string rel_display(const fs::path &base, const fs::path &p)
    {
        std::error_code ec;
        fs::path r = fs::relative(p, base, ec);
        if (ec || r.empty())
            return {};
        std::string s = r.generic_string();
        return s == "." ? std::string() : s;
    }

    // Resolve the command's working directory: args.cwd, else the cwd of the
    // workspace selected by the caller (dispatch passes it in).
    inline bool resolve_base(const json &args, const std::string &default_cwd,
                             fs::path &out, std::string &err)
    {
        std::string s = trim_copy(jstr(args, "cwd"));
        if (s.empty())
            s = trim_copy(default_cwd);
        if (s.empty())
        {
            err = "no workspace open - pass cwd";
            return false;
        }
        std::error_code ec;
        fs::path p = fs::path(s);
        if (p.is_relative())
        {
            if (!default_cwd.empty())
                p = fs::path(default_cwd) / p;
            else
                p = fs::absolute(p, ec);
        }
        if (!fs::is_directory(p, ec))
        {
            err = "not a directory: " + s;
            return false;
        }
        fs::path canon = fs::weakly_canonical(p, ec);
        out = ec ? p.lexically_normal() : canon;
        return true;
    }

    // Resolve a client path inside base. Absolute paths are accepted only when
    // they stay inside base; ".." escapes are rejected after canonicalisation
    // (which also defeats symlinks/junctions pointing out).
    inline bool resolve_inside(const fs::path &base, const std::string &rel,
                               bool must_exist, fs::path &out, std::string &err)
    {
        std::string s = trim_copy(rel);
        if (s.empty())
        {
            out = base;
            return true;
        }
        fs::path p = fs::path(s);
        if (p.is_relative())
            p = base / p;
        std::error_code ec;
        fs::path canon = fs::weakly_canonical(p, ec);
        if (ec)
        {
            err = "invalid path: " + s;
            return false;
        }
        if (!path_under(base, canon))
        {
            err = "path escapes the workspace: " + s;
            return false;
        }
        if (must_exist && !fs::exists(canon, ec))
        {
            err = "not found: " + s;
            return false;
        }
        out = canon;
        return true;
    }

    inline long long file_mtime_epoch(const fs::path &p)
    {
        std::error_code ec;
        auto ft = fs::last_write_time(p, ec);
        if (ec)
            return 0;
        auto now_ft = fs::file_time_type::clock::now();
        long long age = (long long)std::chrono::duration_cast<std::chrono::seconds>(now_ft - ft).count();
        long long now = (long long)std::chrono::duration_cast<std::chrono::seconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
        return now - age;
    }

    // =====================================================================
    //  child processes (cell::plat::spawn_cmd: timeout + process-tree kill)
    // =====================================================================
    struct proc
    {
        bool launched = false;
        int code = -1;
        std::string out, err;
    };

    inline proc run_shell(const std::string &cmdline, const fs::path &cwd, double timeout_s)
    {
        proc r;
        r.launched = cell::plat::spawn_cmd(cmdline, timeout_s, r.out, r.code, r.err, cwd);
        return r;
    }

    // Quote ONE shell argument. Windows: cmd.exe double quotes (paths may
    // contain spaces/&/% — the whitelists keep the dangerous inputs out);
    // POSIX: single quotes.
    inline std::string quote_arg(const std::string &s)
    {
        if (s.empty())
            return "\"\"";
#ifdef _WIN32
        static const char *special = " \t&|<>^()',\"";
        if (s.find_first_of(special) == std::string::npos)
            return s;
        std::string out;
        out.reserve(s.size() + 2);
        out.push_back('"');
        for (char c : s)
            out.push_back(c);
        out.push_back('"');
        return out;
#else
        std::string out;
        out.reserve(s.size() + 2);
        out.push_back('\'');
        for (char c : s)
        {
            if (c == '\'')
                out += "'\\''";
            else
                out.push_back(c);
        }
        out.push_back('\'');
        return out;
#endif
    }

    inline proc run_git(const fs::path &cwd, const std::string &gitargs, double timeout_s = 60.0)
    {
        return run_shell("git --no-pager -c color.ui=false -c core.quotepath=false " + gitargs,
                         cwd, timeout_s);
    }

    inline std::string git_error_text(const proc &r)
    {
        std::string s = trim_copy(r.err.empty() ? r.out : r.err);
        if (s.empty())
            s = "git failed (exit " + std::to_string(r.code) + ")";
        cap_text(s, 2000);
        return s;
    }

    // =====================================================================
    //  git:: repository / worktree introspection
    // =====================================================================
    struct repo_info
    {
        bool ok = false;
        fs::path top; // working-tree root of the CURRENT worktree
        std::string error;
    };

    inline repo_info find_repo(const fs::path &cwd)
    {
        repo_info ri;
        proc r = run_git(cwd, "rev-parse --show-toplevel", 30.0);
        if (!r.launched)
        {
            ri.error = "git is not available (failed to start)";
            return ri;
        }
        std::string top = trim_copy(r.out);
        if (r.code != 0 || top.empty())
        {
            ri.error = r.code != 0 ? git_error_text(r) : "not a git repository";
            return ri;
        }
        std::error_code ec;
        fs::path p = fs::path(top);
        fs::path canon = fs::weakly_canonical(p, ec);
        ri.top = ec ? p.lexically_normal() : canon;
        ri.ok = true;
        return ri;
    }

    struct worktree_entry
    {
        std::string path, head, branch;
        bool current = false, is_main = false, detached = false, locked = false, prunable = false;
    };

    // Parse "git worktree list --porcelain".
    inline std::vector<worktree_entry> list_worktrees(const fs::path &top, std::string *error = nullptr)
    {
        std::vector<worktree_entry> out;
        proc r = run_git(top, "worktree list --porcelain", 30.0);
        if (!r.launched || r.code != 0)
        {
            if (error)
                *error = git_error_text(r);
            return out;
        }
        worktree_entry cur;
        bool seen = false;
        auto flush = [&]()
        {
            if (seen && !cur.path.empty())
                out.push_back(cur);
            cur = worktree_entry{};
            seen = false;
        };
        for (auto &line : split_lines(r.out))
        {
            if (line.empty())
            {
                flush();
                continue;
            }
            if (starts_with(line, "worktree "))
            {
                cur.path = line.substr(9);
                seen = true;
            }
            else if (starts_with(line, "HEAD "))
                cur.head = line.substr(5);
            else if (starts_with(line, "branch "))
            {
                cur.branch = line.substr(7);
                if (starts_with(cur.branch, "refs/heads/"))
                    cur.branch = cur.branch.substr(11);
            }
            else if (line == "detached")
                cur.detached = true;
            else if (line == "locked" || starts_with(line, "locked "))
                cur.locked = true;
            else if (line == "prunable" || starts_with(line, "prunable "))
                cur.prunable = true;
        }
        flush();
        std::string cur_key = norm_key(top);
        for (size_t i = 0; i < out.size(); ++i)
        {
            std::string k = norm_key(fs::path(out[i].path));
            out[i].is_main = (i == 0);
            out[i].current = (k == cur_key);
            out[i].path = native_str(fs::path(out[i].path));
        }
        return out;
    }

    inline json worktrees_json(const std::vector<worktree_entry> &wts)
    {
        json arr = json::array();
        for (const auto &w : wts)
        {
            json e;
            e["path"] = w.path;
            e["branch"] = w.branch;
            e["head"] = w.head;
            e["current"] = w.current;
            e["is_main"] = w.is_main;
            e["detached"] = w.detached;
            e["locked"] = w.locked;
            e["prunable"] = w.prunable;
            arr.push_back(std::move(e));
        }
        return arr;
    }

    inline fs::path git_common_dir(const fs::path &top)
    {
        proc r = run_git(top, "rev-parse --git-common-dir", 20.0);
        std::string s = r.launched && r.code == 0 ? trim_copy(r.out) : std::string();
        if (s.empty())
            return top / ".git";
        fs::path p = fs::path(s);
        if (p.is_relative())
            p = top / p;
        std::error_code ec;
        fs::path canon = fs::weakly_canonical(p, ec);
        return ec ? p.lexically_normal() : canon;
    }

    // Append pattern to <git-common-dir>/info/exclude unless it is already a
    // line there. Used for ".worktrees/" so new worktrees do not dirty the
    // repository listing.
    inline void append_repo_exclude(const fs::path &main_root, const std::string &pattern)
    {
        fs::path info = git_common_dir(main_root) / "info";
        std::error_code ec;
        fs::create_directories(info, ec);
        fs::path file = info / "exclude";
        std::string body;
        {
            std::ifstream f(file, std::ios::binary);
            if (f)
                body.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
        }
        for (auto &line : split_lines(body))
            if (trim_copy(line) == pattern)
                return;
        std::ofstream f(file, std::ios::binary | std::ios::app);
        if (!f)
            return;
        if (!body.empty() && body.back() != '\n')
            f << "\n";
        f << pattern << "\n";
    }

    inline bool ref_exists(const fs::path &top, const std::string &branch)
    {
        proc r = run_git(top, "show-ref --verify --quiet " + quote_arg("refs/heads/" + branch), 30.0);
        return r.launched && r.code == 0;
    }

    // Branch-name whitelist (contract 6):
    //   ^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$  and no "..", no ".lock" suffix,
    //   no empty path segment / trailing slash.
    inline bool branch_name_ok(const std::string &b, std::string &err)
    {
        auto alnum = [](unsigned char c)
        { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); };
        if (b.empty() || b.size() > 121)
        {
            err = "invalid branch name (1..121 characters)";
            return false;
        }
        if (!alnum((unsigned char)b.front()))
        {
            err = "branch name must start with a letter or digit";
            return false;
        }
        for (unsigned char c : b)
        {
            if (!(alnum(c) || c == '.' || c == '_' || c == '/' || c == '-'))
            {
                err = "branch name may only contain A-Z a-z 0-9 . _ / -";
                return false;
            }
        }
        if (b.find("..") != std::string::npos)
        {
            err = "branch name must not contain '..'";
            return false;
        }
        if (ends_with(b, ".lock"))
        {
            err = "branch name must not end with '.lock'";
            return false;
        }
        if (b.back() == '/' || b.find("//") != std::string::npos)
        {
            err = "invalid branch name (empty path segment)";
            return false;
        }
        return true;
    }

    // =====================================================================
    //  git status (porcelain v2) parsing
    // =====================================================================
    struct status_entry
    {
        std::string path;
        char x = ' ';
        char y = ' ';
    };

    struct status_parse
    {
        std::string branch, oid, upstream;
        bool detached = false;
        long long ahead = 0, behind = 0;
        std::vector<status_entry> files;
    };

    // git C-quotes unusual path bytes even with core.quotepath=false; undo the
    // common escapes so the frontend sees the real path.
    inline std::string unquote_git_path(const std::string &s)
    {
        if (s.size() < 2 || s.front() != '"' || s.back() != '"')
            return s;
        std::string out;
        out.reserve(s.size());
        size_t end = s.size() - 1;
        for (size_t i = 1; i < end; ++i)
        {
            char c = s[i];
            if (c != '\\' || i + 1 >= end)
            {
                out.push_back(c);
                continue;
            }
            char e = s[++i];
            switch (e)
            {
            case 'n':
                out.push_back('\n');
                break;
            case 't':
                out.push_back('\t');
                break;
            case 'r':
                out.push_back('\r');
                break;
            case 'a':
                out.push_back('\a');
                break;
            case 'b':
                out.push_back('\b');
                break;
            case 'f':
                out.push_back('\f');
                break;
            case 'v':
                out.push_back('\v');
                break;
            case '\\':
                out.push_back('\\');
                break;
            case '"':
                out.push_back('"');
                break;
            default:
                if (e >= '0' && e <= '7')
                {
                    int v = e - '0';
                    for (int k = 0; k < 2 && i + 1 < end && s[i + 1] >= '0' && s[i + 1] <= '7'; ++k)
                        v = v * 8 + (s[++i] - '0');
                    out.push_back((char)v);
                }
                else
                    out.push_back(e);
            }
        }
        return out;
    }

    // Split the first n space-separated fields off a porcelain-v2 line; the
    // remainder (which may contain spaces) is the path.
    inline bool split_fields(const std::string &line, size_t n,
                             std::vector<std::string> &fields, std::string &rest)
    {
        fields.clear();
        rest.clear();
        size_t pos = 0;
        for (size_t i = 0; i < n; ++i)
        {
            size_t sp = line.find(' ', pos);
            if (sp == std::string::npos)
                return false;
            fields.push_back(line.substr(pos, sp - pos));
            pos = sp + 1;
        }
        rest = line.substr(pos);
        return true;
    }

    inline status_parse parse_status_v2(const std::string &out)
    {
        status_parse st;
        std::vector<std::string> f;
        std::string rest;
        for (const auto &line : split_lines(out))
        {
            if (line.empty())
                continue;
            if (line[0] == '#')
            {
                std::string body = line.size() > 2 ? line.substr(2) : std::string();
                if (starts_with(body, "branch.oid "))
                    st.oid = trim_copy(body.substr(11));
                else if (starts_with(body, "branch.head "))
                    st.branch = trim_copy(body.substr(12));
                else if (starts_with(body, "branch.upstream "))
                    st.upstream = trim_copy(body.substr(16));
                else if (starts_with(body, "branch.ab "))
                {
                    std::string ab = trim_copy(body.substr(10));
                    size_t sp = ab.find(' ');
                    if (sp != std::string::npos)
                    {
                        long long a = to_ll(trim_copy(ab.substr(0, sp)));
                        long long b = to_ll(trim_copy(ab.substr(sp + 1)));
                        st.ahead = a < 0 ? -a : a; // "+<ahead>"
                        st.behind = b < 0 ? -b : b; // "-<behind>"
                    }
                }
                continue;
            }
            char type = line[0];
            if (type == '?')
            {
                if (line.size() > 2)
                {
                    status_entry e;
                    e.path = unquote_git_path(line.substr(2));
                    e.x = '?';
                    e.y = '?';
                    st.files.push_back(std::move(e));
                }
                continue;
            }
            if (type == '!')
                continue;
            if (type == '1' && split_fields(line, 8, f, rest) && f.size() == 8)
            {
                status_entry e;
                e.x = f[1][0];
                e.y = f[1][1];
                e.path = unquote_git_path(rest);
                st.files.push_back(std::move(e));
            }
            else if (type == '2' && split_fields(line, 9, f, rest) && f.size() == 9)
            {
                status_entry e;
                e.x = f[1][0];
                e.y = f[1][1];
                size_t tab = rest.find('\t');
                e.path = unquote_git_path(tab == std::string::npos ? rest : rest.substr(0, tab));
                st.files.push_back(std::move(e));
            }
            else if (type == 'u' && split_fields(line, 10, f, rest) && f.size() == 10)
            {
                status_entry e;
                e.x = f[1][0];
                e.y = f[1][1];
                e.path = unquote_git_path(rest);
                st.files.push_back(std::move(e));
            }
        }
        st.detached = st.branch == "(detached)";
        return st;
    }

    // One-letter change kind for the UI badge (M/A/D/U; R/C pass through).
    inline std::string status_letter(char x, char y)
    {
        if (x == '?')
            return "U";
        auto conflict = [](char a, char b)
        {
            char buf[3] = {a, b, 0};
            for (const char *p : {"DD", "AU", "UD", "UA", "DU", "AA", "UU"})
                if (std::strcmp(buf, p) == 0)
                    return true;
            return false;
        };
        if (conflict(x, y))
            return "U";
        if (y != '.' && y != ' ')
            return std::string(1, y);
        if (x != '.' && x != ' ')
            return std::string(1, x);
        return "M";
    }

    struct add_del
    {
        long long add = 0, del = 0;
        bool binary = false;
    };

    inline void parse_numstat(const std::string &out, std::map<std::string, add_del> &nums)
    {
        for (const auto &line : split_lines(out))
        {
            if (line.empty())
                continue;
            size_t t1 = line.find('\t');
            if (t1 == std::string::npos)
                continue;
            size_t t2 = line.find('\t', t1 + 1);
            if (t2 == std::string::npos)
                continue;
            std::string a = line.substr(0, t1);
            std::string d = line.substr(t1 + 1, t2 - t1 - 1);
            std::string path = unquote_git_path(line.substr(t2 + 1));
            add_del ad;
            if (a == "-" || d == "-")
                ad.binary = true;
            else
            {
                ad.add = to_ll(trim_copy(a));
                ad.del = to_ll(trim_copy(d));
            }
            nums[path] = ad;
        }
    }

    // git diff HEAD covers staged + unstaged changes. An empty repository has
    // no HEAD: fall back to the index and worktree diffs separately.
    inline void collect_numstat(const fs::path &top, std::map<std::string, add_del> &nums)
    {
        proc r = run_git(top, "diff HEAD --numstat --no-renames", 60.0);
        if (r.launched && r.code == 0)
        {
            parse_numstat(r.out, nums);
            return;
        }
        proc a = run_git(top, "diff --numstat --no-renames", 60.0);
        if (a.launched && a.code == 0)
            parse_numstat(a.out, nums);
        proc b = run_git(top, "diff --cached --numstat --no-renames", 60.0);
        if (b.launched && b.code == 0)
            parse_numstat(b.out, nums);
    }

    struct line_count
    {
        long long lines = 0;
        bool binary = false;
    };

    inline line_count count_file_lines(const fs::path &p)
    {
        line_count lc;
        std::error_code ec;
        if (!fs::is_regular_file(p, ec))
            return lc;
        if (fs::file_size(p, ec) > (std::uintmax_t)4 * 1024 * 1024 || ec)
            return lc;
        std::ifstream f(p, std::ios::binary);
        if (!f)
            return lc;
        char buf[65536];
        long long lines = 0;
        bool any = false, last_nl = true;
        while (f)
        {
            f.read(buf, sizeof buf);
            std::streamsize n = f.gcount();
            if (n <= 0)
                break;
            any = true;
            for (std::streamsize i = 0; i < n; ++i)
            {
                if (buf[i] == '\0')
                    lc.binary = true;
                if (buf[i] == '\n')
                    ++lines;
            }
            last_nl = buf[n - 1] == '\n';
        }
        if (lc.binary)
            return lc;
        if (any && !last_nl)
            ++lines;
        lc.lines = lines;
        return lc;
    }

    // =====================================================================
    //  git commands
    // =====================================================================
    inline json do_git_status(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);

        proc sr = run_git(repo.top, "status --porcelain=v2 --branch --untracked-files=all", 60.0);
        if (!sr.launched || sr.code != 0)
            return jerr(git_error_text(sr));
        status_parse st = parse_status_v2(sr.out);

        std::map<std::string, add_del> nums;
        collect_numstat(repo.top, nums);

        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        fs::path main_root = repo.top;
        if (!wts.empty())
            main_root = fs::path(wts[0].path);
        std::string holder = native_str(main_root);
        if (holder.empty())
            holder = native_str(repo.top);

        std::string branch = st.branch;
        if (st.detached && st.oid.size() >= 10 && st.oid[0] != '(')
            branch = st.oid.substr(0, 10);
        if (branch.empty() || branch == "(detached)")
            branch = st.oid;

        json files = json::array();
        for (const auto &e : st.files)
        {
            long long add = 0, del = 0;
            bool staged = false;
            if (e.x == '?')
            {
                line_count lc = count_file_lines(repo.top / fs::path(e.path));
                add = lc.lines;
            }
            else
            {
                auto it = nums.find(e.path);
                if (it != nums.end())
                {
                    add = it->second.add;
                    del = it->second.del;
                }
                staged = e.x != '.' && e.x != ' ' && e.x != '?';
            }
            json fe;
            fe["path"] = e.path;
            fe["status"] = status_letter(e.x, e.y);
            fe["add"] = add;
            fe["del"] = del;
            fe["staged"] = staged;
            files.push_back(std::move(fe));
        }

        std::string repo_name = fs::path(holder).filename().string();
        if (repo_name.empty())
            repo_name = holder;
        bool is_main = wts.empty() ? true : wts[0].current;

        json out = jok();
        out["repo"] = repo_name;
        out["root"] = holder;
        out["branch"] = branch;
        out["detached"] = st.detached;
        out["ahead"] = st.ahead;
        out["behind"] = st.behind;
        out["dirty_count"] = (long long)st.files.size();
        out["files"] = std::move(files);
        out["worktrees"] = worktrees_json(wts);
        out["is_main"] = is_main;
        return out;
    }

    inline json do_git_worktrees(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);
        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        if (wts.empty())
            return jerr(werr.empty() ? "no worktrees" : werr);
        std::string root = wts[0].path;
        std::string current;
        for (const auto &w : wts)
            if (w.current)
                current = w.path;
        if (current.empty())
            current = native_str(repo.top);
        std::string repo_name = fs::path(root).filename().string();
        if (repo_name.empty())
            repo_name = root;
        json out = jok();
        out["root"] = root;
        out["repo_name"] = repo_name;
        out["current"] = current;
        out["worktrees"] = worktrees_json(wts);
        return out;
    }

    inline json do_git_worktree_add(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);

        std::string branch = trim_copy(jstr(args, "branch"));
        std::string berr;
        if (!branch_name_ok(branch, berr))
            return jerr(berr);
        std::string basearg = trim_copy(jstr(args, "base"));
        if (!basearg.empty() && !branch_name_ok(basearg, berr))
            return jerr("invalid base branch: " + berr);

        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        fs::path main_root = wts.empty() ? repo.top : fs::path(wts[0].path);

        std::string patharg = trim_copy(jstr(args, "path"));
        fs::path target;
        if (patharg.empty())
        {
            std::string safe;
            for (char c : branch)
                safe.push_back(c == '/' ? '-' : c);
            target = main_root / ".worktrees" / safe;
        }
        else
        {
            target = fs::path(patharg);
            if (target.is_relative())
                target = main_root / target;
            target = target.lexically_normal();
        }
        std::string target_key = norm_key(target);
        std::string hidden_git = norm_key(main_root) + "/.git";
        if (target_key == hidden_git || starts_with(target_key, (hidden_git + "/").c_str()))
            return jerr("path must not be inside .git");
        std::error_code ec;
        if (fs::exists(target, ec))
            return jerr("path already exists: " + native_str(target));

        bool branch_exists = ref_exists(repo.top, branch);
        bool create = jbool(args, "create_branch", !branch_exists);
        if (!branch_exists && !create)
            return jerr("branch does not exist: " + branch + " (enable create_branch)");
        if (branch_exists && create)
            return jerr("branch already exists: " + branch);

        std::string cmdline = "worktree add ";
        if (create)
            cmdline += "-b " + quote_arg(branch) + " " + quote_arg(native_str(target)) + " " +
                       quote_arg(basearg.empty() ? "HEAD" : basearg);
        else
            cmdline += quote_arg(native_str(target)) + " " + quote_arg(branch);
        proc r = run_git(repo.top, cmdline, 120.0);
        if (!r.launched)
            return jerr("failed to start git");
        if (r.code != 0)
            return jerr(git_error_text(r));

        // Keep ".worktrees/" out of git status (contract 6).
        append_repo_exclude(main_root, ".worktrees/");
        json out = jok();
        out["path"] = native_str(target);
        out["branch"] = branch;
        return out;
    }

    inline json do_git_worktree_remove(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);
        std::string patharg = trim_copy(jstr(args, "path"));
        if (patharg.empty())
            return jerr("path is required");

        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        fs::path main_root = wts.empty() ? repo.top : fs::path(wts[0].path);
        fs::path target = fs::path(patharg);
        if (target.is_relative())
            target = main_root / target;
        target = target.lexically_normal();

        bool found = false;
        for (const auto &w : wts)
        {
            if (norm_key(fs::path(w.path)) != norm_key(target))
                continue;
            found = true;
            if (w.is_main)
                return jerr("refusing to remove the main worktree");
        }
        if (!found)
            return jerr("not a registered worktree: " + native_str(target));

        std::string cmdline = "worktree remove ";
        if (jbool(args, "force", false))
            cmdline += "--force ";
        cmdline += quote_arg(native_str(target));
        proc r = run_git(main_root, cmdline, 120.0);
        if (!r.launched)
            return jerr("failed to start git");
        if (r.code != 0)
            return jerr(git_error_text(r));
        return jok();
    }

    inline json do_git_branches(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);

        proc r = run_git(repo.top, "branch --list --no-color", 45.0);
        if (!r.launched || r.code != 0)
            return jerr(git_error_text(r));
        json local = json::array();
        std::string current;
        for (const auto &line : split_lines(r.out))
        {
            if (line.size() < 2)
                continue;
            std::string name = line.substr(2);
            if (name.empty())
                continue;
            char mark = line[0];
            if (mark == '*')
            {
                if (name[0] == '(')
                    continue;
                if (current.empty())
                    current = name;
                local.push_back(name);
            }
            else if (mark == '+' || mark == ' ')
                local.push_back(name);
        }
        proc cr = run_git(repo.top, "branch --show-current", 30.0);
        if (cr.launched && cr.code == 0)
        {
            std::string c = trim_copy(cr.out);
            if (!c.empty())
                current = c;
        }
        if (current.empty())
        {
            proc sr = run_git(repo.top, "symbolic-ref --short HEAD", 30.0);
            if (sr.launched && sr.code == 0)
                current = trim_copy(sr.out);
        }
        json out = jok();
        out["current"] = current;
        out["local"] = std::move(local);
        return out;
    }

    inline json do_git_log(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);
        long long limit = jint(args, "limit", 5);
        if (limit < 1)
            limit = 1;
        if (limit > 100)
            limit = 100;

        proc r = run_git(repo.top, "log -n " + std::to_string(limit) + " --pretty=raw --no-color", 60.0);
        if (!r.launched)
            return jerr("failed to start git");
        if (r.code != 0)
        {
            std::string e = git_error_text(r);
            if (e.find("does not have any commits") != std::string::npos ||
                e.find("unknown revision") != std::string::npos)
            {
                json out = jok();
                out["commits"] = json::array();
                return out;
            }
            return jerr(e);
        }

        struct commit
        {
            std::string hash, author, subject;
            long long epoch = 0;
        };
        std::vector<commit> commits;
        commit cur;
        bool in_msg = false;
        for (const auto &line : split_lines(r.out))
        {
            if (starts_with(line, "commit "))
            {
                if (!cur.hash.empty())
                    commits.push_back(cur);
                cur = commit{};
                cur.hash = line.substr(7);
                in_msg = false;
                continue;
            }
            if (cur.hash.empty())
                continue;
            if (!in_msg)
            {
                if (starts_with(line, "author "))
                {
                    std::string a = line.substr(7);
                    size_t sp2 = a.rfind(' ');
                    if (sp2 != std::string::npos && sp2 > 0)
                    {
                        std::string rest = a.substr(0, sp2);
                        size_t sp1 = rest.rfind(' ');
                        if (sp1 != std::string::npos)
                        {
                            cur.epoch = to_ll(rest.substr(sp1 + 1));
                            std::string name = rest.substr(0, sp1);
                            size_t lt = name.rfind(" <");
                            if (lt != std::string::npos)
                                name.resize(lt);
                            cur.author = name;
                        }
                    }
                }
                else if (line.empty())
                    in_msg = true;
                continue;
            }
            if (cur.subject.empty())
            {
                std::string subj = line;
                if (subj.size() >= 4 && subj.compare(0, 4, "    ") == 0)
                    subj = subj.substr(4);
                else
                    subj = trim_copy(subj);
                if (!subj.empty())
                    cur.subject = subj;
            }
        }
        if (!cur.hash.empty())
            commits.push_back(cur);

        json arr = json::array();
        for (const auto &c : commits)
        {
            json e;
            e["hash"] = c.hash;
            e["short"] = c.hash.size() > 10 ? c.hash.substr(0, 10) : c.hash;
            e["subject"] = c.subject;
            e["author"] = c.author;
            e["time"] = iso_utc(c.epoch);
            e["rel"] = rel_time(c.epoch);
            arr.push_back(std::move(e));
        }
        json out = jok();
        out["commits"] = std::move(arr);
        return out;
    }

    inline json do_git_numstat(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);

        std::map<std::string, add_del> nums;
        collect_numstat(repo.top, nums);
        proc ur = run_git(repo.top, "ls-files --others --exclude-standard", 45.0);
        if (ur.launched && ur.code == 0)
        {
            for (const auto &path : split_lines(ur.out))
            {
                if (path.empty() || nums.count(path))
                    continue;
                line_count lc = count_file_lines(repo.top / fs::path(path));
                add_del ad;
                ad.add = lc.lines;
                ad.binary = lc.binary;
                nums[path] = ad;
            }
        }
        json files = json::array();
        for (const auto &[path, ad] : nums)
        {
            json fe;
            fe["path"] = path;
            fe["add"] = ad.add;
            fe["del"] = ad.del;
            fe["binary"] = ad.binary;
            files.push_back(std::move(fe));
        }
        json out = jok();
        out["files"] = std::move(files);
        return out;
    }

    inline json do_git_diff(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return jerr(repo.error);

        bool staged = jbool(args, "staged", false);
        std::string relpath;
        std::string patharg = trim_copy(jstr(args, "path"));
        if (!patharg.empty())
        {
            fs::path p(patharg);
            fs::path abs = p.is_absolute() ? p : repo.top / p;
            abs = abs.lexically_normal();
            if (!path_under(repo.top, abs) || norm_key(abs) == norm_key(repo.top))
                return jerr("path escapes the repository: " + patharg);
            std::error_code ec;
            fs::path rel = fs::relative(abs, repo.top, ec);
            if (ec || rel.empty())
                return jerr("invalid path: " + patharg);
            relpath = rel.generic_string();
        }

        std::string cmdline = staged ? "diff --cached" : "diff";
        if (!relpath.empty())
            cmdline += " -- " + quote_arg(relpath);
        proc r = run_git(repo.top, cmdline, 60.0);
        if (!r.launched)
            return jerr("failed to start git");
        if (r.code != 0)
            return jerr(git_error_text(r));

        std::string diff = r.out;
        bool truncated = cap_text(diff, 256 * 1024);
        bool binary = diff.find("Binary files ") != std::string::npos ||
                      diff.find("GIT binary patch") != std::string::npos;

        // An untracked path has no diff yet: synthesise a "new file" unified
        // diff so clicking a U entry in the change list shows its content.
        if (!relpath.empty() && diff.empty())
        {
            proc tracked = run_git(repo.top, "ls-files --error-unmatch -- " + quote_arg(relpath), 30.0);
            if (tracked.launched && tracked.code != 0)
            {
                fs::path abs = repo.top / fs::path(relpath);
                std::error_code ec;
                if (fs::is_regular_file(abs, ec) &&
                    fs::file_size(abs, ec) <= (std::uintmax_t)512 * 1024)
                {
                    std::ifstream f(abs, std::ios::binary);
                    std::string body((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                    if (body.find('\0') != std::string::npos)
                        binary = true;
                    else
                    {
                        std::string synth = "diff --git a/" + relpath + " b/" + relpath +
                                            "\nnew file mode 100644\n--- /dev/null\n+++ b/" + relpath + "\n";
                        size_t lines = 0;
                        for (char c : body)
                            if (c == '\n')
                                ++lines;
                        if (!body.empty() && body.back() != '\n')
                            ++lines;
                        synth += "@@ -0,0 +1," + std::to_string(lines) + " @@\n";
                        size_t start = 0;
                        while (start < body.size())
                        {
                            size_t nl = body.find('\n', start);
                            std::string line = nl == std::string::npos ? body.substr(start) : body.substr(start, nl - start);
                            synth += "+" + line + "\n";
                            start = nl == std::string::npos ? body.size() : nl + 1;
                        }
                        diff = std::move(synth);
                        truncated = cap_text(diff, 256 * 1024);
                    }
                }
            }
        }

        json out = jok();
        out["diff"] = std::move(diff);
        out["truncated"] = truncated;
        out["binary"] = binary;
        return out;
    }

    inline json do_git_init(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        repo_info repo = find_repo(base);
        if (repo.ok)
        {
            std::string werr;
            std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
            json out = jok();
            out["root"] = wts.empty() ? native_str(repo.top) : wts[0].path;
            return out;
        }
        proc r = run_git(base, "init", 60.0);
        if (!r.launched)
            return jerr("failed to start git");
        if (r.code != 0)
            return jerr(git_error_text(r));
        json out = jok();
        out["root"] = native_str(base);
        return out;
    }

    // =====================================================================
    //  fs commands (all paths stay inside the workspace cwd)
    // =====================================================================
    inline json do_fs_list(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        fs::path dir;
        if (!resolve_inside(base, jstr(args, "path"), true, dir, err))
            return jerr(err);
        std::error_code ec;
        if (!fs::is_directory(dir, ec))
            return jerr("not a directory: " + rel_display(base, dir));

        std::vector<fs::directory_entry> list;
        fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
        fs::directory_iterator end;
        for (; !ec && it != end; it.increment(ec))
            list.push_back(*it);
        std::error_code e1, e2;
        std::sort(list.begin(), list.end(),
                  [&](const fs::directory_entry &a, const fs::directory_entry &b)
                  {
                      bool ad = a.is_directory(e1), bd = b.is_directory(e2);
                      if (ad != bd)
                          return ad;
                      return lower_ascii(a.path().filename().string()) <
                             lower_ascii(b.path().filename().string());
                  });

        json entries = json::array();
        bool truncated = false;
        for (const auto &de : list)
        {
            if (entries.size() >= 2000)
            {
                truncated = true;
                break;
            }
            std::error_code e;
            bool isdir = de.is_directory(e);
            long long size = 0;
            if (!isdir)
            {
                auto sz = de.file_size(e);
                if (!e)
                    size = (long long)sz;
            }
            json eo;
            eo["name"] = de.path().filename().string();
            eo["path"] = rel_display(base, de.path());
            eo["dir"] = isdir;
            eo["size"] = size;
            eo["mtime"] = file_mtime_epoch(de.path());
            entries.push_back(std::move(eo));
        }
        json out = jok();
        out["path"] = rel_display(base, dir);
        out["entries"] = std::move(entries);
        out["truncated"] = truncated;
        return out;
    }

    inline json do_fs_read(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        std::string patharg = trim_copy(jstr(args, "path"));
        if (patharg.empty())
            return jerr("path is required");
        fs::path file;
        if (!resolve_inside(base, patharg, true, file, err))
            return jerr(err);
        std::error_code ec;
        if (!fs::is_regular_file(file, ec))
            return jerr("not a file: " + rel_display(base, file));

        constexpr std::uintmax_t kMaxBytes = 512 * 1024;
        std::uintmax_t size = fs::file_size(file, ec);
        if (ec)
            size = 0;
        std::ifstream f(file, std::ios::binary);
        if (!f)
            return jerr("cannot read: " + patharg);
        std::string data;
        data.resize((size_t)std::min<std::uintmax_t>(size, kMaxBytes));
        if (!data.empty())
            f.read(data.data(), (std::streamsize)data.size());
        data.resize((size_t)f.gcount());
        bool truncated = size > kMaxBytes;
        bool binary = data.find('\0') != std::string::npos;

        json out = jok();
        out["path"] = rel_display(base, file);
        out["size"] = (long long)size;
        out["binary"] = binary;
        if (binary)
        {
            out["text"] = "";
            out["truncated"] = truncated;
            out["lines"] = 0;
            return out;
        }
        constexpr size_t kMaxLines = 5000;
        size_t seen = 0;
        for (size_t i = 0; i < data.size(); ++i)
        {
            if (data[i] != '\n')
                continue;
            if (++seen == kMaxLines)
            {
                if (i + 1 < data.size())
                {
                    data.resize(i + 1);
                    truncated = true;
                }
                break;
            }
        }
        size_t lines = 0;
        for (char c : data)
            if (c == '\n')
                ++lines;
        if (!data.empty() && data.back() != '\n')
            ++lines;
        out["text"] = std::move(data);
        out["truncated"] = truncated;
        out["lines"] = (long long)lines;
        return out;
    }

    inline void gather_files(const fs::path &base, std::vector<std::string> &out, size_t cap)
    {
        out.clear();
        static std::mutex rg_mx;
        static int rg_state = 0; // 0 = unknown, 1 = available, -1 = missing
        bool have_rg = false;
        {
            std::lock_guard<std::mutex> lk(rg_mx);
            if (rg_state == 0)
            {
                proc probe = run_shell("rg --version", base, 10.0);
                rg_state = (probe.launched && probe.code == 0) ? 1 : -1;
            }
            have_rg = rg_state > 0;
        }
        if (have_rg)
        {
            proc r = run_shell("rg --files --color never", base, 15.0);
            if (r.launched && (r.code == 0 || !r.out.empty()))
            {
                size_t pos = 0;
                while (pos < r.out.size() && out.size() < cap)
                {
                    size_t nl = r.out.find('\n', pos);
                    std::string line = trim_copy(std::string_view(r.out).substr(
                        pos, nl == std::string::npos ? std::string::npos : nl - pos));
                    pos = nl == std::string::npos ? r.out.size() : nl + 1;
                    if (!line.empty())
                        out.push_back(std::move(line));
                }
                if (!out.empty())
                    return;
            }
        }
        static const char *skip_dirs[] = {
            ".git", "node_modules", "build", ".cell", ".worktrees", ".cache", "dist", "out",
            "target", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".next", ".gradle"};
        std::error_code ec;
        fs::recursive_directory_iterator it(base, fs::directory_options::skip_permission_denied, ec);
        fs::recursive_directory_iterator end;
        size_t seen = 0;
        while (!ec && it != end)
        {
            std::error_code e;
            if (it->is_directory(e))
            {
                std::string name = lower_ascii(it->path().filename().string());
                for (const char *skip : skip_dirs)
                {
                    if (name == skip)
                    {
                        it.disable_recursion_pending();
                        break;
                    }
                }
            }
            else if (it->is_regular_file(e))
            {
                if (++seen > cap)
                    break;
                out.push_back(rel_display(base, it->path()));
            }
            it.increment(ec);
        }
    }

    inline json do_fs_find(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        std::string q = lower_ascii(trim_copy(jstr(args, "q")));
        long long limit = jint(args, "limit", 80);
        if (limit < 1)
            limit = 1;
        if (limit > 500)
            limit = 500;
        std::vector<std::string> files;
        gather_files(base, files, 3000);
        json arr = json::array();
        for (const auto &rel : files)
        {
            if (!q.empty() && lower_ascii(rel).find(q) == std::string::npos)
                continue;
            json fe;
            fe["name"] = fs::path(rel).filename().string();
            fe["path"] = rel;
            arr.push_back(std::move(fe));
            if ((long long)arr.size() >= limit)
                break;
        }
        json out = jok();
        out["files"] = std::move(arr);
        return out;
    }

    // =====================================================================
    //  term.exec — one shell command, bounded and timed out
    // =====================================================================
    inline json do_term_exec(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return jerr(err);
        std::string cmd = jstr(args, "cmd");
        if (trim_copy(cmd).empty())
            return jerr("cmd is required");
        double timeout_s = jnum(args, "timeout_s", 120.0);
        if (!(timeout_s >= 1.0))
            timeout_s = 1.0;
        if (timeout_s > 600.0)
            timeout_s = 600.0;

        auto t0 = std::chrono::steady_clock::now();
        std::string out, errs;
        int code = -1;
        bool launched = cell::plat::spawn_cmd(cmd, timeout_s, out, code, errs, base);
        long long duration_ms = (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::steady_clock::now() - t0)
                                    .count();
        if (!launched)
            return jerr("failed to start the process");
        constexpr size_t kMaxOutput = 256 * 1024;
        bool truncated = cap_text(out, kMaxOutput);
        truncated = cap_text(errs, kMaxOutput) || truncated;
        json r = jok();
        r["exit_code"] = code;
        r["output"] = std::move(out);
        r["stderr"] = std::move(errs);
        r["duration_ms"] = duration_ms;
        r["truncated"] = truncated;
        return r;
    }

    // =====================================================================
    //  dispatch — command-bus entry point
    // =====================================================================
    inline bool is_tool_command(const std::string &name)
    {
        return starts_with(name, "git.") || starts_with(name, "fs.") || starts_with(name, "term.");
    }

    inline std::optional<json> dispatch(const std::string &name, const json &args,
                                       const std::string &default_cwd)
    {
        if (name == "git.status")
            return do_git_status(args, default_cwd);
        if (name == "git.worktrees")
            return do_git_worktrees(args, default_cwd);
        if (name == "git.worktree.add")
            return do_git_worktree_add(args, default_cwd);
        if (name == "git.worktree.remove")
            return do_git_worktree_remove(args, default_cwd);
        if (name == "git.branches")
            return do_git_branches(args, default_cwd);
        if (name == "git.log")
            return do_git_log(args, default_cwd);
        if (name == "git.numstat")
            return do_git_numstat(args, default_cwd);
        if (name == "git.diff")
            return do_git_diff(args, default_cwd);
        if (name == "git.init")
            return do_git_init(args, default_cwd);
        if (name == "fs.list")
            return do_fs_list(args, default_cwd);
        if (name == "fs.read")
            return do_fs_read(args, default_cwd);
        if (name == "fs.find")
            return do_fs_find(args, default_cwd);
        if (name == "term.exec")
            return do_term_exec(args, default_cwd);
        return jerr("unknown command: " + name);
    }

    // =====================================================================
    //  try_handle — called from app_core::exec_command before the core's own
    //  "unknown command" reply. Returns nullopt for names this module does
    //  not own, so every existing command keeps its behaviour.
    //
    //  Core is app_core. Its type is a template parameter because this
    //  header is included before app_core is defined: the body is only
    //  instantiated at the call site, where app_core is complete.
    //
    //  The default cwd is the cwd of the workspace selected by args.ws
    //  (default: active). The copy happens under ctx_mx so a concurrent
    //  workspace.close cannot free the context between lookup and copy.
    // =====================================================================
    template <typename Core>
    std::optional<nlohmann::json> try_handle(const std::string &name, const nlohmann::json &args, Core *core)
    {
        if (!is_tool_command(name))
            return std::nullopt;
        std::string default_cwd;
        if (core)
        {
            std::string ws = jstr(args, "ws");
            std::lock_guard<std::mutex> lk(core->ctx_mx);
            auto it = ws.empty() ? core->ctxs.find(core->active_ws) : core->ctxs.find(ws);
            if (it != core->ctxs.end())
                default_cwd = it->second->cwd;
            else if (!ws.empty())
                return jerr("unknown workspace: " + ws);
        }
        return dispatch(name, args, default_cwd);
    }
} // namespace app::tools
