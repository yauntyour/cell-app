/* ---------- F2. 消息流：用户 / 助手 / 思考 / 工具 / 回合产物 ----------
   与外壳（02-render.js）分开维护，保证「会话体验」这一块只由本文件负责：
     · 用户消息：右对齐气泡（--raise2 / radius 18 / max-width 78%）
     · 助手消息：无气泡，22px logo 头像 + prose 正文（14.5px / 1.75）
     · 思考过程：折叠行（流式中自动展开，结束后收起）
     · 工具调用：紧凑行卡（中文名 + 等宽名 + 状态点 + 耗时），点开看参数/结果
     · 轮次条 / 回合状态行 / 通知卡 / 审批卡 / 摘要卡
     · 回合产物：已编辑 N 个文件卡（git.numstat 前后快照）+ 用量与操作行
     · 空态 hero：logo +「构建未至之境」+ 预览版胶囊 + 工作区/沙箱 chips
  见 docs/ui-redesign.md §5.5 / §5.6 / §7.3；样式在 css/05-stream.css。       */

/* ---------- 工具名 / 状态 / 格式化 ---------------------------------- */
const TOOL_ZH = {
  read: '读取文件', read_file: '读取文件', view: '查看', view_file: '查看文件',
  write: '写入文件', write_file: '写入文件', create_file: '新建文件',
  edit: '编辑文件', edit_file: '编辑文件', apply_patch: '应用补丁', patch: '应用补丁',
  multiedit: '批量编辑', bash: '执行命令', shell: '执行命令', exec: '执行命令',
  run_command: '执行命令', terminal: '终端', command: '执行命令',
  list: '列出目录', list_dir: '列出目录', ls: '列出目录', glob: '匹配文件', find: '查找文件',
  grep: '搜索内容', search: '搜索内容', ripgrep: '搜索内容',
  web_search: '联网搜索', web_fetch: '抓取网页', fetch: '抓取网页', browser: '浏览器',
  think: '思考', todo: '更新计划', todo_write: '更新计划', plan: '更新计划',
  task: '子任务', agent: '子代理', subagent: '子代理', teamwork: '团队任务', tw: '团队任务',
  delete: '删除文件', move: '移动文件', copy: '复制文件', mkdir: '新建目录',
  upload: '上传文件', download: '下载文件',
};
const TOOL_ICON = {
  read: 'file', read_file: 'file', view: 'eye', view_file: 'eye', write: 'pencil', write_file: 'pencil',
  edit: 'pencil', edit_file: 'pencil', apply_patch: 'pencil', patch: 'pencil', multiedit: 'pencil',
  bash: 'terminal', shell: 'terminal', exec: 'terminal', run_command: 'terminal', terminal: 'terminal',
  list: 'folder', list_dir: 'folder', ls: 'folder', glob: 'folder', find: 'folder',
  grep: 'search', search: 'search', ripgrep: 'search',
  web_search: 'external', web_fetch: 'external', fetch: 'external', browser: 'external',
  think: 'sparkles', todo: 'checkCircle', todo_write: 'checkCircle', plan: 'checkCircle',
  teamwork: 'users', tw: 'users', subagent: 'users', agent: 'users',
};
const SANDBOX_LABEL = { 'read-only': '只读', 'edit-only': '仅编辑', 'full-access': '完全访问' };
function toolZh(name) {
  const n = String(name || '');
  return TOOL_ZH[n] || TOOL_ZH[n.toLowerCase()] || n || '工具';
}
function toolIconName(name) {
  const n = String(name || '');
  return TOOL_ICON[n] || TOOL_ICON[n.toLowerCase()] || 'code';
}
// 工具状态 → 语义类（run/ok/bad/warn/idle）
function toolKind(s) {
  s = String(s || '').toLowerCase();
  if (/run|active|progress|working|pending/.test(s)) return 'run';
  if (/(^|_)(ok|done|complete|success|approved)/.test(s)) return 'ok';
  if (/fail|error|denied|abort|cancel|blocked|unknown/.test(s)) return 'bad';
  if (/warn|skip/.test(s)) return 'warn';
  return 'idle';
}
function fmtTok(n) {
  n = Number(n || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}
function fmtDur(sec) {
  sec = Number(sec || 0);
  if (sec >= 10) return sec.toFixed(1) + 's';
  return sec.toFixed(2) + 's';
}
function fnvName(p) { return baseName(String(p || '')) || String(p || ''); }

/* 品牌 logo（与侧栏/图标同形，纯描边，随 currentColor） */
function logoSvg(cls) {
  return '<svg class="' + (cls || 'logo-svg') + '" viewBox="0 0 500 500" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-width="34" stroke-linejoin="miter" stroke-linecap="square">' +
    '<rect x="78" y="78" width="344" height="344"/>' +
    '<path d="M 158 158 L 158 342 L 250 342 L 250 158 L 342 158 L 342 430"/>' +
    '</g></svg>';
}
function avatarEl(cls) {
  const a = el('span', 'ava ' + (cls || ''));
  a.innerHTML = logoSvg('ava-svg');
  return a;
}

/* ---------- 面板与窗格 ---------------------------------------------- */
function ensurePane(ws) {
  let pane = document.getElementById('pane-' + cssId(ws));
  if (pane) { const t = tab(ws); if (!t._wrap) { t._pane = pane; t._chat = $('.chat', pane); t._wrap = $('.chatwrap', pane); } return pane; }
  pane = el('div', 'tabpane'); pane.id = 'pane-' + cssId(ws);
  pane.classList.toggle('active', ws === S.active);
  const head = el('div', 'chathead'); head.id = 'chathead-' + cssId(ws);
  const ctitle = el('span', 'cht-title trunc', ''); ctitle.title = ws;
  head.appendChild(ctitle);
  head.appendChild(el('span', 'grow'));
  const clearBtn = el('button', 'icon-btn sm', '');
  clearBtn.appendChild(iconEl('trash', 'sm'));
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
  bindChatScroll(ws);
  return pane;
}

/* 自动跟底（stick）与「回到底部」按钮：
   流式输出时每次渲染都会尝试滚到底部，但只应在用户本来就贴着底部时发生。
   旧实现用 140px 阈值——用户往上滚一小段（<140px）仍被判定为「在底部」，
   下一次流式渲染就把视图拉回去，表现成「输出时无法上下滚动」。这里：
     · 阈值收到 28px，几乎只有真正在底部才算贴着；
     · 滚轮向上时立刻脱离跟底（不等 scroll 事件，避免同一帧被拉回）；
     · 离开底部且内容可滚动时，在输入卡上方显示「回到底部」悬浮按钮。 */
const CHAT_STICK_PX = 28;
function isNearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < CHAT_STICK_PX; }
function maxScrollOf(node) { return Math.max(0, node.scrollHeight - node.clientHeight); }
/* 贴底只走瞬时滚动：平滑滚动的目标高度是「启动那一刻」的 scrollHeight，
   而窗口化列表滚到新位置后才会挂载末尾条目（估算高度换成实测高度），
   scrollHeight 中途长高 → 动画停在半路，正是「回到底部滑一段就停」。 */
function scrollChatBottom(chat) {
  if (!chat) return;
  try { chat.scrollTo({ top: chat.scrollHeight, behavior: 'instant' }); }
  catch (e) { chat.scrollTop = chat.scrollHeight; }
}
function bindChatScroll(ws) {
  const t = tab(ws);
  const chat = t._chat;
  if (!chat || chat.__bound) return;
  chat.__bound = true;
  chat.addEventListener('scroll', () => {
    t._stick = isNearBottom(chat);
    paintJump(ws);
    // 窗口化的重算是有成本的（O(n) 前缀和），滚动事件里只在「离开上次窗口太远」时触发
    if (t._win) {
      const far = Math.abs((chat.scrollTop || 0) - (t._win.top || 0));
      if (far > Math.max(240, (chat.clientHeight || 600) * 0.3)) markChat(ws);
    }
  }, { passive: true });
  chat.addEventListener('wheel', ev => {
    if (ev.deltaY < 0) {
      // 目标位置已经在阈值之外 → 立即脱离跟底
      if (chat.scrollTop + ev.deltaY < maxScrollOf(chat) - CHAT_STICK_PX) t._stick = false;
    } else if (ev.deltaY > 0 && isNearBottom(chat)) {
      t._stick = true;
    }
    paintJump(ws);
  }, { passive: true });
  ensureJumpButton(ws);
}
function ensureJumpButton(ws) {
  const t = tab(ws);
  const pane = t._pane;
  if (!pane) return null;
  let btn = pane.querySelector('.jump-bottom');
  if (!btn) {
    btn = el('button', 'jump-bottom');
    btn.type = 'button';
    btn.title = '回到底部（恢复自动跟底）';
    btn.appendChild(iconEl('chevronDown', 'sm'));
    btn.appendChild(el('span', null, '回到底部'));
    btn.onclick = ev => {
      ev.stopPropagation();
      t._stick = true;
      scrollChatBottom(t._chat);
      // 滚到当时的高度只挂载了旧窗口；按「贴底」重排一次，末尾条目才真正挂上
      // （估算高度换成实测高度后 scrollHeight 还会变），否则会停在离底部一段处
      markChat(ws);
      paintJump(ws);
    };
    pane.appendChild(btn);
  }
  paintJump(ws);
  return btn;
}
function paintJump(ws) {
  const t = tab(ws);
  if (!t || !t._chat || !t._pane) return;
  const btn = t._pane.querySelector('.jump-bottom');
  if (!btn) return;
  const chat = t._chat;
  const scrollable = chat.scrollHeight > chat.clientHeight + 8;
  const show = !!scrollable && !t._stick && !chat.classList.contains('hero-mode');
  btn.classList.toggle('show', show);
}
// 窗口尺寸变化时重新判断是否显示（内容高度随之变化）
window.addEventListener('resize', () => {
  for (const ws of S.tabOrder) { try { paintJump(ws); } catch (e) {} }
});

// 会话面板顶栏：当前会话标题
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
  // 清空后会话 id 不变，上一回合的产物卡/快照要一起作废，否则新回合会先
  // 闪出旧编辑卡
  const t = S.tabs.get(ws);
  if (t) { t._turnMeta = null; t._turnSnap = null; }
  await resync();
  toast('上下文已清空', 'ok');
}

// 删除一条会话（只删其转录 + 压缩存档，不动源码）；删除当前会话时后端会自动开新会话
async function deleteSession(s) {
  if (!(await confirmDlg('删除会话「' + (s.title || s.id) + '」？其对话历史将不可恢复。', { title: '删除会话', ok: '删除' }))) return;
  const openWs = Array.from(S.tabOrder)
    .filter(ws => { const t = S.tabs.get(ws); return t && t.session === s.id; });
  const out = await cmd('session.delete', { ws: s.ws, id: s.id });
  if (out && out.ok === false) { toast(out.error || '删除失败', 'bad'); return; }
  for (const ws of openWs) await closeWorkspace(ws);
  await resync();
  toast('会话已删除', 'ok');
}

// 删除工作区：只移除该工作区的全部会话记录（sessions 数据根下），cwd 目录本身保留
async function deleteWorkspace(ws) {
  const cwd = cwdOf(ws) || (S.sessions.find(s => s.ws === ws) || {}).cwd || '';
  // cwd 反查不到 = 目录已被移走/删除，只剩 sessions 记录。这种情况仍要能删，
  // 否则分组永远挂在侧栏里（删除只清记录，从不碰目录）；确认串退化为 ws
  const ask = cwd
    ? '删除工作区「' + cwd + '」？\n将移除该工作区的全部会话记录（对话历史不可恢复）；目录本身不会被删除。'
    : '删除工作区「' + shortId(ws) + '」？\n该工作区的目录已不存在，只剩会话记录；删除会清掉这些记录（对话历史不可恢复）。';
  if (!(await confirmDlg(ask, { title: '删除工作区', ok: '删除' }))) return;
  const out = await cmd('workspace.delete', { ws, confirm: cwd || ws });
  if (out && out.ok === false) { toast(out.error || '删除失败', 'bad'); return; }
  await resync();
  await refreshSessions();
  toast('工作区已删除', 'ok');
}

// #centre 的空态类：#centre.hero（有工作区无消息）/ #centre.no-ws（无工作区）
// 由 04-layout.css 用它们把悬浮输入卡下移到视口中部，hero 内容在其上方居中
function paintCentreMode(hero, noWs) {
  const c = document.getElementById('centre');
  if (!c) return;
  c.classList.toggle('hero', !!hero);
  c.classList.toggle('no-ws', !!noWs);
}

function renderPanes() {
  for (const ws of S.tabOrder) {
    const pane = ensurePane(ws);
    pane.classList.toggle('active', ws === S.active);
  }
  for (const p of Array.from($$('.tabpane'))) {
    if (p.id === 'pane-empty') { p.remove(); continue; }
    const ws = p.id.replace(/^pane-/, '');
    const found = S.tabOrder.some(k => cssId(k) === ws);
    if (!found) p.remove();
  }
  renderNoWs();
  if (S.active) {
    const t = tab(S.active);
    const empty = !!t && !t.msgs.length && !t.busy;
    paintCentreMode(empty, false);
  } else paintCentreMode(false, true);
}

// 零工作区时的引导面板：常驻入口是「打开工作区」
function renderNoWs() {
  const view = $('#tabview');
  if (!view) return;
  let pane = document.getElementById('pane-empty');
  const empty = S.tabOrder.length === 0;
  if (!empty) { if (pane) pane.remove(); return; }
  if (!pane) {
    pane = el('div', 'tabpane active'); pane.id = 'pane-empty';
    const chat = el('div', 'chat');
    chat.appendChild(el('div', 'chatwrap'));
    pane.appendChild(chat);
    view.appendChild(pane);
  }
  pane.classList.add('active');
  paintCentreMode(false, true);
  const chat = $('.chat', pane);
  if (chat) chat.classList.add('hero-mode');
  const wrap = $('.chatwrap', pane);
  if (wrap.__built) return;
  wrap.__built = true;
  pane.classList.add('hero');
  wrap.appendChild(heroWrap(heroNoWs()));
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

/* ---------------------------------------------------------------------
   窗口化：百万级上下文里，一条转录可能有几千个节点、十几万行文本。
   全挂上去的代价不是「建 DOM」（几十 ms），而是浏览器给整条转录排版
   （实测 1.69M tokens 时 364ms / 85%）。所以只挂视口附近的一段，
   上下用等高占位（.flowpad）撑住滚动条：
     · 已挂载过的条目用实测高度（t._h）
     · 从没挂过的用 canvas 测出来的估算（02b-measure.js，Pretext 式算术）
     · 非贴底时按锚点校正 scrollTop，估算误差不会让视图跳动
   --------------------------------------------------------------------- */
const VIRT_MIN_ITEMS = 140;   // 条目数超过这个才窗口化（普通会话行为完全不变）
const VIRT_OVERSCAN = 900;    // 视口上下各多挂的像素
const CHAT_PAD_TOP = 22;      // .chat 的 padding-top（占位高度要对齐）

function flowGapOf(m) { return FLOW_GAP[m.role] == null ? 18 : FLOW_GAP[m.role]; }

/* 算出这一帧要挂载的条目区间；返回带上下占位的数组 */
function buildWindow(t, items, chat, wrap) {
  if (!t._h) t._h = new Map();
  if (!t._est) t._est = new Map();
  const textW = Math.max(200, (wrap.clientWidth || 720) - 48);
  const n = items.length;
  const pitch = new Array(n), tops = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    let p = t._h.get(it.id);
    if (p == null) {
      p = t._est.get(it.id);
      if (p == null) { p = estimateFlowItem(it, textW).pitch; t._est.set(it.id, p); }
    }
    pitch[i] = p; tops[i] = total; total += p;
  }
  const viewH = chat.clientHeight || 600;
  // 贴底时窗口按「底部对齐」算：新打开的大会话也得先看到最后一屏，
  // 而不是先挂载开头、再滚到底部形成一次空屏
  const viewTop = t._stick
    ? Math.max(0, total - viewH)
    : Math.max(0, (chat.scrollTop || 0) - CHAT_PAD_TOP);
  const minY = viewTop - VIRT_OVERSCAN, maxY = viewTop + viewH + VIRT_OVERSCAN;

  let lo = 0, hi = n - 1, start = n - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tops[mid] + pitch[mid] >= minY) { start = mid; hi = mid - 1; } else lo = mid + 1; }
  if (start > n - 1) start = n - 1;
  lo = start; hi = n - 1;
  let end = start;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (tops[mid] <= maxY) { end = mid; lo = mid + 1; } else hi = mid - 1; }

  const out = [];
  if (start > 0) out.push({ id: '__padT__', role: 'pad', h: Math.round(tops[start]) });
  for (let i = start; i <= end; i++) out.push(items[i]);
  const below = total - (tops[end] + pitch[end]);
  if (below > 1) out.push({ id: '__padB__', role: 'pad', h: Math.round(below) });
  t._win = { start: start, end: end, top: chat.scrollTop || 0, count: n };
  return out;
}

/* 非贴底时记住视口顶部那一条，重排后按它的位移校正滚动位置 */
function captureAnchor(t, chat) {
  if (t._stick || !t._nodes || !t._nodes.size) return null;
  const ct = chat.getBoundingClientRect().top;
  for (const [key, node] of t._nodes) {
    if (!node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (r.bottom > ct + 1) return { key: key, top: r.top };
  }
  return null;
}
function restoreAnchor(t, chat, anchor) {
  if (!anchor || !t._nodes) return;
  const node = t._nodes.get(anchor.key);
  if (!node) return;
  const d = node.getBoundingClientRect().top - anchor.top;
  if (Math.abs(d) > 0.5) chat.scrollTop += d;
}

/* ---------- 渲染主入口 ---------------------------------------------- */
function renderChat(ws) {
  const t = S.tabs.get(ws); if (!t) return;
  ensurePane(ws);
  const chat = t._chat, wrap = t._wrap;
  if (!chat || !wrap) return;
  if (!t._md) t._md = new Map();
  if (t._stick == null) t._stick = true;

  // 兜底：内核若没调 ChatTurns（旧版 00-core.js），用 busy 边沿补一次快照
  if (t.busy && !t._turnSnap) { try { ChatTurns.begin(ws); } catch (e) {} }
  else if (!t.busy && t._turnSnap) { try { ChatTurns.end({ ws: ws }); } catch (e) {} }

  let items = t.msgs.slice();
  const isEmpty = !items.length && !t.busy;
  restickOnNewUser(t);

  if (ws === S.active) paintCentreMode(isEmpty, false);
  chat.classList.toggle('hero-mode', isEmpty);
  const pane = t._pane;
  if (pane) pane.classList.toggle('hero', isEmpty);

  if (isEmpty) {
    t._stick = true;
    if (wrap.__mode !== 'hero') { wrap.__mode = 'hero'; wrap.replaceChildren(); t._md.clear(); }
    if (!wrap.firstChild) wrap.appendChild(emptyState());
    else {
      // 空态重绘时只刷新 chips（沙箱模式/工作区名可能在别处被改），
      // 不整块替换 hero，避免闪烁
      const chips = wrap.querySelector('.hero-box .hero-chips');
      if (chips) chips.replaceChildren(heroWsChip(t), heroModeChip());
    }
    paintJump(ws);
    return;
  }
  if (wrap.__mode === 'hero') { wrap.__mode = 'stream'; wrap.replaceChildren(); }
  wrap.__mode = 'stream';

  // 等待/思考指示器：回合进行中一直有（标题+副标题按真实阶段变化），
  // 流式正文也会出现在它上面——用户始终能看到「现在卡在哪一步」。
  if (t.busy) items.push({ id: '__think__', role: '__thinking__' });
  items = groupFlow(items);
  items = withTurnMeta(items, t);
  if (ws === S.active && t.approval) items.push({ id: '__approval__' + t.approval.id, role: '__approval__' });

  wrap.classList.toggle('busy', !!t.busy);
  // 条目多时只挂载视口附近：pads 由 reconcile 一起管理（同样的 key/顺序语义）
  const virt = items.length > VIRT_MIN_ITEMS;
  const shown = virt ? buildWindow(t, items, chat, wrap) : items;
  const anchor = virt ? captureAnchor(t, chat) : null;
  reconcile(wrap, shown, m => m.id, makeMsg, (node, m) => updateMsg(node, m, t));
  if (virt) {
    // 记下节点索引，供锚点校正与「挂载后回填实测高度」用
    t._nodes = new Map();
    for (const c of wrap.children) if (c.__key != null) t._nodes.set(c.__key, c);
    for (const it of shown) {
      if (it.role === 'pad') continue;
      const node = t._nodes.get(it.id);
      if (!node) continue;
      const h = node.offsetHeight;
      if (h > 0) t._h.set(it.id, h + flowGapOf(it));
    }
    if (t._h.size > 4000) t._h.clear();
    if (t._est.size > 4000) t._est.clear();
  } else if (t._win) {
    t._win = null;
  }
  // 流式期间只在用户仍贴着底部时跟底；用户滚上去后保持当前位置
  if (t._stick) scrollChatBottom(chat);
  else if (anchor) restoreAnchor(t, chat, anchor);
  paintJump(ws);
}

/* 用户发了新消息（或切到另一条会话）时重新贴底；转录重载/回合结束不打断
   用户正在阅读的位置（靠「最后一条用户消息的签名」区分）。 */
function userSigOf(t) {
  let n = 0, txt = '';
  for (const m of t.msgs) if (m.role === 'user') { n++; txt = String(m.text == null ? '' : m.text); }
  return n + '|' + txt.slice(0, 80);
}
function restickOnNewUser(t) {
  const sig = userSigOf(t);
  if (t._userSig != null && t._userSig !== sig && sig.charAt(0) !== '0') t._stick = true;
  t._userSig = sig;
}

/* 回合产物（编辑卡 + 用量行）插在「回合状态行」之前；没有状态行则追加到末尾 */
function withTurnMeta(items, t) {
  const meta = t._turnMeta;
  if (!meta || meta.session !== t.session) return items;
  if (items.some(x => x.role === '__turnmeta__')) return items;
  const node = { id: '__turnmeta__', role: '__turnmeta__', meta: meta };
  let lastStatus = -1;
  for (let i = items.length - 1; i >= 0; i--) { if (items[i].role === 'status') { lastStatus = i; break; } }
  if (lastStatus >= 0) items.splice(lastStatus, 0, node);
  else items.push(node);
  return items;
}

/* ---------------------------------------------------------------------
   流程分组：把一轮回合里的零散块按「工作流顺序」归组
     · 连续的思考块 → 一张「思考过程」折叠行
     · 连续的工具调用 + 轮次条 → 一张「工具调用」折叠卡
     · 思考 与 工具 **互不合并**：模型「先 CoT、再调工具、再 CoT」时，
       后一段推理是新的一块，排在它前面的工具卡之后——否则整轮 CoT 会被
       并成一大块，读起来像「一大整块 CoT + 工具记录」
     · 用户 / 状态 / 错误 / 助手正文 / 孤儿工具结果闭合分组
   --------------------------------------------------------------------- */
const FLOW_CLOSERS = { user: 1, status: 1, error: 1, assistant: 1, toolres: 1 };
function groupFlow(items) {
  const out = [];
  let think = null, tools = null, rounds = null;
  const flushRounds = () => { if (rounds) { out.push(...rounds); rounds = null; } };
  for (const it of items) {
    if (it.role === 'reason') {
      tools = null; // 工具调用打断了思考：后续 CoT 另起一块
      flushRounds();
      if (!think) { think = { id: 'gfp-think-' + it.id, role: '__grpthink__', items: [] }; out.push(think); }
      think.items.push(it);
    } else if (it.role === 'tool') {
      // Teamwork 工具渲染成独立的结构化大卡（团队任务已创建），不塞进
      // 「工具调用」折叠组——否则展开就是一坨原始 JSON。
      if (isTwTool(it)) {
        flushRounds();
        think = null; tools = null;
        out.push(it);
        continue;
      }
      think = null; // 工具之前的 CoT 到此收尾
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
      flushRounds();
      out.push(it);
      if (FLOW_CLOSERS[it.role]) { think = null; tools = null; }
    }
  }
  flushRounds();
  return out;
}

/* ---------- hero 空态 ------------------------------------------------- */
function heroWrap(box) {
  const w = el('div', 'hero-wrap');
  w.appendChild(box);
  return w;
}
function heroBrandRow(title, withPv) {
  const row = el('div', 'hero-brand');
  const lg = el('span', 'hero-logo');
  lg.innerHTML = logoSvg('hero-logo-svg');
  row.appendChild(lg);
  row.appendChild(el('h1', 'hero-title', title));
  if (withPv) row.appendChild(el('span', 'hero-pv', '预览版'));
  return row;
}
// 契约函数：有工作区但会话为空时的 hero
function emptyState() {
  const t = curTab();
  const box = el('div', 'hero-box');
  box.appendChild(heroBrandRow('构建未至之境', true));
  const chips = el('div', 'hero-chips');
  chips.appendChild(heroWsChip(t));
  chips.appendChild(heroModeChip());
  box.appendChild(chips);
  return heroWrap(box);
}
// 无工作区：同一个 hero 位置，换文案与主按钮
function heroNoWs() {
  const box = el('div', 'hero-box');
  box.appendChild(heroBrandRow('打开一个工作区开始', false));
  box.appendChild(el('div', 'hero-sub', 'cell 不会自动进入任何目录。选择一个工作区后，会在其中恢复上次的会话，或新建一条。'));
  const actions = el('div', 'hero-actions');
  const open = el('button', 'btn accent');
  open.appendChild(iconEl('folder', 'sm'));
  open.appendChild(el('span', null, '打开工作区'));
  open.onclick = () => openWsDialog();
  actions.appendChild(open);
  box.appendChild(actions);
  const recent = (S.closedTabs || []).filter(c => c && c.cwd).slice(0, 3);
  if (recent.length) {
    const row = el('div', 'hero-recent');
    row.appendChild(el('span', 'hr-label', '最近打开'));
    for (const c of recent) {
      const b = el('button', 'hchip');
      b.appendChild(iconEl('folder', 'sm'));
      b.appendChild(el('span', 'trunc', baseName(c.cwd)));
      b.title = c.cwd;
      b.onclick = () => openWorkspace(c.cwd);
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  return box;
}
function heroWsChip(t) {
  const b = el('button', 'hchip');
  b.title = t && t.cwd ? t.cwd : '切换工作区';
  b.appendChild(iconEl('folder', 'sm'));
  b.appendChild(el('span', 'trunc', baseName((t && t.cwd) || cwdOf(S.active)) || shortId(S.active) || '工作区'));
  b.appendChild(iconEl('chevronDown', 'sm'));
  b.onclick = ev => {
    ev.stopPropagation();
    const rows = [];
    for (const w of S.workspaces) rows.push({
      label: baseName(w.cwd) || shortId(w.ws), hint: w.cwd, icon: 'folder',
      on: () => { if (w.ws !== S.active) activateWs(w.ws); },
    });
    rows.push({ label: '打开其他目录…', icon: 'folderPlus', on: () => openWsDialog() });
    popMenu(b, rows);
  };
  return b;
}
function heroModeChip() {
  const b = el('button', 'hchip');
  const mode = S.sandbox || 'full-access';
  b.title = '切换沙箱模式';
  b.appendChild(iconEl('shield', 'sm'));
  b.appendChild(el('span', null, SANDBOX_LABEL[mode] || mode));
  b.appendChild(iconEl('chevronDown', 'sm'));
  b.onclick = ev => {
    ev.stopPropagation();
    const rows = SANDBOX_MODES.map(m => ({
      label: SANDBOX_LABEL[m.v] || m.v, hint: m.desc, icon: 'shield', active: m.v === (S.sandbox || ''),
      on: () => setSandboxMode(m.v),
    }));
    popMenu(b, rows);
  };
  return b;
}
function setSandboxMode(mode) {
  if (mode === S.sandbox) return;
  cmd('settings.set', { patch: { sandbox_mode: mode } }).then(out => {
    if (!out || out.ok === false) return;
    S.sandbox = mode;
    renderChat(S.active);
    toast('沙箱模式：' + (SANDBOX_LABEL[mode] || mode), 'ok', 1600);
  });
}
// 轻量弹出菜单（挂在 body 上，fixed 定位；点外部 / Esc 关闭）
let hMenuEl = null;
function closeHMenu() {
  if (!hMenuEl) return;
  hMenuEl.remove();
  document.removeEventListener('pointerdown', hMenuEl.__out, true);
  document.removeEventListener('keydown', hMenuEl.__key, true);
  hMenuEl = null;
}
function popMenu(anchor, rows) {
  closeHMenu();
  const m = el('div', 'hmenu');
  for (const r of rows) {
    const b = el('button', 'hmenu-item' + (r.active ? ' on' : ''));
    if (r.icon) { const ic = el('span', 'hm-ico'); ic.appendChild(iconEl(r.icon, 'sm')); b.appendChild(ic); }
    const txt = el('span', 'hm-txt');
    txt.appendChild(el('span', 'hm-label', r.label || ''));
    if (r.hint) txt.appendChild(el('span', 'hm-hint trunc', r.hint));
    b.appendChild(txt);
    b.onclick = ev => { ev.stopPropagation(); closeHMenu(); if (r.on) r.on(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - mh - 8)) + 'px';
  const out = ev => { if (!m.contains(ev.target) && !anchor.contains(ev.target)) closeHMenu(); };
  const key = ev => { if (ev.key === 'Escape') closeHMenu(); };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  hMenuEl = m; m.__out = out; m.__key = key;
}

/* ---------- 复制 / diff 预览 ---------------------------------------- */
function copyText(text, okMsg) {
  text = String(text == null ? '' : text);
  if (!text) return;
  const done = () => toast(okMsg || '已复制', 'ok', 1400);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    return;
  }
  legacyCopy(text, done);
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败', 'bad'); }
  ta.remove();
}
async function openDiffPreview(path) {
  if (!path) return;
  let out = null;
  try { out = await api('git.diff', { ws: S.active, cwd: cwdOf(S.active), path: path }); } catch (e) { out = null; }
  if (!out || out.ok === false) { toast('无法获取 diff：' + ((out && out.error) || '命令不可用'), 'bad'); return; }
  if (out.binary) { showModal('diff · ' + path, '（二进制文件，无文本差异）'); return; }
  showModal('diff · ' + path, out.diff || '（无差异）');
}
function lastAssistantText(t) {
  if (!t) return '';
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    const m = t.msgs[i];
    if (m.role === 'assistant' && m.text) return String(m.text);
  }
  return '';
}
function lastUserText(t) {
  if (!t) return '';
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    const m = t.msgs[i];
    if (m.role === 'user' && m.text) return String(m.text);
  }
  return '';
}
function retryTurn(meta) {
  const t = curTab();
  const text = (meta && meta.userText) || lastUserText(t);
  if (!text) { toast('找不到这一回合的用户消息', 'bad'); return; }
  syncComposerText(text);
  focusInput();
  toast('已填入输入栏，可修改后重发', 'ok', 1600);
}

/* ---------- 消息工厂 ------------------------------------------------ */
const ROLE_LABEL = {
  user: '你', assistant: '助手', sys: '系统提示', summary: '上下文摘要', tool: '工具',
  toolres: '工具结果', reason: '思考过程', status: '状态',
  notice: '通知', error: '错误',
};
const ROLE_DOT = {
  user: 'user', assistant: 'assistant', sys: 'system', summary: 'system',
  tool: 'tool', toolres: 'tool', reason: 'other',
  status: 'other', notice: 'other', error: 'bad',
};
const SUMMARY_MARKS = [
  '# Here is a summary that captures the previous conversation:',
  '# Context was compacted to fit the model window.',
];
function splitSummary(text) {
  const t = String(text == null ? '' : text);
  for (const mark of SUMMARY_MARKS) {
    const i = t.indexOf(mark);
    if (i >= 0) return { prompt: t.slice(0, i).replace(/\s+$/, ''), summary: t.slice(i) };
  }
  return null;
}
function isSummary(text) { return !!splitSummary(text); }

// 折叠开关（系统提示 / 摘要 / 存档里的思考块）：按钮 + 面板，hidden 切换
function makeFold(head, panel, label, open, openLabel) {
  const btn = el('button', 'fold');
  const tri = el('span', 'tri');
  tri.appendChild(iconEl('chevronRight', 'sm'));
  const txt = el('span', null, label);
  btn.appendChild(tri); btn.appendChild(txt);
  let isOpen = !!open;
  const labels = { closed: label, open: openLabel || label };
  const paint = () => {
    panel.hidden = !isOpen;
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    tri.classList.toggle('open', isOpen);
    const want = isOpen ? labels.open : labels.closed;
    if (txt.textContent !== want) txt.textContent = want;
  };
  btn.onclick = ev => { ev.stopPropagation(); isOpen = !isOpen; paint(); };
  paint();
  head.appendChild(btn);
  return { btn, txt, labels, paint, isOpen: () => isOpen, set: v => { isOpen = !!v; paint(); } };
}
function iconSvgInner(name) {
  // 直接复用 00-core 的图标表（返回 <path> 内容），用于把图标塞进既有节点
  return (typeof ICON_PATHS !== 'undefined' && ICON_PATHS[name]) ? ICON_PATHS[name] : '';
}
function iconIn(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'uico' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = iconSvgInner(name);
  return s;
}

// 通用壳（保留给旧调用：存档里的 reason/sys 等直接 makeMsg 的场景）
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
function fillProse(w, m) {
  const prose = w._prose;
  if (!prose) return w;
  const txt = m.text == null ? '' : String(m.text);
  if (prose.__txt === txt && !prose.__live) return w;
  prose.__txt = txt;
  if (m.role === 'toolres') {
    const has = typeof renderContentHtml === 'function';
    prose.innerHTML = has ? renderContentHtml(txt, 'tool', m.callId || '') : renderMarkdown(txt);
    return w;
  }
  prose.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(txt) : esc(txt);
  return w;
}

function makeMsg(m) {
  if (m.role === 'pad') return makePad(m);
  if (m.role === '__thinking__') return makeThinking();
  if (m.role === '__grpthink__') return makeThinkGroup(m);
  if (m.role === '__grptools__') return makeToolGroup(m);
  if (m.role === '__turnmeta__') return makeTurnMeta(m.meta);
  if (m.role === '__approval__') return makeApprovalCard();
  if (m.role === 'user') return makeUser(m);
  if (m.role === 'assistant') return makeAssistant(m);
  if (m.role === 'round') return makeRound(m);
  if (m.role === 'status') return makeStatus(m);
  if (m.role === 'error') return makeError(m);
  if (m.role === 'notice') return makeNotice(m);
  if (m.role === 'tool') { const n = makeTool(m); updateTool(n, m); return n; }
  if (m.role === 'sys') return makeSys(m, false);
  if (m.role === 'summary') return makeSys(m, true);
  if (m.role === 'toolres') return makeToolRes(m);
  if (m.role === 'reason') return makeReasonCard(m);
  return makeAssistant(m);
}

/* ---- 用户消息：右对齐气泡 ----------------------------------------- */
function makeUser(m) {
  const w = el('div', 'msg user');
  const bubble = el('div', 'ububble');
  const prose = el('div', 'prose');
  prose.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(m.text || '') : esc(m.text || '');
  bubble.appendChild(prose);
  w.appendChild(bubble);
  w._prose = prose;
  return w;
}

/* ---- 助手消息：22px logo 头像 + 无气泡正文 ------------------------ */
function makeAssistant(m) {
  const w = el('div', 'msg assistant');
  w.appendChild(avatarEl('msg-ava'));
  const body = el('div', 'body');
  const prose = el('div', 'prose');
  fillProseNode(prose, m.text || '');
  body.appendChild(prose);
  w.appendChild(body);
  w._prose = prose;
  return w;
}
function fillProseNode(prose, txt) {
  prose.__txt = txt;
  prose.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(txt) : esc(txt);
}

/* ---- 回合状态行 / 错误 -------------------------------------------- */
/* 窗口化的等高占位：只撑滚动高度，不参与交互、不进无障碍树 */
function makePad(m) {
  const d = el('div', 'flowpad');
  d.setAttribute('aria-hidden', 'true');
  d.style.height = (m.h || 0) + 'px';
  d.__h = m.h || 0;
  return d;
}
function makeStatus(m) {
  const w = el('div', 'msg status');
  const line = el('span', 'sl-line');
  const txt = el('span', 'sl-text');
  const interrupted = /中断|失败|取消|error/i.test(m.text || '');
  const ic = el('span', 'sl-ico');
  ic.appendChild(iconEl(interrupted ? 'alert' : 'checkCircle', 'sm'));
  txt.appendChild(ic);
  txt.appendChild(el('span', null, m.text || '回合结束'));
  w.appendChild(line); w.appendChild(txt); w.appendChild(el('span', 'sl-line'));
  return w;
}
function makeError(m) {
  const w = el('div', 'msg error');
  const card = el('div', 'errcard');
  const ic = el('span', 'eico');
  ic.appendChild(iconEl('alert', 'sm'));
  card.appendChild(ic);
  const body = el('div', 'prose');
  body.textContent = m.text || '出错了';
  card.appendChild(body);
  w.appendChild(card);
  w._prose = body;
  return w;
}

/* ---- 通知卡（消息流内） ------------------------------------------- */
function makeNotice(m) {
  const w = el('div', 'msg notice');
  const n = m.notice || {};
  const card = el('div', 'ncard inmsg');
  const head = el('div', 'nhead');
  const dot = el('span', 'dot warn');
  head.appendChild(dot);
  const from = n.from || '通知';
  const nf = el('span', 'nfrom trunc', from);
  nf.title = from;
  head.appendChild(nf);
  if (n.topic) head.appendChild(el('span', 'ntopic ' + n.topic, TOPIC_ZH[n.topic] || n.topic));
  head.appendChild(el('span', 'grow'));
  if (n.created_at) head.appendChild(el('span', 'ntime', relTime(n.created_at)));
  card.appendChild(head);
  const body = el('div', 'nbody');
  body.innerHTML = typeof highlightBody === 'function' ? highlightBody(n.body || m.text || '') : esc(n.body || m.text || '');
  card.appendChild(body);
  w.appendChild(card);
  return w;
}

/* ---- 等待 / 思考指示器：阶段标题 + 副标题 + 秒表 --------------------
   一个回合会经过多个阶段（准备上下文 → 等模型 → 推理 → 工具 → 审批 →
   下一轮…）。只显示「正在思考中」看不出卡在哪，这里按实时状态生成阶段
   文案，并由 250ms 定时器更新副标题（字符数）与秒表。                 */
function fmtWaitSec(sec) {
  sec = Math.max(0, Number(sec) || 0);
  if (sec < 60) return sec.toFixed(1) + 's';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (m < 60) return m + ':' + (s < 10 ? '0' : '') + s;
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ':' + (mm < 10 ? '0' : '') + mm + ':' + (s < 10 ? '0' : '') + s;
}
function lastRunningTool(t) {
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    const m = t.msgs[i];
    if (m.role === 'tool' && toolKind(m.status) === 'run') return m;
  }
  return null;
}
// 当前回合里最近一条 role=status 文本（遇到上一条用户消息就停，避免旧回合的）
function lastTurnStatus(t) {
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    const m = t.msgs[i];
    if (m.role === 'user') return '';
    if (m.role === 'status' && m.text) return String(m.text);
  }
  return '';
}
// 当前回合里是否已经开始干活（有思考/工具/轮次/状态）——用于区分「刚开始
// 准备上下文」和「工具跑完等下一轮」
function turnHasWork(t) {
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    const r = t.msgs[i].role;
    if (r === 'user') return false;
    if (r === 'tool' || r === 'round' || r === 'status' || r === 'reason') return true;
  }
  return false;
}
function thinkingPhase(t) {
  const done = Number(t.turnRounds || t.roundSeq || 0);
  // 回合进行中 = 第 done+1 轮（round 事件在该轮结束后才到）
  const roundTxt = '第 ' + (done + 1) + ' 轮';
  const live = t._live || {};
  const last = t.msgs.length ? t.msgs[t.msgs.length - 1] : null;
  if (t.approval) {
    return { tone: 'warn', title: '等待审批', sub: '「' + toolZh(t.approval.tool) + '」需要你的确认' };
  }
  if (live.reason && last === live.reason) {
    const n = String(live.reason.text || '').length;
    return { tone: 'run', title: '正在推理',
      sub: (n ? '已思考 ' + fmtTok(n) + ' 字符' : '模型正在推理') + (roundTxt ? ' · ' + roundTxt : '') };
  }
  if (live.assistant && last === live.assistant) {
    const n = String(live.assistant.text || '').length;
    return { tone: 'run', title: '正在输出',
      sub: '已输出 ' + fmtTok(n) + ' 字符' + (roundTxt ? ' · ' + roundTxt : '') };
  }
  const tool = lastRunningTool(t);
  if (tool) {
    if (isTwTool(tool)) {
      const op = String((twArgsOf(tool) || {}).operation || '').toLowerCase();
      const twTitle = (op === 'run' || op === 'resume') ? '正在运行团队任务' : '正在创建团队任务';
      return { tone: 'run', title: twTitle, sub: roundTxt + ' · tw' };
    }
    const bits = [];
    if (tool.name && tool.name !== toolZh(tool.name)) bits.push(tool.name);
    if (roundTxt) bits.push(roundTxt);
    return { tone: 'run', title: '正在执行 ' + toolZh(tool.name), sub: bits.join(' · ') || '工具调用进行中' };
  }
  const status = lastTurnStatus(t);
  if (status) return { tone: 'run', title: status.slice(0, 60), sub: roundTxt };
  if (done > 0 || turnHasWork(t)) return { tone: 'run', title: '等待模型响应', sub: roundTxt + ' · 模型正在处理工具结果' };
  return { tone: 'run', title: '正在准备上下文', sub: '整理历史消息与提示词' };
}
function makeThinking() {
  const w = el('div', 'msg assistant thinking');
  w.appendChild(avatarEl('msg-ava'));
  const body = el('div', 'body');
  const row = el('div', 'thinkrow');
  const dots = el('span', 'thinkdots');
  dots.appendChild(el('span', 'tdot'));
  dots.appendChild(el('span', 'tdot'));
  dots.appendChild(el('span', 'tdot'));
  const main = el('span', 'think-main');
  const title = el('span', 'think-title', '正在准备上下文');
  const sub = el('span', 'think-sub', '');
  main.appendChild(title); main.appendChild(sub);
  const sec = el('span', 'think-sec mono', '');
  row.appendChild(dots); row.appendChild(main); row.appendChild(sec);
  body.appendChild(row);
  w.appendChild(body);
  w._think = { title: title, sub: sub, sec: sec, dots: dots };
  w.__since = Date.now();
  ensureThinkTicker();
  return w;
}
/* 按 250ms 刷新所有可见的等待指示器（标题可能随阶段变化，副标题/秒表持续走） */
let _thinkTicker = 0;
function ensureThinkTicker() {
  if (_thinkTicker) return;
  _thinkTicker = setInterval(() => {
    const nodes = $$('.msg.thinking');
    if (!nodes.length) { clearInterval(_thinkTicker); _thinkTicker = 0; return; }
    for (const node of nodes) {
      const t = node.__tab || curTab();
      if (!t || !t.busy) continue;
      try { paintThinking(node, t); } catch (e) {}
    }
  }, 250);
}
function paintThinking(node, t) {
  if (!node || !node._think || !t) return;
  const ph = thinkingPhase(t);
  const ti = node._think.title, sub = node._think.sub, sec = node._think.sec;
  if (ti.textContent !== ph.title) ti.textContent = ph.title;
  if (sub.textContent !== ph.sub) sub.textContent = ph.sub;
  const start = Number(t.thinkingSince) || node.__since || Date.now();
  const elapsed = fmtWaitSec((Date.now() - start) / 1000);
  if (sec.textContent !== elapsed) sec.textContent = elapsed;
  node.dataset.phase = ph.tone || 'run';
  node.setAttribute('aria-label', ph.title + (ph.sub ? '：' + ph.sub : '') + ' · ' + elapsed);
}

/* ---- 系统提示 / 上下文摘要（卡片） --------------------------------- */
function makeSys(m, isSummary) {
  const w = msgShell(m, (isSummary ? 'summary' : 'sys') + ' cardmsg');
  const head = w._head;
  if (isSummary) head.querySelector('.role').prepend(iconEl('layers', 'sm'));
  const panel = el('div', 'foldpanel');
  panel.appendChild(w._prose);
  $('.body', w).appendChild(panel);
  w._panel = panel;
  const n = String(m.text || '').split('\n').length;
  w._fold = makeFold(head, panel, '展开 ' + n + ' 行', m.collapsed === false, '收起');
  m.collapsed = m.collapsed !== false;
  return fillProse(w, m);
}

// 未配对的工具结果（孤儿结果）：折叠卡
function makeToolRes(m) {
  const w = el('div', 'msg toolres');
  const card = el('details', 'toolresult');
  card.appendChild(el('summary', null, '工具结果'));
  const body = el('div', 'prose');
  body.innerHTML = typeof renderContentHtml === 'function'
    ? renderContentHtml(String(m.text || ''), 'tool', m.callId || '')
    : esc(m.text || '');
  card.appendChild(body);
  w.appendChild(card);
  w._prose = body;
  return w;
}

// 存档/浮窗里的单段思考：折叠行（与主会话同一套视觉）
function makeReasonCard(m) {
  const w = el('div', 'msg reason-card');
  const line = el('button', 'thinkline');
  const ic = el('span', 'th-ico');
  ic.appendChild(iconEl('sparkles', 'sm'));
  line.appendChild(ic);
  line.appendChild(el('span', 'th-label', '思考过程'));
  line.appendChild(el('span', 'grow'));
  const chev = el('span', 'th-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  line.appendChild(chev);
  const panel = el('div', 'thinkpanel');
  panel.hidden = m.collapsed !== false;
  const blk = el('div', 'thinkblk');
  const prose = el('div', 'prose');
  fillProseNode(prose, m.text || '');
  blk.appendChild(prose);
  panel.appendChild(blk);
  line.onclick = () => {
    panel.hidden = !panel.hidden;
    line.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    line.classList.toggle('open', !panel.hidden);
  };
  line.classList.toggle('open', !panel.hidden);
  line.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  const body = el('div', 'reason-body');
  body.appendChild(line); body.appendChild(panel);
  w.appendChild(body);
  w._prose = prose; w._panel = panel;
  return w;
}

/* ---- 轮次条：一行元信息，不抢正文视觉 ------------------------------ */
function makeRound(m) {
  const bar = el('div', 'roundbar');
  const ic = el('span', 'rb-ico');
  ic.appendChild(iconEl('gauge', 'sm'));
  bar.appendChild(ic);
  bar.appendChild(el('span', 'rb-i', '轮次 ' + (m.round == null ? '—' : m.round)));
  if (m.tok_in || m.tok_out) {
    bar.appendChild(el('span', 'rb-sep', '·'));
    bar.appendChild(el('span', 'rb-i', '↑' + fmtTok(m.tok_in) + ' ↓' + fmtTok(m.tok_out)));
  }
  if (m.cache) { bar.appendChild(el('span', 'rb-sep', '·')); bar.appendChild(el('span', 'rb-i', '缓存 ' + fmtTok(m.cache))); }
  if (m.sec) { bar.appendChild(el('span', 'rb-sep', '·')); bar.appendChild(el('span', 'rb-i', fmtDur(m.sec))); }
  if (m.ttft) { bar.appendChild(el('span', 'rb-sep', '·')); bar.appendChild(el('span', 'rb-i', '首字 ' + Math.round(m.ttft) + 'ms')); }
  return bar;
}

/* ---- 审批卡（消息流内；模态审批由 07-overlays.js 负责） ------------ */
function makeApprovalCard() {
  const t = curTab();
  const a = t && t.approval;
  const w = el('div', 'msg approval');
  if (!a) return w;
  const card = el('div', 'apcard');
  const head = el('div', 'aphead');
  const ic = el('span', 'apico');
  ic.appendChild(iconEl('alert', 'sm'));
  head.appendChild(ic);
  head.appendChild(el('span', 'aptitle', '需要审批'));
  head.appendChild(el('span', 'apmono mono', a.tool || ''));
  head.appendChild(el('span', 'grow'));
  head.appendChild(el('span', 'badge warn', '待确认'));
  card.appendChild(head);
  const body = el('div', 'apbody');
  const pre = el('pre');
  pre.textContent = typeof a.args === 'string' ? a.args : JSON.stringify(a.args || {}, null, 2);
  body.appendChild(pre);
  card.appendChild(body);
  const foot = el('div', 'apfoot');
  foot.appendChild(el('span', 'ap-hint', '该工具调用需要你的确认'));
  foot.appendChild(el('span', 'grow'));
  const deny = el('button', 'btn sm', '拒绝');
  deny.onclick = () => approve(a, false);
  const allow = el('button', 'btn sm accent', '允许');
  allow.onclick = () => approve(a, true);
  foot.appendChild(deny); foot.appendChild(allow);
  card.appendChild(foot);
  w.appendChild(card);
  return w;
}

/* ---- 回合产物：已编辑文件卡 + 用量 / 操作行 ------------------------ */
function makeTurnMeta(meta) {
  const box = el('div', 'turnmeta');
  if (meta && meta.edits && meta.edits.length) box.appendChild(editsCard(meta.edits));
  box.appendChild(turnFoot(meta));
  return box;
}
function editsCard(edits) {
  const card = el('div', 'edits');
  const head = el('div', 'edits-head');
  const tile = el('span', 'etile');
  tile.appendChild(iconEl('code', 'lg'));
  head.appendChild(tile);
  const info = el('div', 'einfo');
  info.appendChild(el('div', 'etitle', '已编辑 ' + edits.length + ' 个文件'));
  let add = 0, del = 0;
  for (const e of edits) { add += Number(e.add || 0); del += Number(e.del || 0); }
  const sum = el('div', 'esum');
  sum.appendChild(el('span', 'eadd', '+' + add));
  sum.appendChild(el('span', 'edel', '-' + del));
  info.appendChild(sum);
  head.appendChild(info);
  card.appendChild(head);
  const list = el('div', 'elist');
  for (const e of edits) {
    const row = el('button', 'erow');
    row.title = e.path + '  ·  点击查看 diff';
    row.appendChild(el('span', 'epath trunc', e.path || ''));
    const num = el('span', 'enum');
    if (e.add) num.appendChild(el('span', 'eadd', '+' + e.add));
    if (e.del) num.appendChild(el('span', 'edel', '-' + e.del));
    row.appendChild(num);
    row.onclick = () => openDiffPreview(e.path, { add: e.add, del: e.del });
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}
function turnFoot(meta) {
  const foot = el('div', 'turnfoot');
  const copy = el('button', 'tfbtn');
  copy.appendChild(iconEl('copy', 'sm'));
  copy.title = '复制这一回合的回复';
  copy.onclick = () => copyText(lastAssistantText(curTab()), '已复制回复');
  foot.appendChild(copy);
  const retry = el('button', 'tfbtn');
  retry.appendChild(iconEl('rotate', 'sm'));
  retry.title = '重试：把这一回合的用户消息填回输入栏';
  retry.onclick = () => retryTurn(meta);
  foot.appendChild(retry);
  if (meta && meta.usage) {
    const total = Number(meta.usage.in || 0) + Number(meta.usage.out || 0);
    const u = el('span', 'usage');
    u.appendChild(el('span', 'u-label', '用量'));
    u.appendChild(el('span', 'u-tok', fmtTok(total) + ' tok'));
    u.title = '输入 ' + fmtTok(meta.usage.in) + ' tok · 输出 ' + fmtTok(meta.usage.out)
      + ' tok · 缓存 ' + fmtTok(meta.usage.cache || 0) + ' tok';
    foot.appendChild(u);
  }
  if (meta && meta.endedAt) foot.appendChild(el('span', 'utime', hhmm(meta.endedAt)));
  return foot;
}

/* ---- Teamwork（tw）工具卡：结构化「团队任务」卡 --------------------
   LLM 调 tw 创建/配置团队任务时，工具卡原本只能看到一坨参数 JSON。
   这里把创建类调用渲染成结构化卡片：阶段（串/并行、gate）+ 每个子代理的
   works + 模型/思考；在折叠摘要里也能看到「N 阶段 M 子代理」。其余 tw 动作
   （run/report/list…）给紧凑摘要 + 可展开的结果。                         */
const TW_OP_ZH = {
  new: '创建', workflow: '创建工作流', edit: '更新配置', run: '运行', resume: '继续运行',
  remove: '删除', reuse: '复用子代理', list: '列出任务', jobs: '列出任务',
  history: '历史任务', report: '子代理报告', reports: '子代理报告',
};
const TW_JOB_STATUS_ZH = {
  pending: '待运行', queued: '排队中', running: '运行中', waiting: '等待关卡',
  done: '已完成', completed: '已完成', failed: '失败', error: '失败',
  stopped: '已停止', cancelled: '已取消', skipped: '已跳过',
  created: '已创建', updated: '已更新', removed: '已删除',
};
const TW_THINK_ZH = { off: '关闭', low: '低', med: '中', high: '高', max: '最大' };
function twThinkZh(v) {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase().trim();
  if (TW_THINK_ZH[s]) return TW_THINK_ZH[s];
  const n = Number(s);
  if (Number.isFinite(n)) return TW_THINK_ZH[['off', 'low', 'med', 'high', 'max'][n]] || '';
  return String(v);
}
function isTwTool(m) {
  const n = String((m && m.name) || '').toLowerCase();
  return n === 'tw' || n === 'teamwork';
}
function twArgsOf(m) {
  const a = m && m.args;
  if (a && typeof a === 'object') return a;
  const s = String(a == null ? '' : a).trim();
  if (!s || s[0] !== '{') return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}
function twAgentsOf(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { arr = []; } }
  if (!Array.isArray(arr)) arr = arr && typeof arr === 'object' ? [arr] : [];
  return arr.map((a, i) => {
    if (typeof a === 'string') return { name: 'worker_' + i, works: a, model: '', think: '' };
    a = a || {};
    return {
      name: String(a.name || a.worker || ('worker_' + i)),
      works: String(a.works || a.task || ''),
      model: String(a.model || ''),
      think: twThinkZh(a.think),
    };
  });
}
// 可解析为「创建/配置」的 tw 调用 → 归一化的阶段计划；否则 null（走紧凑卡）
function twPlanOf(m) {
  const a = twArgsOf(m);
  if (!a) return null;
  let wf = a.workflow;
  if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch (e) { wf = null; } }
  const op = String(a.operation || '').toLowerCase() || (wf ? 'workflow' : (Array.isArray(a.list) ? 'new' : ''));
  if (op !== 'new' && op !== 'workflow' && op !== 'edit') return null;
  const stages = [];
  if (wf && Array.isArray(wf.stages)) {
    wf.stages.forEach((st, si) => {
      st = st || {};
      const agents = twAgentsOf(st.agents || st.workers || st.list);
      if (!agents.length) return;
      stages.push({
        name: String(st.name || ('阶段 ' + (si + 1))),
        mode: String(st.mode || '').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
        gate: !!st.gate,
        agents: agents,
      });
    });
  } else if (Array.isArray(a.list)) {
    const agents = twAgentsOf(a.list);
    if (agents.length) stages.push({
      name: '子代理',
      mode: String(a['work-type'] || a.work_type || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
      gate: false, agents: agents,
    });
  }
  if (!stages.length) return null;
  const count = stages.reduce((n, s) => n + s.agents.length, 0);
  return {
    op: op, stages: stages, count: count,
    workType: String(a['work-type'] || a.work_type || (wf && (wf.work_type || wf['work-type'])) || '').toLowerCase(),
    model: String(a.model || (wf && wf.model) || ''),
    think: twThinkZh(a.think != null ? a.think : (wf && wf.think)),
    provider: String(a.provider || (wf && wf.provider) || ''),
  };
}
function twResultOf(m) {
  const raw = String(m && m.display != null ? m.display : '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  const idm = flat.match(/\btw-[0-9A-Za-z][0-9A-Za-z._-]*/);
  const st = flat.match(/status=([a-z_]+)/i);
  const child = flat.match(/children=(\d+)/);
  const model = flat.match(/model=([^\s]+)/);
  return {
    raw: raw, flat: flat,
    id: idm ? idm[0] : '',
    status: st ? st[1].toLowerCase() : '',
    children: child ? Number(child[1]) : 0,
    model: model ? model[1] : '',
  };
}
function twWorkTypeText(plan) {
  const uniq = Array.from(new Set(plan.stages.map(s => s.mode)));
  if (plan.workType === 'parallel' || (uniq.length === 1 && uniq[0] === 'parallel')) return '并行';
  if (plan.workType === 'serial' || (uniq.length === 1 && uniq[0] === 'serial')) return '串行';
  return '串行/并行混排';
}
function twClip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function twStatusKind(st) {
  st = String(st || '').toLowerCase();
  if (/run|active|progress|working|waiting|queue/.test(st)) return st === 'waiting' ? 'warn' : 'run';
  if (/(^|_)(ok|done|complete|success|approved)/.test(st)) return 'ok';
  if (/fail|error|denied|abort|cancel|stop|skip/.test(st)) return 'bad';
  return '';
}
function makeTwTool(m) {
  const wrap = el('div', 'trowwrap twtool');
  const head = el('div', 'twt-head');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  const tile = el('span', 'twt-tile');
  tile.appendChild(iconEl('users', 'sm'));
  head.appendChild(tile);
  const main = el('div', 'twt-main');
  const titleRow = el('div', 'twt-title');
  const title = el('span', 'twt-title-t', '团队任务');
  const idEl = el('span', 'twt-id mono', '');
  titleRow.appendChild(title); titleRow.appendChild(idEl);
  main.appendChild(titleRow);
  const sub = el('div', 'twt-sub trunc', '');
  main.appendChild(sub);
  head.appendChild(main);
  const badge = el('span', 'twt-badge pill', '');
  head.appendChild(badge);
  const sec = el('span', 'twt-sec mono', '');
  head.appendChild(sec);
  const openBtn = el('button', 'btn ghost sm twt-open', '在 Teamwork 面板查看');
  openBtn.type = 'button';
  openBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    if (typeof openDock === 'function') openDock('teamwork');
  });
  head.appendChild(openBtn);
  const chev = el('span', 'twt-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  head.appendChild(chev);
  const body = el('div', 'twt-body');
  wrap.appendChild(head); wrap.appendChild(body);
  wrap.__tw = { head: head, title: title, id: idEl, sub: sub, badge: badge, sec: sec, body: body, tile: tile, chev: chev };
  // 创建类卡片默认展开（阶段/子代理任务是这张卡的主体）；其它动作紧凑折叠
  wrap.__open = !!twPlanOf(m);
  head.addEventListener('click', () => toggleTwCard(wrap, m));
  head.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); toggleTwCard(wrap, m); }
  });
  paintTwOpen(wrap);
  updateTwTool(wrap, m);
  return wrap;
}
function toggleTwCard(node, m) {
  node.__open = !node.__open;
  if (m) m.expanded = node.__open;
  paintTwOpen(node);
}
function paintTwOpen(node) {
  if (!node || !node.__tw) return;
  node.classList.toggle('open', !!node.__open);
  node.classList.toggle('expanded', !!node.__open);
  node.__tw.body.hidden = !node.__open;
  node.__tw.head.setAttribute('aria-expanded', node.__open ? 'true' : 'false');
}
function updateTwTool(node, m) {
  if (!node || !node.__tw) return;
  const kind = toolKind(m.status);
  node.dataset.status = kind;
  node.classList.toggle('running', kind === 'run');
  node.classList.toggle('ok', kind === 'ok');
  node.classList.toggle('bad', kind === 'bad');
  const plan = twPlanOf(m);
  const info = twResultOf(m);
  const a = twArgsOf(m);
  const op = String((a && a.operation) || (plan && plan.op) || '').toLowerCase();
  const jobId = info.id || String((a && a.id) || '');
  node.classList.toggle('twtool-create', !!plan);
  node.classList.toggle('twtool-compact', !plan);
  let title = '', sub = '';
  if (plan) {
    const creating = kind === 'run';
    title = creating ? (plan.op === 'edit' ? '正在更新团队任务' : '正在创建团队任务')
                     : (plan.op === 'edit' ? '团队任务配置已更新' : '团队任务已创建');
    const bits = [plan.stages.length + ' 阶段', plan.count + ' 子代理', twWorkTypeText(plan)];
    const gates = plan.stages.filter(s => s.gate).length;
    if (gates) bits.push(gates + ' 个关卡');
    if (plan.model) bits.push('模型 ' + plan.model);
    if (plan.think) bits.push('思考 ' + plan.think);
    sub = bits.join(' · ');
  } else {
    const opZh = TW_OP_ZH[op];
    title = '团队任务' + (opZh ? ' · ' + opZh : '');
    sub = info.flat ? twClip(info.flat, 110) : '正在执行团队工具调用…';
  }
  setTextEl(node.__tw.title, title);
  setTextEl(node.__tw.id, jobId);
  node.__tw.id.hidden = !jobId;
  setTextEl(node.__tw.sub, sub);
  node.__tw.sub.title = sub;
  // 状态徽标：工具状态优先，其次结果里的 job status（后台运行/更新/删除
  // 这类动作没有 status= 字段，从结果文本里推断）
  let inferred = info.status;
  if (!inferred && !plan) {
    if (/in background|started in background/i.test(info.flat)) inferred = 'running';
    else if (/\bupdated\b/i.test(info.flat)) inferred = 'updated';
    else if (/\bremoved\b/i.test(info.flat)) inferred = 'removed';
    else if (/\bcreated\b/i.test(info.flat)) inferred = 'created';
  }
  let label = '', cls = '';
  const jobCls = twStatusKind(inferred);
  if (kind === 'bad') { label = '失败'; cls = 'bad'; }
  else if (kind === 'run') { label = plan ? '创建中…' : '执行中…'; cls = 'run'; }
  else if (inferred) { label = TW_JOB_STATUS_ZH[inferred] || inferred; cls = jobCls; }
  else { label = plan ? '已创建' : '已完成'; cls = 'ok'; }
  node.__tw.badge.textContent = label;
  node.__tw.badge.className = 'twt-badge pill' + (cls ? ' ' + cls : '');
  const secTxt = m.sec ? fmtDur(m.sec) : (kind === 'run' && m.started ? ((Date.now() - m.started) / 1000).toFixed(1) + 's' : '');
  setTextEl(node.__tw.sec, secTxt);
  // 主体只在参数/结果/状态变化时重建（流式期间每次渲染都会调用本函数）
  const sig = kind + '|' + (m.status || '') + '|' + String(m.args == null ? '' : m.args) + '|'
    + String(m.display == null ? '' : m.display) + '|' + (plan ? plan.count : 0);
  if (node.__twSig !== sig) {
    node.__twSig = sig;
    fillTwBody(node, m, plan, info, op, jobId);
  }
}
function setTextEl(node, txt) {
  if (node && node.textContent !== txt) node.textContent = txt;
}
function twFact(box, k, v) {
  if (v == null || v === '') return;
  const f = el('span', 'twt-fact');
  f.appendChild(el('span', 'twt-fact-k', k));
  f.appendChild(el('span', 'twt-fact-v', String(v)));
  box.appendChild(f);
}
function twStageNode(st, si) {
  const li = el('li', 'twt-stage');
  const head = el('div', 'twt-stage-h');
  head.appendChild(el('span', 'twt-num', String(si + 1)));
  head.appendChild(el('span', 'twt-sname', st.name));
  head.appendChild(el('span', 'pill twt-pill' + (st.mode === 'parallel' ? ' accent' : ''), st.mode === 'parallel' ? '并行' : '串行'));
  if (st.gate) head.appendChild(el('span', 'pill twt-pill warn', '关卡 gate'));
  head.appendChild(el('span', 'grow'));
  head.appendChild(el('span', 'twt-smeta mono', st.agents.length + ' 个子代理'));
  li.appendChild(head);
  const ul = el('ul', 'twt-agents');
  for (const ag of st.agents) {
    const row = el('li', 'twt-agent');
    row.appendChild(el('span', 'twt-wname mono', ag.name));
    row.appendChild(el('span', 'twt-works', ag.works || '（未填写任务描述）'));
    const meta = [];
    if (ag.model) meta.push(ag.model);
    if (ag.think) meta.push('思考 ' + ag.think);
    if (meta.length) row.appendChild(el('span', 'twt-wmeta mono', meta.join(' · ')));
    ul.appendChild(row);
  }
  li.appendChild(ul);
  return li;
}
function fillTwBody(node, m, plan, info, op, jobId) {
  const body = node.__tw.body;
  const nodes = [];
  if (plan) {
    const facts = el('div', 'twt-facts');
    twFact(facts, '模式', twWorkTypeText(plan));
    const gates = plan.stages.filter(s => s.gate).length;
    if (gates) twFact(facts, '关卡', gates + ' 个（等待你确认）');
    if (plan.model) twFact(facts, '模型', plan.model);
    if (plan.think) twFact(facts, '思考', plan.think);
    if (plan.provider) twFact(facts, '供应商', plan.provider);
    if (facts.childElementCount) nodes.push(facts);
    const list = el('ol', 'twt-stages');
    plan.stages.forEach((st, si) => list.appendChild(twStageNode(st, si)));
    nodes.push(list);
    if (info.flat) {
      const line = el('div', 'twt-resline');
      const tag = el('span', 'twt-resline-tag', '工具输出');
      line.appendChild(tag);
      line.appendChild(el('span', 'twt-resline-txt mono', twClip(info.flat, 220)));
      line.title = info.flat;
      nodes.push(line);
    }
  } else {
    if (op && TW_OP_ZH[op]) {
      const line = el('div', 'twt-cmd');
      line.appendChild(el('span', 'twt-cmd-k', '动作'));
      line.appendChild(el('span', 'twt-cmd-v', TW_OP_ZH[op]));
      if (jobId) line.appendChild(el('span', 'twt-cmd-k', '任务'));
      if (jobId) line.appendChild(el('span', 'twt-cmd-v mono', jobId));
      nodes.push(line);
    }
    if (info.raw) {
      const pre = el('pre', 'twt-pre');
      pre.textContent = info.raw.length > 4000 ? info.raw.slice(0, 4000) + '\n…' : info.raw;
      nodes.push(pre);
    }
  }
  if (!nodes.length) nodes.push(el('div', 'twt-empty', '（等待工具结果…）'));
  body.replaceChildren.apply(body, nodes);
}

/* ---- 工具调用：紧凑行卡 ------------------------------------------- */
function makeTool(m) {
  // Teamwork 工具走结构化卡片（见上节）
  if (isTwTool(m)) return makeTwTool(m);
  const wrap = el('div', 'trowwrap');
  const btn = el('button', 'trow');
  btn.setAttribute('aria-expanded', m.expanded ? 'true' : 'false');
  const dot = el('span', 'tdot');
  btn.appendChild(dot);
  const ic = el('span', 'tico');
  ic.appendChild(iconEl(toolIconName(m.name), 'sm'));
  btn.appendChild(ic);
  btn.appendChild(el('span', 'tzh', toolZh(m.name)));
  btn.appendChild(el('span', 'tmono mono', m.name || ''));
  const meta = el('span', 'tmeta');
  btn.appendChild(meta);
  btn.appendChild(el('span', 'grow'));
  const chev = el('span', 'tchev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  btn.appendChild(chev);
  const body = el('div', 'tbody');
  body.hidden = !m.expanded;
  wrap.appendChild(btn); wrap.appendChild(body);
  wrap._btn = btn; wrap._body = body; wrap._dot = dot; wrap._meta = meta; wrap._chev = chev; wrap._ico = ic;
  btn.onclick = () => {
    m.expanded = !m.expanded;
    wrap.classList.toggle('expanded', m.expanded);
    body.hidden = !m.expanded;
    btn.setAttribute('aria-expanded', m.expanded ? 'true' : 'false');
  };
  wrap.classList.toggle('expanded', !!m.expanded);
  return wrap;
}

/* 工具行更新：状态点 / 中文名 / 耗时 / 参数与结果（懒填充） */
function updateTool(node, m) {
  if (!node || m.role === 'round') return;
  if (node.__tw) { updateTwTool(node, m); return; }
  const kind = toolKind(m.status);
  node.dataset.status = kind;
  if (node._btn) node._btn.dataset.status = kind;
  node.classList.toggle('running', kind === 'run');
  node.classList.toggle('ok', kind === 'ok');
  node.classList.toggle('bad', kind === 'bad');
  node.classList.toggle('warn', kind === 'warn');
  if (node._meta) {
    const bits = [];
    if (m.sec) bits.push(fmtDur(m.sec));
    else if (kind === 'run' && m.started) bits.push(((Date.now() - m.started) / 1000).toFixed(1) + 's');
    if (m.chars) bits.push(fmtTok(m.chars) + ' 字符');
    node._meta.textContent = bits.join(' · ');
  }
  if (node._body) {
    if (!node.__filled) {
      node.__filled = true;
      const argsLbl = el('div', 'tbody-lbl', '参数');
      const args = el('pre', 'targs');
      const raw = m.args == null ? '' : String(m.args);
      args.textContent = raw.length > 4000 ? raw.slice(0, 4000) + '\n…' : raw;
      const resLbl = el('div', 'tbody-lbl', '结果');
      const res = el('div', 'tres prose');
      node._body.appendChild(argsLbl);
      node._body.appendChild(args);
      node._body.appendChild(resLbl);
      node._body.appendChild(res);
      node._res = res;
    }
    if (node._res) {
      const d = m.display == null ? '' : String(m.display);
      if (node._res.__txt !== d) {
        node._res.__txt = d;
        if (!d) node._res.innerHTML = '<div class="tres-empty">（无输出）</div>';
        else if (d.slice(0, 12) === '<tool_output') {
          // 引擎的 <tool_output …> 包裹：走共享渲染器，收成一张折叠卡
          node._res.innerHTML = renderContentHtml(d, 'tool', '');
        } else {
          // 普通文本/markdown 输出：直接铺在「结果」下方，不再套一层折叠
          node._res.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(d) : '<pre class="tres-pre">' + esc(d) + '</pre>';
        }
      }
    }
  }
}

/* ---- 工具组：一整段工具调用 + 轮次条收进一张折叠卡 ----------------- */
function makeToolGroup(m) {
  const w = el('div', 'toolgroup');
  const head = el('button', 'tghead');
  const ic = el('span', 'tg-ico');
  ic.appendChild(iconEl('terminal', 'sm'));
  head.appendChild(ic);
  head.appendChild(el('span', 'tg-label', '工具调用'));
  const meta = el('span', 'tg-meta');
  head.appendChild(meta);
  head.appendChild(el('span', 'grow'));
  const chev = el('span', 'tg-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  head.appendChild(chev);
  const body = el('div', 'tgbody');
  body.hidden = false; // 紧凑行卡默认可见：一行一个工具调用，点头部才收起
  w.classList.add('open');
  head.onclick = () => {
    w._manual = true;
    const open = body.hidden;
    body.hidden = !open;
    w.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.setAttribute('aria-expanded', 'true');
  w.appendChild(head); w.appendChild(body);
  w._body = body; w._meta = meta; w._head = head; w._blocks = new Map();
  return w;
}
function makeThinkGroup(m) {
  const w = el('div', 'thinkgrp');
  const line = el('button', 'thinkline');
  const ic = el('span', 'th-ico');
  ic.appendChild(iconEl('sparkles', 'sm'));
  line.appendChild(ic);
  line.appendChild(el('span', 'th-label', '思考过程'));
  const meta = el('span', 'th-meta');
  line.appendChild(meta);
  line.appendChild(el('span', 'grow'));
  const chev = el('span', 'th-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  line.appendChild(chev);
  line.setAttribute('aria-expanded', 'false');
  const panel = el('div', 'thinkpanel');
  panel.hidden = true;
  line.onclick = () => {
    w._manual = true;
    const open = panel.hidden;
    panel.hidden = !open;
    w.classList.toggle('open', open);
    line.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) fillThinkPanel(w); // 懒渲染：展开时才解析这一组的正文
  };
  w.appendChild(line); w.appendChild(panel);
  w._panel = panel; w._meta = meta; w._line = line; w._blocks = new Map();
  return w;
}
function makeThinkBlock(it) {
  const b = el('div', 'thinkblk');
  const prose = el('div', 'prose');
  b.appendChild(prose);
  b._prose = prose;
  return b;
}
// 分组成员只追加：序列变化时重建（流式文本节点随之按全量重建）
function syncGroupChildren(w, m, makeChild) {
  const ids = m.items.map(x => x.id).join('|');
  if (w.__kids === ids) return;
  w.__kids = ids;
  w._blocks = new Map();
  const nodes = [];
  for (const it of m.items) {
    const c = makeChild(it);
    w._blocks.set(it.id, c);
    nodes.push(c);
  }
  const host = w._panel || w._body;
  if (host) host.replaceChildren(...nodes);
}

/* ---------- 详细渲染：更新 ------------------------------------------ */
function updateMsg(node, m, t) {
  if (!node) return;
  if (m.role === 'pad') {
    if (node.__h !== m.h) { node.__h = m.h; node.style.height = (m.h || 0) + 'px'; }
    return;
  }
  if (m.role === '__thinking__') {
    node.__tab = t;
    paintThinking(node, t);
    return;
  }
  if (m.role === '__grpthink__') return updateThinkGroup(node, m, t);
  if (m.role === '__grptools__') return updateToolGroup(node, m, t);
  if (m.role === '__turnmeta__' || m.role === '__approval__' || m.role === 'status'
      || m.role === 'round' || m.role === 'notice' || m.role === 'error') return;
  if (m.role === 'tool') { updateTool(node, m); return; }
  const prose = node._prose;
  if (!prose) return;
  const slot = (m.role === 'assistant' || m.role === 'reason' || m.role === 'summary') ? m.role : null;
  const liveMsg = slot && t._live ? t._live[slot] : null;
  const isStreaming = !!(liveMsg && liveMsg.id === m.id && m.streaming);
  node.classList.toggle('streaming', isStreaming);
  if (isStreaming) {
    if (!prose.__live) {
      prose.replaceChildren(document.createTextNode(m.text == null ? '' : String(m.text)));
      prose.__tn = prose.firstChild;
      prose.__live = true;
      t._md.set(m.id, prose);
      t._liveMsgId = m.id;
    }
    if (node._fold) node._fold.set(true);
  } else {
    if (prose.__live || prose.__txt !== (m.text == null ? '' : String(m.text))) {
      prose.__live = false; prose.__tn = null;
      fillProse(node, m);
    }
    if (node._fold && m.collapsed === false) node._fold.set(true);
  }
}

// 思考组：流式段自动展开、实时追加；统计「N 段」
// 收起状态下**不建** body 的 DOM（懒渲染）：百万级上下文里 99% 的思考块都是收起的，
// 解析 + 建节点纯属浪费——首次展开时才补渲染（fillThinkPanel）。
function updateThinkGroup(node, m, t) {
  syncGroupChildren(node, m, makeThinkBlock);
  const live = t._live && t._live.reason;
  const liveLast = !!(live && t.msgs.length && t.msgs[t.msgs.length - 1] === live);
  let streaming = false, chars = 0;
  for (const it of m.items) {
    if (liveLast && live.id === it.id && it.streaming) streaming = true;
    chars += String(it.text || '').length;
  }
  node.classList.toggle('streaming', streaming);
  const open = node._manual ? !node._panel.hidden : (streaming || node.__wasStreaming);
  if (!node._manual) {
    node._panel.hidden = !open;
    node.classList.toggle('open', open);
    node._line.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  node.__wasStreaming = streaming;
  node.__items = m.items; // 给「展开时补渲染」用
  node.__tab = t;
  if (open) {
    for (const it of m.items) {
      const blk = node._blocks.get(it.id);
      if (!blk) continue;
      const isStreaming = !!(liveLast && live.id === it.id && it.streaming);
      fillThinkBlock(blk._prose, it, isStreaming, t);
    }
  }
  if (node._meta) {
    // 分块后每组通常只有一段，再说「1 段」就是噪音
    const bits = [];
    if (m.items.length > 1) bits.push(m.items.length + ' 段');
    if (chars) bits.push(chars + ' 字符');
    if (streaming) bits.push('进行中');
    node._meta.textContent = bits.join(' · ');
  }
}
// 展开收起着的思考组时补渲染（懒渲染的另一半）
function fillThinkPanel(w) {
  if (!w.__items) return;
  for (const it of w.__items) {
    const blk = w._blocks.get(it.id);
    if (blk && !blk._prose.__txt) fillThinkBlock(blk._prose, it, false, w.__tab);
  }
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
    prose.__txt = txt;
    prose.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(txt) : esc(txt);
  }
}
// 工具组：运行中自动展开（用户手动接管后不再自动）；统计次数/耗时/失败
function updateToolGroup(node, m, t) {
  syncGroupChildren(node, m, it => (it.role === 'round' ? makeRound(it) : makeTool(it)));
  let running = 0, ok = 0, bad = 0, sec = 0, chars = 0, tools = 0, rounds = 0;
  for (const it of m.items) {
    if (it.role === 'round') { rounds++; continue; }
    tools++;
    const row = node._blocks.get(it.id);
    if (row) updateTool(row, it);
    const kind = toolKind(it.status);
    if (kind === 'run') running++;
    else if (kind === 'bad') bad++;
    else ok++;
    sec += Number(it.sec || 0);
    chars += Number(it.chars || 0);
  }
  node.classList.toggle('running', running > 0);
  node.classList.toggle('ok', running === 0 && bad === 0 && tools > 0);
  node.classList.toggle('bad', bad > 0);
  if (!node._manual) {
    // 一行一个工具调用，默认全部可见；运行中也不藏（用户手动收起后不再改写）
    node._body.hidden = false;
    node.classList.add('open');
    node._head && node._head.setAttribute('aria-expanded', 'true');
  }
  if (node._meta) {
    const bits = [tools + ' 次'];
    if (running) {
      const rt = m.items.find(x => x.role === 'tool' && toolKind(x.status) === 'run');
      bits.push('运行中 ' + ((Date.now() - (rt && rt.started ? rt.started : Date.now())) / 1000).toFixed(1) + 's');
    } else if (sec) bits.push(fmtDur(sec));
    if (bad) bits.push(bad + ' 失败');
    if (rounds) bits.push(rounds + ' 轮');
    node._meta.textContent = bits.join(' · ');
  }
}

/* ---------- 后端 transcript → 消息对象 ------------------------------ */
function detailEntries(e, idx, sid) {
  const out = [];
  // 条目 id 必须**跨重载稳定**：reconcile 按 id 复用节点，随机 uid 会让「每回合结束
  // 后重载转录」把整条会话重建一遍（百万级上下文实测 ~0.5s 主线程卡顿）。
  // 用「会话 + 条目序号」做键：追加消息不影响旧条目；压缩摘要插到头部时整条平移
  // 一次（重新稳定），代价是一次重渲染。
  const base = { id: (sid || 'd') + ':' + (idx == null ? uid() : idx), ts: 0 };
  if (!e) return out;
  if (e.kind === 'summary') { out.push(Object.assign({}, base, { role: 'summary', text: e.text, collapsed: true })); return out; }
  if (e.kind === 'user') { out.push(Object.assign({}, base, { role: 'user', text: e.text })); return out; }
  if (e.kind === 'reasoning') { out.push(Object.assign({}, base, { role: 'reason', text: e.text, collapsed: true })); return out; }
  if (e.kind === 'round') {
    out.push(Object.assign({}, base, {
      role: 'round', round: e.round, tok_in: e.tok_in, tok_out: e.tok_out,
      cache: e.cache, sec: e.sec, ttft: e.ttft,
    }));
    return out;
  }
  if (e.kind === 'approval') { return out; }
  if (e.kind === 'assistant' || e.kind === 'other') {
    const sp = splitSummary(e.text);
    if (sp) {
      if (sp.prompt) out.push(Object.assign({}, base, { role: 'assistant', text: sp.prompt }));
      out.push(Object.assign({ id: base.id + '#2', ts: 0 }, { role: 'summary', text: sp.summary, collapsed: true }));
    } else {
      out.push(Object.assign({}, base, { role: 'assistant', text: e.text }));
    }
    return out;
  }
  if (e.kind === 'system') {
    const sp = splitSummary(e.text);
    if (sp) {
      if (sp.prompt) out.push(Object.assign({}, base, { role: 'sys', text: sp.prompt, collapsed: true }));
      out.push(Object.assign({ id: base.id + '#2', ts: 0 }, { role: 'summary', text: sp.summary, collapsed: true }));
    } else {
      out.push(Object.assign({}, base, { role: 'sys', text: e.text, collapsed: true }));
    }
    return out;
  }
  if (e.kind === 'tool') {
    out.push(Object.assign({}, base, {
      role: 'tool', name: e.name, args: e.args, display: e.result || '',
      status: e.status || 'ok', expanded: false, seq: 0, started: 0,
      sec: e.sec, chars: e.chars, marker: e.marker,
    }));
    return out;
  }
  if (e.kind === 'tool_result') { out.push(Object.assign({}, base, { role: 'toolres', text: e.text })); return out; }
  out.push(Object.assign({}, base, { role: 'assistant', text: e.text || '' }));
  return out;
}
function detailMsg(e) { return detailEntries(e)[0]; }

// 拉取一个会话的完整详情（transcript + 存档列表），替换预览消息
// opts.keepStick：回合结束后重载时保留用户当前的滚动位置（用户可能正在往上看）
function loadSessionDetail(ws, id, done, opts) {
  const t = S.tabs.get(ws);
  if (!t || !id) { if (done) done(); return; }
  if (t.busy || t.detailSession === id || t.detailLoading === id) return;
  t.detailLoading = id;
  cmd('session.history', { ws: ws, id: id }).then(out => {
    t.detailLoading = '';
    if (!out || out.ok === false) { if (done) done(); return; }
    if (S.tabs.get(ws) !== t || t.session !== id) { if (done) done(); return; }
    t.detailSession = id;
    t.msgs = [];
    t._live = { assistant: null, reason: null, summary: null };
    t._liveMsgId = null;
    t._md = new Map();
    const entries = out.entries || [];
    for (let i = 0; i < entries.length; i++)
      for (const m of detailEntries(entries[i], i, id)) t.msgs.push(m);
    t.archives = out.archives || [];
    t.archivesFor = id;
    // 换了会话（或首次加载）→ 贴底；回合结束的原地重载不打扰阅读位置
    if (!(opts && opts.keepStick)) { t._stick = true; t._userSig = null; }
    schedule('dock', renderDock);
    markChat(ws);
    if (done) done();
  });
}
// 强制重载当前会话的转录（回合结束后用）
function reloadSessionDetail(ws, done) {
  const t = S.tabs.get(ws);
  if (!t || !t.session) { if (done) done(); return; }
  t.detailSession = '';
  loadSessionDetail(ws, t.session, done, { keepStick: true });
}

/* ---------- 回合快照：git.numstat 前后差 → 已编辑文件卡 --------------
   begin 在 turn_begin 时拍快照，end 在 turn_end 时再取一次；失败静默降级
   （后端 core-git 未就绪 / 非 git 仓库时不显示编辑卡）。                   */
function numstatMap(out) {
  if (!out || out.ok === false || !Array.isArray(out.files)) return null;
  const m = new Map();
  for (const f of out.files) {
    if (!f || !f.path) continue;
    m.set(String(f.path), { add: Number(f.add || 0), del: Number(f.del || 0) });
  }
  return m;
}
function diffNumstat(before, after) {
  if (!before || !after) return [];
  const out = [];
  for (const [path, a] of after) {
    const b = before.get(path) || { add: 0, del: 0 };
    const add = a.add - b.add;
    const del = a.del - b.del;
    if (add > 0 || del > 0) out.push({ path: path, add: Math.max(0, add), del: Math.max(0, del) });
  }
  out.sort((x, y) => (y.add + y.del) - (x.add + x.del));
  return out;
}
// 从当前回合的消息里聚合用量 / 用户消息 / 工具与轮次（end 在重载之前调用）
function turnStatsFromMsgs(t) {
  let lastUser = -1;
  for (let i = t.msgs.length - 1; i >= 0; i--) { if (t.msgs[i].role === 'user') { lastUser = i; break; } }
  const slice = lastUser >= 0 ? t.msgs.slice(lastUser) : t.msgs.slice();
  let inTok = 0, outTok = 0, cache = 0, rounds = 0, toolCalls = 0;
  for (const m of slice) {
    if (m.role === 'round') {
      rounds++;
      inTok += Number(m.tok_in || 0); outTok += Number(m.tok_out || 0); cache += Number(m.cache || 0);
    } else if (m.role === 'tool') toolCalls++;
  }
  const usage = (inTok || outTok) ? { in: inTok, out: outTok, cache: cache } : null;
  return {
    usage: usage, rounds: rounds, toolCalls: toolCalls,
    userText: lastUser >= 0 ? String(t.msgs[lastUser].text || '') : '',
  };
}
// 演示模式直接问 08-mock.js 的 numstat：08b-panels.js 会包装 Mock.api 提供
// 面板的静态数据，那套数据不随回合变化，无法生成「本回合改动」的差异。
// 真实后端走 §6 契约的 git.numstat；失败静默降级（不显示编辑卡）。
function numstatSnapshot(ws) {
  if (S.mode === 'demo' && typeof Mock !== 'undefined' && Mock && typeof Mock.numstat === 'function')
    return Promise.resolve(Mock.numstat());
  return Promise.resolve(api('git.numstat', { ws: ws, cwd: cwdOf(ws) }));
}
const ChatTurns = {
  begin(ws) {
    const t = ensureTab(ws);
    if (t._turnSnap) return;
    const snap = { startedAt: Date.now(), beforeP: null };
    t._turnSnap = snap;
    try {
      snap.beforeP = numstatSnapshot(ws).then(out => numstatMap(out)).catch(() => null);
    } catch (e) { snap.beforeP = Promise.resolve(null); }
  },
  end(e) {
    const ws = (e && e.ws) ? e.ws : S.active;
    const t = S.tabs.get(ws); if (!t) return;
    const snap = t._turnSnap; if (!snap) return;
    t._turnSnap = null;
    const stats = turnStatsFromMsgs(t);
    const meta = {
      session: t.session, startedAt: snap.startedAt, endedAt: nowSec(),
      edits: [],
      usage: stats.usage,
      rounds: stats.rounds || Number((e && e.rounds) || 0),
      toolCalls: stats.toolCalls || Number((e && e.tool_calls) || 0),
      userText: stats.userText,
      natural: !(e && e.natural === false),
    };
    t._turnMeta = meta;
    markChat(ws);
    if (!snap.beforeP) return;
    snap.beforeP.then(before => {
      if (!before) return;
      numstatSnapshot(ws)
        .then(after => {
          if (!after || after.ok === false) return;
          const edits = diffNumstat(before, numstatMap(after));
          if (!edits.length) return;
          meta.edits = edits;
          if (S.tabs.get(ws) !== t) return;
          markChat(ws);
        }).catch(() => {});
    });
  },
};
window.ChatTurns = ChatTurns;

/* 审批事件在 00-core.js 里只重绘模态框（renderApproval），不重绘消息流：
   这里在事件处理之后补一次 markChat，让流内审批卡随出现/消失更新。
   只包装全局函数，不修改别人的文件；00-core 自己补 markChat 后本兜底无害。 */
(function hookApprovalRender() {
  for (const name of ['onApproval', 'onApprovalResolved']) {
    const orig = window[name];
    if (typeof orig !== 'function' || orig.__chatHooked) continue;
    const wrapped = function (ev) {
      const r = orig.apply(this, arguments);
      try {
        if (!ev || !ev.ws || ev.ws === S.active) markChat(S.active);
      } catch (e) {}
      return r;
    };
    wrapped.__chatHooked = true;
    window[name] = wrapped;
  }
})();
