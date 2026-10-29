/* =====================================================================
   I. 输入栏（Composer）· DSH 式悬浮输入卡
   ---------------------------------------------------------------------
   结构（全部由 ComposerUI.init() 建在骨架的 #composerInner 内）：
     #composerInner  ← 卡片本体（--elev-2 / --radius-xl / 1px --line2，
                        :focus-within 时 accent 边 + 外环）
       #inputBox     ← 编辑区（附件区 + textarea），拖拽落点
         #attachWrap ← 附件区（在编辑区上方，可多行折行，卡片随之变高）
           #attachBar（#btnPickFile）
           #chips
         #ta
         #fileInput
       #teamEditor   ← Teamwork 工作流编辑器（team 模式显示）
       .cmp-bar      ← 底部工具条：
         + 添加附件 · 模式 chip · 沙箱 chip  ……  模型+思考 chip · accent 发送钮
     .cmp-stat       ← 卡片外的状态行（连接点 / 左侧状态 / 右侧 token·round）
                       由 Lead 的 renderStatLine 写 #statLeft/#connDot，
                       这里只负责右侧 token/round（#statRight）。

   兼容契约（docs/ui-redesign.md §7.1）：保留全部旧全局函数
   renderComposer / syncComposerInput / setComposerMode / sendCurrent /
   focusInput / autosize / buildSlash / renderChips / syncComposerText /
   addFiles / enterSlash / applySlash / execSlash / layoutSlash / slashSel；
   并新增 window.ComposerUI = { init, render, refresh, ... } 供 boot 优先调用。

   #slashPanel 一个浮层两种来源（见 docs/ui-redesign.md §5.9）：文本以 / 开头 →
   斜杠指令候选；光标处有「空白之后的 @…」→ 引用候选（fs.list 列文件/目录，
   sessions.search 搜会话；选中会话时用 session.digest 取上下文摘要，
   以 session:```…``` 内容块写进输入框）。
   ===================================================================== */

const CMP_PLACEHOLDER = '描述你想构建的内容，/ 调用指令，@ 文件或对话';
const CMP_ATTACH_PLACEHOLDER = '为附件添加说明，或直接发送…';

/* 模式 / 沙箱 / 图标映射（图标名取自 00-core.js 的 ICON_PATHS） */
const CMP_MODES = [
  { v: 'text', label: '文本', icon: 'pencil', desc: '普通对话 · Enter 发送，Shift+Enter 换行' },
  { v: 'attach', label: '附件', icon: 'clip', desc: '拖入或粘贴文件，随消息一起发送' },
  { v: 'team', label: 'Teamwork', icon: 'users', desc: '编排多代理团队工作流' },
];
const CMP_SANDBOX = {
  'read-only': { label: '只读', icon: 'eye', desc: '禁止任何写入或执行' },
  'edit-only': { label: '仅编辑', icon: 'pencil', desc: '允许修改文件，禁止执行命令' },
  'full-access': { label: '完全访问', icon: 'terminal', desc: '可读写并执行命令' },
};
const CMP_CMD_ICONS = {
  '/new': 'plus', '/clear': 'trash', '/session': 'message', '/model': 'cpu',
  '/provider': 'database', '/think': 'bulb', '/tools': 'settings', '/sandbox': 'terminal',
  '/autoallow': 'check', '/compact': 'archive', '/stop': 'stop', '/teamwork': 'users',
  '/notice': 'bell', '/archive': 'archive', '/workspace': 'folder', '/theme': 'eye',
  '/help': 'info',
};
const CMP_ARG_ICONS = {
  sessions: 'message', models: 'cpu', providers: 'database', think: 'bulb',
  sandbox: 'terminal', onoff: 'check', theme: 'eye', teamwork: 'users', workspaces: 'folder',
};

/* 发送/停止/运行图标用内联 SVG 直接给：停止方块与播放三角填充更扎实 */
const CMP_ICON_SEND = '<svg class="uico" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CMP_ICON_STOP = '<svg class="uico" viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect x="6.5" y="6.5" width="11" height="11" rx="2.6" fill="currentColor"/></svg>';
const CMP_ICON_RUN = '<svg class="uico" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M8 5.2v13.6a.8.8 0 0 0 1.22.68l10.8-6.8a.8.8 0 0 0 0-1.36L9.22 4.52A.8.8 0 0 0 8 5.2Z" fill="currentColor"/></svg>';

let slashSel = 0;
let cmpMenu = null;        // 当前打开的 composer 弹出菜单
let cmpModelFetching = false;
let cmpMetaSig = '';       // 状态行右侧 token/round 的缓存签名

/* @ 引用面板：与斜杠面板共用同一个浮层（#slashPanel），只是候选来源不同。
   文件/目录走 ls 工具（fs.list）逐层列举，会话走 sessions.search 做检索；
   选中会话时先取它的上下文摘要（session.digest），再以
     session:```…```  的代码块形式写进输入框。 */
const AT_FILE_LIMIT = 40;
const AT_SESSION_LIMIT = 8;
let atState = { key: '', busy: false, files: [], sessions: [] };
let atTimer = 0;

/* ---------- I1. 构建 DOM ------------------------------------------- */
function cmpHost() { return $('#composerInner') || $('.composer-inner'); }
function cmpStack(host) {
  const el0 = host || cmpHost();
  if (!el0) return null;
  if (el0.parentElement && el0.parentElement.classList.contains('composer-stack')) return el0.parentElement;
  return el0.closest ? el0.closest('.composer-stack') : null;
}
function ensureSlashPanel() {
  let panel = $('#slashPanel');
  if (panel) return panel;
  panel = el('div', 'slash');
  panel.id = 'slashPanel';
  const stack = cmpStack(null) || $('#composer');
  if (!stack) return null;
  stack.insertBefore(panel, stack.firstChild);
  return panel;
}

function buildComposerDom() {
  const host = cmpHost();
  if (!host) return false;
  host.id = 'composerInner';
  host.classList.add('cmp-card');
  host.replaceChildren();

  /* — 编辑区（#inputBox 同时是拖拽落点） —
     附件区（提示条 + chips）在 textarea **上方**：附件多到折行时只会把卡片撑高，
     不会像放在下方那样把编辑区挤成一条缝（历史布局会偶发出现一行空白灰块）。*/
  const box = el('div', 'cmp-box');
  box.id = 'inputBox';

  const attachWrap = el('div', 'cmp-attachwrap');
  attachWrap.id = 'attachWrap';

  const attachBar = el('div', 'cmp-attach');
  attachBar.id = 'attachBar';
  attachBar.hidden = true;
  const pick = el('button', 'btn sm ghost');
  pick.id = 'btnPickFile';
  pick.type = 'button';
  pick.title = '选择要发送的文件';
  pick.innerHTML = iconHtml('clip', 'sm') + '<span>选择文件</span>';
  const hint = el('span', 'cmp-attach-hint', '也可把文件拖进输入框，或直接粘贴');
  attachBar.appendChild(pick);
  attachBar.appendChild(hint);
  attachWrap.appendChild(attachBar);

  const chips = el('div', 'cmp-chips');
  chips.id = 'chips';
  chips.hidden = true;
  attachWrap.appendChild(chips);
  box.appendChild(attachWrap);

  const ta = el('textarea');
  ta.id = 'ta';
  ta.rows = 1;
  ta.placeholder = CMP_PLACEHOLDER;
  ta.setAttribute('aria-label', '输入消息');
  ta.spellcheck = false;
  box.appendChild(ta);

  const fin = el('input');
  fin.type = 'file';
  fin.id = 'fileInput';
  fin.multiple = true;
  fin.hidden = true;
  box.appendChild(fin);

  host.appendChild(box);

  /* — Teamwork 工作流编辑器（team 模式显示） — */
  const team = el('div', 'cmp-team');
  team.id = 'teamEditor';
  team.hidden = true;
  host.appendChild(team);

  /* — 底部工具条 — */
  const bar = el('div', 'cmp-bar');

  const left = el('div', 'cmp-bar-l');
  const add = el('button', 'cmp-add');
  add.id = 'btnAttach';
  add.type = 'button';
  add.title = '添加附件（也可拖入 / 粘贴）';
  add.setAttribute('aria-label', '添加附件');
  add.innerHTML = iconHtml('plus');
  left.appendChild(add);

  const modeChip = el('button', 'cmp-chip');
  modeChip.id = 'modeChip';
  modeChip.type = 'button';
  modeChip.title = '输入模式（Shift+Tab 切换）';
  modeChip.setAttribute('aria-haspopup', 'menu');
  left.appendChild(modeChip);

  const sandboxChip = el('button', 'cmp-chip');
  sandboxChip.id = 'sandboxChip';
  sandboxChip.type = 'button';
  sandboxChip.title = '沙箱模式';
  sandboxChip.setAttribute('aria-haspopup', 'menu');
  left.appendChild(sandboxChip);

  const right = el('div', 'cmp-bar-r');
  const modelChip = el('button', 'cmp-chip cmp-chip-model');
  modelChip.id = 'modelChip';
  modelChip.type = 'button';
  modelChip.title = '模型 / 供应商 / 思考级别';
  modelChip.setAttribute('aria-haspopup', 'menu');
  right.appendChild(modelChip);

  const send = el('button', 'cmp-send');
  send.id = 'sendBtn';
  send.type = 'button';
  send.title = '发送 (Enter)';
  send.setAttribute('aria-label', '发送');
  send.innerHTML = CMP_ICON_SEND;
  right.appendChild(send);

  bar.appendChild(left);
  bar.appendChild(right);
  host.appendChild(bar);

  /* — 状态行：放在卡片外（.composer-stack 末尾），视觉上是漂浮卡下的细行 — */
  const stack = cmpStack(host);
  let stat = null;
  if (stack) stat = stack.querySelector('.cmp-stat, .cstat');
  if (stat && host.contains(stat)) stat = null;
  if (!stat) stat = el('div', 'cmp-stat');
  stat.className = 'cmp-stat';
  stat.replaceChildren();
  const dot = el('span', 'pulse');
  dot.id = 'connDot';
  dot.title = '连接状态';
  const statL = el('span', 'cmp-stat-l trunc');
  statL.id = 'statLeft';
  statL.textContent = '就绪';
  const statR = el('span', 'cmp-stat-r');
  statR.id = 'statRight';
  stat.appendChild(dot);
  stat.appendChild(statL);
  stat.appendChild(el('span', 'grow'));
  stat.appendChild(statR);
  if (stack) { if (stat.parentElement !== stack) stack.appendChild(stat); }
  else host.appendChild(stat);

  ensureSlashPanel();
  autosize(ta);
  host.__cmpBuilt = true;
  return true;
}

/* ---------- I2. 事件绑定 ------------------------------------------- */
function bindComposer() {
  const host = cmpHost();
  if (!host || host.__cmpBound) return;
  host.__cmpBound = true;

  const ta = $('#ta');
  const send = $('#sendBtn');
  const fin = $('#fileInput');
  const pick = $('#btnPickFile');
  const add = $('#btnAttach');

  if (ta) {
    ta.addEventListener('input', () => {
      const t = curTab();
      if (!t) return;
      t.composer.text = ta.value;
      slashSel = 0;
      autosize(ta);
      buildSlash();
      paintSendState(t);
    });
    ta.addEventListener('keydown', onComposerKeydown);
  }
  if (send) send.addEventListener('click', () => sendCurrent());
  if (add && fin) add.addEventListener('click', () => { if (!add.disabled) fin.click(); });
  if (pick && fin) pick.addEventListener('click', () => fin.click());
  if (fin) fin.addEventListener('change', () => {
    if (fin.files && fin.files.length) addFiles(fin.files);
    fin.value = ''; // 同一个文件可以再次选择
  });

  const modeChip = $('#modeChip');
  if (modeChip) modeChip.addEventListener('click', () => toggleModeMenu(modeChip));
  const sandboxChip = $('#sandboxChip');
  if (sandboxChip) sandboxChip.addEventListener('click', () => toggleSandboxMenu(sandboxChip));
  const modelChip = $('#modelChip');
  if (modelChip) modelChip.addEventListener('click', () => toggleModelMenu(modelChip));

  /* 拖拽入卡：整张卡片都是落点（编辑区高亮） */
  const stop = ev => { ev.preventDefault(); ev.stopPropagation(); };
  host.addEventListener('dragenter', ev => {
    stop(ev);
    if (!hasFileDrag(ev)) return;
    host.classList.add('dropping');
  });
  host.addEventListener('dragover', ev => {
    stop(ev);
    if (!hasFileDrag(ev)) return;
    host.classList.add('dropping');
    try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) {}
  });
  host.addEventListener('dragleave', ev => {
    if (ev.relatedTarget && host.contains(ev.relatedTarget)) return;
    host.classList.remove('dropping');
  });
  host.addEventListener('drop', ev => {
    stop(ev);
    host.classList.remove('dropping');
    const dt = ev.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const t = curTab();
    if (t && t.composer.mode !== 'attach') setComposerMode('attach');
    addFiles(dt.files);
  });

  /* 粘贴：带文件的剪贴板 → 附件（沿用旧行为，全局生效） */
  document.addEventListener('paste', ev => {
    const t = curTab();
    if (!t || !ev.clipboardData) return;
    const files = ev.clipboardData.files;
    if (files && files.length) {
      if (t.composer.mode !== 'attach') setComposerMode('attach');
      addFiles(files);
      ev.preventDefault();
    }
  });

  /* 点卡片空白处聚焦输入框 */
  host.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    if (ev.target === host || ev.target.classList.contains('cmp-box') || ev.target.classList.contains('cmp-bar')) {
      ev.preventDefault();
      focusInput();
    }
  });

  /* 宽度自适应：主区变窄（分栏/窗口）时把 chip 收成图标，避免文字挤成「文…」 */
  applyComposerWidthClass();
  paintComposerMetrics();
  if (typeof ResizeObserver !== 'undefined') {
    // 回调里同步改类名会再次改变被观察元素的大小，Chromium 因此报
    // "ResizeObserver loop completed with undelivered notifications"；
    // 延到下一帧处理即可（终端面板改变宽度时会命中这条路）
    const ro = new ResizeObserver(() => window.requestAnimationFrame(() => {
      applyComposerWidthClass();
      paintComposerMetrics();
    }));
    ro.observe(host);
    host.__cmpRO = ro;
  }

  /* 附件预览小窗：任何点击/缩放都先收起，避免残留在半空 */
  document.addEventListener('pointerdown', hideAttachPreview, true);
  window.addEventListener('resize', hideAttachPreview);

  /* 拖动 --composer-h 的手柄后重新自适配高度（布局本身由 03-layout.js 负责） */
  const rz = $('#rzComposer');
  if (rz) {
    rz.addEventListener('pointerup', () => renderComposer());
    rz.addEventListener('keyup', () => renderComposer());
  }
  window.addEventListener('resize', () => { try { renderComposer(); } catch (e) {} });
}

function applyComposerWidthClass() {
  const host = $('#composerInner');
  if (!host) return;
  const w = host.getBoundingClientRect().width || 0;
  host.classList.toggle('cmp-narrow', w > 0 && w < 650);
  host.classList.toggle('cmp-tiny', w > 0 && w < 520);
}

/* 量一次卡片的真实高度，写进两个 CSS 变量（纯 CSS 取不到「元素自然高度」）：
     --cmp-card-h    整个 .composer-stack 的高度 → 消息流底部留白 /「回到底部」按钮
                     跟着卡片走，附件折行把卡片撑高时消息流不会被盖住
     --cmp-attach-h  附件区的高度 → 卡片 max-height 允许超出拖拽高度的部分，
                     保证多行附件始终有位置，不会把编辑区挤扁 */
function paintComposerMetrics() {
  const host = $('#composerInner');
  if (!host) return;
  const root = document.documentElement;
  const stack = cmpStack(host);
  const cardH = Math.round((stack || host).getBoundingClientRect().height);
  root.style.setProperty('--cmp-card-h', cardH + 'px');
  const wrap = $('#attachWrap');
  const attachH = wrap ? Math.round(wrap.getBoundingClientRect().height) : 0;
  root.style.setProperty('--cmp-attach-h', Math.max(0, attachH) + 'px');
}

function hasFileDrag(ev) {
  const dt = ev.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).indexOf('Files') >= 0) return true;
  return !!(dt.files && dt.files.length);
}

function onComposerKeydown(ev) {
  if (ev.isComposing || ev.keyCode === 229) return; // 输入法组合中：交给 IME
  const panel = $('#slashPanel');
  const open = !!(panel && panel.classList.contains('show'));
  const entries = (panel && panel._entries) || [];

  if (open) {
    // 面板自己消费掉的键不再冒泡：全局 Escape 处理器看到面板已关会顺手把右栏也关掉
    if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); moveSlashSel(1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); moveSlashSel(-1); return; }
    if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); if (entries[slashSel]) applySlash(entries[slashSel]); return; }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); enterSlash(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeSlash(); return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendCurrent(); return; }
  if (ev.key === 'Tab' && ev.shiftKey) { ev.preventDefault(); cycleComposerMode(); return; }
  if (ev.key === 'Escape' && cmpMenu) { closeComposerMenu(); return; }
}

function closeSlash() {
  const p = $('#slashPanel');
  if (p) { p.classList.remove('show'); p._entries = []; p._mode = ''; }
}

function cycleComposerMode() {
  const t = curTab();
  if (!t) return;
  const order = CMP_MODES.map(m => m.v);
  const i = order.indexOf(t.composer.mode);
  setComposerMode(order[(i + 1) % order.length]);
}

/* ---------- I3. 核心渲染 ------------------------------------------- */
function ensureComposer() {
  const host = cmpHost();
  if (host && host.__cmpBuilt && $('#ta')) return true;
  if (!buildComposerDom()) return false;
  bindComposer();
  return true;
}

function paintModeChip(mode) {
  const chip = $('#modeChip');
  if (!chip) return;
  const m = CMP_MODES.find(x => x.v === mode) || CMP_MODES[0];
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml(m.icon) + '</span>'
    + '<span class="cmp-chip-txt"></span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  const txt = chip.querySelector('.cmp-chip-txt');
  if (txt) txt.textContent = m.label;
  chip.title = '输入模式：' + m.label + '（Shift+Tab 切换）';
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'mode' ? 'true' : 'false');
}

function paintSandboxChip(mode) {
  const chip = $('#sandboxChip');
  if (!chip) return;
  const m = CMP_SANDBOX[mode] || CMP_SANDBOX['full-access'];
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml(m.icon) + '</span>'
    + '<span class="cmp-chip-txt"></span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  const txt = chip.querySelector('.cmp-chip-txt');
  if (txt) txt.textContent = m.label;
  chip.title = '沙箱模式：' + m.label + ' · ' + m.desc;
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'sandbox' ? 'true' : 'false');
}

function paintModelChip(t) {
  const chip = $('#modelChip');
  if (!chip) return;
  const lv = Number((S.settings || {}).think_level || 0);
  const lvl = THINK_LEVELS[lv] || THINK_LEVELS[0];
  const name = S.model || '(未选择模型)';
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml('cpu') + '</span>'
    + '<span class="cmp-model-name trunc"></span>'
    + '<span class="cmp-sep">·</span>'
    + '<span class="cmp-think' + (lv > 0 ? ' on' : '') + '"></span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  const nm = chip.querySelector('.cmp-model-name');
  if (nm) nm.textContent = name;
  const th = chip.querySelector('.cmp-think');
  if (th) th.textContent = lv > 0 ? ('思考 ' + lvl.name) : '思考 off';
  chip.title = '模型：' + name + '\n思考：' + (lv > 0 ? lvl.name + ' (' + lvl.v + ') · ' + lvl.desc : '关闭')
    + '\n点击切换模型 / 供应商 / 思考级别';
  chip.disabled = !t;
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'model' ? 'true' : 'false');
}

function paintSendState(t) {
  const send = $('#sendBtn');
  if (!send) return;
  const mode = t ? (t.composer.mode || 'text') : 'text';
  send.classList.toggle('stop', !!(t && t.busy));
  send.classList.remove('dim');
  if (!t) {
    send.disabled = true;
    send.innerHTML = CMP_ICON_SEND;
    send.title = '先打开一个工作区';
    return;
  }
  send.disabled = false;
  if (t.busy) {
    send.innerHTML = CMP_ICON_STOP;
    send.title = '停止：中断当前回合与该工作区的全部 Teamwork 任务';
    send.setAttribute('aria-label', '停止');
    return;
  }
  send.setAttribute('aria-label', '发送');
  if (mode === 'team') {
    send.innerHTML = CMP_ICON_RUN;
    send.title = '创建工作流并运行';
    return;
  }
  send.innerHTML = CMP_ICON_SEND;
  send.title = '发送 (Enter)';
  const has = !!(String(t.composer.text || '').trim() || (t.composer.attachments || []).length);
  if (!has) send.classList.add('dim');
}

function renderComposer() {
  if (!ensureComposer()) return;
  const t = curTab();
  const composer = $('#composer');
  if (composer) composer.classList.toggle('disabled', !t);
  const ta = $('#ta');
  const send = $('#sendBtn');
  const box = $('#inputBox');
  const teamHost = $('#teamEditor');
  const attachBar = $('#attachBar');

  if (!t) {
    if (ta) { ta.disabled = true; ta.value = ''; ta.placeholder = '先打开一个工作区…'; }
    if (box) box.hidden = false;
    if (teamHost) { teamHost.hidden = true; teamHost.replaceChildren(); teamHost.__builtFor = ''; }
    if (attachBar) attachBar.hidden = true;
    renderChips(null);
    if (send) { send.disabled = true; send.classList.remove('stop'); send.innerHTML = CMP_ICON_SEND; send.title = '先打开一个工作区'; }
    ['#modeChip', '#sandboxChip', '#btnAttach'].forEach(s => { const b = $(s); if (b) b.disabled = true; });
    paintModeChip('text');
    paintSandboxChip(S.sandbox || 'full-access');
    paintModelChip(null);
    closeComposerMenu();
    closeSlash();
    paintStatRight(null);
    paintComposerMetrics();
    // 状态行左侧（#statLeft）归 Lead 的 renderStatLine；这里顺带刷新，
    // 避免 composer 重建后左侧还停在上一次（如「没有打开的工作区」）的文案
    if (typeof renderStatLine === 'function') renderStatLine();
    return;
  }

  ta.disabled = false;
  const mode = t.composer.mode || 'text';
  if (composer) composer.classList.toggle('team', mode === 'team');
  ['#modeChip', '#sandboxChip', '#btnAttach'].forEach(s => { const b = $(s); if (b) b.disabled = false; });
  paintModeChip(mode);
  paintSandboxChip(S.sandbox || 'full-access');
  paintModelChip(t);

  if (mode === 'team') {
    if (box) box.hidden = true;
    if (attachBar) attachBar.hidden = true;
    if (teamHost) {
      teamHost.hidden = false;
      if (teamHost.__builtFor !== t.ws) { teamHost.__builtFor = t.ws; renderWorkflowEditor(t); }
    }
  } else {
    if (teamHost) teamHost.hidden = true;
    if (box) box.hidden = false;
    if (attachBar) attachBar.hidden = mode !== 'attach';
    if (ta) {
      if (ta.value !== (t.composer.text || '')) ta.value = t.composer.text || '';
      ta.placeholder = mode === 'attach' ? CMP_ATTACH_PLACEHOLDER : CMP_PLACEHOLDER;
      autosize(ta);
    }
  }

  renderChips(t); // 内部会重算 --cmp-card-h / --cmp-attach-h
  paintSendState(t);
  paintStatRight(t);
  if (typeof renderStatLine === 'function') renderStatLine();
}

function syncComposerInput() { renderComposer(); }

function syncComposerText(txt) {
  const t = curTab();
  if (!t) return;
  t.composer.text = txt;
  const ta = $('#ta');
  if (ta) { ta.value = txt; autosize(ta); }
  paintSendState(t);
  buildSlash();
}

function focusInput() {
  const t = curTab();
  if (t && t.composer.mode === 'team') {
    const goal = $('#twGoal');
    if (goal) { goal.focus(); return; }
  }
  const ta = $('#ta');
  if (ta && !ta.disabled) ta.focus();
}

function autosize(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  let cap = 200;
  try {
    const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 156;
    cap = Math.max(44, Math.round(h - 74));
  } catch (e) {}
  const want = Math.max(24, Math.min(cap, ta.scrollHeight));
  ta.style.height = want + 'px';
  ta.style.overflowY = ta.scrollHeight > cap ? 'auto' : 'hidden';
}

function setComposerMode(mode) {
  const t = curTab();
  if (!t) return;
  closeComposerMenu();
  closeSlash();
  t.composer.mode = mode;
  renderComposer();
  if (mode === 'team') {
    const goal = $('#twGoal');
    if (goal) goal.focus();
  } else {
    focusInput();
  }
}

/* ---------- I4. 附件 chips ----------------------------------------- */
function renderChips(t) {
  const wrap = $('#chips');
  if (!wrap) return;
  const list = (t && t.composer && t.composer.attachments) || [];
  wrap.replaceChildren();
  hideAttachPreview();
  if (!list.length) { wrap.hidden = true; paintComposerMetrics(); return; }
  wrap.hidden = false;
  list.forEach((a, i) => {
    const c = el('div', 'cf-chip' + (a.uploading ? ' up' : '') + (a.error ? ' err' : ''));
    c.title = a.path || a.name || '';
    const ico = el('span', 'cf-ico');
    ico.innerHTML = iconHtml(a.uploading ? 'clock' : (a.error ? 'alert' : 'file'));
    c.appendChild(ico);
    c.appendChild(el('span', 'cf-name trunc', a.name || 'file'));
    c.appendChild(el('span', 'cf-size', a.uploading ? '上传中…' : (a.error ? '失败' : fmtBytes(a.size))));
    const x = el('button', 'cf-x');
    x.type = 'button';
    x.title = '移除附件';
    x.setAttribute('aria-label', '移除附件');
    x.innerHTML = iconHtml('x');
    x.onclick = ev => {
      ev.stopPropagation();
      dropAttachPreview(a);
      list.splice(i, 1);
      renderChips(t);
      if (t === curTab()) paintSendState(t);
    };
    c.appendChild(x);
    c.addEventListener('mouseenter', () => scheduleAttachPreview(c, a));
    c.addEventListener('mouseleave', hideAttachPreview);
    wrap.appendChild(c);
  });
  paintComposerMetrics();
}

/* 附件预览数据：图片给 object URL，文本给前 4k 字符（都只在内存里，发送/移除即释放）。
   仅用于「这是哪个附件」的辨识，跟上传走的是同一次本地读取之外的最小代价。 */
const CMP_PREV_IMG_MAX = 12 * 1024 * 1024;
const CMP_PREV_TXT_MAX = 512 * 1024;
const CMP_PREV_TEXT_EXT = /\.(txt|md|markdown|jsonl?|csv|tsv|log|xml|ya?ml|ini|toml|cfg|conf|c|h|hpp|cc|cpp|cxx|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|kt|rb|php|lua|sh|bash|ps1|bat|html?|css|scss|sql)$/i;

function loadAttachPreview(item, file) {
  if (!item || !file) return;
  try {
    if (/^image\//i.test(file.type || '') && file.size <= CMP_PREV_IMG_MAX) {
      item._url = URL.createObjectURL(file);
      return;
    }
    if (file.size > CMP_PREV_TXT_MAX) return;
    if (!(/^text\//i.test(file.type || '') || CMP_PREV_TEXT_EXT.test(item.name || ''))) return;
    const rd = new FileReader();
    rd.onload = () => { item._text = String(rd.result == null ? '' : rd.result).slice(0, 4000); };
    rd.readAsText(file);
  } catch (e) {}
}
function dropAttachPreview(item) {
  if (!item) return;
  if (item._url) { try { URL.revokeObjectURL(item._url); } catch (e) {} item._url = ''; }
  item._text = '';
}

/* 悬浮预览小窗：贴在被悬浮的 chip 上方（上方放不下就翻到下方），
   pointer-events:none，永远不抢鼠标。延迟 160ms 再出，扫过一排 chip 时不闪。 */
let cmpPrev = null;        // { el, item }
let cmpPrevTimer = 0;

function hideAttachPreview() {
  if (cmpPrevTimer) { clearTimeout(cmpPrevTimer); cmpPrevTimer = 0; }
  if (cmpPrev) { cmpPrev.el.remove(); cmpPrev = null; }
}
function scheduleAttachPreview(chip, item) {
  if (cmpPrevTimer) { clearTimeout(cmpPrevTimer); cmpPrevTimer = 0; }
  if (cmpPrev && cmpPrev.item === item) return; // 已经显示这一个
  cmpPrevTimer = setTimeout(() => { cmpPrevTimer = 0; paintAttachPreview(chip, item); }, 160);
}
function paintAttachPreview(chip, item) {
  hideAttachPreview();
  if (!chip || !chip.isConnected || !item) return;
  const card = el('div', 'cmp-prev');
  const head = el('div', 'cmp-prev-head');
  head.appendChild(el('span', 'cmp-prev-name trunc', item.name || '文件'));
  head.appendChild(el('span', 'cmp-prev-meta', fmtBytes(item.size)));
  card.appendChild(head);

  if (item._url) {
    const img = el('img', 'cmp-prev-img');
    img.alt = item.name || '';
    // 图片解码完才知道真实高度：定位要跟着重算，否则「上方贴边」的小窗会
    // 一边长高一边盖住 chip（首次渲染时 img 高度为 0）
    img.addEventListener('load', () => { if (cmpPrev && cmpPrev.el === card) placeAttachPreview(card, chip); });
    img.src = item._url;
    card.appendChild(img);
  } else if (item._text) {
    const pre = el('pre', 'cmp-prev-txt');
    pre.textContent = item._text;
    card.appendChild(pre);
  } else {
    card.appendChild(el('div', 'cmp-prev-none', item.uploading ? '上传中…' : '（该类型没有预览）'));
  }

  document.body.appendChild(card);
  placeAttachPreview(card, chip);
  cmpPrev = { el: card, item: item };
}

/* 贴在被悬浮的 chip 上方 8px；上方放不下就翻到下方，左右都夹在视口内 */
function placeAttachPreview(card, chip) {
  if (!card || !chip || !chip.isConnected) return;
  const r = chip.getBoundingClientRect();
  const w = card.offsetWidth || 200;
  const h = card.offsetHeight || 80;
  let top = r.top - h - 8;
  if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  card.style.top = Math.round(Math.max(8, top)) + 'px';
  card.style.left = Math.round(left) + 'px';
}

async function addFiles(files) {
  const t = curTab();
  if (!t || !files || !files.length) return;
  for (const f of Array.from(files)) {
    const item = { name: f.name || '文件', size: f.size, uploading: true, path: '' };
    t.composer.attachments.push(item);
    renderChips(t);
    paintSendState(t);
    loadAttachPreview(item, f);
    try {
      const b64 = await fileToB64(f);
      const out = await cmd('upload', { ws: t.ws, name: f.name, data_b64: b64 });
      if (out && out.ok) { item.path = out.path; item.name = out.name; item.size = out.size; }
      else { item.error = true; item.path = ''; }
    } catch (e) {
      item.error = true;
      toast('上传失败：' + e.message, 'bad');
    }
    item.uploading = false;
    renderChips(t);
    paintSendState(t);
  }
}

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => rej(new Error('读取失败'));
    r.readAsDataURL(file);
  });
}

/* ---------- I5. 发送 / 停止 ---------------------------------------- */
async function sendCurrent() {
  const t = curTab();
  if (!t) return;
  closeComposerMenu();
  if (t.busy) { closeSlash(); stopAllActivity(t); return; }
  if (t.composer.mode === 'team') { closeSlash(); await submitWorkflow(t, 'run'); return; }
  let text = (t.composer.text || '').trim();
  const atts = (t.composer.attachments || []).filter(a => a.path);
  if (!text && !atts.length) return;
  // 斜杠指令在前端执行，绝不作为消息发给模型（见 slashIntent 注释）
  const it = slashIntent(text);
  if (it.kind !== 'message') {
    closeSlash();
    if (it.kind === 'exec') { syncComposerText(''); runSlash(t, it); }
    else { syncComposerText(it.name + ' '); buildSlash(); focusInput(); } // complete：先出参数候选
    return;
  }
  if (atts.length) {
    text += (text ? '\n\n' : '') + '[附件]\n' + atts.map(a => '- ' + a.path).join('\n');
  }
  closeSlash();
  const optimistic = { id: uid(), role: 'user', text: text, ts: nowSec() };
  t.msgs.push(optimistic);
  for (const a of (t.composer.attachments || [])) dropAttachPreview(a); // 释放预览用的 object URL
  t.composer.text = '';
  t.composer.attachments = [];
  const ta = $('#ta');
  if (ta) { ta.value = ''; autosize(ta); }
  renderChips(t);
  paintSendState(t);
  buildSlash(true);
  markChat(t.ws);
  const out = await cmd('send', { ws: t.ws, text: text });
  if (out && out.ok === false) { markChat(t.ws); }
  focusInput();
}

// 「停止」= 终止该工作区的全部活动：进行中的回合 + 所有 run 状态的 Teamwork
// 任务（此前只停回合，后台团队任务会继续跑）。列表现场拉一次为准，t.jobs
// 可能还没刷新到最新状态。
async function stopAllActivity(t) {
  cmd('stop', { ws: t.ws });
  let jobs = t.jobs || [];
  try { const out = await api('teamwork.list', { ws: t.ws }); if (out && out.jobs) jobs = out.jobs; } catch (e) {}
  const running = jobs.filter(j => jobStatusClass(j.status) === 'run');
  if (!running.length) { await refreshTeamworkNow(t.ws, true); return; }
  for (const j of running) await cmd('teamwork.stop', { ws: t.ws, id: j.id });
  toast('已停止 ' + running.length + ' 个团队任务', 'ok');
  // 停止是异步的（runner 下一轮才翻状态）：先立即刷一次，+600ms 再对一次
  await refreshTeamworkNow(t.ws, false, true);
  setTimeout(() => { if (S.tabs.get(t.ws) === t) refreshTeamworkNow(t.ws, true); }, 600);
}

/* ---------- I6. 状态行右侧：token / round -------------------------- */
function cmpTurnUsage(t) {
  let start = 0;
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    if (t.msgs[i] && t.msgs[i].role === 'user') { start = i; break; }
  }
  let tin = 0, tout = 0, cache = 0, rounds = 0;
  for (let i = start; i < t.msgs.length; i++) {
    const m = t.msgs[i];
    if (!m || m.role !== 'round') continue;
    rounds++;
    tin += Number(m.tok_in || 0);
    tout += Number(m.tok_out || 0);
    cache += Number(m.cache || 0);
  }
  return { tin: tin, tout: tout, cache: cache, rounds: rounds };
}
function cmpFmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function paintStatRight(t) {
  const box = $('#statRight');
  if (!box) return;
  let meta = box.querySelector('.cmp-stat-meta');
  if (!t) { if (meta) { meta.textContent = ''; meta.hidden = true; } cmpMetaSig = ''; return; }
  const u = cmpTurnUsage(t);
  const parts = [];
  if (t.busy) parts.push('运行中');
  if (u.rounds) parts.push('第 ' + u.rounds + ' 轮');
  if (u.tin || u.tout) parts.push('↑' + cmpFmtTok(u.tin) + ' ↓' + cmpFmtTok(u.tout));
  const txt = parts.join(' · ');
  const sig = [t.busy ? 1 : 0, u.rounds, u.tin, u.tout, u.cache].join('|');
  if (!txt) { if (meta) { meta.textContent = ''; meta.hidden = true; } cmpMetaSig = sig; return; }
  if (!meta) {
    meta = el('span', 'cmp-stat-meta');
    meta.hidden = false;
    box.appendChild(meta);
  }
  meta.hidden = false;
  if (meta.textContent !== txt) meta.textContent = txt;
  meta.title = '本回合 tokens —— 输入 ' + u.tin + ' · 输出 ' + u.tout
    + (u.cache ? ' · 缓存命中 ' + u.cache : '') + (u.rounds ? ' · 共 ' + u.rounds + ' 轮' : '');
  meta.classList.toggle('busy', !!t.busy);
  cmpMetaSig = sig;
}
// 回合进行中轮次事件不触发 composer 重绘：用极廉价的心跳补上 token/round
setInterval(() => {
  if (document.hidden) return;
  const t = curTab();
  if (!t) return;
  const u = cmpTurnUsage(t);
  const sig = [t.busy ? 1 : 0, u.rounds, u.tin, u.tout, u.cache].join('|');
  if (sig === cmpMetaSig) return;
  paintStatRight(t);
}, 700);

/* ---------- I7. 弹出菜单（模式 / 沙箱 / 模型） --------------------- */
function closeComposerMenu(restoreFocus) {
  if (!cmpMenu) return;
  const m = cmpMenu;
  const focused = m.el.contains(document.activeElement);
  m.el.remove();
  document.removeEventListener('pointerdown', m.out, true);
  document.removeEventListener('keydown', m.key, true);
  if (m.resize) window.removeEventListener('resize', m.resize);
  try { m.anchor.setAttribute('aria-expanded', 'false'); } catch (e) {}
  cmpMenu = null;
  try {
    if (restoreFocus !== false && focused && m.anchor && m.anchor.isConnected) m.anchor.focus({ preventScroll: true });
  } catch (e) {}
}

function cmpMenuRow(icon, label, sub, on) {
  const b = el('button', 'cmp-mi' + (on ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  const ico = el('span', 'cmp-mi-ico');
  ico.innerHTML = iconHtml(icon);
  b.appendChild(ico);
  const tx = el('span', 'cmp-mi-tx');
  tx.appendChild(el('span', 'cmp-mi-label trunc', label));
  if (sub) tx.appendChild(el('span', 'cmp-mi-sub trunc', sub));
  b.appendChild(tx);
  if (on) {
    const ck = el('span', 'cmp-mi-ck');
    ck.innerHTML = iconHtml('check');
    b.appendChild(ck);
  }
  return b;
}
function cmpMenuHead(text) { return el('div', 'cmp-menu-head', text); }
function cmpMenuSep() { return el('div', 'cmp-menu-sep'); }

function openComposerMenu(anchor, opts) {
  if (!anchor) return;
  if (cmpMenu && cmpMenu.anchor === anchor && cmpMenu.kind === opts.kind) { closeComposerMenu(); return; }
  closeComposerMenu(false);
  const menu = el('div', 'cmp-menu');
  menu.setAttribute('role', 'menu');
  opts.build(menu);
  document.body.appendChild(menu);

  // 定位：优先贴在 chip 上方；上下空间不够时按可用高度收缩（菜单内部滚动），
  // 任何情况下都不越出视口——弹出菜单是 fixed 层，不受输入卡 overflow 影响。
  const r = anchor.getBoundingClientRect();
  const gap = 8, margin = 8;
  const spaceAbove = r.top - gap - margin;
  const spaceBelow = window.innerHeight - r.bottom - gap - margin;
  const useAbove = spaceAbove >= spaceBelow;
  const avail = Math.max(140, useAbove ? spaceAbove : spaceBelow);
  menu.style.maxHeight = Math.min(520, avail) + 'px';
  const mw = menu.offsetWidth || 240;
  const mh = menu.offsetHeight || 200;
  let left = opts.align === 'right' ? (r.right - mw) : r.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin));
  let top = useAbove ? (r.top - gap - mh) : (r.bottom + gap);
  top = Math.max(margin, Math.min(top, window.innerHeight - mh - margin));
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';

  const rows = () => Array.from(menu.querySelectorAll('.cmp-mi'));
  menu.addEventListener('keydown', ev => {
    const rs = rows();
    const i = rs.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); (rs[i + 1] || rs[0]).focus({ preventScroll: true }); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); (rs[i - 1] || rs[rs.length - 1]).focus({ preventScroll: true }); }
  });
  const out = ev => {
    if (!menu.contains(ev.target) && !anchor.contains(ev.target)) closeComposerMenu();
  };
  const key = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    closeComposerMenu();
  };
  const onResize = () => closeComposerMenu(false);
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', onResize);
  cmpMenu = { el: menu, anchor: anchor, out: out, key: key, resize: onResize, kind: opts.kind };
  const first = menu.querySelector('.cmp-mi.on') || rows()[0];
  if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  anchor.setAttribute('aria-expanded', 'true');
}

function toggleModeMenu(anchor) {
  const t = curTab();
  if (!t) return;
  openComposerMenu(anchor, {
    kind: 'mode',
    build: menu => {
      menu.appendChild(cmpMenuHead('输入模式'));
      for (const m of CMP_MODES) {
        const row = cmpMenuRow(m.icon, m.label, m.desc, t.composer.mode === m.v);
        row.onclick = () => {
          closeComposerMenu(false);
          if (t.composer.mode !== m.v) setComposerMode(m.v);
          else focusInput();
        };
        menu.appendChild(row);
      }
      menu.appendChild(cmpMenuSep());
      const hint = el('div', 'cmp-menu-hint');
      hint.innerHTML = '<kbd>Shift</kbd>+<kbd>Tab</kbd> 快速切换模式';
      menu.appendChild(hint);
    },
  });
}

function toggleSandboxMenu(anchor) {
  const t = curTab();
  if (!t) return;
  const cur = S.sandbox || 'full-access';
  openComposerMenu(anchor, {
    kind: 'sandbox',
    build: menu => {
      menu.appendChild(cmpMenuHead('沙箱模式'));
      for (const m of SANDBOX_MODES) {
        const info = CMP_SANDBOX[m.v] || { label: m.v, icon: 'terminal', desc: m.desc };
        const row = cmpMenuRow(info.icon, info.label, m.desc || info.desc, cur === m.v);
        row.onclick = () => { closeComposerMenu(false); if (cur !== m.v) setSandboxMode(m.v); else focusInput(); };
        menu.appendChild(row);
      }
    },
  });
}

function toggleModelMenu(anchor) {
  const t = curTab();
  if (!t) return;
  const lv = Number((S.settings || {}).think_level || 0);
  openComposerMenu(anchor, {
    kind: 'model',
    align: 'right',
    build: menu => {
      menu.appendChild(cmpMenuHead('模型'));
      if (S.models.length) {
        for (const m of S.models) {
          const row = cmpMenuRow('cpu', m, m === S.model ? '当前模型' : '', m === S.model);
          row.onclick = () => switchModel(m);
          menu.appendChild(row);
        }
      } else {
        const row = cmpMenuRow('refresh', '拉取模型列表', 'models.fetch', false);
        row.onclick = ev => { ev.stopPropagation(); fetchModels(true); };
        menu.appendChild(row);
      }
      const setRow = cmpMenuRow('settings', '打开模型设置…', '设置 · 模型', false);
      setRow.onclick = () => { closeComposerMenu(false); openSettings('models'); };
      menu.appendChild(setRow);

      menu.appendChild(cmpMenuSep());
      menu.appendChild(cmpMenuHead('供应商'));
      if (S.providers.length) {
        for (const p of S.providers) {
          const row = cmpMenuRow('database', p.name, p.current ? '当前供应商' : (p.api_style || ''), !!p.current);
          row.onclick = () => { closeComposerMenu(false); execSlash(t, '/provider', p.name); focusInput(); };
          menu.appendChild(row);
        }
      } else {
        const row = cmpMenuRow('database', '打开供应商设置…', '', false);
        row.onclick = () => { closeComposerMenu(false); openSettings('providers'); };
        menu.appendChild(row);
      }

      menu.appendChild(cmpMenuSep());
      menu.appendChild(cmpMenuHead('思考级别'));
      for (const l of THINK_LEVELS) {
        const row = cmpMenuRow('bulb', l.name + ' (' + l.v + ')', l.desc, lv === l.v);
        row.onclick = () => { closeComposerMenu(false); execSlash(t, '/think', String(l.v)); focusInput(); };
        menu.appendChild(row);
      }
    },
  });
  autoFetchModels();
}

function autoFetchModels() {
  if (S.models.length || cmpModelFetching) return;
  fetchModels(false);
}
function fetchModels(force) {
  if (cmpModelFetching) return;
  cmpModelFetching = true;
  cmd('models.fetch', {}).then(out => {
    cmpModelFetching = false;
    if (!out || out.ok === false || !Array.isArray(out.models)) return;
    S.models = out.models;
    if (out.models.length) {
      if (force) toast('已拉取 ' + out.models.length + ' 个模型', 'ok');
      // 只有真的拿到列表才重开菜单（空列表重开会再次触发拉取，造成死循环）
      if (cmpMenu && cmpMenu.kind === 'model') reopenModelMenu();
    } else if (force) {
      toast('供应商未返回模型列表', 'bad');
    }
  });
}
function reopenModelMenu() {
  const anchor = $('#modelChip');
  closeComposerMenu(false);
  if (anchor) toggleModelMenu(anchor);
}

async function switchModel(m) {
  closeComposerMenu(false);
  if (!m) return focusInput();
  if (m === S.model) return focusInput();
  const out = await cmd('model.set', { model: m });
  if (!out || out.ok === false) return;
  S.model = m;
  renderComposer();
  if (typeof renderFoot === 'function') renderFoot();
  if (typeof renderStatLine === 'function') renderStatLine();
  toast('模型：' + m, 'ok');
  focusInput();
}

async function setSandboxMode(v) {
  closeComposerMenu(false);
  const info = CMP_SANDBOX[v] || { label: v };
  const out = await cmd('settings.set', { patch: { sandbox_mode: v } });
  if (!out || out.ok === false) return;
  S.sandbox = v;
  if (!S.settings) S.settings = {};
  S.settings.sandbox_mode = v;
  try { await resync(); } catch (e) {}
  renderComposer();
  if (typeof renderStatLine === 'function') renderStatLine();
  toast('沙箱模式：' + info.label, 'ok');
  focusInput();
}

/* ---------- I8. 斜杠面板 ------------------------------------------- */
// 面板浮在输入卡之上，高度不能顶穿 #centre 的顶边（标签栏/横幅下沿）。
// 把可用高度写进 --slash-max，CSS 用 min(360px, var(--slash-max)) 取用——
// 纯 CSS 表达不了「相对于卡片顶边到容器顶边的距离」，所以由 JS 量一次。
function layoutSlash() {
  const panel = $('#slashPanel');
  const stack = $('.composer-stack');
  const centre = $('#centre');
  if (!panel || !stack || !centre) return;
  const top = stack.getBoundingClientRect().top;
  const avail = Math.floor(top - centre.getBoundingClientRect().top - 12);
  panel.style.setProperty('--slash-max', Math.max(96, avail) + 'px');
}

function fuzzy(q, s) {
  if (!q) return 1;
  q = q.toLowerCase(); s = s.toLowerCase();
  const idx = s.indexOf(q);
  if (idx >= 0) return 100 - idx;
  let i = 0, score = 0;
  for (const ch of s) { if (ch === q[i]) { i++; score++; } }
  return i === q.length ? score : 0;
}

function slashArgItems(cmdName) {
  const c = COMMANDS.find(x => x.name === cmdName);
  if (!c || !c.ctx) return [];
  const out = [];
  const add = (label, insert, desc, run) => out.push({ label: label, insert: insert, desc: desc, run: run });
  switch (c.ctx) {
    case 'sessions':
      for (const s of S.sessions.filter(x => x.ws === S.active))
        add((s.title || shortId(s.id)).slice(0, 40), s.id, relTime(s.mtime));
      break;
    case 'models':
      add('◌ 拉取模型列表', '__fetch__', 'models.fetch');
      for (const m of S.models) add(m, m, m === S.model ? '当前' : '');
      break;
    case 'providers':
      for (const p of S.providers) add(p.name, p.name, p.current ? '当前' : (p.api_style || ''));
      break;
    case 'think':
      for (const l of THINK_LEVELS) add(l.name + ' (' + l.v + ')', String(l.v), l.desc);
      break;
    case 'sandbox':
      for (const m of SANDBOX_MODES) add(m.v, m.v, m.desc);
      break;
    case 'onoff':
      add('on', 'on', '开启'); add('off', 'off', '关闭');
      break;
    case 'theme':
      add('default', '', '默认外观（与 /export 导出的会话页同源）');
      for (const th of Theme.list()) add(th.name, th.name, th.label + (th.desc ? ' · ' + th.desc : ''));
      break;
    case 'teamwork': {
      const t2 = curTab();
      for (const j of (t2 ? t2.jobs : [])) add(j.id, j.id, j.status + ' · ' + (j.work_type || ''));
      add('run <id>', 'run ', '运行任务');
      add('resume <id>', 'resume ', '恢复任务');
      add('stop <id>', 'stop ', '停止任务');
      break;
    }
    case 'workspaces': {
      for (const w of S.workspaces) add(baseName(w.cwd), w.ws, w.cwd);
      for (const c2 of S.recentCwds) add(baseName(c2), c2, c2);
      add('＋ 打开新目录…', '__open__', 'workspace.open');
      break;
    }
    default: break;
  }
  return out;
}

function slashRowIcon(e) {
  if (e.kind === 'cmd') return CMP_CMD_ICONS[e.name] || 'command';
  if (e.kind === 'arg' && e.cmd && CMP_ARG_ICONS[e.cmd.ctx]) return CMP_ARG_ICONS[e.cmd.ctx];
  if (e.kind === 'dir') return 'folder';
  if (e.kind === 'file') return 'file';
  if (e.kind === 'sess') return 'message';
  return 'info';
}

/* 斜杠候选：指令名模糊匹配，或某条指令的参数候选 */
function slashEntries(v) {
  const sp = v.indexOf(' ');
  const token = sp < 0 ? v : v.slice(0, sp);
  const rest = sp < 0 ? '' : v.slice(sp + 1);
  let entries = [];
  let title = '指令';
  if (!rest && !v.includes(' ')) {
    const scored = COMMANDS.map(c => ({ c: c, sc: fuzzy(token.slice(1), c.name.slice(1)) }))
      .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    entries = scored.map(x => ({ kind: 'cmd', name: x.c.name, usage: x.c.usage, desc: x.c.desc, cmd: x.c }));
  } else {
    const c = COMMANDS.find(x => x.name === token);
    if (c) {
      entries = slashArgItems(c.name).map(a => Object.assign({ kind: 'arg', cmd: c }, a));
      title = c.name + ' 的参数';
    }
    if (!entries.length && c) entries.push({ kind: 'hint', desc: c.desc, cmd: c });
  }
  return { title: title, entries: entries };
}

/* ---------- I8b. @ 引用：文件 / 目录 / 会话 -------------------------
   输入行里出现「空白之后的 @…」时，同一个面板换成引用候选：
     · 文件 / 目录 → 复用 ls 工具（fs.list）逐层列举。选目录 = 继续往下翻，
       选文件 = 把相对路径写进输入框（模型可用 fs 工具读内容）；
     · 会话 → 空查询列最近会话，有查询走 sessions.search 做内容检索。
       选中时取该会话的上下文摘要（session.digest），以
         session:```…```  内容块的形式插入输入框。               */
function atTokenOf(text, caret) {
  text = String(text || '');
  let pos = (caret == null || caret < 0) ? text.length : Math.min(caret, text.length);
  let i = pos;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  const frag = text.slice(i, pos);
  if (!frag || frag[0] !== '@' || frag.length > 160) return null; // 邮箱等普通 @ 文本不触发
  return { start: i, end: pos, query: frag.slice(1) };
}

/* "src/ui/05" → { dir:"src/ui", base:"05" }：dir 交给 fs.list，base 用于过滤 */
function atSplitPath(q) {
  const i = q.lastIndexOf('/');
  return i < 0 ? { dir: '', base: q } : { dir: q.slice(0, i), base: q.slice(i + 1) };
}

function atTitle(q) {
  return q ? '@ ' + q : '@ 引用文件或会话';
}

/* 空查询时的会话候选：当前工作区在前，其余按最近使用排序 */
function atRecentSessions(t) {
  const mine = [], other = [];
  for (const s of (S.sessions || [])) {
    if (!s || !s.id) continue;
    (t && s.ws === t.ws ? mine : other).push(s);
  }
  const byTime = (a, b) => (b.mtime || 0) - (a.mtime || 0);
  return mine.sort(byTime).concat(other.sort(byTime)).slice(0, AT_SESSION_LIMIT);
}

/* 拉候选（带 140ms 防抖）：结果按 key 缓存 15s，落定后重绘面板 */
function atFetch(t, at) {
  const key = t.ws + '\u0000' + at.query;
  if (atState.key === key && (Date.now() - (atState.ts || 0)) < 15000) return;
  atState = { key: key, busy: true, files: [], sessions: [], ts: 0 };
  clearTimeout(atTimer);
  const q = at.query;
  atTimer = setTimeout(() => {
    const sp = atSplitPath(q);
    const jobs = [];
    jobs.push(api('fs.list', { ws: t.ws, path: sp.dir }).then(out => {
      if (atState.key !== key) return;
      const list = (out && out.ok !== false && Array.isArray(out.entries)) ? out.entries : [];
      const rows = [];
      for (const e of list) {
        if (!e || !e.name) continue;
        if (sp.base && !fuzzy(sp.base, e.name)) continue;
        rows.push(e);
      }
      rows.sort((a, b) => ((b.dir ? 1 : 0) - (a.dir ? 1 : 0))
        || (fuzzy(sp.base, b.name) - fuzzy(sp.base, a.name)));
      // 空查询（刚敲下 @）先给少量条目，好让下面的「最近会话」不用滚动就能看到
      atState.files = rows.slice(0, sp.base ? AT_FILE_LIMIT : 12);
    }).catch(() => {}));
    // 会话：路径形态的查询（含 /）明显是在翻目录，不去搜会话
    if (!q) atState.sessions = atRecentSessions(t);
    else if (q.indexOf('/') < 0) {
      jobs.push(api('sessions.search', { q: q }).then(out => {
        if (atState.key !== key) return;
        atState.sessions = ((out && Array.isArray(out.results)) ? out.results : []).slice(0, AT_SESSION_LIMIT);
      }).catch(() => {}));
    }
    Promise.all(jobs).then(() => {
      if (atState.key !== key) return;
      atState.busy = false;
      atState.ts = Date.now();
      if (curTab() === t) buildSlash(); // 候选到位：重绘（面板在此才真正弹出）
    });
  }, q ? 140 : 0);
}

function atCandidates(t, at) {
  atFetch(t, at);
  if (atState.key !== (t.ws + '\u0000' + at.query)) return [];
  const out = [];
  for (const e of atState.files) {
    out.push({
      kind: e.dir ? 'dir' : 'file',
      name: e.name,
      path: e.path || e.name,
      desc: e.dir ? '目录' : fmtBytes(e.size || 0),
    });
  }
  for (const s of atState.sessions) {
    const title = s.title || shortId(s.id);
    const hit = (s.hits && s.hits[0]) ? String(s.hits[0].text || '') : '';
    const snippet = hit.replace(/\s+/g, ' ').trim();
    // 命中片段与标题是同一段话（标题只是被截断了）就不再重复显示
    const same = !!snippet && (snippet === title || snippet.indexOf(title.slice(0, 16)) === 0);
    out.push({
      kind: 'sess',
      id: s.id,
      ws: s.ws || '',
      title: title,
      desc: (!same && snippet)
        ? snippet.slice(0, 90)
        : (relTime(s.mtime) + (s.ws && s.ws !== t.ws ? ' · 其他工作区' : '')),
    });
  }
  return out;
}

/* 候选渲染（斜杠 / @ 共用一套行样式，只是行内容与底部键位不同） */
function sxPaint(panel, title, entries, mode) {
  if (slashSel >= entries.length) slashSel = 0;
  if (slashSel < 0) slashSel = 0;
  panel.replaceChildren();
  const head = el('div', 'sx-head');
  head.appendChild(el('span', 'sx-title', title));
  head.appendChild(el('span', 'sx-count', String(entries.length)));
  panel.appendChild(head);

  const list = el('div', 'sx-list');
  panel._rows = [];
  entries.forEach((e, i) => {
    const row = el('div', 'sx-row' + (i === slashSel ? ' sel' : '') + (mode === 'at' ? ' at' : ''));
    row.setAttribute('role', 'option');
    const ico = el('span', 'sx-ico');
    ico.innerHTML = iconHtml(slashRowIcon(e));
    row.appendChild(ico);
    const main = el('span', 'sx-main');
    if (e.kind === 'cmd') {
      main.appendChild(el('span', 'sx-name', e.name));
      const usage = String(e.usage || '').replace(e.name, '').trim();
      if (usage) main.appendChild(el('span', 'sx-usage', usage));
    } else if (e.kind === 'arg') {
      main.appendChild(el('span', 'sx-name', e.label));
      if (e.insert && e.insert !== e.label) main.appendChild(el('span', 'sx-usage', String(e.insert).slice(0, 24)));
    } else if (e.kind === 'file' || e.kind === 'dir') {
      // 表头已经写明当前目录，行里只留名字（目录带尾斜杠），不再重复整条路径
      main.appendChild(el('span', 'sx-name', e.name + (e.kind === 'dir' ? '/' : '')));
    } else if (e.kind === 'sess') {
      main.appendChild(el('span', 'sx-name sx-sess', e.title));
      main.appendChild(el('span', 'sx-tag', '会话'));
    } else {
      main.appendChild(el('span', 'sx-name', '说明'));
    }
    row.appendChild(main);
    if (e.desc) row.appendChild(el('span', 'sx-desc trunc', e.desc));
    if (e.kind !== 'hint' || e.cmd) row.onclick = () => { slashSel = i; applySlash(entries[i]); };
    list.appendChild(row);
    panel._rows.push(row);
  });
  panel.appendChild(list);

  const foot = el('div', 'sx-foot');
  foot.innerHTML = '<span class="sx-k"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>'
    + (mode === 'at'
      ? '<span class="sx-k"><kbd>Tab</kbd><kbd>Enter</kbd> 插入</span>'
      : '<span class="sx-k"><kbd>Tab</kbd> 补全</span><span class="sx-k"><kbd>Enter</kbd> 执行</span>')
    + '<span class="sx-k"><kbd>Esc</kbd> 关闭</span>';
  panel.appendChild(foot);

  panel.scrollTop = 0; // 换了候选列表就从顶部看起（否则沿用上一轮的滚动位置）
  panel._mode = mode;
  panel.classList.add('show');
  panel._entries = entries;
  layoutSlash();
  moveSlashSel(0);
}

function buildSlash(forceClose) {
  const panel = $('#slashPanel');
  if (!panel) return;
  const t = curTab();
  if (!t) return closeSlash();
  // team 模式下输入行是隐藏的（换成工作流编辑器），补全面板无从对应，
  // 留着只会是一块浮在工作流编辑器上、关不掉的死面板
  if (forceClose || t.composer.mode === 'team') return closeSlash();
  const v = t.composer.text || '';
  if (v && v[0] === '/' && v.indexOf('\n') < 0) {
    const r = slashEntries(v);
    if (!r.entries.length) return closeSlash();
    return sxPaint(panel, r.title, r.entries, 'slash');
  }
  const ta = $('#ta');
  const at = atTokenOf(v, ta ? ta.selectionStart : v.length);
  if (!at) return closeSlash();
  const entries = atCandidates(t, at);
  if (!entries.length) return closeSlash(); // 候选还在路上：落定后由 atFetch 回调重绘
  panel._at = at;
  sxPaint(panel, atTitle(at.query), entries, 'at');
}

function moveSlashSel(delta) {
  const panel = $('#slashPanel');
  if (!panel) return;
  const entries = panel._entries || [];
  if (!entries.length) return;
  slashSel = ((slashSel + delta) % entries.length + entries.length) % entries.length;
  const rows = panel._rows || [];
  rows.forEach((r, i) => r.classList.toggle('sel', i === slashSel));
  const cur = rows[slashSel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  const list = panel.querySelector('.sx-list');
  if (list && rows[slashSel] && list.scrollIntoView) {
    // scrollIntoView 在嵌套滚动容器里可能带动整页：面板是真滚动容器，只滚它
    const top = rows[slashSel].offsetTop - 8;
    const bot = top + rows[slashSel].offsetHeight + 8;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
  }
}

/* 接受一条 @ 候选。dir → 继续往下翻目录；file → 写入相对路径；
   sess → 取该会话的上下文摘要，作为 session:```…``` 内容块插入。 */
function applyAt(t, e) {
  const panel = $('#slashPanel');
  const at = (panel && panel._at) || atTokenOf(t.composer.text || '', null);
  closeSlash();
  if (!at) return;
  if (e.kind === 'dir') return atSplice(t, at, '@' + String(e.path || e.name).replace(/\/$/, '') + '/');
  if (e.kind === 'file') return atSplice(t, at, '@' + String(e.path || e.name) + ' ');
  if (e.kind === 'sess') return atInsertSession(t, at, e);
}

/* 把光标处的 @ 片段换成 insert：插完把插入符放到插入内容之后并重算面板
   （目录补全以 / 结尾 → 面板继续列出该目录；文件补全带空格 → 面板收起） */
function atSplice(t, at, insert) {
  const cur = t.composer.text || '';
  let start = at.start, end = at.end;
  if (cur.slice(start, end)[0] !== '@') {
    // 等待异步结果期间文本变了：退化成「在当前位置插入」，不破坏用户输入
    const ta0 = $('#ta');
    const p = clamp(ta0 ? ta0.selectionStart : cur.length, 0, cur.length);
    start = end = p;
  }
  const next = cur.slice(0, start) + insert + cur.slice(end);
  syncComposerText(next);
  const ta = $('#ta');
  const pos = start + insert.length;
  if (ta) { ta.focus(); try { ta.setSelectionRange(pos, pos); } catch (err) {} }
  buildSlash();
}

/* 会话引用：向核心要一份上下文摘要（已有压缩摘要优先，否则现场摘录），
   折成 markdown 代码块插入。形如：
     session:```
     会话「标题」· N 条消息 · 已有压缩摘要
     - 用户：…
     ```                                                        */
async function atInsertSession(t, at, e) {
  // 会话可能来自任意工作区：用会话自己的 ws（留空则由核心从 id 反推），
  // 不能硬塞当前标签页的 ws —— 否则跨工作区引用会被判「不属于该工作区」
  const out = await api('session.digest', { ws: e.ws || '', id: e.id });
  if (!out || out.ok === false) {
    toast((out && out.error) || '读取会话摘要失败', 'bad');
    return;
  }
  let body = String(out.summary || '').trim();
  if (!body) { toast('该会话没有可引用的上下文', 'bad'); return; }
  // 摘要里若自带三连反引号，会把外层代码块提前结束：打散它
  body = body.replace(/```/g, '``\u200b`');
  const head = '会话「' + (out.title || e.title || shortId(e.id)) + '」· '
    + Number(out.msgs || 0) + ' 条消息 · '
    + (out.source === 'summary' ? '已有压缩摘要' : '压缩摘录');
  atSplice(t, at, 'session:```\n' + head + '\n' + body + '\n```\n');
}

function applySlash(e) {
  const t = curTab();
  if (!t) return;
  if (e.kind === 'file' || e.kind === 'dir' || e.kind === 'sess') { applyAt(t, e); return; }
  const panel = $('#slashPanel');
  const entries = (panel && panel._entries) || [];
  if (e.kind === 'cmd') {
    closeSlash();
    if (e.cmd.run) { syncComposerText(''); e.cmd.run(t); return; }
    if (e.cmd.ctx) { syncComposerText(e.name + ' '); buildSlash(); focusInput(); return; }
    syncComposerText(''); return;
  }
  if (e.kind === 'hint') { closeSlash(); syncComposerText(''); execSlash(t, e.cmd.name, ''); return; }
  // arg
  closeSlash();
  if (e.run) { syncComposerText(''); e.run(t); return; }
  if (e.insert === '__fetch__') {
    fetchModels(true);
    syncComposerText('');
    return;
  }
  if (e.insert === '__open__') { syncComposerText(''); openWsDialog(); return; }
  const cur = t.composer.text || '';
  const sp = cur.indexOf(' ');
  const head = sp < 0 ? cur : cur.slice(0, sp);
  if (e.cmd && e.cmd.name === '/teamwork' && ['run ', 'resume ', 'stop '].includes(e.insert)) {
    syncComposerText(e.cmd.name + ' ' + e.insert);
    buildSlash(); focusInput(); return;
  }
  const full = head + ' ' + (e.insert || e.label);
  // 单参数指令：直接执行并清空输入框（是否生效由 execSlash 的 toast 提示）；
  // 其余（多段指令的中间补全）保留补全文本，等下一步继续选
  if (['/model', '/provider', '/think', '/sandbox', '/tools', '/autoallow', '/compact', '/theme', '/session', '/workspace'].includes(head)
      && e.insert && !String(e.insert).endsWith(' ')) {
    syncComposerText('');
    execSlash(t, head, String(e.insert));
    return;
  }
  syncComposerText(full + ' ');
  focusInput();
}

/* 斜杠指令的执行语义（保留旧行为）：
     exec     已写完的指令（/cmd 或 /cmd arg）——前端直接执行，绝不作为消息发给模型
     complete 裸指令名且需要参数——先补全出参数候选
     message  其余——普通消息
   Enter 在面板开着时走 enterSlash：已写完整的指令按「用户输入」执行，
   不再照高亮候选执行；↑↓ 移动高亮，Tab / 点击接受候选（补全）。 */
function thinkLevelOf(s) {
  s = String(s || '').trim().toLowerCase();
  if (/^[0-4]$/.test(s)) return Number(s);
  const alias = { minimal: 1, medium: 2, med: 2, on: 1, maximum: 4 };
  if (Object.prototype.hasOwnProperty.call(alias, s)) return alias[s];
  const hit = THINK_LEVELS.find(l => l.name === s);
  return hit ? hit.v : null;
}
function onoffOf(s) {
  s = String(s || '').trim().toLowerCase();
  return (s === 'on') ? true : (s === 'off' ? false : null);
}
function slashIntent(text) {
  const v = String(text || '').trim();
  if (!v || v[0] !== '/') return { kind: 'message' };
  const sp = v.indexOf(' ');
  const name = sp < 0 ? v : v.slice(0, sp);
  const arg = sp < 0 ? '' : v.slice(sp + 1).trim();
  const c = COMMANDS.find(x => x.name === name);
  if (!c) return { kind: 'message' };
  if (!arg) return c.ctx ? { kind: 'complete', c: c, name: name, arg: arg } : { kind: 'exec', c: c, name: name, arg: arg };
  return c.ctx ? { kind: 'exec', c: c, name: name, arg: arg } : { kind: 'message' };
}
function runSlash(t, it) {
  if (it.c.ctx) return execSlash(t, it.name, it.arg);
  if (it.c.run) return it.c.run(t);
  return undefined;
}
function enterSlash() {
  const t = curTab();
  if (!t) return;
  const panel = $('#slashPanel');
  const entries = (panel && panel._entries) || [];
  if (panel && panel._mode === 'at') { // @ 引用面板：Enter = 接受当前候选
    if (entries[slashSel]) applySlash(entries[slashSel]);
    return;
  }
  const v = (t.composer.text || '').trim();
  const it = slashIntent(v);
  if (it.kind === 'exec') { // 已写完的指令：按输入执行
    closeSlash();
    syncComposerText('');
    runSlash(t, it);
    return;
  }
  if (it.kind === 'complete' || v.indexOf(' ') < 0) { // 半成品：接受当前候选补全
    if (entries[slashSel]) applySlash(entries[slashSel]);
    return;
  }
  // 非指令形态（如 "/clear 请忽略"）：关面板，交回普通发送
  closeSlash();
  sendCurrent();
}

// 设置类指令的统一收尾：成功 → resync + 结果 toast；失败 → 交给 cmd 的错误提示
function afterSet(out, msg) {
  if (!out || out.ok === false) return;
  return resync().then(() => {
    renderComposer();
    toast(msg, 'ok');
  });
}

async function execSlash(t, name, arg) {
  arg = (arg || '').trim();
  switch (name) {
    case '/new': return cmd('session.new', { ws: t.ws }).then(resync);
    case '/clear': return cmd('session.clear', { ws: t.ws }).then(resync);
    case '/session': if (arg) return cmd('session.select', { ws: t.ws, id: arg }).then(resync); break;
    case '/model':
      if (!arg) { openSettings('models'); return; }
      return cmd('model.set', { model: arg }).then(out => {
        if (out && out.ok === false) return;
        S.model = arg;
        renderComposer();
        if (typeof renderFoot === 'function') renderFoot();
        if (typeof renderStatLine === 'function') renderStatLine();
        toast('模型已切换', 'ok');
      });
    case '/provider':
      if (arg) return cmd('providers.select', { name: arg }).then(out => {
        if (out && out.ok === false) return;
        return afterSet(out, '供应商：' + arg);
      });
      break;
    case '/think': {
      const lv = thinkLevelOf(arg);
      if (lv == null) { toast('无效的思考级别：' + arg + '（0-4 或 ' + THINK_LEVELS.map(l => l.name).join('/') + '）', 'bad'); break; }
      const l = THINK_LEVELS[lv];
      return cmd('settings.set', { patch: { think_level: lv } }).then(out => {
        if (!out || out.ok === false) return;
        if (!S.settings) S.settings = {};
        S.settings.think_level = lv;
        return afterSet(out, '思考级别：' + l.name + ' (' + l.v + ') · ' + l.desc);
      });
    }
    case '/tools': {
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/tools on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { tools: on } }).then(out => {
        if (out && out.ok !== false) S.tools = on;
        return afterSet(out, '工具调用：' + (on ? '开' : '关'));
      });
    }
    case '/sandbox': {
      const m = SANDBOX_MODES.find(x => x.v === arg);
      if (!m) { toast('无效的沙箱模式：' + arg + '（' + SANDBOX_MODES.map(x => x.v).join(' / ') + '）', 'bad'); break; }
      return setSandboxMode(m.v);
    }
    case '/autoallow': {
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/autoallow on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { autoallow: on } }).then(out => afterSet(out, '自动放行：' + (on ? '开' : '关')));
    }
    case '/compact': {
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/compact on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { compact_auto: on } }).then(out => afterSet(out, '自动压缩：' + (on ? '开' : '关')));
    }
    case '/stop': return cmd('stop', { ws: t.ws });
    case '/theme': {
      if (!arg) {
        if (!Theme.list().length) { toast('主题：默认（无第三方主题）', 'ok'); break; }
        Theme.cycle();
        const c = Theme.current();
        toast('主题：' + (c ? c.label : '默认'), 'ok');
        break;
      }
      if (arg === 'default') { Theme.set(''); toast('主题：默认', 'ok'); break; }
      const th = Theme.list().find(x => x.name === arg);
      if (!th) { toast('未知主题：' + arg + '（可用：default' + (Theme.list().length ? '、' + Theme.list().map(x => x.name).join('、') : '') + '）', 'bad'); break; }
      Theme.set(arg); toast('主题：' + th.label, 'ok');
      break;
    }
    case '/workspace':
      if (arg) { if (arg.startsWith('/') || /^[A-Za-z]:/.test(arg)) return openWorkspace(arg); return cmd('workspace.activate', { ws: arg }).then(resync); }
      openWsDialog(); break;
    case '/teamwork': {
      const m = arg.split(/\s+/);
      if (m[0] === 'run' || m[0] === 'resume' || m[0] === 'stop') return cmd('teamwork.' + m[0], { ws: t.ws, id: m[1] || '' }).then(() => refreshTeamworkNow(t.ws, false, true));
      if (arg) return cmd('teamwork.run', { ws: t.ws, id: arg }).then(() => refreshTeamworkNow(t.ws, false, true));
      openDock('teamwork'); break;
    }
    case '/notice': openDock('notices'); refreshNotices(t.ws); break;
    default: break;
  }
}

/* ---------- I9. Teamwork 工作流编辑器 ------------------------------ */
function renderWorkflowEditor(t) {
  let host = $('#teamEditor');
  if (!host) {
    host = el('div', 'cmp-team');
    host.id = 'teamEditor';
    const card = $('#composerInner');
    if (card) card.appendChild(host);
  }
  const wf = t.composer.workflow || (t.composer.workflow = defaultWorkflow());
  host.replaceChildren();

  let stageCount = wf.stages.length, agentCount = 0;
  for (const st of wf.stages) agentCount += (st.agents || []).length;

  const head = el('div', 'tw-head');
  const ttl = el('span', 'tw-title');
  const ttlIco = el('span', 'tw-title-ico');
  ttlIco.innerHTML = iconHtml('users');
  ttl.appendChild(ttlIco);
  ttl.appendChild(el('span', null, '团队工作流'));
  ttl.appendChild(el('span', 'tw-title-sub', stageCount + ' 阶段 · ' + agentCount + ' 子代理'));
  head.appendChild(ttl);
  head.appendChild(el('span', 'grow'));
  const b1 = el('button', 'btn sm');
  b1.type = 'button';
  b1.textContent = '仅创建';
  b1.onclick = () => submitWorkflow(t, 'create');
  const b2 = el('button', 'btn sm accent');
  b2.type = 'button';
  b2.textContent = '创建并运行';
  b2.onclick = () => submitWorkflow(t, 'run');
  head.appendChild(b1);
  head.appendChild(b2);
  host.appendChild(head);

  const scroll = el('div', 'tw-scroll');
  host.appendChild(scroll);

  /* 目标描述：让 LLM 规划整条工作流 */
  const goalWrap = el('div', 'tw-goal');
  const goalLbl = el('label', null, '目标描述');
  goalLbl.htmlFor = 'twGoal';
  goalWrap.appendChild(goalLbl);
  const goal = el('textarea');
  goal.rows = 2;
  goal.id = 'twGoal';
  goal.placeholder = '例如：调研本项目的事件总线并给出重构建议，最后写一份报告';
  goal.value = t.composer.goal || '';
  goal.oninput = () => { t.composer.goal = goal.value; };
  goalWrap.appendChild(goal);
  const planRow = el('div', 'tw-goal-row');
  const planBtn = el('button', 'btn sm');
  planBtn.type = 'button';
  planBtn.innerHTML = iconHtml('sparkles', 'sm') + '<span>让 LLM 规划</span>';
  planBtn.title = '发送目标，并提示模型使用 teamwork（tw）工具拆解工作流';
  planBtn.onclick = () => {
    const g = (t.composer.goal || '').trim();
    if (!g) { toast('请先填写目标描述', 'bad'); return; }
    const msg = g + '\n\n请使用 teamwork（tw）工具把上述目标拆解为一个多阶段、可按需并行的团队工作流，' +
      '先创建任务（create），再按需运行（run），完成后汇总各子代理报告。';
    t.composer.text = '';
    const ta = $('#ta');
    if (ta) ta.value = '';
    const optimistic = { id: uid(), role: 'user', text: msg, ts: nowSec() };
    t.msgs.push(optimistic); markChat(t.ws);
    cmd('send', { ws: t.ws, text: msg });
    toast('已发送规划请求', 'ok');
  };
  planRow.appendChild(planBtn);
  planRow.appendChild(el('span', 'tiny dim', '发送目标，并提示模型用 tw 工具拆解'));
  goalWrap.appendChild(planRow);
  scroll.appendChild(goalWrap);

  const stagesBox = el('div', 'tw-stages');
  wf.stages.forEach((st, si) => stagesBox.appendChild(renderStageEditor(t, wf, st, si, stagesBox)));
  scroll.appendChild(stagesBox);

  const addStage = el('button', 'btn sm tw-add');
  addStage.type = 'button';
  addStage.innerHTML = iconHtml('plus', 'sm') + '<span>添加阶段</span>';
  addStage.onclick = () => {
    wf.stages.push({ name: '阶段 ' + (wf.stages.length + 1), mode: 'serial', gate: false, agents: [{ works: '', name: '', model: '', think: 'off' }] });
    renderWorkflowEditor(t);
  };
  scroll.appendChild(addStage);
}

function renderStageEditor(t, wf, st, si, parent) {
  const card = el('div', 'tw-stage');
  const hd = el('div', 'tw-stage-head');
  hd.appendChild(el('span', 'pill accent', '阶段 ' + (si + 1)));
  const nm = el('input');
  nm.type = 'text';
  nm.className = 'tw-name';
  nm.value = st.name || '';
  nm.placeholder = '阶段名称';
  nm.oninput = () => { st.name = nm.value; };
  hd.appendChild(nm);

  const seg = el('div', 'tw-seg');
  const mk = (val, txt) => {
    const b = el('button', st.mode === val ? 'on' : '', txt);
    b.type = 'button';
    b.onclick = () => { st.mode = val; renderWorkflowEditor(t); };
    return b;
  };
  seg.appendChild(mk('serial', '串行'));
  seg.appendChild(mk('parallel', '并行'));
  hd.appendChild(seg);

  const gateLbl = el('label', 'tw-gate');
  const gate = el('input');
  gate.type = 'checkbox';
  gate.checked = !!st.gate;
  gate.onchange = () => { st.gate = gate.checked; };
  gateLbl.appendChild(gate);
  gateLbl.appendChild(el('span', null, '关卡'));
  hd.appendChild(gateLbl);

  const del = el('button', 'icon-btn sm');
  del.type = 'button';
  del.title = '删除阶段';
  del.innerHTML = iconHtml('trash');
  del.onclick = () => { wf.stages.splice(si, 1); renderWorkflowEditor(t); };
  hd.appendChild(del);
  card.appendChild(hd);

  const agents = el('div', 'tw-agents');
  (st.agents || []).forEach((ag, ai) => {
    const row = el('div', 'tw-agent');
    const works = el('textarea');
    works.className = 'tw-works';
    works.rows = 1;
    works.value = ag.works || '';
    works.placeholder = '子代理任务（works）';
    works.oninput = () => {
      ag.works = works.value;
      works.style.height = 'auto';
      works.style.height = Math.min(88, works.scrollHeight) + 'px';
    };
    row.appendChild(works);
    const anm = el('input');
    anm.type = 'text';
    anm.className = 'tw-aname';
    anm.value = ag.name || '';
    anm.placeholder = '名称';
    anm.oninput = () => { ag.name = anm.value; };
    row.appendChild(anm);
    const amd = el('input');
    amd.type = 'text';
    amd.className = 'tw-amodel';
    amd.value = ag.model || '';
    amd.placeholder = '模型（可空）';
    amd.oninput = () => { ag.model = amd.value; };
    row.appendChild(amd);
    const thk = el('select');
    thk.className = 'tw-athink';
    for (const l of THINK_LEVELS) {
      const o = el('option', null, l.name);
      o.value = l.name;
      if ((ag.think || 'off') === l.name) o.selected = true;
      thk.appendChild(o);
    }
    thk.onchange = () => { ag.think = thk.value; };
    row.appendChild(thk);
    const ax = el('button', 'icon-btn sm');
    ax.type = 'button';
    ax.title = '删除子代理';
    ax.innerHTML = iconHtml('x');
    ax.onclick = () => { st.agents.splice(ai, 1); renderWorkflowEditor(t); };
    row.appendChild(ax);
    agents.appendChild(row);
  });
  card.appendChild(agents);

  const addAg = el('button', 'btn ghost sm tw-add-agent');
  addAg.type = 'button';
  addAg.innerHTML = iconHtml('plus', 'sm') + '<span>子代理</span>';
  addAg.onclick = () => {
    (st.agents = st.agents || []).push({ works: '', name: '', model: '', think: 'off' });
    renderWorkflowEditor(t);
  };
  card.appendChild(addAg);
  return card;
}

/* Teamwork 面板刷新：03-teamwork.js 的 twRefresh 会打 jobsAt 时间戳并重算
   轮询表；保留 refreshTeamwork fallback，避免文件合并顺序变化时提交路径失效。 */
function refreshTeamworkNow(ws, quiet, force) {
  if (typeof twRefresh === 'function') return twRefresh(ws, quiet, force);
  return refreshTeamwork(ws, quiet);
}

async function submitWorkflow(t, mode) {
  const wf = t.composer.workflow || defaultWorkflow();
  const stages = [];
  for (const st of wf.stages) {
    const agents = [];
    for (const ag of (st.agents || [])) {
      if (!ag.works || !ag.works.trim()) continue;
      const a = { works: ag.works.trim() };
      if (ag.name) a.name = ag.name;
      if (ag.model) a.model = ag.model;
      if (ag.think) a.think = ag.think;
      agents.push(a);
    }
    if (!agents.length) continue;
    const s = { agents: agents };
    if (st.name) s.name = st.name;
    s.mode = st.mode || 'serial';
    if (st.gate) s.gate = true;
    stages.push(s);
  }
  if (!stages.length) { toast('至少需要一个带任务的阶段', 'bad'); return; }
  const out = await cmd('teamwork.create', { ws: t.ws, workflow: { stages: stages }, work_type: wf.work_type || 'serial' });
  if (!out || out.ok === false) return;
  toast('已创建任务 ' + out.job, 'ok');
  if (mode === 'run') {
    const r = await cmd('teamwork.run', { ws: t.ws, id: out.job });
    if (r && r.ok !== false) toast('任务已运行', 'ok');
  }
  openDock('teamwork');
  // 提交后立刻按磁盘重拉：create/run 的落盘与面板首帧存在竞态，
  // 旧实现只 setTimeout(500) 猜一次，慢盘/大工作区时会看不到新卡片。
  await refreshTeamworkNow(t.ws, false, true);
  // 再补两次：后端 store 写入/状态翻转有延迟，保证卡片状态最终正确
  setTimeout(() => { if (S.tabs.get(t.ws) === t) refreshTeamworkNow(t.ws, true); }, 500);
  setTimeout(() => { if (S.tabs.get(t.ws) === t) refreshTeamworkNow(t.ws, true); }, 1500);
}

/* ---------- I10. 对外接口（boot 优先调用 ComposerUI.init） ---------- */
const ComposerUI = {
  init() {
    // 幂等：重复调用（boot 与懒加载兜底都可能在同一次启动里触发）不重建 DOM，
    // 否则会掉一遍事件绑定（新节点没绑上，输入/回车全部失效）
    const host = cmpHost();
    if (host && host.__cmpBuilt && $('#ta')) {
      bindComposer();
      this.render();
      if (typeof renderStatLine === 'function') renderStatLine();
      return true;
    }
    if (!buildComposerDom()) return false;
    bindComposer();
    this.render();
    if (typeof renderStatLine === 'function') renderStatLine();
    return true;
  },
  render() { renderComposer(); },
  refresh() { renderComposer(); if (typeof renderStatLine === 'function') renderStatLine(); },
  focus() { focusInput(); },
  setMode(mode) { setComposerMode(mode); },
  openModelMenu() { const a = $('#modelChip'); if (a) toggleModelMenu(a); },
  closeMenus() { closeComposerMenu(false); closeSlash(); },
};
window.ComposerUI = ComposerUI;
