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
  $('#btnSidebarTop').onclick = () => toggleSidebar();
  $('#navBack').onclick = () => Nav.back();
  $('#navFwd').onclick = () => Nav.fwd();
  $('#navRefresh').onclick = () => Nav.refresh();
  $('#navHome').onclick = () => Nav.home();
  $('#navUsage').onclick = () => toggleUsagePop();
  $('#navUpdate').onclick = () => openReleasePage((S.update || {}).url);
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
  refreshUsages(false); // 侧栏「用量」chip 先显示一个数（演示数据）
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
    // 用量统计已从右栏挪到左侧栏收纳浮层：?dock=usages 保留给截图/调试
    if (qd === 'usages') openUsagePop(true);
    else if (qd && { start: 1, files: 2, git: 3, terminal: 4, teamwork: 5, notices: 6, archives: 7 }[qd]) openDock(qd);
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
    fetchSkills(); // /skill 的参数补全：后台拉一次，失败就退回空列表（不挡启动）
    refreshUsages(false); // 侧栏「用量」chip 的后台取数（失败就保持「—」）
  } catch (e) {
    enterDemo('无法连接后端：' + (e && e.message ? e.message : e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ---------- N. 更新提醒 / 桌面壳偏好 ---------------------------------
   后端在进程启动时只查一次（app_core::start_update_check）：本 exe 内置的
   短提交号 vs GitHub 最新 release 上的 tag（tag 就是短哈希）。有新版本时把
   左侧栏「用量」旁的 chip 点亮 —— 从托盘恢复窗口、页面重连都不会重新检查。
   结论有两条到达路径：boot 的 state 快照，或检查稍晚完成时的 update 事件。

   开关属于「桌面壳偏好」（S.prefs，落盘 .cell/cell-app.json）：托盘驻留必须
   在窗口创建前就读到，所以不能和主题那样放 localStorage。              */
async function setShellPrefs(patch) {
  const out = await cmd('prefs.set', { patch });
  if (out && out.ok && out.prefs) {
    S.prefs = out.prefs;
    toast('已保存', 'ok');
  }
  renderUpdateChip();
  return out;
}

function renderUpdateChip() {
  const chip = $('#navUpdate');
  if (!chip) return;
  const u = S.update || {};
  const show = u.state === 'available' && !!u.url && (S.prefs || {}).update_check !== false;
  chip.classList.toggle('show', show);
  if (!show) return;
  const cur = u.current ? '当前构建 ' + u.current : '';
  chip.title = '有新版本 ' + (u.latest_tag || '') + (cur ? '（' + cur + '）' : '') + ' · 点击前往下载';
}

// 下载页交给系统默认浏览器：桌面壳里走 host_open_url 绑定（ShellExecuteW，
// 起的是真正的浏览器进程）；WebView2 没有 NewWindowRequested 处理，window.open
// 只会开出壳自己的派生窗口，所以壳里失败就只提示链接，绝不退回 window.open。
async function openReleasePage(url) {
  if (!url) return;
  if (typeof window.host_open_url === 'function') {
    let ok = false;
    try { const r = await window.host_open_url(url); ok = !!(r && r.ok); } catch (e) {}
    if (!ok) toast('无法唤起浏览器，请手动打开：' + url, 'bad', 9000);
    return;
  }
  if (!window.open(url, '_blank', 'noopener')) toast('请手动打开：' + url, 'info', 8000);
}
