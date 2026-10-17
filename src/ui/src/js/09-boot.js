/* ---------- M. 事件绑定 / boot ------------------------------------- */
function wireEvents() {
  $('#btnNewSession').onclick = async () => {
    if (!S.active) { openWsDialog(); return; }
    const out = await cmd('session.new', { ws: S.active });
    if (out && out.ok !== false) { await resync(); refreshSessions(); }
  };
  $('#btnOpenWs').onclick = () => openWsDialog();
  $('#btnSettings').onclick = () => toggleSettings();
  $('#btnSearch').onclick = () => openSearch();
  $('#btnTopSearch').onclick = () => openSearch();
  $('#btnFiles').onclick = () => openDock('files');
  $('#btnGit').onclick = () => openDock('git');
  $('#btnTerminal').onclick = () => openDock('terminal');
  $('#btnWsFilter').onclick = () => toggleSidebarFilter();
  $('#btnSidebarToggle').onclick = () => toggleSidebar();
  $('#navBack').onclick = () => Nav.back();
  $('#navFwd').onclick = () => Nav.fwd();
  $('#navRefresh').onclick = () => Nav.refresh();
  $('#navHome').onclick = () => Nav.home();
  $('#navDock').onclick = () => toggleDock();
  $('#btnTopDock').onclick = () => toggleDock();
  $('#dockClose').onclick = () => closeDock();
  $('#searchModal').onclick = ev => { if (ev.target === ev.currentTarget) closeSearch(); };
  // 右侧页签：事件委托，面板由 renderDock 分发
  const dockTabs = $('#dockTabs');
  if (dockTabs) dockTabs.addEventListener('click', ev => {
    const b = ev.target.closest('.docktab');
    if (b && b.dataset.dock) openDock(b.dataset.dock);
  });
  if (window.Panels && Panels.init) Panels.init();
  if (window.ComposerUI && ComposerUI.init) ComposerUI.init();
  else wireComposerLegacy();

  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/settings') openSettings();
    else if (S.settingsOpen) closeSettings();
  });
}

/* 旧输入栏兜底绑定：ComposerUI 未加载时保持页面可用 */
function wireComposerLegacy() {
  const send = $('#sendBtn');
  if (send) send.onclick = () => sendCurrent();
  const pick = $('#btnPickFile'), fin = $('#fileInput');
  if (pick && fin) {
    pick.onclick = () => fin.click();
    fin.addEventListener('change', () => {
      if (fin.files && fin.files.length) addFiles(fin.files);
      fin.value = '';
    });
  }
  const ta = $('#ta');
  if (ta) {
    ta.addEventListener('input', () => {
      const t = S.tabs.get(S.active); if (t) t.composer.text = ta.value;
      autosize(ta); slashSel = 0; buildSlash();
    });
    ta.addEventListener('keydown', onComposerKey);
  }
  $$('.modebtn').forEach(b => b.onclick = () => setComposerMode(b.dataset.mode));
  const ib = $('#inputBox');
  if (ib) {
    ib.addEventListener('dragover', ev => { ev.preventDefault(); ib.classList.add('dropping'); });
    ib.addEventListener('dragleave', () => ib.classList.remove('dropping'));
    ib.addEventListener('drop', ev => {
      ev.preventDefault(); ib.classList.remove('dropping');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        const t = S.tabs.get(S.active);
        if (t && t.composer.mode !== 'attach') setComposerMode('attach');
        addFiles(ev.dataTransfer.files);
      }
    });
  }
  document.addEventListener('paste', ev => {
    const t = S.tabs.get(S.active);
    if (!t || !ev.clipboardData) return;
    const files = ev.clipboardData.files;
    if (files && files.length) {
      if (t.composer.mode !== 'attach') setComposerMode('attach');
      addFiles(files);
      ev.preventDefault();
    }
  });
}

/* 输入框键盘：斜杠面板导航 + Enter 发送（ComposerUI 负责时会自己绑定） */
function onComposerKey(ev) {
  const panel = $('#slashPanel');
  const open = panel && panel.classList.contains('show');
  if (open) {
    const entries = panel._entries || [];
    if (ev.key === 'ArrowDown') { ev.preventDefault(); slashSel = (slashSel + 1) % entries.length; paintSlashSelection(panel); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); slashSel = (slashSel - 1 + entries.length) % entries.length; paintSlashSelection(panel); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); if (entries[slashSel]) applySlash(entries[slashSel]); return; }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); enterSlash(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); panel.classList.remove('show'); return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendCurrent(); return; }
  if (ev.key === 'Tab' && ev.shiftKey) { ev.preventDefault(); cycleMode(); return; }
}

function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

function onGlobalKey(ev) {
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'Escape') {
    if (typeof closePreview === 'function' && typeof previewOpen === 'function' && previewOpen()) { closePreview(); return; }
    if (typeof quickOpenOpen === 'function' && quickOpenOpen()) { closeQuickOpen(); return; }
    if (searchOpen()) { closeSearch(); return; }
    if (modalOpen()) { closeModal(); return; }
    if ($('#approvalModal').classList.contains('show')) { const t = S.tabs.get(S.active); if (t && t.approval) approve(t.approval, false); return; }
    const slash = $('#slashPanel');
    if (slash && slash.classList.contains('show')) { slash.classList.remove('show'); return; }
    if (S.settingsOpen) { closeSettings(); return; }
    if (S.dockOpen) { closeDock(); return; }
  }
  if (!mod) return;
  const k = (ev.key || '').toLowerCase();
  if (k === 'n') { ev.preventDefault(); $('#btnNewSession').click(); return; }
  if (ev.key === ',') { ev.preventDefault(); toggleSettings(); return; }
  if (ev.shiftKey && k === 'f') { ev.preventDefault(); openSearch(); return; }
  if (k === 'p') { ev.preventDefault(); if (window.openQuickOpen) openQuickOpen(); else openDock('files'); return; }
  if (k === 'g') { ev.preventDefault(); openDock('git'); return; }
  if (ev.key === 'Backquote' || ev.code === 'Backquote' || ev.key === '\u0060') { ev.preventDefault(); openDock('terminal'); return; }
  if (k === 'b' && !ev.shiftKey) { ev.preventDefault(); toggleSidebar(); return; }
  if (k === 'b' && ev.shiftKey) { ev.preventDefault(); toggleDock(); return; }
  if (k === 'e' && ev.shiftKey) { ev.preventDefault(); toggleDock(); return; }
}

function paintSlashSelection(panel) {
  const rows = $$('.scmd', panel);
  rows.forEach((r, i) => r.classList.toggle('sel', i === slashSel));
  const cur = rows[slashSel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}
function cycleMode() {
  const order = ['text', 'attach', 'team'];
  const t = S.tabs.get(S.active); if (!t) return;
  const i = order.indexOf(t.composer.mode);
  setComposerMode(order[(i + 1) % order.length]);
}

function enterDemo(reason) {
  S.mode = 'demo';
  Transport.close();
  const b = $('#banner');
  b.textContent = '演示模式 · 数据为内置示例，不可持久化' + (reason ? '（' + reason + '）' : '');
  b.classList.add('show');
  S.connected = true;
  Mock.start();
  renderPanes(); renderTabbar(); renderSidebar(); renderFoot(); renderStatLine(); renderDock();
  if (S.active) { renderChat(S.active); renderChatHead(S.active); }
  renderDock();
  setTimeout(() => { refreshSessions(); renderSidebar(); renderDock(); }, 60);
}

async function boot() {
  Theme.init();
  S.closedTabs = loadClosedTabs();
  S.groupsClosed = loadGroupState();
  restoreSidebarState();
  dockRestore();
  Layout.init();
  wireEvents();
  // dev/debug + screenshots: ?dock=... 打开右侧面板；?settings=1 打开设置
  try {
    const q = new URLSearchParams(location.search);
    const qd = q.get('dock');
    if (qd && { start: 1, files: 2, git: 3, terminal: 4, teamwork: 5, notices: 6, archives: 7 }[qd]) openDock(qd);
    if (q.get('settings') === '1') openSettings(q.get('section') || undefined);
  } catch (e) {}
  if (MOCK) { enterDemo('file:// 或 ?mock=1'); return; }
  renderPanes(); renderTabbar(); renderSidebar(); renderFoot(); renderStatLine(); renderDock();
  try {
    const st = await api('state', {});
    if (!st || st.ok === false) throw new Error(st && st.error ? st.error : '状态请求失败');
    S.everConnected = true; S.connected = true;
    applyHello(st, true);
    Transport.init();
  } catch (e) {
    enterDemo('无法连接后端：' + (e && e.message ? e.message : e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();