// ============================================================================
//  cell-app-tools.hpp — desktop-workbench commands behind the command bus
// ============================================================================
//
//  app_core::exec_command adds the desktop verbs on top of the agent's own
//  (docs/api-tools.md is the contract):
//
//      git.status | worktrees | worktree.add | worktree.remove | branches
//      git.log | numstat | diff | init
//      fs.list | read | find
//      term.exec | open | input | resize | close | list
//
//  Every command takes an optional "ws" (workspace key, default: the active
//  one) and an optional "cwd" (absolute directory, default: that workspace's
//  cwd) — "cwd" is what lets the Git panel browse a directory that is not open
//  as a workspace. A response is {"ok":true,…} or {"ok":false,"error":"…"}.
//
//  Isolation: fs.* resolve every path against the base, canonicalise it
//  (symlinks/junctions included) and refuse anything outside; git.* validate
//  branch names against a whitelist and quote every argument; child processes
//  go through cell::plat::spawn_cmd (timeout, whole-tree kill, bounded
//  capture), with the outputs capped again here.
//
//  Included by cell-app-core.hpp, i.e. after cell.cpp (cell::plat, cell::text).
// ============================================================================
#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "cell-app-term.hpp" // term.open/input/resize/close/list
#include "cell-app-util.hpp"

namespace app::tools
{
    namespace fs = std::filesystem;
    using json = nlohmann::json;
    using js::cap_text, js::clamp_int, js::fail, js::jbool, js::jint, js::jnum, js::jstr, js::ok, js::to_ll;

    // "2026-10-17T09:07:31Z" (UTC) for an epoch second; empty for unknown.
    inline std::string iso_utc(long long epoch)
    {
        if (epoch <= 0)
            return {};
        const std::time_t t = (std::time_t)epoch;
        std::tm tmv{};
#ifdef _WIN32
        if (gmtime_s(&tmv, &t) != 0)
            return {};
#else
        if (!gmtime_r(&t, &tmv))
            return {};
#endif
        return std::format("{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z", tmv.tm_year + 1900, tmv.tm_mon + 1,
                           tmv.tm_mday, tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
    }

    // The commit list and the worktree badges show Chinese relative times.
    inline std::string rel_time(long long epoch)
    {
        if (epoch <= 0)
            return {};
        const long long now = (long long)std::chrono::duration_cast<std::chrono::seconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();
        const long long d = std::max(0LL, now - epoch);
        constexpr long long kMin = 60, kHour = 3600, kDay = 86400;
        if (d < kMin)
            return "刚刚";
        if (d < kHour)
            return std::format("{} 分钟前", d / kMin);
        if (d < kDay)
            return std::format("{} 小时前", d / kHour);
        if (d < kDay * 30)
            return std::format("{} 天前", d / kDay);
        if (d < kDay * 365)
            return std::format("{} 个月前", d / (kDay * 30));
        return std::format("{} 年前", d / (kDay * 365));
    }

    // =====================================================================
    //  paths
    // =====================================================================
    inline std::string norm_key(const fs::path &p)
    {
        std::string s = p.lexically_normal().generic_string();
#ifdef _WIN32
        cell::lower_ascii(s); // case-insensitive file system
#endif
        return s;
    }

    // Native separators, so the frontend sees the same shape as workspace.cwd.
    inline std::string native_str(fs::path p)
    {
#ifdef _WIN32
        p.make_preferred();
#endif
        return p.lexically_normal().string();
    }

    // p is `root` or a path below it (both already normalised by norm_key).
    inline bool path_under(const fs::path &root, const fs::path &p)
    {
        const std::string r = norm_key(root), q = norm_key(p);
        return q == r || (q.size() > r.size() && q[r.size()] == '/' && q.starts_with(r));
    }

    // p relative to base (generic '/'), empty for base itself.
    inline std::string rel_display(const fs::path &base, const fs::path &p)
    {
        std::error_code ec;
        const fs::path r = fs::relative(p, base, ec);
        const std::string s = ec || r.empty() ? std::string{} : r.generic_string();
        return s == "." ? std::string{} : s;
    }

    // The command's working directory: args.cwd, else the cwd of the workspace
    // the caller selected (dispatch passes it in).
    inline bool resolve_base(const json &args, const std::string &default_cwd, fs::path &out, std::string &err)
    {
        std::string s = cell::text::trim(jstr(args, "cwd"));
        if (s.empty())
            s = cell::text::trim(default_cwd);
        if (s.empty())
        {
            err = "no workspace open - pass cwd";
            return false;
        }
        std::error_code ec;
        fs::path p = s;
        if (p.is_relative())
            p = default_cwd.empty() ? fs::absolute(p, ec) : fs::path(default_cwd) / p;
        if (!fs::is_directory(p, ec))
        {
            err = "not a directory: " + s;
            return false;
        }
        const fs::path canon = fs::weakly_canonical(p, ec);
        out = ec ? p.lexically_normal() : canon;
        return true;
    }

    // A client path inside base. Absolute paths are accepted only while they
    // stay inside base; ".." escapes are rejected after canonicalisation, which
    // also defeats symlinks/junctions pointing out.
    inline bool resolve_inside(const fs::path &base, const std::string &rel, bool must_exist, fs::path &out, std::string &err)
    {
        const std::string s = cell::text::trim(rel);
        if (s.empty())
        {
            out = base;
            return true;
        }
        fs::path p = s;
        if (p.is_relative())
            p = base / p;
        std::error_code ec;
        const fs::path canon = fs::weakly_canonical(p, ec);
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
        const auto ft = fs::last_write_time(p, ec);
        if (ec)
            return 0;
        const auto age = std::chrono::duration_cast<std::chrono::seconds>(fs::file_time_type::clock::now() - ft);
        return (long long)std::chrono::duration_cast<std::chrono::seconds>(
                   std::chrono::system_clock::now().time_since_epoch())
                   .count() -
               (long long)age.count();
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
        std::string s = cell::text::trim(r.err.empty() ? r.out : r.err);
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
        const std::string top = cell::text::trim(r.out);
        if (r.code != 0 || top.empty())
        {
            ri.error = r.code != 0 ? git_error_text(r) : "not a git repository";
            return ri;
        }
        std::error_code ec;
        const fs::path p = top;
        const fs::path canon = fs::weakly_canonical(p, ec);
        ri.top = ec ? p.lexically_normal() : canon;
        ri.ok = true;
        return ri;
    }

    // Every git.* command opens the same way: resolve the directory, find the
    // worktree root. Returns the repo, or the ready-to-send error response.
    inline std::expected<repo_info, json> repo_at(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return std::unexpected(fail(err));
        repo_info repo = find_repo(base);
        if (!repo.ok)
            return std::unexpected(fail(repo.error));
        return repo;
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
        for (std::string_view line : cell::text::lines(r.out))
        {
            if (line.empty())
            {
                flush();
                continue;
            }
            if (line.starts_with("worktree "))
            {
                cur.path = line.substr(9);
                seen = true;
            }
            else if (line.starts_with("HEAD "))
                cur.head = line.substr(5);
            else if (line.starts_with("branch "))
            {
                cur.branch = line.substr(7);
                if (cur.branch.starts_with("refs/heads/"))
                    cur.branch = cur.branch.substr(11);
            }
            else if (line == "detached")
                cur.detached = true;
            else if (line == "locked" || line.starts_with("locked "))
                cur.locked = true;
            else if (line == "prunable" || line.starts_with("prunable "))
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
        std::string s = r.launched && r.code == 0 ? cell::text::trim(r.out) : std::string();
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
        for (std::string_view line : cell::text::lines(body))
            if (cell::text::trim(line) == pattern)
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
        if (b.ends_with(".lock"))
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
    inline std::string unquote_git_path(std::string_view s)
    {
        if (s.size() < 2 || s.front() != '"' || s.back() != '"')
            return std::string{s};
        std::string out;
        out.reserve(s.size());
        const size_t end = s.size() - 1;
        for (size_t i = 1; i < end; ++i)
        {
            const char c = s[i];
            if (c != '\\' || i + 1 >= end)
            {
                out.push_back(c);
                continue;
            }
            const char e = s[++i];
            switch (e)
            {
            case 'n': out.push_back('\n'); break;
            case 't': out.push_back('\t'); break;
            case 'r': out.push_back('\r'); break;
            case 'a': out.push_back('\a'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'v': out.push_back('\v'); break;
            case '\\': out.push_back('\\'); break;
            case '"': out.push_back('"'); break;
            default:
                if (e >= '0' && e <= '7') // up to three octal digits: \303\251
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

    // A porcelain-v2 record is "1 XY … path" / "2 XY … path<TAB>origPath" /
    // "u XY … path": field 1 holds the two status letters and the last field is
    // the path, which may contain spaces. Returns the letters, fills `path`.
    inline std::optional<std::pair<char, char>> status_xy(std::string_view line, size_t fields, std::string &path)
    {
        size_t pos = 0;
        char x = ' ', y = ' ';
        for (size_t i = 0; i < fields; ++i)
        {
            const size_t sp = line.find(' ', pos);
            if (sp == std::string_view::npos)
                return std::nullopt;
            if (i == 1 && sp - pos >= 2)
            {
                x = line[pos];
                y = line[pos + 1];
            }
            pos = sp + 1;
        }
        path = unquote_git_path(line.substr(pos));
        return std::pair{x, y};
    }

    inline status_parse parse_status_v2(const std::string &out)
    {
        status_parse st;
        std::string path;
        for (const std::string_view line : cell::text::lines(out))
        {
            if (line.empty())
                continue;
            if (line[0] == '#')
            {
                const std::string_view body = line.size() > 2 ? line.substr(2) : std::string_view{};
                if (body.starts_with("branch.oid "))
                    st.oid = cell::text::trim(body.substr(11));
                else if (body.starts_with("branch.head "))
                    st.branch = cell::text::trim(body.substr(12));
                else if (body.starts_with("branch.upstream "))
                    st.upstream = cell::text::trim(body.substr(16));
                else if (body.starts_with("branch.ab "))
                {
                    // "+<ahead> -<behind>"
                    const std::string ab = cell::text::trim(body.substr(10));
                    if (const size_t sp = ab.find(' '); sp != std::string::npos)
                    {
                        st.ahead = std::abs(to_ll(ab.substr(0, sp)));
                        st.behind = std::abs(to_ll(ab.substr(sp + 1)));
                    }
                }
                continue;
            }
            switch (line[0])
            {
            case '?': // untracked
                if (line.size() > 2)
                {
                    st.files.push_back({unquote_git_path(line.substr(2)), '?', '?'});
                }
                break;
            case '1': // changed
                if (auto xy = status_xy(line, 8, path))
                    st.files.push_back({std::move(path), xy->first, xy->second});
                break;
            case '2': // renamed/copied: the path field is "new<TAB>orig"
                if (auto xy = status_xy(line, 9, path))
                {
                    if (const size_t tab = path.find('\t'); tab != std::string::npos)
                        path.resize(tab);
                    st.files.push_back({std::move(path), xy->first, xy->second});
                }
                break;
            case 'u': // unmerged
                if (auto xy = status_xy(line, 10, path))
                    st.files.push_back({std::move(path), xy->first, xy->second});
                break;
            default: // '!': ignored, '#' handled above
                break;
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
        static constexpr std::string_view conflicts[] = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"};
        const char pair[3] = {x, y, 0};
        if (std::ranges::find(conflicts, std::string_view{pair}) != std::end(conflicts))
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
        for (const std::string_view line : cell::text::lines(out))
        {
            const size_t t1 = line.find('\t');
            if (t1 == std::string_view::npos)
                continue;
            const size_t t2 = line.find('\t', t1 + 1);
            if (t2 == std::string_view::npos)
                continue;
            const std::string_view a = line.substr(0, t1), d = line.substr(t1 + 1, t2 - t1 - 1);
            add_del ad;
            if (a == "-" || d == "-")
                ad.binary = true; // binary: git reports '-'
            else
            {
                ad.add = to_ll(a);
                ad.del = to_ll(d);
            }
            nums[unquote_git_path(line.substr(t2 + 1))] = ad;
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
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;

        proc sr = run_git(repo.top, "status --porcelain=v2 --branch --untracked-files=all", 60.0);
        if (!sr.launched || sr.code != 0)
            return fail(git_error_text(sr));
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

        json out = ok();
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
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;
        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        if (wts.empty())
            return fail(werr.empty() ? "no worktrees" : werr);
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
        json out = ok();
        out["root"] = root;
        out["repo_name"] = repo_name;
        out["current"] = current;
        out["worktrees"] = worktrees_json(wts);
        return out;
    }

    inline json do_git_worktree_add(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;

        std::string branch = cell::text::trim(jstr(args, "branch"));
        std::string berr;
        if (!branch_name_ok(branch, berr))
            return fail(berr);
        std::string basearg = cell::text::trim(jstr(args, "base"));
        if (!basearg.empty() && !branch_name_ok(basearg, berr))
            return fail("invalid base branch: " + berr);

        std::string werr;
        std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
        fs::path main_root = wts.empty() ? repo.top : fs::path(wts[0].path);

        std::string patharg = cell::text::trim(jstr(args, "path"));
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
        if (target_key == hidden_git || target_key.starts_with((hidden_git + "/").c_str()))
            return fail("path must not be inside .git");
        std::error_code ec;
        if (fs::exists(target, ec))
            return fail("path already exists: " + native_str(target));

        bool branch_exists = ref_exists(repo.top, branch);
        bool create = jbool(args, "create_branch", !branch_exists);
        if (!branch_exists && !create)
            return fail("branch does not exist: " + branch + " (enable create_branch)");
        if (branch_exists && create)
            return fail("branch already exists: " + branch);

        std::string cmdline = "worktree add ";
        if (create)
            cmdline += "-b " + quote_arg(branch) + " " + quote_arg(native_str(target)) + " " +
                       quote_arg(basearg.empty() ? "HEAD" : basearg);
        else
            cmdline += quote_arg(native_str(target)) + " " + quote_arg(branch);
        proc r = run_git(repo.top, cmdline, 120.0);
        if (!r.launched)
            return fail("failed to start git");
        if (r.code != 0)
            return fail(git_error_text(r));

        // Keep ".worktrees/" out of git status (contract 6).
        append_repo_exclude(main_root, ".worktrees/");
        json out = ok();
        out["path"] = native_str(target);
        out["branch"] = branch;
        return out;
    }

    inline json do_git_worktree_remove(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;
        std::string patharg = cell::text::trim(jstr(args, "path"));
        if (patharg.empty())
            return fail("path is required");

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
                return fail("refusing to remove the main worktree");
        }
        if (!found)
            return fail("not a registered worktree: " + native_str(target));

        std::string cmdline = "worktree remove ";
        if (jbool(args, "force", false))
            cmdline += "--force ";
        cmdline += quote_arg(native_str(target));
        proc r = run_git(main_root, cmdline, 120.0);
        if (!r.launched)
            return fail("failed to start git");
        if (r.code != 0)
            return fail(git_error_text(r));
        return ok();
    }

    inline json do_git_branches(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;

        proc r = run_git(repo.top, "branch --list --no-color", 45.0);
        if (!r.launched || r.code != 0)
            return fail(git_error_text(r));
        json local = json::array();
        std::string current;
        for (const std::string_view line : cell::text::lines(r.out))
        {
            if (line.size() < 2)
                continue;
            std::string name{line.substr(2)};
            if (name.empty())
                continue;
            const char mark = line[0];
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
            std::string c = cell::text::trim(cr.out);
            if (!c.empty())
                current = c;
        }
        if (current.empty())
        {
            proc sr = run_git(repo.top, "symbolic-ref --short HEAD", 30.0);
            if (sr.launched && sr.code == 0)
                current = cell::text::trim(sr.out);
        }
        json out = ok();
        out["current"] = current;
        out["local"] = std::move(local);
        return out;
    }

    inline json do_git_log(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;
        long long limit = jint(args, "limit", 5);
        if (limit < 1)
            limit = 1;
        if (limit > 100)
            limit = 100;

        proc r = run_git(repo.top, "log -n " + std::to_string(limit) + " --pretty=raw --no-color", 60.0);
        if (!r.launched)
            return fail("failed to start git");
        if (r.code != 0)
        {
            std::string e = git_error_text(r);
            if (e.find("does not have any commits") != std::string::npos ||
                e.find("unknown revision") != std::string::npos)
            {
                json out = ok();
                out["commits"] = json::array();
                return out;
            }
            return fail(e);
        }

        struct commit
        {
            std::string hash, author, subject;
            long long epoch = 0;
        };
        std::vector<commit> commits;
        commit cur;
        bool in_msg = false;
        for (const std::string_view line : cell::text::lines(r.out))
        {
            if (line.starts_with("commit "))
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
                if (line.starts_with("author "))
                {
                    // "Name <mail> 1712345678 +0000"
                    const std::string_view a = line.substr(7);
                    const size_t sp2 = a.rfind(' ');
                    if (sp2 != std::string_view::npos && sp2 > 0)
                    {
                        const std::string_view rest = a.substr(0, sp2);
                        const size_t sp1 = rest.rfind(' ');
                        if (sp1 != std::string_view::npos)
                        {
                            cur.epoch = to_ll(rest.substr(sp1 + 1));
                            std::string name{rest.substr(0, sp1)};
                            if (const size_t lt = name.rfind(" <"); lt != std::string::npos)
                                name.resize(lt);
                            cur.author = std::move(name);
                        }
                    }
                }
                else if (line.empty())
                    in_msg = true;
                continue;
            }
            if (cur.subject.empty())
            {
                std::string_view subj = line;
                if (subj.starts_with("    ")) // the message body is indented
                    subj.remove_prefix(4);
                subj = cell::text::trim_view(subj);
                if (!subj.empty())
                    cur.subject = subj;
            }
        }
        if (!cur.hash.empty())
            commits.push_back(cur);

        json arr = json::array();
        for (const auto &c : commits)
            arr.push_back({{"hash", c.hash},
                           {"short", c.hash.substr(0, std::min<size_t>(10, c.hash.size()))},
                           {"subject", c.subject},
                           {"author", c.author},
                           {"time", iso_utc(c.epoch)},
                           {"rel", rel_time(c.epoch)}});
        json out = ok();
        out["commits"] = std::move(arr);
        return out;
    }

    inline json do_git_numstat(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;

        std::map<std::string, add_del> nums;
        collect_numstat(repo.top, nums);
        proc ur = run_git(repo.top, "ls-files --others --exclude-standard", 45.0);
        if (ur.launched && ur.code == 0)
        {
            for (std::string_view path : cell::text::lines(ur.out))
            {
                if (path.empty())
                    continue;
                const std::string key{path};
                if (nums.contains(key))
                    continue;
                const line_count lc = count_file_lines(repo.top / fs::path(key));
                nums[key] = add_del{lc.lines, 0, lc.binary};
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
        json out = ok();
        out["files"] = std::move(files);
        return out;
    }

    inline json do_git_diff(const json &args, const std::string &default_cwd)
    {
        const auto opened = repo_at(args, default_cwd);
        if (!opened)
            return opened.error();
        const repo_info &repo = *opened;

        bool staged = jbool(args, "staged", false);
        std::string relpath;
        std::string patharg = cell::text::trim(jstr(args, "path"));
        if (!patharg.empty())
        {
            fs::path p(patharg);
            fs::path abs = p.is_absolute() ? p : repo.top / p;
            abs = abs.lexically_normal();
            if (!path_under(repo.top, abs) || norm_key(abs) == norm_key(repo.top))
                return fail("path escapes the repository: " + patharg);
            std::error_code ec;
            fs::path rel = fs::relative(abs, repo.top, ec);
            if (ec || rel.empty())
                return fail("invalid path: " + patharg);
            relpath = rel.generic_string();
        }

        std::string cmdline = staged ? "diff --cached" : "diff";
        if (!relpath.empty())
            cmdline += " -- " + quote_arg(relpath);
        proc r = run_git(repo.top, cmdline, 60.0);
        if (!r.launched)
            return fail("failed to start git");
        if (r.code != 0)
            return fail(git_error_text(r));

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

        json out = ok();
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
            return fail(err);
        json out = ok();
        // already a repository: report its main worktree, do not re-init
        if (repo_info repo = find_repo(base); repo.ok)
        {
            std::string werr;
            const std::vector<worktree_entry> wts = list_worktrees(repo.top, &werr);
            out["root"] = wts.empty() ? native_str(repo.top) : wts[0].path;
            return out;
        }
        const proc r = run_git(base, "init", 60.0);
        if (!r.launched)
            return fail("failed to start git");
        if (r.code != 0)
            return fail(git_error_text(r));
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
            return fail(err);
        fs::path dir;
        if (!resolve_inside(base, jstr(args, "path"), true, dir, err))
            return fail(err);
        std::error_code ec;
        if (!fs::is_directory(dir, ec))
            return fail("not a directory: " + rel_display(base, dir));

        std::vector<fs::directory_entry> list;
        for (fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end; !ec && it != end; it.increment(ec))
            list.push_back(*it);
        std::error_code dir_ec;
        std::ranges::sort(list, [&dir_ec](const fs::directory_entry &a, const fs::directory_entry &b)
                          {
                              const bool ad = a.is_directory(dir_ec), bd = b.is_directory(dir_ec);
                              if (ad != bd)
                                  return ad; // directories first
                              return js::lower_ascii(a.path().filename().string()) <
                                     js::lower_ascii(b.path().filename().string());
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
            std::error_code entry_ec;
            const bool isdir = de.is_directory(entry_ec);
            long long size = 0;
            if (!isdir)
                if (const auto sz = de.file_size(entry_ec); !entry_ec)
                    size = (long long)sz;
            entries.push_back({{"name", de.path().filename().string()},
                               {"path", rel_display(base, de.path())},
                               {"dir", isdir},
                               {"size", size},
                               {"mtime", file_mtime_epoch(de.path())}});
        }
        json out = ok();
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
            return fail(err);
        std::string patharg = cell::text::trim(jstr(args, "path"));
        if (patharg.empty())
            return fail("path is required");
        fs::path file;
        if (!resolve_inside(base, patharg, true, file, err))
            return fail(err);
        std::error_code ec;
        if (!fs::is_regular_file(file, ec))
            return fail("not a file: " + rel_display(base, file));

        constexpr std::uintmax_t kMaxBytes = 512 * 1024;
        std::uintmax_t size = fs::file_size(file, ec);
        if (ec)
            size = 0;
        std::ifstream f(file, std::ios::binary);
        if (!f)
            return fail("cannot read: " + patharg);
        std::string data;
        data.resize((size_t)std::min<std::uintmax_t>(size, kMaxBytes));
        if (!data.empty())
            f.read(data.data(), (std::streamsize)data.size());
        data.resize((size_t)f.gcount());
        bool truncated = size > kMaxBytes;
        bool binary = data.find('\0') != std::string::npos;

        json out = ok();
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
        // The viewer renders 5000 lines; the byte cap above is the safety net
        // for one very long line. Counting and truncating are one pass.
        constexpr size_t kMaxLines = 5000;
        size_t lines = 0;
        for (size_t i = 0; i < data.size(); ++i)
        {
            if (data[i] != '\n')
                continue;
            if (++lines == kMaxLines)
            {
                if (i + 1 < data.size())
                {
                    data.resize(i + 1);
                    truncated = true;
                }
                break;
            }
        }
        if (lines < kMaxLines && !data.empty() && data.back() != '\n')
            ++lines;
        out["text"] = std::move(data);
        out["truncated"] = truncated;
        out["lines"] = (long long)lines;
        return out;
    }

    inline void gather_files(const fs::path &base, std::vector<std::string> &out, size_t cap)
    {
        out.clear();
        // ripgrep honours .gitignore and is an order of magnitude faster than a
        // directory walk; probed once per process, the walk is the fallback
        static const bool have_rg = []
        {
            const proc probe = run_shell("rg --version", fs::current_path(), 10.0);
            return probe.launched && probe.code == 0;
        }();
        if (have_rg)
        {
            const proc r = run_shell("rg --files --color never", base, 15.0);
            if (r.launched && (r.code == 0 || !r.out.empty()))
            {
                for (const std::string_view line : cell::text::lines(r.out))
                {
                    if (out.size() >= cap)
                        break;
                    if (!line.empty())
                        out.emplace_back(cell::text::trim(line));
                }
                if (!out.empty())
                    return;
            }
        }
        static constexpr std::string_view kSkipDirs[] = {
            ".git", "node_modules", "build", ".cell", ".worktrees", ".cache", "dist", "out",
            "target", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".next", ".gradle"};
        std::error_code ec;
        size_t seen = 0;
        for (fs::recursive_directory_iterator it(base, fs::directory_options::skip_permission_denied, ec), end;
             !ec && it != end; it.increment(ec))
        {
            std::error_code entry_ec;
            if (it->is_directory(entry_ec))
            {
                if (const std::string name = js::lower_ascii(it->path().filename().string());
                    std::ranges::find(kSkipDirs, std::string_view{name}) != std::end(kSkipDirs))
                    it.disable_recursion_pending();
            }
            else if (it->is_regular_file(entry_ec))
            {
                if (++seen > cap)
                    break;
                out.push_back(rel_display(base, it->path()));
            }
        }
    }

    inline json do_fs_find(const json &args, const std::string &default_cwd)
    {
        fs::path base;
        std::string err;
        if (!resolve_base(args, default_cwd, base, err))
            return fail(err);
        std::string q = js::lower_ascii(cell::text::trim(jstr(args, "q")));
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
            if (!q.empty() && js::lower_ascii(rel).find(q) == std::string::npos)
                continue;
            json fe;
            fe["name"] = fs::path(rel).filename().string();
            fe["path"] = rel;
            arr.push_back(std::move(fe));
            if ((long long)arr.size() >= limit)
                break;
        }
        json out = ok();
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
            return fail(err);
        std::string cmd = jstr(args, "cmd");
        if (cell::text::trim(cmd).empty())
            return fail("cmd is required");
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
            return fail("failed to start the process");
        constexpr size_t kMaxOutput = 256 * 1024;
        bool truncated = cap_text(out, kMaxOutput);
        truncated = cap_text(errs, kMaxOutput) || truncated;
        json r = ok();
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
    using handler = json (*)(const json &, const std::string &);

    inline constexpr std::pair<std::string_view, handler> kHandlers[] = {
        {"git.status", do_git_status},
        {"git.worktrees", do_git_worktrees},
        {"git.worktree.add", do_git_worktree_add},
        {"git.worktree.remove", do_git_worktree_remove},
        {"git.branches", do_git_branches},
        {"git.log", do_git_log},
        {"git.numstat", do_git_numstat},
        {"git.diff", do_git_diff},
        {"git.init", do_git_init},
        {"fs.list", do_fs_list},
        {"fs.read", do_fs_read},
        {"fs.find", do_fs_find},
        {"term.exec", do_term_exec},
    };

    inline std::optional<handler> find_handler(std::string_view name)
    {
        const auto it = std::ranges::find(kHandlers, name, &std::pair<std::string_view, handler>::first);
        return it == std::end(kHandlers) ? std::nullopt : std::optional{it->second};
    }

    inline bool is_tool_command(std::string_view name)
    {
        return name.starts_with("git.") || name.starts_with("fs.") || name.starts_with("term.");
    }

    inline json dispatch(const std::string &name, const json &args, const std::string &default_cwd)
    {
        const auto fn = find_handler(name);
        return fn ? (*fn)(args, default_cwd) : fail("unknown command: " + name);
    }

    // =====================================================================
    //  try_handle — called from app_core::exec_command before the core's own
    //  "unknown command" reply; nullopt for names this module does not own.
    //
    //  Core is app_core, passed as a template parameter because this header is
    //  included before app_core is defined: the body is instantiated at the
    //  call site, where app_core is complete.
    //
    //  The default cwd belongs to the workspace selected by args.ws (default:
    //  active). It is copied under ctx_mx so a concurrent workspace.close
    //  cannot free the context between the lookup and the copy.
    // =====================================================================
    template <typename Core>
    std::optional<nlohmann::json> try_handle(const std::string &name, const nlohmann::json &args, Core *core)
    {
        if (!is_tool_command(name))
            return std::nullopt;
        std::string default_cwd, ws_key;
        if (core)
        {
            std::string ws = jstr(args, "ws");
            std::lock_guard<std::mutex> lk(core->ctx_mx);
            auto it = ws.empty() ? core->ctxs.find(core->active_ws) : core->ctxs.find(ws);
            if (it != core->ctxs.end())
            {
                default_cwd = it->second->cwd;
                ws_key = it->second->cwd_key; // events are tagged with this
            }
            else if (!ws.empty())
                return fail("unknown workspace: " + ws);
        }

        // real terminal sessions live in their own module: open resolves the
        // directory here (args.cwd / the workspace cwd), every other verb
        // addresses an existing session by id. term.exec keeps its one-shot
        // path through dispatch() below.
        if (name.starts_with("term.") && name != "term.exec")
        {
            std::string cwd = default_cwd;
            if (name == "term.open")
            {
                fs::path base;
                std::string err;
                if (!resolve_base(args, default_cwd, base, err))
                    return fail(err);
                cwd = base.string();
            }
            // the reader thread publishes on the same event bus as everything
            // else, so one SSE stream feeds every tab
            term::post_fn post = [core](const nlohmann::json &e)
            {
                if (core)
                    core->bus.post(e);
            };
            return term::handle(name, args, cwd, ws_key, post);
        }
        return dispatch(name, args, default_cwd);
    }
} // namespace app::tools
