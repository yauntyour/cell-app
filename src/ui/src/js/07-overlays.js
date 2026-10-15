/* ---------- K. 弹窗 / 审批 / 提示 ---------------------------------- */
function showModal(title, text, buttons, build) {
  const host = $('#genericModal');
  const box = el('div', 'modalbox');
  const head = el('div', 'modalhead');
  head.appendChild(el('span', null, title));
  const body = el('div', 'modalbody');
  if (text) { const pre = el('pre'); pre.textContent = text; body.appendChild(pre); }
  if (build) build(body);
  const foot = el('div', 'modalfoot');
  for (const b of (buttons || [])) {
    const btn = el('button', 'btn sm ' + (b.cls || ''), b.label);
    btn.onclick = b.fn;
    foot.appendChild(btn);
  }
  if (!(buttons || []).length) {
    const c = el('button', 'btn sm', '关闭'); c.onclick = closeModal; foot.appendChild(c);
  }
  box.appendChild(head); box.appendChild(body); box.appendChild(foot);
  host.replaceChildren(box);
  host.classList.add('show');
}
function closeModal() {
  const h = $('#genericModal');
  // Esc / 关按钮走这里：把挂起的确认框当作「取消」，否则 Promise 永远悬空
  if (h._confirmDone) { const f = h._confirmDone; h._confirmDone = null; f(); }
  h.classList.remove('show');
  h.replaceChildren();
}
function modalOpen() { return $('#genericModal').classList.contains('show'); }
function searchOpen() { return $('#searchModal').classList.contains('show'); }

/* 应用内确认框（替代 window.confirm）：
   WebView2 默认禁用脚本对话框（AreDefaultScriptDialogsEnabled = false），
   confirm() 既不弹窗也不返回——它把页面主线程永久挂住（实测：调用之后
   setInterval 停走、整个 UI 冻结），桌面壳里所有确认交互都必须走这里。 */
function confirmDlg(text, opts) {
  opts = opts || {};
  const host = $('#genericModal');
  return new Promise(resolve => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      if (host._confirmDone === cancel) host._confirmDone = null;
      resolve(v);
    };
    const cancel = () => finish(false);
    host._confirmDone = cancel;
    showModal(opts.title || '请确认', text, [
      { label: opts.cancel || '取消', fn: () => { finish(false); closeModal(); } },
      { label: opts.ok || '确认', cls: 'danger', fn: () => { finish(true); closeModal(); } },
    ]);
  });
}

function renderApproval() {
  const host = $('#approvalModal');
  const t = S.tabs.get(S.active);
  if (!t || !t.approval) { host.classList.remove('show'); host.replaceChildren(); return; }
  const a = t.approval;
  const box = el('div', 'modalbox');
  const head = el('div', 'modalhead');
  head.appendChild(el('span', 'dot warn'));
  head.appendChild(el('span', null, '需要审批 · ' + a.tool));
  const body = el('div', 'modalbody');
  body.appendChild(el('div', 'small mut', '该工具调用需要你的确认：'));
  const pre = el('pre'); pre.textContent = typeof a.args === 'string' ? a.args : JSON.stringify(a.args, null, 2);
  body.appendChild(pre);
  const foot = el('div', 'modalfoot');
  const deny = el('button', 'btn sm danger', '拒绝 (Esc)');
  deny.onclick = () => approve(a, false);
  const allow = el('button', 'btn sm primary', '允许 (Enter)');
  allow.onclick = () => approve(a, true);
  foot.appendChild(deny); foot.appendChild(allow);
  box.appendChild(head); box.appendChild(body); box.appendChild(foot);
  host.replaceChildren(box);
  host.classList.add('show');
  setTimeout(() => allow.focus(), 20);
}
function approve(a, allow) {
  const t = S.tabs.get(S.active);
  cmd('approve', { ws: a.ws, id: a.id, allow: allow });
  if (t && t.approval && t.approval.id === a.id) t.approval = null;
  S.pendingApprovals = Array.from(S.tabs.values()).filter(x => x.approval).length;
  renderApproval();
  schedule('tabbar', renderTabbar);
}

function toast(msg, kind, ms) {
  const host = $('#toasts');
  if (!host) return;
  const n = el('div', 'toast ' + (kind || ''));
  n.textContent = msg;
  host.appendChild(n);
  setTimeout(() => { n.classList.add('leaving'); setTimeout(() => n.remove(), 240); }, ms || (kind === 'bad' ? 4600 : 2600));
}

/* ---------- 打开工作区 --------------------------------------------- */
// 桌面壳里 host_pick_folder 是 webview 绑定（原生文件夹选择框）；纯浏览器 /
// 演示模式没有这个绑定，「浏览…」不渲染，退回手动输入路径。
function openWsDialog() {
  showModal('打开工作区', '', [{ label: '取消', fn: closeModal }], (body) => {
    body.appendChild(el('div', 'small mut', '输入要打开的目录路径：'));
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'D:\\path\\to\\project';
    inp.onkeydown = ev => { if (ev.key === 'Enter') { const v = inp.value.trim(); if (v) { closeModal(); openWorkspace(v); } } };
    if (typeof window.host_pick_folder === 'function') {
      const brow = el('button', 'btn sm', '浏览…');
      brow.title = '在文件管理器中选择目录';
      brow.onclick = async () => {
        let r = null;
        try { r = await window.host_pick_folder(); } catch (e) { r = null; }
        if (r && r.ok && r.path) { closeModal(); openWorkspace(r.path); }
      };
      const row = el('div', 'wspath-row');
      row.appendChild(inp);
      row.appendChild(brow);
      body.appendChild(row);
    } else {
      inp.style.marginTop = '8px';
      body.appendChild(inp);
    }
    const add = el('button', 'btn primary sm', '打开');
    add.style.marginTop = '8px';
    add.onclick = () => { const v = inp.value.trim(); if (v) { closeModal(); openWorkspace(v); } };
    body.appendChild(add);
    const picks = (S.recentCwds || []).concat(S.workspaces.map(w => w.cwd)).filter((x, i, arr) => x && arr.indexOf(x) === i);
    if (picks.length) {
      body.appendChild(el('div', 'small mut', '最近 / 已打开：'));
      const list = el('div', 'picklist');
      for (const c of picks) {
        const it = el('div', 'pickitem');
        it.appendChild(el('span', 'pname', baseName(c)));
        it.appendChild(el('span', 'pcwd trunc', c));
        it.onclick = () => { closeModal(); openWorkspace(c); };
        list.appendChild(it);
      }
      body.appendChild(list);
    }
    setTimeout(() => inp.focus(), 30);
  });
}

async function openWorkspace(cwd) {
  const out = await cmd('workspace.open', { cwd: cwd });
  if (!out || out.ok === false) return;
  if (!S.recentCwds.includes(cwd)) S.recentCwds.unshift(cwd);
  S.recentCwds = S.recentCwds.slice(0, 8);
  if (!S.tabs.has(out.ws)) tab(out.ws);
  if (!S.tabOrder.includes(out.ws)) S.tabOrder.push(out.ws);
  S.active = out.ws;
  Nav.push(out.ws);
  const t = tab(out.ws);
  t.cwd = out.cwd;
  if (t.session !== out.session) { t.session = out.session; t.detailSession = ''; }
  await resync();
  refreshTeamwork(out.ws);
  loadSessionDetail(out.ws, out.session);
  toast('已打开 ' + baseName(out.cwd), 'ok');
}

/* ---------- 搜索弹窗：全会话内容检索 --------------------------------
   搜索范围：聊天记录（messages.jsonl）、压缩历史存档（saved/）、
   Teamwork 记录（teamworks.json）、通知、子代理工作流文件。        */
const S_KINDS = { chat: '聊天', archive: '存档', teamwork: '团队', notice: '通知', workflow: '工作流', other: '其他' };
const searchState = { q: '', ws: '', results: [], total: 0, sel: 0 };

function openSearch() {
  const host = $('#searchModal');
  if (host.classList.contains('show')) { const i = $('#searchInput'); if (i) i.focus(); return; }
  host.replaceChildren(buildSearchBox());
  host.classList.add('show');
  runSearch('');
}
function closeSearch() {
  const h = $('#searchModal');
  h.classList.remove('show');
  h.replaceChildren();
}
function buildSearchBox() {
  const box = el('div', 'searchbox-lg');
  const head = el('div', 'sm-head');
  head.appendChild(el('span', 'sm-ico', '🔍'));
  const inp = el('input');
  inp.type = 'text';
  inp.id = 'searchInput';
  inp.placeholder = '搜索聊天记录、历史存档、Teamwork、工作流…';
  inp.oninput = debounce(() => runSearch(inp.value), 180);
  inp.onkeydown = ev => searchKeys(ev);
  head.appendChild(inp);
  const close = el('button', 'btn ghost sm', '✕');
  close.title = '关闭 (Esc)';
  close.onclick = closeSearch;
  head.appendChild(close);
  const chips = el('div', 'sm-chips');
  chips.id = 'searchChips';
  const body = el('div', 'sm-body');
  body.id = 'searchBody';
  const foot = el('div', 'sm-foot');
  foot.id = 'searchFoot';
  foot.appendChild(el('span', null, '↑↓ 选择 · Enter 打开 · Esc 关闭'));
  foot.appendChild(el('span', 'grow'));
  const cnt = el('span');
  cnt.id = 'searchCount';
  foot.appendChild(cnt);
  box.appendChild(head);
  box.appendChild(chips);
  box.appendChild(body);
  box.appendChild(foot);
  setTimeout(() => inp.focus(), 30);
  return box;
}
async function runSearch(q) {
  searchState.q = (q || '').trim();
  searchState.sel = 0;
  if (!searchState.q) {
    // 空查询：最近会话快捷列表
    searchState.results = S.sessions.slice(0, 12).map(s => ({
      id: s.id, ws: s.ws, cwd: s.cwd, title: s.title || shortId(s.id), mtime: s.mtime, hits: [],
    }));
    searchState.total = searchState.results.length;
    paintSearch();
    return;
  }
  const body = $('#searchBody');
  if (body && !body.childElementCount) body.replaceChildren(el('div', 'dim small', '搜索中…'));
  const out = await api('sessions.search', { q: searchState.q });
  if (!out || out.ok === false) {
    if (body) body.replaceChildren(el('div', 'dim small', (out && out.error) || '搜索失败'));
    return;
  }
  searchState.results = out.results || [];
  searchState.total = out.total || 0;
  paintSearch();
}
function searchFiltered() {
  return searchState.results.filter(r => !searchState.ws || r.ws === searchState.ws);
}
function paintSearch() {
  const chips = $('#searchChips');
  if (!chips) return;
  const wsMap = new Map();
  for (const r of searchState.results) {
    const k = r.ws || '';
    if (!wsMap.has(k)) wsMap.set(k, { cwd: r.cwd, n: 0 });
    wsMap.get(k).n++;
  }
  const nodes = [];
  const all = el('button', 'sm-chip' + (searchState.ws === '' ? ' on' : ''), '全部 (' + searchState.results.length + ')');
  all.onclick = () => { searchState.ws = ''; paintSearch(); };
  nodes.push(all);
  for (const [k, v] of wsMap) {
    const c = el('button', 'sm-chip' + (searchState.ws === k ? ' on' : ''),
                 (baseName(v.cwd) || shortId(k)) + ' (' + v.n + ')');
    c.onclick = () => { searchState.ws = searchState.ws === k ? '' : k; paintSearch(); };
    nodes.push(c);
  }
  chips.replaceChildren(...nodes);
  const body = $('#searchBody');
  const items = searchFiltered();
  if (!items.length) {
    body.replaceChildren(el('div', 'dim small', searchState.q ? '没有匹配的内容' : '暂无会话'));
  } else {
    body.replaceChildren(...items.map((r, i) => buildSearchItem(r, i)));
  }
  const cnt = $('#searchCount');
  if (cnt) cnt.textContent = searchState.q ? ('找到 ' + searchState.total + ' 条结果') : (items.length + ' 个会话');
}
function buildSearchItem(r, i) {
  const it = el('div', 'sm-item' + (i === searchState.sel ? ' sel' : ''));
  const title = el('div', 'sm-title');
  title.innerHTML = markText(r.title || shortId(r.id), searchState.q);
  it.appendChild(title);
  const meta = el('div', 'sm-meta');
  meta.appendChild(el('span', 'mono', shortId(r.id)));
  meta.appendChild(el('span', null, baseName(r.cwd) || shortId(r.ws)));
  meta.appendChild(el('span', null, relTime(r.mtime)));
  it.appendChild(meta);
  for (const h of (r.hits || []).slice(0, 3)) {
    const row = el('div', 'sm-hit');
    row.appendChild(el('span', 'sm-kind', S_KINDS[h.kind] || h.kind));
    const snip = el('span', 'sm-snip');
    snip.innerHTML = markText(h.text || '', searchState.q);
    row.appendChild(snip);
    it.appendChild(row);
  }
  if (r.more > 0) it.appendChild(el('div', 'tiny dim', '还有 ' + r.more + ' 条匹配…'));
  it.title = (r.title || r.id) + '\n' + (r.cwd || '');
  it.onclick = () => openSearchResult(r);
  it.onmouseenter = () => {
    searchState.sel = i;
    $$('#searchBody .sm-item').forEach((n, k) => n.classList.toggle('sel', k === i));
  };
  return it;
}
// 命中高亮：按查询拆分后逐段转义，保证 <mark> 内的内容也安全
function markText(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return esc(t);
  const qe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.split(new RegExp('(' + qe + ')', 'gi'))
    .map((seg, i) => (i % 2 === 1 ? '<mark>' + esc(seg) + '</mark>' : esc(seg))).join('');
}
function searchKeys(ev) {
  const items = $$('#searchBody .sm-item');
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    searchState.sel = Math.min(searchState.sel + 1, items.length - 1);
    paintSearchSel();
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    searchState.sel = Math.max(searchState.sel - 1, 0);
    paintSearchSel();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const r = searchFiltered()[searchState.sel];
    if (r) openSearchResult(r);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeSearch();
  }
}
function paintSearchSel() {
  const items = $$('#searchBody .sm-item');
  items.forEach((n, i) => n.classList.toggle('sel', i === searchState.sel));
  const sel = items[searchState.sel];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
async function openSearchResult(r) {
  closeSearch();
  if (!r || !r.id) return;
  await selectSession({ ws: r.ws, id: r.id, title: r.title });
}
