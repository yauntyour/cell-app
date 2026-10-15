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
  $('#searchModal').onclick = ev => { if (ev.target === ev.currentTarget) closeSearch(); };
  $('#navBack').onclick = () => Nav.back();
  $('#navFwd').onclick = () => Nav.fwd();
  $('#navRefresh').onclick = () => Nav.refresh();
  $('#navHome').onclick = () => Nav.home();
  $('#navDock').onclick = () => toggleDock();
  $('#dockClose').onclick = () => closeDock();
  $$('.docktab').forEach(b => b.onclick = () => { S.dock = b.dataset.dock; openDock(b.dataset.dock); });
  $$('.modebtn').forEach(b => b.onclick = () => setComposerMode(b.dataset.mode));
  $('#sendBtn').onclick = () => sendCurrent();
  // 附件上传：文件选择按钮 + 隐藏 input（拖拽 / 粘贴入口见下方 drop/paste）
  const pick = $('#btnPickFile'), fin = $('#fileInput');
  if (pick && fin) {
    pick.onclick = () => fin.click();
    fin.addEventListener('change', () => {
      if (fin.files && fin.files.length) addFiles(fin.files);
      fin.value = ''; // 同一个文件可以再次选择
    });
  }

  const ta = $('#ta');
  ta.addEventListener('input', () => {
    const t = S.tabs.get(S.active); if (t) t.composer.text = ta.value;
    autosize(ta); slashSel = 0; buildSlash();
  });
  ta.addEventListener('keydown', ev => {
    const panel = $('#slashPanel');
    const open = panel.classList.contains('show');
    if (open) {
      const entries = panel._entries || [];
      if (ev.key === 'ArrowDown') { ev.preventDefault(); slashSel = (slashSel + 1) % entries.length; paintSlashSelection(panel); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); slashSel = (slashSel - 1 + entries.length) % entries.length; paintSlashSelection(panel); return; }
      if (ev.key === 'Tab') { ev.preventDefault(); if (entries[slashSel]) applySlash(entries[slashSel]); return; }
      // Enter：已写完整的指令按输入执行；半成品才接受高亮候选（见 enterSlash）
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); enterSlash(); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); panel.classList.remove('show'); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendCurrent(); return; }
    if (ev.key === 'Tab' && ev.shiftKey) { ev.preventDefault(); cycleMode(); return; }
  });

  $('#inputBox').addEventListener('dragover', ev => { ev.preventDefault(); $('#inputBox').classList.add('dropping'); });
  $('#inputBox').addEventListener('dragleave', () => $('#inputBox').classList.remove('dropping'));
  $('#inputBox').addEventListener('drop', ev => {
    ev.preventDefault(); $('#inputBox').classList.remove('dropping');
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
      if (S.tabs.get(S.active) && S.tabs.get(S.active).composer.mode !== 'attach') setComposerMode('attach');
      addFiles(ev.dataTransfer.files);
    }
  });
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

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      if (searchOpen()) { closeSearch(); return; }
      if (modalOpen()) { closeModal(); return; }
      if ($('#approvalModal').classList.contains('show')) { const t = S.tabs.get(S.active); if (t && t.approval) approve(t.approval, false); return; }
      if ($('#slashPanel').classList.contains('show')) { $('#slashPanel').classList.remove('show'); return; }
      if (S.settingsOpen) { closeSettings(); return; }
    }
    if (ev.key === 'Enter' && $('#approvalModal').classList.contains('show') && !modalOpen()) {
      const t = S.tabs.get(S.active); if (t && t.approval) { ev.preventDefault(); approve(t.approval, true); }
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'n') { ev.preventDefault(); $('#btnNewSession').click(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === ',') { ev.preventDefault(); toggleSettings(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'F' || ev.key === 'f')) { ev.preventDefault(); openSearch(); }
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/settings') openSettings(setSection);
    else if (S.settingsOpen) closeSettings();
  });
}

function paintSlashSelection(panel) {
  const rows = $$('.scmd', panel);
  rows.forEach((r, i) => r.classList.toggle('sel', i === slashSel));
  // 面板是真滚动容器（此前被卡片裁掉，看不到全部条目），↑↓ 要把选中行带进视野
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
  // demo has no async boot: render everything in the same tick so the first
  // frame already shows the whole UI (one paint, no double layout)
  renderPanes(); renderTabbar(); renderSidebar(); renderFoot(); renderStatLine(); renderDock();
  if (S.active) renderChat(S.active);
  setTimeout(() => { refreshSessions(); renderSidebar(); }, 60);
}

async function boot() {
  Theme.init();
  S.closedTabs = loadClosedTabs();
  S.groupsClosed = loadGroupState();
  Layout.init();
  wireEvents();
  // dev/debug + screenshots: ?dock=teamwork|notices opens the right dock at boot
  {
    const qd = new URLSearchParams(location.search).get('dock');
    if (qd === 'teamwork' || qd === 'notices') openDock(qd);
  }
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
