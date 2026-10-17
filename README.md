# cell-app — the desktop shell + web service for cell.cpp

One agent runtime, one web UI, several ways to open it:

- **Desktop**: a native window (WebView2 / WebKitGTK / WKWebView) that loads
  the same page a browser gets, served by the built-in HTTP service.
- **Web service**: the UI and API exposed over HTTP on `127.0.0.1` only, so a
  browser, a script or another tool on the same machine can drive the same
  workspaces. Requests must be loopback and same-origin (Host + Origin checks,
  no CORS); there is no LAN/remote access, because the agent has full-access
  tools.
- **Multiple workspaces in parallel**: every working directory gets its own
  engine context (history, turn worker, approvals). Different directories run
  agent turns truly in parallel; within one directory there is exactly one
  working session at a time (use Teamwork to parallelise inside a directory).

```
cell-app.exe                    the desktop app (auto-serves its UI on a free port)
cell-app.exe --serve [PORT]     desktop app + explicit service port (default 8787)
cell-app.exe --headless [PORT]  HTTP service only, no window
cell-app.exe --ui FILE          serve the UI page from disk (dev mode, see below)
```

## Layout

| file | role |
|---|---|
| `CMakeLists.txt` | cross-platform build (regenerates the embedded UI first) — artifacts land in `build/` |
| `src/cell-app.cpp` | entry point: args, window, navigation, JS-bridge fallback, exit guard |
| `src/cell-app-core.hpp` | `app_core`: the **workspace registry** (`workspace_ctx` per directory: history + runner + turn worker + approvals + box state), config/vault, the **command bus** (`exec_command`) and the **event bus** (multi-sink fan-out; every event carries its `ws`) |
| `src/cell-app-http.hpp` | web service: `GET /` (UI), `POST /api/cmd/<name>`, `GET /api/state`, `GET /api/events` (SSE), `GET /api/themes` + `GET /api/theme/<name>` (theme system) |
| `src/ui/src/` | the UI sources: an `index.html` skeleton + `css/*.css` and `js/*.js` layers (vanilla JS + inline CSS, no CDN, no assets) |
| `src/ui/index.html` | **generated** — the assembled page, the `--ui` dev-loop artifact |
| `build_ui.py` | assembles `src/ui/src/` into `src/ui/index.html` and embeds it as `src/cell-ui.hpp` |
| `src/cell-ui.hpp` | **generated** — do not edit by hand |
| `assets/` | app icon: `icon.svg` source, `icon.ico`, `icon.rc` (embedded into the exe on Windows) |
| `.cell/theme/<name>/` | third-party UI themes (`theme.json` + `theme.css`) under `<exe dir>/.cell/` — the same root as config/sessions/vault; discovered at runtime, see *Themes* below |
| `cell.cpp/cell.cpp` | the agent core — CLI, `cell::engine`, teamwork, notices, everything else |
| `third_party/include/` | vendored `webview.h` (MIT), `WebView2.h` (BSD-3), `servic.hpp` + `router/router.hpp` (patched, see below) |

## Build

```bash
cmake -B build            # configure (Ninja or Makefiles)
cmake --build build       # → build/cell-app[.exe]
```

On Windows, run CMake from the MSYS2 UCRT64 shell (or point it at the
toolchain: `-DCMAKE_CXX_COMPILER=D:/x64/msys2/ucrt64/bin/g++.exe`). Before
compiling, the build regenerates the embedded UI (`src/ui/src/` →
`src/cell-ui.hpp`) and drops the executable into `build/`.

```bash
cmake -B build -DCELL_STATIC=OFF        # Windows: link against MSYS2 DLLs
cmake -B build -DCELL_CONSOLE=ON        # Windows: keep a console (debugging)
cmake -B build -DCELL_CXX_STANDARD=23   # compilers without -std=c++26
cmake -B build -DPython3_EXECUTABLE=/path/to/python   # interpreter for the UI step
```

## Developing the UI without rebuilding

`src/ui/index.html` is the assembled page and is served straight from disk
when `--ui` is given, so the loop is: edit `src/ui/src/`, rebuild the page,
hit refresh in the browser. No C++ compilation.

```bash
build/cell-app.exe --headless 8787 --ui src/ui/index.html
# open http://127.0.0.1:8787/ , edit src/ui/src/, run `python build_ui.py --html`, refresh
```

The page also works standalone: open `src/ui/index.html` directly in a browser
(`file://`) and it boots in **demo mode** with synthetic data (two
workspaces, a streaming answer, a teamwork job with a gate, folded notices,
an approval prompt) — useful for design work with no backend at all.
`?mock=1` forces demo mode anywhere.

The CMake build runs `build_ui.py` before compiling and only rewrites an
output when its content changed; with `-DCELL_BUILD_UI=OFF` (or no Python
found) the committed `src/cell-ui.hpp` is used unchanged.

## Platform support

| platform | window backend | status | build notes |
|---|---|---|---|
| Windows 10/11 | WebView2 (Edge) | **verified** | MSYS2 UCRT64 g++; statically linked by default — zero third-party DLLs |
| Linux | GTK3 + WebKitGTK | code-complete, not yet tested on hardware | g++ (or clang++); install `gtk+-3.0` + `webkit2gtk-4.1` (fallback `4.0`) dev packages + `libsodium-dev` + `libcurl-dev` |
| macOS | Cocoa + WKWebView | code-complete, not yet tested on hardware | Homebrew LLVM clang++ + static libsodium — libc++ lacks `<generator>` and `std::move_only_function`, so `third_party/compat` backfills both; curl and the Cocoa/WebKit frameworks are system libraries |

**Toolchain floor**: a C++23-capable compiler — GCC 14+ or Clang 17+. The
code uses `std::generator`, `std::expected` and `std::move_only_function`
but no C++26-only features, so `cmake -B build -DCELL_CXX_STANDARD=23`
works on compilers that predate `-std=c++26`. The standard library is the
real gate: libc++ — Apple's and Homebrew LLVM's alike — implements neither
`std::generator` nor `std::move_only_function`, so macOS builds pair
Homebrew LLVM clang++ (needed to parse the Apple SDK headers under
`-std=c++26`) with the `third_party/compat` shims.

**Dependency weight per platform**:
- *Windows*: zero third-party DLLs. TLS via SChannel — no CA bundle needed.
- *Linux*: the GTK/WebKitGTK stack only ships shared, so binaries depend on
  the distro packages; TLS via the distro's ca-certificates.
- *macOS*: system frameworks + system libcurl; only libsodium comes from
  Homebrew. TLS via the system keychain.

Vendored `servic.hpp` carries these patches:
1. query strings are stripped from the routed path (the page reads
   `?theme=` / `?dock=` / `?mock=1` itself);
2. a failed socket write throws instead of being swallowed, so an SSE handler
   can notice a disconnected client;
3. requests run on dedicated, bounded worker threads instead of the io_context
   threads, so a long command or a long-lived SSE stream cannot starve
   accept/read (the desktop shell and every browser tab stay responsive);
4. the listen endpoint is explicit and the shell binds `127.0.0.1` only;
5. the request head is bounded (64 KiB), `Content-Length` is parsed
   case-insensitively and validated, `Transfer-Encoding: chunked` is rejected
   with `411`, and `Expect: 100-continue` is honoured.

## HTTP API (for scripts and integrations)

The service binds `127.0.0.1` only. Every request must carry a loopback
`Host` header (`127.0.0.1:PORT`, `localhost:PORT`) and be same-origin: an
`Origin` from another site, or `Sec-Fetch-Site: cross-site`, is refused with
`403` (request methods are enforced too — anything but the listed one gets
`405`). There is no CORS at all: the page is always served from this same
origin, so no other website can reach the API even from the user's browser.

| method | path | body / notes |
|---|---|---|
| GET | `/` | the single-page UI (or the `--ui` file) |
| POST | `/api/cmd/<name>` | JSON body = command args; JSON result |
| GET | `/api/state` | full snapshot of the active workspace (same as `cmd/state`) |
| GET | `/api/events` | SSE: one `data: {…}` line per agent event |
| — | other methods | `405 Method Not Allowed`; `OPTIONS` is refused as well (no CORS) |

Commands (all return `{"ok":true,...}` or `{"ok":false,"error":"..."}`).
Every command accepts an optional `"ws"` (workspace key); omitted = the
active workspace:

```
workspace.open {cwd}                workspace.close {ws}
workspace.activate {ws}             workspace.list {}

send {ws?, text}                    stop {ws?}
approve {ws?, id, allow}            state {ws?}

settings.get {}                     settings.set {patch}
providers.add {api_style, base, name?, key?, proxy?}
providers.rm {name}                 providers.select {name}
provider.set_key {name, key}        models.fetch {}
model.set {model}

sessions.list {}                    session.select {ws?, id}
session.new {ws?}

teamwork.list {ws?}                 teamwork.report {ws?, job, worker}
teamwork.worker {ws?, job, worker, since?}
teamwork.create {ws?, workflow|list, ...}
teamwork.run {ws?, id}              teamwork.resume {ws?, id}
teamwork.stop {ws?, id}

upload {ws?, name, data_b64}        notice.list {ws?}
notice.clear {ws?}                  notice.send {ws?, session?, body, from?, topic?}
```

`notice.send` delivers a notice to another session. `session` is a handle
resolved against every known session: exact id, unique id prefix, 16-hex
workspace key (→ that group's newest session), a workspace directory path,
`reply`/`@` (→ the newest notice sender that can be answered), or empty
(the caller's own session). The sender is recorded and receivers answer
with the same `reply` handle. A session folder is materialized when the
session becomes live, so a session that has not saved a transcript yet
(fresh GUI workspace, running CLI) is discoverable too — the `session`
field on notice.list rows / SSE notice events is that reply address.

Every event carries `"ws"`; the frontends route it to the right tab.

Example:

```bash
curl -X POST http://127.0.0.1:8787/api/cmd/workspace.open \
     -H "Content-Type: application/json" -d '{"cwd":"D:/work/project"}'

curl -X POST http://127.0.0.1:8787/api/cmd/send \
     -H "Content-Type: application/json" -d '{"ws":"<key>","text":"explain CMakeLists.txt"}'
```

## The UI

- **Workspaces as tabs** — one tab per open directory; tabs show a busy
  pulse and unread badges. Background tabs keep accumulating events.
- **Sessions sidebar** — sessions grouped by workspace, titled by their
  first user message, with relative time and message counts; click to
  switch (the backend opens the directory on demand).
- **Chat** — streaming answers, reasoning blocks, tool cards (policy,
  duration, expandable output), per-round token/timing stats, inline
  approvals with a ws badge.
- **Teamwork** — a live SVG flow chart per job (serial/parallel stages, gate
  diamonds, active-stage glow, animated edges), draggable worker windows
  streaming a child's transcript, run/stop/resume controls, and reports.
- **Notices** — folded notice cards grouped by sender+topic+path; gate/job
  notices are pinned with a one-click *resume*; new notices animate in. The
  panel sends cross-session notices (target handle + body) and every card
  from another session shows a `→ <session>` reply address with an inline
  reply row. An idle session sees notices the moment they land: a backend
  watcher broadcasts them over SSE (~0.7s cadence) without consuming the
  turn-drain pipeline.
- **Composer** — three modes: text, attachments (drag/paste/upload, stored
  under the workspace `.cell/uploads/`), and a structured Teamwork workflow
  builder (stages, gates, per-agent model/thinking) with a "let the LLM
  plan it" path.
- **Slash commands** — `/` opens a fuzzy palette with descriptions and
  context-aware argument hints (sessions of the current workspace, models,
  providers, sandbox modes, jobs, …): `/new /session /model /provider
  /think /tools /sandbox /autoallow /compact /stop /teamwork /notice
  /workspace /theme /help`.
- **Settings page** — providers, model, agent (thinking/tools/system
  prompt), sandbox, compaction, performance limits, theme and animation
  level; everything maps to the same config the CLI writes. Provider/model/
  agent changes are refused while a turn is running (the engine reads that
  config on its worker thread); retry when it finishes. Teamwork jobs are
  unaffected: each job runs on its own snapshot of the settings.
- **Themes & motion** — the built-in look is locked to a **black/white/gray
  dark** palette: neutral gray surfaces, flat borders, no textures, no colored
  accent (highlights, links, badges and role dots are all grays, with links
  underlined), tuned to cut blue light. Icons are single-color inline SVG
  throughout (no emoji). Third-party themes live in the same `.cell`
  directory as config, sessions and the credential vault: drop a folder
  `<exe dir>/.cell/theme/<name>/` with a `theme.json` (`label` / `type` /
  `desc` / `swatch`) and a `theme.css` that redefines the design tokens, then
  pick it in *Settings → 外观* or via `/theme <name>` — no rebuild, no restart
  (the CSS is served with `no-store`). Three
  animation levels and `prefers-reduced-motion` are respected.

One command bus and one event stream feed every client: a desktop window and
several browser tabs can watch and drive the same workspaces, and an approval
answered in one client closes the dialog in the others. Every request (SSE
streams included) runs on its own worker thread, so a long command or several
open tabs can no longer starve the service's accept/read side.

## Cross-session file claims

Concurrent workspaces must not interleave edits of the same file. The engine
enforces *first come, first served*: the first session whose writing tools
touch a file claims it; another session's `write`/`edit` on that file is
refused with a clear message ("occupied by another session …"). Reads never
claim and are never refused, and a session's own teamwork children cooperate
rather than conflict. Claims are released automatically when the owning
agent loop ends (turn end / job end), whatever the exit path.

## Smoke tests (no provider needed, isolated data root)

```bash
build/cell-app.exe --smoke          # window -> HTTP page -> first `state` command
build/cell-app.exe --smoke-engine   # + one engine turn through the pipeline
build/cell-app.exe --smoke-ws       # + two workspaces running turns in parallel
```

## Releases (prebuilt single files)

`.github/workflows/cmake-multi-platform.yml` builds the single-file
executable on all three platforms and publishes it as a GitHub Release:

- **push a commit whose message is exactly `release`** (first line), or
- **run the workflow manually** from the *Actions* tab (*Run workflow*).

| artifact | platform | runtime requirements |
|---|---|---|
| `cell-app-windows-x64.exe` | Windows 10/11 x64 | none — statically linked; the WebView2 runtime ships with Edge |
| `cell-app-linux-x86_64` | Linux x86_64 | the distro GTK3 + WebKitGTK 4.1 stack, `libcurl4`, `libsodium23` |
| `cell-app-macos-arm64` | macOS (Apple silicon) | none — system frameworks + system libcurl; libsodium is linked in |

Every run is validated before anything is uploaded: the Linux binary is
smoke-tested under `xvfb` (window → HTTP page → the first `state` command),
the Windows import table is checked for stray DLLs, and the macOS link is
checked for Homebrew libraries. The macOS build uses Homebrew LLVM clang++
(Homebrew GCC cannot parse the Apple SDK headers) with `third_party/compat`
backfilling the two C++23 pieces libc++ lacks; Windows and Linux use
GCC 14+ either way.
