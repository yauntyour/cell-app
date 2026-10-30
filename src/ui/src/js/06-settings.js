/* ---------- J. 设置页 ----------------------------------------------
   整页浮层（#settings 的定位/显隐由 04-layout.css 提供），左侧 220px 分节
   导航 + 右侧 max 720 内容列。分节：外观 / 模型 / 供应商 / 代理 / 沙箱 /
   上下文 / 性能 / 关于。保留原有全部命令与行为（providers.add/rm/select、
   provider.set_key、models.fetch、model.set、settings.set 的 think/tools/
   system prompt/sandbox/compaction/perf），只是重排了 DOM 与观感。        */

const SET_SECTIONS = [
  { id: 'appearance', label: '外观', icon: 'sliders' },
  { id: 'models', label: '模型', icon: 'sparkles' },
  { id: 'providers', label: '供应商', icon: 'layers' },
  { id: 'agent', label: '代理', icon: 'cpu' },
  { id: 'sandbox', label: '沙箱', icon: 'shield' },
  { id: 'context', label: '上下文', icon: 'database' },
  { id: 'perf', label: '性能', icon: 'gauge' },
  { id: 'about', label: '关于', icon: 'info' },
];
let setSection = 'appearance';
// 滚动 spy 的节流句柄（renderSettings 重建 DOM 时旧值自然失效）
let setSpyTick = 0;
// 最近一次渲染的数据指纹：状态异步到达时只在「数据真的变了」时补一次重绘，
// 避免重绘把用户正在进行的平滑滚动 / 输入打断。
let setRenderSig = '';
function setDataSig() {
  return [
    (S.providers || []).length,
    S.model || '',
    (S.workspaces || []).length,
    (S.settings || {}).think_level == null ? '' : (S.settings || {}).think_level,
    S.mode || '',
  ].join('|');
}

/* ---- 小工具：图标 / 按钮 / 输入框 ---------------------------------- */
function setIcon(name, cls, fallback) {
  if (typeof ICON_PATHS !== 'undefined' && ICON_PATHS[name]) return iconEl(name, cls);
  if (fallback && typeof ICON_PATHS !== 'undefined' && ICON_PATHS[fallback]) return iconEl(fallback, cls);
  return null;
}
function setBtn(label, cls, fn, icon) {
  const b = el('button', 'btn ' + (cls || ''));
  b.type = 'button';
  const ic = icon ? setIcon(icon, 'sm') : null;
  if (ic) b.appendChild(ic);
  if (label) b.appendChild(el('span', 'btn-label', label));
  b.onclick = fn;
  return b;
}
function setIconBtn(icon, title, fn, cls) {
  const b = el('button', 'icon-btn ' + (cls || ''));
  b.type = 'button';
  b.title = title || '';
  b.setAttribute('aria-label', title || icon);
  const ic = setIcon(icon);
  if (ic) b.appendChild(ic);
  b.onclick = fn;
  return b;
}
function setInput(placeholder, value, type) {
  const i = el('input');
  i.type = type || 'text';
  if (placeholder) i.placeholder = placeholder;
  if (value != null && value !== '') i.value = value;
  return i;
}
function setTextarea(placeholder, value, rows) {
  const t = el('textarea', 'set-textarea');
  t.rows = rows || 6;
  if (placeholder) t.placeholder = placeholder;
  t.value = value == null ? '' : value;
  return t;
}
// 密钥输入：默认 password，右侧眼睛按钮切换明文（不引入外部资源）
function setSecretField(placeholder, value) {
  const wrap = el('div', 'set-secret');
  const inp = setInput(placeholder, value, 'password');
  const eye = setIconBtn('eye', '显示密钥', () => {
    inp.type = inp.type === 'password' ? 'text' : 'password';
    eye.classList.toggle('on', inp.type === 'text');
  });
  wrap.appendChild(inp);
  wrap.appendChild(eye);
  wrap.input = inp;
  return wrap;
}
function setCardHead(title, right) {
  const h = el('div', 'set-card-head');
  h.appendChild(el('span', 'set-card-title', title));
  if (right) h.appendChild(right);
  return h;
}
function setPill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }
function setKbd(text) { return el('span', 'kbd', text); }
function setNote(text, kind) {
  const n = el('div', 'set-note' + (kind ? ' ' + kind : ''));
  const ic = setIcon(kind === 'warn' ? 'alert' : 'info', 'sm');
  if (ic) n.appendChild(ic);
  n.appendChild(el('span', 'set-note-txt', text));
  return n;
}
// 只在目标函数还存在时调用：外壳模块重写期间也保持设置页可渲染
function setCall(name) {
  try {
    if (typeof window[name] === 'function') { window[name](); return true; }
  } catch (e) { console.error(e); }
  return false;
}
// 品牌 logo（与侧栏同一个折线形，内联 SVG，无外部资源）
function cellLogoSvg(cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 500 500');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = '<g fill="none" stroke="currentColor" stroke-width="30" stroke-linejoin="miter" stroke-linecap="square">' +
    '<rect x="90" y="90" width="320" height="320"/>' +
    '<path d="M 170 170 L 170 330 L 250 330 L 250 170 L 330 170 L 330 410"/></g>';
  return svg;
}

/* ---- 打开 / 关闭 / 渲染 ------------------------------------------- */
function openSettings(section) {
  if (section && SET_SECTIONS.some(s => s.id === section)) setSection = section;
  const host = $('#settings');
  const already = !!(S.settingsOpen && host && host.classList.contains('show'));
  S.settingsOpen = true;
  try { if (location.hash !== '#/settings') location.hash = '#/settings'; } catch (e) { /* file:// 下个别环境不允许 */ }
  if (!host) return;
  host.classList.add('show');
  // 已打开且没有指定新分节：openSettings() 往往来自 hashchange 回声（openSettings
  // 自己写了 hash）或重复调用，不必再重绘一遍、打断正在进行的交互。
  if (already && !section) return;
  renderSettings();
  // ?settings=1 由 boot 在状态到达前就打开了设置页（演示模式的 hello 稍后
  // 才回填 providers/model/settings）：短暂轮询，数据到达后补一次重绘，
  // 避免首次打开看到一屏空卡片。resync() 之后同样会重绘，这里只是兜底。
  const retry = n => {
    if (!S.settingsOpen || n <= 0) return;
    if (setDataSig() !== setRenderSig) renderSettings();
    if (!(S.providers || []).length || !S.model) setTimeout(() => retry(n - 1), 260);
  };
  setTimeout(() => retry(6), 180);
}
function closeSettings() {
  S.settingsOpen = false;
  const host = $('#settings');
  if (host) {
    // 关闭即丢弃 DOM：下次打开总是从当前分节重新渲染（并在打开时滚到该节）
    host.classList.remove('show');
    host.replaceChildren();
  }
  try {
    if (location.hash === '#/settings') history.replaceState(null, '', location.pathname + location.search);
  } catch (e) { /* ignore */ }
}
function toggleSettings() { S.settingsOpen ? closeSettings() : openSettings(); }

function renderSettings() {
  const host = $('#settings');
  if (!host) return;
  const prevMain = host.querySelector('.set-main');
  const keepScroll = prevMain ? prevMain.scrollTop : 0;
  const mode = S.mode === 'demo' ? 'demo' : 'live';

  const shell = el('div', 'set-shell');

  /* ---- 左：分节导航 ---- */
  const side = el('aside', 'set-side');
  const sideHead = el('div', 'set-side-head');
  const logoTile = el('span', 'set-logo');
  logoTile.appendChild(cellLogoSvg('set-logo-svg'));
  sideHead.appendChild(logoTile);
  const sideTitle = el('div', 'set-side-title');
  sideTitle.appendChild(el('span', 'set-side-name', '设置'));
  sideTitle.appendChild(el('span', 'set-side-sub', 'cell · preview'));
  sideHead.appendChild(sideTitle);
  side.appendChild(sideHead);

  const nav = el('nav', 'set-nav');
  nav.setAttribute('aria-label', '设置分节');
  const navBtns = new Map();
  for (const s of SET_SECTIONS) {
    const b = el('button', 'set-navitem' + (s.id === setSection ? ' on' : ''));
    b.type = 'button';
    b.dataset.sec = s.id;
    b.title = s.label;
    if (s.id === setSection) b.setAttribute('aria-current', 'true');
    const ic = setIcon(s.icon, 'set-nav-ico', 'circle');
    if (ic) b.appendChild(ic);
    else b.appendChild(el('span', 'set-nav-dot'));
    b.appendChild(el('span', 'set-nav-label', s.label));
    b.onclick = () => {
      setSection = s.id;
      paintSetNav(s.id);
      sectionScroll(s.id);
    };
    nav.appendChild(b);
    navBtns.set(s.id, b);
  }
  side.appendChild(nav);

  const sideFoot = el('div', 'set-side-foot');
  const modeLine = el('div', 'set-mode-line');
  modeLine.appendChild(el('span', 'set-mode-dot ' + mode));
  modeLine.appendChild(el('span', 'set-mode-txt', mode === 'demo' ? '演示模式 · 设置不持久化' : '已连接到本地服务'));
  sideFoot.appendChild(modeLine);
  sideFoot.appendChild(el('div', 'set-foot-hint', 'Ctrl+, 打开 · Esc 关闭'));
  side.appendChild(sideFoot);
  shell.appendChild(side);

  /* ---- 右：标题栏 + 分节内容 ---- */
  const main = el('main', 'set-main');
  const head = el('header', 'set-head');
  const headMain = el('div', 'set-head-main');
  const headTitle = el('h1', 'set-head-title', SET_SECTIONS.find(x => x.id === setSection).label);
  headTitle.id = 'setHeadTitle';
  const headDesc = el('p', 'set-head-desc');
  headDesc.id = 'setHeadDesc';
  headMain.appendChild(headTitle);
  headMain.appendChild(headDesc);
  head.appendChild(headMain);

  const headActions = el('div', 'set-head-actions');
  const status = el('span', 'set-status ' + mode);
  status.appendChild(el('span', 'set-mode-dot ' + mode));
  status.appendChild(el('span', null, mode === 'demo' ? '演示模式' : (S.connected ? '已连接' : '连接断开')));
  headActions.appendChild(status);
  headActions.appendChild(setIconBtn('refresh', '刷新状态 (resync)', () => { resync(); toast('已刷新设置页', 'ok', 1400); }));
  headActions.appendChild(setIconBtn('x', '关闭设置 (Esc)', closeSettings));
  head.appendChild(headActions);
  main.appendChild(head);

  const content = el('div', 'set-content');
  for (const s of SET_SECTIONS) content.appendChild(buildSection(s.id));
  main.appendChild(content);
  shell.appendChild(main);
  host.replaceChildren(shell);

  /* ---- 导航高亮 / 滚动 spy ---- */
  const findSec = id => SET_SECTIONS.find(x => x.id === id) || SET_SECTIONS[0];
  const paintHead = id => {
    const s = findSec(id);
    headTitle.textContent = s.label;
    headDesc.textContent = setSectionDesc(s.id);
  };
  function paintSetNav(id) {
    for (const [sid, b] of navBtns) {
      const on = sid === id;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    paintHead(id);
  }
  paintHead(setSection);
  const sections = Array.from(content.querySelectorAll('.set-section'));
  const spy = () => {
    setSpyTick = 0;
    const top = main.getBoundingClientRect().top + (head.offsetHeight || 60) + 24;
    let cur = sections.length ? sections[0].id.replace(/^sec-/, '') : setSection;
    for (const node of sections) {
      if (node.getBoundingClientRect().top <= top) cur = node.id.replace(/^sec-/, '');
    }
    // 滚到底时强制高亮最后一节（短页面最后几节可能都已在视口上方）
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4 && sections.length) {
      cur = sections[sections.length - 1].id.replace(/^sec-/, '');
    }
    if (cur !== setSection) { setSection = cur; paintSetNav(cur); }
  };
  main.addEventListener('scroll', () => {
    if (setSpyTick) return;
    setSpyTick = requestAnimationFrame(spy);
  }, { passive: true });

  setRenderSig = setDataSig();
  requestAnimationFrame(() => {
    // 用户已经滚开（重绘前的 scrollTop 较大）就还原位置；否则定位到当前分节。
    // 阈值不能取 0：异步数据到达触发重绘时，平滑滚动可能刚走了一两像素。
    if (keepScroll > 60) main.scrollTop = keepScroll;
    else sectionScroll(setSection, true);
  });
}

// 分节副标题（渲染到右侧标题栏，滚动时随当前节更新）
function setSectionDesc(id) {
  switch (id) {
    case 'appearance': return '主题、动画等级与界面观感。第三方主题放入 .cell/theme/<名称>/ 即可在此选择。';
    case 'models': return '当前模型与供应商可用模型列表，切换后作用于之后的新回合。';
    case 'providers': return '管理 API 供应商与密钥；密钥保存在本机凭据库，不会回显明文。';
    case 'agent': return '思考级别、工具调用开关与系统提示词。';
    case 'sandbox': return '执行与写入的权限边界；自动放行仅在完全访问模式下生效。';
    case 'context': return '自动上下文压缩与压缩专用供应商 / 模型。';
    case 'perf': return '工具线程池大小与团队协作子代理上限，修改在后续回合生效。';
    case 'about': return '版本、运行状态、已打开工作区与快捷键。';
    default: return '';
  }
}

// 把浮层内的滚动容器滚到某一分节（点击导航 / 首次打开时调用）
function sectionScroll(id, instant) {
  const host = $('#settings');
  if (!host) return;
  const main = host.querySelector('.set-main');
  const node = document.getElementById('sec-' + id);
  if (!main || !node) return;
  const head = main.querySelector('.set-head');
  const headH = head ? head.offsetHeight : 60;
  const target = Math.max(0, node.offsetTop - headH - 12);
  // instant 用于首次打开 / 重绘后的定位：直接写 scrollTop（不受 CSS
  // scroll-behavior 影响）；点击导航才用显式平滑滚动。
  try {
    if (instant) main.scrollTop = target;
    else main.scrollTo({ top: target, behavior: 'smooth' });
  } catch (e) { main.scrollTop = target; }
}

/* ---- 分节骨架 ------------------------------------------------------ */
// 分节标题与说明由右侧粘性页头承担（滚动 spy 随当前分节更新），内容列
// 不再重复一遍标题；保留一个视觉隐藏的 h2 给读屏与键盘跳转。
function sec(id, title, desc) {
  const s = el('section', 'set-section');
  s.id = 'sec-' + id;
  s.appendChild(el('h2', 'sr-only', title || id));
  if (desc) s.setAttribute('aria-label', title + '：' + desc);
  return s;
}
function card(children) {
  const c = el('div', 'card set-card');
  (children || []).forEach(x => x && c.appendChild(x));
  return c;
}
function field(label, control, hint) {
  const w = el('div', 'set-field');
  if (label) w.appendChild(el('label', 'set-label', label));
  w.appendChild(control);
  if (hint) w.appendChild(el('div', 'set-hint', hint));
  return w;
}
function makeSwitch(checked, onchange) {
  const sw = el('button', 'switch' + (checked ? ' on' : ''));
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', checked ? 'true' : 'false');
  sw.onclick = () => {
    const nv = !sw.classList.contains('on');
    sw.classList.toggle('on', nv);
    sw.setAttribute('aria-checked', String(nv));
    onchange(nv);
  };
  return sw;
}
function switchRow(label, checked, onchange, desc) {
  const row = el('div', 'set-row');
  const txt = el('div', 'set-row-txt');
  txt.appendChild(el('div', 'set-row-title', label));
  if (desc) txt.appendChild(el('div', 'set-row-desc', desc));
  row.appendChild(txt);
  row.appendChild(makeSwitch(checked, onchange));
  return row;
}
function makeSeg(values, cur, onpick) {
  const seg = el('div', 'seg');
  for (const v of values) {
    const b = el('button', v.v === cur ? 'on' : '');
    b.type = 'button';
    if (v.desc) b.title = v.desc;
    b.appendChild(el('span', null, v.label));
    b.onclick = () => onpick(v.v);
    seg.appendChild(b);
  }
  return seg;
}
function segRow(label, values, cur, onpick, desc) {
  const row = el('div', 'set-row set-row-wrap');
  const txt = el('div', 'set-row-txt');
  txt.appendChild(el('div', 'set-row-title', label));
  if (desc) txt.appendChild(el('div', 'set-row-desc', desc));
  row.appendChild(txt);
  row.appendChild(makeSeg(values, cur, onpick));
  return row;
}

/* ---- settings.set 包装 --------------------------------------------- */
function setPatch(patch) {
  return cmd('settings.set', { patch }).then(out => {
    if (out && out.ok && out.settings) S.settings = Object.assign(S.settings || {}, out.settings);
    if (out && out.ok) toast('已保存', 'ok');
    setCall('renderStatLine');
    return out;
  });
}

/* ---- 分节内容 ------------------------------------------------------ */
function buildSection(id) {
  const st = S.settings || {};
  if (id === 'providers') return buildProviders(st);
  if (id === 'models') return buildModels(st);
  if (id === 'agent') return buildAgent(st);
  if (id === 'sandbox') return buildSandbox(st);
  if (id === 'context') return buildContext(st);
  if (id === 'perf') return buildPerf(st);
  if (id === 'appearance') return buildAppearance(st);
  return buildAbout(st);
}

/* 4.1 供应商 */
function providerItem(p) {
  const item = el('div', 'pitem' + (p.current ? ' cur' : ''));
  item.appendChild(el('span', 'pavatar', String(p.name || '?').charAt(0).toUpperCase()));
  const info = el('div', 'pinfo');
  const row = el('div', 'prow');
  row.appendChild(el('span', 'pname', p.name || '(未命名)'));
  if (p.current) row.appendChild(setPill('当前', 'accent'));
  row.appendChild(setPill(p.has_key ? '已设密钥' : '无密钥', p.has_key ? 'ok' : 'warn'));
  if (p.proxy) row.appendChild(setPill('代理'));
  info.appendChild(row);
  const baseLine = (p.api_style || '') + (p.base ? ' · ' + p.base : '');
  info.appendChild(el('div', 'pbase trunc', baseLine || '(未设置 Base URL)'));
  if (p.proxy) info.appendChild(el('div', 'pproxy trunc', '代理 ' + p.proxy));
  item.appendChild(info);

  const acts = el('div', 'pacts');
  if (!p.current) {
    acts.appendChild(setBtn('设为当前', 'sm', () => {
      cmd('providers.select', { name: p.name }).then(out => {
        if (out && out.ok === false) return;
        // 与 /provider 一致：自动拉一次模型列表并提醒选模型（设置页是浮层，
        // 不在下面弹模型菜单，靠输入栏的红色 chip 提示）
        resync().then(() => afterProviderSwitch(p.name, false));
      });
    }));
  }
  acts.appendChild(setBtn('密钥', 'sm', () => promptKey(p.name), 'key'));
  const del = setIconBtn('trash', '删除供应商 ' + p.name, async () => {
    if (await confirmDlg('删除供应商 ' + p.name + '？其 API Key 也会一并移除。', { title: '删除供应商', ok: '删除' })) {
      cmd('providers.rm', { name: p.name }).then(() => resync());
    }
  }, 'danger');
  acts.appendChild(del);
  item.appendChild(acts);
  return item;
}

function buildProviders(st) {
  const s = sec('providers', '供应商', '管理 API 供应商。API Key 存入本机凭据库，界面只显示是否已设置。');
  const list = el('div', 'plist');
  const provs = S.providers || [];
  if (!provs.length) {
    const empty = el('div', 'pempty');
    const ic = setIcon('layers', 'lg');
    if (ic) empty.appendChild(ic);
    empty.appendChild(el('div', 'pempty-title', '尚未配置任何供应商'));
    empty.appendChild(el('div', 'pempty-sub', '在下方填写 Base URL 添加第一个供应商。'));
    list.appendChild(empty);
  }
  for (const p of provs) list.appendChild(providerItem(p));
  const count = el('span', 'badge', String(provs.length));
  s.appendChild(card([setCardHead('已配置', count), list]));

  // 添加表单（字段与旧实现一致：名称 / API 风格 / Base URL / API Key / 代理）
  const name = setInput('名称（可空，自动取名）');
  const style = el('select');
  for (const v of ['openai-chat', 'openai-responses', 'anthropic']) {
    const o = el('option', null, v);
    o.value = v;
    style.appendChild(o);
  }
  const base = setInput('https://api.openai.com/v1');
  const secret = setSecretField('API Key（可空）');
  const proxy = setInput('http://127.0.0.1:7890（可空）');
  const row1 = el('div', 'set-form-2');
  row1.appendChild(field('名称', name));
  row1.appendChild(field('API 风格', style));
  const row3 = el('div', 'set-form-2');
  row3.appendChild(field('API Key', secret));
  row3.appendChild(field('代理', proxy));
  const add = setBtn('添加供应商', 'primary', async () => {
    if (!base.value.trim()) { toast('Base URL 必填', 'bad'); return; }
    const out = await cmd('providers.add', {
      name: name.value.trim(), api_style: style.value, base: base.value.trim(),
      key: secret.input.value, proxy: proxy.value.trim(),
    });
    if (out && out.ok) {
      toast('已添加 ' + (out.name || '供应商'), 'ok');
      name.value = base.value = secret.input.value = proxy.value = '';
      resync();
    }
  }, 'plus');
  add.classList.add('set-form-submit');
  s.appendChild(card([
    setCardHead('添加供应商'),
    row1,
    field('Base URL', base, '请求根地址，例如 https://api.openai.com/v1'),
    row3,
    add,
  ]));
  return s;
}

/* 4.2 模型 */
function buildModels() {
  const s = sec('models', '模型', '当前模型的展示与切换。模型列表需从当前供应商拉取。');
  const hero = el('div', 'model-hero');
  const tile = el('span', 'model-ico');
  const ic = setIcon('sparkles', 'lg');
  if (ic) tile.appendChild(ic);
  hero.appendChild(tile);
  const info = el('div', 'model-info');
  const nameEl = el('div', 'model-name', modelShortName() || '(未选择模型)');
  const subEl = el('div', 'model-sub', (S.provider || '未选择供应商') + ' · ' + (S.models || []).length + ' 个可用模型');
  info.appendChild(nameEl);
  info.appendChild(subEl);
  hero.appendChild(info);

  const grid = el('div', 'modelgrid');
  const fetchBtn = setBtn('拉取模型列表', '', () => {}, 'refresh');
  fetchBtn.classList.add('model-fetch');
  const setFetchLabel = txt => { const l = fetchBtn.querySelector('.btn-label'); if (l) l.textContent = txt; };
  fetchBtn.onclick = async () => {
    fetchBtn.disabled = true;
    setFetchLabel('拉取中…');
    const out = await cmd('models.fetch', {});
    fetchBtn.disabled = false;
    setFetchLabel('拉取模型列表');
    if (out && out.ok && Array.isArray(out.models)) {
      S.models = out.models;
      toast('已获取 ' + out.models.length + ' 个模型', 'ok');
      paint();
    } else if (out && out.error) toast(out.error, 'bad');
  };
  hero.appendChild(fetchBtn);
  s.appendChild(card([hero]));

  const paint = () => {
    grid.replaceChildren();
    subEl.textContent = (S.provider || '未选择供应商') + ' · ' + (S.models || []).length + ' 个可用模型';
    if (!(S.models || []).length) {
      const empty = el('div', 'model-empty');
      const eic = setIcon('sparkles', 'lg');
      if (eic) empty.appendChild(eic);
      empty.appendChild(el('div', 'pempty-title', '还没有模型列表'));
      empty.appendChild(el('div', 'pempty-sub', '点击「拉取模型列表」从当前供应商获取可用模型。'));
      grid.appendChild(empty);
      return;
    }
    for (const m of S.models) {
      const cur = isCurrentModel(m);
      const tag = el('button', 'modeltag' + (cur ? ' on' : ''));
      tag.type = 'button';
      if (cur) { const c = setIcon('check', 'sm'); if (c) tag.appendChild(c); }
      tag.appendChild(el('span', 'modeltag-name', m));
      tag.onclick = () => {
        cmd('model.set', { model: m }).then(out => {
          if (out && out.ok !== false) {
            S.model = modelLabelOf(m);
            S.modelSet = true;
            nameEl.textContent = m;
            paint();
            toast('模型已切换', 'ok');
            setCall('renderFoot');
            setCall('renderStatLine');
          }
        });
      };
      grid.appendChild(tag);
    }
  };
  paint();
  s.appendChild(card([setCardHead('可用模型'), grid, el('div', 'set-hint', '模型列表来自当前供应商的 /models 接口；切换供应商后需要重新拉取。')]));
  return s;
}

/* 4.3 代理（Agent） */
function buildAgent(st) {
  const s = sec('agent', '代理', '思考级别、工具开关与系统提示词；这些设置作用于之后的每个回合。');
  const thinkVal = Number(st.think_level == null ? 0 : st.think_level);
  const level = THINK_LEVELS[clamp(thinkVal, 0, 4)] || THINK_LEVELS[0];
  const range = el('input');
  range.type = 'range';
  range.min = '0'; range.max = '4'; range.step = '1';
  range.value = String(clamp(thinkVal, 0, 4));
  range.className = 'set-range';
  const rangeVal = el('span', 'rangeval', range.value);
  const thinkRow = el('div', 'think-row');
  thinkRow.appendChild(range);
  thinkRow.appendChild(rangeVal);
  const thinkDesc = el('div', 'set-hint', level.desc + '（' + level.name + '）');
  const ticks = el('div', 'range-ticks');
  const tickEls = [];
  for (const lv of THINK_LEVELS) {
    const t = el('span', 'range-tick' + (lv.v === Number(range.value) ? ' on' : ''), lv.name);
    ticks.appendChild(t);
    tickEls.push(t);
  }
  const paintThink = () => {
    const v = Number(range.value);
    rangeVal.textContent = String(v);
    const lv = THINK_LEVELS[v] || THINK_LEVELS[0];
    thinkDesc.textContent = lv.desc + '（' + lv.name + '）';
    tickEls.forEach((t, i) => t.classList.toggle('on', i === v));
  };
  range.oninput = paintThink;
  range.onchange = () => setPatch({ think_level: Number(range.value) });
  const thinkField = el('div', 'set-field');
  thinkField.appendChild(el('label', 'set-label', '思考级别'));
  thinkField.appendChild(thinkRow);
  thinkField.appendChild(ticks);
  thinkField.appendChild(thinkDesc);

  const toolsRow = switchRow('启用工具调用', st.tools !== false, v => setPatch({ tools: v }),
    '关闭后模型只能回复文本，无法读写文件或执行命令。');
  const toolsCard = el('div', 'set-row-block');
  toolsCard.appendChild(toolsRow);
  s.appendChild(card([setCardHead('推理与工具'), thinkField, el('div', 'set-divider'), toolsCard]));

  // 系统提示词
  const sp = setTextarea('系统提示词（留空使用内置默认）', st.system_prompt || '', 6);
  const counter = el('span', 'set-hint mono', (sp.value.length) + ' 字');
  sp.oninput = () => { counter.textContent = sp.value.length + ' 字'; };
  const saveSp = setBtn('保存系统提示词', 'primary', () => setPatch({ system_prompt: sp.value }), 'check');
  const foot = el('div', 'set-form-actions');
  foot.appendChild(counter);
  foot.appendChild(el('span', 'grow'));
  foot.appendChild(saveSp);
  s.appendChild(card([setCardHead('系统提示词'), sp, foot]));
  return s;
}

/* 4.4 沙箱 */
function buildSandbox(st) {
  const s = sec('sandbox', '沙箱', '执行与写入的权限边界。autoallow（自动放行）仅在完全访问模式下生效。');
  const cur = st.sandbox_mode || S.sandbox || 'full-access';
  const curDef = SANDBOX_MODES.find(m => m.v === cur) || SANDBOX_MODES[SANDBOX_MODES.length - 1];
  const seg = el('div', 'seg seg-wide');
  const desc = el('div', 'set-hint');
  const paintDesc = v => {
    const m = SANDBOX_MODES.find(x => x.v === v) || curDef;
    desc.textContent = m.desc;
  };
  for (const m of SANDBOX_MODES) {
    const b = el('button', 'sandbox-opt' + (m.v === cur ? ' on' : ''));
    b.type = 'button';
    b.title = m.desc;
    b.appendChild(el('span', 'sandbox-opt-name', sandboxLabel(m.v)));
    seg.appendChild(b);
    b.onclick = () => {
      if (b.classList.contains('on')) return;
      setPatch({ sandbox_mode: m.v }).then(out => {
        if (out && out.ok !== false) {
          S.sandbox = m.v;
          $$('.sandbox-opt', seg).forEach(x => x.classList.toggle('on', x === b));
          paintDesc(m.v);
          updateAutoNote();
          setCall('renderStatLine');
        }
      });
    };
  }
  paintDesc(cur);
  const modeField = el('div', 'set-field');
  modeField.appendChild(el('label', 'set-label', '沙箱模式'));
  modeField.appendChild(seg);
  modeField.appendChild(desc);

  const autoRow = switchRow('自动放行（autoallow）', !!st.autoallow, v => setPatch({ autoallow: v }).then(() => updateAutoNote()),
    '开启后工具调用不再逐次请求审批；仅在「完全访问」模式下真正生效。');
  const noteWrap = el('div', 'set-note-wrap');
  function updateAutoNote() {
    const auto = !!(S.settings || {}).autoallow;
    const mode = (S.settings || {}).sandbox_mode || S.sandbox || 'full-access';
    noteWrap.replaceChildren();
    if (auto && mode === 'full-access') noteWrap.appendChild(setNote('自动放行已开启：完全访问模式下的工具调用将不再请求审批。', 'warn'));
    else if (auto) noteWrap.appendChild(setNote('自动放行已开启，但当前不是完全访问模式，因此不会生效。', 'info'));
  }
  updateAutoNote();
  s.appendChild(card([setCardHead('权限模式'), modeField, el('div', 'set-divider'), autoRow, noteWrap]));
  return s;
}
function sandboxLabel(v) {
  return v === 'read-only' ? '只读' : v === 'edit-only' ? '仅编辑' : v === 'full-access' ? '完全访问' : v;
}

/* 4.5 上下文 */
function buildContext(st) {
  const s = sec('context', '上下文', '上下文接近窗口上限时自动压缩历史，并生成摘要继续对话。');
  const prov = setInput('供应商（可空 = 当前）', st.compact_provider || '');
  const model = setInput('模型（可空 = 当前）', st.compact_model || '');
  const save = setBtn('保存压缩设置', 'primary', () => setPatch({
    compact_provider: prov.value.trim(), compact_model: model.value.trim(),
  }), 'check');
  s.appendChild(card([
    setCardHead('自动压缩'),
    switchRow('自动上下文压缩', !!st.compact_auto, v => setPatch({ compact_auto: v }),
      '历史超出模型窗口时自动总结较早的内容，避免请求被截断。'),
    el('div', 'set-divider'),
    setCardHead('压缩专用模型'),
    el('div', 'set-hint', '留空则使用当前供应商与当前模型；也可以指定更便宜的模型专门做摘要。'),
    (() => {
      const row = el('div', 'set-form-2');
      row.appendChild(field('压缩供应商', prov));
      row.appendChild(field('压缩模型', model));
      return row;
    })(),
    save,
  ]));
  return s;
}

/* 4.6 性能 */
function buildPerf(st) {
  const s = sec('perf', '性能', '工具线程池与团队协作并发上限；修改在之后的回合生效。');
  const mt = el('input');
  mt.type = 'number'; mt.min = '1'; mt.max = '16';
  mt.value = String(st.max_threads || 8);
  mt.className = 'set-num';
  const mc = el('input');
  mc.type = 'number'; mc.min = '1'; mc.max = '100';
  mc.value = String(st.teamwork_max_children || 5);
  mc.className = 'set-num';
  const apply1 = setBtn('应用', '', () => {
    const n = clamp(Number(mt.value) || 1, 1, 16);
    mt.value = n;
    setPatch({ max_threads: n });
  }, 'check');
  const apply2 = setBtn('应用', '', () => {
    const n = clamp(Number(mc.value) || 1, 1, 100);
    mc.value = n;
    setPatch({ teamwork_max_children: n });
  }, 'check');
  const row1 = el('div', 'set-num-row');
  row1.appendChild(mt); row1.appendChild(apply1);
  const row2 = el('div', 'set-num-row');
  row2.appendChild(mc); row2.appendChild(apply2);
  s.appendChild(card([
    setCardHead('并发'),
    field('工具线程池 1-16', row1, '并行执行工具调用的最大线程数。'),
    field('团队子代理上限 1-100', row2, 'Teamwork 编排中同时运行的子代理数量上限。'),
  ]));
  return s;
}

/* 4.7 外观 */
function buildAppearance(st) {
  const s = sec('appearance', '外观', '默认外观为黑白灰深色（与 /export 导出的会话页同一套令牌）；第三方主题放入 exe 目录的 .cell/theme/<名称>/ 后出现在下方。');
  const grid = el('div', 'themegrid');
  const paintTheme = (name, label, meta, swatch, on) => {
    const b = el('button', 'themecard' + (on ? ' on' : ''));
    b.type = 'button';
    const sw = el('div', 'tswatch');
    for (const c of swatch) { const i = el('i'); i.style.background = c; sw.appendChild(i); }
    b.appendChild(sw);
    const nameRow = el('div', 'tname-row');
    nameRow.appendChild(el('span', 'tname', label));
    if (on) { const c = setIcon('check', 'sm'); if (c) { c.classList.add('tcheck'); nameRow.appendChild(c); } }
    b.appendChild(nameRow);
    b.appendChild(el('span', 'tmeta', meta));
    b.onclick = () => { Theme.set(name); renderSettings(); };
    grid.appendChild(b);
  };
  paintTheme('', '默认', '与导出的会话页同源 · 黑白灰深色', ['var(--bg)', 'var(--fg)', 'var(--accent)'], !S.theme);
  const themes = Theme.list();
  for (const t of themes) {
    paintTheme(t.name, t.label || t.name,
      (t.type === 'light' ? '浅色' : '深色') + (t.desc ? ' · ' + t.desc : ''),
      (t.swatch && t.swatch.length) ? t.swatch.slice(0, 4) : ['var(--bg2)', 'var(--fg2)', 'var(--line2)'],
      S.theme === t.name);
  }
  s.appendChild(card([setCardHead('主题'), grid]));
  if (!themes.length) {
    s.appendChild(setNote('未发现第三方主题，当前使用默认外观。', 'info'));
  }

  // 动画等级
  const animCur = String(document.documentElement.dataset.anim == null ? '2' : document.documentElement.dataset.anim);
  const animSeg = makeSeg(
    [{ v: '0', label: '关', desc: '关闭所有动画与过渡' }, { v: '1', label: '精简', desc: '仅保留极短的过渡' }, { v: '2', label: '完整', desc: '完整动效' }],
    animCur,
    v => { Theme.set(S.theme, Number(v)); renderSettings(); }
  );
  const animField = el('div', 'set-field');
  animField.appendChild(el('label', 'set-label', '动画等级'));
  animField.appendChild(animSeg);
  animField.appendChild(el('div', 'set-hint', '跟随系统 prefers-reduced-motion；选择保存在本机浏览器。'));
  s.appendChild(card([setCardHead('动效'), animField]));

  const note = el('div', 'themenote');
  note.appendChild(el('span', null, '第三方主题：在 exe 目录的 '));
  note.appendChild(el('code', null, '.cell/theme/<名称>/'));
  note.appendChild(el('span', null, '（与配置、会话、凭据同一目录）放置 theme.json（label / type / desc / swatch）与 theme.css（覆盖 CSS 变量），刷新本页即可在此选择。'));
  s.appendChild(note);
  return s;
}

/* 4.8 关于 */
function buildAbout(st) {
  const s = sec('about', '关于', '版本与运行状态、已打开的工作区、快捷键与数据目录。');
  // 产品卡
  const hero = el('div', 'about-hero');
  const logo = el('span', 'about-logo');
  logo.appendChild(cellLogoSvg('about-logo-svg'));
  hero.appendChild(logo);
  const info = el('div', 'about-info');
  const nameRow = el('div', 'about-name-row');
  nameRow.appendChild(el('span', 'about-name', 'cell'));
  nameRow.appendChild(setPill('预览版', 'accent'));
  if (S.mode === 'demo') nameRow.appendChild(setPill('演示模式', 'warn'));
  info.appendChild(nameRow);
  info.appendChild(el('div', 'about-sub', '本地代理工作台 · cell.cpp 智能体运行时的桌面壳 + 本地 Web 服务'));
  info.appendChild(el('div', 'about-desc', '界面与 /export 导出的会话页同源，零外部依赖：无 CDN、无外部字体、无框架。'));
  hero.appendChild(info);
  s.appendChild(card([hero]));

  // 桌面壳偏好（.cell/cell-app.json，随 exe 走，与浏览器 profile 无关）
  const pf = S.prefs || {};
  const deskRows = [];
  if (pf.tray_supported)
    deskRows.push(switchRow('关闭窗口后驻留托盘', pf.tray !== false, v => setShellPrefs({ tray: v }),
      '关闭后点托盘图标恢复前台；关掉这个开关，关闭窗口就是退出程序（运行中的回合会中断）。'));
  deskRows.push(switchRow('启动时提醒更新', pf.update_check !== false, v => setShellPrefs({ update_check: v }),
    '启动时比对 GitHub 最新发布 tag 里的提交短号，有新版本就在左侧栏「用量」旁显示入口；关闭后不再联网检查。'));
  if (deskRows.length) s.appendChild(card([setCardHead('桌面'), ...deskRows]));

  // 运行状态
  const kv = el('div', 'kv');
  const curProvider = (S.providers || []).find(p => p.current);
  const lv = THINK_LEVELS[clamp(Number(st.think_level == null ? 0 : st.think_level), 0, 4)];
  const rows = [
    ['连接', S.mode === 'demo' ? '演示模式（数据不持久化）' : (S.connected ? '已连接本地服务' : '连接断开，正在重试')],
    ['模型', modelShortName() || '(未选择)'],
    ['供应商', (curProvider && curProvider.name) || S.provider || '(未选择)'],
    ['沙箱', sandboxLabel(st.sandbox_mode || S.sandbox || 'full-access') + ' · ' + (st.sandbox_mode || S.sandbox || 'full-access')],
    ['工具调用', st.tools === false ? '已关闭' : '已开启'],
    ['思考级别', (lv ? lv.name + ' · ' + lv.desc : 'off')],
    ['上下文压缩', st.compact_auto ? '已开启' : '已关闭'],
    ['工作区', (S.workspaces || []).length + ' 个已打开'],
    ['会话', (S.sessionsTotal || (S.sessions || []).length) + ' 条记录'],
  ];
  for (const [k, v] of rows) {
    const r = el('div', 'kv-row');
    r.appendChild(el('span', 'kv-k', k));
    r.appendChild(el('span', 'kv-v' + (k === '模型' ? ' mono' : ''), v));
    kv.appendChild(r);
  }
  s.appendChild(card([setCardHead('运行状态'), kv]));

  // 工作区（原「数据」分节的能力：列出已打开工作区 / 复制路径 / 打开新工作区）
  const list = el('div', 'wslist');
  const works = S.workspaces || [];
  if (!works.length) {
    const empty = el('div', 'pempty');
    const ic = setIcon('folder', 'lg');
    if (ic) empty.appendChild(ic);
    empty.appendChild(el('div', 'pempty-title', '没有打开的工作区'));
    empty.appendChild(el('div', 'pempty-sub', '打开一个目录后，cell 会在其中恢复会话。'));
    list.appendChild(empty);
  }
  for (const w of works) {
    const row = el('div', 'wsrow');
    const ic = setIcon('folder', 'ws-ico');
    if (ic) row.appendChild(ic);
    const col = el('div', 'ws-info');
    col.appendChild(el('div', 'ws-name', baseName(w.cwd) || w.ws));
    col.appendChild(el('div', 'ws-path mono trunc', w.cwd || ''));
    row.appendChild(col);
    row.appendChild(setBtn('复制路径', 'sm', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(w.cwd);
      toast('已复制路径', 'ok');
    }, 'copy'));
    list.appendChild(row);
  }
  const openBtn = setBtn('打开工作区', '', () => openWsDialog(), 'folderOpen');
  list.appendChild(openBtn);
  s.appendChild(card([setCardHead('工作区', el('span', 'badge', String(works.length))), list]));

  // 快捷键
  const shortcuts = [
    ['Ctrl + ,', '打开 / 关闭设置'],
    ['Ctrl + Shift + F', '搜索全部会话内容'],
    ['Ctrl + N', '新建会话'],
    ['Ctrl + P', '快速打开文件'],
    ['Ctrl + G', 'Git / Worktree 面板'],
    ['Ctrl + B', '收起 / 展开侧栏'],
    ['Shift + Tab', '切换输入模式'],
    ['Esc', '关闭最上层浮层'],
  ];
  const grid = el('div', 'shortcut-grid');
  for (const [k, v] of shortcuts) {
    const r = el('div', 'sc-row');
    r.appendChild(el('span', 'sc-key', v));
    r.appendChild(setKbd(k));
    grid.appendChild(r);
  }
  s.appendChild(card([setCardHead('快捷键'), grid]));

  // 数据位置
  const note = el('div', 'themenote');
  note.appendChild(el('span', null, '配置、会话记录、凭据与主题都保存在 exe 目录的 '));
  note.appendChild(el('code', null, '.cell/'));
  note.appendChild(el('span', null, ' 下（与导出的历史存档同源）。主题与动画等级保存在本机浏览器 localStorage；桌面卡片里的开关存在 '));
  note.appendChild(el('code', null, '.cell/cell-app.json'));
  note.appendChild(el('span', null, '（随 exe 走，换浏览器 profile 也不会丢）。'));
  s.appendChild(note);
  return s;
}

/* ---- API Key 弹窗 -------------------------------------------------- */
function promptKey(name) {
  showModal('设置 API Key · ' + name, '', [
    { label: '取消', cls: 'ghost', fn: closeModal },
  ], (body) => {
    body.appendChild(el('div', 'modal-desc', '密钥保存在本机凭据库，不会回显明文，也不会写入会话记录。'));
    const secret = setSecretField('粘贴 API Key');
    secret.style.marginTop = '2px';
    body.appendChild(secret);
    const save = setBtn('保存密钥', 'accent', async () => {
      if (!secret.input.value.trim()) { toast('Key 不能为空', 'bad'); return; }
      const out = await cmd('provider.set_key', { name: name, key: secret.input.value.trim() });
      if (out && out.ok) { toast('Key 已保存', 'ok'); closeModal(); resync(); }
    }, 'key');
    save.style.marginTop = '10px';
    save.style.alignSelf = 'flex-start';
    body.appendChild(save);
    setTimeout(() => secret.input.focus(), 30);
  });
}
