/* ---------- K. 弹窗 / 审批 / 提示 / 搜索 ---------------------------
   浮层宿主（#genericModal / #approvalModal / #searchModal / #toasts /
   #ctxmenu）的定位与显隐由 04-layout.css 提供；本文件负责完整 DOM 与样式类。
   保留全部旧全局函数名与签名。                                          */

/* ---- 小工具 -------------------------------------------------------- */
function ovIcon(name, cls, fallback) {
  if (typeof ICON_PATHS !== 'undefined' && ICON_PATHS[name]) return iconEl(name, cls);
  if (fallback && typeof ICON_PATHS !== 'undefined' && ICON_PATHS[fallback]) return iconEl(fallback, cls);
  return null;
}
function ovKbd(text) { return el('span', 'kbd', text); }
function ovIconBtn(icon, title, fn, cls) {
  const b = el('button', 'icon-btn ' + (cls || ''));
  b.type = 'button';
  b.title = title || '';
  b.setAttribute('aria-label', title || icon);
  const ic = ovIcon(icon);
  if (ic) b.appendChild(ic);
  b.onclick = fn;
  return b;
}
// 通用按钮：保持旧调用里的 cls（'' / 'primary' / 'danger' / 'accent' / 'ghost'）
function ovBtn(label, cls, fn) {
  const b = el('button', 'btn ' + (cls || ''), label);
  b.type = 'button';
  b.onclick = fn;
  return b;
}

/* ---- 通用弹窗 ------------------------------------------------------ */
function showModal(title, text, buttons, build) {
  const host = $('#genericModal');
  if (!host) return;
  host.replaceChildren();
  const box = el('div', 'modalbox');
  const head = el('div', 'modalhead');
  const ttl = el('div', 'modal-title');
  ttl.appendChild(el('span', 'modal-title-text', title));
  head.appendChild(ttl);
  head.appendChild(ovIconBtn('x', '关闭 (Esc)', closeModal, 'modal-x'));
  const body = el('div', 'modalbody');
  if (text) { const pre = el('pre', 'modal-pre'); pre.textContent = text; body.appendChild(pre); }
  if (build) build(body);
  const foot = el('div', 'modalfoot');
  const list = (buttons && buttons.length) ? buttons : [{ label: '关闭', fn: closeModal }];
  for (const b of list) {
    const btn = ovBtn(b.label, b.cls, b.fn);
    if (b.id) btn.id = b.id;
    foot.appendChild(btn);
  }
  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(foot);
  host.replaceChildren(box);
  host.classList.add('show');
  host.onclick = ev => { if (ev.target === host) closeModal(); };
  requestAnimationFrame(() => {
    const first = body.querySelector('input:not([type=hidden]),textarea,select');
    if (first) first.focus();
  });
}
function closeModal() {
  const h = $('#genericModal');
  if (!h) return;
  // Esc / 关闭按钮走这里：把挂起的确认框当作「取消」，否则 Promise 永远悬空
  if (h._confirmDone) { const f = h._confirmDone; h._confirmDone = null; try { f(); } catch (e) { /* ignore */ } }
  h.classList.remove('show');
  h.replaceChildren();
  h.onclick = null;
}
function modalOpen() { const h = $('#genericModal'); return !!(h && h.classList.contains('show')); }
function searchOpen() { const h = $('#searchModal'); return !!(h && h.classList.contains('show')); }

/* 应用内确认框（替代 window.confirm）：
   WebView2 默认禁用脚本对话框（AreDefaultScriptDialogsEnabled = false），
   confirm() 既不弹窗也不返回——它把页面主线程永久挂住（实测：调用之后
   setInterval 停走、整个 UI 冻结），桌面壳里所有确认交互都必须走这里。 */
function confirmDlg(text, opts) {
  opts = opts || {};
  const host = $('#genericModal');
  return new Promise(resolve => {
    if (!host) { resolve(false); return; }
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
      { label: opts.cancel || '取消', cls: 'ghost', fn: () => { finish(false); closeModal(); } },
      { label: opts.ok || '确认', cls: 'danger', fn: () => { finish(true); closeModal(); } },
    ]);
    // 确认类弹窗没有输入框：把焦点给「确认」，Enter 即可确认（Esc 走取消）
    requestAnimationFrame(() => {
      const btn = host.querySelector('.modalfoot .btn.danger');
      if (btn) btn.focus();
    });
  });
}

/* ---- 审批弹窗 ------------------------------------------------------ */
function renderApproval() {
  const host = $('#approvalModal');
  if (!host) return;
  const t = (typeof S !== 'undefined' && S.tabs && S.active) ? S.tabs.get(S.active) : null;
  if (!t || !t.approval) { host.classList.remove('show'); host.replaceChildren(); return; }
  const a = t.approval;
  const argsText = typeof a.args === 'string' ? a.args : JSON.stringify(a.args, null, 2);
  const box = el('div', 'modalbox approval');

  const head = el('div', 'modalhead');
  const ico = el('span', 'ap-ico');
  const ai = ovIcon('alert', 'lg');
  if (ai) ico.appendChild(ai);
  head.appendChild(ico);
  const ttl = el('div', 'modal-title');
  ttl.appendChild(el('span', 'modal-title-text', '需要审批'));
  ttl.appendChild(el('span', 'modal-sub', '工具调用需要你的确认后才会执行'));
  head.appendChild(ttl);
  const toolTag = el('span', 'ap-tool mono', a.tool || 'tool');
  toolTag.title = a.tool || '';
  head.appendChild(toolTag);
  box.appendChild(head);

  const body = el('div', 'modalbody approval-body');
  const call = el('div', 'ap-call');
  const callHead = el('div', 'ap-call-head');
  callHead.appendChild(el('span', null, '工具'));
  callHead.appendChild(el('span', 'ap-call-name mono', a.tool || 'tool'));
  callHead.appendChild(el('span', 'grow'));
  callHead.appendChild(el('span', 'ap-call-dot'));
  call.appendChild(callHead);
  const pre = el('pre', 'ap-args');
  pre.textContent = argsText || '（无参数）';
  call.appendChild(pre);
  body.appendChild(call);
  body.appendChild(el('div', 'ap-note', '允许后该工具将按当前沙箱策略执行；拒绝则跳过本次调用，回合继续。'));
  box.appendChild(body);

  const foot = el('div', 'modalfoot ap-foot');
  const hints = el('div', 'ap-hints');
  hints.appendChild(ovKbd('Esc'));
  hints.appendChild(el('span', null, '拒绝'));
  hints.appendChild(ovKbd('Enter'));
  hints.appendChild(el('span', null, '允许'));
  foot.appendChild(hints);
  const deny = ovBtn('拒绝', 'danger', () => approve(a, false));
  const allow = ovBtn('允许', 'accent', () => approve(a, true));
  foot.appendChild(deny);
  foot.appendChild(allow);
  box.appendChild(foot);

  host.replaceChildren(box);
  host.classList.add('show');
  bindApprovalKeys();
  setTimeout(() => allow.focus(), 20);
}
// 审批弹窗的 Enter = 允许（Esc = 拒绝由外壳 onGlobalKey 处理）。外壳新版的
// 全局键处理只保留 Esc，这里补上 Enter，并保证焦点不在其它弹窗里时才生效。
let approvalKeysBound = false;
function bindApprovalKeys() {
  if (approvalKeysBound) return;
  approvalKeysBound = true;
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const h = $('#approvalModal');
    if (!h || !h.classList.contains('show')) return;
    if (modalOpen() || searchOpen()) return;
    const t = S.tabs.get(S.active);
    if (!t || !t.approval) return;
    ev.preventDefault();
    approve(t.approval, true);
  });
}
function approve(a, allow) {
  const t = S.tabs.get(S.active);
  cmd('approve', { ws: a.ws, id: a.id, allow: allow });
  if (t && t.approval && t.approval.id === a.id) t.approval = null;
  S.pendingApprovals = Array.from(S.tabs.values()).filter(x => x.approval).length;
  renderApproval();
  if (typeof schedule === 'function' && typeof renderTabbar === 'function') schedule('tabbar', renderTabbar);
}

/* ---- Toast --------------------------------------------------------- */
const TOAST_ICONS = { ok: 'checkCircle', bad: 'xCircle', warn: 'alert', info: 'info' };
function toast(msg, kind, ms) {
  const host = $('#toasts');
  if (!host) return;
  const k = kind || '';
  const n = el('div', 'toast ' + (k || 'info'));
  n.setAttribute('role', 'status');
  const ic = ovIcon(TOAST_ICONS[k] || 'info', 'toast-ico');
  if (ic) n.appendChild(ic);
  n.appendChild(el('span', 'toast-msg', msg));
  const x = el('button', 'toast-x');
  x.type = 'button';
  x.title = '关闭';
  const xi = ovIcon('x', 'sm');
  if (xi) x.appendChild(xi);
  n.appendChild(x);
  host.appendChild(n);
  while (host.childElementCount > 4) host.firstElementChild.remove();
  const life = ms || (k === 'bad' ? 4600 : k === 'warn' ? 3600 : 2600);
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    n.classList.add('leaving');
    setTimeout(() => n.remove(), 240);
  };
  const timer = setTimeout(hide, life);
  x.onclick = ev => { ev.stopPropagation(); hide(); };
  n.onclick = hide;
}

/* ---- 打开工作区 ----------------------------------------------------
   桌面壳里 host_pick_folder 是 webview 绑定（原生文件夹选择框）；纯浏览器 /
   演示模式没有这个绑定，「浏览…」不渲染，退回手动输入路径。              */
function openWsDialog() {
  // 路径输入 / 最近列表在主区，主操作「打开」放页脚（与「取消」并列）
  let submit = null;
  showModal('打开工作区', '', [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: '打开', cls: 'accent', fn: () => { if (submit) submit(); else closeModal(); } },
  ], (body) => {
    body.appendChild(el('div', 'modal-desc', '输入要打开的目录路径，或在「最近 / 已打开」里选择一个。'));
    const inp = el('input', 'ws-input');
    inp.type = 'text';
    inp.placeholder = 'D:\\path\\to\\project';
    const openIt = () => {
      const v = inp.value.trim();
      if (!v) { toast('请输入目录路径', 'bad'); return; }
      closeModal();
      openWorkspace(v);
    };
    submit = openIt;
    inp.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); openIt(); } };
    const row = el('div', 'ws-inputrow');
    row.appendChild(inp);
    if (typeof window.host_pick_folder === 'function') {
      const brow = ovBtn('浏览…', '', async () => {
        let r = null;
        try { r = await window.host_pick_folder(); } catch (e) { r = null; }
        if (r && r.ok && r.path) { closeModal(); openWorkspace(r.path); }
      });
      brow.title = '在文件管理器中选择目录';
      row.appendChild(brow);
    }
    body.appendChild(row);

    const picks = (S.recentCwds || []).concat((S.workspaces || []).map(w => w.cwd))
      .filter((x, i, arr) => x && arr.indexOf(x) === i);
    if (picks.length) {
      body.appendChild(el('div', 'ws-sec-title', '最近 / 已打开'));
      const list = el('div', 'ws-picks');
      for (const c of picks) {
        const it = el('div', 'ws-pick');
        const ic = ovIcon('folder', 'ws-pick-ico');
        if (ic) it.appendChild(ic);
        const col = el('div', 'ws-pick-info');
        col.appendChild(el('div', 'ws-name', baseName(c)));
        col.appendChild(el('div', 'ws-path mono trunc', c));
        it.appendChild(col);
        const chev = ovIcon('chevronRight', 'ws-pick-chev');
        if (chev) it.appendChild(chev);
        it.title = c;
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
  if (typeof Nav !== 'undefined' && Nav.push) Nav.push(out.ws);
  const t = tab(out.ws);
  t.cwd = out.cwd;
  if (t.session !== out.session) { t.session = out.session; t.detailSession = ''; }
  await resync();
  if (typeof refreshTeamwork === 'function') refreshTeamwork(out.ws);
  if (typeof loadSessionDetail === 'function') loadSessionDetail(out.ws, out.session);
  toast('已打开 ' + baseName(out.cwd), 'ok');
}

/* ---- 搜索弹窗：全会话内容检索 --------------------------------------
   搜索范围：聊天记录（messages.jsonl）、压缩历史存档（saved/）、
   Teamwork 记录（teamworks.json）、通知、子代理工作流文件。            */
const S_KINDS = { chat: '聊天', archive: '存档', teamwork: '团队', notice: '通知', workflow: '工作流', other: '其他' };
const searchState = { q: '', ws: '', results: [], total: 0, sel: 0 };

function openSearch() {
  const host = $('#searchModal');
  if (!host) return;
  if (host.classList.contains('show')) { const i = $('#searchInput'); if (i) i.focus(); return; }
  host.replaceChildren(buildSearchBox());
  host.classList.add('show');
  host.onclick = ev => { if (ev.target === host) closeSearch(); };
  runSearch('');
}
function closeSearch() {
  const h = $('#searchModal');
  if (!h) return;
  h.classList.remove('show');
  h.replaceChildren();
  h.onclick = null;
}
function buildSearchBox() {
  const box = el('div', 'searchbox-lg');
  const head = el('div', 'sm-head');
  const si = el('span', 'sm-ico');
  const sic = ovIcon('search', 'lg');
  if (sic) si.appendChild(sic);
  head.appendChild(si);
  const inp = el('input');
  inp.type = 'text';
  inp.id = 'searchInput';
  inp.placeholder = '搜索聊天记录、历史存档、Teamwork、工作流…';
  inp.spellcheck = false;
  inp.oninput = debounce(() => runSearch(inp.value), 180);
  inp.onkeydown = ev => searchKeys(ev);
  head.appendChild(inp);
  head.appendChild(ovKbd('Esc'));
  head.appendChild(ovIconBtn('x', '关闭搜索', closeSearch, 'sm-x'));
  const chips = el('div', 'sm-chips');
  chips.id = 'searchChips';
  const body = el('div', 'sm-body');
  body.id = 'searchBody';
  const foot = el('div', 'sm-foot');
  foot.id = 'searchFoot';
  const hints = el('span', 'sm-hints');
  hints.appendChild(ovKbd('↑'));
  hints.appendChild(ovKbd('↓'));
  hints.appendChild(el('span', null, '选择'));
  hints.appendChild(ovKbd('Enter'));
  hints.appendChild(el('span', null, '打开'));
  hints.appendChild(ovKbd('Esc'));
  hints.appendChild(el('span', null, '关闭'));
  foot.appendChild(hints);
  foot.appendChild(el('span', 'grow'));
  const cnt = el('span', 'sm-count');
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
    searchState.results = (S.sessions || []).slice(0, 12).map(s => ({
      id: s.id, ws: s.ws, cwd: s.cwd, title: s.title || shortId(s.id), mtime: s.mtime, hits: [],
    }));
    searchState.total = searchState.results.length;
    paintSearch();
    return;
  }
  const body = $('#searchBody');
  if (body && !body.childElementCount) {
    const loading = el('div', 'sm-loading');
    loading.appendChild(el('span', 'spin'));
    loading.appendChild(el('span', null, '搜索中…'));
    body.replaceChildren(loading);
  }
  const out = await api('sessions.search', { q: searchState.q });
  if (!out || out.ok === false) {
    if (body) {
      const err = el('div', 'sm-empty');
      const ei = ovIcon('alert', 'lg');
      if (ei) err.appendChild(ei);
      err.appendChild(el('div', null, (out && out.error) || '搜索失败'));
      body.replaceChildren(err);
    }
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
  all.type = 'button';
  all.onclick = () => { searchState.ws = ''; searchState.sel = 0; paintSearch(); };
  nodes.push(all);
  for (const [k, v] of wsMap) {
    const c = el('button', 'sm-chip' + (searchState.ws === k ? ' on' : ''));
    c.type = 'button';
    c.appendChild(el('span', 'sm-chip-name', baseName(v.cwd) || shortId(k)));
    c.appendChild(el('span', 'sm-chip-n', String(v.n)));
    c.title = v.cwd || k;
    c.onclick = () => { searchState.ws = searchState.ws === k ? '' : k; searchState.sel = 0; paintSearch(); };
    nodes.push(c);
  }
  chips.replaceChildren(...nodes);

  const body = $('#searchBody');
  if (!body) return;
  const items = searchFiltered();
  const out = [];
  if (!items.length) {
    const empty = el('div', 'sm-empty');
    const ei = ovIcon(searchState.q ? 'search' : 'message', 'lg');
    if (ei) empty.appendChild(ei);
    empty.appendChild(el('div', 'sm-empty-title', searchState.q ? '没有匹配的内容' : '暂无会话'));
    empty.appendChild(el('div', 'sm-empty-sub', searchState.q ? '换个关键词试试，或清空工作区筛选。' : '开始一次对话后，这里会列出最近的会话。'));
    out.push(empty);
  } else if (!searchState.q) {
    // 无查询：最近会话列表（分组头 = 最近会话）
    out.push(el('div', 'sm-grouphead sm-grouphead-first', '最近会话'));
    items.forEach((r, i) => out.push(buildSearchItem(r, i)));
  } else {
    // 有查询：按工作区分组，组头显示目录与结果数
    let lastWs = null;
    items.forEach((r, i) => {
      const key = r.ws || '';
      if (key !== lastWs) {
        lastWs = key;
        const gh = el('div', 'sm-grouphead');
        const gi = ovIcon('folder', 'sm-group-ico');
        if (gi) gh.appendChild(gi);
        gh.appendChild(el('span', 'sm-groupname', baseName(r.cwd) || shortId(key)));
        let n = 0;
        for (const x of items) if ((x.ws || '') === key) n++;
        gh.appendChild(el('span', 'sm-groupcount', n + ' 条'));
        out.push(gh);
      }
      out.push(buildSearchItem(r, i));
    });
  }
  // 一次性替换：不能边查边 append，否则上一次「最近会话」列表会残留下来
  body.replaceChildren(...out);
  const cnt = $('#searchCount');
  if (cnt) {
    cnt.textContent = searchState.q
      ? ('找到 ' + searchState.total + ' 条结果')
      : (items.length + ' 个会话');
  }
}
function buildSearchItem(r, i) {
  const it = el('div', 'sm-item' + (i === searchState.sel ? ' sel' : ''));
  it.dataset.i = String(i);
  const title = el('div', 'sm-title');
  title.innerHTML = markText(r.title || shortId(r.id), searchState.q);
  it.appendChild(title);
  const meta = el('div', 'sm-meta');
  meta.appendChild(el('span', 'sm-sid mono', shortId(r.id)));
  const wsSpan = el('span', 'sm-ws');
  wsSpan.appendChild(el('span', null, baseName(r.cwd) || shortId(r.ws)));
  meta.appendChild(wsSpan);
  meta.appendChild(el('span', null, relTime(r.mtime)));
  it.appendChild(meta);
  for (const h of (r.hits || []).slice(0, 3)) {
    const row = el('div', 'sm-hit');
    row.appendChild(el('span', 'sm-kind', S_KINDS[h.kind] || h.kind || '其他'));
    const snip = el('span', 'sm-snip');
    snip.innerHTML = markText(h.text || '', searchState.q);
    row.appendChild(snip);
    it.appendChild(row);
  }
  if (r.more > 0) it.appendChild(el('div', 'sm-more', '还有 ' + r.more + ' 条匹配…'));
  it.title = (r.title || r.id) + '\n' + (r.cwd || '');
  it.onclick = () => openSearchResult(r);
  it.onmouseenter = () => {
    searchState.sel = i;
    paintSearchSel();
  };
  return it;
}
// 命中高亮：按查询拆分后逐段转义，保证 <mark> 内的内容也安全
function markText(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return esc(t);
  const qe = q.replace(/[.*+?^$()|{}\[\]\\]/g, '\\$&');
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
  if (typeof selectSession === 'function') await selectSession({ ws: r.ws, id: r.id, title: r.title });
}
