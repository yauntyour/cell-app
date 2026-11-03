/* ==== 后台任务（exec background=true 挂起的进程）====================
   引擎把 `exec(background=true)` 的命令挂到它自己的一条线程上（不是工具
   线程池的槽位），注册表在 cell::bg 里 —— CLI 的 /tasks 和这个浮层读的是
   同一份数据。数据通路：

     · 打开浮层 / 启动时：tasks.list（全量快照）
     · 任务开始或结束：后端推 tasks 事件（同样带全量列表，见 onTasksEvent）
     · 终止：tasks.kill；看输出：tasks.output（事件里也带一小段 tail）

   入口是**每个会话顶栏自己的 chip**（.ch-tasks，摆在「本会话用量」左边）：
   后台任务本来就属于某个会话，数字只算这个会话在跑的数量。浮层按会话分组
   收纳 —— 当前会话那组默认展开，其余收起；外壳仍与「用量」浮层共用
   （.usage-pop / .up-head / .up-body）。
   运行中任务的耗时在本地按「收到列表的时刻 + 已跑时长」推算，不必每秒
   去问后端。                                                            */

const TASK_TAIL_BYTES = 4096;   // 行内预览取多少字节的输出尾巴

function tasksAll() { return Array.isArray(S.tasks) ? S.tasks : []; }
function tasksRunning() { return tasksAll().filter(t => t && t.running).length; }

/* 已跑时长：引擎给的是收到列表那一刻的秒数，运行中的任务要加上之后流逝的时间 */
function taskElapsed(t) {
  const base = Number(t && t.elapsed) || 0;
  if (!t || !t.running || !S.tasksAt) return base;
  return base + Math.max(0, (Date.now() - S.tasksAt) / 1000);
}
function taskDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
  return Math.floor(sec / 3600) + 'h' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';
}

/* ---- chip：会话顶栏的「后台任务」（用量 chip 左边） ------------------ */
function tasksOfSession(sid) {
  const k = sid || '';
  return tasksAll().filter(t => ((t && t.session) || '') === k);
}
function ensureChatTasksBtn(head) {
  let b = head.querySelector('.ch-tasks');
  if (b) return b;
  b = el('button', 'ch-tasks');
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(iconEl('squareTerminal', 'sm'));
  b.appendChild(el('span', 'chu-val', '—'));
  b.onclick = ev => { ev.stopPropagation(); toggleTasksPop(); };
  const usage = head.querySelector('.ch-usage');
  if (usage) usage.insertAdjacentElement('beforebegin', b);
  else head.appendChild(b);
  return b;
}
function paintChatTasks(ws) {
  const head = $('#chathead-' + cssId(ws));
  if (!head) return;
  const b = head.querySelector('.ch-tasks');
  if (!b) return;
  const t = S.tabs.get(ws);
  const mine = tasksOfSession(t && t.session);
  const run = mine.filter(x => x.running).length;
  const val = $('.chu-val', b);
  b.classList.toggle('has-val', mine.length > 0);
  b.classList.toggle('run', run > 0);
  b.classList.toggle('on', !!S.tasksOpen);
  b.setAttribute('aria-expanded', S.tasksOpen ? 'true' : 'false');
  if (val) val.textContent = run ? String(run) : '—';
  b.title = run
    ? '后台任务 · 本会话 ' + run + ' 个在运行（点击展开）'
    : (mine.length ? '后台任务 · 本会话 ' + mine.length + ' 个已结束（点击展开）' : '后台任务（点击展开）');
}
/* chip 的显示口径变了（任务增删、切会话）就整体刷一遍 */
function paintTasksChip() {
  for (const ws of S.tabOrder || []) paintChatTasks(ws);
}

/* 后端推来的列表：任务开始/结束都会来一条（见 app_core::start_task_watcher） */
function onTasksEvent(e) {
  S.tasks = Array.isArray(e && e.tasks) ? e.tasks : [];
  S.tasksAt = Date.now();
  paintTasksChip();
  if (S.tasksOpen) paintTasksPop();
}

/* 拉一次全量快照（启动时给 chip 一个数，浮层里的「刷新」也走这里） */
async function refreshTasks(force) {
  if (!S.tasks.length && !force && S.tasksAt) return; // 事件已给过，别重复问
  const out = await cmd('tasks.list', {});
  if (!out || out.ok === false) return;
  S.tasks = Array.isArray(out.tasks) ? out.tasks : [];
  S.tasksAt = Date.now();
  paintTasksChip();
  if (S.tasksOpen) paintTasksPop();
}

/* ---- 浮层 ---------------------------------------------------------- */
let tasksPop = null;
let tasksTick = 0;   // 运行中任务的耗时刷新定时器

function closeTasksPop() {
  if (tasksTick) { clearInterval(tasksTick); tasksTick = 0; }
  if (!tasksPop) return;
  tasksPop.el.remove();
  document.removeEventListener('pointerdown', tasksPop.out, true);
  document.removeEventListener('keydown', tasksPop.key, true);
  window.removeEventListener('resize', tasksPop.resize);
  tasksPop = null;
  S.tasksOpen = false;
  paintTasksChip();
}
function tasksPopPlace(pop, anchor) {
  // 入口在会话顶栏：浮层从 chip 下缘往下铺，右缘对齐（顶栏右侧没有多余空间）
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
  pop.style.top = top + 'px';
}
/* chip 所在位置：当前标签页的会话顶栏；没有（空态 / 演示）就退回标题栏 */
function tasksPopAnchor() {
  const head = S.active ? $('#chathead-' + cssId(S.active)) : null;
  const b = head && head.querySelector('.ch-tasks');
  return b || $('#btnTopSearch') || $('#titlebar');
}
function openTasksPop(force) {
  if (tasksPop) { if (force) refreshTasks(true); return; }
  const anchor = tasksPopAnchor();
  if (!anchor) return;
  const pop = el('div', 'usage-pop task-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '后台任务');
  const head = el('div', 'up-head');
  head.appendChild(el('span', 'up-title', '后台任务'));
  head.appendChild(el('span', 'up-sub', ''));
  head.appendChild(el('span', 'grow'));
  const bRefresh = el('button', 'icon-btn sm');
  bRefresh.type = 'button';
  bRefresh.title = '刷新列表';
  bRefresh.setAttribute('aria-label', '刷新列表');
  bRefresh.appendChild(iconEl('refresh', 'sm'));
  bRefresh.onclick = () => refreshTasks(true);
  head.appendChild(bRefresh);
  const bClose = el('button', 'icon-btn sm');
  bClose.type = 'button';
  bClose.title = '收起 (Esc)';
  bClose.setAttribute('aria-label', '收起');
  bClose.appendChild(iconEl('x', 'sm'));
  bClose.onclick = () => closeTasksPop();
  head.appendChild(bClose);
  pop.appendChild(head);
  pop.appendChild(el('div', 'up-body'));
  document.body.appendChild(pop);

  const out = ev => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) closeTasksPop(); };
  const key = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();   // 别让全局 Esc 顺手把右侧面板也关掉
    closeTasksPop();
  };
  const resize = () => { if (tasksPop) tasksPopPlace(pop, anchor); };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', resize);
  tasksPop = { el: pop, anchor: anchor, out: out, key: key, resize: resize };
  S.tasksOpen = true;
  // 每次打开都从「当前会话」这一组看起，其余会话收起（按会话收纳）
  S.tasksOpenGroups = new Set([((S.tabs.get(S.active) || {}).session) || '']);
  paintTasksChip();
  paintTasksPop();
  refreshTasks(true);
  // 每秒：先只走耗时（不重建 DOM，展开的输出和滚动位置都保得住），展开中的
  // 运行任务顺带拉一次最新输出（就是用户在看的那一条，值得这一趟）
  tasksTick = setInterval(tickTasks, 1000);
}
function toggleTasksPop() { S.tasksOpen ? closeTasksPop() : openTasksPop(true); }

/* 每秒的轻量刷新：只改文本，不重建列表（按 id 对行，分组后 DOM 顺序≠列表顺序） */
function tickTasks() {
  if (!tasksPop) return;
  const list = tasksAll();
  const items = tasksPop.el.querySelectorAll('.task-item');
  for (const node of items) {
    const t = list.find(x => x.id === node.dataset.id);
    if (!t) { paintTasksPop(); return; } // 任务被回收了，整块重画
    const d = node.querySelector('.tk-dur');
    if (d) d.textContent = taskDur(taskElapsed(t));
  }
  const shown = list.find(t => t.id === S.tasksShown);
  if (shown && shown.running) refreshTaskOutput(shown.id);
}

/* 拉一条任务的输出尾巴写进已展开的 <pre>（不重建 DOM）。
   走裸 api 而不是 cmd：这是每秒一次的后台刷新，失败不该弹 toast。 */
let tasksOutBusy = false;
async function refreshTaskOutput(id) {
  if (tasksOutBusy || !tasksPop) return;
  tasksOutBusy = true;
  try {
    const out = await api('tasks.output', { id: id });
    if (!out || !out.ok || typeof out.text !== 'string' || S.tasksShown !== id) return;
    const pre = tasksPop && tasksPop.el.querySelector('.task-out[data-id="' + id + '"] .task-pre');
    if (pre) pre.textContent = out.text;
  } catch (e) {
    /* 任务刚被回收 / 连接抖动：保持上一次的内容 */
  } finally {
    tasksOutBusy = false;
  }
}

/* 会话名：优先用会话标题（侧栏里显示的那条），否则短 id */
function taskSessionLabel(sid) {
  if (!sid) return '未归属会话';
  const s = (S.sessions || []).find(x => x.id === sid);
  return (s && s.title) || shortId(sid);
}
function paintTasksPop() {
  if (!tasksPop) return;
  const list = tasksAll();
  const run = tasksRunning();
  const sub = tasksPop.el.querySelector('.up-sub');
  if (sub) sub.textContent = list.length ? (run + ' 运行 / ' + list.length + ' 共') : '';
  const body = tasksPop.el.querySelector('.up-body');
  if (!body) return;
  body.textContent = '';
  if (!list.length) {
    const empty = el('div', 'up-empty');
    empty.appendChild(el('div', null, '还没有后台任务'));
    empty.appendChild(el('div', 'tk-hint',
      '让 agent 用 exec(background=true) 起一个进程（开发服务器、watcher、长构建…），它会在自己的线程上跑，不占工具线程池，也不挡当前回合。'));
    body.appendChild(empty);
  } else {
    const cur = ((S.tabs.get(S.active) || {}).session) || '';
    const groups = new Map();               // session id -> tasks（保持注册表顺序）
    for (const t of list) {
      const k = (t && t.session) || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    // 当前会话排第一，其余保持原顺序（sort 稳定）
    const keys = Array.from(groups.keys()).sort((a, b) => (b === cur) - (a === cur));
    for (const k of keys) body.appendChild(taskGroup(k, groups.get(k), cur));
  }
  tasksPopPlace(tasksPop.el, tasksPop.anchor); // 内容高度变了，重新贴边
}

/* 一个会话一组：标题行（折叠开关 + 会话名 + 计数），展开后才是任务行 */
function taskGroup(sid, items, curSession) {
  const open = S.tasksOpenGroups.has(sid);
  const g = el('div', 'tk-group' + (open ? ' open' : '') + (sid === curSession ? ' cur' : ''));
  const head = el('button', 'tk-ghead');
  head.type = 'button';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  head.appendChild(iconEl('chevronRight', 'sm'));
  head.appendChild(el('span', 'tk-gname trunc', taskSessionLabel(sid)));
  const run = items.filter(t => t.running).length;
  head.appendChild(el('span', 'tk-gcnt', run ? run + ' 运行 / ' + items.length : String(items.length)));
  head.title = (sid || '未记录会话') + ' —— 点击' + (open ? '收起' : '展开');
  head.onclick = () => {
    if (S.tasksOpenGroups.has(sid)) S.tasksOpenGroups.delete(sid);
    else S.tasksOpenGroups.add(sid);
    paintTasksPop();
  };
  g.appendChild(head);
  if (open) {
    const box = el('div', 'tk-gitems');
    for (const t of items) box.appendChild(taskRow(t));
    g.appendChild(box);
  }
  return g;
}

function taskRow(t) {
  const failed = !t.running && t.exit != null && t.exit !== 0;
  const row = el('div', 'task-row' + (t.running ? ' run' : '') + (failed ? ' bad' : ''));
  const dot = el('span', 'tk-dot');
  row.appendChild(dot);
  row.appendChild(el('span', 'tk-id', t.id || '?'));
  const cmd = el('span', 'tk-cmd', t.cmd || '');
  cmd.title = (t.cmd || '') + (t.wd ? '\nwd: ' + t.wd : '') + (t.tid ? '\nthread: ' + t.tid : '');
  row.appendChild(cmd);
  row.appendChild(el('span', 'tk-dur', taskDur(taskElapsed(t))));

  // 结束的任务把退出码放在耗时后面，运行中的留空
  if (!t.running) row.appendChild(el('span', 'tk-exit' + (failed ? ' bad' : ''), 'exit ' + (t.exit == null ? '?' : t.exit)));

  const bOut = el('button', 'icon-btn sm tk-btn');
  bOut.type = 'button';
  bOut.title = '查看输出';
  bOut.setAttribute('aria-label', '查看输出');
  bOut.appendChild(iconEl('chevronDown', 'sm'));
  row.appendChild(bOut);

  if (t.running) {
    const bKill = el('button', 'icon-btn sm tk-btn tk-kill');
    bKill.type = 'button';
    bKill.title = '终止（整棵进程树）';
    bKill.setAttribute('aria-label', '终止');
    bKill.appendChild(iconEl('stop', 'sm'));
    bKill.onclick = async ev => {
      ev.stopPropagation();
      bKill.disabled = true;
      const out = await cmd('tasks.kill', { id: t.id });
      if (out && out.tasks) { S.tasks = out.tasks; S.tasksAt = Date.now(); paintTasksChip(); }
      if (out && out.message) toast(out.message, out.ok === false ? 'bad' : 'ok');
      paintTasksPop();
    };
    row.appendChild(bKill);
  }

  const wrap = el('div', 'task-item');
  wrap.dataset.id = t.id;
  wrap.appendChild(row);

  // 展开的输出：先显示事件里带的 tail，再问一次 tasks.output 拿最新的
  const outBox = el('div', 'task-out');
  outBox.dataset.id = t.id;
  outBox.style.display = 'none';
  const pre = el('pre', 'task-pre');
  pre.textContent = t.tail || '（还没有输出）';
  outBox.appendChild(pre);
  wrap.appendChild(outBox);
  const expanded = S.tasksShown === t.id;
  if (expanded) { outBox.style.display = ''; bOut.classList.add('open'); }

  bOut.onclick = async () => {
    const open = outBox.style.display === 'none';
    outBox.style.display = open ? '' : 'none';
    bOut.classList.toggle('open', open);
    S.tasksShown = open ? t.id : null;
    if (!open) return;
    await refreshTaskOutput(t.id);
    if (tasksPop) tasksPopPlace(tasksPop.el, tasksPop.anchor);
  };
  return wrap;
}
