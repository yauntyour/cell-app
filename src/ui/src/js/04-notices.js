/* ---------- H. 通知流（右侧 dock 面板） -----------------------------
   内容以磁盘为准（noticesLoaded / refreshNotices 与服务端对齐）；同源同
   topic / 路径特征的通知合并成一组，关卡与任务类置顶。样式见
   06b-sidepanels.css（.ncard / .nhead / .nbody / .ncompose …）。         */
function renderDockNotices(body, t) {
  if (!t.noticesLoaded) {
    t.noticesLoaded = true;
    refreshNotices(t.ws);
  }
  const pinned = (t.noticeGroups || []).filter(g => g.pinned).length;
  const sub = t.notices.length + ' 条' + (pinned ? ' · ' + pinned + ' 组待处理' : '');
  body.replaceChildren(pnlHead('通知', sub, [
    { icon: 'refresh', title: '刷新通知', on: () => refreshNotices(S.active) },
    {
      icon: 'trash', title: '清空当前会话的通知记录',
      on: () => clearNotices(t),
    },
  ]));
  const inner = el('div', 'pnl-scroll notice-panel');
  inner.appendChild(noticeSendForm(t));
  if (!t.notices.length) {
    inner.appendChild(pnlEmpty('暂无通知。团队协作运行时的进度、关卡与评审会出现在这里。', 'bell'));
    body.appendChild(inner);
    return;
  }
  for (const g of t.noticeGroups) inner.appendChild(renderNoticeGroup(t, g));
  body.appendChild(inner);
}

/* 跨会话发送通知：目标句柄由后端解析（id / 唯一前缀 / 16-hex 工作区 key /
   工作区路径 / reply），留空 = 当前会话。发送方记为当前会话，对方可用 reply
   直接回话；对方空闲时也能实时看到（后端 watcher ~0.7s 播报）。 */
function noticeSendForm(t) {
  const form = el('div', 'ncompose');
  const r1 = el('div', 'ncompose-row');
  const tgt = el('input');
  tgt.type = 'text';
  tgt.placeholder = '目标会话（id / 前缀 / 路径 / reply；留空 = 当前）';
  r1.appendChild(tgt);
  const r2 = el('div', 'ncompose-row');
  const bod = el('input');
  bod.type = 'text';
  bod.placeholder = '通知内容（Enter 发送）';
  r2.appendChild(bod);
  const go = el('button', 'btn sm accent', '发送');
  const fire = () => sendNoticeDialog(t, tgt.value.trim(), bod);
  go.onclick = fire;
  bod.onkeydown = ev => { if (ev.key === 'Enter') fire(); };
  r2.appendChild(go);
  form.appendChild(r1);
  form.appendChild(r2);
  return form;
}
async function sendNoticeDialog(t, target, bodEl) {
  const body = bodEl.value.trim();
  if (!body) return;
  const out = await cmd('notice.send', { ws: t.ws, session: target, body, from: 'user' });
  if (out && out.ok === false) return;
  bodEl.value = '';
  toast('通知已发送 → ' + shortSession(out && out.target), 'ok');
  refreshNotices(t.ws);
}
function shortSession(id) { return !id ? '当前会话' : (id.length > 12 ? id.slice(0, 12) + '…' : id); }

// 清空通知记录（pending 丢弃；审计轨归档到 saved/ 后清空）
async function clearNotices(t) {
  if (!(await confirmDlg('清空当前会话的通知记录？\n待投递通知将被丢弃，已投递的审计轨会归档到 saved/ 后清空。',
                         { title: '清空通知', ok: '清空' }))) return;
  const out = await cmd('notice.clear', { ws: t.ws });
  if (out && out.ok === false) return;
  t.notices = [];
  rebuildNoticeGroups(t);
  schedule('dock', renderDock);
  refreshNotices(t.ws);
  toast('通知已清空', 'ok');
}

function renderNoticeGroup(t, g) {
  const last = g.items[g.items.length - 1] || {};
  const card = el('div', 'ncard' + (g.pinned ? ' pinned' : '') + (g.items.length > 1 ? ' grouped' : ''));
  const hd = el('div', 'nhead');
  hd.appendChild(el('span', 'dot ' + (g.pinned ? 'warn' : 'run')));
  const nf = el('span', 'nfrom trunc', g.from || '?');
  nf.title = g.from || '';
  hd.appendChild(nf);
  if (last.session) {
    const s = el('span', 'nsess mono', '→ ' + shortSession(last.session));
    s.title = '发送方会话：' + last.session + '（可用下方输入直接回复）';
    hd.appendChild(s);
  }
  if (g.topic) hd.appendChild(el('span', 'ntopic ' + g.topic, TOPIC_ZH[g.topic] || g.topic));
  hd.appendChild(el('span', 'grow'));
  hd.appendChild(el('span', 'ntime', relTime(g.newest)));
  if (g.items.length > 1) hd.appendChild(el('span', 'ncount', String(g.items.length)));
  if (g.pinned) {
    const mk = el('span', 'npin');
    mk.appendChild(iconEl('mark', 'sm'));
    hd.appendChild(mk);
  }
  card.appendChild(hd);

  const bd = el('div', 'nbody');
  bd.innerHTML = highlightBody(last.body);
  card.appendChild(bd);

  if (g.items.length > 1) {
    let expanded = !!g._expanded;
    const stack = el('div', 'nstack');
    stack.hidden = !expanded;
    for (let i = 0; i < g.items.length - 1; i++) {
      const it = g.items[i];
      const sub = el('div', 'nsub');
      const sh = el('div', 'nsub-head');
      sh.appendChild(el('span', 'ntime', relTime(it.created_at)));
      sh.appendChild(el('span', 'grow'));
      sub.appendChild(sh);
      const sb = el('div', 'nbody small');
      sb.innerHTML = highlightBody(it.body);
      sub.appendChild(sb);
      stack.appendChild(sub);
    }
    hd.classList.add('grouphd');
    hd.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const fold = el('span', 'nfold');
    fold.appendChild(iconEl('chevronRight', 'sm'));
    hd.insertBefore(fold, hd.firstChild);
    hd.onclick = () => {
      expanded = !expanded;
      g._expanded = expanded;
      stack.hidden = !expanded;
      hd.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      fold.classList.toggle('open', expanded);
    };
    card.appendChild(stack);
  }
  if (g.pinned) {
    const id = twIdOf(g.items.map(x => x.body).join(' '));
    if (id) card.appendChild(noticeActions(t, id));
  }
  if (last.session && last.session !== t.session)
    card.appendChild(noticeReplyRow(t, last.session));
  return card;
}

// 回复该通知的发送方：走 notice 总线，直接答到对方会话
function noticeReplyRow(t, sid) {
  const f = el('div', 'nreply');
  const inp = el('input');
  inp.type = 'text';
  inp.placeholder = '回复会话 ' + shortSession(sid) + '（Enter 发送通知）';
  inp.onkeydown = ev => {
    if (ev.key !== 'Enter') return;
    const body = inp.value.trim();
    if (!body) return;
    cmd('notice.send', { ws: t.ws, session: sid, body, from: 'user' }).then(out => {
      if (out && out.ok === false) return;
      inp.value = '';
      toast('已回复会话 ' + shortSession(sid), 'ok');
    });
  };
  f.appendChild(inp);
  return f;
}
function noticeActions(t, id) {
  const f = el('div', 'nacts');
  if (id) {
    const resume = el('button', 'btn sm', '恢复 ' + id);
    resume.onclick = () => cmd('teamwork.resume', { ws: t.ws, id: id }).then(() => setTimeout(() => refreshTeamwork(t.ws), 400));
    f.appendChild(resume);
  }
  const inp = el('input');
  inp.type = 'text'; inp.placeholder = '回复该通知（作为消息发送）';
  inp.onkeydown = ev => {
    if (ev.key === 'Enter' && inp.value.trim()) {
      cmd('send', { ws: t.ws, text: inp.value.trim() });
      toast('已回复通知', 'ok');
      inp.value = '';
    }
  };
  f.appendChild(inp);
  return f;
}

function highlightBody(body) {
  let h = esc(body || '');
  h = h.replace(/&#39;([^&]{2,})&#39;/g, '<span class="pathv">&#39;$1&#39;</span>');
  h = h.replace(/(tw-[A-Za-z0-9\-_]+)/g, '<span class="pathv">$1</span>');
  return h;
}
