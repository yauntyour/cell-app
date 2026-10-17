/* ---------- F. 渲染：侧栏 / 标签栏 / 状态 ------------------------- */
function cssId(ws) { return String(ws).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// 侧栏工作区分组的折叠状态（localStorage 持久化）。工作区可以并行打开，
// 分组头此前只是静态文字（g.open 恒为 true、无点击处理）——现在点击即折叠。
const GRP_KEY = 'cell.wGroups';
function loadGroupState() {
  try { return new Set(JSON.parse(localStorage.getItem(GRP_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function saveGroupState() {
  try { localStorage.setItem(GRP_KEY, JSON.stringify(Array.from(S.groupsClosed))); } catch (e) {}
}

function renderSidebar() {
  const list = $('#sessionList');
  if (!list) return;
  // 按工作区（group）聚合会话
  const groups = new Map();
  for (const w of S.workspaces) {
    if (!groups.has(w.ws)) groups.set(w.ws, { ws: w.ws, cwd: w.cwd, items: [], open: true, busy: w.busy });
  }
  for (const s of S.sessions) {
    if (!groups.has(s.ws)) groups.set(s.ws, { ws: s.ws, cwd: s.cwd, items: [], open: false, busy: false });
    const g = groups.get(s.ws);
    g.cwd = g.cwd || s.cwd;
    g.items.push(s);
  }
  // 折叠状态覆盖默认：未显式折叠过的工作区一律展开
  for (const [ws, g] of groups) g.open = !S.groupsClosed.has(ws);

  const nodes = [];
  for (const g of groups.values()) {
    const items = g.items;
    if (!g.open && !items.length) continue;

    const gEl = el('div', 'sgroup');
    const head = el('div', 'sgroup-head');
    head.setAttribute('aria-expanded', g.open ? 'true' : 'false');
    head.appendChild(el('span', 'gchev', '▸'));
    const gname = el('span', 'gname trunc', baseName(g.cwd) || shortId(g.ws));
    gname.title = g.cwd || g.ws;
    head.appendChild(gname);
    head.appendChild(el('span', 'cnt', '(' + g.items.length + ')'));
    const pulse = el('span', 'pulse' + (g.busy ? ' busy' : ''));
    pulse.title = g.busy ? '运行中' : (g.open ? '已展开' : '已折叠');
    if (!g.open) pulse.style.background = 'var(--fg3)';
    head.appendChild(pulse);
    const gdel = el('button', 'gdel');
    gdel.appendChild(iconEl('trash', 'sm'));
    gdel.title = '删除工作区（移除全部会话记录，保留目录）';
    gdel.style.marginLeft = 'auto';
    gdel.onclick = ev => { ev.stopPropagation(); deleteWorkspace(g.ws); };
    head.appendChild(gdel);
    head.title = (g.cwd || g.ws) + '\n点击' + (g.open ? '折叠' : '展开');
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
      const empty = el('div', 'dim tiny', '（暂无会话）');
      empty.style.padding = '2px 10px 6px';
      box.appendChild(empty);
    }
    for (const s of sorted) {
      const it = el('div', 'sitem' + (s.active ? ' active' : ''));
      const title = el('div', 'stitle trunc', s.title || shortId(s.id));
      title.title = s.title || s.id;
      const meta = el('div', 'smeta');
      meta.appendChild(el('span', 'sid', shortId(s.id)));
      meta.appendChild(el('span', null, relTime(s.mtime)));
      meta.appendChild(el('span', null, s.msgs + ' 条'));
      if (Number(s.jobs || 0) > 0) {
        const j = el('span', 'stag tw', '团队 ' + s.jobs);
        j.title = '该会话有 ' + s.jobs + ' 条 Teamwork 记录';
        meta.appendChild(j);
      }
      if (Number(s.archives || 0) > 0) {
        const a = el('span', 'stag ar', '存档 ' + s.archives);
        a.title = '该会话有 ' + s.archives + ' 个压缩历史存档（点击在右侧面板查看）';
        a.style.cursor = 'pointer';
        // 存档已从聊天流移入右侧面板：点标签直接去存档架看
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
      it.title = (s.title ? s.title + '\n' : '') + s.id + '\n' + (s.cwd || '');
      it.onclick = () => selectSession(s);
      box.appendChild(it);
    }
    gEl.appendChild(box);
    nodes.push(gEl);
  }
  list.replaceChildren(...nodes);
  if (!nodes.length) {
    const e = el('div', 'dim small');
    e.style.padding = '18px 12px'; e.textContent = '没有匹配的会话';
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
  // 后端会打开并激活对应工作区；本地同步
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
  // 已有会话：拉取完整详情（聊天记录 + 工具调用 + 存档 + 工作流）
  loadSessionDetail(s.ws, s.id);
  if (Number(s.jobs || 0) > 0) openDock('teamwork');
}

function renderTabbar() {
  const bar = $('#tabbar');
  if (!bar) return;
  const nodes = [];
  for (const ws of S.tabOrder) {
    const t = S.tabs.get(ws); if (!t) continue;
    const active = ws === S.active;
    const tb = el('div', 'tab' + (active ? ' active' : ''));
    tb.title = t.cwd || ws;
    const nm = el('span', 'tname trunc', baseName(t.cwd) || shortId(ws));
    if (t.busy) { const p = el('span', 'pulse busy'); p.style.width = '7px'; p.style.height = '7px'; tb.appendChild(p); }
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
// cwdHint: the path must be captured *before* the close round-trip — the
// hello event that follows already drops the workspace from S.tabs/S.workspaces
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
      row.appendChild(el('span', 'mpath', c.cwd));
      b.appendChild(iconEl('archive', 'sm'));
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
  // keep the backend's active workspace in sync with this tab: commands
  // without an explicit "ws" and state snapshots resolve against it, so a
  // diverged server state used to make a refresh jump to the wrong tab
  if (S.tabs.has(ws)) cmd('workspace.activate', { ws: ws });
  if (!navNavigating) Nav.push(ws);
  const t = tab(ws);
  t.unread = 0;
  renderPanes();
  syncComposerInput();
  markAll();
  schedule('composer', renderComposer);
  schedule('statline', renderStatLine);
}

/* ---------- 顶部导航：后退/前进（标签切换历史）/ 刷新 / 主页 --------- */
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
    toast('已刷新', 'ok', 1200);
  },
  // 主页：关闭一切浮层，回到第一个工作区的主聊天视图
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
  const closedCwd = cwdOf(ws); // capture before the round-trip clears state
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
  renderBrand();
}

/* ---------- 品牌标识：静止内联 logo / 运行态描线动画 ----------------
   与 /export 一样，消息流里没有人物头像：角色靠「角色点 + 角色名」表达
   （--user/--assistant/--tool/--system）。这里的 SVG 只出现在侧栏品牌区：
   静止态是 HTML 内联的 icon，忙碌态是同一条折线的描线动画。            */
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
  if (!brandIconNode) brandIconNode = box.firstElementChild; // HTML 内联的静态 logo
  const t = S.tabs.get(S.active);
  const busy = !!(t && t.busy);
  if (busy === brandBusy) return;
  brandBusy = busy;
  box.classList.toggle('busy', busy);
  box.title = busy ? '运行中' : '';
  box.replaceChildren(busy ? avaSVG() : brandIconNode);
}

function renderStatLine() {
  const t = S.tabs.get(S.active);
  const left = $('#statLeft');
  if (!left) return;
  if (!t) { left.textContent = '没有打开的工作区'; renderThinkBtn(); return; }
  // 只报环境（模型/沙箱/工具）：思考状态由消息流里的「思考中」指示器
  // 单独承担——此前这里也写一份「思考中 · Xs · Yms」，既与指示器重复，
  // 又因为只在 progress 事件里刷新而在回合结束后留下陈旧值。
  // 模型芯片与连接点原先在侧栏底部，现已并入这里（顶栏只留设置按钮）
  left.textContent = (S.model || '(none)') + ' · ' + (S.sandbox || '—') + ' · ' + (S.tools ? '工具开' : '工具关');
  renderThinkBtn();
}

/* ---------- 思考级别快捷设置（底行右侧） ----------------------------
   开关 = off，强度 = 1-4；点按钮弹出级别菜单（fixed 定位在按钮上方，
   不会像卡内浮层那样被输入卡的 overflow 裁掉）。执行复用 execSlash
   的 /think 通道（校验 + resync + 结果 toast 一套齐）。               */
function renderThinkBtn() {
  const box = $('#statRight');
  if (!box) return;
  box.replaceChildren();
  if (!S.tabs.get(S.active)) return;
  const lv = Number((S.settings || {}).think_level || 0);
  const l = THINK_LEVELS[lv] || THINK_LEVELS[0];
  const b = el('button', 'btn ghost sm thkbtn' + (lv > 0 ? ' on' : ''));
  b.appendChild(iconEl('bulb', 'sm'));
  b.appendChild(el('span', null, '思考：' + (lv > 0 ? l.name + ' (' + l.v + ')' : '关')));
  b.title = '快捷设置思考开关与强度';
  b.onclick = () => toggleThinkMenu(b);
  box.appendChild(b);
}
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
  // 点面板外（含按钮自身交由 onclick 切换）与 Esc 关闭
  const out = ev => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) closeThinkMenu(); };
  const key = ev => { if (ev.key === 'Escape') closeThinkMenu(); };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  thkMenu = { el: menu, out, key };
}

// 「思考中」指示器的秒表：指示器文本只在重绘时写一次，而等待首字期间消息流
// 没有可重绘的内容（「正在思考… 0.0s」会一直冻着）。空转极廉价：没有 busy
// 的标签就什么都不做；有则只改那一个文本节点。
setInterval(() => {
  if (document.hidden) return;
  for (const [, t] of S.tabs) {
    if (!t.busy || !t.thinkingSince) continue;
    const th = t._wrap && t._wrap.querySelector('.msg.thinking .thinking');
    if (th) th.textContent = '正在思考… ' + ((Date.now() - t.thinkingSince) / 1000).toFixed(1) + 's';
  }
}, 250);

/* ---------- 面板与聊天渲染 ----------------------------------------- */
function ensurePane(ws) {
  let pane = document.getElementById('pane-' + cssId(ws));
  if (pane) { const t = tab(ws); if (!t._wrap) { t._pane = pane; t._chat = $('.chat', pane); t._wrap = $('.chatwrap', pane); } return pane; }
  pane = el('div', 'tabpane'); pane.id = 'pane-' + cssId(ws);
  pane.classList.toggle('active', ws === S.active); // a lazily created pane must never start invisible
  const head = el('div', 'chathead'); head.id = 'chathead-' + cssId(ws);
  const ctitle = el('span', 'cht-title trunc', ''); ctitle.title = ws;
  head.appendChild(ctitle);
  head.appendChild(el('span', 'grow'));
  const clearBtn = el('button', 'btn ghost sm danger');
  clearBtn.appendChild(iconEl('trash', 'sm'));
  clearBtn.appendChild(el('span', null, '清空上下文'));
  clearBtn.title = '清空当前会话上下文（/clear，会中断正在进行的回合）';
  clearBtn.onclick = () => clearSession(ws);
  head.appendChild(clearBtn);
  pane.appendChild(head);
  const chat = el('div', 'chat'); chat.id = 'chat-' + cssId(ws);
  const wrap = el('div', 'chatwrap');
  chat.appendChild(wrap);
  pane.appendChild(chat);
  $('#tabview').appendChild(pane);
  const t = tab(ws); t._pane = pane; t._chat = chat; t._wrap = wrap;
  renderChatHead(ws);
  chat.addEventListener('scroll', () => { t._stick = isNearBottom(chat); });
  return pane;
}
function isNearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 140; }

// 会话面板顶栏：显示当前会话标题，并提供「清空上下文」按钮
function renderChatHead(ws) {
  const head = $('#chathead-' + cssId(ws));
  if (!head) return;
  const t = tab(ws);
  let title = baseName(cwdOf(ws)) || shortId(ws);
  if (t && t.session) {
    const s = (S.sessions || []).find(x => x.ws === ws && x.id === t.session);
    if (s) title = s.title || shortId(s.id);
  }
  const tt = $('.cht-title', head);
  if (tt) { tt.textContent = title; tt.title = title; }
}

// 清空当前会话上下文（/clear 的按钮入口；会先中断正在进行的回合）
async function clearSession(ws) {
  if (!(await confirmDlg('清空当前会话的全部上下文？此操作不可撤销（会先中断正在进行的回合）。', { title: '清空上下文', ok: '清空' }))) return;
  const out = await cmd('session.clear', { ws });
  if (out && out.ok === false) { toast(out.error || '清空失败', 'bad'); return; }
  await resync();
  toast('上下文已清空', 'ok');
}

// 删除一条会话（只删其转录 + 压缩存档，不动源码）；删除当前会话时后端会自动开新会话；
// 工作区未打开时后端直接删磁盘存档，无需先打开
async function deleteSession(s) {
  if (!(await confirmDlg('删除会话「' + (s.title || s.id) + '」？其对话历史将不可恢复。', { title: '删除会话', ok: '删除' }))) return;
  // 先记下要关的窗口：删除成功后后端会另开一条新会话并广播 hello，标签上的
  // session 届时已变成新 id——事后再比对就永远匹配不上了
  const openWs = Array.from(S.tabOrder)
    .filter(ws => { const t = S.tabs.get(ws); return t && t.session === s.id; });
  const out = await cmd('session.delete', { ws: s.ws, id: s.id });
  if (out && out.ok === false) { toast(out.error || '删除失败', 'bad'); return; }
  // 删的正是某个打开中的标签正在显示的会话：后端会另开一条新会话，前端不必
  // 留着窗口展示一条空会话 —— 直接关掉那个工作区窗口
  for (const ws of openWs) await closeWorkspace(ws);
  await resync();
  toast('会话已删除', 'ok');
}

// 删除工作区：只移除该工作区的全部会话记录（sessions 数据根下），cwd 目录
// 本身保留；对话历史不可恢复
async function deleteWorkspace(ws) {
  // 侧栏里属于已关闭/从未打开的工作区的分组没有 tab/workspace 条目，cwd 只能
  // 从会话行反查（与后端 sessions 索引同源）；拿不到就不要静默返回
  const cwd = cwdOf(ws) || (S.sessions.find(s => s.ws === ws) || {}).cwd || '';
  if (!cwd) { toast('找不到该工作区的目录，无法删除', 'bad'); return; }
  if (!(await confirmDlg('删除工作区「' + cwd + '」？\n将移除该工作区的全部会话记录（对话历史不可恢复）；目录本身不会被删除。',
                         { title: '删除工作区', ok: '删除' }))) return;
  const out = await cmd('workspace.delete', { ws, confirm: cwd });
  if (out && out.ok === false) { toast(out.error || '删除失败', 'bad'); return; }
  // 记录已删：resync 重刷工作区/标签，再显式拉一次会话列表——侧栏分组
  // （尤其是已关闭工作区的分组）不等 SSE hello 往复就直接消失
  await resync();
  await refreshSessions();
  toast('工作区已删除', 'ok');
}


function renderPanes() {
  for (const ws of S.tabOrder) {
    const pane = ensurePane(ws);
    pane.classList.toggle('active', ws === S.active);
  }
  for (const p of $$('.tabpane')) {
    const ws = p.id.replace(/^pane-/, '');
    const found = S.tabOrder.some(k => cssId(k) === ws);
    if (!found) p.remove();
  }
  // 启动时不再自动打开任何工作区（后端也不带），因此零标签是常态而非异常：
  // 给一块明确的引导面板，而不是留一片空白 + 一个用不了的输入栏
  renderNoWs();
}

// 零工作区时的引导面板：唯一的常驻入口是「打开工作区」
function renderNoWs() {
  const view = $('#tabview');
  if (!view) return;
  let pane = document.getElementById('pane-empty');
  const empty = S.tabOrder.length === 0;
  if (!empty) { if (pane) pane.remove(); return; }
  if (!pane) {
    pane = el('div', 'tabpane active'); pane.id = 'pane-empty';
    pane.appendChild(el('div', 'chat')).appendChild(el('div', 'chatwrap'));
    view.appendChild(pane);
  }
  pane.classList.add('active');
  const wrap = $('.chatwrap', pane);
  if (wrap.__built) return;
  wrap.__built = true;
  const box = el('div', 'empty');
  box.appendChild(el('h2', null, '打开一个目录开始'));
  box.appendChild(el('div', 'dim', 'cell 不会自动进入任何目录。选一个工作区后，会在其中恢复上次的会话，或新建一条。'));
  const hints = el('div', 'hints');
  const open = el('div', 'hint');
  open.appendChild(iconEl('folder'));
  open.appendChild(el('span', null, '打开工作区'));
  open.onclick = () => openWsDialog();
  hints.appendChild(open);
  // 最近关闭过的工作区可以直接接回来，省掉一次目录选择
  for (const c of (S.closedTabs || []).slice(0, 3)) {
    if (!c || !c.cwd) continue;
    const h = el('div', 'hint', '↻ ' + baseName(c.cwd));
    h.title = c.cwd;
    h.onclick = () => openWorkspace(c.cwd);
    hints.appendChild(h);
  }
  box.appendChild(hints);
  wrap.replaceChildren(box);
}

function reconcile(container, items, keyOf, make, update) {
  const existing = new Map();
  for (const c of Array.from(container.children)) if (c.__key != null) existing.set(c.__key, c);
  let prev = null;
  for (const it of items) {
    const k = keyOf(it);
    let node = existing.get(k);
    if (node) existing.delete(k);
    else { node = make(it); node.__key = k; }
    update(node, it);
    const ref = prev ? prev.nextSibling : container.firstChild;
    if (node !== ref) container.insertBefore(node, ref);
    prev = node;
  }
  for (const n of existing.values()) n.remove();
}

function renderChat(ws) {
  const t = S.tabs.get(ws); if (!t) return;
  ensurePane(ws);
  const chat = t._chat, wrap = t._wrap;
  if (!chat || !wrap) return;
  if (!t._md) t._md = new Map();
  if (t._stick == null) t._stick = true;

  let items = t.msgs.slice();
  const liveAsst = t._live && t._live.assistant;
  const liveReason = t._live && t._live.reason;
  if (!items.length && !t.busy) {
    wrap.replaceChildren(emptyState());
    t._md.clear();
    return;
  }
  // 空态块是「0 条消息」时整块换上的；消息到来后 reconcile 只管带 id 的消息
  // 节点，不会摘掉它（此前它一直挂在消息流末尾，空态和内容同屏）
  const emp = wrap.querySelector('.empty');
  if (emp) emp.remove();
  // 没有正在流式的内容时才挂「思考中」指示器：思考正文会由思考组实时展示
  if (t.busy && !liveAsst && !liveReason) items.push({ id: '__think__', role: '__thinking__' });
  items = groupFlow(items);

  wrap.classList.toggle('busy', !!t.busy);
  reconcile(wrap, items, m => m.id, makeMsg, (node, m) => updateMsg(node, m, t));

  if (t._stick) chat.scrollTop = chat.scrollHeight;
}

/* ---------------------------------------------------------------------
   流程分组：把一轮回合里的零散块按「工作流顺序」归组后渲染
     · 多个（连续的）tool 调用 → 一张「工具调用」折叠卡（收纳）
     · 被 tool 调用（甚至轮次条、通知）分开的思考块 → 合并进同一张
       「思考过程」折叠卡（收纳）
     · 轮次条并入工具组；整段没有工具时保持独立
     · 其余消息按原序排列；以下角色闭合分组：用户消息 / 状态 / 错误 /
       助手正文 / 孤儿工具结果——它们标志一个 think→act 阶段的结束。
       通知是异步旁路，不拆开思考流
   分组落在该组第一个成员的出现位置，因此整体仍是 think → act → answer。
   --------------------------------------------------------------------- */
const FLOW_CLOSERS = { user: 1, status: 1, error: 1, assistant: 1, toolres: 1 };
function groupFlow(items) {
  const out = [];
  let think = null, tools = null, rounds = null;
  for (const it of items) {
    if (it.role === 'reason') {
      if (!think) { think = { id: 'gfp-think-' + it.id, role: '__grpthink__', items: [] }; out.push(think); }
      think.items.push(it);
    } else if (it.role === 'tool') {
      if (!tools) {
        tools = { id: 'gfp-tools-' + it.id, role: '__grptools__', items: [] };
        out.push(tools);
        if (rounds) { tools.items.push(...rounds); rounds = null; }
      }
      tools.items.push(it);
    } else if (it.role === 'round') {
      if (tools) tools.items.push(it);
      else (rounds = rounds || []).push(it);
    } else {
      if (rounds) { out.push(...rounds); rounds = null; }
      out.push(it);
      if (FLOW_CLOSERS[it.role]) { think = null; tools = null; }
    }
  }
  if (rounds) out.push(...rounds);
  return out;
}

function emptyState() {
  const box = el('div', 'empty');
  box.appendChild(el('h2', null, '开始你的第一次对话'));
  box.appendChild(el('div', 'dim', '在下方输入消息，或使用 / 唤起指令面板。打开团队协作面板可编排多代理工作流。'));
  const hints = el('div', 'hints');
  const hs = [
    ['/teamwork 编排一个并行研究任务', () => { syncComposerText('/teamwork '); focusInput(); }],
    ['/model 切换模型', () => { syncComposerText('/model '); focusInput(); }],
    ['/workspace 打开另一个目录', () => openWsDialog()],
    ['查看演示模式', () => { if (!MOCK) location.search = '?mock=1'; }],
  ];
  for (const [txt, fn] of hs) { const h = el('div', 'hint', txt); h.onclick = fn; hints.appendChild(h); }
  box.appendChild(hints);
  return box;
}

/* ---------------------------------------------------------------------
   消息渲染：与 /export 导出页同一套排版（见 05-stream.css）
     角色点 + 等宽小型大写角色名 + prose 正文 + 极弱分隔线
   每条消息在创建时就填好正文（存档展开的子消息同样有内容），updateMsg
   只负责流式追加与状态同步——这正是此前「存档展开后只有空壳」的原因。
   --------------------------------------------------------------------- */
const ROLE_LABEL = {
  user: '你', assistant: '助手', sys: '系统提示', summary: '上下文摘要', tool: '工具',
  toolres: '工具结果', reason: '思考过程', status: '状态',
  notice: '通知', error: '错误',
};
// 角色点配色（--user/--assistant/--tool/--system/--other）
const ROLE_DOT = {
  user: 'user', assistant: 'assistant', sys: 'system', summary: 'system',
  tool: 'tool', toolres: 'tool', reason: 'other',
  status: 'other', notice: 'other', error: 'bad',
};

// cell.cpp 的压缩摘要落盘形式（runner::compact / teamwork worker）：
//   "# Here is a summary that captures the previous conversation:\n…"
//   "# Context was compacted to fit the model window. …"
// 现在摘要以 role:assistant 的消息存储；旧会话里也可能被折进 system 块。
const SUMMARY_MARKS = [
  '# Here is a summary that captures the previous conversation:',
  '# Context was compacted to fit the model window.',
];
// 文本里是否含压缩摘要；返回 {prompt, summary}（prompt 为摘要之前的正文）
function splitSummary(text) {
  const t = String(text == null ? '' : text);
  for (const mark of SUMMARY_MARKS) {
    const i = t.indexOf(mark);
    if (i >= 0)
      return { prompt: t.slice(0, i).replace(/\s+$/, ''), summary: t.slice(i) };
  }
  return null;
}
function isSummary(text) { return !!splitSummary(text); }

// 折叠开关：按钮 + 面板，点击切换 hidden（此前 sys 卡片的开关算错了状态，
// 永远是「已折叠」，所以点不动）。label = 折叠时的文案，openLabel = 展开后
function makeFold(head, panel, label, open, openLabel) {
  const btn = el('button', 'fold');
  const tri = el('span', 'tri', '▸');
  const txt = el('span', null, label);
  btn.appendChild(tri); btn.appendChild(txt);
  let isOpen = !!open;
  const labels = { closed: label, open: openLabel || label };
  const paint = () => {
    panel.hidden = !isOpen;
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    tri.textContent = isOpen ? '▾' : '▸';
    const want = isOpen ? labels.open : labels.closed;
    if (txt.textContent !== want) txt.textContent = want;
  };
  btn.onclick = ev => { ev.stopPropagation(); isOpen = !isOpen; paint(); };
  paint();
  head.appendChild(btn);
  return { btn, txt, labels, paint, isOpen: () => isOpen, set: v => { isOpen = !!v; paint(); } };
}

// 消息骨架：与 /export 一致 —— 一条消息就是「头部 + 正文」，没有头像列；
// 角色由头部左侧的角色点 + 等宽小型大写角色名表达。
function msgShell(m, cls) {
  const w = el('div', 'msg ' + (cls || m.role));
  const body = el('div', 'body');
  const head = el('div', 'head');
  const dot = el('span', 'dot ' + (ROLE_DOT[m.role] || 'other'));
  head.appendChild(dot);
  head.appendChild(el('span', 'role', ROLE_LABEL[m.role] || (m.role || 'msg')));
  head.appendChild(el('span', 'grow'));
  head.appendChild(el('span', 'mtime', m.ts ? hhmm(m.ts) : ''));
  const prose = el('div', 'prose');
  body.appendChild(head);
  body.appendChild(prose);
  w.appendChild(body);
  w._head = head; w._prose = prose;
  return w;
}
// 填正文：markdown（流式时交给 updateMsg 增量追加）
function fillProse(w, m) {
  const prose = w._prose;
  if (!prose) return w;
  const txt = m.text == null ? '' : String(m.text);
  if (prose.__txt === txt && !prose.__live) return w;
  prose.__txt = txt;
  // 工具结果是原始输出：走共享渲染器 → 收进一张 <details> 折叠卡
  // （摘要带工具名 / 路径 / 调用 id，与 /export 的 toolresult 卡片一致）
  if (m.role === 'toolres') {
    prose.innerHTML = renderContentHtml(txt, 'tool', m.callId || '');
    return w;
  }
  prose.innerHTML = renderMarkdown(txt);
  return w;
}

function makeMsg(m) {
  if (m.role === '__thinking__') {
    const w = el('div', 'msg thinking');
    const head = el('div', 'head');
    head.appendChild(el('span', 'dot assistant'));
    head.appendChild(el('span', 'role', '思考中'));
    const body = el('div', 'body');
    const th = el('div', 'thinking');
    th.appendChild(el('span', 'orb'));
    th.appendChild(el('span', null, '正在思考…'));
    body.appendChild(th);
    w.appendChild(head);
    w.appendChild(body);
    w._th = th;
    return w;
  }
  if (m.role === '__grpthink__') return makeThinkGroup(m);
  if (m.role === '__grptools__') return makeToolGroup(m);
  if (m.role === 'round') return makeRound(m);
  if (m.role === 'tool') { const n = makeTool(m); updateTool(n, m, 0); return n; }
  if (m.role === 'sys') return makeSys(m, false);
  if (m.role === 'summary') return makeSys(m, true);
  if (m.role === 'toolres') return makeToolRes(m);
  const w = msgShell(m);
  if (m.role === 'reason') { // 思考过程：默认折叠
    const panel = el('div', 'foldpanel');
    panel.appendChild(w._prose);
    w._fold = makeFold(w._head, panel, '思考过程', m.collapsed === false, '收起');
    $('.body', w).appendChild(panel);
    w._panel = panel;
    return fillProse(w, m);
  }
  return fillProse(w, m);
}

/* 分组卡公共骨架：头部 = 角色点 + 折叠按钮 + 统计 + grow，正文是折叠面板 */
function groupShell(cls, dotCls, foldLabel) {
  const w = el('div', 'msg tgrp ' + cls);
  const head = el('div', 'head');
  head.appendChild(el('span', 'dot ' + dotCls));
  const panel = el('div', 'foldpanel');
  w._fold = makeFold(head, panel, foldLabel, false, '收起');
  const meta = el('span', 'tmeta'); head.appendChild(meta);
  head.appendChild(el('span', 'grow'));
  const body = el('div', 'body');
  body.appendChild(panel);
  w.appendChild(head); w.appendChild(body);
  w._panel = panel; w._meta = meta; w._blocks = new Map();
  // 用户手动展开/收起后不再被流式状态自动改写
  w._fold.btn.addEventListener('click', () => { w._manual = true; });
  return w;
}
// 思考组：N 段思考（可被工具调用分开）收进一张折叠卡；流式时自动展开
function makeThinkGroup(m) {
  const w = groupShell('think', 'other', '思考过程');
  syncGroupChildren(w, m, makeThinkBlock);
  return w;
}
function makeThinkBlock(it) {
  const b = el('div', 'thinkblk');
  b.appendChild(el('div', 'prose'));
  b._prose = $('.prose', b);
  return b;
}
// 工具组：整段回合的工具调用（连同轮次条）收进一张折叠卡；运行中自动展开
function makeToolGroup(m) {
  const w = groupShell('tools', 'tool', '工具调用');
  syncGroupChildren(w, m, it => (it.role === 'round' ? makeRound(it) : makeTool(it)));
  return w;
}
// 分组成员只会追加：序列变了才重建子节点（流式文本节点随之按全量重建）
function syncGroupChildren(w, m, makeChild) {
  const ids = m.items.map(x => x.id).join('\u0000');
  if (w.__kids === ids) return;
  w.__kids = ids;
  w._blocks = new Map();
  const nodes = [];
  for (const it of m.items) {
    const c = makeChild(it);
    w._blocks.set(it.id, c);
    nodes.push(c);
  }
  w._panel.replaceChildren(...nodes);
}

// 系统提示 / 上下文摘要卡片：整块内容放进折叠面板，默认折叠，可展开
function makeSys(m, isSummary) {
  const w = msgShell(m, (isSummary ? 'summary' : 'sys') + ' cardmsg');
  const panel = el('div', 'foldpanel');
  panel.appendChild(w._prose);
  $('.body', w).appendChild(panel);
  w._panel = panel;
  // 折叠时的文案带条目规模，展开后只写「收起」
  const n = String(m.text || '').split('\n').length;
  w._fold = makeFold(w._head, panel, '展开 ' + n + ' 行', m.collapsed === false, '收起');
  m.collapsed = m.collapsed !== false;
  return fillProse(w, m);
}

// 未配对的工具结果（孤儿结果）：紧凑行
function makeToolRes(m) {
  const w = msgShell(m);
  return fillProse(w, m);
}

// 后端 transcript 条目 → 聊天消息对象（一条条目可能拆成多条：系统提示 + 摘要）
function detailEntries(e) {
  const out = [];
  const base = { id: uid(), ts: 0 };
  if (e.kind === 'summary') {
    out.push(Object.assign({}, base, { role: 'summary', text: e.text, collapsed: true }));
    return out;
  }
  if (e.kind === 'user') { out.push(Object.assign({}, base, { role: 'user', text: e.text })); return out; }
  if (e.kind === 'reasoning') {
    // 落盘的思考块（content 数组里的 reasoning/thinking）：折叠的思考过程
    out.push(Object.assign({}, base, { role: 'reason', text: e.text, collapsed: true }));
    return out;
  }
  if (e.kind === 'assistant' || e.kind === 'other') {
    // cell.cpp 现在把压缩摘要以 role:assistant 落盘 —— 认领为摘要卡
    const sp = splitSummary(e.text);
    if (sp) {
      if (sp.prompt) out.push(Object.assign({}, base, { role: 'assistant', text: sp.prompt }));
      out.push(Object.assign({ id: uid(), ts: 0 }, { role: 'summary', text: sp.summary, collapsed: true }));
    } else {
      out.push(Object.assign({}, base, { role: 'assistant', text: e.text }));
    }
    return out;
  }
  if (e.kind === 'system') {
    const sp = splitSummary(e.text);
    if (sp) {
      if (sp.prompt) out.push(Object.assign({}, base, { role: 'sys', text: sp.prompt, collapsed: true }));
      out.push(Object.assign({ id: uid(), ts: 0 }, { role: 'summary', text: sp.summary, collapsed: true }));
    } else {
      out.push(Object.assign({}, base, { role: 'sys', text: e.text, collapsed: true }));
    }
    return out;
  }
  if (e.kind === 'tool') {
    out.push(Object.assign({}, base, {
      role: 'tool', name: e.name, args: e.args, display: e.result || '',
      status: e.status || 'ok', expanded: false, seq: 0, started: 0,
    }));
    return out;
  }
  if (e.kind === 'tool_result') { out.push(Object.assign({}, base, { role: 'toolres', text: e.text })); return out; }
  out.push(Object.assign({}, base, { role: 'assistant', text: e.text || '' }));
  return out;
}
function detailMsg(e) { return detailEntries(e)[0]; }

// 拉取一个会话的完整详情（transcript + 存档列表），替换预览消息。
// done：装载完成（含失败/切走）后的回调，供回合结束后补一条状态消息
function loadSessionDetail(ws, id, done) {
  const t = S.tabs.get(ws);
  if (!t || !id) { if (done) done(); return; }
  if (t.busy || t.detailSession === id || t.detailLoading === id) return;
  t.detailLoading = id;
  cmd('session.history', { ws: ws, id: id }).then(out => {
    t.detailLoading = '';
    if (!out || out.ok === false) { if (done) done(); return; }
    if (S.tabs.get(ws) !== t || t.session !== id) { if (done) done(); return; } // 已切走
    t.detailSession = id;
    t.msgs = [];
    t._live = { assistant: null, reason: null, summary: null };
    t._liveMsgId = null;
    t._md = new Map();
    for (const e of (out.entries || []))
      for (const m of detailEntries(e)) t.msgs.push(m);
    // 历史存档不再进聊天流：列表交给 dock 存档架（点击在小窗里看全文），
    // archivesFor 记下已拉取的会话，回合结束会失效从而按需重拉
    t.archives = out.archives || [];
    t.archivesFor = id;
    schedule('dock', renderDock);
    markChat(ws);
    if (done) done();
  });
}
// 强制重载当前会话的转录（回合结束后用）：loadSessionDetail 对已加载过的
// 会话会早退，这里清掉 detailSession 让它重新拉取。落盘内容才是权威视图——
// 压缩产生的自动摘要、思考块、工具结果都以磁盘为准。
function reloadSessionDetail(ws, done) {
  const t = S.tabs.get(ws);
  if (!t || !t.session) { if (done) done(); return; }
  t.detailSession = '';
  loadSessionDetail(ws, t.session, done);
}

function makeRound(m) {
  const bar = el('div', 'roundbar');
  bar.appendChild(el('span', null, '轮次 ' + m.round));
  bar.appendChild(el('span', null, '↑' + (m.tok_in || 0) + ' ↓' + (m.tok_out || 0)));
  if (m.cache) bar.appendChild(el('span', null, '缓存 ' + m.cache));
  bar.appendChild(el('span', null, (Number(m.sec || 0)).toFixed(2) + 's'));
  if (m.ttft) bar.appendChild(el('span', null, '首字 ' + Math.round(m.ttft) + 'ms'));
  const g = el('span', 'grow-bar'); g.style.width = '60px'; g.style.flex = 'none';
  bar.appendChild(el('span', 'grow'));
  bar.appendChild(g);
  return bar;
}

function makeTool(m) {
  const card = el('div', 'tool');
  const box = el('div', 'tbox');
  const head = el('div', 'toolhead');
  head.appendChild(el('span', 'spin'));
  head.appendChild(el('span', 'tname', m.name || 'tool'));
  const st = el('span', 'tmeta'); head.appendChild(st);
  head.appendChild(el('span', 'grow'));
  head.appendChild(el('span', 'chev', '›'));
  const body = el('div', 'toolbody');
  body.hidden = !m.expanded; // 真折叠（hidden），不是 max-height 裁切
  head.onclick = () => { m.expanded = !m.expanded; card.classList.toggle('expanded', m.expanded); body.hidden = !m.expanded; };
  box.appendChild(head); box.appendChild(body);
  card.appendChild(box);
  card._head = head; card._body = body; card._st = st; card._spin = head.firstChild;
  return card;
}

function updateMsg(node, m, t) {
  if (m.role === '__thinking__') {
    const th = node._th ? $('.thinking span:last-child', node._th) : $('.thinking span:last-child', node);
    if (th && t.thinkingSince) th.textContent = '正在思考… ' + ((Date.now() - t.thinkingSince) / 1000).toFixed(1) + 's';
    return;
  }
  if (m.role === '__grpthink__') return updateThinkGroup(node, m, t);
  if (m.role === '__grptools__') return updateToolGroup(node, m, t);
  if (m.role === 'round' || m.role === 'tool') { updateTool(node, m, 0); return; }
  const prose = node._prose;
  if (!prose) return;

  // 流式：answer / reason / summary 三条通道各自有一个 live 对象
  const slot = (m.role === 'assistant' || m.role === 'reason' || m.role === 'summary') ? m.role : null;
  const liveMsg = slot && t._live ? t._live[slot] : null;
  const isStreaming = !!(liveMsg && liveMsg.id === m.id && m.streaming);
  if (isStreaming) {
    if (!prose.__live) {
      prose.replaceChildren(document.createTextNode(m.text));
      prose.__tn = prose.firstChild;
      prose.__live = true;
      t._md.set(m.id, prose);
      t._liveMsgId = m.id;
    }
    // 正在写的内容必须看得见：自动展开所在的折叠面板
    if (node._fold) node._fold.set(true);
  } else {
    prose.__live = false; prose.__tn = null;
    fillProse(node, m); // 内容变了才重渲染 markdown
    if (node._fold && m.collapsed === false) node._fold.set(true);
  }
  prose.classList.toggle('cursor', isStreaming);
}

// 思考组更新：流式段自动展开、实时追加；统计「N 段 · X 字符」
function updateThinkGroup(node, m, t) {
  syncGroupChildren(node, m, makeThinkBlock);
  const live = t._live && t._live.reason;
  let streaming = false, chars = 0;
  for (const it of m.items) {
    const blk = node._blocks.get(it.id);
    if (!blk) continue;
    const isStreaming = !!(live && live.id === it.id && it.streaming);
    fillThinkBlock(blk._prose, it, isStreaming, t);
    if (isStreaming) streaming = true;
    chars += (it.text || '').length;
  }
  if (!node._manual) node._fold.set(streaming);
  if (node._meta) node._meta.textContent = m.items.length + ' 段 · ' + chars + ' 字符';
}
function fillThinkBlock(prose, it, isStreaming, t) {
  const txt = it.text == null ? '' : String(it.text);
  if (isStreaming) {
    if (!prose.__live) {
      prose.replaceChildren(document.createTextNode(txt));
      prose.__tn = prose.firstChild;
      prose.__live = true;
      t._md.set(it.id, prose);
    }
  } else if (prose.__live || prose.__txt !== txt) {
    prose.__live = false; prose.__tn = null;
    prose.innerHTML = renderMarkdown(txt);
    prose.__txt = txt;
  }
  prose.classList.toggle('cursor', isStreaming);
}
// 工具组更新：运行中自动展开（用户手动接管后不再自动）；统计次数/耗时/字符
function updateToolGroup(node, m, t) {
  syncGroupChildren(node, m, it => (it.role === 'round' ? makeRound(it) : makeTool(it)));
  let running = 0, ok = 0, bad = 0, sec = 0, chars = 0;
  for (const it of m.items) {
    if (it.role !== 'tool') continue;
    const card = node._blocks.get(it.id);
    if (card) updateTool(card, it, 0);
    if (it.status === 'running') running++;
    else if (/error|denied|fail|blocked|unknown/.test(String(it.status || ''))) bad++;
    else ok++;
    sec += Number(it.sec || 0);
    chars += Number(it.chars || 0);
  }
  const tools = running + ok + bad;
  node.classList.toggle('run', running > 0);
  node.classList.toggle('ok', running === 0 && ok > 0 && bad === 0);
  node.classList.toggle('bad', bad > 0);
  if (!node._manual) node._fold.set(running > 0);
  if (node._meta) {
    const bits = [tools + ' 次'];
    if (running) {
      const rt = m.items.find(x => x.role === 'tool' && x.status === 'running');
      bits.push('运行中 ' + ((Date.now() - (rt ? rt.started : Date.now())) / 1000).toFixed(1) + 's');
    } else bits.push(sec.toFixed(2) + 's');
    if (chars) bits.push(chars + ' 字符');
    if (bad) bits.push(bad + ' 失败');
    node._meta.textContent = bits.join(' · ');
  }
}

function updateTool(node, m, runningTools) {
  if (m.role === 'round') return;
  const running = m.status === 'running';
  node.classList.toggle('running', running);
  node.classList.toggle('ok', m.status === 'ok' || m.status === 'success' || m.status === 'done');
  node.classList.toggle('bad', m.status === 'error' || m.status === 'denied' || m.status === 'fail' || m.status === 'failed');
  node.classList.toggle('expanded', !!m.expanded);
  if (node._spin) node._spin.style.display = running ? '' : 'none';
  if (node._st) {
    const bits = [];
    if (m.status && !running) bits.push(m.status);
    if (m.marker) bits.push(m.marker);
    if (m.sec) bits.push(Number(m.sec).toFixed(2) + 's');
    if (m.chars) bits.push(m.chars + ' 字符');
    if (running && m.started) bits.push(((Date.now() - m.started) / 1000).toFixed(1) + 's');
    node._st.textContent = bits.join(' · ');
  }
  if (node._body) {
    if (!node.__filled) {
      const a = el('div', 'lbl', '参数');
      const pre = el('pre'); pre.textContent = (m.args || '').length > 4000 ? m.args.slice(0, 4000) + '\n…' : (m.args || '');
      node._body.appendChild(a); node._body.appendChild(pre);
      const b = el('div', 'lbl', '结果');
      const res = el('div', 'toolres prose');
      node._body.appendChild(b); node._body.appendChild(res);
      node.__filled = true; node._res = res;
    }
    if (node._res) {
      // 工具输出同样收进折叠卡：<tool_output …> 包裹会被拆成摘要 + 正文
      const d = m.display == null ? '' : String(m.display);
      if (node._res.__txt !== d) {
        node._res.__txt = d;
        node._res.innerHTML = renderContentHtml(d, 'tool', '');
      }
    }
  }
}
