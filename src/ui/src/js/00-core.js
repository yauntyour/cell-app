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

const THINK_LEVELS = [
  { v: 0, name: 'off', desc: '不推理，最快' },
  { v: 1, name: 'minimal', desc: '极少推理' },
  { v: 2, name: 'low', desc: '低强度' },
  { v: 3, name: 'medium', desc: '中等强度' },
  { v: 4, name: 'high', desc: '高强度，最慢' },
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
  { name: '/compact', usage: '/compact <on|off>', desc: '自动上下文压缩', ctx: 'onoff' },
  { name: '/stop', usage: '/stop', desc: '停止当前工作区正在跑的回合', run: t => cmd('stop', { ws: S.active }) },
  { name: '/teamwork', usage: '/teamwork [run|resume|stop] <id>', desc: '列出/运行/恢复团队任务', ctx: 'teamwork' },
  { name: '/notice', usage: '/notice', desc: '查看通知列表', run: () => { openDock('notices'); refreshNotices(S.active); } },
  { name: '/archive', usage: '/archive', desc: '查看当前会话的历史存档（右侧面板）', run: () => { openDock('archives'); refreshArchives(S.active, true); } },
  { name: '/workspace', usage: '/workspace [path]', desc: '切换或打开工作区', ctx: 'workspaces' },
  { name: '/theme', usage: '/theme [default|名称]', desc: '切换第三方主题（默认与导出的会话页同源）', ctx: 'theme' },
  { name: '/help', usage: '/help', desc: '显示指令帮助', run: () => toast('输入 / 查看全部指令；↑↓ 选择，Tab 补全，Enter 执行', 'ok', 4200) },
];

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
   没有内置主题：默认外观就是 cell.cpp /export 导出页那一套（:root 浅色 +
   prefers-color-scheme 深色，见 00-tokens.css），因此「界面里的会话」
   与「导出的会话」同源。唯一的主题来源是第三方：放在与配置/会话/凭据
   相同的 <exe 目录>/.cell/theme/<名称>/ 下的 theme.json + theme.css，
   经 GET /api/themes 发现、GET /api/theme/<名称> 拉取后注入
   <style id="theme-ext">。只需重定义 CSS 变量即可完整换肤（含深浅）。
   选择持久化于 localStorage；URL ?theme=<名称> 可临时覆盖。           */
const Theme = {
  key: 'cell.theme', animKey: 'cell.anim',
  fallback: '', // 无第三方主题 = 默认外观（导出页那一套）
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
  providers: [], settings: {}, workspaces: [], sessions: [], models: [],
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
  if (out && out.ok !== false) applyHello(out, true);
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
  switch (e.t) {
    case 'hello': applyHello(e, true); break;
    case 'turn_begin': onTurnBegin(e.ws); break;
    case 'turn_end': onTurnEnd(e); break;
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
function applyHello(st, rebuild) {
  if (!st) return;
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

  if (Array.isArray(st.workspaces)) {
    S.workspaces = st.workspaces;
    for (const w of st.workspaces) {
      const t = tab(w.ws);
      t.cwd = w.cwd;
      if (t.session !== w.session) { t.session = w.session; t.detailSession = ''; }
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
    if (st.session && t.session !== st.session) { t.session = st.session; t.detailSession = ''; }
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
    if (!S.active || rebuild) S.active = ws;
  }
  if (st.active && S.tabOrder.includes(st.active)) S.active = st.active;

  markAll();
  syncComposerInput();
  // 可选：拉取会话与通知（非阻塞）
  if (rebuild) {
    refreshSessions();
    refreshNotices(S.active);
  }
}

function removeTab(ws) {
  S.tabs.delete(ws);
  S.tabOrder = S.tabOrder.filter(k => k !== ws);
  if (S.active === ws) S.active = S.tabOrder[S.tabOrder.length - 1] || '';
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
}
function onNotice(e) {
  const t = ensureTab(e.ws);
  const n = { id: e.nid || uid(), from: e.from || '', topic: e.topic || '', body: e.body || '', d: e.d || '', created_at: e.created_at || nowSec(), pending: true, _new: true };
  t.notices.push(n);
  rebuildNoticeGroups(t);
  if (e.ws !== S.active) t.unread++;
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
  if (out && out.sessions) { S.sessions = out.sessions; schedule('sidebar', renderSidebar); }
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
async function refreshNotices(ws) {
  if (!ws) return;
  const out = await cmd('notice.list', { ws: ws });
  const t = S.tabs.get(ws); if (!t) return;
  t.noticesLoaded = true;
  if (out && out.notices) {
    const seen = new Set(t.notices.map(n => n.id));
    for (const n of out.notices) if (!seen.has(n.id)) t.notices.push(n);
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
