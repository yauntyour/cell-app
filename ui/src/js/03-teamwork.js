/* ---------- G. Teamwork -------------------------------------------- */
// 导航栏的 #navDock 按钮：面板开合的唯一 UI 入口。关闭后仍可随时唤回，
// 不必靠切换会话（此前没有任何按钮能打开它）。
function toggleDock() { S.dockOpen ? closeDock() : openDock(S.dock); }

function openDock(name) {
  S.dock = name || S.dock;
  S.dockOpen = true;
  $('#rightdock').classList.add('open');
  Layout.apply(); // 用记住的宽度（可被分隔条拖到 1200px），而非 CSS 的 380px
  paintDockToggle();
  schedule('dock', renderDock);
}
function closeDock() {
  S.dockOpen = false;
  $('#rightdock').classList.remove('open');
  Layout.apply(); // 关闭时宽度归 0，但记住的值保留
  paintDockToggle();
  syncTwPoll(); // 面板关了就别再接团队轮询（否则后台白拉）
}
// 按钮的按下态 / 无障碍属性跟随面板真实状态
function paintDockToggle() {
  const b = $('#navDock');
  if (!b) return;
  b.classList.toggle('on', S.dockOpen);
  b.setAttribute('aria-pressed', S.dockOpen ? 'true' : 'false');
  const name = S.dock === 'notices' ? '通知' : (S.dock === 'archives' ? '存档' : 'Teamwork');
  b.title = S.dockOpen
    ? '关闭 ' + name + ' 面板'
    : '打开 ' + name + ' 面板';
}

function renderDock() {
  const body = $('#dockBody');
  if (!body) return;
  syncTwPoll(); // 面板开合 / 切标签 / 任务起止都会走到这里，顺手复核轮询开关
  $$('.docktab').forEach(b => b.classList.toggle('on', b.dataset.dock === S.dock));
  const t = curTab();
  // 存档/通知的计数不放在标签上（切会话、回合结束后容易过期）：各自面板的
  // 头部就是权威计数（「N 个存档」/「N 条通知」）
  if (!t) { body.replaceChildren(el('div', 'dim small', '没有打开的工作区')); return; }
  if (S.dock === 'teamwork') renderDockTeamwork(body, t);
  else if (S.dock === 'archives') renderDockArchives(body, t);
  else renderDockNotices(body, t);
}

function renderDockTeamwork(body, t) {
  const head = el('div', 'row gap8');
  head.style.marginBottom = '10px';
  head.appendChild(el('span', 'small mut', t.jobs.length + ' 个任务'));
  head.appendChild(el('span', 'grow'));
  const rf = el('button', 'btn ghost sm', '刷新');
  rf.onclick = () => refreshTeamwork(S.active);
  head.appendChild(rf);
  const mk = el('button', 'btn ghost sm', '＋ 新建');
  mk.onclick = () => { setComposerMode('team'); focusInput(); };
  head.appendChild(mk);
  body.replaceChildren(head);
  // 面板内容以磁盘为准：LLM 通过 tw 工具建/跑的任务没有 SSE 事件，
  // 回合结束时 jobsFor 会失效（同存档架的套路），这里按需静默重拉
  if (t.jobsFor !== t.session) {
    const e = el('div', 'dim small');
    e.style.padding = '14px 4px';
    e.textContent = '正在加载团队任务…';
    body.appendChild(e);
    t.jobsFor = t.session; // 先占位，防止并发重复拉取（同存档架）
    refreshTeamwork(t.ws, true);
    return;
  }
  if (!t.jobs.length) {
    const e = el('div', 'dim small');
    e.style.padding = '14px 4px';
    e.textContent = '还没有团队任务。用输入栏的 Teamwork 模式创建，或在聊天里让 LLM 规划。';
    body.appendChild(e);
    return;
  }
  for (const job of t.jobs) body.appendChild(renderJobCard(t, job));
}

/* ---------- Teamwork 面板的运行时自动刷新 ----------------------------
   后台 job 的推进（worker 汇报、阶段切换、收尾）只写磁盘 store，没有
   对应的 SSE 事件（teamwork_changed 只在 create/run/stop 命令边界发），
   不轮询的话卡片会一直停在上次拉到的 status。规则：面板开着且在
   teamwork 标签、并且有 run 状态任务时，每 2.5s 拉一次 teamwork.list
   （与子代理浮窗的 1.5s 轮询同一套路）；面板关闭 / 没有运行中任务 /
   页面隐藏时不动。任务收尾后最后一次轮询会把终态拉回来并停表。      */
const TW_POLL_MS = 2500;
let twTimer = 0, twPollInFlight = false;
function twHasRunningJob() {
  const t = curTab();
  return !!(t && t.jobs && t.jobs.some(j => jobStatusClass(j.status) === 'run'));
}
function twPollTick() {
  if (twPollInFlight || document.hidden) return; // 隐藏（最小化）时不强拉，与子代理浮窗一致
  twPollInFlight = true;
  refreshTeamwork(S.active, true).finally(() => { twPollInFlight = false; });
}
function syncTwPoll() {
  const on = S.dockOpen && S.dock === 'teamwork' && twHasRunningJob();
  if (on && !twTimer) twTimer = setInterval(twPollTick, TW_POLL_MS);
  else if (!on && twTimer) { clearInterval(twTimer); twTimer = 0; }
}

function jobStatusClass(s) {
  s = String(s || '').toLowerCase();
  if (/run|active|progress|working/.test(s)) return 'run';
  if (/(^|_)(ok|done|complete|success|approved)/.test(s)) return 'ok';
  if (/fail|error|denied|abort|cancel/.test(s)) return 'bad';
  return 'idle';
}
function workerStatus(w) {
  const s = w.report_status || w.status || '';
  return s ? jobStatusClass(s) : 'idle';
}

function renderJobCard(t, job) {
  const card = el('div', 'job open');
  const head = el('div', 'jobhead');
  const ck = jobStatusClass(job.status);
  const dot = el('span', 'dot ' + (ck === 'idle' ? '' : ck));
  head.appendChild(dot);
  head.appendChild(el('span', 'jid', job.id));
  const st = el('span', 'pill ' + (ck === 'idle' ? '' : ck), job.status || 'pending');
  st.classList.add('status');
  head.appendChild(st);
  head.appendChild(el('span', 'grow'));
  const chev = el('span', 'chev', '›');
  head.appendChild(chev);
  const bodyWrap = el('div', 'jobbody');
  let open = true;
  head.onclick = () => {
    open = !open;
    bodyWrap.hidden = !open;
    card.classList.toggle('open', open);
  };
  card.appendChild(head); card.appendChild(bodyWrap);

  const stages = Array.isArray(job.stages) ? job.stages : [];
  const workers = Array.isArray(job.workers) ? job.workers : [];

  if (stages.length) {
    const fw = el('div', 'flowwrap');
    fw.appendChild(buildFlow(job, stages, workers));
    // 点击子代理节点打开 worker 浮窗
    fw.addEventListener('click', ev => {
      const g = ev.target.closest && ev.target.closest('[data-worker]');
      if (g) { const name = g.getAttribute('data-worker'); openWorkerWindow(t, job, name); }
    });
    bodyWrap.appendChild(fw);
  }
  const meta = el('div', 'jobmeta');
  if (job.provider) meta.appendChild(el('span', null, job.provider));
  if (job.model) meta.appendChild(el('span', 'mono', job.model));
  if (job.work_type) meta.appendChild(el('span', null, job.work_type));
  if (job.created_at) meta.appendChild(el('span', null, relTime(job.created_at)));
  if (job.error) { const e = el('span', 'pill bad', job.error); meta.appendChild(e); }
  bodyWrap.appendChild(meta);

  // worker 行（无头像：角色/状态靠状态点 + 等宽名称表达，与 /export 一致）
  const list = el('div');
  list.style.marginTop = '8px';
  for (const w of workers) {
    const row = el('div', 'wrow');
    const s = workerStatus(w);
    row.appendChild(el('span', 'run-dot ' + (s === 'idle' ? '' : s)));
    row.appendChild(el('span', 'wname', w.name));
    if (w.stage_name) row.appendChild(el('span', 'wmeta', w.stage_name));
    const bits = [];
    if (w.rounds != null) bits.push(w.rounds + ' 轮');
    if (w.tool_calls != null) bits.push(w.tool_calls + ' 工具');
    if (w.reviews_approved) bits.push('✓' + w.reviews_approved);
    if (bits.length) row.appendChild(el('span', 'wmeta', bits.join(' · ')));
    row.appendChild(el('span', 'grow'));
    if (w.has_report) {
      const rb = el('button', 'btn ghost sm', '报告');
      rb.onclick = ev => { ev.stopPropagation(); showReport(t, job, w.name); };
      row.appendChild(rb);
    }
    row.onclick = () => openWorkerWindow(t, job, w.name);
    list.appendChild(row);
  }
  bodyWrap.appendChild(list);

  const ctl = el('div', 'jobctl');
  const running = jobStatusClass(job.status) === 'run';
  if (running) {
    const sb = el('button', 'btn sm danger', '停止');
    sb.onclick = () => cmd('teamwork.stop', { ws: t.ws, id: job.id }).then(() => refreshTeamwork(t.ws));
    ctl.appendChild(sb);
  } else {
    const rb = el('button', 'btn sm', '运行');
    rb.onclick = () => cmd('teamwork.run', { ws: t.ws, id: job.id }).then(() => setTimeout(() => refreshTeamwork(t.ws), 400));
    ctl.appendChild(rb);
    const rs = el('button', 'btn sm', '恢复');
    rs.onclick = () => cmd('teamwork.resume', { ws: t.ws, id: job.id }).then(() => setTimeout(() => refreshTeamwork(t.ws), 400));
    ctl.appendChild(rs);
  }
  const rr = el('button', 'btn ghost sm', '刷新');
  rr.onclick = () => refreshTeamwork(t.ws);
  ctl.appendChild(rr);
  bodyWrap.appendChild(ctl);
  return card;
}

/* ---------------------------------------------------------------------
   工作流图：与 cell.cpp /export 同款的 HTML/CSS 流程图（不再用 SVG）
     竖轨（border 画的线）+ 每个阶段一个节点 + 并行阶段扇出的分支盒 +
     关卡虚线框菱形点 + 首尾起点 / 状态终点。见 06-flow.css。
   --------------------------------------------------------------------- */
// 每个阶段的 agent 列表：优先用真实 worker（带状态），否则用阶段定义
function stageAgentsOf(stages, workers) {
  return stages.map((s, si) => {
    const sname = s.name || ('stage ' + (si + 1));
    const fromWorkers = workers.filter(w => {
      if (w.stage != null && w.stage !== '' && w.stage !== undefined) return Number(w.stage) === si;
      return w.stage_name === sname;
    });
    if (fromWorkers.length)
      return fromWorkers.map(w => ({ name: w.name, status: workerStatus(w), ref: w.name, works: w.works || '' }));
    const ag = Array.isArray(s.agents) ? s.agents : (Array.isArray(s.workers) ? s.workers : []);
    return ag.map((a, i) => ({
      name: (typeof a === 'string') ? a : ((a && (a.name || a.works)) || ('agent_' + i)),
      status: 'idle',
      ref: (typeof a === 'string') ? a : ((a && (a.name || a.works)) || ('agent_' + i)),
      works: (a && a.works) || '',
    }));
  });
}

function buildFlow(job, stages, workers) {
  const wrap = el('div', 'flow');
  const cur = Number(job.current_stage);
  const jc = jobStatusClass(job.status);
  const agents = stageAgentsOf(stages, workers);

  // 起点
  const start = el('div', 'fnode cap');
  const sRail = el('div', 'frail');
  sRail.appendChild(el('span', 'fdot'));
  const sBox = el('div', 'fbox');
  sBox.appendChild(el('span', 'fname', 'start'));
  start.appendChild(sRail); start.appendChild(sBox);
  wrap.appendChild(start);

  stages.forEach((s, si) => {
    const list = agents[si] || [];
    const sc = list.length
      ? (list.some(a => a.status === 'run') ? 'run'
        : (list.every(a => a.status === 'ok') ? 'ok' : (list.some(a => a.status === 'bad') ? 'bad' : 'idle')))
      : 'idle';
    const now = cur === si;
    const node = el('div', 'fnode' + (s.gate ? ' gate' : '') + (now ? ' now' : ''));
    const rail = el('div', 'frail');
    const dot = el('span', 'fdot' + (sc !== 'idle' ? ' ' + sc : ''));
    rail.appendChild(dot);
    const box = el('div', 'fbox');
    const hd = el('div', 'fhd');
    hd.appendChild(el('span', 'fn', String(si + 1).padStart(2, '0')));
    hd.appendChild(el('span', 'fname', s.name || ('stage ' + (si + 1))));
    hd.appendChild(el('span', 'kbadge', s.mode || 'serial'));
    if (s.gate) hd.appendChild(el('span', 'kbadge', 'gate'));
    box.appendChild(hd);
    box.appendChild(el('div', 'fmeta', list.length + ' agent' + (s.gate ? ' · 关卡' : '')));
    if (list.length) {
      const fan = list.length > 1 || (s.mode === 'parallel');
      const ul = el('ul', 'fbr' + (fan ? ' fan' : ''));
      ul.style.setProperty('--n', String(list.length));
      for (const a of list) {
        const li = el('li');
        li.setAttribute('data-worker', a.ref || '');
        const row = el('div', 'frow');
        row.appendChild(el('span', 'wd ' + (a.status || 'idle')));
        row.appendChild(el('span', 'nm', a.name || '?'));
        if (a.status && a.status !== 'idle') row.appendChild(el('span', 'st', a.status));
        li.appendChild(row);
        if (a.works) li.appendChild(el('span', 'ex', trunc(String(a.works), 90)));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    node.appendChild(rail);
    node.appendChild(box);
    wrap.appendChild(node);
  });

  // 终点：任务当前状态
  const end = el('div', 'fnode cap');
  const eRail = el('div', 'frail');
  eRail.appendChild(el('span', 'fdot' + (jc !== 'idle' ? ' ' + jc : '')));
  const eBox = el('div', 'fbox');
  const ehd = el('div', 'fhd');
  ehd.appendChild(el('span', 'fname', job.status || 'pending'));
  eBox.appendChild(ehd);
  if (job.error) eBox.appendChild(el('div', 'fmeta', trunc(String(job.error), 80)));
  end.appendChild(eRail); end.appendChild(eBox);
  wrap.appendChild(end);
  return wrap;
}
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function showReport(t, job, workerName) {
  cmd('teamwork.report', { ws: t.ws, job: job.id, worker: workerName }).then(out => {
    if (!out || out.ok === false) return;
    showModal('报告 · ' + workerName, out.report || '（空）');
  });
}

/* ---------- 浮窗骨架（子代理对话 / 历史存档共用） --------------------
   可拖拽 / 最小化 / 关闭，注册在 t.wins 里按 key 去重。同一 key 再次
   打开只是还原窗口（返回 null，调用方据此跳过重复加载）。            */
function makeFloatWin(t, key, roleLabel, title) {
  const old = t.wins.get(key);
  if (old) { old.node.style.display = ''; old.node.classList.remove('min'); return null; }
  const node = el('div', 'wwin');
  const head = el('div', 'whead');
  head.appendChild(el('span', 'dot run'));
  head.appendChild(el('span', 'role', roleLabel));
  head.appendChild(el('span', 'wtitle', trunc(title, 20)));
  const wctl = el('div', 'wctl');
  const mn = el('button', 'btn ghost sm', '—');
  const cx = el('button', 'btn ghost sm', '✕');
  wctl.appendChild(mn); wctl.appendChild(cx);
  head.appendChild(wctl);
  const body = el('div', 'wbody');
  node.appendChild(head); node.appendChild(body);
  // 初始位置：右下错位排列
  const n = t.wins.size;
  node.style.left = Math.max(20, window.innerWidth - 440 - (n % 4) * 30) + 'px';
  node.style.top = Math.max(60, 120 + (n % 5) * 34) + 'px';
  $('#windows').appendChild(node);

  const w = { node, body, key, since: 0, timer: 0, alive: true, min: false, status: '', _stick: true };
  t.wins.set(key, w);
  makeDraggable(node, head);
  // 贴底状态由滚动位置决定：用户上翻后，后续轮询不再把他弹回底部
  body.addEventListener('scroll', () => { w._stick = isNearBottom(body); });
  mn.onclick = () => { w.min = !w.min; node.classList.toggle('min', w.min); mn.textContent = w.min ? '▢' : '—'; };
  cx.onclick = () => closeFloatWin(t, key);
  head.ondblclick = () => { w.min = !w.min; node.classList.toggle('min', w.min); };
  return w;
}

function closeFloatWin(t, key) {
  const w = t.wins.get(key);
  if (!w) return;
  w.alive = false;
  clearInterval(w.timer);
  w.node.remove();
  t.wins.delete(key);
}

/* ---------- Worker 浮窗 -------------------------------------------- */
function openWorkerWindow(t, job, name) {
  if (!name) return;
  const key = job.id + '\u0000' + name;
  const w = makeFloatWin(t, key, '子代理', name);
  if (!w) return; // 已打开：仅还原
  renderWorkerHead(w, job, name, '');
  w.body.replaceChildren(el('div', 'dim small', '正在加载子代理对话…'));
  pollWorker(t, key, job.id, name);
  w.timer = setInterval(() => { if (document.hidden) return; pollWorker(t, key, job.id, name); }, 1500);
}

function renderWorkerHead(w, job, name, status) {
  const d = $('.dot', w.node);
  const s = jobStatusClass(status);
  d.className = 'dot ' + (s === 'idle' ? '' : s);
  d.style.animation = s === 'run' ? 'pulseRing 1.4s var(--ease) infinite' : '';
  $('.wtitle', w.node).textContent = trunc(name, 20) + (status ? ' · ' + status : '');
}

async function pollWorker(t, key, jobId, name) {
  const w = t.wins.get(key);
  if (!w || !w.alive) return;
  const out = await api('teamwork.worker', { ws: t.ws, job: jobId, worker: name, since: w.since });
  if (!w.alive) return;
  if (!out || out.ok === false) {
    if (out && out.error && /not written yet|not found|unreadable/.test(out.error)) {
      if (!w.__warned) { w.body.replaceChildren(el('div', 'dim small', out.error)); w.__warned = true; }
    }
    return;
  }
  w.status = out.status || w.status;
  renderWorkerHead(w, null, name, w.status);
  const msgs = Array.isArray(out.messages) ? out.messages : [];
  const wasPinned = w.since === 0 || w._stick;   // 首屏，或本来就贴着底部
  if (w.since === 0) { w.body.replaceChildren(); w._stick = true; }
  if (w.since === 0 && !msgs.length) w.body.appendChild(el('div', 'dim small', '（暂无对话）'));
  for (const m of msgs) w.body.appendChild(renderWorkerMsg(m, name));
  if (out.total != null) w.since = out.total;
  // 只有原本贴着底部才跟着滚：用户上翻看历史时，每 1.5s 的轮询不再把他弹回底部
  if (wasPinned && !w.node.classList.contains('min')) w.body.scrollTop = w.body.scrollHeight;
}

function renderWorkerMsg(m, worker) {
  const role = (m && (m.role || (m.type === 'assistant' ? 'assistant' : m.type))) || '?';
  const box = el('div', 'wmsg');
  // 与 /export 一致：无头像，头部是角色点 + 角色名 + 子代理名
  const head = el('div', 'wmsg-head');
  head.appendChild(el('span', 'dot ' + (ROLE_DOT[role] || 'other')));
  head.appendChild(el('span', 'role', ROLE_LABEL[role] || role));
  head.appendChild(el('span', 'grow'));
  if (worker) head.appendChild(el('span', 'wmeta', worker));
  box.appendChild(head);

  // 正文与主会话共用 renderContentHtml：markdown 排版一致，思考 / 工具调用 /
  // 工具结果一律收进 <details> 折叠卡（见 5.4b）
  const txt = el('div', 'wtext prose');
  txt.innerHTML = renderContentHtml(m ? m.content : '', role, (m && m.tool_call_id) || '');
  box.appendChild(txt);
  return box;
}

function makeDraggable(node, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
  handle.addEventListener('mousedown', ev => {
    if (ev.target.closest('button')) return;
    on = true; sx = ev.clientX; sy = ev.clientY;
    ox = node.offsetLeft; oy = node.offsetTop;
    node.style.zIndex = 90;
    ev.preventDefault();
  });
  const mv = ev => {
    if (!on) return;
    node.style.left = clamp(ox + ev.clientX - sx, -100, window.innerWidth - 60) + 'px';
    node.style.top = clamp(oy + ev.clientY - sy, 0, window.innerHeight - 40) + 'px';
  };
  const up = () => { on = false; };
  document.addEventListener('mousemove', mv);
  document.addEventListener('mouseup', up);
}

/* ---------------------------------------------------------------------
   存档架（dock 第三个标签页）与存档浮窗

   会话的压缩历史存档从聊天流移到这里收纳：一个存档一张卡，点击在
   小窗里看全文。存档可能同时存在多个，因此每个存档一个独立浮窗
   （与子代理浮窗共用 makeFloatWin 骨架），互不干扰。
   列表用轻量命令 session.archives 拉（只列 saved/*.jsonl，不读
   transcript），所以回合结束（可能刚落一个新存档）后也能廉价刷新。
   --------------------------------------------------------------------- */
function renderDockArchives(body, t) {
  const head = el('div', 'row gap8');
  head.style.marginBottom = '10px';
  head.appendChild(el('span', 'small mut', (t.archives.length || 0) + ' 个存档'));
  head.appendChild(el('span', 'grow'));
  const rf = el('button', 'btn ghost sm', '刷新');
  rf.onclick = () => refreshArchives(t.ws, true);
  head.appendChild(rf);
  body.replaceChildren(head);
  if (t.archivesFor !== t.session) {
    // 还没为当前会话拉过列表：先出占位，拉到后 refreshArchives 会重绘
    const e = el('div', 'dim small');
    e.style.padding = '14px 4px';
    e.textContent = '正在加载存档列表…';
    body.appendChild(e);
    refreshArchives(t.ws, false);
    return;
  }
  if (!t.archives.length) {
    const e = el('div', 'dim small');
    e.style.padding = '14px 4px';
    e.textContent = '当前会话还没有历史存档。上下文装满自动压缩后，压缩前的对话会出现在这里。';
    body.appendChild(e);
    return;
  }
  for (const a of t.archives) body.appendChild(renderArchiveCard(t, a));
}

function renderArchiveCard(t, a) {
  const card = el('div', 'job arch');
  const head = el('div', 'jobhead');
  head.appendChild(el('span', 'dot'));
  const nm = el('span', 'jid trunc', a.name);
  nm.title = a.name;
  head.appendChild(nm);
  head.appendChild(el('span', 'pill status', (a.msgs || 0) + ' 条'));
  head.onclick = () => openArchiveWindow(t, a);
  card.appendChild(head);
  const meta = el('div', 'jobmeta');
  if (a.mtime) meta.appendChild(el('span', null, relTime(a.mtime)));
  meta.appendChild(el('span', null, '点击在小窗中查看'));
  card.appendChild(meta);
  return card;
}

// 存档浮窗：内容是静态的，一次拉全量，不需要轮询
function openArchiveWindow(t, a) {
  if (!a || !a.name) return;
  const key = 'arch\u0000' + a.name;
  const w = makeFloatWin(t, key, '存档', a.name);
  if (!w) return; // 已打开：仅还原
  w.body.replaceChildren(el('div', 'dim small', '正在加载存档…'));
  cmd('session.archive', { ws: t.ws, id: t.session, name: a.name }).then(out => {
    if (!w.alive) return; // 加载期间被关掉
    if (!out || out.ok === false) {
      w.body.replaceChildren(el('div', 'dim small', (out && out.error) || '加载失败'));
      return;
    }
    const stream = el('div', 'wstream');
    // notice 归档（清空通知/清空上下文的产物）：按通知卡的形状渲染，
    // 不是消息流——消息解析器读它会得到空集（曾显示「存档为空」）
    if (Array.isArray(out.notices)) {
      for (const n of out.notices) {
        const card = el('div', 'ncard');
        const hd = el('div', 'nhead');
        hd.appendChild(el('span', 'dot ' + (n.state === 'dropped' ? 'warn' : 'run')));
        hd.appendChild(el('span', 'nfrom trunc', n.from || '?'));
        if (n.topic) hd.appendChild(el('span', 'ntopic ' + n.topic, TOPIC_ZH[n.topic] || n.topic));
        hd.appendChild(el('span', 'grow'));
        if (n.state) hd.appendChild(el('span', 'tiny dim', n.state === 'dropped' ? '已丢弃' : '已投递'));
        if (n.created_at) hd.appendChild(el('span', 'tiny dim', relTime(n.created_at)));
        card.appendChild(hd);
        const bd = el('div', 'nbody');
        bd.innerHTML = highlightBody(n.body);
        card.appendChild(bd);
        stream.appendChild(card);
      }
      if (!out.notices.length) stream.appendChild(el('div', 'dim small', '（存档为空）'));
      w.body.replaceChildren(stream);
      return;
    }
    // 与主会话同一套消息渲染（markdown / 工具卡 / 摘要折叠全保留），
    // 间距与字号按浮窗尺度收紧（03-molecules.css 的 .wstream）
    const entries = out.entries || [];
    for (const e of entries)
      for (const m of detailEntries(e)) stream.appendChild(makeMsg(m));
    if (!entries.length) stream.appendChild(el('div', 'dim small', '（存档为空）'));
    w.body.replaceChildren(stream);
  });
}
