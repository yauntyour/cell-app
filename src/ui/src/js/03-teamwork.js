/* ---------- G. Teamwork：任务卡 / 工作流图 / 子代理浮窗 / 存档架 -------
   面板内容以磁盘为准：LLM 通过 tw 工具创建/运行的任务没有 SSE 事件，
   jobsFor 失效后按需静默重拉（与存档架同一套路）。样式见 06-flow.css
   与 06b-sidepanels.css。                                               */

/* 面板骨架：标题 + 计数 + 右侧操作 —— 三个面板（团队/通知/存档）共用 */
function pnlHead(title, sub, actions) {
  const head = el('div', 'pnl-head');
  head.appendChild(el('span', 'pnl-title', title));
  if (sub) head.appendChild(el('span', 'pnl-sub', sub));
  head.appendChild(el('span', 'grow'));
  const bar = el('div', 'pnl-acts');
  for (const a of (actions || [])) {
    const b = el('button', a.btnCls || 'icon-btn sm', a.label || '');
    if (a.icon) b.appendChild(iconEl(a.icon, 'sm'));
    if (a.text) b.appendChild(el('span', null, a.text));
    b.title = a.title || '';
    b.onclick = a.on;
    bar.appendChild(b);
  }
  head.appendChild(bar);
  return head;
}
function pnlEmpty(text, iconName, action) {
  const box = el('div', 'pnl-empty');
  if (iconName) {
    const ic = el('span', 'pe-ico');
    ic.appendChild(iconEl(iconName, 'xl'));
    box.appendChild(ic);
  }
  box.appendChild(el('div', 'pe-text', text));
  if (action) {
    const b = el('button', 'btn sm', action.label);
    b.onclick = action.on;
    box.appendChild(b);
  }
  return box;
}

/* ---------- Teamwork 面板 ------------------------------------------ */
function renderDockTeamwork(body, t) {
  const n = (t.jobs || []).length;
  const running = (t.jobs || []).filter(j => jobStatusClass(j.status) === 'run').length;
  const head = pnlHead('Teamwork', running ? running + ' 个运行中 · 共 ' + n + ' 个任务' : n + ' 个任务', [
    { icon: 'refresh', title: '刷新任务列表', on: () => refreshTeamwork(t.ws) },
    {
      icon: 'plus', title: '新建团队任务（切到输入栏 Teamwork 模式）',
      on: () => { setComposerMode('team'); focusInput(); },
    },
  ]);
  body.replaceChildren(head);

  // 面板内容以磁盘为准：没为当前会话拉过就先拉一次再渲染
  if (t.jobsFor !== t.session) {
    t.jobsFor = t.session; // 先占位，防止并发重复拉取
    body.appendChild(pnlEmpty('正在加载团队任务…', 'users'));
    refreshTeamwork(t.ws, true);
    return;
  }
  if (!n) {
    body.appendChild(pnlEmpty('还没有团队任务。用输入栏的 Teamwork 模式创建，或在聊天里让 LLM 规划。', 'users', {
      label: '新建任务', on: () => { setComposerMode('team'); focusInput(); },
    }));
    return;
  }
  const list = el('div', 'pnl-scroll');
  for (const job of t.jobs) list.appendChild(renderJobCard(t, job));
  body.appendChild(list);
}

/* ---------- 运行时自动刷新 ------------------------------------------
   后台 job 的推进只写磁盘 store，没有 SSE 事件：面板开着、在 teamwork
   标签、且有运行中任务时每 2.5s 拉一次；关面板 / 无运行任务 / 页面隐藏
   时停表。                                                            */
const TW_POLL_MS = 2500;
let twTimer = 0, twPollInFlight = false;
function twHasRunningJob() {
  const t = curTab();
  return !!(t && t.jobs && t.jobs.some(j => jobStatusClass(j.status) === 'run'));
}
function twPollTick() {
  if (twPollInFlight || document.hidden) return;
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
const STATUS_ZH = {
  running: '运行中', run: '运行中', pending: '待运行', idle: '空闲',
  done: '已完成', ok: '已完成', complete: '已完成', success: '已完成',
  failed: '失败', error: '失败', denied: '已拒绝', stopped: '已停止', cancelled: '已取消',
};
function statusZh(s) {
  const k = String(s || '').toLowerCase();
  return STATUS_ZH[k] || s || '未知';
}

/* ---------- 任务卡 -------------------------------------------------- */
function renderJobCard(t, job) {
  const ck = jobStatusClass(job.status);
  const card = el('div', 'twcard ' + ck + ' open');
  const head = el('button', 'twcard-head');
  const orb = el('span', 'status-orb ' + (ck === 'idle' ? '' : ck));
  head.appendChild(orb);
  const title = el('span', 'tw-id mono', job.id || '');
  title.title = job.id || '';
  head.appendChild(title);
  head.appendChild(el('span', 'pill ' + (ck === 'idle' ? '' : ck), statusZh(job.status)));
  head.appendChild(el('span', 'grow'));
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const workers = Array.isArray(job.workers) ? job.workers : [];
  if (workers.length) head.appendChild(el('span', 'tw-count', workers.length + ' 子代理'));
  const chev = el('span', 'tw-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  head.appendChild(chev);
  const bodyWrap = el('div', 'twcard-body');
  let open = true;
  head.onclick = () => {
    open = !open;
    bodyWrap.hidden = !open;
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  head.setAttribute('aria-expanded', 'true');
  card.appendChild(head); card.appendChild(bodyWrap);

  if (stages.length) {
    const fw = el('div', 'flowwrap');
    fw.appendChild(buildFlow(job, stages, workers));
    fw.addEventListener('click', ev => {
      const g = ev.target.closest && ev.target.closest('[data-worker]');
      if (g) { const name = g.getAttribute('data-worker'); openWorkerWindow(t, job, name); }
    });
    bodyWrap.appendChild(fw);
  }
  const meta = el('div', 'tw-meta');
  const bits = [];
  if (job.work_type) bits.push(job.work_type);
  if (job.model) bits.push(job.model);
  if (job.created_at) bits.push(relTime(job.created_at));
  if (bits.length) meta.appendChild(el('span', 'tw-meta-i mono', bits.join(' · ')));
  if (job.error) meta.appendChild(el('span', 'pill bad', trunc(String(job.error), 60)));
  if (meta.childElementCount) bodyWrap.appendChild(meta);

  // 子代理行
  if (workers.length) {
    const list = el('div', 'wlist');
    for (const w of workers) {
      const row = el('button', 'wrow');
      const s = workerStatus(w);
      row.appendChild(el('span', 'run-dot ' + (s === 'idle' ? '' : s)));
      row.appendChild(el('span', 'wname', w.name || 'worker'));
      if (w.stage_name) row.appendChild(el('span', 'wstage', w.stage_name));
      row.appendChild(el('span', 'grow'));
      const metaBits = [];
      if (w.rounds != null) metaBits.push(w.rounds + ' 轮');
      if (w.tool_calls != null) metaBits.push(w.tool_calls + ' 工具');
      if (w.reviews_approved) metaBits.push('✓' + w.reviews_approved);
      if (metaBits.length) row.appendChild(el('span', 'wmeta', metaBits.join(' · ')));
      if (w.has_report) {
        const rb = el('button', 'btn ghost sm', '报告');
        rb.onclick = ev => { ev.stopPropagation(); showReport(t, job, w.name); };
        row.appendChild(rb);
      }
      row.title = '打开子代理对话';
      row.onclick = () => openWorkerWindow(t, job, w.name);
      list.appendChild(row);
    }
    bodyWrap.appendChild(list);
  }

  // 操作
  const ctl = el('div', 'tw-ctl');
  if (ck === 'run') {
    const sb = el('button', 'btn sm', '停止');
    sb.onclick = () => cmd('teamwork.stop', { ws: t.ws, id: job.id }).then(() => refreshTeamwork(t.ws));
    ctl.appendChild(sb);
  } else {
    const rb = el('button', 'btn sm accent', '运行');
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

/* ---------- 工作流图（HTML/CSS 竖轨 + 扇出分支，不用 SVG） ----------- */
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

  const start = el('div', 'fnode cap');
  const sRail = el('div', 'frail'); sRail.appendChild(el('span', 'fdot'));
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
    rail.appendChild(el('span', 'fdot' + (sc !== 'idle' ? ' ' + sc : '')));
    const box = el('div', 'fbox');
    const hd = el('div', 'fhd');
    hd.appendChild(el('span', 'fn', String(si + 1).padStart(2, '0')));
    hd.appendChild(el('span', 'fname', s.name || ('stage ' + (si + 1))));
    hd.appendChild(el('span', 'kbadge', s.mode || 'serial'));
    if (s.gate) hd.appendChild(el('span', 'kbadge warn', 'gate'));
    box.appendChild(hd);
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
        if (a.status && a.status !== 'idle') row.appendChild(el('span', 'st', statusZh(a.status)));
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

  const end = el('div', 'fnode cap');
  const eRail = el('div', 'frail');
  eRail.appendChild(el('span', 'fdot' + (jc !== 'idle' ? ' ' + jc : '')));
  const eBox = el('div', 'fbox');
  eBox.appendChild(el('span', 'fname', statusZh(job.status || 'pending')));
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

/* ---------- 浮窗骨架（子代理对话 / 历史存档共用） -------------------- */
function makeFloatWin(t, key, roleLabel, title) {
  const old = t.wins.get(key);
  if (old) { old.node.style.display = ''; old.node.classList.remove('min'); return null; }
  const node = el('div', 'wwin');
  const head = el('div', 'wwin-head');
  head.appendChild(el('span', 'dot run'));
  head.appendChild(el('span', 'wwin-role', roleLabel));
  head.appendChild(el('span', 'wwin-title trunc', trunc(title, 24)));
  head.appendChild(el('span', 'grow'));
  const wctl = el('div', 'wwin-ctl');
  const mn = el('button', 'icon-btn sm');
  mn.appendChild(iconEl('chevronDown', 'sm'));
  mn.title = '最小化';
  const cx = el('button', 'icon-btn sm');
  cx.appendChild(iconEl('x', 'sm'));
  cx.title = '关闭';
  wctl.appendChild(mn); wctl.appendChild(cx);
  head.appendChild(wctl);
  const body = el('div', 'wwin-body');
  node.appendChild(head); node.appendChild(body);
  const n = t.wins.size;
  node.style.left = Math.max(20, window.innerWidth - 460 - (n % 4) * 32) + 'px';
  node.style.top = Math.max(60, 96 + (n % 5) * 36) + 'px';
  $('#windows').appendChild(node);

  const w = { node, body, key, since: 0, timer: 0, alive: true, min: false, status: '', _stick: true };
  t.wins.set(key, w);
  makeDraggable(node, head);
  body.addEventListener('scroll', () => { w._stick = isNearBottom(body); });
  mn.onclick = () => { w.min = !w.min; node.classList.toggle('min', w.min); mn.title = w.min ? '还原' : '最小化'; };
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
  const key = job.id + '|' + name;
  const w = makeFloatWin(t, key, '子代理', name);
  if (!w) return;
  renderWorkerHead(w, job, name, '');
  w.body.replaceChildren(el('div', 'dim small', '正在加载子代理对话…'));
  pollWorker(t, key, job.id, name);
  w.timer = setInterval(() => { if (document.hidden) return; pollWorker(t, key, job.id, name); }, 1500);
}
function renderWorkerHead(w, job, name, status) {
  const d = $('.dot', w.node);
  const s = jobStatusClass(status);
  if (d) { d.className = 'dot ' + (s === 'idle' ? '' : s); d.style.animation = s === 'run' ? 'pulseRing 1.4s var(--ease) infinite' : ''; }
  const ttl = $('.wwin-title', w.node);
  if (ttl) ttl.textContent = trunc(name, 24) + (status ? ' · ' + statusZh(status) : '');
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
  const wasPinned = w.since === 0 || w._stick;
  if (w.since === 0) { w.body.replaceChildren(); w._stick = true; }
  if (w.since === 0 && !msgs.length) w.body.appendChild(el('div', 'dim small', '（暂无对话）'));
  for (const m of msgs) w.body.appendChild(renderWorkerMsg(m, name));
  if (out.total != null) w.since = out.total;
  if (wasPinned && !w.node.classList.contains('min')) w.body.scrollTop = w.body.scrollHeight;
}
function renderWorkerMsg(m, worker) {
  const role = (m && (m.role || (m.type === 'assistant' ? 'assistant' : m.type))) || '?';
  const box = el('div', 'wmsg');
  const head = el('div', 'wmsg-head');
  head.appendChild(el('span', 'dot ' + (ROLE_DOT[role] || 'other')));
  head.appendChild(el('span', 'role', ROLE_LABEL[role] || role));
  head.appendChild(el('span', 'grow'));
  if (worker) head.appendChild(el('span', 'wmeta', worker));
  box.appendChild(head);
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

/* ---------- 存档架（dock 第三个标签页）与存档浮窗 ------------------- */
function renderDockArchives(body, t) {
  const head = pnlHead('存档', (t.archives.length || 0) + ' 个压缩存档', [
    { icon: 'refresh', title: '刷新存档列表', on: () => refreshArchives(t.ws, true) },
  ]);
  body.replaceChildren(head);
  if (t.archivesFor !== t.session) {
    body.appendChild(pnlEmpty('正在加载存档列表…', 'archive'));
    refreshArchives(t.ws, false);
    return;
  }
  if (!t.archives.length) {
    body.appendChild(pnlEmpty('当前会话还没有历史存档。上下文装满自动压缩后，压缩前的对话会出现在这里。', 'archive'));
    return;
  }
  const list = el('div', 'pnl-scroll');
  for (const a of t.archives) list.appendChild(renderArchiveCard(t, a));
  body.appendChild(list);
}
function renderArchiveCard(t, a) {
  const card = el('button', 'archcard');
  const ic = el('span', 'arch-ico');
  ic.appendChild(iconEl('archive', 'lg'));
  card.appendChild(ic);
  const main = el('span', 'arch-main');
  main.appendChild(el('span', 'arch-name trunc', a.name || '存档'));
  const bits = [];
  if (a.mtime) bits.push(relTime(a.mtime));
  if (a.msgs) bits.push(a.msgs + ' 条消息');
  main.appendChild(el('span', 'arch-meta', bits.join(' · ')));
  card.appendChild(main);
  const chev = el('span', 'arch-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  card.appendChild(chev);
  card.title = (a.name || '') + '  ·  点击在小窗中查看';
  card.onclick = () => openArchiveWindow(t, a);
  return card;
}
// 存档浮窗：内容是静态的，一次拉全量，不需要轮询
function openArchiveWindow(t, a) {
  if (!a || !a.name) return;
  const key = 'arch|' + a.name;
  const w = makeFloatWin(t, key, '存档', a.name);
  if (!w) return;
  w.body.replaceChildren(el('div', 'dim small', '正在加载存档…'));
  cmd('session.archive', { ws: t.ws, id: t.session, name: a.name }).then(out => {
    if (!w.alive) return;
    if (!out || out.ok === false) {
      w.body.replaceChildren(el('div', 'dim small', (out && out.error) || '加载失败'));
      return;
    }
    const stream = el('div', 'wstream');
    // notice 归档（清空通知/清空上下文的产物）：按通知卡的形状渲染
    if (Array.isArray(out.notices)) {
      for (const n of out.notices) {
        const card = el('div', 'ncard');
        const hd = el('div', 'nhead');
        hd.appendChild(el('span', 'dot ' + (n.state === 'dropped' ? 'warn' : 'run')));
        hd.appendChild(el('span', 'nfrom trunc', n.from || '?'));
        if (n.topic) hd.appendChild(el('span', 'ntopic ' + n.topic, TOPIC_ZH[n.topic] || n.topic));
        hd.appendChild(el('span', 'grow'));
        if (n.state) hd.appendChild(el('span', 'ntime', n.state === 'dropped' ? '已丢弃' : '已投递'));
        if (n.created_at) hd.appendChild(el('span', 'ntime', relTime(n.created_at)));
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
    const entries = out.entries || [];
    for (const e of entries)
      for (const m of detailEntries(e)) stream.appendChild(makeMsg(m));
    if (!entries.length) stream.appendChild(el('div', 'dim small', '（存档为空）'));
    w.body.replaceChildren(stream);
  });
}
