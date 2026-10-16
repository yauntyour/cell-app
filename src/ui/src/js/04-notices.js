/* ---------- H. 通知流 ---------------------------------------------- */
function renderDockNotices(body, t) {
  // 与 Teamwork 面板同套路：内容以磁盘为准，没加载过就先拉一次再渲染
  // （切会话会清空 noticesLoaded，打开面板即与服务端对齐）
  if (!t.noticesLoaded) {
    t.noticesLoaded = true;
    refreshNotices(t.ws);
  }
  const head = el('div', 'row gap8');
  head.style.marginBottom = '10px';
  head.appendChild(el('span', 'small mut', t.notices.length + ' 条通知'));
  head.appendChild(el('span', 'grow'));
  const rf = el('button', 'btn ghost sm', '刷新');
  rf.onclick = () => refreshNotices(S.active);
  head.appendChild(rf);
  const cl = el('button', 'btn ghost sm', '清空');
  cl.title = '清空当前会话的通知记录（待投递丢弃；已投递审计轨归档到 saved/ 后清空）';
  cl.onclick = () => clearNotices(t);
  head.appendChild(cl);
  body.replaceChildren(head, noticeSendForm(t));
  if (!t.notices.length) {
    const e = el('div', 'dim small');
    e.style.padding = '14px 4px';
    e.textContent = '暂无通知。团队协作运行时的进度、关卡与评审会出现在这里。';
    body.appendChild(e);
    return;
  }
  const stream = el('div', 'nstream');
  for (const g of t.noticeGroups) stream.appendChild(renderNoticeGroup(t, g));
  body.appendChild(stream);
}

// 跨会话发送通知：目标句柄由后端解析（id / 唯一前缀 / 16-hex 工作区 key /
// 工作区路径 / reply），留空 = 当前会话。发送方记为当前会话，对方可用 reply
// 直接回话；对方空闲时也能实时看到（后端 watcher ~0.7s 播报）
function noticeSendForm(t) {
  const form = el('div', 'ncard');
  form.style.marginBottom = '10px';
  const r1 = el('div', 'nfield');
  r1.style.borderTop = 'none';
  const tgt = el('input');
  tgt.type = 'text';
  tgt.placeholder = '发送通知 → 目标会话（id / 前缀 / 工作区路径 / reply；留空 = 当前）';
  r1.appendChild(tgt);
  const r2 = el('div', 'nfield');
  const bod = el('input');
  bod.type = 'text';
  bod.placeholder = '通知内容（Enter 发送）';
  r2.appendChild(bod);
  const go = el('button', 'btn sm', '发送');
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
  refreshNotices(t.ws); // 目标=当前会话时，自己的队列里也会出现这条
}

function shortSession(id) { return !id ? '当前会话' : (id.length > 12 ? id.slice(0, 12) + '…' : id); }

// 清空通知记录（对齐 CLI 的 /notices clear + /notices seen clear 机制：
// notice.clear 后端命令把待投递的丢弃、审计轨归档到 saved/ 后清空）
async function clearNotices(t) {
  if (!(await confirmDlg('清空当前会话的通知记录？\n待投递通知将被丢弃，已投递的审计轨会归档到 saved/ 后清空。',
                         { title: '清空通知', ok: '清空' }))) return;
  const out = await cmd('notice.clear', { ws: t.ws });
  if (out && out.ok === false) return;
  t.notices = [];
  rebuildNoticeGroups(t);
  schedule('dock', renderDock);
  refreshNotices(t.ws); // 与服务端对齐（归档失败等边角情况以服务端为准）
  toast('通知已清空', 'ok');
}

function renderNoticeGroup(t, g) {
  const card = el('div', 'ncard' + (g.pinned ? ' pinned' : ''));
  const hd = el('div', 'nhead');
  hd.appendChild(el('span', 'dot ' + (g.pinned ? 'warn' : 'run')));
  hd.appendChild(el('span', 'nfrom trunc', g.from || '?'));
  const last = g.items[g.items.length - 1];
  if (last && last.session) {
    const s = el('span', 'tiny dim', '→ ' + shortSession(last.session));
    s.title = '发送方会话：' + last.session + '（可用下方输入直接回复）';
    hd.appendChild(s);
  }
  if (g.topic) hd.appendChild(el('span', 'ntopic ' + g.topic, TOPIC_ZH[g.topic] || g.topic));
  hd.appendChild(el('span', 'grow'));
  hd.appendChild(el('span', 'tiny dim', relTime(g.newest)));
  if (g.pinned) hd.appendChild(iconEl('mark', 'sm'));
  if (g.items.length > 1) hd.appendChild(el('span', 'ncount', String(g.items.length)));
  card.appendChild(hd);

  const bd = el('div', 'nbody');
  bd.innerHTML = highlightBody(last.body);
  card.appendChild(bd);

  if (g.items.length > 1) {
    let expanded = !!g._expanded;
    const stack = el('div', 'nstack');
    stack.style.display = expanded ? '' : 'none';
    for (let i = 0; i < g.items.length - 1; i++) {
      const it = g.items[i];
      const sub = el('div', 'ncard');
      sub.style.border = 'none';
      sub.style.background = 'var(--bg2)';
      const sh = el('div', 'nhead');
      sh.appendChild(el('span', 'tiny dim', relTime(it.created_at)));
      const sp = el('span', 'grow'); sh.appendChild(sp);
      sub.appendChild(sh);
      const sb = el('div', 'nbody'); sb.innerHTML = highlightBody(it.body);
      sub.appendChild(sb);
      stack.appendChild(sub);
    }
    hd.classList.add('grouphd');
    hd.style.cursor = 'pointer';
    hd.onclick = () => { expanded = !expanded; g._expanded = expanded; stack.style.display = expanded ? '' : 'none'; };
    card.appendChild(stack);
  }
  if (g.pinned) {
    const id = twIdOf(g.items.map(x => x.body).join(' '));
    if (id) card.appendChild(noticeActions(t, id));
  }
  if (last && last.session && last.session !== t.session)
    card.appendChild(noticeReplyRow(t, last.session));
  return card;
}

// 回复该通知的发送方：走 notice 总线，直接答到对方会话（对方可能是另一个
// 工作区、另一个进程或 CLI 里的会话），不需要知道完整 id
function noticeReplyRow(t, sid) {
  const f = el('div', 'nfield');
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
  const f = el('div', 'nfield');
  if (id) {
    const resume = el('button', 'btn sm primary', '恢复 ' + id);
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
  h = h.replace(/'([^']{2,})'/g, '<span class="pathv">\'$1\'</span>');
  h = h.replace(/(tw-[A-Za-z0-9\-_]+)/g, '<span class="pathv">$1</span>');
  return h;
}
