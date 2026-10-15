# cell-app — the desktop shell + web service for cell.cpp

One agent runtime, one web UI, several ways to open it:

- **Desktop**: a native window (WebView2 / WebKitGTK / WKWebView) that loads
  the same page a browser gets, served by the built-in HTTP service.
- **Web service**: the UI and API exposed over HTTP, so a browser, a script
  or another tool can drive the same workspaces.
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
| `cell-app.cpp` | entry point: args, window, navigation, JS-bridge fallback, exit guard |
| `cell-app-core.hpp` | `app_core`: the **workspace registry** (`workspace_ctx` per directory: history + runner + turn worker + approvals + box state), config/vault, the **command bus** (`exec_command`) and the **event bus** (multi-sink fan-out; every event carries its `ws`) |
| `cell-app-http.hpp` | web service: `GET /` (UI), `POST /api/cmd/<name>`, `GET /api/state`, `GET /api/events` (SSE), `GET /api/themes` + `GET /api/theme/<name>` (theme system) |
| `ui/index.html` | **the UI — single file, the single source of truth** (vanilla JS + inline CSS, no CDN, no assets) |
| `scripts/gen_ui_header.py` | embeds `ui/index.html` into the generated `cell-ui.hpp` at build time |
| `cell-ui.hpp` | **generated** — do not edit by hand |
| `.cell/theme/<name>/` | third-party UI themes (`theme.json` + `theme.css`) under `<exe dir>/.cell/` — the same root as config/sessions/vault; discovered at runtime, see *Themes* below |
| `cell.cpp/cell.cpp` | the agent core — CLI, `cell::engine`, teamwork, notices, everything else |
| `third_party/include/` | vendored `webview.h` (MIT), `WebView2.h` (BSD-3), `servic.hpp` + `router/router.hpp` (patched, see below) |
| `build-gui.sh` | build script (regenerates `cell-ui.hpp` first) |

## Build

```bash
./build-gui.sh             # release build (per-platform defaults)
./build-gui.sh --shared    # Windows only: link against MSYS2 DLLs
./build-gui.sh --console   # Windows only: keep a console (debugging)
PYTHON=/path/to/python ./build-gui.sh   # pick the interpreter for the UI step
```

## Developing the UI without rebuilding

`ui/index.html` is served straight from disk when `--ui` is given, so the
loop is: edit the file, hit refresh in the browser. No compilation.

```bash
bin/cell-app.exe --headless 8787 --ui ui/index.html
# open http://127.0.0.1:8787/ , edit ui/index.html, refresh
```

The page also works standalone: open `ui/index.html` directly in a browser
(`file://`) and it boots in **demo mode** with synthetic data (two
workspaces, a streaming answer, a teamwork job with a gate, folded notices,
an approval prompt) — useful for design work with no backend at all.
`?mock=1` forces demo mode anywhere.

Regular builds call `scripts/gen_ui_header.py` to generate `cell-ui.hpp`;
if no python is found the committed header is used unchanged.

## Platform support

| platform | window backend | status | build notes |
|---|---|---|---|
| Windows 10/11 | WebView2 (Edge) | **verified** | MSYS2 UCRT64 g++; statically linked by default — zero third-party DLLs |
| Linux | GTK3 + WebKitGTK | code-complete, not yet tested on hardware | g++ (or clang++); install `gtk+-3.0` + `webkit2gtk-4.1` (fallback `4.0`) dev packages + `libsodium-dev` + `libcurl-dev` |
| macOS | Cocoa + WKWebView | code-complete, not yet tested on hardware | clang++; `brew install libsodium` (curl and the Cocoa/WebKit frameworks are system libraries) |

**Toolchain floor**: a C++23-capable compiler — GCC 14+ or Clang 17+. The
code uses `std::generator`, `std::expected` and `std::move_only_function`
but no C++26-only features, so `STD=-std=c++23 ./build-gui.sh` works on
compilers that predate `-std=c++26` (e.g. Apple clang).

**Dependency weight per platform**:
- *Windows*: zero third-party DLLs. TLS via SChannel — no CA bundle needed.
- *Linux*: the GTK/WebKitGTK stack only ships shared, so binaries depend on
  the distro packages; TLS via the distro's ca-certificates.
- *macOS*: system frameworks + system libcurl; only libsodium comes from
  Homebrew. TLS via the system keychain.

Vendored `servic.hpp` carries two small patches:
1. the per-connection `std::cout` line is removed (no console in the shell);
2. a failed socket write now throws instead of being swallowed, so an SSE
   handler can notice a disconnected client.

## HTTP API (for scripts and integrations)

| method | path | body / notes |
|---|---|---|
| GET | `/` | the single-page UI (or the `--ui` file) |
| POST | `/api/cmd/<name>` | JSON body = command args; JSON result |
| GET | `/api/state` | full snapshot of the active workspace (same as `cmd/state`) |
| GET | `/api/events` | SSE: one `data: {…}` line per agent event |
| OPTIONS | `/api/*` | CORS preflight (`Access-Control-Allow-Origin: *`, PNA allowed) |

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
```

Every event carries `"ws"`; the frontends route it to the right tab.

Example:

```bash
curl -X POST http://127.0.0.1:8787/api/cmd/workspace.open \
     -H "Content-Type: application/json" -d '{"cwd":"D:/work/project"}'

curl -X POST http://127.0.0.1:8787/api/cmd/send \
     -H "Content-Type: application/json" -d '{"ws":"<key>","text":"explain build-gui.sh"}'
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
  notices are pinned with a one-click *resume*; new notices animate in.
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
  level; everything maps to the same config the CLI writes.
- **Themes & motion** — the default **极简 (mono)** theme: pure black/white/gray
  surfaces, flat borders, no textures, with a single blue accent reserved for
  highlights (focus rings, links, selection, badges); a matching **极简 · 暗夜**
  dark variant ships alongside. Third-party themes live in the same `.cell`
  directory as config, sessions and the credential vault: drop a folder
  `<exe dir>/.cell/theme/<name>/` with a `theme.json` (`label` / `type` /
  `desc` / `swatch`) and a `theme.css` that redefines the design tokens, then
  pick it in *Settings → 外观* or via `/theme <name>` — no rebuild, no restart
  (the CSS is served with `no-store`). Icons are emoji throughout. Three
  animation levels and `prefers-reduced-motion` are respected. The repo ships
  a worked example at `bin/.cell/theme/warm-paper/` (warm paper neutrals +
  orange accent).

One command bus and one event stream feed every client: a desktop window and
any number of browser tabs can watch and drive the same workspaces, and an
approval answered in one client closes the dialog in the others.

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
bin/cell-app.exe --smoke          # window -> HTTP page -> first `state` command
bin/cell-app.exe --smoke-engine   # + one engine turn through the pipeline
bin/cell-app.exe --smoke-ws       # + two workspaces running turns in parallel
```
