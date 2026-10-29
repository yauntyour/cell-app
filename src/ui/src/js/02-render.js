/* ---------- F. 渲染：侧栏 / 标签栏 / 状态 ------------------------- */
function cssId(ws) { return String(ws).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// 侧栏工作区分组的折叠状态（localStorage 持久化）
const GRP_KEY = 'cell.wGroups';
function loadGroupState() {
  try { return new Set(JSON.parse(localStorage.getItem(GRP_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function saveGroupState() {
  try { localStorage.setItem(GRP_KEY, JSON.stringify(Array.from(S.groupsClosed))); } catch (e) {}
}

/* ---- 侧栏 -------------------------------------------------------- */
function renderSidebar() {
  const list = $('#sessionList');
  if (!list) return;
  const q = (S.sbFilter || '').trim().toLowerCase();
  const groups = new Map();
  for (const w of S.workspaces) {
    if (!groups.has(w.ws)) groups.set(w.ws, { ws: w.ws, cwd: w.cwd, items: [], busy: w.busy });
  }
  for (const s of S.sessions) {
    if (!groups.has(s.ws)) groups.set(s.ws, { ws: s.ws, cwd: s.cwd, items: [], busy: false });
    const g = groups.get(s.ws);
    g.cwd = g.cwd || s.cwd;
    if (q) {
      const hay = ((s.title || '') + ' ' + shortId(s.id) + ' ' + (s.cwd || '')).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    g.items.push(s);
  }
  for (const [ws, g] of groups) g.open = q ? true : !S.groupsClosed.has(ws);

  const nodes = [];
  for (const g of groups.values()) {
    const items = g.items;
    if (!g.open && !items.length) continue;

    const gEl = el('div', 'sgroup');
    const head = el('div', 'sgroup-head');
    head.setAttribute('aria-expanded', g.open ? 'true' : 'false');
    const gico = el('span', 'gico');
    gico.appendChild(iconEl('folder', 'sm'));
    head.appendChild(gico);
    const gname = el('span', 'gname trunc', baseName(g.cwd) || shortId(g.ws));
    gname.title = g.cwd || g.ws;
    head.appendChild(gname);
    head.appendChild(el('span', 'cnt', String(g.items.length)));
    const pulse = el('span', 'pulse' + (g.busy ? ' busy' : ''));
    pulse.title = g.busy ? '运行中' : (g.open ? '已展开' : '已折叠');
    if (!g.busy) pulse.style.background = g.open ? 'var(--ok)' : 'var(--fg4)';
    head.appendChild(pulse);
    const gdel = el('button', 'gdel');
    gdel.appendChild(iconEl('trash', 'sm'));
    gdel.title = '删除工作区（移除全部会话记录，保留目录）';
    gdel.onclick = ev => { ev.stopPropagation(); deleteWorkspace(g.ws); };
    head.appendChild(gdel);
    head.title = (g.cwd || g.ws) + ' | 点击' + (g.open ? '折叠' : '展开');
    head.setAttribute('aria-expanded', g.open ? 'true' : 'false');
    head.onclick = () => {
      if (S.groupsClosed.has(g.ws)) S.groupsClosed.delete(g.ws);
      else S.groupsClosed.add(g.ws);
      saveGroupState();
      renderSidebar();
    };
    gEl.appendChild(head);

    const sorted = items.slice().sort((a, b) => (b.active - a.active) || (b.mtime - a.mtime));
    const box = el('div', 'sgroup-items');
    box.hidden = !g.open;
    if (!sorted.length) {
      const empty = el('div', 'dim tiny', q ? '（无匹配会话）' : '（暂无会话）');
      empty.style.padding = '2px 10px 6px';
      box.appendChild(empty);
    }
    for (const s of sorted) {
      const it = el('div', 'sitem' + (s.active ? ' active' : ''));
      const title = el('div', 'stitle trunc', s.title || shortId(s.id));
      title.title = s.title || s.id;
      const meta = el('div', 'smeta');
      meta.appendChild(el('span', '', relTime(s.mtime)));
      meta.appendChild(el('span', null, s.msgs + ' 条'));
      const wt = (typeof s.worktree === 'string' && s.worktree) || '';
      if (wt) {
        const wtag = el('span', 'stag', '⑂ ' + wt);
        wtag.title = '会话所在 Git worktree 分支：' + wt;
        meta.appendChild(wtag);
      }
      if (Number(s.jobs || 0) > 0) {
        const j = el('span', 'stag tw', '团队 ' + s.jobs);
        j.title = '该会话有 ' + s.jobs + ' 条 Teamwork 记录';
        meta.appendChild(j);
      }
      if (Number(s.archives || 0) > 0) {
        const a = el('span', 'stag ar', '存档 ' + s.archives);
        a.title = '该会话有 ' + s.archives + ' 个压缩历史存档（点击在右侧面板查看）';
        a.style.cursor = 'pointer';
        a.onclick = ev => { ev.stopPropagation(); selectSession(s); openDock('archives'); };
        meta.appendChild(a);
      }
      if (s.busy) { const d = el('span', 'dot run'); d.style.marginLeft = 'auto'; meta.appendChild(d); }
      it.appendChild(title);
      it.appendChild(meta);
      const del = el('button', 'idel');
      del.appendChild(iconEl('trash', 'sm'));
      del.title = '删除会话';
      del.onclick = ev => { ev.stopPropagation(); deleteSession(s); };
      it.appendChild(del);
      it.title = (s.title ? s.title + ' | ' : '') + s.id + ' | ' + (s.cwd || '');
      it.onclick = () => selectSession(s);
      box.appendChild(it);
    }
    gEl.appendChild(box);
    nodes.push(gEl);
  }
  list.replaceChildren(...nodes);
  if (!nodes.length) {
    const e = el('div', 'empty');
    e.innerHTML = iconHtml('message', 'lg') + (q ? '没有匹配的会话' : '还没有会话，点上方「＋ 新会话」开始');
    list.appendChild(e);
  }
  if (S.sessionsTotal && S.sessionsTotal > S.sessions.length) {
    const more = el('div', 'dim tiny', '仅显示最近 ' + S.sessions.length + ' / ' + S.sessionsTotal + ' 条会话');
    more.style.padding = '4px 10px 10px';
    list.appendChild(more);
  }
}

async function selectSession(s) {
  const out = await cmd('session.select', { ws: s.ws, id: s.id });
  if (out && out.ok === false) return;
  if (!S.tabs.has(s.ws)) tab(s.ws);
  if (!S.tabOrder.includes(s.ws)) S.tabOrder.push(s.ws);
  S.active = s.ws;
  Nav.push(s.ws);
  const t = tab(s.ws);
  if (t.session !== s.id) { t.session = s.id; t.detailSession = ''; }
  t.unread = 0;
  t.loaded = true;
  await resync();
  refreshTeamwork(s.ws);
  loadSessionDetail(s.ws, s.id);
  if (Number(s.jobs || 0) > 0) openDock('teamwork');
}

/* ---- 标签栏 ------------------------------------------------------ */
function renderTabbar() {
  const bar = $('#tabbar');
  if (!bar) return;
  const nodes = [];
  for (const ws of S.tabOrder) {
    const t = S.tabs.get(ws); if (!t) continue;
    const active = ws === S.active;
    const tb = el('div', 'tab' + (active ? ' active' : ''));
    tb.title = t.cwd || ws;
    if (t.busy) { const p = el('span', 'pulse busy'); tb.appendChild(p); }
    else tb.appendChild(iconEl('folder', 'sm'));
    const nm = el('span', 'tname trunc', baseName(t.cwd) || shortId(ws));
    tb.appendChild(nm);
    const badge = t.approval ? 'warn' : '';
    if (t.unread > 0 || t.approval) {
      tb.appendChild(el('span', 'badge' + (badge ? ' ' + badge : ''), t.approval ? '!' : (t.unread > 9 ? '9+' : String(t.unread))));
    }
    const x = el('button', 'x', '✕');
    x.title = '关闭工作区';
    x.onclick = ev => { ev.stopPropagation(); closeWorkspace(ws); };
    tb.appendChild(x);
    tb.onclick = () => activateWs(ws);
    tb.oncontextmenu = ev => { ev.preventDefault(); tabMenu(ev, ws); };
    nodes.push(tb);
  }
  const add = el('button', 'tab-add');
  add.appendChild(iconEl('plus'));
  add.title = '打开工作区 / 最近关闭';
  add.onclick = ev => { ev.stopPropagation(); tabAddMenu(ev); };
  nodes.push(add);
  bar.replaceChildren(...nodes);
}

/* ---------- 标签页“+”菜单：打开工作区 + 最近关闭历史 ---------------- */
const CLOSED_KEY = 'cell.closedTabs';
function loadClosedTabs() {
  try { return JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]'); } catch (e) { return []; }
}
function saveClosedTabs() {
  try { localStorage.setItem(CLOSED_KEY, JSON.stringify(S.closedTabs.slice(0, 8))); } catch (e) {}
}
function rememberClosed(ws, cwdHint) {
  const cwd = cwdHint || cwdOf(ws);
  if (!cwd) return;
  S.closedTabs = [{ cwd, ts: nowSec() }]
    .concat(S.closedTabs.filter(x => x.cwd !== cwd))
    .slice(0, 8);
  saveClosedTabs();
}
function tabAddMenu(ev) {
  hideTabMenu();
  const r = ev.currentTarget.getBoundingClientRect();
  const m = el('div', 'tabmenu');
  const open = el('button');
  open.innerHTML = iconHtml('folder') + '<span class="grow">打开工作区…</span>';
  open.onclick = () => { hideTabMenu(); openWsDialog(); };
  m.appendChild(open);
  const list = S.closedTabs.filter(x => !S.workspaces.some(w => w.cwd === x.cwd));
  if (list.length) {
    m.appendChild(el('div', 'mhead', '最近关闭'));
    const lw = el('div', 'mlist');
    for (const c of list) {
      const b = el('button');
      const row = el('div', 'mrow');
      row.appendChild(el('span', 'mtitle trunc', baseName(c.cwd)));
      row.appendChild(el('span', 'mpath trunc', c.cwd));
      b.appendChild(iconEl('folder', 'sm'));
      b.appendChild(row);
      b.appendChild(el('span', 'tiny dim', relTime(c.ts)));
      b.title = c.cwd;
      b.onclick = () => { hideTabMenu(); openWorkspace(c.cwd); };
      lw.appendChild(b);
    }
    m.appendChild(lw);
  }
  document.body.appendChild(m);
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  S.tabMenuNode = m;
  setTimeout(() => document.addEventListener('click', hideTabMenu, { once: true }), 0);
}
function hideTabMenu() { if (S.tabMenuNode) { S.tabMenuNode.remove(); S.tabMenuNode = null; } }

async function activateWs(ws) {
  if (ws === S.active) return;
  S.active = ws;
  if (S.tabs.has(ws)) cmd('workspace.activate', { ws: ws });
  if (!navNavigating) Nav.push(ws);
  const t = tab(ws);
  t.unread = 0;
  if (S.dock === 'files' || S.dock === 'git' || S.dock === 'terminal') schedule('dockRefresh', () => { if (window.Panels) Panels.refresh(S.dock); });
  renderPanes();
  syncComposerInput();
  markAll();
  schedule('composer', renderComposer);
  schedule('statline', renderStatLine);
  renderDock();
}

/* ---------- 导航：后退/前进（标签切换历史）/ 刷新 / 主页 ------------ */
let navNavigating = false;
const Nav = {
  hist: [], idx: -1,
  push(ws) {
    if (!ws) return;
    if (this.idx >= 0 && this.hist[this.idx] === ws) return;
    this.hist = this.hist.slice(0, this.idx + 1);
    this.hist.push(ws);
    if (this.hist.length > 50) this.hist.shift();
    this.idx = this.hist.length - 1;
    paintNav();
  },
  go(delta) {
    const next = this.idx + delta;
    if (next < 0 || next >= this.hist.length) return;
    this.idx = next;
    navNavigating = true;
    try { activateWs(this.hist[next]); } finally { navNavigating = false; }
    paintNav();
  },
  back() { this.go(-1); },
  fwd() { this.go(1); },
  refresh() {
    resync();
    refreshSessions();
    if (S.active) { refreshTeamwork(S.active); refreshNotices(S.active); }
    if (window.Panels) Panels.refresh(S.dock);
    toast('已刷新', 'ok', 1200);
  },
  home() {
    if (S.settingsOpen) closeSettings();
    closeModal();
    hideTabMenu();
    hideCtx();
    const slash = $('#slashPanel');
    if (slash) slash.classList.remove('show');
    const first = S.tabOrder[0];
    if (first && first !== S.active) activateWs(first);
    const t = S.tabs.get(S.active);
    if (t && t._chat) t._chat.scrollTop = t._chat.scrollHeight;
    paintNav();
  },
};
function paintNav() {
  const b = $('#navBack'), f = $('#navFwd');
  if (b) b.toggleAttribute('disabled', Nav.idx <= 0);
  if (f) f.toggleAttribute('disabled', Nav.idx >= Nav.hist.length - 1);
}

function tabMenu(ev, ws) {
  const m = $('#ctxmenu');
  const items = [
    { t: '复制工作区路径', f: () => { const c = cwdOf(ws); if (c) navigator.clipboard && navigator.clipboard.writeText(c); toast('已复制路径', 'ok'); } },
    { t: '在 Git 面板查看', f: () => openDock('git') },
    { t: '重新加载状态', f: () => resync() },
    { t: '关闭工作区', f: () => closeWorkspace(ws) },
  ];
  m.replaceChildren(...items.map(it => { const b = el('button', null, it.t); b.onclick = () => { hideCtx(); it.f(); }; return b; }));
  m.style.left = ev.clientX + 'px'; m.style.top = ev.clientY + 'px';
  m.style.display = 'block';
  setTimeout(() => document.addEventListener('click', hideCtx, { once: true }), 0);
}
function hideCtx() { const m = $('#ctxmenu'); m.style.display = 'none'; }

async function closeWorkspace(ws) {
  const t = S.tabs.get(ws);
  const closedCwd = cwdOf(ws);
  if (t && t.busy) {
    if (!(await confirmDlg('该工作区正在运行一个回合，关闭会中断它。确认关闭？', { title: '关闭工作区', ok: '关闭' }))) return;
    await cmd('stop', { ws: ws });
  }
  const out = await cmd('workspace.close', { ws: ws });
  if (out && out.ok === false) return;
  rememberClosed(ws, closedCwd);
  removeTab(ws);
  await resync();
}

function renderFoot() {
  const dot = $('#connDot');
  if (dot) {
    dot.className = 'pulse' + (S.connected ? '' : ' busy');
    dot.style.background = S.connected ? 'var(--ok)' : 'var(--bad)';
    dot.title = S.connected ? '已连接' : '连接断开';
  }
  const sub = $('#sbConnState');
  if (sub) {
    sub.textContent = S.mode === 'demo' ? '演示模式' : (S.connected ? '已连接' : '重连中…');
    sub.classList.toggle('online', S.mode !== 'demo' && S.connected);
    sub.classList.toggle('demo', S.mode === 'demo');
  }
  renderBrand();
  paintUsageChip(); // 侧栏底部「用量」chip：数字跟 S.usages 走
}

/* ---------- 品牌标识 ------------------------------------------------ */
function avaSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 500 500');
  svg.setAttribute('class', 'ava');
  svg.innerHTML =
    '<g fill="none" stroke="currentColor" stroke-width="30" stroke-linejoin="miter" stroke-linecap="square">' +
    '<rect class="ava-frame" x="90" y="90" width="320" height="320"/>' +
    '<path class="ava-path" pathLength="100" d="M 170 170 L 170 330 L 250 330 L 250 170 L 330 170 L 330 410"/>' +
    '</g>';
  return svg;
}
let brandBusy = null, brandIconNode = null;
function renderBrand() {
  const box = $('#brandLogo');
  if (!box) return;
  if (!brandIconNode) brandIconNode = box.firstElementChild;
  const t = S.tabs.get(S.active);
  const busy = !!(t && t.busy);
  if (busy === brandBusy) return;
  brandBusy = busy;
  const brand = $('#brandWrap');
  if (brand) brand.classList.toggle('busy', busy);
  box.classList.toggle('busy', busy);
  box.title = busy ? '运行中' : '';
  box.replaceChildren(busy ? avaSVG() : brandIconNode);
}

function renderStatLine() {
  const t = S.tabs.get(S.active);
  const left = $('#statLeft');
  if (!left) return;
  if (!t) { left.textContent = '没有打开的工作区'; return; }
  const sandbox = { 'read-only': '只读', 'edit-only': '仅编辑', 'full-access': '完全访问' }[S.sandbox] || S.sandbox || '—';
  left.textContent = (S.model || '(无模型)') + ' · ' + sandbox + ' · ' + (S.tools ? '工具开' : '工具关');
}

/* ---------- 思考级别菜单（保留兼容；不再自动写 #statRight） ---------- */
let thkMenu = null;
function closeThinkMenu() {
  if (!thkMenu) return;
  thkMenu.el.remove();
  document.removeEventListener('pointerdown', thkMenu.out, true);
  document.removeEventListener('keydown', thkMenu.key, true);
  thkMenu = null;
}
function toggleThinkMenu(anchor) {
  if (thkMenu) { closeThinkMenu(); return; }
  const menu = el('div', 'thkmenu');
  const cur = Number((S.settings || {}).think_level || 0);
  for (const l of THINK_LEVELS) {
    const row = el('div', 'scmd' + (l.v === cur ? ' sel' : ''));
    row.appendChild(el('span', 'sname', l.name + ' (' + l.v + ')'));
    row.appendChild(el('span', 'sdesc', l.desc));
    row.onclick = () => { closeThinkMenu(); execSlash(S.tabs.get(S.active), '/think', String(l.v)); };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  menu.style.bottom = (innerHeight - r.top + 6) + 'px';
  const out = ev => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) closeThinkMenu(); };
  const key = ev => { if (ev.key === 'Escape') closeThinkMenu(); };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  thkMenu = { el: menu, out, key };
}
function renderThinkBtn() { /* 思考级别已并入输入栏模型 chip；函数保留兼容 */ }

/* 运行态指示器的秒表（旧消息流可能仍有 .thinking 节点） */
setInterval(() => {
  if (document.hidden) return;
  for (const [, t] of S.tabs) {
    if (!t.busy || !t.thinkingSince) continue;
    const th = t._wrap && t._wrap.querySelector('.msg.thinking .thinking');
    if (th) th.textContent = '正在思考… ' + ((Date.now() - t.thinkingSince) / 1000).toFixed(1) + 's';
  }
}, 250);

/* =====================================================================
   右侧 dock 外壳：开合 / 页签 / 派发
   新面板（files/git/terminal）通过 window.Panels 注册（08b-panels.js）
   ===================================================================== */
const DOCK_KEY = 'cell.dock';
const DOCK_LABEL = { start: '开始', files: '工作区文件', git: 'Git / Worktree', terminal: '终端', teamwork: 'Teamwork', notices: '通知', archives: '存档' };
function dockRestore() {
  let had = false;
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      had = !!j;
      if (j && typeof j.open === 'boolean') S.dockOpen = j.open;
      if (j && DOCK_LABEL[j.tab]) S.dock = j.tab;
    }
  } catch (e) {}
  // 首次启动：宽窗口默认打开「开始」，窄窗口（右栏是覆盖式）默认收起，
  // 否则面板会盖住输入栏与消息区
  if (!had) { S.dockOpen = window.innerWidth > 980; S.dock = 'start'; }
  if (!DOCK_LABEL[S.dock]) S.dock = 'start';
  const dk = $('#rightdock');
  if (dk) dk.classList.toggle('open', S.dockOpen);
}
function dockSave() {
  try { localStorage.setItem(DOCK_KEY, JSON.stringify({ open: S.dockOpen, tab: S.dock })); } catch (e) {}
}
function toggleDock() { S.dockOpen ? closeDock() : openDock(S.dock); }
function openDock(name) {
  // 用量统计不在右栏了（左侧栏 ⌂ 旁边的收纳浮层）：旧调用点/旧链接统一改道
  if (name === 'usages') { openUsagePop(true); return; }
  if (name && DOCK_LABEL[name]) S.dock = name;
  S.dockOpen = true;
  const dk = $('#rightdock');
  if (dk) dk.classList.add('open');
  Layout.apply();
  paintDockToggle();
  dockSave();
  schedule('dock', renderDock);
  if (window.Panels && Panels.has(S.dock) && S.active) schedule('dockRefresh', () => Panels.refresh(S.dock));
  // 打开 Teamwork 时永远拉一次最新列表：任务可能是在面板关着的时候建的
  if (S.dock === 'teamwork' && S.active) schedule('dockRefresh', () => refreshTeamwork(S.active, true));
}
function closeDock() {
  S.dockOpen = false;
  const dk = $('#rightdock');
  if (dk) dk.classList.remove('open');
  Layout.apply();
  paintDockToggle();
  dockSave();
  syncTwPoll();
}
function paintDockToggle() {
  const label = DOCK_LABEL[S.dock] || '面板';
  for (const id of ['navDock', 'btnTopDock']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.classList.toggle('on', S.dockOpen);
    b.setAttribute('aria-pressed', S.dockOpen ? 'true' : 'false');
    b.title = (S.dockOpen ? '收起 ' : '打开 ') + label + ' 面板';
  }
}
function renderDock() {
  const body = $('#dockBody');
  if (!body) return;
  syncTwPoll();
  $$('.docktab').forEach(b => b.classList.toggle('on', b.dataset.dock === S.dock));
  paintDockToggle();
  if (!S.dockOpen) return;
  const t = curTab();
  if (S.dock === 'start') { renderStartPanel(body, t); return; }
  if (window.Panels && Panels.has(S.dock)) {
    try { Panels.render(S.dock, body, t); } catch (e) { console.error(e); body.replaceChildren(el('div', 'empty', '面板渲染失败：' + e.message)); }
    return;
  }
  // 用量统计是全局的（不依赖工作区），入口在左侧栏底部：见 openUsagePop
  if (!t) { body.replaceChildren(el('div', 'empty', '没有打开的工作区')); return; }
  if (S.dock === 'teamwork') renderDockTeamwork(body, t);
  else if (S.dock === 'archives') renderDockArchives(body, t);
  else renderDockNotices(body, t);
}

/* 「开始」面板：快捷入口卡（对齐 DSH 右侧「开始」） */
function quickCard(cls, icon, title, desc, kbd, onclick, disabled) {
  const b = el('button', 'quick-card ' + cls);
  if (disabled) { b.disabled = true; b.title = '先打开一个工作区'; }
  const ic = el('span', 'qc-icon');
  ic.appendChild(iconEl(icon, 'lg'));
  b.appendChild(ic);
  const body = el('span', 'qc-body');
  body.appendChild(el('span', 'qc-title', title));
  body.appendChild(el('span', 'qc-desc', desc));
  b.appendChild(body);
  b.appendChild(el('span', 'kbd qc-kbd', kbd));
  if (onclick) b.onclick = onclick;
  return b;
}
function renderStartPanel(body, t) {
  const wrap = el('div', 'start-panel');
  const head = el('div', 'start-head');
  head.appendChild(el('span', 'start-title', '开始'));
  head.appendChild(el('span', 'start-sub', t ? '从工作区、Git 或终端开始' : '先打开一个工作区'));
  wrap.appendChild(head);
  const spacer = el('div', 'start-spacer');
  const wm = el('span', 'start-watermark');
  wm.appendChild(iconEl('compass', 'xl'));
  spacer.appendChild(wm);
  wrap.appendChild(spacer);
  const cards = el('div', 'start-cards');
  const noWs = !t;
  cards.appendChild(quickCard('files', 'folderOpen', '工作区文件', '浏览工作区的文件', 'Ctrl+P', () => { if (window.openQuickOpen) openQuickOpen(); else openDock('files'); }, noWs));
  cards.appendChild(quickCard('git', 'gitBranch', 'Git Worktree', '分支、改动与并行工作树', 'Ctrl+G', () => openDock('git'), noWs));
  cards.appendChild(quickCard('term', 'squareTerminal', '新建终端', '在工作区运行命令', 'Ctrl+反引号', () => openDock('terminal'), noWs));
  cards.appendChild(quickCard('search', 'search', '会话搜索', '检索全部会话内容', 'Ctrl+Shift+F', () => openSearch(), false));
  wrap.appendChild(cards);
  body.replaceChildren(wrap);
}

/* ---- 侧栏：收起 / 筛选 ------------------------------------------- */
const SIDEBAR_KEY = 'cell.sidebarCollapsed';
function paintSidebarToggle() {
  const col = !!S.sidebarCollapsed;
  // 顶栏按钮在侧栏收起后仍然可见——它是重新打开侧栏的入口
  const top = $('#btnSidebarTop');
  if (top) {
    top.setAttribute('aria-pressed', col ? 'false' : 'true');
    top.title = (col ? '展开侧栏' : '收起侧栏') + ' (Ctrl+B)';
    top.classList.toggle('on', col);
  }
}
function restoreSidebarState() {
  let col = false;
  try { col = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (e) {}
  S.sidebarCollapsed = col;
  const sb = $('#sidebar');
  if (sb) sb.classList.toggle('collapsed', col);
  paintSidebarToggle();
}
function toggleSidebar() {
  const sb = $('#sidebar');
  if (!sb) return;
  const col = sb.classList.toggle('collapsed');
  S.sidebarCollapsed = col;
  // 收纳浮层挂在侧栏上：侧栏收起就一起收掉，免得浮在半空
  if (col && typeof closeUsagePop === 'function') closeUsagePop();
  try { localStorage.setItem(SIDEBAR_KEY, col ? '1' : '0'); } catch (e) {}
  paintSidebarToggle();
  setTimeout(() => Layout.apply(), 180);
}
function toggleSidebarFilter() {
  const box = $('#sbFilterBox');
  if (box) {
    S.sbFilter = '';
    box.remove();
    renderSidebar();
    return;
  }
  const wrap = el('div', 'sb-filterbox');
  wrap.id = 'sbFilterBox';
  const inp = el('input');
  inp.type = 'text';
  inp.className = 'sb-filter';
  inp.placeholder = '筛选会话…';
  inp.oninput = () => { S.sbFilter = inp.value; renderSidebar(); };
  inp.onkeydown = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); toggleSidebarFilter(); } };
  wrap.appendChild(inp);
  const sidebar = $('#sidebar');
  sidebar.insertBefore(wrap, $('#sessionList'));
  inp.focus();
}