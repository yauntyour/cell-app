/* ---------- G. Teamwork：任务卡 / 工作流图 / 子代理浮窗 / 存档架 -------
   面板内容以磁盘为准：LLM 通过 tw 工具创建/运行的任务没有 SSE 事件，
   jobsFor 失效后按需静默重拉（与存档架同一套路）。样式见 06-flow.css
   与 06b-sidepanels.css。

   刷新协议（修复「提交/运行后卡片不自动刷新」）：
   · jobsAt = 每个 tab 最近一次 teamwork.list 的完成时间。面板每次渲染时
     只要距上次拉取超过 TW_STALE_MS 就在后台静默重拉，卡片不闪不空；
   · 00-core / 02-render 也会主动刷新（它们不打时间戳）：渲染时比较
     t.jobs 数组引用，发现别人已经换过数据就只补时间戳，不重复请求；
   · composer 提交（create/run）后立即 await 刷新，再在 +500/1500ms 补拉；
     用户点运行/恢复/停止后同样立即刷新；
   · 运行中任务仍按 2.5s 轮询（仅面板打开且在 teamwork 标签时）；
     waiting / failed 不轮询——靠 notice 钩子、用户操作或重新进入面板触发。
   子代理浮窗见 §「Worker 浮窗」：打开即渲染任务/状态/进度/等待卡，
   失败时给完整原因并停掉无效轮询，手动刷新与报告入口保留。           */

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

/* ---------- Teamwork 面板 ------------------------------------------
   自动刷新（轮询 / 渲染时重拉）会整块重建列表：这里保存滚动位置与
   卡片展开状态，重建后还原，避免每 2.5s 把用户滚到的位置弹回顶部。   */
const twScrollByWs = {};
let twPanelWs = '';
function renderDockTeamwork(body, t) {
  twPatchMockDemo();
  const oldList = body.querySelector('#twJobList');
  if (oldList && twPanelWs) twScrollByWs[twPanelWs] = oldList.scrollTop;
  const jobs = Array.isArray(t.jobs) ? t.jobs : [];
  const n = jobs.length;
  const running = jobs.filter(j => jobStatusClass(j.status) === 'run').length;
  const waiting = jobs.filter(j => jobStatusClass(j.status) === 'warn').length;
  const failed = jobs.filter(j => jobStatusClass(j.status) === 'bad').length;
  const bits = [];
  if (running) bits.push(running + ' 个运行中');
  if (waiting) bits.push(waiting + ' 个等待');
  if (failed) bits.push(failed + ' 个失败');
  bits.push('共 ' + n + ' 个任务');
  const head = pnlHead('Teamwork', bits.join(' · '), [
    { icon: 'refresh', title: '刷新任务列表', on: () => { twRefresh(t.ws, false, true); } },
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
    twRefresh(t.ws, true);
    return;
  }
  if (!n) {
    body.appendChild(pnlEmpty('还没有团队任务。用输入栏的 Teamwork 模式创建，或在聊天里让 LLM 规划。', 'users', {
      label: '新建任务', on: () => { setComposerMode('team'); focusInput(); },
    }));
    twMaybeRefresh(t);
    return;
  }
  const list = el('div', 'pnl-scroll');
  list.id = 'twJobList';
  for (const job of jobs) list.appendChild(renderJobCard(t, job));
  body.appendChild(list);
  twPanelWs = t.ws;
  const keepTop = twScrollByWs[t.ws] || 0;
  if (keepTop) requestAnimationFrame(() => {
    const n = document.getElementById('twJobList');
    if (n) n.scrollTop = keepTop;
  });
  twMaybeRefresh(t); // 数据超过 2s 就静默重拉（已渲染的卡片先留着，不闪空态）
}

/* ---------- 自动刷新 -------------------------------------------------
   所有主动刷新都走 twRefresh：完成后打 jobsAt 时间戳、重算轮询表。    */
const TW_POLL_MS = 2500;
const TW_STALE_MS = 2000;
let twTimer = 0, twPollInFlight = false;

async function twRefresh(ws, quiet, force) {
  if (!ws) return null;
  const t = S.tabs.get(ws);
  if (!t) return null;
  if (t._twFetching && !force) return null; // 已有同会话请求在飞：等它回来即可
  t._twFetching = (t._twFetching || 0) + 1;
  let jobs = null;
  try { jobs = await refreshTeamwork(ws, quiet); }
  catch (e) { jobs = null; }
  const t2 = S.tabs.get(ws);
  if (t2) {
    t2._twFetching = Math.max(0, (t2._twFetching || 1) - 1);
    t2.jobsAt = Date.now();
  }
  syncTwPoll();
  return jobs;
}
// 渲染时按需重拉：超过 TW_STALE_MS 才拉；延迟 150ms 先看别的模块是否已经
// 刷过（比较 t.jobs 数组引用——refreshTeamwork 每次都会换新数组），避免重复请求。
function twMaybeRefresh(t) {
  if (!t || t.jobsFor !== t.session || t._twFetching) return;
  const now = Date.now();
  const stamp = Math.max(Number(t.jobsAt) || 0, Number(t._twFetchAt) || 0);
  if (now - stamp < TW_STALE_MS) return;
  const before = t.jobs;
  t._twFetchAt = now;
  setTimeout(() => {
    if (t.jobsFor !== t.session) return;
    if (t.jobs !== before) { t.jobsAt = Date.now(); return; }
    twRefresh(t.ws, true);
  }, 150);
}

function twHasRunningJob() {
  const t = curTab();
  return !!(t && Array.isArray(t.jobs) && t.jobs.some(j => jobStatusClass(j.status) === 'run'));
}
function twPollTick() {
  if (twPollInFlight || document.hidden) return;
  twPollInFlight = true;
  twRefresh(S.active, true).finally(() => { twPollInFlight = false; });
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
  if (/wait|gate|hold|pause|stop/.test(s)) return 'warn';
  return 'idle';
}
function workerStatus(w) {
  const s = (w && (w.report_status || w.status)) || '';
  return s ? jobStatusClass(s) : 'idle';
}
const STATUS_ZH = {
  running: '运行中', run: '运行中', pending: '待运行', idle: '空闲', queued: '排队中',
  waiting: '等待中', gate: '等待确认', paused: '已暂停',
  done: '已完成', ok: '已完成', complete: '已完成', completed: '已完成', success: '已完成',
  failed: '失败', error: '失败', denied: '已拒绝', aborted: '已中止',
  stopped: '已停止', cancelled: '已取消', canceled: '已取消', skipped: '已跳过',
};
function statusZh(s) {
  const k = String(s || '').toLowerCase();
  return STATUS_ZH[k] || s || '未知';
}
// waiting 的两种语义：关卡确认（gate）/ 停止后等待恢复（stopped）。
// 后端把「停止」也记成 status=waiting + stopped:true + error='stopped by the supervisor'，
// 列表接口不暴露 stopped 字段，所以从 error 文本区分。
function jobWaitKind(job) {
  if (!job || jobStatusClass(job.status) !== 'warn') return '';
  const err = String(job.error || '').toLowerCase();
  return /stop/.test(err) ? 'stopped' : 'gate';
}
function jobStatusZh(job) {
  const kind = jobWaitKind(job);
  if (kind === 'stopped') return '等待恢复';
  if (kind === 'gate') return '等待关卡确认';
  return statusZh(job && job.status);
}
function stageNameOf(job, i) {
  const stages = (job && Array.isArray(job.stages)) ? job.stages : [];
  const s = stages[Number(i)];
  return (s && (s.name || ('stage ' + (Number(i) + 1)))) || '';
}

/* ---------- 任务卡 -------------------------------------------------- */
function renderJobCard(t, job) {
  const ck = jobStatusClass(job.status);
  const waitKind = jobWaitKind(job);
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const workers = Array.isArray(job.workers) ? job.workers : [];
  const card = el('div', 'twcard ' + ck + ' open');
  const head = el('button', 'twcard-head');
  const orb = el('span', 'status-orb ' + (ck === 'idle' ? '' : ck));
  head.appendChild(orb);
  const title = el('span', 'tw-id mono', job.id || '');
  title.title = job.id || '';
  head.appendChild(title);
  head.appendChild(el('span', 'pill ' + (ck === 'idle' ? '' : ck), jobStatusZh(job)));
  head.appendChild(el('span', 'grow'));
  if (workers.length) head.appendChild(el('span', 'tw-count', workers.length + ' 子代理'));
  const chev = el('span', 'tw-chev');
  chev.appendChild(iconEl('chevronRight', 'sm'));
  head.appendChild(chev);
  const bodyWrap = el('div', 'twcard-body');
  // 展开/收起状态记在 tab 上：自动刷新重建 DOM 后保持原样
  const openKey = job.id || '';
  t._twOpen = t._twOpen || {};
  let open = t._twOpen[openKey] !== false;
  head.onclick = () => {
    open = !open;
    t._twOpen[openKey] = open;
    bodyWrap.hidden = !open;
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if (!open) { bodyWrap.hidden = true; card.classList.remove('open'); }
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  card.appendChild(head); card.appendChild(bodyWrap);

  // 等待关卡确认 / 等待恢复：置顶提示 + 运行/恢复按钮（不再等轮询）
  if (waitKind) bodyWrap.appendChild(renderWaitBanner(t, job, waitKind));
  // 失败：完整 job.error（可折叠，长文不截断）
  if (ck === 'bad') {
    const errBox = renderJobError(job);
    if (errBox) bodyWrap.appendChild(errBox);
  }
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
  if (meta.childElementCount) bodyWrap.appendChild(meta);

  if (workers.length) bodyWrap.appendChild(renderWorkerList(t, job, workers));
  bodyWrap.appendChild(renderJobControls(t, job, ck, waitKind));
  return card;
}

/* 等待横幅：gate = 等待关卡确认；stopped = 等待恢复 */
function renderWaitBanner(t, job, kind) {
  const box = el('div', 'tw-wait ' + kind);
  const ic = el('span', 'tw-wait-ico');
  ic.appendChild(iconEl(kind === 'stopped' ? 'stop' : 'clock', 'sm'));
  box.appendChild(ic);
  const main = el('div', 'tw-wait-main');
  main.appendChild(el('div', 'tw-wait-title', kind === 'stopped' ? '任务已停止 · 等待恢复' : '等待关卡确认'));
  const stage = stageNameOf(job, job.current_stage);
  const next = stageNameOf(job, job.next_stage);
  let hint;
  if (kind === 'stopped') {
    hint = next ? '恢复后从阶段「' + next + '」继续（该阶段会重新执行）。' : '恢复后继续执行未完成的阶段。';
  } else {
    hint = (stage ? '阶段「' + stage + '」已完成，' : '') + (next ? '确认后继续「' + next + '」。' : '确认后完成该任务。');
  }
  main.appendChild(el('div', 'tw-wait-hint', hint));
  const acts = el('div', 'tw-wait-acts');
  acts.appendChild(jobActionBtn(t, job, '运行', 'accent', 'run'));
  acts.appendChild(jobActionBtn(t, job, '恢复', '', 'resume'));
  box.appendChild(main);
  box.appendChild(acts);
  return box;
}

/* 失败原因：完整文本，<details> 可折叠；不截断（旧实现只显示 60 字 pill） */
function renderJobError(job) {
  const err = String((job && job.error) || '').trim();
  const details = el('details', 'tw-err');
  details.open = true;
  const sum = el('summary', 'tw-err-hd');
  const ic = el('span', 'tw-err-ico');
  ic.appendChild(iconEl('alert', 'sm'));
  sum.appendChild(ic);
  sum.appendChild(el('span', 'tw-err-title', '失败原因'));
  sum.appendChild(el('span', 'grow'));
  sum.appendChild(el('span', 'tw-err-n', err ? err.length + ' 字' : '无错误详情'));
  details.appendChild(sum);
  const pre = el('pre', 'tw-err-text');
  pre.textContent = err || '任务以失败状态结束，但没有记录错误详情。可查看通知面板里的最后进度，或打开失败子代理的报告。';
  details.appendChild(pre);
  return details;
}

function renderWorkerList(t, job, workers) {
  const list = el('div', 'wlist');
  const failedN = workers.filter(w => workerStatus(w) === 'bad').length;
  if (jobStatusClass(job.status) === 'bad' && failedN)
    list.appendChild(el('div', 'tw-subh', '失败子代理 · ' + failedN));
  for (const w of workers) list.appendChild(renderWorkerRow(t, job, w));
  return list;
}
function renderWorkerRow(t, job, w) {
  const s = workerStatus(w);
  const rec = w || {};
  const row = el('button', 'wrow' + (s === 'bad' ? ' bad' : ''));
  row.appendChild(el('span', 'run-dot ' + (s === 'idle' ? '' : s)));
  row.appendChild(el('span', 'wname', rec.name || 'worker'));
  if (rec.stage_name) row.appendChild(el('span', 'wstage', rec.stage_name));
  const raw = String(rec.report_status || rec.status || '').toLowerCase();
  if (s === 'bad') row.appendChild(el('span', 'wpill bad', statusZh(raw || 'failed')));
  else if (s === 'warn') row.appendChild(el('span', 'wpill warn', statusZh(raw)));
  else if (/skip|queue/.test(raw)) row.appendChild(el('span', 'wpill idle', statusZh(raw)));
  row.appendChild(el('span', 'grow'));
  const metaBits = [];
  if (rec.rounds != null) metaBits.push(rec.rounds + ' 轮');
  if (rec.tool_calls != null) metaBits.push(rec.tool_calls + ' 工具');
  if (rec.reviews_approved) metaBits.push('✓' + rec.reviews_approved);
  if (metaBits.length) row.appendChild(el('span', 'wmeta', metaBits.join(' · ')));
  if (rec.has_report) {
    const rb = el('button', 'btn ghost sm', '报告');
    rb.onclick = ev => { ev.stopPropagation(); showReport(t, job, rec.name); };
    row.appendChild(rb);
  }
  row.title = s === 'bad' ? '打开子代理对话（含失败详情）' : '打开子代理对话';
  row.onclick = () => openWorkerWindow(t, job, rec.name);
  return row;
}

function renderJobControls(t, job, ck, waitKind) {
  const ctl = el('div', 'tw-ctl');
  if (ck === 'run') {
    ctl.appendChild(jobActionBtn(t, job, '停止', '', 'stop'));
  } else if (ck === 'bad') {
    ctl.appendChild(jobActionBtn(t, job, '重试', 'accent', 'run'));
    ctl.appendChild(jobActionBtn(t, job, '恢复', '', 'resume'));
  } else if (!waitKind) {
    // waiting 卡的操作在等待横幅上，这里不重复
    ctl.appendChild(jobActionBtn(t, job, '运行', 'accent', 'run'));
    ctl.appendChild(jobActionBtn(t, job, '恢复', '', 'resume'));
  }
  const rr = el('button', 'btn ghost sm', '刷新');
  rr.onclick = () => twRefresh(t.ws, false, true);
  ctl.appendChild(rr);
  return ctl;
}
// 任务操作：命令成功后立刻重拉（并打时间戳），不再 setTimeout(400) 猜落盘时间
function jobActionBtn(t, job, label, cls, name) {
  const b = el('button', 'btn sm ' + (cls || ''), label);
  b.onclick = async ev => {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    const out = await cmd('teamwork.' + name, { ws: t.ws, id: job.id });
    b.disabled = false;
    if (!out || out.ok === false) return;
    toast(name === 'stop' ? '已请求停止任务' : (name === 'run' ? '任务已开始运行' : '任务已恢复'), 'ok', 1600);
    await twRefresh(t.ws, false, true);
    // 后端把状态翻成 running/waiting 有短暂延迟：+600ms 再对一次
    setTimeout(() => { if (S.tabs.get(t.ws) === t) twRefresh(t.ws, true); }, 600);
  };
  return b;
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
      return fromWorkers.map(w => ({ name: w.name, status: workerStatus(w), raw: (w.report_status || w.status || ''), ref: w.name, works: w.works || '' }));
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
  const waitKind = jobWaitKind(job);
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
      ? (list.some(a => a.status === 'bad') ? 'bad'
        : (list.some(a => a.status === 'run') ? 'run'
          : (list.every(a => a.status === 'ok') ? 'ok' : (list.some(a => a.status === 'warn') ? 'warn' : 'idle'))))
      : 'idle';
    const now = cur === si;
    const node = el('div', 'fnode' + (s.gate ? ' gate' : '') + (now ? ' now' : '') + (now && jc === 'warn' ? ' holding' : ''));
    const rail = el('div', 'frail');
    rail.appendChild(el('span', 'fdot' + (sc !== 'idle' ? ' ' + sc : '')));
    const box = el('div', 'fbox');
    const hd = el('div', 'fhd');
    hd.appendChild(el('span', 'fn', String(si + 1).padStart(2, '0')));
    hd.appendChild(el('span', 'fname', s.name || ('stage ' + (si + 1))));
    hd.appendChild(el('span', 'kbadge', s.mode || 'serial'));
    if (s.gate) hd.appendChild(el('span', 'kbadge warn', 'gate'));
    if (now && jc === 'warn') hd.appendChild(el('span', 'kbadge warn', waitKind === 'stopped' ? '等待恢复' : '等待确认'));
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
        // 优先显示子代理真实状态（ok/failed/stopped/skipped…），否则用状态类
        const stLabel = a.raw ? statusZh(a.raw) : (a.status && a.status !== 'idle' ? statusZh(a.status) : '');
        if (stLabel) row.appendChild(el('span', 'st', stLabel));
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
  eBox.appendChild(el('span', 'fname', jobStatusZh(job)));
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
  stopWorkerPoll(w);
  clearInterval(w.timer);
  w.node.remove();
  t.wins.delete(key);
}

/* ====================================================================
   Worker 浮窗：打开即渲染「任务 works + 状态/轮次/工具 + 进度通知 +
   等待首轮输出（秒表）」，transcript 到达后无缝替换；失败时显示失败卡
   （job.error + 状态 + 最后进度），停掉无效轮询但保留手动刷新/报告。
   ==================================================================== */
const WK_POLL_MS = 1200;
const WK_JOB_REFRESH_MS = 3000;

function findJob(t, jobId) {
  const list = (t && Array.isArray(t.jobs)) ? t.jobs : [];
  for (const j of list) if (j && j.id === jobId) return j;
  return null;
}
function findWorker(job, name) {
  const list = (job && Array.isArray(job.workers)) ? job.workers : [];
  for (const w of list) if (w && w.name === name) return w;
  return null;
}
function fmtElapsed(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' + s : String(s));
}
function startWorkerPoll(t, w, key) {
  if (!w || !w.alive) return;
  stopWorkerPoll(w);
  w.timer = setInterval(() => { if (!document.hidden) pollWorker(t, key); }, WK_POLL_MS);
}
function stopWorkerPoll(w) {
  if (w && w.timer) { clearInterval(w.timer); w.timer = 0; }
}

function openWorkerWindow(t, job, name) {
  if (!name) return;
  const jobId = (job && job.id) || '';
  if (!jobId) return;
  const key = jobId + '|' + name;
  const w = makeFloatWin(t, key, '子代理', name);
  if (!w) return;
  // 头部加一个手动刷新（失败停表后仍可用）
  const wctl = $('.wwin-ctl', w.node);
  if (wctl) {
    const rf = el('button', 'icon-btn sm');
    rf.appendChild(iconEl('refresh', 'sm'));
    rf.title = '刷新子代理对话与状态';
    rf.onclick = () => pollWorker(t, key, true);
    wctl.insertBefore(rf, wctl.firstChild);
  }
  w.key = key;
  w.jobId = jobId;
  w.worker = name;
  w.startedAt = Date.now();
  w._lastJobAt = 0;
  w.since = 0;
  w.msgs = [];
  w.status = '';
  w.rounds = null;
  w.toolCalls = null;
  w._polling = false;
  w._final = false;
  w._stick = true;
  w._infoSig = '';
  w._progSig = '';
  w._waitNode = null;
  w._waitClock = null;
  w._waitHint = null;
  w._endSig = '';
  w._failSig = '';

  const rec0 = findWorker(job, name);
  w.works = rec0 ? (rec0.works || '') : '';

  const info = el('div', 'ww-info');
  const prog = el('div', 'ww-prog');
  prog.hidden = true;
  const fail = el('div', 'ww-fail');
  fail.hidden = true;
  const pending = el('div', 'ww-pending');
  const stream = el('div', 'ww-stream');
  w.info = info; w.prog = prog; w.failBox = fail; w.pending = pending; w.stream = stream;
  w.body.replaceChildren(info, prog, fail, pending, stream);

  // 打开瞬间先按当前列表快照渲染，不等网络（以前这里只有一句「正在加载」）
  renderWorkerInfo(w, t, job, name);
  renderWorkerProgress(w, t);
  renderWorkerHead(w, job, name, effectiveWorkerStatus(w, job, rec0));
  syncWorkerState(w, t, job, '', false);
  startWorkerPoll(t, w, key);
  pollWorker(t, key);
}

// 子代理可能还没写 report_status：运行中任务的子代理至少显示「运行中」
function effectiveWorkerStatus(w, job, rec) {
  const s = w.status || (rec && (rec.report_status || rec.status)) || '';
  if (s) return s;
  const jc = jobStatusClass(job && job.status);
  if (jc === 'run') return 'running';
  if (jc === 'warn') return 'waiting';
  if (jc === 'bad') return 'failed';
  if (jc === 'ok') return 'completed';
  return '';
}
function renderWorkerHead(w, job, name, status) {
  const d = $('.dot', w.node);
  const s = jobStatusClass(status);
  if (d) {
    d.className = 'dot ' + (s === 'idle' ? '' : s);
    d.style.animation = s === 'run' ? 'pulseRing 1.4s var(--ease) infinite' : '';
  }
  const ttl = $('.wwin-title', w.node);
  if (ttl) ttl.textContent = trunc(name, 24) + (status ? ' · ' + statusZh(status) : '');
}

/* 任务说明 + 状态/阶段/轮次/工具数 + 报告入口 */
function renderWorkerInfo(w, t, job, name) {
  const rec = findWorker(job, name) || {};
  if (rec.works) w.works = rec.works;
  if (rec.stage_name) w.stageName = rec.stage_name;
  const status = effectiveWorkerStatus(w, job, rec);
  const rounds = w.rounds != null ? w.rounds : rec.rounds;
  const tools = w.toolCalls != null ? w.toolCalls : rec.tool_calls;
  const sig = [w.works, status, w.stageName || '', rounds, tools, rec.model || '', rec.has_report ? 1 : 0].join('|');
  if (w._infoSig === sig) return;
  w._infoSig = sig;
  const box = w.info;
  box.replaceChildren();
  const works = el('div', 'ww-works');
  works.appendChild(el('span', 'ww-works-lab', '任务'));
  const wt = el('div', 'ww-works-txt', w.works || '（任务说明未写入列表）');
  wt.title = w.works || '';
  works.appendChild(wt);
  box.appendChild(works);
  const chips = el('div', 'ww-chips');
  if (status) chips.appendChild(el('span', 'pill ' + jobStatusClass(status), statusZh(status)));
  if (w.stageName) chips.appendChild(el('span', 'ww-chip', w.stageName));
  if (rounds != null) chips.appendChild(el('span', 'ww-chip', rounds + ' 轮'));
  if (tools != null) chips.appendChild(el('span', 'ww-chip', tools + ' 次工具'));
  if (rec.model) chips.appendChild(el('span', 'ww-chip mono', rec.model));
  if (rec.has_report) {
    const rp = el('button', 'btn ghost sm', '报告');
    rp.onclick = () => showReport(t, job || { id: w.jobId }, name);
    chips.appendChild(rp);
  }
  box.appendChild(chips);
}

/* 进度通知时间线：from 以 teamwork/<job>[/worker] 开头的 notice */
function workerProgressItems(t, jobId) {
  const prefix = 'teamwork/' + jobId;
  const out = [];
  const seen = {};
  const push = n => {
    if (!n || String(n.from || '').indexOf(prefix) !== 0) return;
    const id = n.id || ((n.created_at || 0) + '|' + (n.body || ''));
    if (seen[id]) return;
    seen[id] = true;
    out.push(n);
  };
  for (const n of ((t && t.notices) || [])) push(n);
  if (MOCK && twDemo) for (const n of twDemo.notices) push(n);
  out.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return out;
}
function workerNoticeRow(n) {
  const row = el('div', 'ww-note');
  row.appendChild(el('span', 'ww-note-t', hhmm(n.created_at)));
  if (n.topic) row.appendChild(el('span', 'ntopic ' + n.topic, TOPIC_ZH[n.topic] || n.topic));
  const body = String(n.body || '').replace(/\s+/g, ' ').trim();
  const b = el('span', 'ww-note-b', trunc(body, 150));
  b.title = body;
  row.appendChild(b);
  return row;
}
function renderWorkerProgress(w, t) {
  const items = workerProgressItems(t, w.jobId);
  const last = items.length ? (items[items.length - 1].id || items[items.length - 1].created_at) : '';
  const sig = items.length + '|' + last;
  if (w._progSig === sig) return;
  w._progSig = sig;
  const box = w.prog;
  box.replaceChildren();
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const hd = el('div', 'ww-prog-hd');
  hd.appendChild(el('span', null, '进度通知'));
  hd.appendChild(el('span', 'grow'));
  hd.appendChild(el('span', 'ww-prog-count', items.length + ' 条'));
  box.appendChild(hd);
  const tl = el('div', 'ww-timeline');
  for (const n of items.slice(-6)) tl.appendChild(workerNoticeRow(n));
  box.appendChild(tl);
}

/* 等待卡：带秒表 + 当前阶段提示（每轮轮询刷新计时） */
function showWorkerWait(w, t, job, rec) {
  w._final = false;
  w.failBox.hidden = true;
  w._failSig = '';
  const box = w.pending;
  box.hidden = false;
  if (!w._waitNode || !w._waitNode.parentNode) {
    box.replaceChildren();
    const wait = el('div', 'ww-wait');
    wait.appendChild(el('span', 'ww-wait-dot'));
    const main = el('div', 'ww-wait-main');
    const hd = el('div', 'ww-wait-hd');
    hd.appendChild(el('span', 'ww-wait-title', '等待子代理首轮输出…'));
    const clock = el('span', 'ww-wait-clock mono', '0:00');
    hd.appendChild(clock);
    main.appendChild(hd);
    const hint = el('div', 'ww-wait-hint', '');
    main.appendChild(hint);
    wait.appendChild(main);
    box.appendChild(wait);
    w._waitNode = wait;
    w._waitClock = clock;
    w._waitHint = hint;
    w._endSig = '';
  }
  if (w._waitClock) w._waitClock.textContent = fmtElapsed(Date.now() - w.startedAt);
  if (w._waitHint) {
    const jc = jobStatusClass(job && job.status);
    const stage = (job && Array.isArray(job.stages)) ? job.stages[Number(job.current_stage)] : null;
    let hint = '子代理正在启动/思考；对话写入磁盘后会自动出现（每 1.2s 检查一次）。';
    if (jc === 'run') hint = '任务运行中' + (stage && stage.name ? ' · 阶段「' + stage.name + '」' : '') + '；对话写入磁盘后会自动出现。';
    else if (jc === 'warn') hint = '任务在等待处理；对话写入磁盘后会自动出现。';
    if (w._waitHint.textContent !== hint) w._waitHint.textContent = hint;
  }
}

/* 结束但没有 transcript（任务已完成/等待关卡/子代理已停止） */
function showWorkerEnded(w, t, job, rec) {
  w._final = true;
  w.failBox.hidden = true;
  const jc = jobStatusClass(job && job.status);
  const wc = jobStatusClass(w.status);
  const sig = [jc, wc, w.worker, rec && rec.report_status, rec && rec.has_report ? 1 : 0].join('|');
  if (w._endSig === sig && w._waitNode === null) return;
  w._endSig = sig;
  w._waitNode = null;
  w._waitClock = null;
  w._waitHint = null;
  const box = w.pending;
  box.hidden = false;
  box.replaceChildren();
  const note = el('div', 'ww-ended');
  const ic = el('span', 'ww-ended-ico');
  ic.appendChild(iconEl('checkCircle', 'sm'));
  note.appendChild(ic);
  const main = el('div', 'ww-ended-main');
  let text;
  if (jc === 'warn') text = '该子代理已结束；任务正在等待关卡确认，处理后可恢复。';
  else if (wc === 'warn') text = '该子代理已停止；恢复任务后可以继续。';
  else if (jc === 'ok') text = '任务已完成；该子代理没有写入对话记录。';
  else text = '该子代理已结束；没有写入对话记录。';
  main.appendChild(el('div', 'ww-ended-title', text));
  if (rec && rec.has_report) main.appendChild(el('div', 'ww-ended-hint', '完整结论在「报告」里。'));
  note.appendChild(main);
  if (rec && rec.has_report) {
    const acts = el('div', 'ww-acts');
    const rp = el('button', 'btn sm', '查看报告');
    rp.onclick = () => showReport(t, job || { id: w.jobId }, w.worker);
    acts.appendChild(rp);
    note.appendChild(acts);
  }
  box.appendChild(note);
  stopWorkerPoll(w);
}

/* 失败卡：状态 + job.error（完整）+ 最后几条进度 + 手动刷新/报告 */
function showWorkerFailure(w, t, job, rec, err) {
  w._final = true;
  stopWorkerPoll(w);
  w.pending.hidden = true;
  clearWorkerPending(w);
  const box = w.failBox;
  box.hidden = false;
  const items = workerProgressItems(t, w.jobId).slice(-3);
  const sig = [w.status, (rec && rec.report_status) || '', job && job.status, job && job.error, err, items.length].join('|');
  if (w._failSig === sig) return;
  w._failSig = sig;
  box.replaceChildren();
  const hd = el('div', 'ww-fail-hd');
  const ic = el('span', 'ww-fail-ico');
  ic.appendChild(iconEl('alert', 'sm'));
  hd.appendChild(ic);
  hd.appendChild(el('span', 'ww-fail-title', '子代理失败'));
  const st = w.status || (rec && rec.report_status) || (job && job.status) || 'failed';
  hd.appendChild(el('span', 'pill bad', statusZh(st)));
  box.appendChild(hd);
  const why = String((job && job.error) || '').trim();
  const txt = why || (err ? '读取子代理对话失败：' + err
    : '子代理以失败状态结束，但没有记录错误详情。可查看报告或通知面板里的最后进度。');
  const pre = el('pre', 'ww-err');
  pre.textContent = txt;
  box.appendChild(pre);
  if (items.length) {
    box.appendChild(el('div', 'ww-fail-sub', '最后进度'));
    const tl = el('div', 'ww-timeline');
    for (const n of items) tl.appendChild(workerNoticeRow(n));
    box.appendChild(tl);
  }
  const acts = el('div', 'ww-acts');
  const rb = el('button', 'btn sm', '手动刷新');
  rb.onclick = () => { w._failSig = ''; pollWorker(t, w.key, true); };
  acts.appendChild(rb);
  if (rec && rec.has_report) {
    const rp = el('button', 'btn sm', '查看报告');
    rp.onclick = () => showReport(t, job || { id: w.jobId }, w.worker);
    acts.appendChild(rp);
  }
  box.appendChild(acts);
}

// 移除等待卡节点（transcript 已到 / 已失败），避免隐藏的旧节点残留
function clearWorkerPending(w) {
  w._waitNode = null;
  w._waitClock = null;
  w._waitHint = null;
  if (w.pending) w.pending.replaceChildren();
}

/* 状态机：失败 > 已有对话 > 结束但无 transcript > 等待首轮输出 */
function syncWorkerState(w, t, job, err, hasMsgs) {
  const rec = findWorker(job, w.worker) || {};
  const wc = jobStatusClass(w.status);
  const jc = jobStatusClass(job && job.status);
  const rc = jobStatusClass(rec.report_status || rec.status);
  const notYet = /not written yet/i.test(String(err || ''));
  const hardErr = !!err && !notYet;
  if (hardErr || jc === 'bad' || wc === 'bad' || rc === 'bad') {
    showWorkerFailure(w, t, job, rec, hardErr ? err : '');
    return;
  }
  if (hasMsgs) {
    w._final = false;
    w.failBox.hidden = true;
    w._failSig = '';
    w.pending.hidden = true;
    clearWorkerPending(w);
    // transcript 已到：完成/停止就停表；仍在跑就继续轮询收增量
    if (wc === 'ok' || wc === 'warn' || jc === 'ok' || jc === 'warn') {
      w._final = true;
      stopWorkerPoll(w);
    }
    return;
  }
  if (jc === 'ok' || jc === 'warn' || wc === 'ok' || wc === 'warn') {
    showWorkerEnded(w, t, job, rec);
    return;
  }
  showWorkerWait(w, t, job, rec);
}

async function pollWorker(t, key, force) {
  const w = t.wins.get(key);
  if (!w || !w.alive) return;
  if (w._polling) return;
  w._polling = true;
  let job = findJob(t, w.jobId);
  let err = '';
  let msgs = w.msgs.length;
  try {
    // 1) 任务/子代理快照：失败原因（job.error）、report_status 都来自列表。
    //    正常节流到 3s；手动刷新时强拉。t.jobs 被 notice 钩子更新时也能直接读到。
    const now = Date.now();
    if (force || !w._lastJobAt || now - w._lastJobAt > WK_JOB_REFRESH_MS) {
      w._lastJobAt = now;
      const jobs = await twRefresh(t.ws, true, force);
      if (!w.alive) return;
      if (Array.isArray(jobs)) job = findJob(t, w.jobId) || job;
    }
    // 2) transcript 增量；未落盘时返回 "worker transcript not written yet"（不是故障）
    let out = null;
    try {
      out = await api('teamwork.worker', { ws: t.ws, job: w.jobId, worker: w.worker, since: w.since });
    } catch (e2) {
      out = { ok: false, error: (e2 && e2.message) || String(e2) };
    }
    if (!w.alive) return;
    if (out && out.ok === false) {
      err = String(out.error || '');
    } else if (out) {
      if (out.status) w.status = out.status;
      if (out.rounds != null) w.rounds = out.rounds;
      if (out.tool_calls != null) w.toolCalls = out.tool_calls;
      if (out.total != null && Number(out.total) < w.since) {
        // transcript 被压缩/重写：从头再来
        w.since = 0;
        w.msgs = [];
        w.stream.replaceChildren();
      }
      const delta = Array.isArray(out.messages) ? out.messages : [];
      if (delta.length) {
        const wasPinned = w.since === 0 || w._stick;
        for (const m of delta) {
          w.msgs.push(m);
          w.stream.appendChild(renderWorkerMsg(m, w.worker));
        }
        msgs = w.msgs.length;
        w.pending.hidden = true;
        if (wasPinned && !w.node.classList.contains('min')) w.body.scrollTop = w.body.scrollHeight;
      }
      if (out.total != null) w.since = Number(out.total);
    }
    // 注意：w.status 只存 transcript 文件里的状态；report_status 每次列表刷新都可能
    // 变化（失败任务「重试」后 backend 会重置），不能写进 w.status 变成永久失败态
    const rec = findWorker(job, w.worker);
    renderWorkerInfo(w, t, job, w.worker);
    renderWorkerProgress(w, t);
    renderWorkerHead(w, job, w.worker, effectiveWorkerStatus(w, job, rec));
    syncWorkerState(w, t, job, err, msgs > 0);
    if (!w._final && !w.timer) startWorkerPoll(t, w, key);
  } catch (e) {
    // 兜底：任何异常都不能停在「正在加载」
    if (w && w.alive) {
      try { syncWorkerState(w, t, findJob(t, w.jobId), String((e && e.message) || e), w.msgs.length > 0); } catch (e3) {}
    }
  } finally {
    w._polling = false;
  }
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

/* ---------------------------------------------------------------- 用量统计
   入口在**左侧栏底部** ⌂ 主页按钮旁边：chip 里收纳一个总 tokens，点开是贴在
   chip 上方的收纳浮层（总览方块 → 模型占比条 → 会话明细）。数据来自
   usages.summary（结构化：totals / models / sessions），全局一份，20s 内复用
   缓存；侧栏收起 / 点外面 / Esc 都会把浮层收回去。
   会话行可点：同/跨工作区都交给 session.select（后端按 cwd 索引打开）。   */
function refreshUsages(force) {
  if (S.usagesLoading) return;
  if (!force && S.usages && Date.now() - (S.usages.at || 0) < 20000) return;
  S.usagesLoading = true;
  cmd('usages.summary', {}).then(out => {
    S.usagesLoading = false;
    if (!out || out.ok === false) return;
    S.usages = {
      at: Date.now(),
      totals: out.totals || {},
      models: out.models || [],
      sessions: out.sessions || [],
      totalSessions: out.total_sessions || 0,
    };
    paintUsageChip();
    paintUsagePop();
  }).catch(() => { S.usagesLoading = false; });
}
// provider:model → model（浮层里只留短名，完整名字放 title）
function usShortModel(n) {
  const s = String(n || '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(i + 1) : (s || '未知模型');
}
function usTile(value, label, wide) {
  const box = el('div', 'us-tile' + (wide ? ' wide' : ''));
  box.appendChild(el('span', 'us-v', value));
  box.appendChild(el('span', 'us-k', label));
  return box;
}

/* chip：收纳在侧栏里的那一小块 —— 图标 + 总 tokens（还没数据时是「—」） */
function paintUsageChip() {
  const b = $('#navUsage');
  if (!b) return;
  const val = b.querySelector('.sb-uval');
  const d = S.usages;
  const tot = d ? (d.totals || {}) : { total_tokens: 0, requests: 0 };
  b.classList.toggle('has-val', !!d);
  b.classList.toggle('on', !!S.usagesOpen);
  b.setAttribute('aria-expanded', S.usagesOpen ? 'true' : 'false');
  if (val) val.textContent = d ? fmtTok(tot.total_tokens) : '—';
  b.title = d
    ? '用量统计 · ' + fmtTok(tot.total_tokens) + ' tokens / ' + (tot.requests || 0) + ' 请求（点击展开）'
    : '用量统计（点击展开）';
}

/* 收纳浮层：贴 chip 上方（放不下才翻到下方），宽度固定 340，超出视口内收 */
let usagePop = null;
function closeUsagePop() {
  if (!usagePop) return;
  usagePop.el.remove();
  document.removeEventListener('pointerdown', usagePop.out, true);
  document.removeEventListener('keydown', usagePop.key, true);
  window.removeEventListener('resize', usagePop.resize);
  usagePop = null;
  S.usagesOpen = false;
  paintUsageChip();
}
function usagePopPlace(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  let top = r.top - h - 8;              // 优先贴在 chip 上方
  if (top < 8) top = r.bottom + 8;      // 上方不够就翻到下方
  pop.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
}
function openUsagePop(force) {
  if (usagePop) { if (force) refreshUsages(true); return; }
  const anchor = $('#navUsage');
  if (!anchor) return;
  const pop = el('div', 'usage-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '用量统计');
  const head = el('div', 'up-head');
  head.appendChild(el('span', 'up-title', '用量统计'));
  head.appendChild(el('span', 'up-sub', '正在统计…'));
  head.appendChild(el('span', 'grow'));
  const bRefresh = el('button', 'icon-btn sm');
  bRefresh.type = 'button';
  bRefresh.title = '重新统计';
  bRefresh.setAttribute('aria-label', '重新统计');
  bRefresh.appendChild(iconEl('refresh', 'sm'));
  bRefresh.onclick = () => refreshUsages(true);
  head.appendChild(bRefresh);
  const bClose = el('button', 'icon-btn sm');
  bClose.type = 'button';
  bClose.title = '收起 (Esc)';
  bClose.setAttribute('aria-label', '收起');
  bClose.appendChild(iconEl('x', 'sm'));
  bClose.onclick = () => closeUsagePop();
  head.appendChild(bClose);
  pop.appendChild(head);
  pop.appendChild(el('div', 'up-body'));
  document.body.appendChild(pop);

  const out = ev => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) closeUsagePop(); };
  const key = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();   // 别让全局 Esc 顺手把右侧面板也关掉
    closeUsagePop();
  };
  const resize = () => { if (usagePop) usagePopPlace(pop, anchor); };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', resize);
  usagePop = { el: pop, anchor: anchor, out: out, key: key, resize: resize };
  S.usagesOpen = true;
  paintUsageChip();
  paintUsagePop();
  refreshUsages(!!force);
}
function toggleUsagePop() { S.usagesOpen ? closeUsagePop() : openUsagePop(true); }
function paintUsagePop() {
  if (!usagePop) return;
  const d = S.usages;
  const sub = usagePop.el.querySelector('.up-sub');
  if (sub) sub.textContent = d ? '更新于 ' + relTime(Math.floor(d.at / 1000)) : '正在统计…';
  const body = usagePop.el.querySelector('.up-body');
  if (body) renderUsageBody(body, 12);
  usagePopPlace(usagePop.el, usagePop.anchor); // 内容高度变了，重新贴边
}
/* 正文：总览方块 + 模型占比条 + 会话明细（limit = 最多列几条会话） */
function renderUsageBody(body, limit) {
  body.replaceChildren();
  const d = S.usages;
  if (!d) { body.appendChild(el('div', 'up-empty', '正在统计用量…')); return; }
  const tot = d.totals || {};
  const tiles = el('div', 'us-tiles');
  tiles.appendChild(usTile(fmtTok(tot.total_tokens), '总 tokens', true));
  tiles.appendChild(usTile(String(tot.requests || 0), '请求'));
  tiles.appendChild(usTile(fmtTok(tot.input_tokens), '输入 tokens'));
  tiles.appendChild(usTile(fmtTok(tot.output_tokens), '输出 tokens'));
  tiles.appendChild(usTile(String(tot.messages || 0), '累计消息'));
  body.appendChild(tiles);

  if (!d.models.length && !d.sessions.length) {
    body.appendChild(el('div', 'up-empty', '还没有用量记录。跑一轮对话后，这里会按模型与会话统计 token 消耗。'));
    return;
  }

  if (d.models.length) {
    const sec = el('div', 'us-sec');
    sec.appendChild(el('span', null, '按模型'));
    sec.appendChild(el('span', 'us-sec-n', d.models.length + ' 个'));
    body.appendChild(sec);
    const maxTok = Math.max.apply(null, d.models.map(m => Number(m.total_tokens) || 0).concat([1]));
    const bars = el('div', 'us-bars');
    for (const m of d.models) {
      const row = el('div', 'us-bar-row');
      const top = el('div', 'us-bar-top');
      top.appendChild(el('span', 'us-bar-name trunc', usShortModel(m.name)));
      top.appendChild(el('span', 'us-bar-val', fmtTok(m.total_tokens)));
      row.appendChild(top);
      const track = el('div', 'us-bar-track');
      const fill = el('i');
      fill.style.width = Math.max(3, Math.round((Number(m.total_tokens) || 0) / maxTok * 100)) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'us-bar-sub',
        [m.requests + ' 请求', fmtTok(m.input_tokens) + ' 入', fmtTok(m.output_tokens) + ' 出'].join(' · ')));
      row.title = m.name;
      bars.appendChild(row);
    }
    body.appendChild(bars);
  }

  if (d.sessions.length) {
    const shown = Math.max(1, Number(limit || 40));
    const sec = el('div', 'us-sec');
    sec.appendChild(el('span', null, '按会话'));
    sec.appendChild(el('span', 'us-sec-n', d.totalSessions + ' 条'));
    body.appendChild(sec);
    const list = el('div', 'us-sess');
    for (const s of d.sessions.slice(0, shown)) {
      const known = (S.sessions || []).find(x => x.id === s.id);
      const row = el('button', 'us-srow');
      row.type = 'button';
      const main = el('span', 'us-s-main');
      main.appendChild(el('span', 'us-s-title trunc', (known && known.title) || shortId(s.id)));
      main.appendChild(el('span', 'us-s-meta trunc',
        usShortModel(s.model) + ' · ' + (s.requests || 0) + ' 请求'));
      row.appendChild(main);
      row.appendChild(el('span', 'us-s-val', fmtTok(s.total_tokens)));
      row.title = s.id + '  ·  点击切换到这个会话';
      row.onclick = () => openUsageSession(s);
      list.appendChild(row);
    }
    if (d.sessions.length > shown)
      list.appendChild(el('div', 'us-more', '另有 ' + (d.sessions.length - shown) + ' 条会话未列出'));
    body.appendChild(list);
  }
}
// 兼容旧调用点（原来的右栏「用量」标签页已经收进左侧栏，函数名保留）
function renderDockUsages(body) { renderUsageBody(body, 40); }
// 点会话行 → 切过去（后端按 cwd 索引打开所属工作区；跨工作区也可以）
function openUsageSession(s) {
  if (!s || !s.id) return;
  const ws = String(s.id).split('-')[0];
  const t = S.tabs.get(ws);
  if (t && t.session === s.id) { toast('已经在这个会话里', 'ok'); return; }
  cmd('session.select', { ws: ws, id: s.id }).then(out => {
    if (out && out.ok === false) { toast(out.error || '切换会话失败', 'bad'); return; }
    closeUsagePop(); // 切走了就收起来，别挡着新会话
    return resync().then(() => refreshSessions());
  }).catch(() => toast('切换会话失败', 'bad'));
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

/* ====================================================================
   演示模式补充数据（MOCK 守卫）
   08-mock.js 归 chat-ui2，这里不碰它；只包装 Mock.api 追加三类可验收
   状态：失败任务（完整 error + 失败子代理 + 报告）、关卡等待任务、
   以及 transcript 延迟落盘的运行中子代理（等待卡 → 对话无缝出现）。
   真实模式（?mock=0）完全不走这些分支。
   ==================================================================== */
let twMockPatched = false;
let twDemo = null;

function twDemoNoticeList() {
  const n = nowSec();
  return [
    { id: 'twdemo-f4', from: 'teamwork/tw-demo-fail/supervisor', topic: 'job', body: "job tw-demo-fail failed in stage '实现': worker impl_0 crashed: upstream returned 502 Bad Gateway", created_at: n - 80, pending: true },
    { id: 'twdemo-f3', from: 'teamwork/tw-demo-fail/impl_0', topic: 'review', body: "review approved edit on 'src/ui/src/js/03-teamwork.js': 只改状态映射与刷新", created_at: n - 120 },
    { id: 'twdemo-f2', from: 'teamwork/tw-demo-fail/impl_0', topic: 'worker', body: '开始重构事件流：先读取 runner 的轮询实现。', created_at: n - 190 },
    { id: 'twdemo-f1', from: 'teamwork/tw-demo-fail/supervisor', topic: 'stage', body: "stage 2/3 '实现' started (1 worker, serial)", created_at: n - 200 },
    { id: 'twdemo-g1', from: 'teamwork/tw-demo-gate/supervisor', topic: 'gate', body: '关卡「调研」已完成，评审通过后继续「实现」。', created_at: n - 150, pending: true },
    { id: 'twdemo-g0', from: 'teamwork/tw-demo-gate/scout_1', topic: 'worker', body: '调研完成：消息流按 role 分发，通知卡与工具卡都可复用。', created_at: n - 210 },
    { id: 'twdemo-r2', from: 'teamwork/tw-demo-run/supervisor', topic: 'stage', body: "stage 1/2 '实现' started (2 workers, parallel)", created_at: n - 35 },
    { id: 'twdemo-r1', from: 'teamwork/tw-demo-run/runner_0', topic: 'worker', body: '开始重构 runner 的轮询与错误处理，先读 03-teamwork.js。', created_at: n - 30 },
  ];
}
function twDemoJobList() {
  const n = nowSec();
  return [
    {
      id: 'tw-demo-fail', status: 'failed', work_type: 'serial', created_at: n - 60,
      provider: 'openai', model: 'deepseek-v4-flash',
      stages: [
        { name: '调研', mode: 'serial', gate: false, agents: [{ name: 'scout_0' }] },
        { name: '实现', mode: 'serial', gate: false, agents: [{ name: 'impl_0' }] },
        { name: '验证', mode: 'serial', gate: false, agents: [{ name: 'check_0' }] },
      ],
      current_stage: 1, next_stage: 2,
      error: 'worker impl_0 crashed: LLM request failed: upstream returned 502 Bad Gateway\n'
        + '阶段 2/3「实现」失败，阶段 1 的报告已保留，可修复后重试。\n'
        + '建议：检查 provider 的 base URL 与密钥，或把子代理模型换成更稳定的模型后再次运行。',
      workers: [
        { name: 'scout_0', works: '调研现有事件总线与消息流实现', report_status: 'ok', rounds: 3, tool_calls: 7, stage: '0', stage_name: '调研', has_report: true },
        { name: 'impl_0', works: '按调研结论实现事件流重构', report_status: 'failed', rounds: 1, tool_calls: 2, stage: '1', stage_name: '实现', has_report: true },
        { name: 'check_0', works: '回归验证重构结果', report_status: 'skipped', rounds: 0, tool_calls: 0, stage: '2', stage_name: '验证' },
      ],
    },
    {
      id: 'tw-demo-gate', status: 'waiting', work_type: 'serial', created_at: n - 160,
      provider: 'openai', model: 'deepseek-v4-flash',
      stages: [
        { name: '调研', mode: 'serial', gate: true, agents: [{ name: 'scout_1' }] },
        { name: '实现', mode: 'serial', gate: false, agents: [{ name: 'impl_1' }] },
      ],
      current_stage: 0, next_stage: 1,
      workers: [
        { name: 'scout_1', works: '调研现有消息流与通知卡实现', report_status: 'ok', rounds: 2, tool_calls: 4, stage: '0', stage_name: '调研', has_report: true },
        { name: 'impl_1', works: '按调研结论实现失败卡与等待提示', report_status: '', rounds: 0, tool_calls: 0, stage: '1', stage_name: '实现' },
      ],
    },
    {
      id: 'tw-demo-run', status: 'running', work_type: 'parallel', created_at: n - 260,
      provider: 'openai', model: 'deepseek-v4-flash',
      stages: [
        { name: '实现', mode: 'parallel', gate: false, agents: [{ name: 'runner_0' }, { name: 'runner_1' }] },
        { name: '验证', mode: 'serial', gate: false, agents: [{ name: 'verifier' }] },
      ],
      current_stage: 0, next_stage: 1,
      workers: [
        { name: 'runner_0', works: '重构 runner 的轮询与错误处理', report_status: '', rounds: 0, tool_calls: 0, stage: '0', stage_name: '实现' },
        { name: 'runner_1', works: '补齐 UI 状态映射与失败展示', report_status: 'running', rounds: 1, tool_calls: 2, stage: '0', stage_name: '实现' },
        { name: 'verifier', works: '回归验证改动', report_status: '', rounds: 0, tool_calls: 0, stage: '1', stage_name: '验证' },
      ],
    },
  ];
}
// transcript：tw-demo-run 首 3s 未落盘，之后给出增量；tw-demo-fail 永不落盘（失败详情走 job.error）
function twDemoWorkerDelta(job, args) {
  const name = args.worker;
  const since = Number(args.since || 0) || 0;
  const cut = all => all.slice(Math.min(since, all.length));
  if (job.id === 'tw-demo-run') {
    const elapsed = Date.now() - (twDemo ? twDemo.startedAt : 0);
    if (elapsed < 3000) return { ok: false, error: 'worker transcript not written yet' };
    const all = [
      { role: 'user', content: '请在当前工作区执行你的任务，并给出简明报告。' },
      { role: 'assistant', content: [{ type: 'text', text: '我先看一下轮询与状态映射的实现。' }, { type: 'tool_use', name: 'read_file', input: { path: 'src/ui/src/js/03-teamwork.js' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '已读取 03-teamwork.js（约 700 行）' }] },
      { role: 'assistant', content: '已确认：刷新要按 jobsAt 判断，失败卡要展示完整 job.error，等待卡要有秒表。' },
    ];
    const done = elapsed >= 16000;
    return { ok: true, status: done ? 'ok' : 'running', rounds: done ? 3 : 1, tool_calls: 4, total: all.length, messages: cut(all) };
  }
  if (job.id === 'tw-demo-gate' && name === 'scout_1') {
    const all = [
      { role: 'user', content: '请调研现有消息流实现并给出结论。' },
      { role: 'assistant', content: '调研完成：消息流按 role 分发，通知卡与工具卡都可复用；等待关卡确认后进入实现。' },
    ];
    return { ok: true, status: 'ok', rounds: 2, tool_calls: 4, total: all.length, messages: cut(all) };
  }
  return { ok: false, error: 'worker transcript not written yet' };
}
function twPatchMockDemo() {
  if (!MOCK || twMockPatched) return;
  if (typeof Mock === 'undefined' || !Mock || typeof Mock.api !== 'function') return;
  twMockPatched = true;
  const demo = twDemo = { jobs: {}, notices: twDemoNoticeList(), startedAt: Date.now() };
  for (const j of twDemoJobList()) demo.jobs[j.id] = j;
  const orig = Mock.api.bind(Mock);
  Mock.api = function (name, args) {
    args = args || {};
    const n = String(name);
    if (n === 'teamwork.list') {
      return orig(n, args).then(out => {
        if (!out || out.ok === false || !Array.isArray(out.jobs)) return out;
        const ids = new Set(out.jobs.map(j => j.id));
        const list = out.jobs.slice();
        for (const id in demo.jobs) if (!ids.has(id)) list.push(demo.jobs[id]);
        list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        return Object.assign({}, out, { jobs: list });
      });
    }
    if (n === 'teamwork.worker') {
      const j = demo.jobs[args.job];
      if (j) return Promise.resolve(twDemoWorkerDelta(j, args));
    }
    if (n === 'teamwork.report') {
      if (demo.jobs[args.job]) {
        const j = demo.jobs[args.job];
        const w = (j.workers || []).find(x => x.name === args.worker) || {};
        return Promise.resolve({ ok: true, report: '# 报告 · ' + (args.worker || '') + '\n\n演示数据。状态：' + (w.report_status || '未记录')
          + '\n轮次：' + (w.rounds == null ? '-' : w.rounds) + ' · 工具调用：' + (w.tool_calls == null ? '-' : w.tool_calls)
          + '\n\n' + (w.works || '') + '\n\n结论：按计划完成（这是 mock 报告，仅用于演示报告入口）。' });
      }
    }
    if (n === 'teamwork.run' || n === 'teamwork.resume' || n === 'teamwork.stop') {
      const j = demo.jobs[args.id];
      if (j) {
        if (n === 'teamwork.stop') {
          j.status = 'waiting';
          j.error = 'stopped by the supervisor';
          j.stopped = true;
        } else {
          j.status = 'running';
          delete j.error;
          j.stopped = false;
          j.current_stage = Math.max(0, Number(j.next_stage || 0));
          j.workers.forEach(w => { if (w.report_status === 'failed' || w.report_status === 'skipped') w.report_status = ''; });
          if (j.id === 'tw-demo-run') demo.startedAt = Date.now();
        }
        setTimeout(() => { try { Mock.emit({ t: 'teamwork_changed', ws: args.ws || S.active }); } catch (e) {} }, 20);
        return Promise.resolve({ ok: true, message: 'demo ' + n });
      }
    }
    return orig(n, args);
  };
}
