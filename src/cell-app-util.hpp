// cell-app-util.hpp — the helpers every shell module shares.
//
// One JSON envelope ({"ok":true,…} / {"ok":false,"error":…}), one set of
// tolerant accessors — command arguments come from browsers and hand-written
// JSON, so a mistyped or null field must read as "absent" instead of throwing —
// and the few text helpers the standard library does not have yet.
//
// cell.cpp (included first, see cell-app.cpp) already provides text::trim,
// text::lines, jstr/jbool/jint and the libsodium base64 codec; this header is
// the app-side vocabulary on top of it, so nothing is implemented twice.
#pragma once

#include <algorithm>
#include <charconv>
#include <cstddef>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace app::js
{
    using nlohmann::json;

    inline std::string lower_ascii(std::string_view s)
    {
        std::string out{s};
        cell::lower_ascii(out); // in place, ASCII only: ids, keys, file names
        return out;
    }

    // Case-insensitive ASCII prefix test (the shell compares file extensions
    // and role names, never prose).
    inline bool starts_with_ci(std::string_view s, std::string_view prefix)
    {
        return s.size() >= prefix.size() && lower_ascii(s.substr(0, prefix.size())) == lower_ascii(prefix);
    }

    // Cut to `cap` bytes without slicing a UTF-8 sequence in half.
    // Returns true when something was cut.
    inline bool cap_text(std::string &s, std::size_t cap)
    {
        if (s.size() <= cap)
            return false;
        s.resize(cap);
        while (!s.empty() && ((unsigned char)s.back() & 0xC0) == 0x80)
            s.pop_back();
        return true;
    }

    // The display variant: same cut, marked with an ellipsis (transcripts and
    // tool results are shown as text, never parsed).
    inline std::string elide(std::string s, std::size_t cap = 8000)
    {
        if (!cap_text(s, cap))
            return s;
        return s += "\n…";
    }

    // ---- the response envelope -------------------------------------------
    inline json ok() { return json{{"ok", true}}; }
    inline json fail(std::string_view why) { return json{{"ok", false}, {"error", why}}; }

    // ---- tolerant accessors ----------------------------------------------
    // A missing, null or wrongly typed field reads as `def`; a number may also
    // arrive as a quoted number ({"cols":"80"} must still open a terminal).
    inline const json *field(const json &o, const char *key)
    {
        if (!o.is_object())
            return nullptr;
        const auto it = o.find(key);
        return it == o.end() || it->is_null() ? nullptr : &*it;
    }

    inline std::string jstr(const json &o, const char *key, std::string_view def = {})
    {
        const json *f = field(o, key);
        return f && f->is_string() ? f->get<std::string>() : std::string{def};
    }

    // from_chars rather than stoll: no locale, no errno, no exception on garbage
    inline std::optional<long long> integer_of(std::string_view text)
    {
        text = cell::text::trim_view(text);
        long long v{};
        const auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), v);
        return ec == std::errc{} && end == text.data() + text.size() ? std::optional{v} : std::nullopt;
    }
    inline std::optional<double> real_of(std::string_view text)
    {
        text = cell::text::trim_view(text);
        double v{};
        const auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), v);
        return ec == std::errc{} && end == text.data() + text.size() ? std::optional{v} : std::nullopt;
    }

    // Non-throwing decimal parse: 0 for anything unparsable.
    inline long long to_ll(std::string_view s) { return integer_of(s).value_or(0); }

    inline long long jint(const json &o, const char *key, long long def = 0)
    {
        const json *f = field(o, key);
        if (!f)
            return def;
        if (f->is_number_unsigned())
        {
            const auto u = f->get<unsigned long long>();
            return u <= (unsigned long long)std::numeric_limits<long long>::max() ? (long long)u : def;
        }
        if (f->is_number_integer())
            return f->get<long long>();
        if (f->is_number_float())
            return (long long)f->get<double>();
        if (f->is_boolean())
            return f->get<bool>() ? 1 : 0;
        if (f->is_string())
            return integer_of(f->get_ref<const std::string &>()).value_or(def);
        return def;
    }

    inline double jnum(const json &o, const char *key, double def = 0.0)
    {
        const json *f = field(o, key);
        if (!f)
            return def;
        if (f->is_number())
            return f->get<double>();
        if (f->is_string())
            return real_of(f->get_ref<const std::string &>()).value_or(def);
        return def;
    }

    inline bool jbool(const json &o, const char *key, bool def = false)
    {
        const json *f = field(o, key);
        if (!f)
            return def;
        if (f->is_boolean())
            return f->get<bool>();
        if (f->is_number())
            return f->get<double>() != 0.0;
        if (!f->is_string())
            return def;
        static constexpr std::string_view yes[] = {"1", "true", "yes", "on"};
        static constexpr std::string_view no[] = {"0", "false", "no", "off"};
        const std::string low = lower_ascii(cell::text::trim_view(f->get_ref<const std::string &>()));
        if (std::ranges::find(yes, std::string_view{low}) != std::end(yes))
            return true;
        if (std::ranges::find(no, std::string_view{low}) != std::end(no))
            return false;
        return def;
    }

    inline int clamp_int(long long v, int lo, int hi)
    {
        return (int)std::clamp(v, (long long)lo, (long long)hi);
    }
} // namespace app::js
