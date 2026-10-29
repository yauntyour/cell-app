# cell-app UI 全面升级 · 设计规范与协作契约（v1）

> 目标：把 cell-app 的 WebUI 从「能用」提升到 DeepSeek Harness 级别的完成度：
> 视觉语言统一、层次清晰、交互顺手，并补齐 Git Worktree / 文件浏览 / 终端
> 等桌面工作台必备能力。界面文案中文，品牌与代码保持等宽小写英文。
>
> 参考图（只读）：
> - `_scratch/ref/dsh-gui.png` —— 目标风格（深色、分层表面、圆角卡片、蓝色强调、右侧「开始」面板）
> - `_scratch/ref/edited-files.png` —— 回合结束的「已编辑 N 个文件 +A -D」卡与用量行
> - `_scratch/shots/baseline.png` —— 改造前的现状截图
>
> 本文是协作契约：所有成员按 §8 的文件所有权写代码，按 §6/§7 的接口对接。

## 1. 原则

1. **一个视觉语言**：只用 §2 的令牌；不写死颜色/圆角/字号（第三方主题靠覆盖令牌换肤）。
2. **分层表面**：主画布最暗，侧栏/面板次之，卡片更亮，悬浮输入卡最亮；用 1px 极淡描边表达边界，不堆阴影。
3. **克制的色彩**：中性灰为底；强调色（靛蓝）只给「可交互 / 激活 / 发送」；语义色只给 diff、状态、终端。
4. **密度**：正文 14px、UI 标签 13px、元信息 11.5px；行高 1.6；信息流留白大于列表留白。
5. **原生、零依赖**：vanilla JS + 内联 SVG（ICON_PATHS），无 CDN / 无外部字体 / 无 emoji / 无框架。
6. **不丢功能**：现有工作区/会话/流式/Teamwork/通知/审批/设置/搜索/主题全部保留；键盘可达性与 reduced-motion 保留。
7. **可验证**：每个面板都要能在 `?mock=1` 演示模式下截图验收（见 §9）。

## 2. 设计令牌（css/00-tokens.css）

```css
:root{
  color-scheme: dark;
  /* surfaces */
  --bg:#111113; --bg2:#17171a; --bg3:#1c1c1f;
  --panel:#1b1b1d; --panel2:#202023;
  --raise:#26262a; --raise2:#2e2e33;
  --elev-1:#232324; --elev-2:#2a2a2d;
  --line:#26262a; --line2:#36363b;
  /* text */
  --fg:#f2f3f5; --fg2:#a8abb2; --fg3:#7b7e86; --fg4:#585b63;
  /* accent & semantics */
  --accent:#6c7cff; --accent-hi:#8a97ff; --accent-soft:rgba(108,124,255,.13);
  --link:#9aa6ff;
  --ok:#3fb950; --warn:#d29922; --bad:#f85149; --info:#58a6ff;
  --add:#3fb950; --del:#f85149;
  --code-bg:#1a1a1d;
  /* shape & type */
  --radius:14px; --radius-s:9px; --radius-lg:20px; --radius-xl:24px; --radius-full:999px;
  --sans:"Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,"Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif;
  --sans-display:"Segoe UI Variable Display","Segoe UI Variable Text","Segoe UI",system-ui,"Noto Sans SC","Microsoft YaHei",sans-serif;
  --mono:"Cascadia Code","Cascadia Mono",ui-monospace,"JetBrains Mono",Consolas,"Liberation Mono",monospace;
  --ease:cubic-bezier(.22,.7,.2,1); --dur:170ms;
  --shadow:0 16px 48px rgba(0,0,0,.55),0 1px 2px rgba(0,0,0,.5);
  --shadow-sm:0 1px 2px rgba(0,0,0,.45);
  --chat-max:880px; --composer-max:880px;
  --stream-pad:24px; --stream-gap:26px; --composer-h:156px;
}
```

兼容旧令牌（旧 CSS/第三方主题仍引用）：`--bg --bg2 --bg3 --panel --panel2 --raise --line --line2 --fg --fg2 --fg3 --link --accent --accent-soft --ok --run --bad --warn --user --assistant --tool --system --other --code-bg --line-soft --radius --radius-s --mono --sans --ease --dur --shadow --shadow-sm --stream-pad --stream-gap --chat-max --composer-max --composer-h`。新代码优先用新令牌；旧名字只在兼容处沿用。

**字号**：display 28px/600（仅空态标题）；h2 17px/600；section 12.5px/600；正文 14px/1.6；列表主行 13.5px；元信息 11.5px；等宽 12.5px。数字用 `font-variant-numeric:tabular-nums`。
**间距**：4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32。
**图标**：全部 `iconHtml(name)` / `iconEl(name)` + `.uico`（stroke 1.7，16/18/20px）。图标名见 `00-core.js` 的 ICON_PATHS；缺图标找 Lead 加。
**交互**：hover 用 `background:var(--raise)`，过渡 `var(--dur) var(--ease)`；focus-visible 统一 `outline:2px solid var(--accent-soft)` + `border-color:var(--accent)`；reduced-motion 时关动效。

## 3. 外壳布局（css/01-base.css、04-layout.css、index.html、02-render.js）

去掉顶部浏览器式导航条（`#navbar` 删除），改为 DSH 式三区：

```
#app (100vh)
└ #shell (flex)
  ├ #sidebar (默认 ~20vw，min 264px / max 440px，可拖拽)
  │  ├ .sb-head：logo + "cell" 字标 + PREVIEW 徽标
  │  ├ #btnNewSession（主按钮，整行「＋ 新会话」）
  │  ├ .sb-nav：会话搜索 / 工作区文件 / Git Worktree / 终端（图标+标签+右侧快捷键，hover 显示）
  │  ├ .sb-section：「工作区」标题行（筛选/新建图标）+ #sessionList（分组会话列表）
  │  └ .sb-foot：导航行（#navBack #navFwd #navRefresh #navHome + #navDock）+ 账户行（#btnSettings）
  ├ #rzSidebar（拖拽）
  └ #main
     ├ #banner（连接/演示模式横幅，保留）
     ├ #topbar：左侧 #tabbar（工作区标签）+ 右侧 #topActions（#btnTopSearch、#btnTopDock）
     ├ #workarea
     │  ├ #centre → #tabview（消息流）+ 悬浮 #composer（底部居中）
     │  ├ #rzDock
     │  └ #rightdock（默认 26vw，min 320 / max 560）：.dockhead（#dockTabs 图标页签 + #dockClose）+ #dockBody
     └ #reconnect
```

- 右栏页签：`start 开始 / files 文件 / git Git / terminal 终端 / teamwork 团队 / notices 通知 / archives 存档`，用 `<button class="docktab" data-dock="…">` 静态写在 skeleton 里（图标 + 文字，窄宽降级为纯图标）；`#dockBody` 由 `renderDock()` 按 `S.dock` 分发。
- 侧栏收起后，顶栏左上角常驻「展开侧栏」按钮（也可 Ctrl+B）；右栏默认打开 `start`（首次/无记忆时），开合与页签记在 localStorage `cell.dock`；`?dock=<name>` 可覆盖。
- 输入卡：宽度 `min(calc(100% - 56px), var(--composer-max))`，底部 22px，圆角 `--radius-xl`，表面 `--elev-2` + 1px `--line2` 描边；聚焦时描边 `--accent` + 外环 `--accent-soft`。
- 消息流列宽 `min(100% - 48px, var(--chat-max))` 居中；底部留白 `var(--composer-h) + 28px`。
- 响应式：<1100px 侧栏可降到 240px；<980px 右栏改为覆盖式且首次启动默认收起（宽->窄跨档时自动收起）；侧栏容器查询的阈值按 **content-box** 计（侧栏有 10px 内边距，264px 最小宽度对应 content 244px，阈值 224px），避免未最大化窗口被误判成窄态而隐藏全部文字标签。
- 拖拽分隔条机制沿用 `03-layout.js`（比例 + 像素护栏），只调默认值与上下限。

## 4. 组件规范（css/02-atoms.css、03-molecules.css）

**按钮**
- `.btn`：h 30、px 12、radius 9、1px `--line`、transparent、fg2；hover `--raise` + fg。
- `.btn.primary`：h 38、整宽、bg `--raise`、border `--line2`、fg、hover `--raise2`。
- `.btn.accent`：bg `--accent`、fg #fff、hover `--accent-hi`（发送/创建等唯一主操作）。
- `.btn.ghost`：无边框无底色、hover `--raise`。`.btn.sm` h 26 px 9 字号 12。
- `.icon-btn`：30×30、radius 8、fg3、hover `--raise`/fg、`.on` 用 accent 淡底。
- 侧栏导航项 `.sb-nav-item`：h 34、px 10、radius 9、gap 10，icon 16 fg3，label 13.5 fg2；hover `--raise`+fg；右侧 `.sb-kbd` 默认 opacity 0，hover 显示（11px、fg4）。
- 标签页 `.tab`：h 30、radius 9、px 10、gap 7，图标 14；选中 `--raise2` + fg；hover `--raise`；关闭钮 hover 才显示。
- 卡片 `.card`：`--elev-1` + 1px `--line` + radius 14；`.card-hover:hover` → `--elev-2`/border `--line2`。
- 快捷卡 `.quick-card`（右栏「开始」）：h 66、radius 14、px 14、gap 12；左侧 34×34 图标砖（radius 10，底色 = 主题色 12% 透明，图标 = 主题色）；标题 14.5/600、副标题 11.5 fg3、右侧 kbd；hover 上浮 1px + `--elev-2`（reduced-motion 关闭）。
- 快捷卡主题色：文件 `#e5b567`、Git `#f0883e`、终端 `#58a6ff`、搜索 `#a8abb2`。
- 页签 `.docktab`：h 30、px 9、radius 8、icon 15 + 12.5px 标签；选中 accent 淡底 + accent 字；hover `--raise`。
- 面板头 `.pnl-head`：h 40、px 14、底部 1px `--line`；标题 13/600，右侧 ghost 图标按钮。
- 输入控件：h 32、bg `--bg3`、1px `--line2`、radius 9、px 10；focus 边框 accent。
- 滚动条：10px、thumb `--line2` 圆角，hover `--fg4`。
- 徽标 `.badge`：h 18、px 6、radius 5、bg `--raise`、fg2、11px；`.badge.accent` 用 accent 淡底/accent。
- kbd：h 18、px 5、radius 5、border `--line`、bg `--bg2`、mono 10.5px、fg3。
- 工具类沿用：`.row .grow .dim .mut .small .tiny .trunc .uico .pulse` 等（旧 JS 大量使用，必须保留）。

**侧栏会话列表**：工作区分组头（folder 图标 + 目录 basename + 数量 + 悬浮操作：新会话/更多）；会话行（h 46、radius 9、px 9）：标题 13.5 单行省略；副行 11.5 fg3（相对时间 · N 条消息 · 分支/Worktree 徽标）；选中行 `--raise2`；运行中标题右侧 6px accent 呼吸点；未读 badge。分组折叠状态沿用 `S.groupsClosed` / localStorage。

**空态（hero）**：垂直居中，logo 40px（灰阶描边）+「构建未至之境」28px/600 + `预览版` 胶囊徽标；下方一行两个 chip：工作区（folder + 目录名 + chevron）、模式（shield + 当前沙箱模式 + chevron）；再下方为悬浮输入卡；无工作区时改为「打开一个工作区开始」+ 打开按钮。

**设置页**：整页浮层（top:0），左侧 220px 导航（外观 / 模型 / 供应商 / 代理 / 沙箱 / 上下文 / 性能 / 关于），右侧内容列 max 720 居中、卡片分节。
**弹窗 / 搜索 / 审批 / Toast**：居中卡片 `--panel2` + `--line2` + `--shadow`；搜索框顶部对齐（top 12vh）；Toast 右下角堆叠、`--panel2` + 左侧 2px 语义色条。

## 5. 新功能（验收口径）

### 5.1 右栏「开始」页
- 4 张快捷卡：工作区文件 `Ctrl+P`、Git Worktree `Ctrl+G`、新建终端 `Ctrl+反引号`、会话搜索 `Ctrl+Shift+F`；点击分别打开对应面板/弹窗。顶部居中一个大号 `compass` 水印图标（opacity .12）。
- 无打开工作区时卡片禁用并提示「先打开一个工作区」。

### 5.2 文件面板（files）
- 面包屑（仓库/目录层级，可点击回退）+ 刷新；单层列表：文件夹优先、名称、大小、修改时间；文件图标按扩展名着色（js/ts/html/css/json/md/py/cpp 等各一色，未知灰）。
- 单击文件夹进入；文件点击打开「文件预览」浮层（等宽行号、前 5000 行、.md 渲染 markdown、.json 格式化、二进制提示）；头部有路径、复制内容。
- `Ctrl+P` 全局快速打开：输入即搜（fs.find），↑↓ 选择、Enter 打开预览、Esc 关闭。
- 验收：mock 下可见目录/文件，预览正常，Ctrl+P 可键盘选择。

### 5.3 Git / Worktree 面板（git）
- 仓库头：分支图标 + 分支名 + 仓库 basename + ahead/behind 徽标 + 刷新；非仓库时显示「不是 Git 仓库」+「初始化仓库」。
- 「工作区变更」：文件列表（M/A/D/U 徽标色、+add/-del、点击看 diff）；空则「工作区干净」。
- 「Worktrees」：每行分支名 + 路径（相对仓库缩短）+ 当前/主仓库徽标 + 操作（打开为工作区 / 移除）；顶部「＋ 新建 Worktree」打开创建弹窗。
- 创建弹窗：分支名、基于分支（git.branches 下拉）、路径（默认 `<repo>/.worktrees/<branch>`，可改）、「创建新分支」开关、「创建后打开为工作区」开关；校验分支名（[A-Za-z0-9._/-]，不以 - 开头、不含 ..）。
- 最近提交：5 条（短 hash + subject + 相对时间）。
- 验收：mock 数据下能列出 worktrees、创建流程对话框可打开、点「打开」调用 workspace.open 并切到新工作区。

### 5.4 终端面板（terminal）—— 真实终端 · 多终端（2026-10 重做）
- **默认是空的**：面板打开时不自动起 shell，正文是「还没有终端 + 新建终端」空态；
  用户点按钮（或标题栏 `+`）才有第一个终端。
- 头部：`▣` + **终端下拉**（当前终端名 + 终端数量徽标 + caret；点开列出本工作区的
  所有终端，行内可切换、行尾 `■` 单独终止，底部一行「新建终端」）+ 当前工作区路径
  （trunc）+ 会话状态徽标（连接中/就绪/已退出(exit N)/不可用）+ `+` 新建 / 复制选中 /
  清屏 / 重启 / **终止**（`■`，danger）图标按钮；底部一行快捷键提示。
- 多终端：每个页签 = 一个后端会话（`term.open {new:true}`，各自一个读线程），互相
  独立运行；**切换只是 detach**——非当前终端的 `.ct-root` 从文档里摘掉，输出照常写进
  它自己的 VT 历史，切回来立刻整屏重绘（不重放 backlog、不重启 shell）。
  同名终端自动补序号（powershell 1 / powershell 2）。
- **终止**：头部 `■` 或下拉行尾 `■` → `term.close {id}`，后端关掉 pty 并 join 读线程
  （整棵进程树一起结束），页签消失、焦点落到相邻终端；关掉最后一个回到空态。
- 正文不再是「命令表单 + 执行按钮」，而是**真终端**：后端在伪终端（Windows ConPTY /
  POSIX forkpty）上跑常驻 shell，输出以 `term.out`（base64 字节）流式送到页面，
  由 `src/ui/src/js/08c-term.js` 的 VT 模拟器渲染（VT100/xterm 子集：CSI 光标/擦除/
  SGR 16+256+truecolor/滚动区/备用屏/DECSTCEM 等）。
- 交互：块状闪烁光标（DECTCEM 可隐藏、DECSCUSR 形状）、UTF-8 流式解码 + CJK 宽字符、
  ≥2000 行回看（Shift+PgUp/PgDn、滚轮）、Tab 发 0x09 交由 shell 补全、方向键 CSI/SS3、
  Home/End/PgUp/PgDn/Ins/Del/F1-F12、Ctrl+字母、Alt 前缀、Ctrl+Shift+C/V 复制粘贴
  （bracketed paste）、中文 IME（隐藏 textarea 承接 composition）。
- 生命周期：切页签/切工作区不重启 shell（终端按 ws 分组，别的 ws 的后台终端也在跑）；
  面板重绘（包括流式事件触发的 renderDock）就地更新头部、复用同一个 `.ct-root`，
  不重建终端本体，键盘焦点与选区不丢；页面刷新时先 `term.list` 把该 ws 仍在跑的
  shell 接管成页签，按 id `term.open {id}`（reused + backlog 重放，seq 去重）；
  面板宽度变化同步 `term.resize` 到 pty。首次挂载时右栏可能还没布局（宽度 0），终端
  等尺寸就绪后再测量格宽 / 启动 shell，第一帧就按真实 cols 渲染，不会出现 20 列硬折行。
- 演示模式（`?mock=1` / file://）：08c-term.js 自带本地假 shell（echo/ls/dir/cd/pwd/
  date/clear/color + Tab 补全 + ↑↓ 历史 + Ctrl+C），不依赖后端；多终端同样成立
  （每个页签一个假 shell），与真实终端共用完全相同的键盘/渲染路径。
- 验收：`_scratch/tmp/term-multi.py`（42 项：默认空 / 新建 / 切换 / 后台继续跑 /
  原地重绘保焦点 / 终止 / 回到空态），另有 `_scratch/term/*` 的后端与浏览器用例。

### 5.5 回合产物与用量（消息流）
- 每轮结束后：若本回合有文件改动，在消息流末尾（回合状态行之前）插入「已编辑 N 个文件」卡：头部 </> 图标砖 + 标题 + 汇总 +A -D；分隔线；每行文件名 + 右侧 +A -D（绿/红）；点击行打开 diff 预览（有 git.diff 时）。样式对齐 `_scratch/ref/edited-files.png`。
- 助手消息/回合尾部：用量行（用量 <tok> tok、时间 hh:mm；hover 显示输入/输出/缓存细分）+ 操作（复制、重试＝把该回合用户消息填回输入栏）。
- 数据来源：round 事件的 tok_in/tok_out/cache 聚合 + git.numstat 前后快照（见 §6）。

### 5.6 消息流重设计（详见 05-stream.css）
用户消息右对齐气泡（--raise2、radius 18、max-width 78%、14px）；助手消息无气泡、左侧 22px logo 头像 + 正文 14.5/1.75；工具调用为紧凑行卡（图标 + 中文名 + mono 名 + 状态点 + 耗时 + 展开）；思考过程折叠行；轮次条 11px fg3；通知/审批为卡内卡片。流式光标为 1px accent 竖条闪烁。

### 5.7 键盘
Ctrl+N 新会话、Ctrl+, 设置、Ctrl+Shift+F 会话搜索、Ctrl+P 快速打开文件、Ctrl+G Git 面板、Ctrl+反引号 终端面板、Ctrl+B 收起/展开侧栏、Esc 关闭浮层（优先级：搜索 > 通用弹窗 > 审批 > 斜杠/@ 提示面板 > 设置 > 预览 > 面板）。

### 5.8 交互反馈（2026-10 增补）

- **滚动跟底**：贴底阈值 28px；流式期间向上滚动/滚轮立即脱离自动跟底，显示「回到底部」悬浮按钮；新用户消息或点击按钮恢复贴底；回合结束的转录重载保留用户阅读位置。
- **等待阶段**：等待指示器改为「标题 + 副标题 + 秒表」，按 等待审批 → 正在推理 → 正在输出 → 正在执行 <工具中文名> → 最近 status → 等待模型响应（第 N 轮）→ 准备上下文 排序，busy 期间常驻。
- **Teamwork 刷新**：create/run/resume/stop 后立即刷新；tw 工具结束与 gate/job/stage/worker 进度 notice 都会防抖触发刷新；面板打开即拉取；刷新保持滚动位置与卡片展开状态。
- **子代理浮窗**：显示任务 works、状态/阶段/轮次/工具数、notice 进度时间线；首轮 transcript 未落盘时显示带秒表的等待卡；transcript 到达无缝替换；失败显示完整 job.error+最后进度并停止轮询。
- **tw 工具结果**：create/config 渲染为结构化「团队任务已创建」卡（阶段/子代理 works/模型/思考/gate/跳转面板），其他动作给紧凑摘要卡。

### 5.9 输入栏 @ 引用（文件 / 目录 / 会话）

输入行里出现「空白之后的 `@…`」时，斜杠面板换成为引用候选（同一个 `#slashPanel`，
↑↓/Tab/Enter/Esc 键位与斜杠面板一致，底部提示改为「←→ 翻页 · Tab Enter 插入」）。

候选分**两页**，面板表头就是页签（`文件` / `会话`，各带本页候选条数）：

- **翻页**：`←` `→` 或鼠标点页签。两页的选中行分开记（翻回来还停在原处）；
  点页签不会把焦点从输入框抢走，翻完页可以直接接着打字。默认落在文件页；
  这段片段还没手动翻过页时，文件页没有候选而会话页有，会自动跟随到会话页。
  输入框里不再是 `@…` 片段（打完文件/目录、清空）时两页状态复位；`Esc` 只收起面板，
  片段还在时按下一次键会重新弹在同一页。
- **文件页**：复用 ls 工具（`fs.list`）列一层目录，按输入片段模糊过滤；选目录 =
  把 `@dir/` 写回输入框并继续列出该目录（可一路下钻，表头右上角显示当前目录），
  选文件 = 写入 `@相对路径 ` 并收起面板（模型再用 fs 工具读内容）。
- **会话页**：空查询列最近会话（当前工作区在前、其余标注「其他工作区」）；有查询走
  `sessions.search`（rg 深度检索转录/存档/团队任务/通知）按内容命中，行内显示命中片段。
  路径形态的查询（含 `/`）默认不搜会话，省掉一次全库 rg；停在会话页时照搜。
- **空页**：候选为 0 时面板不收起，列一行灰字提示（「没有匹配的文件或目录」等），
  页签上的条数照旧，用户能一眼看出该换页还是该改查询。
- **选中会话**：调只读命令 `session.digest {ws?, id}` 取该会话的上下文摘要——优先用
  会话自己压缩出的摘要（compact 落盘的 assistant 摘要消息，老会话可能折叠在 system 块里），
  没有就现场摘录最近 10 轮（并保留会话开头的用户目标），不调模型、不改动被引用的会话。
  结果以内容块形式插入输入框：

  ````
  session:```
  会话「标题」· N 条消息 · 已有压缩摘要
  - 用户：…
  ```
  ````

  会话可以来自其他工作区（ws 由会话 id 反推），选中的是「当时那份上下文」的快照。
- 普通文本里的 `@`（如邮箱 `a@b.com`）不触发面板；team 模式（工作流编辑器）下同样不弹。
- 输入卡的**模型按钮只显示模型名**：状态里的 `model` 是核心 `model_label()` 的
  「供应商:模型」，供应商已经在底部状态行里写了，按钮再带上只会把名字挤成省略号；
  思考级别也不再塞进按钮，改为悬停 tooltip + 模型菜单里的「思考级别」一节。

## 6. 后端命令契约（src/cell-app-tools.hpp，T-core 实现）

所有命令沿用现有 `exec_command` 协议：入参 JSON、返回 `{"ok":true,...}` 或 `{"ok":false,"error":"..."}`，可选 `ws`（缺省=活动工作区）；以下命令还接受 `cwd`（绝对路径，缺省=该 ws 的 cwd，便于对未打开目录操作 git）。

```
git.status    {cwd?}  -> {ok, repo, root, branch, detached, ahead, behind, dirty_count,
                          files:[{path,status,add,del,staged}], worktrees:[…], is_main}
git.worktrees {cwd?}  -> {ok, root, repo_name, current, worktrees:[{path,branch,head,current,is_main,detached,locked,prunable}]}
git.worktree.add {cwd?, branch, base?, path?, create_branch?} -> {ok, path, branch}
git.worktree.remove {cwd?, path, force?} -> {ok}
git.branches  {cwd?}  -> {ok, current, local:[names]}
git.log       {cwd?, limit?=5} -> {ok, commits:[{hash,short,subject,author,time,rel}]}
git.numstat   {cwd?}  -> {ok, files:[{path,add,del,binary}]}
git.diff      {cwd?, path?, staged?} -> {ok, diff, truncated, binary}
git.init      {cwd?}  -> {ok, root}
fs.list       {cwd?, path?=""} -> {ok, path, entries:[{name,path,dir,size,mtime}], truncated}
fs.read       {cwd?, path} -> {ok, path, size, text, binary, truncated, lines}
fs.find       {cwd?, q, limit?=80} -> {ok, files:[{name,path}]}
term.exec     {cwd?, cmd, timeout_s?=120} -> {ok, exit_code, output, stderr, duration_ms, truncated}
term.open     {cwd?, cols?=80, rows?=24, shell?, force?, new?, id?, name?} -> {ok, id, ws, cwd, shell, name, cols, rows, pid, alive, reused, seq, backlog}
term.input    {id, data|text}         -> {ok}          # data = base64 字节
term.resize   {id, cols, rows}        -> {ok, cols, rows}
term.close    {id?|ws?}               -> {ok, closed}
term.list     {ws?}                   -> {ok, sessions:[{id, ws, cwd, shell, name, cols, rows, pid, alive}]}
# 事件（SSE /api/events）：term.out {ws,id,seq,d:base64} / term.exit {ws,id,code} / term.error {ws,id,error}
```

安全/实现约束：
- 全部路径限制在 cwd 内（fs.list/read/find 拒绝 .. 或绝对越界；resolve canonical 后前缀校验）。
- 命令拼接走 `cell::plat::spawn_cmd(cmdline, timeout, out, code, err, cwd)`（cell.cpp 已提供；Windows 自动 cmd.exe /c，POSIX /bin/sh -c）。
- git 参数白名单 + 引号转义：分支名 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$` 且不含 ..、不以 .lock 结尾；路径必须是合法子目录。
- worktree 默认路径 `<root>/.worktrees/<sanitize(branch)>`；成功后在 `<root>/.git/info/exclude` 追加 `.worktrees/`（不存在才加）。
- fs.find 用 `rg --files`（若可用）或 std::filesystem 遍历；跳过 .git node_modules build .cell .worktrees 等目录；限 3000 文件/80 结果。
- fs.read 上限 512KB / 5000 行；二进制（含 NUL）只回 binary:true。
- term.exec 输出上限 256KB（截断标记 truncated:true）；超时返回 exit_code 124。
- 编译接入：在 `src/cell-app-core.hpp` 的 `exec_command` 末尾（`unknown command` 之前）加 `if (auto r = tools::try_handle(name, args, this)) return *r;`（T-core 自己写这 2 行 + include；不要动别的分支）。
- 文档：`docs/api-tools.md` 写命令表与示例 curl（不写 README，Lead 收尾合并）。

## 7. 前端集成契约

### 7.1 稳定性要求
- 所有现有全局函数名/签名保留（其他模块会调用），尤其：
  `renderComposer/syncComposerInput/setComposerMode/sendCurrent/focusInput/autosize/buildSlash/renderChips`；
  `openSettings/closeSettings/toggleSettings/renderSettings`；
  `openSearch/closeSearch/searchOpen/showModal/closeModal/modalOpen/confirmDlg/openWsDialog/toast/renderApproval/approve`；
  `renderDockTeamwork/renderDockArchives/renderDockNotices/syncTwPoll/openWorkerWindow/showReport`；
  `renderChat/renderChatHead/renderPanes/loadSessionDetail/emptyState`。
- 只改自己拥有的文件（§8）；生成物 `src/ui/index.html`、`src/cell-ui.hpp` 只由 `python build_ui.py` 产出。
- 新 CSS 走新文件（按文件名排序追加在旧层之后），不要改别人的 CSS 文件。

### 7.2 面板注册（T-panels）
```js
// js/08b-panels.js（加载顺序在 08-mock.js 之后、09-boot.js 之前）
window.Panels = {
  names: ['files', 'git', 'terminal'],
  has(name),
  render(name, body, tab),   // 渲染进 #dockBody；body 每次 renderDock 时清空重建
  refresh(name),             // 面板可见时强制重拉
  init(),                    // boot 时调用一次
};
window.openFilePanel = () => openDock('files');
window.openGitPanel  = () => openDock('git');
window.openTerminal  = () => openDock('terminal');
window.openQuickOpen = null; // 由 T-panels 赋值
```
Lead 的 `renderDock()` 分发：`start` → 内置开始页；`Panels.has(name)` → `Panels.render`；其余走旧 `renderDockTeamwork/Notices/Archives`。boot 在 wireEvents 后调用 `Panels.init()`。

### 7.3 快照/演示（T-chat + T-panels）
- `08-mock.js`（T-chat）默认演示数据应展示「有内容的会话」：2 个工作区、当前会话含用户/助手/思考/工具/通知消息与一条流式回答；`?demo=empty` 才回到空态 hero；`?demo=stream` 停在流式中。
- 新面板 mock：T-panels 在 `08b-panels.js` 里包装 `Mock.api`（加 git.* fs.* term.* 分支），数据要真实（仓库 cell-app、分支 main、2 个 worktree、3 个变更文件、5 条提交、目录树、终端示例输出）。
- 截图 URL 约定：`file:///…/src/ui/index.html?mock=1&dock=start|files|git|terminal|teamwork|notices|archives`、`&demo=empty|stream`、`&settings=1`（Lead 的 boot 负责解析 dock/settings；demo 参数由 mock 处理）。

### 7.4 后端就绪前
T-panels 先按 §6 契约 + mock 开发；T-core 完成后联调（真实 `?mock=0` + `cell-app.exe --headless 8787 --ui src/ui/index.html`）。

## 8. 文件所有权（唯一写者）

| 成员 | 文件 |
|---|---|
| **lead** | `docs/ui-redesign.md`、`src/ui/src/index.html`、`css/00-tokens.css 01-base.css 02-atoms.css 03-molecules.css 04-layout.css 07-motion.css`、`js/00-core.js 02-render.js 03-layout.js 09-boot.js`、README.md（收尾） |
| **chat** | `js/02-render2-chat.js、css/05-stream.css、css/06-flow.css、css/06b-sidepanels.css（新）、js/03-teamwork.js、js/04-notices.js、js/08-mock.js` |
| **composer** | `js/05-composer.js、css/05b-composer.css（新）` |
| **settings** | `js/06-settings.js、js/07-overlays.js、css/06b-settings.css（新）、css/07b-overlays.css（新）` |
| **panels** | `js/08b-panels.js（新）、css/08-panels.css（新）` |
| **core** | `src/cell-app-tools.hpp（新）、src/cell-app-core.hpp（仅 dispatch 2~3 行 + include）、docs/api-tools.md（新）` |
| **verify** | `_scratch/tools/**、_scratch/shots/**`（只读源码） |

新文件会被 build_ui.py 自动按文件名排序拼装；不要手工改 `src/ui/index.html` / `src/cell-ui.hpp`。

## 9. 验证协议

1. UI 构建：`python build_ui.py --html`（exit 0；`--check` 校验生成物）。
2. 截图：T-verify 提供 `_scratch/tools/shot.mjs`（Edge headless + CDP）：
   `node _scratch/tools/shot.mjs --url <file://…> --out _scratch/shots/<name>.png [--wait 1200] [--eval "js"] [--w 1600 --h 1000]`。
   统一场景：hero、chat、files、git、terminal、teamwork、notices、settings、quickopen、approval、narrow(1180x820)。
3. C++：T-core 用 `cmake --build build`；完成后跑 `build/cell-app.exe --smoke` 与 `--headless 8787 --ui src/ui/index.html` 冒烟（curl /api/cmd/git.status）。T-verify 不并发编译（等 core 完成）。
4. 视觉验收：Lead 按参考图检查层级/留白/字号/色彩；截图归档 `_scratch/shots/`。
5. 功能验收：mock 面板可交互；真实后端命令有返回；快捷键不冲突；prefers-reduced-motion 下不抖。

## 10. 协作纪律

- 只改所有权内的文件；要动别人的文件先发消息给 Lead。
- 小步前进：先保证 `python build_ui.py --html` 通过；页面 JS 报错会让整个 mock 白屏。
- 不引入依赖、不改 CMake/构建脚本、不跑 git checkout/reset/clean、不提交 commit。
- 完成/受阻时向 Lead 报告：任务 id、改了哪些文件、自测命令与结果、剩余风险、需要谁配合。