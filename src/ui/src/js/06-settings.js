/* ---------- J. 设置页 ---------------------------------------------- */
const SET_SECTIONS = [
  ['providers', '供应商'], ['models', '模型'], ['agent', 'Agent'], ['sandbox', '沙箱'],
  ['context', '上下文'], ['perf', '性能'], ['appearance', '外观'], ['data', '数据'],
];
let setSection = 'providers';

function openSettings(section) {
  if (section) setSection = section;
  S.settingsOpen = true;
  location.hash = '#/settings';
  const host = $('#settings');
  host.classList.add('show');
  renderSettings();
}
function closeSettings() {
  S.settingsOpen = false;
  $('#settings').classList.remove('show');
  if (location.hash === '#/settings') history.replaceState(null, '', location.pathname + location.search);
}
function toggleSettings() { S.settingsOpen ? closeSettings() : openSettings(); }

function renderSettings() {
  const host = $('#settings');
  if (!host) return;
  const head = el('div', 'sethead');
  head.appendChild(el('h1', null, '设置'));
  head.appendChild(el('span', 'grow'));
  const st = el('span', 'small dim', S.mode === 'demo' ? '演示模式（设置不可持久化）' : '');
  head.appendChild(st);
  const close = el('button', 'btn sm', '关闭 (Esc)');
  close.onclick = closeSettings;
  head.appendChild(close);

  const body = el('div', 'setbody');
  const wrap = el('div', 'setwrap');
  const nav = el('div', 'setnav');
  for (const [id, label] of SET_SECTIONS) {
    const b = el('button', setSection === id ? 'on' : '', label);
    b.onclick = () => { setSection = id; renderSettings(); sectionScroll(id); };
    nav.appendChild(b);
  }
  const sections = el('div', 'setsections');
  for (const [id] of SET_SECTIONS) sections.appendChild(buildSection(id));
  wrap.appendChild(nav); wrap.appendChild(sections);
  body.appendChild(wrap);
  host.replaceChildren(head, body);
  requestAnimationFrame(() => sectionScroll(setSection, true));
}
function sectionScroll(id, instant) {
  const node = document.getElementById('sec-' + id);
  if (!node) return;
  node.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' });
}

function sec(id, title, desc) {
  const s = el('section', 'setsection'); s.id = 'sec-' + id;
  s.appendChild(el('h2', null, title));
  if (desc) s.appendChild(el('div', 'sdesc', desc));
  return s;
}
// 设置页卡片：纵向等距排列（此前字段间 0 间距，标签会贴到上一行输入框）
// align-items:flex-start —— 卡片是 column flex，按钮/分段控件默认会被拉成
// 整行宽（「添加供应商」曾铺满一张卡）；输入框仍需 stretch，故只对非表单
// 控件用 :where 排除，见 03-molecules.css 的 .card > .btn。
function card(children) {
  const c = el('div', 'card');
  c.style.display = 'flex';
  c.style.flexDirection = 'column';
  c.style.gap = '12px';
  c.style.alignItems = 'stretch';
  (children || []).forEach(x => x && c.appendChild(x));
  return c;
}
function field(label, control, hint) {
  const w = el('div', 'field');
  w.appendChild(el('label', null, label));
  w.appendChild(control);
  if (hint) { const h = el('div', 'tiny dim', hint); h.style.marginTop = '3px'; w.appendChild(h); }
  return w;
}
function switchRow(label, checked, onchange) {
  const row = el('div', 'row gap10');
  row.style.justifyContent = 'space-between';
  row.appendChild(el('span', 'small', label));
  const sw = el('button', 'switch' + (checked ? ' on' : ''));
  sw.onclick = () => { const nv = !sw.classList.contains('on'); sw.classList.toggle('on', nv); onchange(nv); };
  row.appendChild(sw);
  return row;
}
function segRow(label, values, cur, onpick) {
  const row = el('div', 'row gap10');
  row.style.justifyContent = 'space-between';
  row.appendChild(el('span', 'small', label));
  const seg = el('div', 'seg');
  for (const v of values) {
    const b = el('button', v.v === cur ? 'on' : '', v.label);
    b.onclick = () => onpick(v.v);
    seg.appendChild(b);
  }
  row.appendChild(seg);
  return row;
}

function setPatch(patch) {
  return cmd('settings.set', { patch }).then(out => {
    if (out && out.ok && out.settings) { S.settings = Object.assign(S.settings, out.settings); }
    if (out && out.ok) toast('已保存', 'ok');
    renderStatLine();
    return out;
  });
}

function buildSection(id) {
  const st = S.settings || {};
  if (id === 'providers') {
    const s = sec('providers', '供应商', '管理 API 供应商。API Key 存入本地凭据库，界面只显示是否已设置。');
    const list = el('div', 'plist');
    if (!S.providers.length) {
      const empty = el('div', 'pempty', '尚未配置任何供应商 —— 在下方填写 Base URL 添加一个。');
      list.appendChild(empty);
    }
    for (const p of S.providers) {
      const item = el('div', 'pitem' + (p.current ? ' cur' : ''));
      item.appendChild(el('span', 'pavatar', (p.name || '?').charAt(0).toUpperCase()));
      const col = el('div', 'col grow');
      col.appendChild(el('span', 'pname', p.name + (p.current ? ' · 当前' : '')));
      col.appendChild(el('span', 'pbase trunc', (p.api_style || '') + ' · ' + (p.base || '')));
      item.appendChild(col);
      item.appendChild(el('span', 'pill ' + (p.has_key ? 'ok' : 'warn'), p.has_key ? '已设 Key' : '无 Key'));
      const sel = el('button', 'btn sm', '选择');
      sel.onclick = () => cmd('providers.select', { name: p.name }).then(() => resync());
      item.appendChild(sel);
      const k = el('button', 'btn sm', '设置 Key');
      k.onclick = () => promptKey(p.name);
      item.appendChild(k);
      const rm = el('button', 'btn sm danger', '删除');
      rm.onclick = async () => { if (await confirmDlg('删除供应商 ' + p.name + '？', { title: '删除供应商', ok: '删除' })) cmd('providers.rm', { name: p.name }).then(() => resync()); };
      item.appendChild(rm);
      list.appendChild(item);
    }
    s.appendChild(card([list]));
    // 新增表单
    const name = el('input'); name.type = 'text'; name.placeholder = '名称（可空，自动取名）';
    const style = el('select');
    for (const v of ['openai-chat', 'openai-responses', 'anthropic']) { const o = el('option', null, v); o.value = v; style.appendChild(o); }
    const base = el('input'); base.type = 'text'; base.placeholder = 'Base URL，例如 https://api.openai.com/v1';
    const key = el('input'); key.type = 'password'; key.placeholder = 'API Key（可空）';
    const proxy = el('input'); proxy.type = 'text'; proxy.placeholder = '代理（可空），例如 http://127.0.0.1:7890';
    const row1 = el('div', 'setrow'); row1.appendChild(field('名称', name)); row1.appendChild(field('API 风格', style));
    const row2 = el('div', 'setrow one'); row2.appendChild(field('Base URL', base));
    const row3 = el('div', 'setrow'); row3.appendChild(field('API Key', key)); row3.appendChild(field('代理', proxy));
    const add = el('button', 'btn primary sm', '添加供应商');
    add.onclick = async () => {
      if (!base.value.trim()) { toast('Base URL 必填', 'bad'); return; }
      const out = await cmd('providers.add', { name: name.value.trim(), api_style: style.value, base: base.value.trim(), key: key.value, proxy: proxy.value.trim() });
      if (out && out.ok) { toast('已添加 ' + (out.name || ''), 'ok'); name.value = base.value = key.value = proxy.value = ''; resync(); }
    };
    s.appendChild(card([row1, row2, row3, add]));
    return s;
  }
  if (id === 'models') {
    const s = sec('models', '模型', '当前模型的展示与切换。');
    const cur = el('div', 'row gap8');
    cur.appendChild(el('span', 'small mut', '当前模型：'));
    cur.appendChild(el('span', 'pill accent mono', S.model || '(none)'));
    s.appendChild(card([cur]));
    const fetchBtn = el('button', 'btn sm', '拉取模型列表');
    const grid = el('div', 'modelgrid');
    const paint = () => {
      grid.replaceChildren();
      if (!S.models.length) grid.appendChild(el('span', 'dim small', '点击「拉取模型列表」从供应商获取可用模型。'));
      for (const m of S.models) {
        const tag = el('div', 'modeltag' + (m === S.model ? ' on' : ''), m);
        tag.onclick = () => cmd('model.set', { model: m }).then(() => { S.model = m; renderFoot(); paint(); toast('模型已切换', 'ok'); });
        grid.appendChild(tag);
      }
    };
    fetchBtn.onclick = async () => {
      fetchBtn.textContent = '拉取中…';
      const out = await cmd('models.fetch', {});
      fetchBtn.textContent = '拉取模型列表';
      if (out && out.ok && Array.isArray(out.models)) { S.models = out.models; toast('已获取 ' + out.models.length + ' 个模型', 'ok'); paint(); }
      else if (out && out.error) toast(out.error, 'bad');
    };
    paint();
    s.appendChild(card([fetchBtn, grid]));
    return s;
  }
  if (id === 'agent') {
    const s = sec('agent', 'Agent', '思考级别、工具开关与系统提示词。');
    const think = el('input'); think.type = 'range'; think.min = '0'; think.max = '4'; think.step = '1';
    think.value = String(st.think_level == null ? 0 : st.think_level);
    const tv = el('span', 'rangeval', String(think.value));
    const thinkRow = el('div', 'row gap10');
    thinkRow.appendChild(think); thinkRow.appendChild(tv);
    think.oninput = () => {
      tv.textContent = think.value;
      const lv = THINK_LEVELS[Number(think.value)];
      tv.title = lv ? lv.desc : '';
    };
    think.onchange = () => setPatch({ think_level: Number(think.value) });
    const sp = el('textarea'); sp.rows = 5; sp.value = st.system_prompt || '';
    sp.placeholder = '系统提示词（留空使用内置默认）';
    const saveSp = el('button', 'btn sm', '保存系统提示词');
    saveSp.onclick = () => setPatch({ system_prompt: sp.value });
    s.appendChild(card([
      field('思考级别 0-4（' + (THINK_LEVELS[Number(think.value)] ? THINK_LEVELS[Number(think.value)].desc : '') + '）', thinkRow),
      switchRow('启用工具调用', st.tools !== false, v => setPatch({ tools: v })),
      field('系统提示词', sp),
      saveSp,
    ]));
    return s;
  }
  if (id === 'sandbox') {
    const s = sec('sandbox', '沙箱', '执行与写入的权限边界。autoallow 仅在完全访问模式下生效。');
    const seg = el('div', 'seg');
    for (const m of SANDBOX_MODES) {
      const b = el('button', (st.sandbox_mode === m.v) ? 'on' : '', m.v);
      b.title = m.desc;
      b.onclick = () => setPatch({ sandbox_mode: m.v }).then(() => { S.sandbox = m.v; renderStatLine(); });
      seg.appendChild(b);
    }
    s.appendChild(card([
      field('沙箱模式', seg),
      switchRow('自动放行（autoallow）', !!st.autoallow, v => setPatch({ autoallow: v })),
    ]));
    return s;
  }
  if (id === 'context') {
    const s = sec('context', '上下文', '自动压缩与压缩专用模型。');
    const prov = el('input'); prov.type = 'text'; prov.value = st.compact_provider || ''; prov.placeholder = '供应商（可空=当前）';
    const model = el('input'); model.type = 'text'; model.value = st.compact_model || ''; model.placeholder = '模型（可空=当前）';
    const save = el('button', 'btn sm', '保存');
    save.onclick = () => setPatch({ compact_provider: prov.value.trim(), compact_model: model.value.trim() });
    s.appendChild(card([
      switchRow('自动上下文压缩', !!st.compact_auto, v => setPatch({ compact_auto: v })),
      field('压缩供应商', prov),
      field('压缩模型', model),
      save,
    ]));
    return s;
  }
  if (id === 'perf') {
    const s = sec('perf', '性能', '线程池大小与团队协作子代理上限。');
    const mt = el('input'); mt.type = 'number'; mt.min = '1'; mt.max = '16'; mt.value = String(st.max_threads || 8);
    const mc = el('input'); mc.type = 'number'; mc.min = '1'; mc.max = '100'; mc.value = String(st.teamwork_max_children || 5);
    const b1 = el('button', 'btn sm', '应用');
    b1.onclick = () => { const n = clamp(Number(mt.value) || 1, 1, 16); mt.value = n; setPatch({ max_threads: n }); };
    const b2 = el('button', 'btn sm', '应用');
    b2.onclick = () => { const n = clamp(Number(mc.value) || 1, 1, 100); mc.value = n; setPatch({ teamwork_max_children: n }); };
    const w1 = el('div', 'row gap8'); w1.appendChild(mt); w1.appendChild(b1);
    const w2 = el('div', 'row gap8'); w2.appendChild(mc); w2.appendChild(b2);
    s.appendChild(card([field('工具线程池 1-16', w1), field('团队子代理上限 1-100', w2)]));
    return s;
  }
  if (id === 'appearance') {
    const s = sec('appearance', '外观', '默认外观为黑白灰深色（无彩色强调，与 /export 导出的会话页同一套中立灰阶）。第三方主题放入 <exe 目录>/.cell/theme/<名称>/ 即出现在下方；选择保存在本机浏览器。');
    const themes = Theme.list();
    const grid = el('div', 'themegrid');
    // 「默认外观」永远存在，且是初始选中项
    {
      const b = el('button', 'themecard' + (S.theme ? '' : ' on'));
      b.type = 'button';
      const sw = el('div', 'tswatch');
      for (const c of ['#0e0e10', '#e8e8ea', '#8f8f95']) { const i = el('i'); i.style.background = c; sw.appendChild(i); }
      b.appendChild(sw);
      b.appendChild(el('span', 'tname', '默认'));
      b.appendChild(el('span', 'tmeta', '与导出的会话页同源 · 黑白灰深色'));
      b.onclick = () => { Theme.set(''); renderSettings(); };
      grid.appendChild(b);
    }
    for (const t of themes) {
      const b = el('button', 'themecard' + (S.theme === t.name ? ' on' : ''));
      b.type = 'button';
      const sw = el('div', 'tswatch');
      for (const c of (t.swatch || [])) { const i = el('i'); i.style.background = c; sw.appendChild(i); }
      b.appendChild(sw);
      b.appendChild(el('span', 'tname', t.label));
      b.appendChild(el('span', 'tmeta', (t.type === 'light' ? '浅色' : '深色') + (t.desc ? ' · ' + t.desc : '')));
      b.onclick = () => { Theme.set(t.name); renderSettings(); };
      grid.appendChild(b);
    }
    const animSeg = el('div', 'seg');
    for (const a of [{ v: 0, label: '关' }, { v: 1, label: '精简' }, { v: 2, label: '完整' }]) {
      const b = el('button', String(document.documentElement.dataset.anim) === String(a.v) ? 'on' : '', a.label);
      b.onclick = () => { Theme.set(S.theme, a.v); renderSettings(); };
      animSeg.appendChild(b);
    }
    s.appendChild(card([field('主题', grid), field('动画等级', animSeg)]));
    if (!themes.length) {
      const none = el('div', 'themenote');
      none.appendChild(el('span', null, '未发现第三方主题，当前使用默认外观。'));
      s.appendChild(none);
    }
    const note = el('div', 'themenote');
    note.appendChild(el('span', null, '第三方主题：在 exe 目录的 '));
    note.appendChild(el('code', null, '.cell/theme/<名称>/'));
    note.appendChild(el('span', null, '（与配置、会话、凭据同一目录）放置 theme.json（label / type / desc / swatch）与 theme.css（覆盖 CSS 变量），刷新本页即可在此选择。'));
    s.appendChild(note);
    return s;
  }
  // data
  const s = sec('data', '数据', '已打开工作区及其目录。');
  const list = el('div', 'plist');
  for (const w of S.workspaces) {
    const it = el('div', 'pitem');
    const col = el('div', 'col grow');
    col.appendChild(el('span', 'pname', baseName(w.cwd) || w.ws));
    col.appendChild(el('span', 'pbase trunc', w.cwd || ''));
    it.appendChild(col);
    const cp = el('button', 'btn sm', '复制路径');
    cp.onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(w.cwd); toast('已复制', 'ok'); };
    it.appendChild(cp);
    list.appendChild(it);
  }
  if (!S.workspaces.length) list.appendChild(el('div', 'pempty', '没有打开的工作区。'));
  s.appendChild(card([list]));
  const openBtn = el('button', 'btn sm');
  openBtn.appendChild(iconEl('folder', 'sm'));
  openBtn.appendChild(el('span', null, '打开工作区'));
  openBtn.onclick = () => openWsDialog();
  s.appendChild(card([openBtn]));
  return s;
}

function promptKey(name) {
  showModal('设置 API Key · ' + name, '', [
    { label: '取消', cls: '', fn: closeModal },
  ], (body) => {
    const inp = el('input'); inp.type = 'password'; inp.placeholder = '粘贴 API Key';
    body.appendChild(inp);
    const save = el('button', 'btn primary sm', '保存');
    save.style.marginTop = '9px';
    save.onclick = async () => {
      if (!inp.value.trim()) { toast('Key 不能为空', 'bad'); return; }
      const out = await cmd('provider.set_key', { name: name, key: inp.value.trim() });
      if (out && out.ok) { toast('Key 已保存', 'ok'); closeModal(); resync(); }
    };
    body.appendChild(save);
    setTimeout(() => inp.focus(), 30);
  });
}
