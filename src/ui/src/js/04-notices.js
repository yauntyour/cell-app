/* ---------- H. 通知流 ---------------------------------------------- */
function renderDockNotices(body, t) {
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
  body.replaceChildren(head);
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
  if (g.topic) hd.appendChild(el('span', 'ntopic ' + g.topic, TOPIC_ZH[g.topic] || g.topic));
  hd.appendChild(el('span', 'grow'));
  hd.appendChild(el('span', 'tiny dim', relTime(g.newest)));
  if (g.pinned) hd.appendChild(el('span', 'tiny', '📌'));
  if (g.items.length > 1) hd.appendChild(el('span', 'ncount', String(g.items.length)));
  card.appendChild(hd);

  const last = g.items[g.items.length - 1];
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
  return card;
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
