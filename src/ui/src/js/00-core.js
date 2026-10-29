'use strict';
/* =====================================================================
   cell WebUI 前端 —— 纯 vanilla JS
   分节：A 常量/i18n · B 工具函数 · C 主题 · D 传输层 · E 状态仓库
        F 渲染——侧栏/标签/聊天/工具卡 · G Teamwork · H 通知流
        I 输入栏/斜杠 · J 设置页 · K 审批/浮窗/提示 · L mock · M boot
   ===================================================================== */

/* ---------- A. 常量与文案 ------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// 传输基址：相对路径（同源）；file:// 或 ?mock=1 走演示模式
const MOCK = location.protocol === 'file:' || /[?&]mock=1\b/.test(location.search);

// 名字必须与 cell.cpp 的 settings::parse_think_level 一致
// （off|low|med|high|max 或 0..4）；旧名 minimal/medium 仍可在输入框里识别。
const THINK_LEVELS = [
  { v: 0, name: 'off', desc: '不推理，最快' },
  { v: 1, name: 'low', desc: '低强度推理' },
  { v: 2, name: 'med', desc: '中等强度' },
  { v: 3, name: 'high', desc: '高强度' },
  { v: 4, name: 'max', desc: '最高强度，最慢' },
];
const SANDBOX_MODES = [
  { v: 'read-only', desc: '只读：禁止任何写入/执行' },
  { v: 'edit-only', desc: '仅编辑：允许改文件，禁止执行命令' },
  { v: 'full-access', desc: '完全访问：可读写并执行命令' },
];
const TOPIC_ZH = { worker: '子代理', compact: '压缩', review: '评审', stage: '阶段', gate: '关卡', job: '任务' };

// 斜杠指令集
const COMMANDS = [
  { name: '/new', usage: '/new', desc: '为当前工作区新建一条会话', run: () => cmd('session.new', { ws: S.active }) },
  { name: '/clear', usage: '/clear', desc: '清空当前会话上下文（会中断正在进行的回合，需确认）', run: () => clearSession(S.active) },
  { name: '/session', usage: '/session [id]', desc: '切换当前工作区的会话', ctx: 'sessions' },
  { name: '/model', usage: '/model [name|fetch]', desc: '查看/切换模型，或拉取模型列表', ctx: 'models' },
  { name: '/provider', usage: '/provider [name]', desc: '切换供应商', ctx: 'providers' },
  { name: '/think', usage: '/think <level>', desc: '设置思考级别 0-4', ctx: 'think' },
  { name: '/tools', usage: '/tools <on|off>', desc: '开关工具调用', ctx: 'onoff' },
  { name: '/sandbox', usage: '/sandbox <mode>', desc: '设置沙箱模式', ctx: 'sandbox' },
  { name: '/autoallow', usage: '/autoallow <on|off>', desc: '自动放行（仅完全访问）', ctx: 'onoff' },
  { name: '/compact', usage: '/compact [auto on|off]', desc: '立即压缩当前上下文（对齐 CLI）；auto on|off 开关自动压缩', ctx: 'compact' },
  { name: '/skills', usage: '/skills', desc: '列出可用技能（.cell/skills）', run: t => listSkills(t) },
  { name: '/skill', usage: '/skill <name>', desc: '把技能正文注入当前会话（对齐 CLI）', ctx: 'skills' },
  { name: '/usages', usage: '/usages', desc: '展开左侧栏的用量统计（总览 / 按模型 / 按会话）', run: () => openUsagePop(true) },
  { name: '/stop', usage: '/stop', desc: '停止当前工作区正在跑的回合', run: t => cmd('stop', { ws: S.active }) },
  { name: '/teamwork', usage: '/teamwork [run|resume|stop] <id>', desc: '列出/运行/恢复团队任务', ctx: 'teamwork' },
  { name: '/notice', usage: '/notice', desc: '查看通知列表', run: () => { openDock('notices'); refreshNotices(S.active); } },
  { name: '/archive', usage: '/archive', desc: '查看当前会话的历史存档（右侧面板）', run: () => { openDock('archives'); refreshArchives(S.active, true); } },
  { name: '/workspace', usage: '/workspace [path]', desc: '切换或打开工作区', ctx: 'workspaces' },
  { name: '/theme', usage: '/theme [default|名称]', desc: '切换第三方主题（默认与导出的会话页同源）', ctx: 'theme' },
  { name: '/git', usage: '/git', desc: '打开 Git / Worktree 面板', run: () => openDock('git') },
  { name: '/worktree', usage: '/worktree', desc: '管理并行工作树（Git Worktree）', run: () => openDock('git') },
  { name: '/files', usage: '/files [path]', desc: '打开工作区文件面板；Ctrl+P 快速打开', run: () => openDock('files') },
  { name: '/terminal', usage: '/terminal', desc: '打开终端面板（在工作区运行命令）', run: () => openDock('terminal') },
  { name: '/save', usage: '/save', desc: '立即把当前会话写盘（对齐 CLI）', run: () => saveSession() },
  { name: '/export', usage: '/export [path]', desc: '导出会话为自包含 HTML（默认落到工作区目录）', ctx: 'export' },
  { name: '/reload', usage: '/reload', desc: '继续被中断的回合（对齐 CLI）', run: () => resumeTurn() },
  { name: '/help', usage: '/help', desc: '显示指令帮助', run: () => toast('输入 / 查看全部指令；↑↓ 选择，Tab 补全，Enter 执行', 'ok', 4200) },
  // ---- CLI 指令名别名：候选列表里不显示，输入完整名字照常执行 ----
  { name: '/provide', alias: true, usage: '/provide [name]', desc: 'CLI 写法：/provider', ctx: 'providers' },
  { name: '/provides', alias: true, usage: '/provides', desc: 'CLI 写法：列出供应商', run: () => listProviders() },
  { name: '/sessions', alias: true, usage: '/sessions', desc: 'CLI 写法：/session', ctx: 'sessions' },
  { name: '/models', alias: true, usage: '/models', desc: 'CLI 写法：/model', ctx: 'models' },
  { name: '/notices', alias: true, usage: '/notices', desc: 'CLI 写法：/notice', run: () => { openDock('notices'); refreshNotices(S.active); } },
  { name: '/teamworks', alias: true, usage: '/teamworks [run|resume|stop] <id>', desc: 'CLI 写法：/teamwork', ctx: 'teamwork' },
  { name: '/tool', alias: true, usage: '/tool <on|off>', desc: 'CLI 写法：/tools', ctx: 'onoff' },
  { name: '/saved', alias: true, usage: '/saved', desc: 'CLI 写法：/archive', run: () => { openDock('archives'); refreshArchives(S.active, true); } },
  { name: '/ins', alias: true, usage: '/ins <message text>', desc: 'CLI 写法：插入一条消息并触发一轮（等同直接发送）', ctx: 'ins' },
];

// CLI 指令名 → WebUI 主名（execSlash 开头统一；别名不进候选列表）
const CMD_ALIAS = {
  '/provide': '/provider', '/sessions': '/session', '/models': '/model',
  '/notices': '/notice', '/teamworks': '/teamwork', '/tool': '/tools', '/saved': '/archive',
};

/* ---------- B. 工具函数 -------------------------------------------- */
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 内联单色图标 -------------------------------------------
   黑白灰界面里不用彩色 emoji：所有按钮/标签图标都是 24 格内联 SVG，
   形状按「一套笔画」选取，着色交给 CSS（.uico，stroke=currentColor，
   见 02-atoms.css §2.8）。iconHtml 给 innerHTML 场景，iconEl 给
   appendChild 场景；名字取不到时返回空 SVG（不抛错）。              */
const ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.2 16.2"/>',
  sliders: '<path d="M4 8.5h8.5M17.5 8.5H20M4 15.5h2.5M11.5 15.5H20"/><circle cx="15" cy="8.5" r="2.2"/><circle cx="9" cy="15.5" r="2.2"/>',
  pencil: '<path d="M4.6 19.4l.9-3.5L16.7 4.7a2.1 2.1 0 0 1 3 3L8.5 18.9l-3.9.5Z"/><path d="M14.9 6.5l2.8 2.8"/>',
  clip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.2M17.8 14.6a5.5 5.5 0 0 1 2.7 4.9"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  archive: '<rect x="3" y="4.5" width="18" height="4.5" rx="1.2"/><path d="M5 9v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  trash: '<path d="M3.5 6.5h17"/><path d="M8.8 6.5V5a1.8 1.8 0 0 1 1.8-1.8h2.8A1.8 1.8 0 0 1 15.2 5v1.5"/><path d="M6.3 6.5l.9 12.3a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9l.9-12.3"/><path d="M10.2 10.8v6M13.8 10.8v6"/>',
  mark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.5L6 20V5.5a1 1 0 0 1 1-1Z"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.7.8 1.3 1.5 1.5 2.5"/><path d="M9.5 17.5h5M10.5 20.5h3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  fileCode: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
  filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  folderPlus: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6M9 13h6"/>',
  gitBranch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  gitCommit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
  gitMerge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  gitPullRequest: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  squareTerminal: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  panelRight: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  refresh: '<path d="M21 12a8 8 0 1 1-2.34-5.66M21 4v4h-4"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  play: '<path d="m7 4 14 8-14 8V4Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  sparkles: '<path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/>',
  code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6Z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6l8-3Z"/>',
  gauge: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l4.5-4.5"/><circle cx="12" cy="12" r="2"/>',
  bars: '<path d="M4.5 20V11M9.75 20V5M15 20v-6M20.25 20V8.5"/><path d="M2.5 20h19"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M16 7l2.5 2.5M19 4l2 2"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',

};
function iconHtml(name, cls) {
  return '<svg class="uico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' +
    (ICON_PATHS[name] || '') + '</svg>';
}
function iconEl(name, cls) {
  const w = document.createElement('span');
  w.innerHTML = iconHtml(name, cls);
  return w.firstChild;
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function relTime(sec) {
  if (!sec) return '';
  const d = nowSec() - sec;
  if (d < 0) return '刚刚';
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return new Date(sec * 1000).toLocaleDateString();
}
function hhmm(sec) {
  const d = new Date((sec || nowSec()) * 1000);
  return d.toTimeString().slice(0, 5);
}
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function shortId(id) { return id ? String(id).slice(0, 8) : ''; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function uid() { return Math.random().toString(36).slice(2, 10); }

// Markdown 渲染见 01-markdown.js（renderMarkdown / mdLite）

// 从 notice body 提取路径特征 / tw- id
function pathFeature(body) {
  const b = String(body || '');
  const q = b.match(/'([^']{3,})'/) || b.match(/`([^`]{3,})`/);
  if (q) return q[1];
  const p = b.match(/[A-Za-z]:[\\/][^\s'"]+|\/[\w.\-/]{4,}/);
  if (p) return p[0];
  const t = b.match(/tw-[A-Za-z0-9\-_]+/);
  return t ? t[0] : '';
}
function twIdOf(body) {
  const t = String(body || '').match(/tw-[A-Za-z0-9\-_]+/);
  return t ? t[0] : '';
}

/* ---------- C. 主题 / 外观 -----------------------------------------
   没有内置主题：默认外观是锁定为黑白灰的深色（见 00-tokens.css，不跟随
   系统深浅，减少蓝光），令牌名与 cell.cpp /export 导出页同一套，因此
   「界面里的会话」与「导出的会话」同源。唯一的主题来源是第三方：放在与
   配置/会话/凭据相同的 <exe 目录>/.cell/theme/<名称>/ 下的 theme.json +
   theme.css，经 GET /api/themes 发现、GET /api/theme/<名称> 拉取后注入
   <style id="theme-ext">。只需重定义 CSS 变量即可完整换肤。
   选择持久化于 localStorage；URL ?theme=<名称> 可临时覆盖。           */
const Theme = {
  key: 'cell.theme', animKey: 'cell.anim',
  fallback: '', // 无第三方主题 = 内置默认外观（黑白灰深色）
  external: {}, // name -> {label,type,desc,swatch}
  cssCache: {},
  el: null,    // 第三方主题注入的 <style id="theme-ext">
  list() {
    const out = [];
    for (const n in this.external)
      out.push(Object.assign({}, this.external[n], { name: n }));
    return out;
  },
  current() { return this.list().find(t => t.name === S.theme) || null; },
  isExternal(name) { return !!this.external[name]; },
  init() {
    // URL override (dev/debug + screenshots): ?theme=<name>&anim=0|1|2
    const q = new URLSearchParams(location.search);
    const qt = q.get('theme'), qa = q.get('anim');
    const anim = (qa === '0' || qa === '1' || qa === '2') ? Number(qa) : null;
    if (qt) { this.set(qt, anim); return; }
    const t = localStorage.getItem(this.key) || this.fallback;
    const a = localStorage.getItem(this.animKey);
    this.set(t, a == null ? 2 : Number(a));
    if (!MOCK) this.loadExternal();
  },
  // 拉取第三方主题清单；当前主题是第三方时补上异步到达的样式
  async loadExternal() {
    let r;
    try { r = await fetch('api/themes'); } catch (e) { return; }
    if (!r || !r.ok) return;
    let j;
    try { j = await r.json(); } catch (e) { return; }
    if (!j || j.ok === false || !Array.isArray(j.themes)) return;
    for (const t of j.themes) {
      this.external[t.name] = {
        label: t.label || t.name,
        type: t.type === 'light' ? 'light' : 'dark',
        desc: t.desc || '',
        swatch: Array.isArray(t.swatch) ? t.swatch.slice(0, 4) : null,
      };
    }
    const cur = localStorage.getItem(this.key) || this.fallback;
    if (this.external[cur]) this.set(cur);
    else if (cur) this.set(this.fallback); // 主题目录被删了 → 回到默认外观
    if (S.settingsOpen) renderSettings();
  },
  set(name, anim) {
    if (name && !this.external[name]) name = this.fallback;
    if (name) document.documentElement.dataset.theme = name;
    else delete document.documentElement.dataset.theme;
    if (name) localStorage.setItem(this.key, name);
    else localStorage.removeItem(this.key);
    if (anim != null) {
      document.documentElement.dataset.anim = String(anim);
      localStorage.setItem(this.animKey, String(anim));
    }
    S.theme = name;
    if (this.isExternal(name)) this.inject(name);
    else this.drop();
  },
  cycle() {
    const l = this.list();
    if (!l.length) return; // 没有第三方主题：保持默认外观
    const i = l.findIndex(t => t.name === S.theme);
    this.set(l[(i + 1) % l.length].name);
  },
  async inject(name) {
    let css = this.cssCache[name];
    if (css == null) {
      try {
        const r = await fetch('api/theme/' + encodeURIComponent(name));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        css = await r.text();
      } catch (e) {
        toast('主题加载失败：' + name + '，已回退', 'bad');
        this.set(this.fallback);
        return;
      }
      this.cssCache[name] = css;
    }
    if (!this.el) {
      this.el = document.createElement('style');
      this.el.id = 'theme-ext';
      document.head.appendChild(this.el);
    }
    this.el.textContent = css;
  },
  drop() {
    if (this.el) { this.el.remove(); this.el = null; }
  },
};

/* ---------- E. 状态仓库 -------------------------------------------- */
// 每个工作区一个 Tab 状态；切标签只换视图，不清状态
function newTab(ws, cwd) {
  return {
    ws, cwd, session: '', busy: false, loaded: false,
    msgs: [], streamMsg: null, streamRole: null,
    tools: new Map(), roundSeq: 0,
    jobs: [], notices: [], noticeGroups: [], noticesLoaded: false,
    archives: [], archivesFor: '', // 压缩历史存档（dock 存档架）；archivesFor = 已拉取列表的会话 id
    unread: 0, approval: null,
    wins: new Map(), // worker 浮窗
    thinkingSince: 0,
    composer: { mode: 'text', text: '', attachments: [], workflow: defaultWorkflow() },
    draft: '',
  };
}
function defaultWorkflow() {
  return { work_type: 'serial', stages: [{ name: '分析', mode: 'serial', gate: false, agents: [{ works: '', name: '', model: '', think: 'off' }] }] };
}

const S = {
  mode: MOCK ? 'demo' : 'live',
  theme: '',
  active: '', tabOrder: [], tabs: new Map(),
  model: '', provider: '', sandbox: 'full-access', tools: true,
  providers: [], settings: {}, workspaces: [], sessions: [], sessionsTotal: 0, models: [],
  skills: [], skillsRoot: '',   // /skills、/skill 共用（启动时拉一次，/skills 强制刷新）
  usages: null, usagesLoading: false, usagesOpen: false, // 用量缓存（usages.summary）+ 左侧栏收纳浮层是否展开
  connected: true, everConnected: false,
  dock: 'teamwork', dockOpen: false, settingsOpen: false,
  recentCwds: [],
  closedTabs: [], tabMenuNode: null,
  groupsClosed: new Set(),   // 侧栏里被折叠的工作区分组（见 02-render.js）
  pendingApprovals: 0,
};

function tab(ws) {
  if (!S.tabs.has(ws)) S.tabs.set(ws, newTab(ws, ''));
  return S.tabs.get(ws);
}
function activeTab() { return S.active ? tab(S.active) : null; }
function curTab() { return S.active ? (S.tabs.get(S.active) || null) : null; }
function cwdOf(ws) {
  const t = S.tabs.get(ws);
  if (t && t.cwd) return t.cwd;
  const w = S.workspaces.find(w => w.ws === ws);
  return w ? w.cwd : '';
}

/* 技能清单（对齐 CLI /skills、/skill）：面板补全用缓存，/skills 强制刷新 ——
   技能目录是磁盘上的文件，用户可能刚改过 */
function fetchSkills(force) {
  if (!force && S.skills && S.skills.length) return Promise.resolve(S.skills);
  return api('skills.list', {}).then(out => {
    if (out && Array.isArray(out.skills)) { S.skills = out.skills; S.skillsRoot = out.root || ''; }
    return S.skills || [];
  }).catch(() => S.skills || []);
}
function listSkills() {
  return fetchSkills(true).then(list => {
    if (!list.length) { toast('没有可用技能' + (S.skillsRoot ? '（' + S.skillsRoot + '）' : '')); return; }
    toast('技能 ' + list.length + ' 个：'
      + list.map(s => s.name + (s.description ? ' — ' + s.description : '')).join('；'), 'ok', 7000);
  });
}

/* 会话类指令（对齐 CLI /save、/export、/reload、/provides） */
function saveSession(ws) {
  ws = ws || S.active;
  return cmd('session.save', { ws: ws }).then(out => {
    if (!out || out.ok === false) {
      const err = String((out && out.error) || '');
      toast(err.indexOf('a turn is running') >= 0 ? '回合进行中，结束后再保存' : (err || '保存失败'), 'bad');
      return;
    }
    toast('会话已保存（' + out.msgs + ' 条消息）', 'ok');
  });
}
function exportSession(t, path) {
  const ws = (t && t.ws) || S.active;
  return cmd('session.export', { ws: ws, path: path || '' }).then(out => {
    if (!out || out.ok === false) { toast((out && out.error) || '导出失败', 'bad', 5200); return; }
    toast('已导出 ' + out.msgs + ' 条消息 → ' + out.path, 'ok', 7000);
  });
}
function resumeTurn(t) {
  const ws = (t && t.ws) || S.active;
  return cmd('turn.resume', { ws: ws }).then(out => {
    if (!out || out.ok === false) {
      const err = String((out && out.error) || '');
      toast(err.indexOf('no interrupted turn') >= 0 ? '没有可继续的中断回合' : (err || '无法继续'), 'bad', 4200);
      return;
    }
    toast('继续被中断的回合（' + (out.reason || '中断') + '）', 'ok');
  });
}
function listProviders() {
  const names = (S.providers || []).map(p => p.name + (p.current ? '（当前）' : ''));
  toast(names.length ? '供应商 ' + names.length + ' 个：' + names.join('、') : '还没有配置供应商', 'ok', 7000);
}

/* ---------- D. 传输层 ---------------------------------------------- */
async function api(name, args) {
  if (S.mode === 'demo') return Mock.api(name, args || {});
  let r;
  try {
    r = await fetch('api/cmd/' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
  } catch (e) {
    throw new Error('网络错误：' + e.message);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
// 命令包装：统一处理错误提示 + 演示模式提前返回
async function cmd(name, args, opts) {
  opts = opts || {};
  try {
    const out = await api(name, args || {});
    if (out && out.ok === false) {
      toast(out.error || (name + ' 失败'), 'bad');
      return out;
    }
    if (out && out.error && out.ok !== true) toast(out.error, 'bad');
    return out;
  } catch (e) {
    toast(e.message || String(e), 'bad');
    return { ok: false, error: String(e) };
  }
}

const Transport = {
  es: null,
  init() {
    if (S.mode === 'demo') return;
    if (this.es) { try { this.es.close(); } catch (e) {} }
    const es = new EventSource('api/events');
    this.es = es;
    es.onopen = () => {
      const first = !S.everConnected;
      S.everConnected = true;
      S.connected = true;
      $('#reconnect').classList.remove('show');
      renderFoot();
      if (!first) resync();
    };
    es.onmessage = ev => {
      if (!ev.data) return;
      let j; try { j = JSON.parse(ev.data); } catch (e) { return; }
      handleEvent(j);
    };
    es.onerror = () => {
      S.connected = false;
      $('#reconnect').classList.add('show');
      renderFoot();
    };
  },
  close() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } },
};

async function resync() {
  const out = await cmd('state', {});
  if (out && out.ok !== false) applyHello(out, true, { keepActive: true });
  if (S.active) refreshNotices(S.active);
  // 设置页是全屏浮层，上面的按钮只改了后端；不重绘的话列表要等到
  // 关掉再打开才更新（此前 providers.add/select/rm 全都这样）。
  // resync() 只由明确的用户动作触发（SSE 走 applyHello(rebuild=false)），
  // 所以在这里重绘不会打断正在进行的输入。
  if (S.settingsOpen) renderSettings();
}

/* ---------- 事件分发 ----------------------------------------------- */
function handleEvent(e) {
  if (!e || !e.t) return;
  // 终端事件（term.out / term.exit / term.error）由 08c-term.js 消费：
  // PTY 输出是 base64 字节流，必须走终端自己的流式解码器
  if (e.t === 'term.out' || e.t === 'term.exit' || e.t === 'term.error') {
    try { if (window.CellTerm && window.CellTerm.onEvent) window.CellTerm.onEvent(e); } catch (err) {}
    return;
  }
  switch (e.t) {
    case 'hello': applyHello(e, true, { keepActive: true }); break;
    case 'turn_begin': onTurnBegin(e.ws); break;
    case 'turn_end': onTurnEnd(e); break;
    case 'compact_begin': onCompactBegin(e.ws); break;
    case 'compact_end': onCompactEnd(e); break;
    case 'answer_begin': onAnswerBegin(e.ws); break;
    // 引擎的 answer 流就是助手正文：统一按 assistant 归档（其余前端同义）
    case 'answer': onStream(e.ws, 'assistant', e.d); break;
    case 'reason': onStream(e.ws, 'reason', e.d); break;
    case 'summary': onStream(e.ws, 'summary', e.d); break;
    case 'status': pushMsg(e.ws, { role: 'status', text: e.d }); break;
    case 'error': pushMsg(e.ws, { role: 'error', text: e.d }); break;
    case 'round': onRound(e); break;
    case 'tool_begin': onToolBegin(e); break;
    case 'tool_end': onToolEnd(e); break;
    case 'notice': onNotice(e); break;
    case 'approval': onApproval(e); break;
    case 'approval_resolved': onApprovalResolved(e); break;
    case 'teamwork_changed': case 'workspace_state':
      if (e.ws) refreshTeamwork(e.ws); else refreshTeamwork(S.active);
      break;
    default: break;
  }
}

/* ---------- 渲染调度（rAF 批量） ----------------------------------- */
const jobs = new Map();
let rafId = 0;
function schedule(key, fn) {
  jobs.set(key, fn);
  if (!rafId) rafId = requestAnimationFrame(flushRender);
}
function flushRender() {
  rafId = 0;
  const list = Array.from(jobs.values());
  jobs.clear();
  for (const fn of list) { try { fn(); } catch (e) { console.error(e); } }
}
function markAll() {
  schedule('sidebar', renderSidebar);
  schedule('tabbar', renderTabbar);
  schedule('panes', renderPanes); // active pane follows S.active (hello/activate paths)
  schedule('dock', renderDock);
  schedule('foot', renderFoot);
  for (const ws of S.tabOrder) schedule('head:' + ws, () => renderChatHead(ws));
  if (S.active) markChat(S.active);
}
function markChat(ws) {
  schedule('chat:' + ws, () => renderChat(ws));
  schedule('sidebar', renderSidebar);
  schedule('tabbar', renderTabbar);
  schedule('foot', renderFoot); // 品牌标识的运行态（忙碌 ⇄ 静止）随回合切换
}
function markComposer(ws) {
  if (ws === S.active) schedule('composer', renderComposer);
}
function markUnread(ws) {
  const t = S.tabs.get(ws);
  if (t && ws !== S.active) t.unread++;
  schedule('tabbar', renderTabbar);
  schedule('sidebar', renderSidebar);
}

/* ---------- hello：重建视图 ---------------------------------------- */
function applyHello(st, rebuild, opts) {
  if (!st) return;
  opts = opts || {};
  S.model = st.model || S.model;
  const prevProvider = S.provider;
  S.provider = st.provider || '';
  // 模型列表是按需拉的（state 快照里没有），换供应商后旧列表就属于上一个
  // 供应商了——不清掉的话「模型」页会继续展示别人的模型
  if (S.provider !== prevProvider) S.models = [];
  if (st.sandbox) S.sandbox = st.sandbox;
  if (st.settings) S.settings = Object.assign({}, S.settings, st.settings);
  if (st.providers) S.providers = st.providers;
  if (Array.isArray(st.tools)) S.tools = true; else if (typeof st.tools === 'boolean') S.tools = st.tools;

  let noticesReset = false;
  if (Array.isArray(st.workspaces)) {
    S.workspaces = st.workspaces;
    for (const w of st.workspaces) {
      const t = tab(w.ws);
      t.cwd = w.cwd;
      if (t.session !== w.session) {
        t.session = w.session; t.detailSession = '';
        // 通知面板按会话隔离：切了会话就不能再显示上一个的通知
        t.notices = []; t.noticesLoaded = false; rebuildNoticeGroups(t);
        noticesReset = true;
      }
      t.busy = w.busy;
      if (!S.tabOrder.includes(w.ws)) S.tabOrder.push(w.ws);
    }
    // 清理已关闭的工作区
    for (const ws of Array.from(S.tabs.keys()))
      if (!st.workspaces.some(w => w.ws === ws)) removeTab(ws);
  }

  const ws = st.ws || st.active || '';
  if (ws) {
    const t = tab(ws);
    if (st.cwd) t.cwd = st.cwd;
    if (st.session && t.session !== st.session) {
      t.session = st.session; t.detailSession = '';
      t.notices = []; t.noticesLoaded = false; rebuildNoticeGroups(t);
      noticesReset = true;
    }
    if (typeof st.busy === 'boolean') { t.busy = st.busy; if (st.busy && !t.thinkingSince) t.thinkingSince = Date.now(); }
    // hello 里的 teamwork 就是该会话当前的权威列表：打上 jobsFor，Teamwork
    // 面板首帧直接渲染，省掉一次「正在加载」+ 重复拉取
    if (st.teamwork) { t.jobs = st.teamwork; t.jobsFor = t.session; }
    // history 回填：rebuild 时清空聊天视图
    if (rebuild && Array.isArray(st.history)) {
      t.msgs = [];
      t._live = { assistant: null, reason: null, summary: null };
      t._liveMsgId = null;
      t._md = new Map();
      for (const h of st.history) {
        if (!h || !h.text) continue;
        t.msgs.push({ id: uid(), role: h.role === 'user' ? 'user' : 'assistant', text: h.text, ts: 0 });
      }
      t.loaded = true;
      // 预览只作为瞬时填充，随后用完整 transcript 替换（含工具/存档/团队记录）
      t.detailSession = '';
      loadSessionDetail(ws, t.session);
    }
    if (!opts.keepActive && (!S.active || rebuild)) S.active = ws;
  }
  if (!opts.keepActive && st.active && S.tabOrder.includes(st.active)) S.active = st.active;
  // never keep a tab selected that no longer exists (workspace closed/deleted)
  if (S.active && !S.tabOrder.includes(S.active))
    S.active = (st.active && S.tabOrder.includes(st.active)) ? st.active : (S.tabOrder[0] || '');
  // 首次 hello（keepActive）可能没有活动标签：补选一个，否则输入栏/右栏会
  // 显示「没有打开的工作区」，而消息流里却有内容
  if (!S.active && (st.active && S.tabOrder.includes(st.active))) S.active = st.active;
  if (!S.active && ws && S.tabOrder.includes(ws)) S.active = ws;
  if (!S.active) S.active = S.tabOrder[0] || '';

  markAll();
  syncComposerInput();
  // 可选：拉取会话与通知（非阻塞）
  if (rebuild) {
    refreshSessions();
    refreshNotices(S.active);
  } else if (noticesReset) {
    refreshNotices(S.active); // 会话切换的广播：面板换成新会话的通知
  }
  if (noticesReset) schedule('dock', renderDock);
}

function removeTab(ws) {
  const tabState = S.tabs.get(ws);
  if (tabState) {
    // worker-transcript / archive float windows must stop polling and go away
    // with their workspace
    for (const key of Array.from(tabState.wins.keys())) closeFloatWin(tabState, key);
  }
  S.tabs.delete(ws);
  S.tabOrder = S.tabOrder.filter(k => k !== ws);
  if (S.active === ws) S.active = S.tabOrder[S.tabOrder.length - 1] || '';
  // drop the workspace from back/forward history: otherwise "back" activates
  // a workspace that no longer exists (ghost tab, commands to a dead ws)
  Nav.hist = Nav.hist.filter(k => k !== ws);
  if (Nav.idx >= Nav.hist.length) Nav.idx = Nav.hist.length - 1;
  paintNav();
  const pane = $('#pane-' + cssId(ws));
  if (pane) pane.remove();
}

/* ---------- 回合与流式 --------------------------------------------- */
function ensureTab(ws) {
  if (!ws) ws = S.active;
  const t = tab(ws);
  if (!S.tabOrder.includes(ws)) S.tabOrder.push(ws);
  return t;
}
function onTurnBegin(ws) {
  const t = ensureTab(ws);
  t.busy = true;
  if (window.ChatTurns && ChatTurns.begin) { try { ChatTurns.begin(ws); } catch (e) {} }
  t.thinkingSince = Date.now();
  t._live = { assistant: null, reason: null, summary: null };
  t._liveMsgId = null;
  t.turnRounds = 0;
  t._turnNotices = []; // 本回合的通知气泡：回合结束重载转录后要补回聊天流
  markChat(ws); schedule('tabbar', renderTabbar); markComposer(ws); // 发送按钮切「停止」
}
function onTurnEnd(e) {
  const t = ensureTab(e.ws);
  t.busy = false;
  if (window.ChatTurns && ChatTurns.end) { try { ChatTurns.end(e); } catch (err) {} }
  t.thinkingSince = 0;
  t._live = { assistant: null, reason: null, summary: null };
  t._liveMsgId = null;
  // 回合里的上下文压缩会落下新的存档文件：让存档架下次渲染时重新拉列表
  t.archivesFor = '';
  const n = e.tool_calls || 0, r = e.rounds || 0;
  const statusText = '回合结束 · ' + r + ' 轮 · ' + n + ' 次工具调用' + (e.natural === false ? '（中断）' : '');
  const sid = t.session, notices = t._turnNotices || [];
  // 回合里 LLM 可能通过 tw 工具创建/运行了团队任务（这一路径没有 SSE 事件）：
  // 让面板重拉内容；出现新任务且右侧面板关着时自动展开 Teamwork 面板
  const beforeIds = new Set((t.jobs || []).map(j => j.id));
  t.jobsFor = '';
  // 一轮跑完总会多出 token：顺手刷新侧栏「用量」chip（缓存 20s，最多两秒一次请求量级）
  if (typeof refreshUsages === 'function') refreshUsages(false);
  refreshTeamwork(e.ws, true).then(jobs => {
    if (e.ws === S.active && jobs && jobs.some(j => !beforeIds.has(j.id)) && !S.dockOpen)
      openDock('teamwork');
  });
  // 工作完成 → 以落盘转录为准重载当前会话：压缩后的自动摘要、思考块、工具
  // 结果都只在磁盘上是权威形态；重载完再把回合小结与通知气泡补到流末尾
  reloadSessionDetail(e.ws, () => {
    if (S.tabs.get(e.ws) !== t || t.session !== sid) return; // 已切走
    for (const m of notices) pushMsgSilent(e.ws, m);
    pushMsg(e.ws, { role: 'status', text: statusText });
  });
  markChat(e.ws); schedule('tabbar', renderTabbar); markComposer(e.ws); // 切回「发送」
  refreshSessions();
}

// /compact 在 worker 里跑（可能要几十秒）：期间按「忙」处理 —— 发送键切停止、
// 思考指示器顶上；用户在压缩中再发消息只会排在压缩后面
function onCompactBegin(ws) {
  const t = ensureTab(ws);
  t.busy = true;
  t.thinkingSince = Date.now();
  t._live = { assistant: null, reason: null, summary: null };
  t._liveMsgId = null;
  markChat(ws); schedule('tabbar', renderTabbar); markComposer(ws);
}
// 压缩把上下文重写成「system + 最近一条用户消息 + 摘要」：只能以落盘转录为准重载
function onCompactEnd(e) {
  const t = ensureTab(e.ws);
  t.busy = false;
  t.thinkingSince = 0;
  t._live = { assistant: null, reason: null, summary: null };
  t._liveMsgId = null;
  t.archivesFor = ''; // 压缩落了一份存档：存档架下次渲染时重拉列表
  // state 与 CLI /compact 打印的字符串同源：done 真压了 / idle 消息太少 /
  // aborted+error 未改动上下文
  if (e.state === 'idle') toast('上下文还很小，不需要压缩', 'ok');
  else if (e.state === 'done') toast('上下文已压缩', 'ok');
  else toast('压缩未完成：' + (e.d || '未知原因'), 'bad', 5200);
  reloadSessionDetail(e.ws);
  markChat(e.ws); schedule('tabbar', renderTabbar); markComposer(e.ws);
  refreshSessions();
}
function onAnswerBegin(ws) {
  const t = ensureTab(ws);
  if (t._live) t._live.assistant = null;
}
function onStream(ws, role, d) {
  const t = ensureTab(ws);
  if (!t._live) t._live = { assistant: null, reason: null, summary: null };
  let msg = t._live[role];
  if (!msg) {
    msg = { id: uid(), role, text: '', ts: nowSec(), streaming: true };
    t._live[role] = msg;
    t.msgs.push(msg);
    t._liveMsgId = role === 'assistant' ? msg.id : t._liveMsgId;
  }
  streamAppend(ws, msg, d || '');
  markChat(ws);
}
function streamAppend(ws, msg, d) {
  if (!d) return;
  msg.text += d;
  const t = S.tabs.get(ws); if (!t || !t._md) return;
  const md = t._md.get(msg.id);
  if (md && md.__live && md.__tn) {
    md.__tn.appendData(d);
    return;
  }
  // DOM 尚未就绪：留待下次整块渲染补齐
}
function onRound(e) {
  const t = ensureTab(e.ws);
  t.roundSeq = (t.turnRounds = (t.turnRounds || 0) + 1);
  // 本轮 LLM 响应已完整结束：思考流随之收尾。清掉 live reason，回合间的等待
  // 才能重新显示「思考中」指示器（它只在没有流式内容时出现）
  if (t._live) t._live.reason = null;
  pushMsg(e.ws, { role: 'round', round: e.round, tok_in: e.tok_in, tok_out: e.tok_out, cache: e.cache, sec: e.sec, ttft: e.ttft });
  markChat(e.ws);
}
function onToolBegin(e) {
  const t = ensureTab(e.ws);
  const tool = {
    // seq 是引擎的「本轮第几个」——跨轮次会重复（每轮都从 1 开始），消息 id
    // 必须另用单调计数器，否则 reconcile 的 key 冲突、同一张卡被建两次
    id: 'tool-' + (t._toolSeq = (t._toolSeq || 0) + 1), role: 'tool', seq: e.seq, name: e.name,
    args: e.args, policy: e.policy, status: 'running', display: '', marker: '',
    sec: 0, chars: 0, expanded: false, started: Date.now(),
  };
  t.tools.set(e.seq, tool);
  t.msgs.push(tool);
  markChat(e.ws);
}
function onToolEnd(e) {
  const t = ensureTab(e.ws);
  let tool = t.tools.get(e.seq);
  if (!tool) {
    tool = { id: 'tool-' + (t._toolSeq = (t._toolSeq || 0) + 1), role: 'tool', seq: e.seq, name: e.name, args: '', expanded: false };
    t.tools.set(e.seq, tool); t.msgs.push(tool);
  }
  tool.status = e.status; tool.display = e.display; tool.marker = e.marker;
  tool.sec = e.sec; tool.chars = e.chars; tool.multimodal = e.multimodal;
  markChat(e.ws);
  // LLM 通过 tw 工具建/跑团队任务时没有 SSE 事件：工具一结束就重拉一次，
  // 新任务出现且右栏关着就自动展开 Teamwork——用户提交后能立刻看到卡片
  if (tool.name === 'tw' || tool.name === 'teamwork') {
    const beforeIds = new Set(((S.tabs.get(e.ws) || {}).jobs || []).map(j => j.id));
    const t2 = S.tabs.get(e.ws);
    if (t2) t2.jobsFor = '';
    refreshTeamwork(e.ws, true).then(jobs => {
      if (e.ws !== S.active || !jobs) return;
      const fresh = jobs.filter(j => !beforeIds.has(j.id));
      if (!fresh.length) return;
      if (!S.dockOpen) openDock('teamwork');
      else if (S.dock === 'teamwork') schedule('dock', renderDock);
    });
  }
}
function onNotice(e) {
  const t = ensureTab(e.ws);
  // 实时 watcher 事件与引擎注入事件可能先后到达同一条通知：按 id 去重
  // （房间 dock 与聊天气泡都以 t.notices 为源）
  if (e.nid && t.notices.some(n => n.id === e.nid)) return;
  const n = { id: e.nid || uid(), from: e.from || '', session: e.session || '', topic: e.topic || '', body: e.body || '', d: e.d || '', created_at: e.created_at || nowSec(), pending: true, _new: true, live: true };
  t.notices.push(n);
  rebuildNoticeGroups(t);
  if (e.ws !== S.active) t.unread++;
  // 团队任务的进度只以 notice 形式广播（gate/job/stage/worker/review/compact）：
  // 防抖后重拉一次 job 列表，面板与失败详情无需等轮询/手动刷新
  if (n.topic === 'gate' || n.topic === 'job' || n.topic === 'stage' || n.topic === 'worker' || n.topic === 'review' || n.topic === 'compact')
    scheduleTeamworkRefresh(e.ws);
  schedule('dock', renderDock);
  schedule('tabbar', renderTabbar);
  schedule('sidebar', renderSidebar);
  // 也作为聊天内的通知气泡（便于回溯）；同时记入本回合列表，回合结束的
  // 转录重载会把它们冲掉，届时按名单补回
  const bubble = { role: 'notice', text: n.d || (n.from + ' · ' + n.body), ts: n.created_at, notice: n };
  (t._turnNotices = t._turnNotices || []).push(bubble);
  pushMsgSilent(e.ws, bubble);
  markChat(e.ws);
  setTimeout(() => { n._new = false; }, 700);
}

/* ---------- 审批 --------------------------------------------------- */
function onApproval(e) {
  const t = ensureTab(e.ws);
  t.approval = { id: e.id, tool: e.tool, args: e.args, ws: e.ws };
  if (e.ws === S.active) { renderApproval(); }
  else { t.unread++; schedule('tabbar', renderTabbar); }
  S.pendingApprovals = Array.from(S.tabs.values()).filter(x => x.approval).length;
}
function onApprovalResolved(e) {
  const t = ensureTab(e.ws);
  if (t.approval && t.approval.id === e.id) t.approval = null;
  if (e.ws === S.active) renderApproval();
  S.pendingApprovals = Array.from(S.tabs.values()).filter(x => x.approval).length;
  schedule('tabbar', renderTabbar);
}

/* ---------- 消息助手 ----------------------------------------------- */
function pushMsg(ws, obj) {
  const t = ensureTab(ws);
  obj.id = obj.id || uid();
  if (obj.ts == null) obj.ts = nowSec();
  t.msgs.push(obj);
  if (ws !== S.active) t.unread++;
  markChat(ws);
  return obj;
}
function pushMsgSilent(ws, obj) {
  const t = ensureTab(ws);
  obj.id = obj.id || uid();
  if (obj.ts == null) obj.ts = nowSec();
  t.msgs.push(obj);
  return obj;
}

/* ---------- 数据刷新 ----------------------------------------------- */
async function refreshSessions() {
  const out = await cmd('sessions.list', {});
  if (out && out.sessions) {
    S.sessions = out.sessions;
    S.sessionsTotal = Number(out.total || out.sessions.length || 0);
    schedule('sidebar', renderSidebar);
  }
}
// quiet：后台轮询用（03-teamwork.js 的 dock 自动刷新）——失败不弹 toast，
// 工作区在拉取期间被删/关掉时静默放弃，等下一次渲染收掉轮询。
// jobsFor 记下已拉取的会话，切会话/回合结束会失效从而按需重拉（同存档架）；
// 返回 jobs 数组供调用方做「是否出现新任务」的判断。
async function refreshTeamwork(ws, quiet) {
  if (!ws) return null;
  let out;
  if (quiet) { try { out = await api('teamwork.list', { ws: ws }); } catch (e) { return null; } }
  else out = await cmd('teamwork.list', { ws: ws });
  const t = S.tabs.get(ws); if (!t) return null;
  if (out && out.jobs) {
    t.jobs = out.jobs;
    t.jobsFor = t.session;
    schedule('dock', renderDock);
    markChatTeamwork(ws);
    return out.jobs;
  }
  return null;
}
const _twNoticeTimers = new Map();
// 进度通知可能连续到达（一轮多个工具/子代理）：合并成一次拉取
function scheduleTeamworkRefresh(ws) {
  if (!ws) return;
  clearTimeout(_twNoticeTimers.get(ws));
  _twNoticeTimers.set(ws, setTimeout(() => {
    _twNoticeTimers.delete(ws);
    if (S.tabs.get(ws)) refreshTeamwork(ws, true);
  }, 600));
}
async function refreshNotices(ws) {
  if (!ws) return;
  const out = await cmd('notice.list', { ws: ws });
  const t = S.tabs.get(ws); if (!t) return;
  t.noticesLoaded = true;
  if (out && out.notices) {
    // 服务端列表（待投递 + 已投递历史）是权威来源：只合并最近 120s 内、
    // 服务端可能还没落盘的实时事件 —— 只增不删会让别的客户端 clear 后
    // 本端继续显示已删除的记录
    const ids = new Set(out.notices.map(n => n.id));
    const now = nowSec();
    const fresh = t.notices.filter(n => n.live && !ids.has(n.id) && (now - (n.created_at || now)) < 120);
    t.notices = out.notices.concat(fresh);
    rebuildNoticeGroups(t);
  }
  schedule('dock', renderDock);
}
// 存档架：只列 saved/*.jsonl（不读 transcript，回合后也能廉价刷新）。
// archivesFor 记下已拉取的会话，切会话/回合结束会失效从而按需重拉。
async function refreshArchives(ws, force) {
  if (!ws) return;
  const t = S.tabs.get(ws); if (!t) return;
  if (!force && t.archivesFor === t.session) return;
  t.archivesFor = t.session; // 先占位，防止并发重复拉取
  const out = await cmd('session.archives', { ws: ws, id: t.session });
  const t2 = S.tabs.get(ws); if (!t2) return;
  if (out && out.ok !== false && Array.isArray(out.archives)) t2.archives = out.archives;
  else t2.archivesFor = ''; // 失败允许重试
  schedule('dock', renderDock);
}
function markChatTeamwork(ws) { if (ws === S.active) schedule('dock', renderDock); }

function rebuildNoticeGroups(t) {
  const map = new Map();
  for (const n of t.notices) {
    const key = (n.from || '?') + '\u0000' + (n.topic || '') + '\u0000' + (pathFeature(n.body) || '');
    if (!map.has(key)) map.set(key, { key, from: n.from, topic: n.topic, items: [], pinned: n.topic === 'gate' || n.topic === 'job', newest: n.created_at });
    const g = map.get(key);
    g.items.push(n);
    g.newest = Math.max(g.newest, n.created_at || 0);
    if (n.topic === 'gate' || n.topic === 'job') g.pinned = true;
  }
  t.noticeGroups = Array.from(map.values()).sort((a, b) => (b.pinned - a.pinned) || (b.newest - a.newest));
}