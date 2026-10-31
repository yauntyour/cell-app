/* =====================================================================
   I. 输入栏（Composer）· DSH 式悬浮输入卡
   ---------------------------------------------------------------------
   结构（全部由 ComposerUI.init() 建在骨架的 #composerInner 内）：
     #composerInner  ← 卡片本体（液态玻璃：半透明 + backdrop-filter + 高光/折射）
       #inputBox     ← 编辑区（附件区 + textarea），拖拽落点
         #attachWrap ← 附件区（在编辑区上方，可多行折行，卡片随之变高）
           #attachBar（#btnPickFile）
           #chips
         #ta
         #fileInput
       #teamEditor   ← Teamwork 工作流编辑器（team 模式显示）
       .cmp-bar      ← 底部工具条（卡片下方不再有状态行）：
         左：+ 添加附件 · 模式 · 访问权限 · 工具开关
         右：供应商 · 模型 · 思考强度 · accent 发送钮

   兼容契约（docs/ui-redesign.md §7.1）：保留全部旧全局函数
   renderComposer / syncComposerInput / setComposerMode / sendCurrent /
   focusInput / buildSlash / renderChips / syncComposerText /
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
  '/skills': 'sparkles', '/skill': 'layers',
  '/save': 'mark', '/export': 'download', '/reload': 'refresh', '/usages': 'layers',
  '/provide': 'database', '/provides': 'database', '/sessions': 'message', '/models': 'cpu',
  '/notices': 'bell', '/teamworks': 'users', '/tool': 'settings', '/saved': 'archive',
  '/notice': 'bell', '/archive': 'archive', '/workspace': 'folder', '/theme': 'eye',
  '/help': 'info',
};
const CMP_ARG_ICONS = {
  sessions: 'message', models: 'cpu', providers: 'database', think: 'bulb',
  sandbox: 'terminal', onoff: 'check', theme: 'eye', teamwork: 'users', workspaces: 'folder',
  compact: 'archive', skills: 'layers', export: 'download',
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

/* @ 引用面板：与斜杠面板共用同一个浮层（#slashPanel），只是候选来源不同。
   候选分两页，表头就是页签（←→ 或鼠标点击翻页）：
     · 文件页 → 走 ls 工具（fs.list）逐层列举；
     · 会话页 → 走 sessions.search 做检索，选中时先取它的上下文摘要
       （session.digest），再以 session:```…``` 的代码块形式写进输入框。 */
const AT_FILE_LIMIT = 40;
const AT_SESSION_LIMIT = 8;
const AT_PAGES = [
  { page: 'files', label: '文件', icon: 'folder' },
  { page: 'sessions', label: '会话', icon: 'message' },
];
let atState = { key: '', busy: false, files: [], sessions: [] };
let atTimer = 0;
let atPage = 'files';                        // 当前页
let atPinned = false;                        // 用户手动翻过页：不再自动跟随
const atSel = { files: 0, sessions: 0 };     // 两页各自记住选中的行

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

  /* 工具调用开关：紧挨访问权限（两者都是「这一回合能做什么」的边界），
     点一下直接开/关（弹菜单反而多一步），状态用文字 + 小圆点表达 */
  const toolsChip = el('button', 'cmp-chip cmp-chip-tools');
  toolsChip.id = 'toolsChip';
  toolsChip.type = 'button';
  toolsChip.setAttribute('aria-pressed', 'true');
  left.appendChild(toolsChip);

  const right = el('div', 'cmp-bar-r');
  const providerChip = el('button', 'cmp-chip cmp-chip-prov');
  providerChip.id = 'providerChip';
  providerChip.type = 'button';
  providerChip.title = '模型供应商';
  providerChip.setAttribute('aria-haspopup', 'menu');
  right.appendChild(providerChip);

  const modelChip = el('button', 'cmp-chip cmp-chip-model');
  modelChip.id = 'modelChip';
  modelChip.type = 'button';
  modelChip.title = '模型';
  modelChip.setAttribute('aria-haspopup', 'menu');
  right.appendChild(modelChip);

  const thinkChip = el('button', 'cmp-chip cmp-chip-think');
  thinkChip.id = 'thinkChip';
  thinkChip.type = 'button';
  thinkChip.title = '思考强度';
  thinkChip.setAttribute('aria-haspopup', 'menu');
  right.appendChild(thinkChip);

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

  /* 卡片下方不再有状态行：模型 / 供应商 / 访问权限 / 工具开关都已经在工具条里，
     再挂一行小字只会重复（连接状态在左侧栏底部的账户行，断线另有浮动横幅）。 */
  const stack = cmpStack(host);
  if (stack) {
    const stale = stack.querySelector('.cmp-stat, .cstat');
    if (stale && !host.contains(stale)) stale.remove();
  }

  ensureSlashPanel();
  // 旧版本用 .glass-refract 走 SVG 折射滤镜；升级后残留在 DOM 上的类要清掉，
  // 否则它会盖掉 CSS 里的 backdrop-filter:blur()（见下面 I1b 的说明）
  host.classList.remove('glass-refract');
  host.__cmpBuilt = true;
  return true;
}

/* ---------- I1b. 液态玻璃：磨砂强度 -----------------------------------
   ⚠️ 历史包袱（2026-10-31 排查）：这里原来用 SVG 滤镜做「边缘折射」——
   圆角矩形 SDF 算位移贴图 → feImage + feDisplacementMap → 通过
   backdrop-filter:url(#cmp-glass-ref) 作用在真实背景上。
   Chromium / WebView2 对 url() **只做解析检测**（CSS.supports() 返回 true），
   渲染时整条滤镜被丢掉，于是卡片既没有模糊也没有折射：背后文字原样透上来
   盖在占位符上（看着像"上界没固定"），两端还留下一道位移硬缝（"没渲染好"）。
   所以现在只保留纯 CSS 方案：磨砂 = backdrop-filter:blur()，
   边缘厚度与圆滑亮边 = #composerInner::before 的渐变环（见 05b-composer.css）。
   这里唯一还留给用户调的是「磨砂强度」，写进 --cmp-glass-blur。 */
const GLASS = {
  t: 0.6,             // 透明度偏好（0=清晰 … 1=磨砂最强），见 applyGlassPref
  blur: 9.3,          // 高斯模糊（CSS px）：由透明度推出来
};

/* 玻璃观感偏好（本机 localStorage，不进后端设置 —— 跟主题、动画等级一样只在
   这台机器的浏览器里生效）。材质无色：只有白/黑透明度层次，不带任何颜色，
   唯一随偏好变化的是高斯模糊强度 —— 越"磨砂"越糊。 */
const GLASS_PREF_KEY = 'cell.glass';
function glassBlur(t) { return 20 * Math.pow(Math.min(1, Math.max(0, t)), 1.5); }

function loadGlassPref() {
  let t = GLASS.t;
  try {
    const v = Number((JSON.parse(localStorage.getItem(GLASS_PREF_KEY) || '{}') || {}).t);
    if (isFinite(v)) t = v;
  } catch (e) {}
  applyGlassPref(t, true);
}
/* 立即生效：只改一个 CSS 变量，卡片与卡内控件共用它 */
function applyGlassPref(t, silent) {
  if (t != null) GLASS.t = Math.min(1, Math.max(0, Number(t) || 0));
  const px = glassBlur(GLASS.t);
  GLASS.blur = px;
  document.documentElement.style.setProperty('--cmp-glass-blur', px.toFixed(2) + 'px');
}
function setGlassPref(t) {
  applyGlassPref(t, false);
  try { localStorage.setItem(GLASS_PREF_KEY, JSON.stringify({ t: Number(GLASS.t.toFixed(3)) })); } catch (e) {}
}
window.setGlassTransparency = pct => setGlassPref((Number(pct) || 0) / 100);
loadGlassPref();

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
  const toolsChip = $('#toolsChip');
  if (toolsChip) toolsChip.addEventListener('click', () => toggleTools());
  const providerChip = $('#providerChip');
  if (providerChip) providerChip.addEventListener('click', () => toggleProviderMenu(providerChip));
  const modelChip = $('#modelChip');
  if (modelChip) modelChip.addEventListener('click', () => toggleModelMenu(modelChip));
  const thinkChip = $('#thinkChip');
  if (thinkChip) thinkChip.addEventListener('click', () => toggleThinkLevelMenu(thinkChip));

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
  if (typeof ResizeObserver !== 'undefined') {
    // 回调里同步改类名会再次改变被观察元素的大小，Chromium 因此报
    // "ResizeObserver loop completed with undelivered notifications"；
    // 延到下一帧处理即可（终端面板改变宽度时会命中这条路）
    const ro = new ResizeObserver(() => window.requestAnimationFrame(applyComposerWidthClass));
    ro.observe(host);
    host.__cmpRO = ro;
    // 卡片高度/位置上界一变（拖手柄、Teamwork 模式、72vh 限高、hero 态），
    // 「回到底部」就重新贴一次 —— 它按卡片实测矩形定位，不读 --composer-h
    if (typeof syncJumpAnchors === 'function') {
      new ResizeObserver(() => window.requestAnimationFrame(() => {
        try { syncJumpAnchors(); } catch (e) {}
      })).observe(host);
    }
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

/* 宽度自适应：chip 里的文字不再被压成「文…」——先量「按自然宽度排下来要多少
   地方」，放不下就把文字标签收成图标（.cmp-narrow），还放不下再缩短模型名
   （.cmp-tiny）。比媒体查询准：分栏开合 / 侧栏拖宽 / 抽屉展开都会改变主区宽度，
   而供应商名、模型名的长度本身也会变（换模型后要重新量一次）。 */
function barSpace(node) {
  const cs = getComputedStyle(node);
  const gap = parseFloat(cs.columnGap || cs.gap) || 0;
  let sum = 0, n = 0;
  for (const c of node.children) {
    if (!c || c.hidden || c.offsetWidth === 0) continue;
    sum += c.offsetWidth; n++;
  }
  return sum + Math.max(0, n - 1) * gap;
}
function composerOverflow(host) {
  const bar = host.querySelector('.cmp-bar');
  if (!bar || !bar.clientWidth) return false;
  const l = bar.querySelector('.cmp-bar-l'), r = bar.querySelector('.cmp-bar-r');
  const gap = parseFloat(getComputedStyle(bar).columnGap || getComputedStyle(bar).gap) || 0;
  // 两个分组的自然宽度 + 组间间距 > 工具条可用宽度 → 该收标签了
  return barSpace(l) + gap + barSpace(r) > bar.clientWidth + 1;
}
/* 宽度自适应三档（CSS 里各档做了什么）：snug 收装饰 → narrow 收文字标签 →
   tiny 压模型名。放得下就停在最小档，避免「明明够宽还把文字藏掉」。 */
const CMP_TIERS = ['cmp-snug', 'cmp-narrow', 'cmp-tiny'];
function applyComposerWidthClass() {
  const host = $('#composerInner');
  if (!host) return;
  host.classList.remove(...CMP_TIERS);
  for (const tier of CMP_TIERS) {
    if (!composerOverflow(host)) break;
    host.classList.add(tier);
  }
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
  // @ 面板当前页是空态（只有一行灰字提示）：Enter 不拦，照常把这段文本发出去
  const atEmptyPage = !!(open && panel._mode === 'at'
    && entries[slashSel] && entries[slashSel].kind === 'empty');

  if (open) {
    // 面板自己消费掉的键不再冒泡：全局 Escape 处理器看到面板已关会顺手把右栏也关掉
    // @ 面板分两页（文件 / 会话）：←→ 翻页，行内 ↑↓ 才是选择
    if (panel._mode === 'at' && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault(); ev.stopPropagation();
      setAtPage(ev.key === 'ArrowRight' ? 'sessions' : 'files');
      return;
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); moveSlashSel(1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); moveSlashSel(-1); return; }
    if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); if (entries[slashSel]) applySlash(entries[slashSel]); return; }
    if (ev.key === 'Enter' && !ev.shiftKey && !atEmptyPage) { ev.preventDefault(); ev.stopPropagation(); enterSlash(); return; }
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

/* S.model 是「供应商:模型」（核心的 model_label），但输入栏的圆钮只放模型名：
   供应商有自己的 chip，模型名再带上只会被挤成省略号。 */
function modelShortName() {
  // 未选模型时 model_label() 只剩供应商名，当成模型名显示会让人以为已选好
  if (!S.modelSet) return '';
  const m = String(S.model || '');
  const p = String(S.provider || '');
  if (p && m.slice(0, p.length + 1) === p + ':') return m.slice(p.length + 1);
  const i = m.indexOf(':');
  return i > 0 ? m.slice(i + 1) : m;
}
/* 模型菜单/设置页标记「当前」用：列表里是裸模型名，状态里是「供应商:模型」 */
function isCurrentModel(m) { return !!m && (m === S.model || m === modelShortName()); }
/* 状态里的模型名补齐回「供应商:模型」，别让 S.model 在两种形状间来回变 */
function modelLabelOf(m) { return S.provider ? S.provider + ':' + m : m; }

/* 未选模型：有供应商但模型为空（后端 state.model_set=false）。切供应商会清空
   current_model，此时 model_label() 只剩供应商名，chip 上看起来像「已选好」——
   必须用权威标志判断，不能靠「有没有冒号」猜字符串形状。 */
function needsModel() { return !!S.provider && S.modelSet === false; }

/* 强制提醒：未选模型时不允许开始会话 —— 红字提示 + chip 抖一下 + 直接弹模型
   菜单（菜单打开时会自动拉列表，用户不必再去找入口） */
function demandModel(msg) {
  toast(msg || '还没有选择模型 —— 先选一个模型才能开始会话', 'bad', 5000);
  const chip = $('#modelChip');
  if (!chip) return;
  chip.classList.add('shake');
  setTimeout(() => chip.classList.remove('shake'), 620);
  if (cmpMenu && cmpMenu.kind === 'model') reopenModelMenu();
  else toggleModelMenu(chip);
}

function paintModelChip(t) {
  const chip = $('#modelChip');
  if (!chip) return;
  const need = !!t && needsModel(); // 有工作区才谈得上「开始会话」
  const name = need ? '选择模型' : (modelShortName() || '(未选择模型)');
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml('cpu') + '</span>'
    + '<span class="cmp-model-name trunc"></span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  const nm = chip.querySelector('.cmp-model-name');
  if (nm) nm.textContent = name;
  chip.classList.toggle('need', need);
  chip.title = need
    ? '未选择模型：供应商 ' + (providerName() || '?') + ' 已切换，但还没有指定模型\n点这里选一个模型后才能开始会话'
    : '模型：' + name + '\n点击切换模型';
  chip.disabled = !t;
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'model' ? 'true' : 'false');
}

/* 当前供应商名：state 的 provider 优先，缺字段时从「供应商:模型」里切 */
function providerName() {
  if (S.provider) return String(S.provider);
  const q = String(S.model || '');
  const i = q.indexOf(':');
  return i > 0 ? q.slice(0, i) : '';
}

/* 供应商 chip：只在左边显示「模型来自哪里」，点开换供应商 */
function paintProviderChip(t) {
  const chip = $('#providerChip');
  if (!chip) return;
  const p = providerName();
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml('database') + '</span>'
    + '<span class="cmp-chip-txt trunc"></span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  const txt = chip.querySelector('.cmp-chip-txt');
  if (txt) txt.textContent = p || '供应商';
  chip.classList.toggle('need', !!t && !p);
  chip.title = p ? '供应商：' + p + '\n点击切换供应商（会清空当前模型）' : '还没有选择供应商';
  chip.disabled = !t;
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'provider' ? 'true' : 'false');
}

/* 思考强度 chip：读数（关/低/中/高/极高）+ 菜单里选 0-4 */
const THINK_SHORT = ['关', '低', '中', '高', '极高'];
function thinkLevel() {
  const v = Number((S.settings || {}).think_level || 0);
  return THINK_LEVELS[v] ? v : 0;
}
function paintThinkChip(t) {
  const chip = $('#thinkChip');
  if (!chip) return;
  const v = thinkLevel();
  const lvl = THINK_LEVELS[v];
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml('bulb') + '</span>'
    + '<span class="cmp-chip-txt">思考</span>'
    + '<span class="cmp-think-lv' + (v ? ' on' : '') + '">' + THINK_SHORT[v] + '</span>'
    + '<span class="cmp-chev">' + iconHtml('chevronDown') + '</span>';
  chip.classList.toggle('off', v === 0);
  chip.title = '思考强度：' + (v ? lvl.name + ' (' + v + ') · ' + lvl.desc : '关闭（不推理，最快）');
  chip.disabled = !t;
  chip.setAttribute('aria-expanded', cmpMenu && cmpMenu.kind === 'think' ? 'true' : 'false');
}

/* 工具调用开关：点击直接翻转（与 /tools on|off 同一命令路径） */
function paintToolsChip(t) {
  const chip = $('#toolsChip');
  if (!chip) return;
  const on = S.tools !== false;
  chip.innerHTML = '<span class="cmp-chip-ico">' + iconHtml('sliders') + '</span>'
    + '<span class="cmp-chip-txt">工具</span>'
    + '<span class="cmp-dot' + (on ? ' on' : '') + '"></span>';
  chip.classList.toggle('off', !on);
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  chip.title = '工具调用：' + (on ? '开（可读写文件 / 执行命令）' : '关（模型只能回复文本）')
    + '\n点击' + (on ? '关闭' : '开启');
  chip.disabled = !t;
}
function toggleTools() {
  const t = curTab();
  if (!t) return;
  const on = S.tools === false;
  cmd('settings.set', { patch: { tools: on } }).then(out => {
    if (!out || out.ok === false) return;
    S.tools = on;
    paintToolsChip(t);
    if (typeof renderStatLine === 'function') renderStatLine();
    toast('工具调用：' + (on ? '开' : '关'), 'ok');
    focusInput();
  });
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
    ['#modeChip', '#sandboxChip', '#toolsChip', '#providerChip', '#modelChip', '#thinkChip', '#btnAttach']
      .forEach(s => { const b = $(s); if (b) b.disabled = true; });
    paintModeChip('text');
    paintSandboxChip(S.sandbox || 'full-access');
    paintToolsChip(null);
    paintProviderChip(null);
    paintModelChip(null);
    paintThinkChip(null);
    closeComposerMenu();
    closeSlash();
    applyComposerWidthClass();
    // 状态行左侧（#statLeft）归 Lead 的 renderStatLine；这里顺带刷新，
    // 避免 composer 重建后左侧还停在上一次（如「没有打开的工作区」）的文案
    if (typeof renderStatLine === 'function') renderStatLine();
    return;
  }

  ta.disabled = false;
  const mode = t.composer.mode || 'text';
  if (composer) composer.classList.toggle('team', mode === 'team');
  ['#modeChip', '#sandboxChip', '#toolsChip', '#providerChip', '#modelChip', '#thinkChip', '#btnAttach']
    .forEach(s => { const b = $(s); if (b) b.disabled = false; });
  paintModeChip(mode);
  paintSandboxChip(S.sandbox || 'full-access');
  paintToolsChip(t);
  paintProviderChip(t);
  paintModelChip(t);
  paintThinkChip(t);

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
        }
  }

  renderChips(t);
  paintSendState(t);
  applyComposerWidthClass(); // 文案变了（换模型 / 换供应商）要重新量一次宽度档位
  if (typeof renderStatLine === 'function') renderStatLine();
  // 卡片高度可能刚被模式切换改掉（Teamwork 是 64vh，不看 --composer-h）：
  // 等这一帧布局落定后把「回到底部」重新贴到实测上界
  if (typeof syncJumpAnchors === 'function') {
    requestAnimationFrame(() => { try { syncJumpAnchors(); } catch (e) {} });
  }
}

function syncComposerInput() { renderComposer(); }

function syncComposerText(txt) {
  const t = curTab();
  if (!t) return;
  t.composer.text = txt;
  const ta = $('#ta');
  if (ta) ta.value = txt;
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
  if (!list.length) { wrap.hidden = true; return; }
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
    // 面板没开着时（Esc 关掉后再 Enter）也要执行完整指令名，不能把它改成
    // 「指令 + 空格」重开参数面板 —— 那样 Enter 永远发不出无参指令
    closeSlash();
    syncComposerText('');
    runSlash(t, it);
    return;
  }
  if (atts.length) {
    text += (text ? '\n\n' : '') + '[附件]\n' + atts.map(a => '- ' + a.path).join('\n');
  }
  // 没选模型就发出去只会白跑一个回合（引擎报错的那行还会被转录重载冲掉），
  // 所以在这里截住：内容留在输入框里，弹菜单让用户当场选
  if (needsModel()) { closeSlash(); demandModel(); return; }
  closeSlash();
  const optimistic = { id: uid(), role: 'user', text: text, ts: nowSec() };
  t.msgs.push(optimistic);
  for (const a of (t.composer.attachments || [])) dropAttachPreview(a); // 释放预览用的 object URL
  t.composer.text = '';
  t.composer.attachments = [];
  const ta = $('#ta');
  if (ta) ta.value = '';
  renderChips(t);
  paintSendState(t);
  buildSlash(true);
  markChat(t.ws);
  const out = await cmd('send', { ws: t.ws, text: text });
  if (out && out.ok === false) { markChat(t.ws); }
  focusInput();
}

// 「停止」= 终止该工作区的全部活动：进行中的回合（含正在跑的工具调用）+
// 所有处于 run 状态的 Teamwork 任务。回合停止走引擎的取消标志，50ms 内生效；
// 团队任务并发停，别再一条条串行 await —— 那正是「点了停止还要等一会儿」。
async function stopAllActivity(t) {
  cmd('stop', { ws: t.ws });
  // 缓存里已知在跑的先立刻发出去，同时按最新列表校准（这期间可能刚起了新任务）
  const cached = (t.jobs || []).filter(j => jobStatusClass(j.status) === 'run');
  const first = Promise.all(cached.map(j => cmd('teamwork.stop', { ws: t.ws, id: j.id })));
  let jobs = t.jobs || [];
  try { const out = await api('teamwork.list', { ws: t.ws }); if (out && out.jobs) jobs = out.jobs; } catch (e) {}
  const running = jobs.filter(j => jobStatusClass(j.status) === 'run');
  await first;
  if (!running.length) { await refreshTeamworkNow(t.ws, true); return; }
  await Promise.all(running.map(j => cmd('teamwork.stop', { ws: t.ws, id: j.id })));
  toast('已停止 ' + running.length + ' 个团队任务', 'ok');
  // 停止是异步的（runner 下一轮才翻状态）：先立即刷一次，+600ms 再对一次
  await refreshTeamworkNow(t.ws, false, true);
  setTimeout(() => { if (S.tabs.get(t.ws) === t) refreshTeamworkNow(t.ws, true); }, 600);
}

/* ---------- I6. 弹出菜单（模式 / 沙箱 / 模型） --------------------- */
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
  openComposerMenu(anchor, {
    kind: 'model',
    align: 'right',
    build: menu => {
      menu.appendChild(cmpMenuHead('模型'));
      // 未选模型是「发不出去」的硬条件：菜单一开就把话说清楚
      if (needsModel()) menu.appendChild(el('div', 'cmp-menu-hint danger', '未选择模型 · 选一个才能开始会话'));
      if (S.models.length) {
        for (const m of S.models) {
          const row = cmpMenuRow('cpu', m, isCurrentModel(m) ? '当前模型' : '', isCurrentModel(m));
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
    },
  });
  autoFetchModels();
}

/* 供应商菜单：换供应商会清空当前模型，走 /provider 同一条路径（resync + 重拉列表） */
function toggleProviderMenu(anchor) {
  const t = curTab();
  if (!t) return;
  const cur = providerName();
  openComposerMenu(anchor, {
    kind: 'provider',
    align: 'right',
    build: menu => {
      menu.appendChild(cmpMenuHead('供应商'));
      if (S.providers.length) {
        for (const p of S.providers) {
          const on = p.name === cur || !!p.current;
          const row = cmpMenuRow('database', p.name, on ? '当前供应商' : (p.api_style || ''), on);
          row.onclick = () => { closeComposerMenu(false); execSlash(t, '/provider', p.name); focusInput(); };
          menu.appendChild(row);
        }
      } else {
        const row = cmpMenuRow('database', '打开供应商设置…', '还没有配置供应商', false);
        row.onclick = () => { closeComposerMenu(false); openSettings('providers'); };
        menu.appendChild(row);
      }
      menu.appendChild(cmpMenuSep());
      const setRow = cmpMenuRow('settings', '管理供应商…', '设置 · 供应商', false);
      setRow.onclick = () => { closeComposerMenu(false); openSettings('providers'); };
      menu.appendChild(setRow);
    },
  });
}

/* 思考强度菜单（0-4；与 /think 同一命令路径） */
function toggleThinkLevelMenu(anchor) {
  const t = curTab();
  if (!t) return;
  const cur = thinkLevel();
  openComposerMenu(anchor, {
    kind: 'think',
    align: 'right',
    build: menu => {
      menu.appendChild(cmpMenuHead('思考强度'));
      for (const l of THINK_LEVELS) {
        const row = cmpMenuRow('bulb', THINK_SHORT[l.v] + ' · ' + l.name, l.desc, cur === l.v);
        row.onclick = () => { closeComposerMenu(false); execSlash(t, '/think', String(l.v)); focusInput(); };
        menu.appendChild(row);
      }
      menu.appendChild(cmpMenuSep());
      const hint = el('div', 'cmp-menu-hint');
      hint.innerHTML = '也可用 <kbd>/think</kbd> 直接设置';
      menu.appendChild(hint);
    },
  });
}

function autoFetchModels() {
  if (S.models.length || cmpModelFetching) return;
  fetchModels(false);
}
// 返回 Promise<boolean>：切供应商后要等列表回来再提示模型数量
function fetchModels(force) {
  if (cmpModelFetching) return Promise.resolve(false);
  cmpModelFetching = true;
  return cmd('models.fetch', {}).then(out => {
    cmpModelFetching = false;
    if (!out || out.ok === false || !Array.isArray(out.models)) return false;
    S.models = out.models;
    if (out.models.length) {
      if (force) toast('已拉取 ' + out.models.length + ' 个模型', 'ok');
      // 只有真的拿到列表才重开菜单（空列表重开会再次触发拉取，造成死循环）
      if (cmpMenu && cmpMenu.kind === 'model') reopenModelMenu();
    } else if (force) {
      toast('供应商未返回模型列表', 'bad');
    }
    return true;
  });
}

/* 切供应商的收尾（/provider 与设置页共用）：旧模型列表属于上一个供应商，
   后端也已经把 current_model 清空了 —— 这里重拉一次列表并提醒选模型。
   popMenu=true 时把模型菜单直接弹出来：换供应商本来就是为了换模型。 */
function afterProviderSwitch(name, popMenu) {
  S.models = [];
  renderComposer();
  const p = fetchModels(false); // 先发出去（同步置位 fetching，挡掉 autoFetchModels 的重复拉取）
  if (popMenu) {
    const chip = $('#modelChip');
    if (chip && !(cmpMenu && cmpMenu.kind === 'model')) toggleModelMenu(chip);
  }
  return p.then(ok => {
    // S.modelSet 不在这里改写：上面的 resync 已经把后端的权威值带回来了
    // （重选同一个供应商时模型仍有效，乐观置 false 会误报「未选模型」）
    if (!ok && cmpModelFetching) return; // 另一次拉取还在飞，别报假失败
    const n = S.models.length;
    toast(n ? '供应商：' + name + ' · 已拉取 ' + n + ' 个模型，请选择模型后开始会话'
            : '供应商：' + name + ' · 没能拉到模型列表（检查密钥 / Base URL）',
          n ? 'ok' : 'warn', 4600);
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
  if (isCurrentModel(m)) return focusInput();
  const out = await cmd('model.set', { model: m });
  if (!out || out.ok === false) return;
  S.model = modelLabelOf(m);
  S.modelSet = true;
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
      for (const m of S.models) add(m, m, isCurrentModel(m) ? '当前' : '');
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
    case 'compact':
      // 参数语法对齐 CLI：裸 /compact = 立即压缩，auto on|off = 自动压缩开关
      add('on', 'on', '开启自动压缩'); add('off', 'off', '关闭自动压缩');
      add('auto on', 'auto on', '同 on（CLI 写法）'); add('auto off', 'auto off', '同 off（CLI 写法）');
      break;
    case 'skills':
      for (const sk of (S.skills || [])) add(sk.name, sk.name, sk.description || '');
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
    // 别名（CLI 写法）只在输入完整名字时执行，不占候选列表
    const scored = COMMANDS.filter(c => !c.alias).map(c => ({ c: c, sc: fuzzy(token.slice(1), c.name.slice(1)) }))
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

/* 一个 @ 片段的生命周期结束（输入框里没有 @ 片段了）：页签与选中位都回到默认，
   下一次敲 @ 从文件页重新开始 */
function atReset() {
  atPage = 'files';
  atPinned = false;
  atSel.files = 0;
  atSel.sessions = 0;
  const panel = $('#slashPanel');
  if (panel) { panel._atStart = null; panel._atQuery = null; }
}

/* 表头右上角：文件页显示当前所在目录（行里就只留条目名） */
function atDirHint(q) {
  const sp = atSplitPath(q);
  return sp.dir ? sp.dir + '/' : '';
}

/* 会话页是否参与检索：路径形态的查询（含 /）明显是在翻目录，不去搜会话——
   除非用户就停在会话页，那说明他要的正是会话 */
function atWantSessions(q) { return !q || q.indexOf('/') < 0 || atPage === 'sessions'; }
/* 候选缓存的 key：工作区 + 查询 + 这一轮有没有搜会话 */
function atKey(t, at) { return t.ws + '\u0000' + at.query + '\u0000' + (atWantSessions(at.query) ? 's' : '-'); }

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

/* 拉候选（带 140ms 防抖）：两页一次拉齐（页签上的条数才有意义），
   结果按 key 缓存 15s，落定后重绘面板 */
function atFetch(t, at) {
  const key = atKey(t, at);
  if (atState.key === key && (Date.now() - (atState.ts || 0)) < 15000) return;
  const q = at.query;
  // 同一个查询只是翻了页（会话页要补一次检索）：已经拿到的那一半留着，
  // 否则翻回文件页会闪一下空列表
  const keep = (atState.q === q && atState.ws === t.ws) ? atState : null;
  atState = {
    key: key, ws: t.ws, q: q, busy: true, ts: 0,
    files: keep ? keep.files : [], sessions: keep ? keep.sessions : [],
  };
  clearTimeout(atTimer);
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
      atState.files = rows.slice(0, AT_FILE_LIMIT);
    }).catch(() => {}));
    if (!q) atState.sessions = atRecentSessions(t);
    else if (atWantSessions(q)) {
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

/* 两页的行（面板只管渲染，翻页只换这一层） */
function atRows(t) {
  const files = atState.files.map(e => ({
    kind: e.dir ? 'dir' : 'file',
    name: e.name,
    path: e.path || e.name,
    desc: e.dir ? '目录' : fmtBytes(e.size || 0),
  }));
  const sessions = atState.sessions.map(s => {
    const title = s.title || shortId(s.id);
    const hit = (s.hits && s.hits[0]) ? String(s.hits[0].text || '') : '';
    const snippet = hit.replace(/\s+/g, ' ').trim();
    // 命中片段与标题是同一段话（标题只是被截断了）就不再重复显示
    const same = !!snippet && (snippet === title || snippet.indexOf(title.slice(0, 16)) === 0);
    return {
      kind: 'sess',
      id: s.id,
      ws: s.ws || '',
      title: title,
      desc: (!same && snippet)
        ? snippet.slice(0, 90)
        : (relTime(s.mtime) + (s.ws && s.ws !== t.ws ? ' · 其他工作区' : '')),
    };
  });
  return { files: files, sessions: sessions };
}

/* 空页也要留住面板：页签上的条数还在，用户才知道该换页还是该改查询 */
function atEmptyRow(page, q, busy) {
  const text = busy ? '正在检索…'
    : page === 'files'
      ? (q ? '没有匹配的文件或目录' : '这个目录里没有东西')
      : (q ? '没有匹配的会话' : '还没有可以引用的会话');
  return [{ kind: 'empty', desc: text }];
}

/* 页签：鼠标点一下就是翻页（←→ 也一样） */
function sxTabStrip(tabs, cur) {
  const strip = el('div', 'sx-tabs');
  strip.setAttribute('role', 'tablist');
  for (const tb of tabs) {
    const on = tb.page === cur;
    const b = el('button', 'sx-tab' + (on ? ' on' : ''));
    b.type = 'button';
    b.dataset.page = tb.page;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.innerHTML = '<span class="sx-tab-ico">' + iconHtml(tb.icon) + '</span>'
      + '<span class="sx-tab-tx"></span><span class="sx-tab-n"></span>';
    const tx = b.querySelector('.sx-tab-tx');
    if (tx) tx.textContent = tb.label;
    const n = b.querySelector('.sx-tab-n');
    if (n) n.textContent = String(tb.count);
    b.title = tb.label + '（' + tb.count + '）· 点击或 ←→ 翻页';
    b.onmousedown = ev => ev.preventDefault(); // 别把焦点从输入框抢走，翻完页还能接着打字
    b.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); setAtPage(tb.page); };
    strip.appendChild(b);
  }
  return strip;
}

/* 翻页：只换面板里的那一页，输入框里的 @ 片段原样不动 */
function setAtPage(page) {
  if (!AT_PAGES.some(p => p.page === page)) return;
  if (atPage !== page) {
    atPage = page;
    slashSel = atSel[page] || 0;
  }
  atPinned = true; // 手动翻过页：之后不再自动跟随「有内容的那页」
  buildSlash();
  focusInput();
}

/* 候选渲染（斜杠 / @ 共用一套行样式，只是行内容与底部键位不同） */
function sxPaint(panel, title, entries, mode, opts) {
  opts = opts || {};
  if (slashSel >= entries.length) slashSel = 0;
  if (slashSel < 0) slashSel = 0;
  panel.replaceChildren();
  const head = el('div', 'sx-head');
  if (opts.tabs) {
    head.classList.add('sx-head-at');
    head.appendChild(sxTabStrip(opts.tabs, opts.page));
    if (opts.hint) head.appendChild(el('span', 'sx-dir trunc', opts.hint));
  } else {
    head.appendChild(el('span', 'sx-title', title));
    head.appendChild(el('span', 'sx-count', String(entries.length)));
  }
  panel.appendChild(head);

  const list = el('div', 'sx-list');
  panel._rows = [];
  entries.forEach((e, i) => {
    const sel = i === slashSel && e.kind !== 'empty';
    const row = el('div', 'sx-row' + (sel ? ' sel' : '') + (mode === 'at' ? ' at' : '')
      + (e.kind === 'empty' ? ' empty' : ''));
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
    } else if (e.kind === 'empty') {
      main.appendChild(el('span', 'sx-empty', e.desc || '没有匹配'));
    } else {
      main.appendChild(el('span', 'sx-name', '说明'));
    }
    row.appendChild(main);
    if (e.desc && e.kind !== 'empty') row.appendChild(el('span', 'sx-desc trunc', e.desc));
    if (e.kind !== 'empty' && (e.kind !== 'hint' || e.cmd))
      row.onclick = () => { slashSel = i; applySlash(entries[i]); };
    list.appendChild(row);
    panel._rows.push(row);
  });
  panel.appendChild(list);

  const foot = el('div', 'sx-foot');
  foot.innerHTML = '<span class="sx-k"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>'
    + (mode === 'at'
      ? '<span class="sx-k"><kbd>←</kbd><kbd>→</kbd> 翻页</span>'
        + '<span class="sx-k"><kbd>Tab</kbd><kbd>Enter</kbd> 插入</span>'
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
  if (!at) { atReset(); return closeSlash(); }
  atFetch(t, at);
  if (atState.key !== atKey(t, at)) return closeSlash(); // 候选还在路上：落定后由 atFetch 回调重绘
  // 新查询的第一批候选还没到：先不画（否则会闪一下「没有匹配」）。
  // 翻页不改查询，所以只有翻页那一下会立刻重画，页签条数随后再刷新。
  if (atState.busy && panel._atQuery !== at.query) return closeSlash();
  // 新的 @ 片段 → 回到默认的文件页；同一个片段里保留用户翻到的页
  if (panel._atStart !== at.start || panel._atWs !== t.ws) {
    panel._atStart = at.start;
    panel._atWs = t.ws;
    atPage = 'files';
    atPinned = false;
  }
  if (panel._atQuery !== at.query) { // 查询变了：两页都从头选起
    panel._atQuery = at.query;
    atSel.files = 0;
    atSel.sessions = 0;
  }
  const rows = atRows(t);
  const count = { files: rows.files.length, sessions: rows.sessions.length };
  let page = atPage;
  if (!atPinned) { // 没手选就跟随有内容的那页（敲下 @ 默认文件页）
    const alt = page === 'files' ? 'sessions' : 'files';
    if (!count[page] && count[alt]) page = alt;
  }
  atPage = page;
  let entries = rows[page];
  if (!entries.length) entries = atEmptyRow(page, at.query, atState.busy);
  slashSel = atSel[page] || 0;
  panel._at = at;
  sxPaint(panel, '', entries, 'at', {
    page: page,
    tabs: AT_PAGES.map(p => ({ page: p.page, label: p.label, icon: p.icon, count: count[p.page] })),
    hint: page === 'files' ? atDirHint(at.query) : '',
  });
}

function moveSlashSel(delta) {
  const panel = $('#slashPanel');
  if (!panel) return;
  const entries = panel._entries || [];
  if (!entries.length) return;
  slashSel = ((slashSel + delta) % entries.length + entries.length) % entries.length;
  // 两页各自记一份选中行：翻回来还停在原来那条上
  if (panel._mode === 'at') atSel[atPage] = slashSel;
  const rows = panel._rows || [];
  // 空态行不可选：光标停在它上面会把「↑↓ 选择」演成什么都没选中
  rows.forEach((r, i) => r.classList.toggle('sel', i === slashSel && entries[i] && entries[i].kind !== 'empty'));
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
  if (!e || e.kind === 'empty') return; // 空页提示行不是候选
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
  if (['/model', '/provider', '/think', '/sandbox', '/tools', '/autoallow', '/compact', '/theme', '/session', '/workspace', '/skill'].includes(head)
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
  // 完整指令名（/compact）：Enter 就是执行，补全交给 Tab —— 面板底部写的正是
  // 「Tab 补全 / Enter 执行」。旧行为把 Enter 当成接受高亮参数（/compact → on），
  // 无参指令永远发不出去。
  if (it.kind === 'complete') {
    closeSlash();
    syncComposerText('');
    runSlash(t, it);
    return;
  }
  if (v.indexOf(' ') < 0) { // 半成品指令名：接受当前候选补全
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
  name = CMD_ALIAS[name] || name; // /provide、/sessions… 统一成主名再分派
  switch (name) {
    case '/new': return cmd('session.new', { ws: t.ws }).then(resync);
    case '/clear': return cmd('session.clear', { ws: t.ws }).then(resync);
    case '/session':
      if (arg) return cmd('session.select', { ws: t.ws, id: arg }).then(resync);
      toast('用法：/session <id>'); break;
    case '/model':
      if (!arg) { openSettings('models'); return; }
      return cmd('model.set', { model: arg }).then(out => {
        if (out && out.ok === false) return;
        S.model = modelLabelOf(arg);
        S.modelSet = true;
        renderComposer();
        if (typeof renderFoot === 'function') renderFoot();
        if (typeof renderStatLine === 'function') renderStatLine();
        toast('模型已切换', 'ok');
      });
    case '/provider':
      if (arg) return cmd('providers.select', { name: arg }).then(out => {
        if (out && out.ok === false) return;
        // 换供应商会清空模型：resync 之后自动拉一次列表并弹出模型菜单。
        // 提示统一交给 afterProviderSwitch（它带着拉取结果），不再单独弹「已切换」
        return resync().then(() => { renderComposer(); return afterProviderSwitch(arg, true); });
      });
      toast('用法：/provider <name>'); break;
    case '/think': {
      if (!arg) { toast('用法：/think 0-4 或 ' + THINK_LEVELS.map(l => l.name).join('/')); break; }
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
      if (!arg) { toast('工具调用：' + (S.tools ? '开' : '关'), 'ok'); break; }
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/tools on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { tools: on } }).then(out => {
        if (out && out.ok !== false) S.tools = on;
        return afterSet(out, '工具调用：' + (on ? '开' : '关'));
      });
    }
    case '/sandbox': {
      if (!arg) { toast('用法：/sandbox ' + SANDBOX_MODES.map(x => x.v).join('|')); break; }
      const m = SANDBOX_MODES.find(x => x.v === arg);
      if (!m) { toast('无效的沙箱模式：' + arg + '（' + SANDBOX_MODES.map(x => x.v).join(' / ') + '）', 'bad'); break; }
      return setSandboxMode(m.v);
    }
    case '/autoallow': {
      if (!arg) { toast('自动放行：' + ((S.settings || {}).autoallow ? '开' : '关'), 'ok'); break; }
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/autoallow on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { autoallow: on } }).then(out => afterSet(out, '自动放行：' + (on ? '开' : '关')));
    }
    case '/compact': {
      // 裸 /compact = 立即压缩当前会话（与 CLI 一致）。压缩在 worker 里跑，
      // 这里只负责投递；进度与结果走 compact_begin / compact_end 事件。
      if (!arg) return compactNow(t.ws);
      // /compact auto [on|off] 与 /compact [on|off] 都是自动压缩开关
      const m = String(arg).split(/\s+/);
      if (m[0] === 'auto' && !m[1]) {
        toast('自动压缩：' + ((S.settings || {}).compact_auto ? '开' : '关'), 'ok');
        break;
      }
      const on = onoffOf(m[0] === 'auto' ? m[1] : arg);
      if (on == null) { toast('用法：/compact | /compact auto on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { compact_auto: on } }).then(out => afterSet(out, '自动压缩：' + (on ? '开' : '关')));
    }
    case '/skills': return listSkills();
    case '/skill': {
      // 对齐 CLI /skill NAME：把技能正文注入当前会话的 system 块
      if (!arg) { toast('用法：/skill <name>'); break; }
      return cmd('skill.load', { ws: t.ws, name: arg }).then(out => {
        if (!out || out.ok === false) {
          const err = String((out && out.error) || '加载失败');
          toast(err.indexOf('a turn is running') >= 0 ? '回合进行中，结束后再加载' : err, 'bad');
          return;
        }
        toast('已加载技能：' + out.name + '（' + out.chars + ' 字符）', 'ok', 4200);
      });
    }
    case '/export': return exportSession(t, arg);
    case '/ins': {
      // 对齐 CLI：文本作为用户消息发出去并触发一轮（GUI 里等同于直接输入）
      if (!arg) { toast('用法：/ins <message text>'); break; }
      if (t.busy) { toast('回合进行中，结束后再插入', 'bad'); break; }
      t.composer.text = arg;
      return sendCurrent();
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
  // 团队任务同样要有模型才能跑：没选就当场提醒，别创建出一个跑不动的任务
  if (needsModel()) { demandModel(); return; }
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
