# cell-app 桌面工作台命令（git.* / fs.* / term.*）

> 实现在 src/cell-app-tools.hpp，由 src/cell-app-core.hpp 的 exec_command 在
> 原有命令之后分发。契约来源：docs/ui-redesign.md 第 6 节。
> 前端面板（js/08b-panels.js）按本文件的 JSON 形状对接。

## 调用方式

所有命令都走现有的命令总线（桌面 WebView 与 HTTP 服务共用）：

- POST /api/cmd/<name>，body 为 JSON 对象（Content-Type: application/json）
- 返回 JSON 对象：{"ok":true, ...} 或 {"ok":false,"error":"..."}

请求的公共字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| ws   | string? | 工作区 key；缺省 = 活动工作区。未知 ws 返回 {"ok":false,"error":"unknown workspace: ..."} |
| cwd  | string? | 绝对目录；缺省 = 该工作区的 cwd。传 cwd 时可以在"尚未作为工作区打开"的目录上直接操作（Git/文件面板浏览用） |

响应里的绝对路径使用本机风格（Windows 反斜杠）；fs.* 返回的工作区内部路径使用
相对 cwd 的 generic 路径（正斜杠），可直接回传给 fs.* 命令。

## 命令表

### git.status {cwd?}

~~~
-> {ok, repo, root, branch, detached, ahead, behind, dirty_count,
    files:[{path,status,add,del,staged}],
    worktrees:[{path,branch,head,current,is_main,detached,locked,prunable}],
    is_main}
~~~

- repo: 主仓库目录名；root: 主 worktree 绝对路径（linked worktree 里也返回主仓库根）
- branch: 当前分支名；detached 时返回短 sha；detached: bool
- ahead/behind: 相对 upstream 的提交数（无 upstream 时为 0）
- files: 工作区变更，path 为仓库根相对路径；status 是单个字母
  （M/A/D/R/C，未跟踪与冲突都为 U）；add/del 为行数（二进制/未跟踪大文件为 0）；
  staged = 是否有已暂存部分
- worktrees: 与 git.worktrees 的条目相同；is_main = 当前目录是否主 worktree
- 不是 git 仓库时返回 {"ok":false,"error":"fatal: not a git repository ..."}

### git.worktrees {cwd?}

~~~
-> {ok, root, repo_name, current, worktrees:[{path,branch,head,current,is_main,detached,locked,prunable}]}
~~~

- root: 主 worktree 绝对路径；repo_name: root 的目录名
- current: 当前 worktree 的绝对路径
- 每个条目: path 绝对路径；branch 分支名（detached 时为空）；head 完整 40 位 sha；
  current/is_main/detached/locked/prunable 均为 bool

### git.worktree.add {cwd?, branch, base?, path?, create_branch?}

~~~
-> {ok, path, branch}
~~~

- branch 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$ 且不含 ".."、不以 ".lock" 结尾
- base: 新分支的起点（默认 HEAD），同样按分支名白名单校验
- path: 缺省 <主仓库根>/.worktrees/<branch 中的 '/' 换成 '-'>；相对路径按主仓库根解析；
  必须不存在；不允许落在 .git 内
- create_branch: 该分支不存在时默认 true（新建）；已存在时默认 false（挂到已有分支）。
  显式 create_branch=true 且分支已存在、或 false 且分支不存在，都返回错误
- 成功后往 <git-common-dir>/info/exclude 追加 ".worktrees/"（已有则不重复）

### git.worktree.remove {cwd?, path, force?}

~~~
-> {ok}
~~~

- path 必须是已注册的 worktree（相对路径按主仓库根解析）；主 worktree 拒绝移除
- force=true 时透传 git 的 --force（丢弃未提交改动）

### git.branches {cwd?}

~~~
-> {ok, current, local:[names]}
~~~

- current: 当前分支名（detached 时为空字符串）；local: 本地分支名列表（字典序）

### git.log {cwd?, limit?=5}

~~~
-> {ok, commits:[{hash,short,subject,author,time,rel}]}
~~~

- limit 取值 1..100
- hash: 完整 sha；short: 前 10 位；time: UTC ISO 8601（YYYY-MM-DDTHH:MM:SSZ）；
  rel: 中文相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前）
- 空仓库（还没有 commit）返回 {"ok":true,"commits":[]}

### git.numstat {cwd?}

~~~
-> {ok, files:[{path,add,del,binary}]}
~~~

- 相对 HEAD 的全部改动（暂存 + 未暂存）+ 未跟踪文件（add = 行数）
- path 为仓库根相对路径；binary: true 时 add/del 为 0

### git.diff {cwd?, path?, staged?}

~~~
-> {ok, diff, truncated, binary}
~~~

- 缺省为工作区 vs 暂存区（git diff）；staged=true 为暂存区 vs HEAD（git diff --cached）
- path: 仓库根相对或绝对路径，必须留在仓库内；缺省 = 整个 diff
- 未跟踪文件会合成一个 "new file" 的 unified diff（便于面板点击 U 条目查看内容）
- diff 上限 256 KiB（truncated:true）；二进制文件 binary:true

### git.init {cwd?}

~~~
-> {ok, root}
~~~

- 已是仓库：直接返回主 worktree 路径；否则在 cwd 执行 git init 并返回该目录

### fs.list {cwd?, path?=""}

~~~
-> {ok, path, entries:[{name,path,dir,size,mtime}], truncated}
~~~

- path 为 cwd 相对路径（"" = cwd 本身），绝对路径必须在 cwd 内
- entries 单层列表：目录优先，再按名称（不区分大小写）排序；path 为 cwd 相对 generic 路径
- size: 文件字节数（目录 0）；mtime: Unix 秒（last_write_time 换算）
- 最多 2000 条（truncated:true）

### fs.read {cwd?, path}

~~~
-> {ok, path, size, text, binary, truncated, lines}
~~~

- 上限 512 KiB / 5000 行；超过时截断并 truncated:true
- 含 NUL 字节视为二进制：binary:true、text:""、lines:0
- path 为 cwd 相对 generic 路径；size 为文件真实大小；lines 为返回文本的行数

### fs.find {cwd?, q, limit?=80}

~~~
-> {ok, files:[{name,path}]}
~~~

- 在 cwd 下递归找文件（跳过 .git node_modules build .cell .worktrees .cache dist out target
  __pycache__ .venv venv .idea .vscode .next .gradle）；有 rg 时用 rg --files，否则 std::filesystem
- q 为路径子串（不区分大小写，空串 = 列出前 limit 个文件）；最多扫描 3000 个文件
- limit 取值 1..500；path 为 cwd 相对 generic 路径

### term.open {cwd?, cols?=80, rows?=24, shell?, force?, ws?}

~~~
-> {ok, id, ws, cwd, shell, cols, rows, pid, alive, reused, seq, backlog}
~~~

- 启动（或复用）一个**真实终端会话**：常驻 shell 跑在伪终端上（Windows ConPTY /
  POSIX forkpty），Windows 缺省用 `%COMSPEC%`（cmd.exe），可用 `shell` 覆盖
- 同一 ws（未传 ws 时以 cwd 为键）已有存活会话且 force!=true 时**复用**，返回
  `reused:true` 与 `backlog`（最近 ≤512 KiB 原始输出字节的 base64，可为 ""）：
  页面刷新后靠它重放画面、接到同一个 shell。并发 open 同一个 ws 时注册表只保留一个
  shell，后到者拿到同一 id（被丢弃的候选进程会被关闭）
- `force:true` 表示强制换新 shell：旧会话先从注册表移除并关闭，它的订阅者会收到一条
  `term.exit (code 0)`；之后输入旧 id 返回 `unknown terminal session`
- cols 取值 2..1000（缺省 80；数字字符串也接受），rows 2..500（缺省 24）
- `ws` 与事件里的 `ws` 一致（cwd_key），前端据此路由

### term.input {id, data | text, ws?}

~~~
-> {ok}
~~~

- `data` = base64(原始字节)；`text` = 原始 UTF-8 字符串（调试用，二者取一）
- 一次调用可以是一整段按键序列：`"echo hi\r"`、`"\u0003"`(Ctrl+C)、
  `"\u001b[A"`(↑)、`"\u0009"`(Tab，交给 shell 做补全)
- 会话不存在返回 `{"ok":false,"error":"unknown terminal session"}`

### term.resize {id, cols, rows, ws?} → {ok, cols, rows}
### term.close {id?|ws?, ws?} → {ok, closed:true}
- 关闭是显式结束会话：其它仍连着该会话的客户端会收到一条 `term.exit (code 0)`；
  同一会话的 exit 事件最多一条（子进程自然退出与 close 竞争时不会重复）
### term.list {ws?} → {ok, sessions:[{id, ws, cwd, shell, cols, rows, pid, alive}]}

会话输出**不**通过命令响应返回，而是走既有事件流（`GET /api/events`，即
core.bus）：前端 `handleEvent` 把 `term.*` 交给 `window.CellTerm.onEvent`。

~~~
{"t":"term.out",  "ws":"<cwd_key>","id":"<sid>","seq":N,"d":"<base64 字节>"}
{"t":"term.exit", "ws":"<cwd_key>","id":"<sid>","code":N}
{"t":"term.error","ws":"<cwd_key>","id":"<sid>","error":"..."}
~~~

`d` 是原始字节的 base64，**不保证 UTF-8 边界完整**：前端必须流式解码
（`TextDecoder('utf-8',{stream:true})`），否则多字节字符/汉字会被截断。

### term.exec {cwd?, cmd, timeout_s?=120}

~~~
-> {ok, exit_code, output, stderr, duration_ms, truncated}
~~~

- 通过 cell::plat::spawn_cmd 执行（Windows 自动 cmd.exe /c，POSIX /bin/sh -c），
  超时整棵进程树被杀，exit_code = 124
- timeout_s 取值 1..600；duration_ms 为实际耗时
- output/stderr 各上限 256 KiB（truncated:true 表示任一被截断）
- 进程启动失败才返回 ok:false；命令非零退出仍是 ok:true，由 exit_code 表达

## 安全约定

- fs.*：路径先 canonical（跟随 symlink/junction）再做 cwd 前缀校验；".." 或绝对路径越界返回
  "path escapes the workspace: ..."
- git.*：分支名严格白名单；所有交给 shell 的参数都会加引号；git.diff 的 path 必须留在仓库内
- 所有子进程都有超时与进程树清理；输出有硬上限，事件流不会被超大输出拖死
- 这些命令只读为主；git.worktree.add/remove、git.init、term.exec 会写文件系统（文件面板/终端
  是用户显式操作），命令总线本身仍受 loopback Host/Origin 校验保护（同其它命令）
- term.open/input/resize/close 会启动并驱动一个**真实 shell 进程**（权限与用户终端相同）：
  仍只对 loopback + 同源客户端开放；应用退出时所有会话被统一关闭（`app::term::shutdown_all`）

## 示例

HTTP（curl，在仓库目录 D:/Developments/CXX/cell-app 上）：

~~~
curl -s -X POST http://127.0.0.1:8787/api/cmd/git.status \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app"}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/git.worktrees \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app"}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/git.log \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","limit":3}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/fs.list \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","path":"src"}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/fs.read \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","path":"docs/ui-redesign.md"}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/fs.find \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","q":"panel","limit":10}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/term.exec \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","cmd":"git status --short"}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/git.worktree.add \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","branch":"feat/demo","create_branch":true}'

curl -s -X POST http://127.0.0.1:8787/api/cmd/git.worktree.remove \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/Developments/CXX/cell-app","path":"D:/Developments/CXX/cell-app/.worktrees/feat-demo"}'
~~~

未打开工作区时也能用（传 cwd）：

~~~
curl -s -X POST http://127.0.0.1:8787/api/cmd/git.status \
     -H "Content-Type: application/json" -d '{"cwd":"D:/some/other/repo"}'
~~~

返回样例（git.status，节选）：

~~~
{"ok":true,"repo":"cell-app","root":"D:\\Developments\\CXX\\cell-app","branch":"main",
 "detached":false,"ahead":0,"behind":1,"dirty_count":2,"is_main":true,
 "files":[{"path":"README.md","status":"M","add":3,"del":1,"staged":false},
          {"path":"docs/new.md","status":"U","add":12,"del":0,"staged":false}],
 "worktrees":[{"path":"D:\\Developments\\CXX\\cell-app","branch":"main",
               "head":"1233c743ffc4f082178cf28347ae30b5af30714b","current":true,
               "is_main":true,"detached":false,"locked":false,"prunable":false}]}
~~~

## 错误约定

- 参数错误（缺 path/cmd/branch，分支名非法等）：{"ok":false,"error":"<说明>"}
- 不是 git 仓库：{"ok":false,"error":"fatal: not a git repository ..."}（前端显示非仓库态）
- 路径越界：{"ok":false,"error":"path escapes the workspace: ..."}
- git 失败：{"ok":false,"error":"<git stderr 首部，上限 2KB>"}
- 未知子命令：{"ok":false,"error":"unknown command: <name>"}
