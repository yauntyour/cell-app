/* =====================================================================
   08b · 桌面工作台面板：文件 / Git Worktree / 终端
         + 文件预览浮层 + Ctrl+P 快速打开 + git diff 浮层

   设计规范见 docs/ui-redesign.md §5.1~§5.4 / §6 / §7.2：
     · window.Panels 注册表（files / git / terminal），由外壳 renderDock() 分发；
     · 只改本文件与 css/08-panels.css，不碰别人的文件与生成物；
     · 后端命令契约（core-git）：git.status / git.worktrees / git.worktree.add /
       git.worktree.remove / git.branches / git.log / git.numstat / git.diff /
       git.init、fs.list / fs.read / fs.find、term.exec；
     · 演示模式（?mock=1）下包装 Mock.api 提供上述命令的示例数据。

   跨模块钩子（给「回合已编辑 N 个文件」卡用）：
     window.showFilePreview(path, opts)  —— 打开文件预览浮层
     window.openDiffPreview(path, opts)  —— 打开 git diff 浮层
   两者都按 Esc 关闭（优先级低于搜索 / 通用弹窗 / 审批 / 设置）。
   ===================================================================== */
'use strict';

/* ---------- 1. 小工具（统一 pnl 前缀，避免与其它层撞名） ------------ */

function pnlEl(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = String(txt);
  return n;
}

function pnlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function pnlIcon(name, cls) {
  try {
    if (typeof iconHtml === 'function') return iconHtml(name, cls);
  } catch (e) {}
  return '';
}

function pnlIconEl(name, cls) {
  var w = pnlEl('span', 'pnl-ico-wrap');
  w.innerHTML = pnlIcon(name, cls);
  return w;
}

function pnlBase(p) {
  if (p == null) return '';
  var s = String(p).replace(/[\\/]+$/, '');
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function pnlFmtSize(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '';
  n = Number(n);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function pnlRelTime(sec) {
  if (!sec) return '';
  try { if (typeof relTime === 'function') return relTime(Number(sec)); } catch (e) {}
  var d = Math.floor(Date.now() / 1000) - Number(sec);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

function pnlDur(ms) {
  var n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  if (n < 1000) return Math.round(n) + ' ms';
  return (n / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' s';
}

// 路径归一化：只用于比较 / 截短，不用于拼接
function pnlNorm(p) {
  return String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function pnlSepFor(root) {
  return String(root || '').indexOf('\\') >= 0 ? '\\' : '/';
}

function pnlRelPath(full, root) {
  var f = String(full || '');
  var r = String(root || '');
  if (!f) return '';
  if (!r) return f;
  var nf = pnlNorm(f), nr = pnlNorm(r);
  if (nf === nr) return '.';
  if (nf.indexOf(nr + '\\') === 0) return f.slice(r.replace(/[\\/]+$/, '').length + 1);
  return f;
}

// 预览标题：工作区内显示相对路径，工作区外保留完整路径
function pnlDisplayPath(path, cwd) {
  var p = String(path || '');
  var c = String(cwd || '');
  if (!c) return p;
  return pnlRelPath(p, c);
}

function pnlExt(name) {
  var b = pnlBase(name);
  var i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

var PNL_KIND_MAP = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  py: 'py', pyw: 'py',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'cpp', c: 'cpp', hxx: 'cpp',
  go: 'go', rs: 'rs', java: 'java', kt: 'java', rb: 'rb', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh',
  yml: 'yml', yaml: 'yml', toml: 'yml', ini: 'yml', conf: 'yml', env: 'yml',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img',
  ico: 'img', bmp: 'img', avif: 'img',
  lock: 'lock', gitignore: 'txt', txt: 'txt', log: 'txt', csv: 'txt'
};

var PNL_BIN_EXT = {
  exe: 1, dll: 1, so: 1, dylib: 1, bin: 1, obj: 1, lib: 1, pdb: 1, zip: 1,
  '7z': 1, tar: 1, gz: 1, rar: 1, pdf: 1, png: 1, jpg: 1, jpeg: 1, gif: 1,
  webp: 1, ico: 1, bmp: 1, avif: 1, woff: 1, woff2: 1, ttf: 1, otf: 1, eot: 1,
  mp3: 1, mp4: 1, wav: 1, ogg: 1, webm: 1, sqlite: 1, db: 1
};

function pnlKindOf(name) {
  return PNL_KIND_MAP[pnlExt(name)] || 'other';
}

function pnlColorClass(name) {
  var k = pnlKindOf(name);
  return k === 'other' ? 'fi-other' : 'fi-' + k;
}

function pnlIsBinaryName(name) {
  return !!PNL_BIN_EXT[pnlExt(name)];
}

function pnlStripAnsi(s) {
  return String(s == null ? '' : s).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

// 面板命令的公共参数：ws + 活动工作区 cwd（§6：cwd 缺省 = 该 ws 的 cwd）
function pnlCtx(tab) {
  var cwd = '';
  try {
    if (typeof S !== 'undefined' && S.active && typeof cwdOf === 'function') cwd = cwdOf(S.active) || '';
  } catch (e) {}
  if (!cwd && tab && tab.cwd) cwd = tab.cwd;
  if (!cwd) {
    try {
      var w = ((typeof S !== 'undefined' && S.workspaces) || []).filter(function (x) { return x.ws === S.active; })[0];
      if (w && w.cwd) cwd = w.cwd;
    } catch (e) {}
  }
  var ws = '';
  try { ws = (typeof S !== 'undefined' && S.active) || ''; } catch (e) {}
  return { ws: ws, cwd: String(cwd || '') };
}

function pnlArgs(extra) {
  var ctx = pnlCtx();
  var a = { ws: ctx.ws };
  if (ctx.cwd) a.cwd = ctx.cwd;
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
  return a;
}

// 面板内统一调用：失败不弹全局 toast（面板自己显示），返回 {ok:false,error}
async function pnlApi(name, args) {
  try {
    if (typeof api !== 'function') return { ok: false, error: 'api 不可用' };
    var out = await api(name, args || {});
    if (out == null) return { ok: false, error: '空响应' };
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e || '命令执行失败') };
  }
}

function pnlToast(msg, kind) {
  try { if (typeof toast === 'function') { toast(msg, kind || 'ok'); return; } } catch (e) {}
  if (kind === 'bad' && window.console) console.warn('[panels] ' + msg);
}

var PNL = {
  cwd: '',
  inited: false,
  files: { path: '', stack: [], data: null, err: '', loading: false, loadedCwd: '' },
  git: { status: null, worktrees: [], commits: [], err: '', loading: false, nonRepo: false, loadedCwd: '', root: '', repoName: '' },
  // 终端：items 是跨工作区共享的终端列表（每个 item 绑定一个 CellTerm view
  // = 一个独立后端会话）；active 记每个工作区当前选中的终端；attached 是
  // 此刻挂在文档里的那个 view（其余 detach 在后台继续跑）。
  term: { seq: 0, items: [], active: {}, listed: {}, attached: null, ui: null }
};

function pnlResetCwd(cwd) {
  PNL.cwd = cwd;
  PNL.files = { path: '', stack: [], data: null, err: '', loading: false, loadedCwd: '' };
  PNL.git = { status: null, worktrees: [], commits: [], err: '', loading: false, nonRepo: false, loadedCwd: '', root: '', repoName: '' };
}

// 让面板铺满 #dockBody：dockBody 自带内边距时用负边距抵消（新旧外壳 CSS 都成立）
function pnlFit(wrap, body) {
  if (!wrap || !body) return;
  try {
    var cs = window.getComputedStyle(body);
    var pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    var pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    if (pt || pb || pl || pr) {
      wrap.style.margin = (-pt) + 'px ' + (-pr) + 'px ' + (-pb) + 'px ' + (-pl) + 'px';
      wrap.style.height = 'calc(100% + ' + (pt + pb) + 'px)';
      wrap.style.width = 'calc(100% + ' + (pl + pr) + 'px)';
    }
  } catch (e) {}
}

function pnlIconBtn(icon, title, fn, cls) {
  var b = pnlEl('button', 'icon-btn ' + (cls || ''));
  b.type = 'button';
  b.title = title || '';
  b.setAttribute('aria-label', title || icon);
  b.innerHTML = pnlIcon(icon);
  b.onclick = fn;
  return b;
}

function pnlEmptyBox(icon, title, desc, actionLabel, actionFn) {
  var box = pnlEl('div', 'pnl-empty');
  var ic = pnlEl('div', 'pnl-empty-ico');
  ic.innerHTML = pnlIcon(icon);
  box.appendChild(ic);
  box.appendChild(pnlEl('div', 'pnl-empty-title', title));
  if (desc) box.appendChild(pnlEl('div', 'pnl-empty-desc', desc));
  if (actionLabel && actionFn) {
    var b = pnlEl('button', 'btn sm', actionLabel);
    b.type = 'button';
    b.onclick = actionFn;
    box.appendChild(b);
  }
  return box;
}

function pnlLoading(text) {
  var box = pnlEl('div', 'pnl-loading');
  box.appendChild(pnlEl('span', 'pnl-spin'));
  box.appendChild(pnlEl('span', null, text || '正在加载…'));
  return box;
}

function pnlErrorBox(msg, retry) {
  var box = pnlEl('div', 'pnl-error');
  var ic = pnlEl('span', 'pnl-error-ico');
  ic.innerHTML = pnlIcon('alert');
  box.appendChild(ic);
  box.appendChild(pnlEl('div', 'pnl-error-txt', msg || '加载失败'));
  if (retry) {
    var b = pnlEl('button', 'btn sm', '重试');
    b.type = 'button';
    b.onclick = retry;
    box.appendChild(b);
  }
  return box;
}

function pnlCopy(text, okMsg) {
  var s = String(text == null ? '' : text);
  var done = function () { pnlToast(okMsg || '已复制到剪贴板', 'ok'); };
  var fallback = function () {
    try {
      var ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      if (ok) done(); else pnlToast('复制失败（当前环境不允许写入剪贴板）', 'bad');
    } catch (e) {
      pnlToast('复制失败：' + ((e && e.message) || e), 'bad');
    }
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, fallback);
      return;
    }
  } catch (e) {}
  fallback();
}

/* =====================================================================
   2. 演示数据：包装 Mock.api（git.* / fs.* / term.*）
   ---------------------------------------------------------------------
   数据要经得起看：真实仓库 cell-app、main 分支、2 个 worktree、
   3 个变更文件、5 条提交、目录树、终端示例输出。
   ===================================================================== */

var PMOCK_ROOT = (typeof Mock !== 'undefined' && Mock && Mock.cwdA)
  ? String(Mock.cwdA)
  : 'D:\\Developments\\CXX\\cell-app';

var PMOCK_WORKTREES = [
  {
    path: PMOCK_ROOT, branch: 'main', head: 'a1b2c3d',
    current: true, is_main: true, detached: false, locked: false, prunable: false
  },
  {
    path: PMOCK_ROOT + '\\.worktrees\\feat-ui', branch: 'feat/ui-redesign', head: '9f8e7d6',
    current: false, is_main: false, detached: false, locked: false, prunable: false
  }
];

var PMOCK_BRANCHES = ['main', 'feat/ui-redesign', 'fix/dock-resize', 'docs/redesign', 'chore/build-ui'];

// [相对路径, 字节数, 距离现在的秒数]
var PMOCK_FILES = [
  ['CMakeLists.txt', 4218, 7200],
  ['README.md', 8260, 172800],
  ['build_ui.py', 3180, 86400],
  ['.gitignore', 86, 604800],
  ['docs/ui-redesign.md', 18240, 3600],
  ['docs/api-tools.md', 10240, 5400],
  ['src/cell.cpp', 184320, 1200],
  ['src/cell-app-core.hpp', 95100, 900],
  ['src/cell-app-http.hpp', 22800, 5400],
  ['src/cell-app-tools.hpp', 38200, 2400],
  ['src/cell-ui.hpp', 412000, 600],
  ['src/ui/index.html', 268000, 600],
  ['src/ui/src/index.html', 6820, 1800],
  ['src/ui/src/css/00-tokens.css', 4210, 3600],
  ['src/ui/src/css/01-base.css', 3360, 3600],
  ['src/ui/src/css/02-atoms.css', 5210, 3600],
  ['src/ui/src/css/03-molecules.css', 14800, 3600],
  ['src/ui/src/css/04-layout.css', 6820, 2400],
  ['src/ui/src/css/05-stream.css', 12600, 7200],
  ['src/ui/src/css/08-panels.css', 18400, 600],
  ['src/ui/src/js/00-core.js', 38200, 2400],
  ['src/ui/src/js/01-markdown.js', 12100, 7200],
  ['src/ui/src/js/02-render.js', 28400, 1800],
  ['src/ui/src/js/02-render2-chat.js', 32600, 7200],
  ['src/ui/src/js/03-layout.js', 9800, 3600],
  ['src/ui/src/js/03-teamwork.js', 19800, 3600],
  ['src/ui/src/js/04-notices.js', 8400, 7200],
  ['src/ui/src/js/05-composer.js', 23600, 3600],
  ['src/ui/src/js/06-settings.js', 25800, 7200],
  ['src/ui/src/js/07-overlays.js', 16400, 7200],
  ['src/ui/src/js/08-mock.js', 14200, 3600],
  ['src/ui/src/js/08b-panels.js', 52600, 600],
  ['src/ui/src/js/09-boot.js', 6200, 1800],
  ['_scratch/NOTES.md', 2100, 43200],
  ['_scratch/ref/dsh-gui.png', 284000, 86400],
  ['_scratch/ref/edited-files.png', 96000, 86400],
  ['_scratch/shots/baseline.png', 312000, 7200],
  ['_scratch/tools/shot.mjs', 4820, 10800],
  ['build/cell-app.exe', 12400000, 4200],
  ['build/CMakeCache.txt', 18200, 4200],
  ['build/build.ninja', 9100, 4200],
  ['.worktrees/feat-ui/README.md', 8260, 3600]
];

var PMOCK_TEXT = {
  'README.md': '# cell-app\n\n> cell.cpp 智能体运行时的桌面壳 + 本地 Web 服务。\n\n## 构建\n\n' +
    '    python build_ui.py --html\n    cmake -S . -B build\n    cmake --build build\n\n' +
    '## 运行\n\n' +
    '    build/cell-app.exe --headless 8787 --ui src/ui/index.html\n\n' +
    '## 目录\n\n- src/ui/src —— WebUI 源码（skeleton + css/*.css + js/*.js）\n' +
    '- src/cell-app-core.hpp —— 应用核心与 exec_command 分发\n' +
    '- src/cell-app-tools.hpp —— git / fs / term 工具命令\n- docs/ —— 设计与接口文档\n',
  '.gitignore': 'build/\n.cell/\n_scratch/shots/*.png\n_scratch/tmp/\n.worktrees/\n',
  'build_ui.py': '#!/usr/bin/env python3\n"""Assemble the WebUI sources into the single embedded page."""\n' +
    'import pathlib\nimport sys\n\nROOT = pathlib.Path(__file__).resolve().parent\nSRC = ROOT / "src/ui/src"\n' +
    'OUT_HTML = ROOT / "src/ui/index.html"\nOUT_HPP = ROOT / "src/cell-ui.hpp"\n\n' +
    'def layer(folder, suffix):\n    files = sorted((SRC / folder).glob("*" + suffix))\n' +
    '    return "\\n\\n".join(f.read_text(encoding="utf-8-sig") for f in files)\n\n' +
    'def main():\n    page = build()\n    save(OUT_HTML, page)\n    return 0\n',
  'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(cell-app LANGUAGES CXX)\n\n' +
    'set(CMAKE_CXX_STANDARD 20)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\n\n' +
    'add_executable(cell-app src/cell.cpp\n    src/cell-app-http.hpp\n    src/cell-app-core.hpp\n' +
    '    src/cell-app-tools.hpp)\n\ntarget_link_libraries(cell-app PRIVATE ws2_32)\n',
  'docs/ui-redesign.md': '# cell-app UI 全面升级 · 设计规范与协作契约（v1）\n\n' +
    '> 目标：把 WebUI 从「能用」提升到 DeepSeek Harness 级别的完成度。\n\n' +
    '## 1. 原则\n\n1. **一个视觉语言**：只用 §2 的令牌。\n2. **分层表面**：主画布最暗，面板次之，卡片更亮。\n' +
    '3. **克制的色彩**：中性灰为底，强调色只给可交互 / 激活。\n4. **密度**：正文 14px、UI 标签 13px、元信息 11.5px。\n' +
    '5. **原生、零依赖**：vanilla JS + 内联 SVG。\n\n## 2. 设计令牌（节选）\n\n' +
    '    --bg: #111113;  --bg2: #17171a;  --bg3: #1c1c1f;\n' +
    '    --panel: #1b1b1d;  --panel2: #202023;\n' +
    '    --accent: #6c7cff;  --accent-soft: rgba(108,124,255,.13);\n' +
    '    --ok: #3fb950;  --bad: #f85149;\n\n' +
    '## 5.2 文件面板（files）\n\n- 面包屑 + 刷新；单层列表：文件夹优先。\n' +
    '- 文件图标按扩展名着色；单击文件打开预览浮层。\n- Ctrl+P 全局快速打开。\n',
  'docs/api-tools.md': '# 工具命令 API（exec_command 扩展）\n\n所有命令沿用现有协议：入参 JSON，返回 {"ok":true,...}。\n\n' +
    '| 命令 | 入参 | 返回 |\n|---|---|---|\n| git.status | {cwd?, ws?} | 仓库状态 / 变更 / worktrees |\n' +
    '| git.worktrees | {cwd?, ws?} | worktree 列表 |\n| git.worktree.add | {branch, base?, path?, create_branch?} | 新路径 |\n' +
    '| git.diff | {cwd?, path?, staged?} | unified diff |\n| fs.list | {cwd?, path?} | 目录项 |\n' +
    '| fs.read | {cwd?, path} | 文本 / binary |\n| fs.find | {cwd?, q, limit?} | 文件列表 |\n' +
    '| term.exec | {cwd?, cmd, timeout_s?} | exit_code / output / stderr |\n\n## 示例\n\n' +
    '    curl -s localhost:8787/api/cmd/git.status -d "{}"\n',
  'src/ui/src/index.html': '<!DOCTYPE html>\n<html lang="zh-CN" data-anim="2">\n<head>\n' +
    '<meta charset="utf-8">\n<title>cell · 本地代理工作台</title>\n</head>\n<body>\n' +
    '<div id="app">\n  <div id="shell">\n    <aside id="sidebar">…</aside>\n' +
    '    <div id="main">\n      <div id="topbar">…</div>\n      <div id="workarea">\n' +
    '        <div id="centre"><div id="tabview"></div></div>\n' +
    '        <aside id="rightdock"><div class="dockhead">…</div><div id="dockBody"></div></aside>\n' +
    '      </div>\n    </div>\n  </div>\n</div>\n</body>\n</html>\n',
  'src/ui/src/js/08b-panels.js': '/* 08b · 桌面工作台面板 */\n' +
    "'use strict';\n\nwindow.Panels = {\n  names: ['files', 'git', 'terminal'],\n" +
    '  has: function (name) { return this.names.indexOf(name) >= 0; },\n' +
    '  render: function (name, body, tab) { /* … */ },\n  refresh: function (name) { /* … */ },\n' +
    '  init: function () { /* … */ }\n};\n',
  'src/ui/src/css/08-panels.css': '/* 08 · 文件 / Git / 终端 面板 */\n.pnl{display:flex;flex-direction:column;height:100%;min-height:0}\n' +
    '.pnl-head{height:40px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--line)}\n' +
    '.fp-row{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:var(--radius-s)}\n' +
    '.fp-row:hover{background:var(--raise)}\n',
  'src/ui/src/js/00-core.js': "'use strict';\n\nconst $ = (s, r = document) => r.querySelector(s);\n" +
    'const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));\n\n' +
    "const MOCK = location.protocol === 'file:' || /[?&]mock=1\\b/.test(location.search);\n\n" +
    'const S = {\n  mode: MOCK ? \'demo\' : \'live\',\n  active: \'\', tabOrder: [], tabs: new Map(),\n' +
    '  dock: \'start\', dockOpen: false,\n};\n\nasync function api(name, args) {\n' +
    "  if (S.mode === 'demo') return Mock.api(name, args || {});\n  // fetch('api/cmd/' + name, …)\n}\n",
  'src/cell-app-core.hpp': '// cell-app-core.hpp —— 应用核心：会话、回合、事件总线\n#pragma once\n\n' +
    'namespace app {\n\nclass core {\npublic:\n  bool exec_command(const std::string &name, const json &args, json &out);\n' +
    '  void post(const json &ev); // 广播给 SSE / WebView 两条传输\n\nprivate:\n' +
    '  std::map<std::string, workspace> ws_;\n};\n\n} // namespace app\n'
};

function pmockNow() { return Math.floor(Date.now() / 1000); }

function pmockNormPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function pmockFindFile(p) {
  for (var i = 0; i < PMOCK_FILES.length; i++) if (PMOCK_FILES[i][0] === p) return PMOCK_FILES[i];
  return null;
}

function pmockCellCpp() {
  var lines = [];
  lines.push('// cell.cpp —— cell-app 入口：解析参数、启动 headless 服务或桌面壳');
  lines.push('#include "cell-app-core.hpp"');
  lines.push('#include "cell-app-http.hpp"');
  lines.push('');
  lines.push('int main(int argc, char **argv)');
  lines.push('{');
  for (var i = 0; i < 5200; i++) {
    lines.push('    // 演示文件：第 ' + (i + 1) + ' 行 —— fs.read 只返回前 5000 行（truncated:true）');
  }
  lines.push('    return 0;');
  lines.push('}');
  return lines.join('\n');
}

function pmockStub(p) {
  var name = pnlBase(p);
  var kind = pnlKindOf(name);
  if (kind === 'md') return '# ' + name + '\n\n演示文件：真实后端由 fs.read 返回文件内容。\n';
  if (kind === 'json') return '{\n  "name": "' + name + '",\n  "kind": "demo",\n  "ok": true\n}\n';
  if (kind === 'css') return '/* ' + name + ' —— 演示文件 */\n.demo{color:var(--fg)}\n';
  if (kind === 'html') return '<!DOCTYPE html>\n<html>\n<body>\n  <p>' + pnlEsc(name) + '</p>\n</body>\n</html>\n';
  if (kind === 'yml') return '# ' + name + '\ndemo: true\n';
  if (kind === 'py') return '#!/usr/bin/env python3\n# ' + name + '\nprint("demo")\n';
  if (kind === 'cpp') return '// ' + name + '\n#include <cstdio>\nint main() { return 0; }\n';
  if (kind === 'js' || kind === 'ts') return "'use strict';\n// " + name + '\nfunction demo() { return 42; }\n';
  return '// ' + name + '\n（演示文件）\n';
}

function pmockFileText(p) {
  if (p === 'src/cell.cpp') return pmockCellCpp();
  if (PMOCK_TEXT[p] != null) return PMOCK_TEXT[p];
  return pmockStub(p);
}

function pmockList(path) {
  var rel = pmockNormPath(path);
  var prefix = rel ? rel + '/' : '';
  var now = pmockNow();
  var dirs = [], files = [];
  var dirSeen = {};
  for (var i = 0; i < PMOCK_FILES.length; i++) {
    var p = PMOCK_FILES[i][0], size = PMOCK_FILES[i][1], age = PMOCK_FILES[i][2];
    if (prefix && p.indexOf(prefix) !== 0) continue;
    var rest = p.slice(prefix.length);
    if (!rest) continue;
    var slash = rest.indexOf('/');
    if (slash >= 0) {
      var d = rest.slice(0, slash);
      if (!dirSeen[d]) {
        dirSeen[d] = 1;
        dirs.push({ name: d, path: prefix + d, dir: true, size: 0, mtime: now - 1800 });
      }
    } else {
      files.push({ name: rest, path: p, dir: false, size: size, mtime: now - age });
    }
  }
  var isDir = (rel === '') || dirs.length > 0 || files.length > 0;
  if (!isDir) return { ok: false, error: '目录不存在：' + (path || '') };
  var entries = dirs.concat(files);
  entries.sort(function (a, b) { return (b.dir - a.dir) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); });
  return { ok: true, path: rel, entries: entries, truncated: false };
}

function pmockRead(path) {
  var rel = pmockNormPath(path);
  if (!rel) return { ok: false, error: '缺少文件路径' };
  var found = pmockFindFile(rel);
  if (!found) return { ok: false, error: '文件不存在：' + path };
  var size = found[1];
  if (pnlIsBinaryName(rel)) {
    return { ok: true, path: rel, size: size, binary: true, text: '', lines: 0, truncated: false };
  }
  var text = pmockFileText(rel);
  var all = text.split('\n');
  var truncated = false;
  var lines = all.length;
  if (lines > 5000) {
    text = all.slice(0, 5000).join('\n');
    lines = 5000;
    truncated = true;
  }
  return { ok: true, path: rel, size: size, binary: false, text: text, lines: lines, truncated: truncated };
}

function pmockFind(args) {
  var q = String(args.q == null ? '' : args.q).trim().toLowerCase();
  var limit = Math.max(1, Math.min(200, Number(args.limit) || 80));
  var hits = [];
  for (var i = 0; i < PMOCK_FILES.length; i++) {
    var p = PMOCK_FILES[i][0];
    var lp = p.toLowerCase();
    var name = pnlBase(p);
    var ln = name.toLowerCase();
    var score = 0;
    if (!q) score = 3;
    else if (ln === q) score = 0;
    else if (ln.indexOf(q) === 0) score = 1;
    else if (ln.indexOf(q) >= 0) score = 2;
    else if (lp.indexOf(q) >= 0) score = 3;
    else continue;
    hits.push({ name: name, path: p, _s: score, _n: ln, _p: lp, _d: (p.match(/\//g) || []).length });
  }
  hits.sort(function (a, b) {
    return (a._s - b._s) || (a._n.length - b._n.length) || (a._d - b._d) || a._p.localeCompare(b._p);
  });
  var out = [];
  for (var k = 0; k < hits.length && out.length < limit; k++) out.push({ name: hits[k].name, path: hits[k].path });
  return { ok: true, files: out, total: out.length };
}

function pmockWorktreeFor(cwd) {
  var c = String(cwd || PMOCK_ROOT).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  // 主仓库路径是 worktree 路径的前缀：取匹配到的最长路径（最具体的那个）
  var best = null, bestLen = -1;
  for (var i = 0; i < PMOCK_WORKTREES.length; i++) {
    var w = PMOCK_WORKTREES[i];
    var wp = String(w.path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if ((c === wp || c.indexOf(wp + '\\') === 0) && wp.length > bestLen) {
      best = w;
      bestLen = wp.length;
    }
  }
  return best || PMOCK_WORKTREES[0];
}

var PMOCK_CHANGES = [
  { path: 'src/ui/src/js/02-render.js', status: 'M', add: 48, del: 12, staged: false },
  { path: 'docs/api-tools.md', status: 'A', add: 210, del: 0, staged: true },
  { path: 'src/ui/src/js/08b-panels.js', status: 'U', add: 486, del: 0, staged: false }
];

var PMOCK_WT_CHANGES = [
  { path: 'src/ui/src/js/02-render2-chat.js', status: 'M', add: 32, del: 9, staged: false }
];

function pmockGitStatus(args) {
  var wt = pmockWorktreeFor(args.cwd || PMOCK_ROOT);
  var main = !!wt.is_main;
  var files = main ? PMOCK_CHANGES : PMOCK_WT_CHANGES;
  var list = [];
  for (var i = 0; i < files.length; i++) list.push(Object.assign({}, files[i]));
  var wts = [];
  for (var k = 0; k < PMOCK_WORKTREES.length; k++) {
    var w = PMOCK_WORKTREES[k];
    wts.push(Object.assign({}, w, { current: pmockNormPath(w.path) === pmockNormPath(wt.path) }));
  }
  return {
    ok: true, repo: 'cell-app', root: main ? PMOCK_ROOT : wt.path, branch: wt.branch,
    detached: !!wt.detached, ahead: main ? 2 : 5, behind: main ? 1 : 0,
    dirty_count: list.length, files: list, worktrees: wts, is_main: main
  };
}

function pmockCommits() {
  var now = pmockNow();
  return [
    { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', short: 'a1b2c3d', subject: 'ui: 三区外壳与右栏 dock 页签重构', author: 'cell', time: now - 3600, rel: '1 小时前' },
    { hash: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', short: '9f8e7d6', subject: 'feat: Git Worktree 面板与终端面板', author: 'cell', time: now - 10800, rel: '3 小时前' },
    { hash: '2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3', short: '2c3d4e5', subject: 'core: exec_command 接入 git/fs/term 工具', author: 'cell', time: now - 86400, rel: '昨天' },
    { hash: '3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4', short: '3d4e5f6', subject: 'ui: 设计令牌与原子组件重写', author: 'cell', time: now - 172800, rel: '2 天前' },
    { hash: '4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5', short: '4e5f6a7', subject: 'chore: build_ui 拼装顺序与初始化', author: 'cell', time: now - 259200, rel: '3 天前' }
  ];
}

function pmockDiff(args) {
  var path = String(args.path || '');
  var lines = [];
  if (path === 'src/ui/src/js/02-render.js') {
    lines.push('diff --git a/src/ui/src/js/02-render.js b/src/ui/src/js/02-render.js');
    lines.push('index 6d1e2f0..9a4b7c1 100644');
    lines.push('--- a/src/ui/src/js/02-render.js');
    lines.push('+++ b/src/ui/src/js/02-render.js');
    lines.push('@@ -467,10 +467,22 @@ function renderDock() {');
    lines.push("   const body = $('#dockBody');");
    lines.push('   if (!body) return;');
    lines.push('   syncTwPoll();');
    lines.push("   $$('.docktab').forEach(b => b.classList.toggle('on', b.dataset.dock === S.dock));");
    lines.push('   const t = curTab();');
    lines.push("-  if (!t) { body.replaceChildren(el('div', 'dim small', '没有打开的工作区')); return; }");
    lines.push("-  if (S.dock === 'teamwork') renderDockTeamwork(body, t);");
    lines.push("-  else if (S.dock === 'archives') renderDockArchives(body, t);");
    lines.push('-  else renderDockNotices(body, t);');
    lines.push('+  body.replaceChildren();');
    lines.push("+  if (!t) { body.appendChild(el('div', 'dim small', '没有打开的工作区')); return; }");
    lines.push("+  if (S.dock === 'start') renderDockStart(body, t);");
    lines.push("+  else if (S.dock === 'teamwork') renderDockTeamwork(body, t);");
    lines.push("+  else if (S.dock === 'archives') renderDockArchives(body, t);");
    lines.push("+  else if (S.dock === 'notices') renderDockNotices(body, t);");
    lines.push('+  else if (window.Panels && Panels.has(S.dock)) Panels.render(S.dock, body, t);');
    lines.push("+  else body.appendChild(el('div', 'dim small', '未知面板：' + S.dock));");
    lines.push(' }');
  } else if (path === 'docs/api-tools.md') {
    lines.push('diff --git a/docs/api-tools.md b/docs/api-tools.md');
    lines.push('new file mode 100644');
    lines.push('index 0000000..7a3c9e2');
    lines.push('--- /dev/null');
    lines.push('+++ b/docs/api-tools.md');
    lines.push('@@ -0,0 +1,12 @@');
    lines.push('+# 工具命令 API（exec_command 扩展）');
    lines.push('+');
    lines.push('+所有命令沿用现有协议：入参 JSON，返回 {"ok":true,...}。');
    lines.push('+');
    lines.push('+| 命令 | 入参 | 返回 |');
    lines.push('+|---|---|---|');
    lines.push('+| git.status | {cwd?, ws?} | 仓库状态 / 变更 / worktrees |');
    lines.push('+| git.worktrees | {cwd?, ws?} | worktree 列表 |');
    lines.push('+| fs.list | {cwd?, path?} | 目录项 |');
    lines.push('+| fs.read | {cwd?, path} | 文本 / binary |');
    lines.push('+| fs.find | {cwd?, q, limit?} | 文件列表 |');
    lines.push('+| term.exec | {cwd?, cmd, timeout_s?} | exit_code / output / stderr |');
  } else if (path === 'src/ui/src/js/08b-panels.js') {
    lines.push('diff --git a/src/ui/src/js/08b-panels.js b/src/ui/src/js/08b-panels.js');
    lines.push('new file mode 100644');
    lines.push('index 0000000..b18f4d2');
    lines.push('--- /dev/null');
    lines.push('+++ b/src/ui/src/js/08b-panels.js');
    lines.push('@@ -0,0 +1,16 @@');
    lines.push('+/* 08b · 桌面工作台面板：文件 / Git Worktree / 终端 */');
    lines.push("+'use strict';");
    lines.push('+');
    lines.push('+window.Panels = {');
    lines.push("+  names: ['files', 'git', 'terminal'],");
    lines.push('+  has: function (name) { return this.names.indexOf(name) >= 0; },');
    lines.push('+  render: function (name, body, tab) { /* … */ },');
    lines.push('+  refresh: function (name) { /* … */ },');
    lines.push('+  init: function () { /* … */ }');
    lines.push('+};');
    lines.push('+');
    lines.push('+window.openFilePanel = function () { openDock("files"); };');
    lines.push('+window.openGitPanel = function () { openDock("git"); };');
    lines.push('+window.openTerminal = function () { openDock("terminal"); };');
    lines.push('+window.openQuickOpen = function () { /* Ctrl+P 快速打开 */ };');
  } else {
    var st = null;
    for (var i = 0; i < PMOCK_CHANGES.length; i++) if (PMOCK_CHANGES[i].path === path) st = PMOCK_CHANGES[i];
    lines.push('diff --git a/' + path + ' b/' + path);
    lines.push('index 1234567..89abcde 100644');
    lines.push('--- a/' + path);
    lines.push('+++ b/' + path);
    lines.push('@@ -1,6 +1,12 @@');
    lines.push(' ' + '（演示 diff：' + (st ? st.status : 'M') + ' ' + path + '）');
    lines.push('-旧的实现（演示占位）');
    lines.push('+新的实现（演示占位）');
    lines.push('+// +' + (st ? st.add : 0) + ' / -' + (st ? st.del : 0));
  }
  return { ok: true, diff: lines.join('\n'), truncated: false, binary: false };
}

function pmockWorktreeAdd(args) {
  var branch = String(args.branch || '').trim();
  if (!branch) return { ok: false, error: '分支名不能为空' };
  var sep = pnlSepFor(PMOCK_ROOT);
  var path = String(args.path || '').trim();
  if (!path) {
    path = PMOCK_ROOT + sep + '.worktrees' + sep + branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
  }
  for (var i = 0; i < PMOCK_WORKTREES.length; i++) {
    if (pnlNorm(PMOCK_WORKTREES[i].path) === pnlNorm(path)) return { ok: false, error: '路径已存在：' + path };
  }
  PMOCK_WORKTREES.push({
    path: path, branch: branch, head: '0000000',
    current: false, is_main: false, detached: false, locked: false, prunable: false
  });
  PMOCK_BRANCHES.push(branch);
  return { ok: true, path: path, branch: branch };
}

function pmockWorktreeRemove(args) {
  var path = String(args.path || '');
  for (var i = 0; i < PMOCK_WORKTREES.length; i++) {
    if (pnlNorm(PMOCK_WORKTREES[i].path) === pnlNorm(path)) {
      if (PMOCK_WORKTREES[i].current || PMOCK_WORKTREES[i].is_main) {
        return { ok: false, error: '不能移除当前 / 主仓库 worktree' };
      }
      PMOCK_WORKTREES.splice(i, 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'worktree 不存在：' + path };
}

function pmockTermResult(cmd, cwd) {
  var raw = String(cmd || '').trim();
  var low = raw.toLowerCase();
  var c = cwd || PMOCK_ROOT;
  if (low === 'pwd') return { ok: true, exit_code: 0, output: c + '\n', stderr: '', duration_ms: 8, truncated: false };
  if (low === 'git status' || low === 'git status -s') {
    return {
      ok: true, exit_code: 0, stderr: '', duration_ms: 42, truncated: false,
      output: 'On branch main\nYour branch is ahead of \'origin/main\' by 2 commits.\n' +
        '  (use "git push" to publish your local commits)\n\n' +
        'Changes not staged for commit:\n' +
        '  (use "git add <file>..." to update what will be committed)\n' +
        '        modified:   src/ui/src/js/02-render.js\n' +
        '        modified:   src/ui/src/css/04-layout.css\n\n' +
        'Untracked files:\n' +
        '        docs/api-tools.md\n        src/ui/src/js/08b-panels.js\n        src/ui/src/css/08-panels.css\n\n' +
        'no changes added to commit (use "git add" and/or "git commit -a")\n'
    };
  }
  if (low === 'git log --oneline -5' || low === 'git log --oneline') {
    var outs = [];
    var cs = pmockCommits();
    for (var i = 0; i < cs.length; i++) outs.push(cs[i].short + ' ' + cs[i].subject);
    return { ok: true, exit_code: 0, output: outs.join('\n') + '\n', stderr: '', duration_ms: 36, truncated: false };
  }
  if (low === 'git branch' || low === 'git branch -a') {
    var bl = PMOCK_BRANCHES.map(function (b) { return b === 'main' ? '* main' : '  ' + b; });
    return { ok: true, exit_code: 0, output: bl.join('\n') + '\n', stderr: '', duration_ms: 24, truncated: false };
  }
  if (low === 'git worktree list') {
    var wtl = PMOCK_WORKTREES.map(function (w) { return w.path + '  ' + w.head + ' [' + w.branch + ']'; });
    return { ok: true, exit_code: 0, output: wtl.join('\n') + '\n', stderr: '', duration_ms: 26, truncated: false };
  }
  if (low === 'ls' || low === 'dir') {
    return {
      ok: true, exit_code: 0, stderr: '', duration_ms: 14, truncated: false,
      output: '    目录: ' + c + '\n\nMode                 LastWriteTime         Length Name\n' +
        '----                 -------------         ------ ----\n' +
        'd----          2026/10/17    17:12                _scratch\n' +
        'd----          2026/10/17    17:02                build\n' +
        'd----          2026/10/17    16:48                docs\n' +
        'd----          2026/10/17    17:21                src\n' +
        '-a---          2026/10/17    15:30           4218 CMakeLists.txt\n' +
        '-a---          2026/10/17    16:05           8260 README.md\n' +
        '-a---          2026/10/17    16:05           3180 build_ui.py\n'
    };
  }
  if (/python(3)?\s+build_ui\.py/.test(low)) {
    return {
      ok: true, exit_code: 0, stderr: '', duration_ms: 186, truncated: false,
      output: 'build_ui: -> src/ui/index.html\nbuild_ui: untouched src/cell-ui.hpp\n'
    };
  }
  if (/node\s+--check/.test(low)) {
    return { ok: true, exit_code: 0, output: '', stderr: '', duration_ms: 58, truncated: false };
  }
  if (low === 'git push') {
    return {
      ok: true, exit_code: 1, output: '', duration_ms: 1220, truncated: false,
      stderr: 'fatal: unable to access \'https://github.com/cell-app/cell-app.git/\':\n' +
        'Could not resolve host: github.com\n'
    };
  }
  if (/^(npm|pnpm)\s+(run\s+)?test/.test(low)) {
    return {
      ok: true, exit_code: 1, output: '', duration_ms: 640, truncated: false,
      stderr: 'Error: no test files found, exiting with code 1\n'
    };
  }
  if (low.indexOf('echo ') === 0) {
    return { ok: true, exit_code: 0, output: raw.slice(5) + '\n', stderr: '', duration_ms: 6, truncated: false };
  }
  if (low === 'whoami') return { ok: true, exit_code: 0, output: 'cell\n', stderr: '', duration_ms: 5, truncated: false };
  if (low === 'date') return { ok: true, exit_code: 0, output: new Date().toString() + '\n', stderr: '', duration_ms: 5, truncated: false };
  if (low === 'git diff' || low === 'git diff --stat') {
    return {
      ok: true, exit_code: 0, stderr: '', duration_ms: 31, truncated: false,
      output: ' src/ui/src/js/02-render.js | 60 ++++++++++++++++++++++++++--------\n' +
        ' 1 file changed, 48 insertions(+), 12 deletions(-)\n'
    };
  }
  return {
    ok: true, exit_code: 0, stderr: '', duration_ms: 10, truncated: false,
    output: '演示模式：已执行 ' + raw + '\n（真实后端由 term.exec 执行并把 stdout / stderr / exit_code 回传）\n'
  };
}

function pmockTermExec(args) {
  var cmd = String(args.cmd || '');
  var cwd = args.cwd || PMOCK_ROOT;
  return new Promise(function (resolve) {
    var delay = /build_ui|cmake|push|test/i.test(cmd) ? 620 : 220;
    setTimeout(function () {
      var res = pmockTermResult(cmd, cwd);
      if (res.duration_ms == null) res.duration_ms = delay;
      resolve(res);
    }, delay);
  });
}

function pmockApi(name, args) {
  args = args || {};
  switch (name) {
    case 'fs.list': return Promise.resolve(pmockList(args.path || ''));
    case 'fs.read': return Promise.resolve(pmockRead(args.path || ''));
    case 'fs.find': return Promise.resolve(pmockFind(args));
    case 'git.status': return Promise.resolve(pmockGitStatus(args));
    case 'git.worktrees': {
      var wt = pmockWorktreeFor(args.cwd || PMOCK_ROOT);
      var list = [];
      for (var i = 0; i < PMOCK_WORKTREES.length; i++) {
        var w = PMOCK_WORKTREES[i];
        list.push(Object.assign({}, w, { current: pmockNormPath(w.path) === pmockNormPath(wt.path) }));
      }
      return Promise.resolve({ ok: true, root: PMOCK_ROOT, repo_name: 'cell-app', current: wt.path, worktrees: list });
    }
    case 'git.branches': return Promise.resolve({ ok: true, current: 'main', local: PMOCK_BRANCHES.slice(0) });
    case 'git.log': {
      var lim = Math.max(1, Number(args.limit) || 5);
      return Promise.resolve({ ok: true, commits: pmockCommits().slice(0, lim) });
    }
    case 'git.numstat': {
      var files = [];
      for (var k = 0; k < PMOCK_CHANGES.length; k++) {
        files.push({ path: PMOCK_CHANGES[k].path, add: PMOCK_CHANGES[k].add, del: PMOCK_CHANGES[k].del, binary: false });
      }
      return Promise.resolve({ ok: true, files: files });
    }
    case 'git.diff': return Promise.resolve(pmockDiff(args));
    case 'git.init': return Promise.resolve({ ok: true, root: args.cwd || PMOCK_ROOT });
    case 'git.worktree.add': return Promise.resolve(pmockWorktreeAdd(args));
    case 'git.worktree.remove': return Promise.resolve(pmockWorktreeRemove(args));
    case 'term.exec': return pmockTermExec(args);
    default: return Promise.resolve({ ok: false, error: '演示模式不支持：' + name });
  }
}

function pnlPatchMock() {
  try {
    if (typeof Mock === 'undefined' || !Mock || typeof Mock.api !== 'function') return;
    if (Mock.__pnlPatched) return;
    // 演示模式里「打开为工作区」的 worktree 也要能被 state 快照认出来：
    // 记录 workspace.open 的结果，并在 hello()/workspaces() 里合并进工作区列表。
    var openedWs = {};
    var orig = Mock.api.bind(Mock);
    Mock.api = function (name, args) {
      args = args || {};
      var n = String(name);
      if (/^(git|fs|term)\./.test(n)) return pmockApi(n, args);
      if (n === 'workspace.open') {
        return orig(n, args).then(function (out) {
          if (out && out.ok !== false && out.ws && out.cwd) openedWs[out.ws] = String(out.cwd);
          return out;
        });
      }
      if (n === 'workspace.close') {
        var closeWs = args.ws || args.workspace || '';
        if (closeWs) delete openedWs[closeWs];
        return orig(n, args);
      }
      return orig(n, args);
    };
    if (typeof Mock.hello === 'function') {
      var origHello = Mock.hello.bind(Mock);
      Mock.hello = function (ws) {
        var h = origHello(ws);
        var keys = Object.keys(openedWs);
        if (!keys.length) return h;
        var wss = Array.isArray(h.workspaces) ? h.workspaces.slice() : [];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i], dup = false;
          for (var j = 0; j < wss.length; j++) if (wss[j].ws === k) { dup = true; break; }
          if (!dup) wss.push({ ws: k, cwd: openedWs[k], session: 'mock-wt-session', busy: false, active: false });
        }
        h.workspaces = wss;
        if (openedWs[ws]) {
          h.ws = ws;
          h.active = ws;
          h.cwd = openedWs[ws];
          h.session = 'mock-wt-session';
          h.history = [];
          h.teamwork = [];
          h.busy = false;
        }
        return h;
      };
    }
    if (typeof Mock.workspaces === 'function') {
      var origWorkspaces = Mock.workspaces.bind(Mock);
      Mock.workspaces = function () {
        var list = origWorkspaces().slice();
        var keys = Object.keys(openedWs);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i], dup = false;
          for (var j = 0; j < list.length; j++) if (list[j].ws === k) { dup = true; break; }
          if (!dup) list.push({ ws: k, cwd: openedWs[k], session: 'mock-wt-session', busy: false, active: false });
        }
        return list;
      };
    }
    Mock.__pnlPatched = true;
  } catch (e) {
    if (window.console) console.warn('[panels] mock 包装失败', e);
  }
}

pnlPatchMock();

/* =====================================================================
   3. 浮层：文件预览 / git diff / Ctrl+P 快速打开
   ===================================================================== */

var PNLOv = { preview: null, quick: null };

// 指定 cwd 的命令参数（预览 / 快速打开用的是「打开浮层那一刻」的工作区）
function pnlArgsIn(cwd, extra) {
  var a = { ws: (typeof S !== 'undefined' && S.active) || '' };
  if (cwd) a.cwd = cwd;
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
  return a;
}

function pnlOverlayNode(kind) {
  var id = kind === 'quick' ? 'pnlQuickOpen' : 'pnlPreview';
  var n = document.getElementById(id);
  if (!n) {
    n = pnlEl('div', 'pnl-ov ' + (kind === 'quick' ? 'qo-ov' : 'fpv-ov'));
    n.id = id;
    n.setAttribute('role', 'dialog');
    n.setAttribute('aria-modal', 'true');
    n.addEventListener('mousedown', function (ev) { if (ev.target === n) pnlCloseOverlay(kind); });
    document.body.appendChild(n);
  }
  return n;
}

function pnlOverlayShown(kind) {
  var n = document.getElementById(kind === 'quick' ? 'pnlQuickOpen' : 'pnlPreview');
  return !!(n && n.classList.contains('show'));
}

function pnlRestoreFocus(prev) {
  try {
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  } catch (e) {}
}

function pnlCloseOverlay(kind) {
  if (kind === 'quick') { pnlCloseQuickOpen(); return; }
  var n = document.getElementById('pnlPreview');
  var prev = PNLOv.preview && PNLOv.preview.prevFocus;
  if (n) { n.classList.remove('show'); n.replaceChildren(); }
  PNLOv.preview = null;
  pnlRestoreFocus(prev);
}

function pnlClosePreview() { pnlCloseOverlay('preview'); }

/* ---------- 3.1 文件预览 / diff 浮层外壳 --------------------------- */
function pnlPreviewShell(opts) {
  var ov = pnlOverlayNode('preview');
  var box = pnlEl('div', 'fpv-box');
  var head = pnlEl('div', 'fpv-head');
  var ico = pnlEl('span', 'fpv-ico ' + pnlColorClass(opts.path));
  ico.innerHTML = pnlIcon(opts.mode === 'diff' ? 'gitCommit' : 'fileCode');
  var titles = pnlEl('div', 'fpv-titles');
  var pathEl = pnlEl('div', 'fpv-path', pnlDisplayPath(opts.path, opts.cwd));
  pathEl.title = String(opts.path || '');
  var meta = pnlEl('div', 'fpv-meta', '正在读取…');
  titles.append(pathEl, meta);
  var acts = pnlEl('div', 'fpv-acts');
  var copyBtn = pnlIconBtn('copy', '复制内容', function () {
    if (PNLOv.preview && PNLOv.preview.text) pnlCopy(PNLOv.preview.text, '已复制内容');
  });
  var closeBtn = pnlIconBtn('x', '关闭 (Esc)', pnlClosePreview);
  acts.append(copyBtn, closeBtn);
  head.append(ico, titles, acts);
  var body = pnlEl('div', 'fpv-body');
  body.appendChild(pnlLoading('正在读取…'));
  var foot = pnlEl('div', 'fpv-foot');
  foot.innerHTML = '<span class="mut">Esc 关闭</span><span class="grow"></span><span class="fpv-foot-path trunc">' +
    pnlEsc(String(opts.path || '')) + '</span>';
  box.append(head, body, foot);
  ov.replaceChildren(box);
  ov.classList.add('show');
  PNLOv.preview = {
    mode: opts.mode, path: String(opts.path || ''), cwd: opts.cwd || '',
    text: '', prevFocus: document.activeElement
  };
  try { closeBtn.focus(); } catch (e) {}
  return { ov: ov, body: body, meta: meta, copyBtn: copyBtn, closeBtn: closeBtn, rec: PNLOv.preview };
}

// 代码视图：等宽行号 + 文本（先转义再拼，避免任何注入）
function pnlCodeView(text, maxLines) {
  var max = maxLines || 5000;
  var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  var cut = lines.length > max;
  var h = '';
  var n = Math.min(lines.length, max);
  for (var i = 0; i < n; i++) {
    h += '<div class="fpv-line"><span class="fpv-ln">' + (i + 1) + '</span><span class="fpv-lc">' + pnlEsc(lines[i]) + '</span></div>';
  }
  if (!h) h = '<div class="fpv-line"><span class="fpv-ln">1</span><span class="fpv-lc"></span></div>';
  var el = pnlEl('div', 'fpv-code');
  el.innerHTML = h;
  return { el: el, truncated: cut, total: lines.length, shown: n };
}

function pnlMarkdownView(text) {
  var box = pnlEl('div', 'fpv-md');
  try {
    if (typeof renderMarkdown === 'function') box.innerHTML = renderMarkdown(String(text == null ? '' : text));
    else box.textContent = String(text == null ? '' : text);
  } catch (e) {
    box.textContent = String(text == null ? '' : text);
  }
  return box;
}

function pnlFormatJson(text) {
  try {
    var v = JSON.parse(String(text || ''));
    return { text: JSON.stringify(v, null, 2), parsed: true };
  } catch (e) {
    return { text: String(text || ''), parsed: false, error: String(e.message || e) };
  }
}

function pnlIsMarkdownPath(path) {
  return /\.(md|markdown|mdx)$/i.test(String(path || ''));
}

function pnlIsJsonPath(path) {
  return /\.(json|jsonc)$/i.test(String(path || ''));
}

async function openFilePreview(path, opts) {
  opts = opts || {};
  var p = String(path || '');
  if (!p) return;
  var cwd = opts.cwd || pnlCtx().cwd;
  var shell = pnlPreviewShell({ mode: 'file', path: p, cwd: cwd });
  var out = await pnlApi('fs.read', pnlArgsIn(cwd, { path: p }));
  var rec = PNLOv.preview;
  if (!rec || rec.mode !== 'file' || rec.path !== p) return; // 期间被关闭 / 打开了别的预览
  var body = shell.body;
  body.replaceChildren();
  if (!out || out.ok === false) {
    shell.meta.textContent = '读取失败';
    body.appendChild(pnlErrorBox((out && out.error) || '无法读取文件', function () { openFilePreview(p, opts); }));
    return;
  }
  if (out.binary) {
    shell.meta.textContent = '二进制文件';
    var bin = pnlEl('div', 'fpv-binary');
    var bic = pnlEl('div', 'fpv-binary-ico');
    bic.innerHTML = pnlIcon('database');
    bin.appendChild(bic);
    bin.appendChild(pnlEl('div', 'fpv-binary-title', '二进制文件'));
    bin.appendChild(pnlEl('div', 'fpv-binary-desc', pnlBase(p) + ' · ' + pnlFmtSize(out.size) + '，无法以文本预览'));
    body.appendChild(bin);
    return;
  }
  var text = String(out.text == null ? '' : out.text);
  rec.text = text;
  var lines = Number(out.lines) || (text ? text.split('\n').length : 0);
  var metaBits = [];
  if (out.size != null) metaBits.push(pnlFmtSize(out.size));
  metaBits.push(lines + ' 行');
  if (out.truncated) metaBits.push('已截断（前 5000 行）');
  if (cwd) metaBits.push('工作区 ' + (pnlBase(cwd) || cwd));
  shell.meta.textContent = metaBits.join(' · ');
  if (pnlIsMarkdownPath(p)) {
    body.appendChild(pnlMarkdownView(text));
  } else if (pnlIsJsonPath(p)) {
    var fj = pnlFormatJson(text);
    var cv = pnlCodeView(fj.text, 5000);
    if (fj.parsed) cv.el.classList.add('fpv-json');
    body.appendChild(cv.el);
    if (!fj.parsed) body.appendChild(pnlEl('div', 'fpv-note', 'JSON 解析失败，按原文显示：' + fj.error));
    if (cv.truncated) body.appendChild(pnlEl('div', 'fpv-note', '文件过长，仅显示前 5000 行'));
  } else {
    var cv2 = pnlCodeView(text, 5000);
    body.appendChild(cv2.el);
    if (cv2.truncated) body.appendChild(pnlEl('div', 'fpv-note', '文件过长，仅显示前 5000 行'));
  }
}

function pnlDiffView(diff) {
  var lines = String(diff == null ? '' : diff).replace(/\r\n?/g, '\n').split('\n');
  var h = '';
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var cls = 'df-ctx';
    if (ln.indexOf('+++') === 0 || ln.indexOf('---') === 0) cls = 'df-file';
    else if (ln.indexOf('diff --git') === 0 || ln.indexOf('index ') === 0 ||
             ln.indexOf('new file mode') === 0 || ln.indexOf('deleted file mode') === 0) cls = 'df-meta';
    else if (ln.indexOf('@@') === 0) cls = 'df-hunk';
    else if (ln.charAt(0) === '+') cls = 'df-add';
    else if (ln.charAt(0) === '-') cls = 'df-del';
    h += '<div class="fpv-line df-line ' + cls + '"><span class="fpv-ln">' + (i + 1) + '</span><span class="fpv-lc">' + pnlEsc(ln) + '</span></div>';
  }
  if (!h) h = '<div class="fpv-note">（没有 diff 内容）</div>';
  var el = pnlEl('div', 'fpv-code fpv-diff');
  el.innerHTML = h;
  return el;
}

async function pnlOpenDiffPreview(path, opts) {
  opts = opts || {};
  var p = String(path || '');
  if (!p) return;
  var cwd = opts.cwd || pnlCtx().cwd;
  var shell = pnlPreviewShell({ mode: 'diff', path: p, cwd: cwd });
  var bits = [];
  if (Number(opts.add) > 0) bits.push('+' + opts.add);
  if (Number(opts.del) > 0) bits.push('-' + opts.del);
  if (opts.staged) bits.push('已暂存');
  shell.meta.textContent = bits.length ? bits.join('  ') + ' · 正在读取 diff…' : '正在读取 diff…';
  var args = pnlArgsIn(cwd, { path: p });
  if (opts.staged) args.staged = true;
  var out = await pnlApi('git.diff', args);
  var rec = PNLOv.preview;
  if (!rec || rec.mode !== 'diff' || rec.path !== p) return;
  shell.body.replaceChildren();
  if (!out || out.ok === false) {
    shell.meta.textContent = 'diff 读取失败';
    shell.body.appendChild(pnlErrorBox((out && out.error) || '无法读取 diff', function () { pnlOpenDiffPreview(p, opts); }));
    return;
  }
  var stat = [];
  if (Number(opts.add) > 0) stat.push('+' + opts.add);
  if (Number(opts.del) > 0) stat.push('-' + opts.del);
  if (opts.staged) stat.push('已暂存');
  if (out.truncated) stat.push('已截断');
  shell.meta.textContent = stat.length ? stat.join('  ') : 'diff';
  if (out.binary) {
    shell.body.appendChild(pnlEmptyBox('database', '二进制文件', '该文件的 diff 无法以文本显示'));
    return;
  }
  rec.text = String(out.diff == null ? '' : out.diff);
  shell.body.appendChild(pnlDiffView(out.diff || ''));
}

/* ---------- 3.2 Ctrl+P 快速打开 ----------------------------------- */
function pnlHighlight(text, q) {
  var s = String(text == null ? '' : text);
  var e = pnlEsc(s);
  var qq = String(q == null ? '' : q).trim();
  if (!qq) return e;
  var idx = s.toLowerCase().indexOf(qq.toLowerCase());
  if (idx < 0) return e;
  return pnlEsc(s.slice(0, idx)) + '<mark>' + pnlEsc(s.slice(idx, idx + qq.length)) + '</mark>' + pnlEsc(s.slice(idx + qq.length));
}

function openQuickOpen(prefill) {
  var ctx = pnlCtx();
  if (!ctx.cwd) { pnlToast('先打开一个工作区，再快速打开文件', 'bad'); return; }
  var ov = pnlOverlayNode('quick');
  ov.replaceChildren();
  var box = pnlEl('div', 'qo-box');
  var head = pnlEl('div', 'qo-inputrow');
  var ic = pnlEl('span', 'qo-ico');
  ic.innerHTML = pnlIcon('search');
  var input = pnlEl('input', 'qo-input');
  input.type = 'text';
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  input.placeholder = '输入文件名或路径片段…';
  input.setAttribute('aria-label', '快速打开文件');
  var escKbd = pnlEl('span', 'qo-esc kbd', 'Esc');
  head.append(ic, input, escKbd);
  var list = pnlEl('div', 'qo-list');
  list.setAttribute('role', 'listbox');
  var foot = pnlEl('div', 'qo-foot');
  foot.appendChild(pnlEl('span', 'qo-hint-key', '↑↓ 选择'));
  foot.appendChild(pnlEl('span', 'qo-hint-key', 'Enter 打开'));
  foot.appendChild(pnlEl('span', 'qo-hint-key', 'Esc 关闭'));
  foot.appendChild(pnlEl('span', 'grow'));
  var scope = pnlEl('span', 'qo-scope trunc', pnlBase(ctx.cwd) || ctx.cwd);
  scope.title = ctx.cwd;
  foot.appendChild(scope);
  box.append(head, list, foot);
  ov.appendChild(box);
  ov.classList.add('show');
  pnlQO = {
    el: ov, input: input, list: list, ctx: ctx, sel: 0, files: [],
    seq: 0, timer: 0, loading: false, err: '', prevFocus: document.activeElement
  };
  input.value = prefill == null ? '' : String(prefill);
  input.addEventListener('input', pnlQuickSchedule);
  input.addEventListener('keydown', pnlQuickKeys);
  try { input.focus(); if (input.value) input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
  pnlQuickSearch(input.value);
}

var pnlQO = null;

function pnlQuickSchedule() {
  if (!pnlQO) return;
  clearTimeout(pnlQO.timer);
  pnlQO.timer = setTimeout(function () { if (pnlQO) pnlQuickSearch(pnlQO.input.value); }, 140);
}

function pnlQuickKeys(ev) {
  if (!pnlQO) return;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (pnlQO.files.length) pnlQO.sel = Math.min(pnlQO.files.length - 1, pnlQO.sel + 1);
    pnlPaintQuickSel();
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    pnlQO.sel = Math.max(0, pnlQO.sel - 1);
    pnlPaintQuickSel();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    pnlQuickChoose();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    pnlCloseQuickOpen();
  }
}

function pnlPaintQuickSel() {
  if (!pnlQO) return;
  var rows = pnlQO.list.querySelectorAll('.qo-row');
  for (var i = 0; i < rows.length; i++) {
    var on = i === pnlQO.sel;
    rows[i].classList.toggle('sel', on);
    rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && rows[i].scrollIntoView) rows[i].scrollIntoView({ block: 'nearest' });
  }
}

function pnlPaintQuick() {
  var st = pnlQO;
  if (!st) return;
  var list = st.list;
  list.replaceChildren();
  if (st.loading) { list.appendChild(pnlEl('div', 'qo-hint', '正在搜索…')); return; }
  if (st.err) {
    list.appendChild(pnlErrorBox(st.err, function () { if (pnlQO) pnlQuickSearch(pnlQO.input.value); }));
    return;
  }
  if (!st.files.length) {
    list.appendChild(pnlEl('div', 'qo-hint', st.input.value ? '没有匹配「' + st.input.value + '」的文件' : '输入文件名开始搜索（演示模式含完整目录树）'));
    return;
  }
  for (var i = 0; i < st.files.length; i++) {
    (function (f, idx) {
      var row = pnlEl('div', 'qo-row' + (idx === st.sel ? ' sel' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', idx === st.sel ? 'true' : 'false');
      var ic = pnlEl('span', 'qo-ico ' + pnlColorClass(f.name || f.path));
      ic.innerHTML = pnlIcon('file');
      var mid = pnlEl('span', 'qo-mid');
      var nm = pnlEl('span', 'qo-name');
      nm.innerHTML = pnlHighlight(f.name || pnlBase(f.path), st.input.value);
      var pt = pnlEl('span', 'qo-path trunc', pnlDisplayPath(f.path, st.ctx.cwd));
      mid.append(nm, pt);
      row.append(ic, mid);
      row.onclick = function () { pnlQuickChooseIdx(idx); };
      list.appendChild(row);
    })(st.files[i], i);
  }
}

async function pnlQuickSearch(q) {
  var st = pnlQO;
  if (!st) return;
  var seq = ++st.seq;
  st.loading = true;
  st.err = '';
  pnlPaintQuick();
  var args = pnlArgsIn(st.ctx.cwd, { q: String(q == null ? '' : q), limit: 80 });
  var out = await pnlApi('fs.find', args);
  if (!pnlQO || pnlQO !== st || st.seq !== seq) return;
  st.loading = false;
  if (!out || out.ok === false) st.err = (out && out.error) || '搜索失败';
  else st.files = Array.isArray(out.files) ? out.files : [];
  st.sel = 0;
  pnlPaintQuick();
}

function pnlQuickChooseIdx(idx) {
  var st = pnlQO;
  if (!st) return;
  var f = st.files[idx];
  if (!f) return;
  var cwd = st.ctx.cwd;
  pnlCloseQuickOpen();
  openFilePreview(f.path, { cwd: cwd, name: f.name });
}

function pnlQuickChoose() { if (pnlQO) pnlQuickChooseIdx(pnlQO.sel); }

function pnlCloseQuickOpen() {
  var st = pnlQO;
  var ov = document.getElementById('pnlQuickOpen');
  if (st && st.timer) clearTimeout(st.timer);
  var prev = st && st.prevFocus;
  pnlQO = null;
  if (ov) { ov.classList.remove('show'); ov.replaceChildren(); }
  pnlRestoreFocus(prev);
}

/* =====================================================================
   4. 文件面板（files）：面包屑 + 单层目录列表
   ===================================================================== */

function pnlRenderFiles(body, ctx) {
  var wrap = pnlEl('div', 'pnl pnl-files');
  pnlFit(wrap, body);
  var head = pnlEl('div', 'pnl-head fp-head');
  var crumbs = pnlEl('div', 'fp-crumbs');
  var refresh = pnlIconBtn('refresh', '刷新目录', function () { pnlLoadFiles(true); });
  refresh.classList.add('fp-refresh');
  head.append(crumbs, pnlEl('span', 'grow'), refresh);
  var list = pnlEl('div', 'fp-list');
  wrap.append(head, list);
  body.appendChild(wrap);
  if (!ctx.cwd) {
    pnlPaintFileCrumbs(crumbs, ctx);
    list.appendChild(pnlEmptyBox('folderOpen', '没有打开的工作区',
      '打开一个工作区后，这里会显示它的文件。', '打开工作区', function () {
        if (typeof openWsDialog === 'function') openWsDialog();
      }));
    return;
  }
  pnlPaintFileCrumbs(crumbs, ctx);
  if (!PNL.files.data && !PNL.files.err && !PNL.files.loading) pnlLoadFiles(false);
  pnlPaintFileList(list, ctx);
  if (PNL.files.loading) refresh.classList.add('spin');
}

function pnlPaintFileCrumbs(box, ctx) {
  box.replaceChildren();
  if (!ctx.cwd) { box.appendChild(pnlEl('span', 'fp-crumb-root', '文件')); return; }
  var st = PNL.files;
  var rootBtn = pnlEl('button', 'fp-crumb fp-crumb-root');
  rootBtn.type = 'button';
  rootBtn.title = ctx.cwd;
  rootBtn.innerHTML = pnlIcon('folder') + '<span>' + pnlEsc(pnlBase(ctx.cwd) || '工作区') + '</span>';
  rootBtn.onclick = function () { pnlFileGo(0); };
  box.appendChild(rootBtn);
  for (var i = 0; i < st.stack.length; i++) {
    var sep = pnlEl('span', 'fp-crumb-sep');
    sep.innerHTML = pnlIcon('chevronRight');
    box.appendChild(sep);
    (function (idx) {
      var b = pnlEl('button', 'fp-crumb');
      b.type = 'button';
      b.textContent = st.stack[idx].name;
      b.title = st.stack[idx].path || st.stack[idx].name;
      b.onclick = function () { pnlFileGo(idx + 1); };
      box.appendChild(b);
    })(i);
  }
}

function pnlFileGo(depth) {
  var st = PNL.files;
  if (depth <= 0) { st.stack = []; st.path = ''; }
  else {
    st.stack = st.stack.slice(0, depth);
    st.path = st.stack.length ? st.stack[st.stack.length - 1].path : '';
  }
  st.data = null;
  st.err = '';
  pnlLoadFiles(true);
}

function pnlFileEnter(entry) {
  var st = PNL.files;
  var name = String(entry.name || pnlBase(entry.path) || '');
  st.stack = st.stack.concat([{ name: name, path: entry.path }]);
  st.path = entry.path;
  st.data = null;
  st.err = '';
  pnlLoadFiles(true);
}

async function pnlLoadFiles(force) {
  var st = PNL.files;
  if (st.loading) return;
  if (!force && st.data && st.loadedCwd === PNL.cwd) return;
  st.loading = true;
  st.err = '';
  var out = await pnlApi('fs.list', pnlArgs({ path: st.path || '' }));
  st.loading = false;
  st.loadedCwd = PNL.cwd;
  if (!out || out.ok === false) {
    st.err = (out && out.error) || '读取目录失败';
    st.data = null;
  } else {
    st.data = out;
    st.err = '';
  }
  pnlRepaint('files');
}

function pnlFileRow(entry, ctx) {
  var row = pnlEl('div', 'fp-row' + (entry.dir ? ' is-dir' : ''));
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  var nm = String(entry.name || pnlBase(entry.path) || '');
  var ic = pnlEl('span', 'fp-ico ' + (entry.dir ? 'fi-dir' : pnlColorClass(nm)));
  ic.innerHTML = pnlIcon(entry.dir ? 'folder' : 'file');
  var name = pnlEl('span', 'fp-name trunc', nm);
  var meta = pnlEl('span', 'fp-meta num');
  var bits = [];
  if (!entry.dir && entry.size != null) bits.push(pnlFmtSize(entry.size));
  if (entry.mtime) bits.push(pnlRelTime(entry.mtime));
  meta.textContent = bits.join(' · ');
  row.append(ic, name, pnlEl('span', 'grow'), meta);
  if (entry.dir) {
    var chev = pnlEl('span', 'fp-chev');
    chev.innerHTML = pnlIcon('chevronRight');
    row.appendChild(chev);
  }
  var act = function () {
    if (entry.dir) pnlFileEnter(entry);
    else openFilePreview(entry.path, { cwd: ctx.cwd, name: nm, size: entry.size });
  };
  row.onclick = act;
  row.onkeydown = function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); }
  };
  row.title = entry.path || nm;
  return row;
}

function pnlPaintFileList(list, ctx) {
  var st = PNL.files;
  list.replaceChildren();
  if (st.loading && !st.data) { list.appendChild(pnlLoading('正在读取目录…')); return; }
  if (st.err) {
    list.appendChild(pnlErrorBox(st.err, function () { pnlLoadFiles(true); }));
    return;
  }
  if (!st.data) return;
  var entries = (st.data.entries || []).slice();
  entries.sort(function (a, b) {
    return (Number(!!b.dir) - Number(!!a.dir)) ||
      String(a.name || a.path).localeCompare(String(b.name || b.path), 'zh-Hans-CN');
  });
  if (!entries.length) {
    list.appendChild(pnlEmptyBox('folderOpen', '空目录', '这里还没有文件。'));
    return;
  }
  for (var i = 0; i < entries.length; i++) list.appendChild(pnlFileRow(entries[i], ctx));
  if (st.data.truncated) list.appendChild(pnlEl('div', 'fp-note', '目录项过多，仅显示前一部分'));
}

/* =====================================================================
   5. Git / Worktree 面板（git）
   ===================================================================== */

function pnlStatusMeta(status) {
  var s = String(status || '?').trim().toUpperCase();
  if (s.length > 1) s = s.charAt(0); // 兼容 ?? / MM / AM 之类的两列状态
  if (s === 'M') return { label: 'M', cls: 'M', title: '已修改（Modified）' };
  if (s === 'A') return { label: 'A', cls: 'A', title: '新增（Added）' };
  if (s === 'D') return { label: 'D', cls: 'D', title: '删除（Deleted）' };
  if (s === 'R') return { label: 'R', cls: 'R', title: '重命名（Renamed）' };
  if (s === 'C') return { label: 'C', cls: 'C', title: '复制（Copied）' };
  if (s === 'U' || s === '?' || s === '!') return { label: 'U', cls: 'U', title: '未跟踪（Untracked）' };
  return { label: s.charAt(0) || '?', cls: 'U', title: String(status || '未知状态') };
}

function pnlRenderGit(body, ctx) {
  var wrap = pnlEl('div', 'pnl pnl-git');
  pnlFit(wrap, body);
  body.appendChild(wrap);
  if (!ctx.cwd) {
    wrap.appendChild(pnlEl('div', 'pnl-head', 'Git'));
    var nil = pnlEl('div', 'pnl-body');
    nil.appendChild(pnlEmptyBox('gitBranch', '没有打开的工作区', '打开一个工作区后，这里会显示 Git 状态与 Worktree。', '打开工作区', function () {
      if (typeof openWsDialog === 'function') openWsDialog();
    }));
    wrap.appendChild(nil);
    return;
  }
  if (!PNL.git.status && !PNL.git.nonRepo && !PNL.git.err && !PNL.git.loading) pnlLoadGit(false);
  pnlPaintGit(wrap, ctx);
}

async function pnlLoadGit(force) {
  var st = PNL.git;
  if (st.loading) return;
  if (!force && st.loadedCwd === PNL.cwd && (st.status || st.nonRepo || st.err)) return;
  st.loading = true;
  st.err = '';
  var args = pnlArgs();
  var res = await Promise.all([
    pnlApi('git.status', args),
    pnlApi('git.worktrees', args),
    pnlApi('git.log', pnlArgs({ limit: 5 }))
  ]);
  st.loading = false;
  st.loadedCwd = PNL.cwd;
  var s = res[0], w = res[1], l = res[2];
  if (!s || s.ok === false) {
    var msg = (s && s.error) || '无法读取 Git 状态';
    if (/not a git repository|not a repo|不是.{0,4}仓库|未找到.{0,4}仓库|fatal: not/i.test(msg)) {
      st.nonRepo = true;
      st.status = null;
      st.err = '';
    } else {
      st.err = msg;
      st.status = null;
      st.nonRepo = false;
    }
  } else if (s.repo === false || (!s.root && !s.branch && s.is_main === false)) {
    st.nonRepo = true;
    st.status = null;
  } else {
    st.nonRepo = false;
    st.err = '';
    st.status = s;
    st.worktrees = (w && w.ok !== false && Array.isArray(w.worktrees)) ? w.worktrees
      : (Array.isArray(s.worktrees) ? s.worktrees : []);
    st.root = (w && w.root) || s.root || '';
    st.repoName = (w && w.repo_name) || s.repo || pnlBase(st.root);
    st.commits = (l && l.ok !== false && Array.isArray(l.commits)) ? l.commits : [];
  }
  pnlRepaint('git');
}

function pnlGitHead(ctx) {
  var st = PNL.git;
  var head = pnlEl('div', 'pnl-head gp-head');
  var ic = pnlEl('span', 'gp-head-ico');
  ic.innerHTML = pnlIcon('gitBranch');
  head.appendChild(ic);
  if (st.status) {
    var branch = String(st.status.branch || 'main');
    var bname = pnlEl('span', 'gp-branch mono trunc', branch);
    bname.title = branch;
    head.appendChild(bname);
    if (st.status.detached) head.appendChild(pnlEl('span', 'pill warn', 'detached'));
    var repo = pnlEl('span', 'gp-repo trunc', st.repoName || pnlBase(st.root || ctx.cwd));
    repo.title = st.root || ctx.cwd;
    head.appendChild(repo);
    if (Number(st.status.ahead) > 0) {
      var ahead = pnlEl('span', 'pill gp-ahead', '↑' + st.status.ahead);
      ahead.title = '领先远端 ' + st.status.ahead + ' 个提交';
      head.appendChild(ahead);
    }
    if (Number(st.status.behind) > 0) {
      var behind = pnlEl('span', 'pill gp-behind', '↓' + st.status.behind);
      behind.title = '落后远端 ' + st.status.behind + ' 个提交';
      head.appendChild(behind);
    }
    if (st.status.is_main === false) head.appendChild(pnlEl('span', 'pill', 'worktree'));
  } else if (st.nonRepo) {
    head.appendChild(pnlEl('span', 'gp-branch', '不是 Git 仓库'));
  } else {
    head.appendChild(pnlEl('span', 'gp-branch', 'Git'));
  }
  head.appendChild(pnlEl('span', 'grow'));
  head.appendChild(pnlIconBtn('refresh', '刷新 Git 状态', function () { pnlLoadGit(true); }));
  return head;
}

function pnlSecHead(title, count, extra) {
  var sh = pnlEl('div', 'gp-sec-head');
  sh.appendChild(pnlEl('span', 'gp-sec-title', title));
  if (count != null) {
    var b = pnlEl('span', 'gp-count', String(count));
    if (!count) b.classList.add('zero');
    sh.appendChild(b);
  }
  sh.appendChild(pnlEl('span', 'grow'));
  if (extra) sh.appendChild(extra);
  return sh;
}

function pnlGitChanges(ctx) {
  var st = PNL.git;
  var files = (st.status && st.status.files) || [];
  var sec = pnlEl('section', 'gp-sec');
  sec.appendChild(pnlSecHead('工作区变更', files.length));
  if (!files.length) {
    var clean = pnlEl('div', 'gp-clean');
    var ci = pnlEl('span', 'gp-clean-ico');
    ci.innerHTML = pnlIcon('checkCircle');
    clean.append(ci, pnlEl('span', null, '工作区干净，没有待提交的改动'));
    sec.appendChild(clean);
    return sec;
  }
  var list = pnlEl('div', 'gp-list');
  for (var i = 0; i < files.length; i++) list.appendChild(pnlGitChangeRow(files[i], ctx));
  sec.appendChild(list);
  return sec;
}

function pnlGitChangeRow(f, ctx) {
  var row = pnlEl('div', 'gp-change');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  var sm = pnlStatusMeta(f.status);
  var badge = pnlEl('span', 'gch-badge gch-' + sm.cls, sm.label);
  badge.title = sm.title;
  var full = String(f.path || '');
  var i = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  var dirPart = i > 0 ? full.slice(0, i) : '';
  var basePart = i >= 0 ? full.slice(i + 1) : full;
  var pathWrap = pnlEl('span', 'gch-path');
  if (dirPart) pathWrap.appendChild(pnlEl('span', 'gch-dir', dirPart + '/'));
  pathWrap.appendChild(pnlEl('span', 'gch-name', basePart));
  row.appendChild(badge);
  if (f.staged) {
    var stg = pnlEl('span', 'gch-staged', '暂存');
    stg.title = '已暂存（staged）';
    row.appendChild(stg);
  }
  row.appendChild(pathWrap);
  row.appendChild(pnlEl('span', 'grow'));
  if ((f.add != null && Number(f.add) > 0) || (f.del != null && Number(f.del) > 0)) {
    var stat = pnlEl('span', 'gch-stat num');
    if (Number(f.add) > 0) stat.appendChild(pnlEl('span', 'add', '+' + f.add));
    if (Number(f.del) > 0) stat.appendChild(pnlEl('span', 'del', '-' + f.del));
    row.appendChild(stat);
  }
  row.title = full;
  var act = function () { pnlOpenDiffPreview(full, { cwd: ctx.cwd, staged: !!f.staged, add: f.add, del: f.del }); };
  row.onclick = act;
  row.onkeydown = function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); }
  };
  return row;
}

function pnlGitWorktrees(ctx) {
  var st = PNL.git;
  var wts = st.worktrees || [];
  var addBtn = pnlEl('button', 'btn sm gp-add-wt');
  addBtn.type = 'button';
  addBtn.innerHTML = pnlIcon('plus') + '<span>新建 Worktree</span>';
  addBtn.title = '在当前仓库创建新的 worktree';
  addBtn.onclick = pnlOpenWorktreeDialog;
  var sec = pnlEl('section', 'gp-sec');
  sec.appendChild(pnlSecHead('Worktrees', wts.length, addBtn));
  if (!wts.length) {
    sec.appendChild(pnlEl('div', 'gp-note', '没有 worktree 信息（真实后端由 git.worktrees 返回）'));
    return sec;
  }
  var list = pnlEl('div', 'gp-wts');
  for (var i = 0; i < wts.length; i++) list.appendChild(pnlGitWtRow(wts[i], ctx));
  sec.appendChild(list);
  return sec;
}

function pnlGitWtRow(wt, ctx) {
  var st = PNL.git;
  var row = pnlEl('div', 'gp-wt');
  var info = pnlEl('div', 'gp-wt-info');
  var main = pnlEl('div', 'gp-wt-main');
  var ic = pnlEl('span', 'gp-wt-ico');
  ic.innerHTML = pnlIcon(wt.detached ? 'gitCommit' : 'gitBranch');
  var branch = pnlEl('span', 'gp-wt-branch mono trunc', wt.branch || (wt.detached ? '(detached)' : '(未知分支)'));
  branch.title = wt.branch || '';
  main.append(ic, branch);
  if (wt.current) main.appendChild(pnlEl('span', 'pill accent', '当前'));
  if (wt.is_main) main.appendChild(pnlEl('span', 'pill', '主仓库'));
  if (wt.locked) main.appendChild(pnlEl('span', 'pill warn', '锁定'));
  if (wt.prunable) main.appendChild(pnlEl('span', 'pill warn', '可清理'));
  var rel = pnlRelPath(wt.path, st.root || ctx.cwd);
  if (rel === '.') rel = '仓库根目录';
  var pathEl = pnlEl('div', 'gp-wt-path mono trunc', rel);
  pathEl.title = String(wt.path || '');
  info.append(main, pathEl);
  var acts = pnlEl('div', 'gp-wt-actions');
  var openBtn = pnlEl('button', 'btn sm', '打开');
  openBtn.type = 'button';
  openBtn.title = wt.current ? '已经是当前工作区' : '打开为工作区：' + (wt.path || '');
  openBtn.disabled = !!wt.current;
  openBtn.onclick = function () { pnlOpenWorktree(wt); };
  var rmBtn = pnlEl('button', 'btn ghost sm danger', '移除');
  rmBtn.type = 'button';
  rmBtn.title = (wt.current || wt.is_main) ? '不能移除当前 / 主仓库 worktree' : '移除 worktree（保留分支）';
  rmBtn.disabled = !!(wt.current || wt.is_main);
  rmBtn.onclick = function () { pnlRemoveWorktree(wt); };
  acts.append(openBtn, rmBtn);
  row.append(info, acts);
  return row;
}

function pnlGitCommits() {
  var st = PNL.git;
  var commits = st.commits || [];
  var sec = pnlEl('section', 'gp-sec');
  sec.appendChild(pnlSecHead('最近提交', null));
  if (!commits.length) {
    sec.appendChild(pnlEl('div', 'gp-note', '没有提交记录'));
    return sec;
  }
  var list = pnlEl('div', 'gp-commits');
  for (var i = 0; i < commits.length; i++) {
    var c = commits[i];
    var row = pnlEl('div', 'gp-commit');
    var hash = pnlEl('span', 'gcommit-hash mono', c.short || String(c.hash || '').slice(0, 7));
    var subj = pnlEl('span', 'gcommit-subject trunc', c.subject || '');
    var rel = pnlEl('span', 'gcommit-rel', c.rel || pnlRelTime(c.time));
    row.append(hash, subj, rel);
    row.title = String(c.hash || '') + '\n' + String(c.subject || '') + '\n' + String(c.author || '');
    list.appendChild(row);
  }
  sec.appendChild(list);
  return sec;
}

function pnlGitNonRepo(ctx) {
  var card = pnlEl('div', 'gp-nonrepo');
  var ic = pnlEl('div', 'gp-nonrepo-ico');
  ic.innerHTML = pnlIcon('gitBranch');
  card.appendChild(ic);
  card.appendChild(pnlEl('div', 'gp-nonrepo-title', '不是 Git 仓库'));
  card.appendChild(pnlEl('div', 'gp-nonrepo-desc', ctx.cwd));
  var row = pnlEl('div', 'gp-nonrepo-actions');
  var init = pnlEl('button', 'btn primary sm', '初始化仓库');
  init.type = 'button';
  init.onclick = pnlInitRepo;
  var recheck = pnlEl('button', 'btn sm', '重新检测');
  recheck.type = 'button';
  recheck.onclick = function () { pnlLoadGit(true); };
  row.append(init, recheck);
  card.appendChild(row);
  card.appendChild(pnlEl('div', 'gp-nonrepo-hint', '会在当前工作区执行 git init，之后可以创建 worktree。'));
  return card;
}

async function pnlInitRepo() {
  var out = await pnlApi('git.init', pnlArgs());
  if (!out || out.ok === false) {
    pnlToast((out && out.error) || '初始化 Git 仓库失败', 'bad');
    return;
  }
  pnlToast('已初始化 Git 仓库', 'ok');
  PNL.git = { status: null, worktrees: [], commits: [], err: '', loading: false, nonRepo: false, loadedCwd: '', root: '', repoName: '' };
  pnlLoadGit(true);
}

function pnlOpenWorktree(wt) {
  if (!wt || !wt.path) return;
  if (typeof openWorkspace === 'function') { openWorkspace(wt.path); return; }
  pnlApi('workspace.open', { cwd: wt.path }).then(function (out) {
    if (out && out.ok !== false) {
      if (typeof resync === 'function') resync();
    } else {
      pnlToast((out && out.error) || '打开工作区失败', 'bad');
    }
  });
}

async function pnlRemoveWorktree(wt) {
  if (!wt || !wt.path) return;
  var label = '移除 worktree「' + (wt.branch || pnlBase(wt.path)) + '」？\n\n' + wt.path +
    '\n\n分支本身会保留，只删除对应的检出目录。';
  var ok = true;
  if (typeof confirmDlg === 'function') ok = await confirmDlg(label, { title: '移除 Worktree', ok: '移除' });
  if (!ok) return;
  var out = await pnlApi('git.worktree.remove', pnlArgs({ path: wt.path }));
  if (!out || out.ok === false) {
    pnlToast((out && out.error) || '移除 worktree 失败', 'bad');
    return;
  }
  pnlToast('已移除 worktree', 'ok');
  PNL.git.loadedCwd = '';
  pnlLoadGit(true);
}

function pnlValidateBranch(b) {
  var s = String(b || '').trim();
  if (!s) return '请输入分支名';
  if (s.length > 121) return '分支名过长（最多 121 个字符）';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(s)) return '分支名只能包含字母、数字、点、下划线、斜杠与连字符，且不能以 - 开头';
  if (s.indexOf('..') >= 0) return '分支名不能包含连续的 ..';
  if (/\.lock$/i.test(s)) return '分支名不能以 .lock 结尾';
  if (/\/$/.test(s)) return '分支名不能以 / 结尾';
  return '';
}

async function pnlOpenWorktreeDialog() {
  var st = PNL.git;
  if (!st.status) { pnlToast('Git 仓库尚未就绪，先刷新一下', 'bad'); return; }
  if (typeof showModal !== 'function' || typeof closeModal !== 'function') {
    pnlToast('弹窗组件不可用，无法创建 worktree', 'bad');
    return;
  }
  var root = st.root || pnlCtx().cwd;
  var curBranch = st.status.branch || 'main';
  var brOut = await pnlApi('git.branches', pnlArgs());
  var locals = (brOut && brOut.ok !== false && Array.isArray(brOut.local)) ? brOut.local.slice() : [];
  if (locals.indexOf(curBranch) < 0) locals.unshift(curBranch);
  if (!locals.length) locals = [curBranch];
  var currentBase = (brOut && brOut.current) || curBranch;
  var sep = pnlSepFor(root);
  var els = {};
  var state = { pathTouched: false, submitting: false };
  function defaultPath(branch) {
    var safe = String(branch || '').replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    if (!safe) safe = 'worktree';
    return String(root || '').replace(/[\\/]+$/, '') + sep + '.worktrees' + sep + safe;
  }
  function submit() {
    if (state.submitting) return;
    var branch = String(els.branch.value || '').trim();
    var base = String(els.base.value || '');
    var path = String(els.path.value || '').trim();
    var createBranch = !!els.createNew.checked;
    var openAfter = !!els.openAfter.checked;
    var err = pnlValidateBranch(branch);
    if (err) { els.err.textContent = err; els.err.hidden = false; els.branch.focus(); return; }
    if (!path) path = defaultPath(branch);
    state.submitting = true;
    els.err.hidden = true;
    var a = {
      ws: (typeof S !== 'undefined' && S.active) || '',
      cwd: root, branch: branch, path: path, create_branch: createBranch
    };
    if (createBranch && base) a.base = base;
    pnlApi('git.worktree.add', a).then(function (out) {
      state.submitting = false;
      if (!out || out.ok === false) {
        els.err.textContent = (out && out.error) || '创建 worktree 失败';
        els.err.hidden = false;
        return;
      }
      try { closeModal(); } catch (e) {}
      pnlToast('已创建 worktree ' + (out.branch || branch), 'ok');
      PNL.git.loadedCwd = '';
      pnlLoadGit(true);
      if (openAfter && out.path) pnlOpenWorktree({ path: out.path, branch: out.branch || branch });
    });
  }
  showModal('新建 Worktree', '', [
    { label: '取消', fn: function () { closeModal(); } },
    { label: '创建', cls: 'primary', fn: submit }
  ], function (body) {
    var form = pnlEl('div', 'wt-form');
    var f1 = pnlEl('div', 'wt-field');
    f1.appendChild(pnlEl('label', null, '分支名'));
    els.branch = pnlEl('input', 'wt-branch');
    els.branch.type = 'text';
    els.branch.placeholder = 'feat/my-feature';
    els.branch.setAttribute('spellcheck', 'false');
    f1.appendChild(els.branch);
    form.appendChild(f1);

    var f2 = pnlEl('div', 'wt-field');
    f2.appendChild(pnlEl('label', null, '基于分支'));
    els.base = pnlEl('select', 'wt-base');
    for (var i = 0; i < locals.length; i++) {
      var op = document.createElement('option');
      op.value = locals[i];
      op.textContent = locals[i];
      if (locals[i] === currentBase) op.selected = true;
      els.base.appendChild(op);
    }
    f2.appendChild(els.base);
    form.appendChild(f2);

    var f3 = pnlEl('div', 'wt-field');
    f3.appendChild(pnlEl('label', null, '路径'));
    els.path = pnlEl('input', 'wt-path');
    els.path.type = 'text';
    els.path.value = defaultPath('');
    els.path.setAttribute('spellcheck', 'false');
    f3.appendChild(els.path);
    form.appendChild(f3);
    form.appendChild(pnlEl('div', 'wt-hint', '默认路径 .worktrees/<分支名>，创建后会加入 .git/info/exclude'));

    var sw1 = pnlEl('label', 'wt-sw');
    els.createNew = pnlEl('input', 'wt-newbranch');
    els.createNew.type = 'checkbox';
    els.createNew.checked = true;
    var tr1 = pnlEl('span', 'wt-sw-track');
    sw1.append(els.createNew, tr1, pnlEl('span', 'wt-sw-label', '创建新分支（基于上面的分支）'));
    form.appendChild(sw1);

    var sw2 = pnlEl('label', 'wt-sw');
    els.openAfter = pnlEl('input', 'wt-open');
    els.openAfter.type = 'checkbox';
    els.openAfter.checked = true;
    var tr2 = pnlEl('span', 'wt-sw-track');
    sw2.append(els.openAfter, tr2, pnlEl('span', 'wt-sw-label', '创建后打开为工作区'));
    form.appendChild(sw2);

    els.err = pnlEl('div', 'wt-err');
    els.err.hidden = true;
    form.appendChild(els.err);

    els.branch.addEventListener('input', function () {
      if (!state.pathTouched) els.path.value = defaultPath(els.branch.value);
    });
    els.path.addEventListener('input', function () { state.pathTouched = String(els.path.value || '').trim() !== ''; });
    els.createNew.addEventListener('change', function () {
      els.base.disabled = !els.createNew.checked;
      if (!els.createNew.checked) els.base.title = '检出已有分支时忽略「基于分支」';
      else els.base.title = '';
    });
    body.appendChild(form);
    setTimeout(function () { try { els.branch.focus(); } catch (e) {} }, 30);
  });
}

function pnlPaintGit(wrap, ctx) {
  wrap.replaceChildren();
  var st = PNL.git;
  wrap.appendChild(pnlGitHead(ctx));
  var scroll = pnlEl('div', 'pnl-body gp-body');
  wrap.appendChild(scroll);
  if (st.loading && !st.status && !st.nonRepo && !st.err) {
    scroll.appendChild(pnlLoading('正在读取 Git 状态…'));
    return;
  }
  if (st.err) {
    scroll.appendChild(pnlErrorBox(st.err, function () { pnlLoadGit(true); }));
    return;
  }
  if (st.nonRepo) {
    scroll.appendChild(pnlGitNonRepo(ctx));
    return;
  }
  if (!st.status) return;
  scroll.appendChild(pnlGitChanges(ctx));
  scroll.appendChild(pnlGitWorktrees(ctx));
  scroll.appendChild(pnlGitCommits());
}

/* =====================================================================
   6. 终端面板（terminal）：真实终端（PTY shell + VT 模拟器）
   ---------------------------------------------------------------------
   终端不再是"命令表单 + 执行按钮"：08c-term.js 提供 window.CellTerm
   （VT 解析/渲染 + 会话控制器 + 演示模式假 shell），这一节只负责面板外壳
   与会话生命周期：
     · 面板默认是空的（没有 shell，也没有请求）：点「新建终端」才有；
     · 一个工作区可以有多个终端，每个 = 一个后端会话（独立读线程）。切终端
       只是把旧 view detach 出文档，会话继续跑，切回来整屏重绘；
     · 页面刷新用 term.list 把仍在跑的 shell 接管成页签（term.open {id} +
       backlog 重放）；终止走 term.close（pty 与读线程一起收掉）；
     · 面板重绘时复用同一个 .ct-root，不重放 backlog、不闪屏、不丢焦点；
     · 后端由 08c-term.js 通过 term.open / term.input / term.resize /
       term.close 驱动，输出走 SSE 的 term.out / term.exit 事件。
   ===================================================================== */

// ---- 多终端状态 ------------------------------------------------------
// 终端面板默认是空的：用户点「新建终端」才有 shell。一个工作区可以有多个
// 终端（各自一个后端会话 + 独立读线程，见 cell-app-term.hpp），面板顶部
// 下拉切换；切走的终端只是从文档里 detach，会话照常在后台跑。
function pnlTermWsKey(ctx) {
  return (ctx && (ctx.ws || ctx.cwd)) || '';
}

function pnlTermItems(wsKey) {
  var out = [];
  var list = (PNL.term && PNL.term.items) || [];
  for (var i = 0; i < list.length; i++) if (list[i].ws === wsKey) out.push(list[i]);
  return out;
}

function pnlTermItem(key) {
  var list = (PNL.term && PNL.term.items) || [];
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}

function pnlTermActiveItem(wsKey) {
  var items = pnlTermItems(wsKey);
  if (!items.length) return null;
  var key = PNL.term.active[wsKey];
  for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i];
  // 当前项被关掉了（或首次渲染）：落到最后一个
  PNL.term.active[wsKey] = items[items.length - 1].key;
  return items[items.length - 1];
}

// 显示名：后端给的 shell 名（powershell / bash / cmd）；同名多个时补序号
function pnlTermLabel(item) {
  if (!item) return '';
  var base = String(item.name || '').trim() || '终端';
  var items = pnlTermItems(item.ws);
  var idx = items.indexOf(item);
  var dup = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i] === item) continue;
    if ((String(items[i].name || '').trim() || '终端') === base) { dup = true; break; }
  }
  return dup ? base + ' ' + (idx + 1) : base;
}

function pnlTermIsDemo() {
  try { return typeof S !== 'undefined' && S.mode === 'demo'; } catch (e) {}
  try { return typeof MOCK !== 'undefined' && !!MOCK; } catch (e) {}
  return false;
}

// 当前挂在文档里的 view（切换终端时用来先 detach 旧的）
function pnlTermAttached() {
  return (PNL.term && PNL.term.attached) || null;
}

function pnlTermStateText(st) {
  if (!st) return '';
  if (st.kind === 'connecting') return '连接中…';
  if (st.kind === 'ready') return '就绪';
  if (st.kind === 'demo') return '演示模式';
  if (st.kind === 'exited') return '已退出' + (st.code == null ? '' : ' (exit ' + st.code + ')');
  if (st.kind === 'error') return '不可用';
  return st.text || '';
}

function pnlTermApplyState(el, st) {
  if (!el) return;
  var txt = pnlTermStateText(st);
  var cls = 'tp-state';
  if (st && st.kind === 'ready') cls += ' ok';
  else if (st && (st.kind === 'exited' || st.kind === 'error')) cls += ' bad';
  else if (st && st.kind === 'connecting') cls += ' wait';
  el.className = cls;
  el.textContent = txt;
  if (txt) el.title = (st && st.text) || txt;
  else el.removeAttribute('title');
}

function pnlTermNotice(icon, title, desc, actionLabel, actionFn) {
  var box = pnlEl('div', 'tp-notice');
  var ic = pnlEl('div', 'tp-notice-ico');
  ic.innerHTML = pnlIcon(icon);
  box.appendChild(ic);
  box.appendChild(pnlEl('div', 'tp-notice-title', title));
  if (desc) box.appendChild(pnlEl('div', 'tp-notice-desc', desc));
  if (actionLabel && actionFn) {
    var b = pnlEl('button', 'btn sm', actionLabel);
    b.type = 'button';
    b.onclick = actionFn;
    box.appendChild(b);
  }
  return box;
}

// 终端面板外壳（head / host / foot + 工具按钮）。构建与更新分开：dock 的
// 重复重绘走 pnlTermUpdateInPlace，绝不摘掉 .ct-root——摘掉会让 .ct-ime
// 失焦，用户后续按键全部丢失。
function pnlTermChrome(wrap, ctx) {
  // 重新建外观时把上一个外壳（可能还开着的下拉）收起，别留着 document 监听
  if (PNL.term.ui) pnlTermMenuClose(PNL.term.ui);
  var head = pnlEl('div', 'pnl-head tp-head');
  var ic = pnlEl('span', 'tp-head-ico');
  ic.innerHTML = pnlIcon('squareTerminal');
  var title = pnlEl('span', 'tp-title', '终端');

  // 终端切换器：标题就是下拉按钮（终端名 + 数量 + caret）
  var picker = pnlEl('button', 'tp-picker');
  picker.type = 'button';
  picker.title = '切换终端';
  picker.setAttribute('aria-haspopup', 'menu');
  picker.hidden = true;
  var pickerIco = pnlEl('span', 'tp-picker-ico');
  pickerIco.innerHTML = pnlIcon('squareTerminal');
  var pickerName = pnlEl('span', 'tp-picker-name trunc', '终端');
  var pickerCount = pnlEl('span', 'tp-picker-count', '');
  pickerCount.hidden = true;
  var pickerCaret = pnlEl('span', 'tp-picker-caret');
  pickerCaret.innerHTML = pnlIcon('chevronDown');
  picker.append(pickerIco, pickerName, pickerCount, pickerCaret);

  var cwdEl = pnlEl('span', 'tp-cwd mono trunc grow', ctx.cwd || '没有工作区');
  cwdEl.title = ctx.cwd || '';
  var stateEl = pnlEl('span', 'tp-state', '');
  var host = pnlEl('div', 'tp-host');
  var menu = pnlEl('div', 'tp-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  head.appendChild(menu); // 绝对定位在头部下方

  var ui = {
    wrap: wrap, head: head, host: host, menu: menu, ctx: ctx,
    wsKey: pnlTermWsKey(ctx), title: title, picker: picker,
    pickerName: pickerName, pickerCount: pickerCount, cwdEl: cwdEl, stateEl: stateEl
  };

  var addBtn = pnlIconBtn('plus', '新建终端', function () { pnlTermNew(ui); });
  addBtn.classList.add('tp-add');
  var copyBtn = pnlIconBtn('copy', '复制选中内容（Ctrl+Shift+C）', function () {
    var v = pnlTermAttached();
    if (!v || !window.CellTerm || !CellTerm.copySelection) return;
    Promise.resolve(CellTerm.copySelection(v)).then(function (ok) {
      pnlToast(ok ? '已复制选中内容' : '没有选中内容', ok ? 'ok' : 'warn');
    }).catch(function () {});
  });
  var killBtn = pnlIconBtn('stop', '终止当前终端（关闭这个 shell）', function () {
    var item = pnlTermActiveItem(ui.wsKey);
    if (item) pnlTermKill(ui, item);
  });
  killBtn.classList.add('tp-kill');
  // 头部只留最常用的三个：新建 / 复制选中 / 终止（右栏宽度有限，清屏交给
  // shell 的 cls，重启交给状态条上的「重试」→ CellTerm.restart）
  ui.btns = { add: addBtn, copy: copyBtn, kill: killBtn };

  picker.onclick = function (ev) {
    ev.stopPropagation();
    pnlTermToggleMenu(ui);
  };

  head.append(ic, title, picker, cwdEl, stateEl, addBtn, copyBtn, killBtn);

  var foot = pnlEl('div', 'tp-foot');
  foot.appendChild(pnlEl('span', 'tp-foot-txt',
    '终端各自独立运行 · Tab 补全 · ↑↓ 历史 · Ctrl+Shift+C/V 复制粘贴 · Shift+PgUp/PgDn 回看'));
  wrap.append(head, host, foot);
  wrap.__pnlUi = ui;
  PNL.term.ui = ui;
  return ui;
}

function pnlTermBuild(body, ctx) {
  var wrap = pnlEl('div', 'pnl pnl-term');
  pnlFit(wrap, body);
  wrap.dataset.pnlKey = pnlTermWsKey(ctx);
  var ui = pnlTermChrome(wrap, ctx);
  body.appendChild(wrap);
  return ui;
}

/* ---- 终端下拉：列出本工作区的所有终端，可切换 / 单个终止 / 新建 ---- */
function pnlTermMenuClose(ui) {
  if (!ui || !ui.menu) return;
  ui.menu.hidden = true;
  if (ui.menuDocHandler) {
    document.removeEventListener('mousedown', ui.menuDocHandler, true);
    ui.menuDocHandler = null;
  }
  if (ui.menuKeyHandler) {
    document.removeEventListener('keydown', ui.menuKeyHandler, true);
    ui.menuKeyHandler = null;
  }
  if (ui.picker) ui.picker.classList.remove('open');
}

function pnlTermToggleMenu(ui) {
  if (!ui || !ui.menu) return;
  if (!ui.menu.hidden) { pnlTermMenuClose(ui); return; }
  pnlTermPaintMenu(ui);
  ui.menu.hidden = false;
  if (ui.picker) ui.picker.classList.add('open');
  // 点面板别处 / 别的地方就收起（capture：先于行上的 click 生效，但不影响行）
  ui.menuDocHandler = function (ev) {
    if (ui.menu.contains(ev.target)) return;
    if (ui.picker && ui.picker.contains(ev.target)) return;
    pnlTermMenuClose(ui);
  };
  document.addEventListener('mousedown', ui.menuDocHandler, true);
  ui.menuKeyHandler = function (ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    pnlTermMenuClose(ui);
    if (ui.picker) { try { ui.picker.focus(); } catch (e) {} }
  };
  document.addEventListener('keydown', ui.menuKeyHandler, true);
}

function pnlTermPaintMenu(ui) {
  var menu = ui.menu;
  if (!menu) return;
  var items = pnlTermItems(ui.wsKey);
  var active = pnlTermActiveItem(ui.wsKey);
  menu.replaceChildren();
  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var row = pnlEl('div', 'tp-menu-row' + (item === active ? ' on' : ''));
      row.tabIndex = 0;
      row.setAttribute('role', 'menuitem');
      row.title = pnlTermLabel(item) + (item.cwd ? '\n' + item.cwd : '');
      var ic = pnlEl('span', 'tp-menu-ico');
      ic.innerHTML = pnlIcon('squareTerminal');
      var mid = pnlEl('span', 'tp-menu-mid');
      mid.appendChild(pnlEl('span', 'tp-menu-name trunc', pnlTermLabel(item)));
      var sub = [];
      var stTxt = pnlTermStateText(item.status);
      if (stTxt) sub.push(stTxt);
      if (item.cwd) sub.push(pnlBase(item.cwd) || item.cwd);
      mid.appendChild(pnlEl('span', 'tp-menu-sub trunc', sub.join(' · ') || '终端'));
      var kill = pnlEl('button', 'tp-menu-kill');
      kill.type = 'button';
      kill.title = '终止这个终端';
      kill.setAttribute('aria-label', '终止终端');
      kill.innerHTML = pnlIcon('stop');
      kill.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        pnlTermKill(ui, item);
      };
      row.append(ic, mid, kill);
      row.onclick = function () { pnlTermSelect(ui, item.key); };
      row.onkeydown = function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pnlTermSelect(ui, item.key); }
      };
      menu.appendChild(row);
    })(items[i]);
  }
  var add = pnlEl('div', 'tp-menu-row tp-menu-add');
  add.tabIndex = 0;
  add.setAttribute('role', 'menuitem');
  var aic = pnlEl('span', 'tp-menu-ico');
  aic.innerHTML = pnlIcon('plus');
  add.append(aic, pnlEl('span', 'tp-menu-add-txt', '新建终端'));
  add.onclick = function () { pnlTermNew(ui); };
  add.onkeydown = function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pnlTermNew(ui); }
  };
  menu.appendChild(add);
}

/* ---- 视图 <-> 状态 ---- */
function pnlTermBindView(ui, item, view) {
  view.onStatus = function (st) {
    item.status = st || null;
    if (st && st.name && !item.name) item.name = st.name;
    if (st && st.id) item.attachId = null;
    var act = pnlTermActiveItem(ui.wsKey);
    if (act === item) pnlTermPaintChrome(ui);
    if (ui.menu && !ui.menu.hidden) pnlTermPaintMenu(ui);
  };
  if (view.status) item.status = view.status;
}

function pnlTermMakeView(ui, item) {
  if (!window.CellTerm || typeof CellTerm.mount !== 'function') return null;
  var view = CellTerm.mount(ui.host, {
    ws: ui.ctx.ws,
    cwd: item.cwd || ui.ctx.cwd,
    id: item.attachId || null,
    name: item.name || ''
  });
  if (!view) return null;
  item.view = view;
  pnlTermBindView(ui, item, view);
  return view;
}

function pnlTermFocusSoon() {
  if (typeof window === 'undefined' || !window.requestAnimationFrame) return;
  window.requestAnimationFrame(function () {
    var v = pnlTermAttached();
    if (v && v.root && v.root.isConnected && window.CellTerm && CellTerm.focus) {
      try { CellTerm.focus(v); } catch (e) {}
    }
  });
}

// host 里只放「空态提示」或「当前终端的 .ct-root」；后台终端 detach 掉，
// 会话继续跑（输出照常写进它自己的 VT 历史）。
function pnlTermPaintHost(ui) {
  var host = ui.host;
  if (!host) return;
  var item = pnlTermActiveItem(ui.wsKey);
  var prev = pnlTermAttached();

  if (!item) {
    if (prev && window.CellTerm && CellTerm.detach) { try { CellTerm.detach(prev); } catch (e) {} }
    PNL.term.attached = null;
    host.replaceChildren();
    host.appendChild(pnlTermNotice('squareTerminal', '还没有终端',
      '终端默认是空的：新建一个 shell 开始使用。可以同时开多个（各自独立运行），用标题栏的下拉切换。',
      '新建终端', function () { pnlTermNew(ui); }));
    return;
  }

  if (!item.view) {
    if (prev && window.CellTerm && CellTerm.detach) { try { CellTerm.detach(prev); } catch (e) {} }
    PNL.term.attached = null;
    host.replaceChildren(); // 清掉空态提示
    pnlTermMakeView(ui, item);
  } else if (prev && prev !== item.view && window.CellTerm && CellTerm.detach) {
    try { CellTerm.detach(prev); } catch (e) {}
    PNL.term.attached = null;
  }

  var view = item.view;
  if (!view || !view.root) {
    host.replaceChildren();
    host.appendChild(pnlTermNotice('alert', '终端组件未加载',
      '缺少 src/ui/src/js/08c-term.js：运行 python build_ui.py 重新生成页面后刷新。'));
    PNL.term.attached = null;
    return;
  }
  var kids = Array.prototype.slice.call(host.children);
  for (var i = 0; i < kids.length; i++) if (kids[i] !== view.root) kids[i].remove();
  PNL.term.attached = view;
  if (view.root.parentNode !== host) {
    if (window.CellTerm && CellTerm.attach) CellTerm.attach(view, host);
    else host.appendChild(view.root);
  } else if (window.CellTerm && CellTerm.refit) {
    try { CellTerm.refit(view); } catch (e) {}
  }
}

function pnlTermPaintChrome(ui) {
  if (!ui) return;
  var items = pnlTermItems(ui.wsKey);
  var item = pnlTermActiveItem(ui.wsKey);
  if (!item) pnlTermMenuClose(ui); // 没有终端了：下拉连同菜单一起收起
  if (ui.title) ui.title.hidden = !!item;
  if (ui.picker) {
    ui.picker.hidden = !item;
    if (ui.pickerName) ui.pickerName.textContent = item ? pnlTermLabel(item) : '';
    if (ui.pickerCount) {
      ui.pickerCount.hidden = items.length < 2;
      ui.pickerCount.textContent = items.length > 1 ? String(items.length) : '';
    }
  }
  var cwd = (item && item.cwd) || ui.ctx.cwd || '';
  if (ui.cwdEl) {
    var txt = cwd || '没有工作区';
    if (ui.cwdEl.textContent !== txt) ui.cwdEl.textContent = txt;
    if (ui.cwdEl.title !== cwd) ui.cwdEl.title = cwd;
  }
  pnlTermApplyState(ui.stateEl, item ? item.status : null);
  var has = !!item;
  var b = ui.btns || {};
  if (b.copy) b.copy.disabled = !has;
  if (b.kill) b.kill.disabled = !has;
  if (ui.menu && !ui.menu.hidden) pnlTermPaintMenu(ui);
}

function pnlTermSync(ui) {
  if (!ui || !ui.host) return;
  pnlTermPaintHost(ui);
  pnlTermPaintChrome(ui);
}

/* ---- 新建 / 切换 / 终止 ---- */
function pnlTermNew(ui) {
  if (!ui || !ui.ctx || !ui.ctx.cwd) return;
  var item = {
    key: 'tk' + (++PNL.term.seq), ws: ui.wsKey, cwd: ui.ctx.cwd || '',
    name: '', attachId: null, view: null, status: null
  };
  PNL.term.items.push(item);
  PNL.term.active[ui.wsKey] = item.key;
  pnlTermMenuClose(ui);
  pnlTermSync(ui);
  pnlTermFocusSoon();
}

function pnlTermSelect(ui, key) {
  if (!ui) return;
  var item = pnlTermItem(key);
  if (!item) return;
  pnlTermMenuClose(ui);
  PNL.term.active[ui.wsKey] = item.key;
  pnlTermSync(ui);
  pnlTermFocusSoon();
}

function pnlTermKill(ui, item) {
  if (!ui || !item) return Promise.resolve(false);
  var items = pnlTermItems(ui.wsKey);
  var idx = items.indexOf(item);
  var wasActive = (PNL.term.active[ui.wsKey] === item.key);
  var view = item.view;
  if (view && pnlTermAttached() === view) PNL.term.attached = null;
  item.view = null;
  var at = PNL.term.items.indexOf(item);
  if (at >= 0) PNL.term.items.splice(at, 1);
  if (wasActive) {
    var rest = pnlTermItems(ui.wsKey);
    PNL.term.active[ui.wsKey] = rest.length ? rest[Math.min(idx, rest.length - 1)].key : '';
  }
  var p = Promise.resolve(true);
  if (view && window.CellTerm && CellTerm.close) {
    try { p = Promise.resolve(CellTerm.close(view)).catch(function () { return false; }); } catch (e) {}
  }
  pnlTermSync(ui);
  pnlTermFocusSoon();
  return p;
}

// 页面刷新 / 换客户端后，后端可能还有这个工作区的 shell：接管成页签
// （term.list 拿到会话列表，点开时按 id 重新 attach + backlog 重放）。
function pnlTermAdopt(ui) {
  if (!ui) return;
  var wsKey = ui.wsKey;
  if (!wsKey || PNL.term.listed[wsKey]) return;
  PNL.term.listed[wsKey] = true;
  if (pnlTermIsDemo()) return; // 演示模式的终端是本地的，没有后端会话可接管
  if (!window.CellTerm || typeof CellTerm.mount !== 'function') return;
  var args = { ws: ui.ctx.ws || '' };
  if (ui.ctx.cwd) args.cwd = ui.ctx.cwd;
  pnlApi('term.list', args).then(function (out) {
    if (!out || out.ok === false || !Array.isArray(out.sessions) || !out.sessions.length) return;
    var seen = {};
    var list = PNL.term.items;
    for (var i = 0; i < list.length; i++) if (list[i].ws === wsKey && list[i].attachId) seen[list[i].attachId] = 1;
    var added = 0;
    for (var k = 0; k < out.sessions.length; k++) {
      var s = out.sessions[k];
      if (!s || !s.id || s.alive === false || seen[s.id]) continue;
      PNL.term.items.push({
        key: 'tk' + (++PNL.term.seq), ws: wsKey, cwd: s.cwd || ui.ctx.cwd || '',
        name: s.name || pnlBase(s.shell || '') || '', attachId: s.id, view: null, status: null
      });
      added++;
    }
    if (!added) return;
    if (ui.wrap && ui.wrap.isConnected && ui.wrap.__pnlUi === ui) pnlTermSync(ui);
  });
}

function pnlRenderTerm(body, ctx) {
  var ui = pnlTermBuild(body, ctx);
  body.dataset.pnl = 'terminal';
  if (!ctx.cwd) {
    ui.host.appendChild(pnlTermNotice('squareTerminal', '先打开一个工作区',
      '终端需要一个工作目录：用左侧「打开工作区」选一个目录后即可新建 shell。'));
    pnlTermPaintChrome(ui);
    return;
  }
  pnlTermAdopt(ui);
  pnlTermSync(ui);
}

// dock 原地重绘（SSE / 状态变化触发的 Panels.render('terminal')）：容器与
// 当前 .ct-root 都不动，只刷新头部与状态，键盘焦点不会被打断。
function pnlTermUpdateInPlace(body, ctx) {
  if (!body || body.dataset.pnl !== 'terminal') return false;
  if (!ctx.cwd) return false;
  var wrap = body.firstElementChild;
  if (!wrap || !wrap.classList || !wrap.classList.contains('pnl-term')) return false;
  if (wrap.dataset.pnlKey !== pnlTermWsKey(ctx)) return false;
  var ui = wrap.__pnlUi;
  if (!ui || !ui.host) return false;
  ui.ctx = ctx;
  pnlTermSync(ui);
  return true;
}

// 面板重建（switch workspace / dock 页签 / 强制重绘）会 replaceChildren，
// .ct-root 在"同一帧内"被摘掉再挂回：Chromium 在摘除完成的瞬间就派发 blur
// 且此时 isConnected 仍是 true，单靠 blur 事件判断不可靠。所以重建前先
// 记下"焦点在终端里"，重建后由这里在下一帧把焦点还回去（不抢普通点击）。
function pnlTermFocusInBody(body) {
  try {
    var a = document.activeElement;
    return !!(body && a && a.classList && a.classList.contains('ct-ime') && body.contains(a));
  } catch (e) { return false; }
}

function pnlTermFocusRestore(body) {
  var host = body && body.querySelector ? body.querySelector('.tp-host') : null;
  if (!host) return false;
  var view = pnlTermAttached();
  if (!view || !view.imeEl) return false;
  // 等一帧：让 CellTerm.refit 的 measure/applyResize 先跑完再接管焦点
  window.requestAnimationFrame(function () {
    if (!view.root || !view.root.isConnected || !view.imeEl) return;
    if (document.activeElement === view.imeEl) return;
    try { view.imeEl.focus({ preventScroll: true }); } catch (e) {}
  });
  return true;
}

/* =====================================================================
   7. 面板注册表 + 全局快捷键 + 启动垫片
   ===================================================================== */

function pnlRepaint(name) {
  var body = document.getElementById('dockBody');
  if (!body || body.dataset.pnl !== name) return;
  Panels.render(name, body, (typeof curTab === 'function' ? curTab() : null));
}

var Panels = {
  names: ['files', 'git', 'terminal'],
  has: function (name) { return this.names.indexOf(name) >= 0; },
  render: function (name, body, tab) {
    try {
      if (!body) return;
      if (!this.has(name)) return;
      var ctx = pnlCtx(tab);
      if (ctx.cwd !== PNL.cwd) pnlResetCwd(ctx.cwd);
      // 终端面板支持原地更新：dock 的重复重绘（SSE / 状态变化）不再
      // replaceChildren，.ct-root 不被摘出文档，.ct-ime 焦点与输入不中断。
      // 重建前记下"焦点在终端里"：replaceChildren 摘掉 .ct-root 后 Chromium
      // 只把 activeElement 移回 BODY，blur 时机不可靠，重建后由这里还焦点
      var termHadFocus = name === 'terminal' && pnlTermFocusInBody(body);
      if (name === 'terminal' && pnlTermUpdateInPlace(body, ctx)) return;
      body.replaceChildren();
      body.dataset.pnl = name;
      if (name === 'files') pnlRenderFiles(body, ctx);
      else if (name === 'git') pnlRenderGit(body, ctx);
      else pnlRenderTerm(body, ctx);
      if (termHadFocus) pnlTermFocusRestore(body);
    } catch (e) {
      if (window.console) console.error('[panels] render ' + name, e);
      try {
        body.replaceChildren();
        body.dataset.pnl = name;
        body.appendChild(pnlErrorBox('面板渲染失败：' + ((e && e.message) || e)));
      } catch (e2) {}
    }
  },
  refresh: function (name) {
    if (name === 'files') pnlLoadFiles(true);
    else if (name === 'git') { PNL.git.loadedCwd = ''; pnlLoadGit(true); }
    else if (name === 'terminal') pnlRepaint('terminal');
  },
  init: function () {
    if (PNL.inited) return;
    PNL.inited = true;
    try { document.addEventListener('keydown', pnlGlobalKeys); } catch (e) {}
    window.Panels = Panels;
  }
};

// 浮层优先级（§5.7）：搜索 > 通用弹窗 > 审批 > 斜杠 > 设置 > 预览 > 面板。
// 这些开着的时，Esc / Ctrl+P / Ctrl+G / Ctrl+反引号 都不抢事件。
function pnlHigherOverlayOpen() {
  try { if (typeof searchOpen === 'function' && searchOpen()) return true; } catch (e) {}
  try { if (typeof modalOpen === 'function' && modalOpen()) return true; } catch (e) {}
  try {
    var am = document.getElementById('approvalModal');
    if (am && am.classList.contains('show')) return true;
  } catch (e) {}
  try {
    var sp = document.getElementById('slashPanel');
    if (sp && sp.classList.contains('show')) return true;
  } catch (e) {}
  try { if (typeof S !== 'undefined' && S.settingsOpen) return true; } catch (e) {}
  return false;
}

function pnlPreviewShown() {
  var n = document.getElementById('pnlPreview');
  return !!(n && n.classList.contains('show'));
}

/* 给外壳 onGlobalKey 的浮层优先级钩子（§5.7）：搜索 > 通用弹窗 > 审批 >
   斜杠 > 设置 > 预览 > 面板。外壳先问这里，预览 / 快速打开才能先于 dock 关闭。 */
function previewOpen() { return pnlPreviewShown(); }
function closePreview() { pnlClosePreview(); }
function quickOpenOpen() { return !!pnlQO; }
function closeQuickOpen() { pnlCloseQuickOpen(); }

function pnlGlobalKeys(ev) {
  if (ev.key === 'Escape') {
    if (pnlHigherOverlayOpen()) return;
    if (pnlQO) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      pnlCloseQuickOpen();
      return;
    }
    if (pnlPreviewShown()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      pnlClosePreview();
      return;
    }
    return;
  }
  var mod = ev.ctrlKey || ev.metaKey;
  if (!mod || ev.altKey) return;
  // 外壳 onGlobalKey 已经处理过的快捷键不再重复处理（事件在 document 上按注册顺序传播）
  if (ev.defaultPrevented) return;
  var key = ev.key;
  if ((key === 'p' || key === 'P') && !ev.shiftKey) {
    if (pnlHigherOverlayOpen()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (pnlQO) { try { pnlQO.input.focus(); } catch (e) {} return; }
    openQuickOpen('');
    return;
  }
  if ((key === 'g' || key === 'G') && !ev.shiftKey) {
    if (pnlHigherOverlayOpen()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (typeof openDock === 'function') openDock('git');
    return;
  }
  if (key === '\u0060' || ev.code === 'Backquote') {
    if (pnlHigherOverlayOpen()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (typeof openDock === 'function') openDock('terminal');
  }
}

// 打开右栏页签：优先走外壳的 openDock（会记 dock 状态 / 重绘页签），
// 外壳尚未提供时退回直接渲染（并行开发期的兜底）。
function pnlOpenDock(name) {
  if (typeof openDock === 'function') { openDock(name); return; }
  try { if (typeof S !== 'undefined') { S.dock = name; S.dockOpen = true; } } catch (e) {}
  var dock = document.getElementById('rightdock');
  if (dock) dock.classList.add('open');
  var body = document.getElementById('dockBody');
  if (body) Panels.render(name, body, (typeof curTab === 'function' ? curTab() : null));
}

window.Panels = Panels;
window.openFilePanel = function () { pnlOpenDock('files'); };
window.openGitPanel = function () { pnlOpenDock('git'); };
window.openTerminal = function () { pnlOpenDock('terminal'); };
window.openQuickOpen = openQuickOpen;
window.showFilePreview = openFilePreview;
// 与 02-render2-chat.js 的同名函数不冲突：内部实现用唯一名，这里只覆盖全局钩子
window.openDiffPreview = pnlOpenDiffPreview;

// 启动垫片：
//   1) 若 boot 忘记调用 Panels.init()，这里兜底初始化（幂等）；
//   2) ?dock=files|git|terminal 在并行开发期也能直接出图；
//   3) 外壳 renderDock 尚未接入 Panels 时自行渲染一次（不覆盖已渲染的面板）。
(function pnlBootstrap() {
  function after() {
    try { Panels.init(); } catch (e) {}
    try {
      var q = new URLSearchParams(location.search);
      var dock = q.get('dock');
      if (dock && Panels.has(dock)) {
        var alreadyOpen = false;
        try { alreadyOpen = !!(typeof S !== 'undefined' && S.dockOpen); } catch (e) {}
        if (!alreadyOpen) pnlOpenDock(dock);
        setTimeout(function () {
          try {
            var body = document.getElementById('dockBody');
            if (body && !body.querySelector('.pnl')) {
              Panels.render(dock, body, (typeof curTab === 'function' ? curTab() : null));
            }
          } catch (e) {}
        }, 100);
      }
      var qo = q.get('quickopen');
      if (qo === '1' || qo === 'true') {
        setTimeout(function () { openQuickOpen(q.get('q') || ''); }, 320);
      }
    } catch (e) {
      if (window.console) console.warn('[panels] bootstrap', e);
    }
  }
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(after, 0); });
  } else {
    setTimeout(after, 0);
  }
})();





