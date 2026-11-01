/* =====================================================================
   11 · Skills 管理页（整页浮层 #skillsPage）

   左栏是技能清单（可搜索），右栏是详情与正文预览。

   技能是「按需显式载入」的：清单里的每一条都能被 /skill <name> 注入当前
   会话，没有启用/禁用这种后台开关 —— 面板也不发明一套自己的状态。

   后端契约（见 cell-app-core.hpp）：
     skills.list   → {skills:[{name,description,file}], root}
     skills.read   → {name, description, file, body}   正文（已剥 front matter）
     skills.reveal → 在文件管理器里定位（没给 name 就打开始目录）
     skill.load    → 把正文注入当前会话（与 CLI 的 /skill 同一条路）
   ===================================================================== */
'use strict';

const SK = {
  list: [],                 // [{name, description, file}]
  root: '',                 // .cell/skills
  sel: '', q: '',           // 选中的技能名 / 搜索词
  body: '', bodyName: '',   // 正文缓存（bodyName 与 sel 对齐才算读到）
  err: '', loading: false,
};

/* ---------- 数据 ---------------------------------------------------- */
function skFind(name) {
  return (SK.list || []).find(s => s.name === name) || null;
}
function skFiltered() {
  const q = (SK.q || '').trim().toLowerCase();
  const list = SK.list || [];
  if (!q) return list;
  return list.filter(s => (s.name + ' ' + (s.description || '')).toLowerCase().indexOf(q) >= 0);
}
function skJoin(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const sep = a.indexOf('\\') >= 0 ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}

async function refreshSkills() {
  SK.loading = true;
  SK.err = '';
  paintSkillList();
  try {
    const out = await api('skills.list', {});
    if (!out || out.ok === false) throw new Error((out && out.error) || '读取技能清单失败');
    SK.list = Array.isArray(out.skills) ? out.skills : [];
    SK.root = out.root || '';
    // /skill 的补全复用这份缓存
    S.skills = SK.list.map(s => ({ name: s.name, description: s.description }));
    S.skillsRoot = SK.root;
  } catch (e) {
    SK.err = e.message || String(e);
    SK.list = [];
  }
  SK.loading = false;
  const first = skFiltered()[0];
  const keep = SK.sel && skFind(SK.sel) ? SK.sel : (first ? first.name : '');
  await selectSkill(keep, true);
}

async function selectSkill(name, force) {
  name = name || '';
  if (!force && name === SK.sel && SK.bodyName) return;
  SK.sel = name;
  SK.body = '';
  SK.bodyName = '';
  SK.err = '';
  paintSkillList();
  paintSkillDetail();
  if (!name) return;
  try {
    const out = await api('skills.read', { name });
    if (!out || out.ok === false) throw new Error((out && out.error) || '读取技能失败');
    if (SK.sel !== name) return; // 读的途中用户切走了
    SK.body = out.body || '';
    SK.bodyName = name;
  } catch (e) {
    if (SK.sel !== name) return;
    SK.err = e.message || String(e);
  }
  paintSkillDetail();
}

async function revealSkill(name) {
  try {
    const out = await api('skills.reveal', name ? { name } : {});
    if (!out || out.ok === false) throw new Error((out && out.error) || '无法打开文件夹');
  } catch (e) {
    toast(e.message || String(e), 'bad');
  }
}

function loadSkillIntoChat(name) {
  const t = typeof curTab === 'function' ? curTab() : null;
  if (!t) { toast('先打开一个工作区', 'info'); return; }
  cmd('skill.load', { ws: t.ws, name }).then(out => {
    if (out && out.ok !== false) toast('已载入 ' + name + ' · ' + (out.chars || 0) + ' 字符', 'ok', 2400);
  });
}

/* ---------- 打开 / 关闭 --------------------------------------------- */
function openSkillsPage() {
  const host = $('#skillsPage');
  if (!host) return;
  if (S.skillsOpen && host.classList.contains('show')) return;
  if (S.settingsOpen) closeSettings(); // 两个整页浮层不叠在一起
  S.skillsOpen = true;
  host.classList.add('show');
  skBuild();
  paintSkillList();
  paintSkillDetail();
  refreshSkills();
}
function closeSkillsPage() {
  S.skillsOpen = false;
  const host = $('#skillsPage');
  if (!host) return;
  host.classList.remove('show');
  host.replaceChildren(); // 下次打开重新拉一遍清单
}
function toggleSkillsPage() { S.skillsOpen ? closeSkillsPage() : openSkillsPage(); }

/* ---------- 小部件 -------------------------------------------------- */
function skButton(label, icon, fn, cls) {
  const b = el('button', 'btn ' + (cls || ''));
  b.type = 'button';
  if (icon) { const i = iconEl(icon, 'sm'); if (i) b.appendChild(i); }
  b.appendChild(el('span', 'btn-label', label));
  b.onclick = fn;
  return b;
}
function skIconBtn(icon, title, fn) {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = title || '';
  b.setAttribute('aria-label', title || icon);
  const i = iconEl(icon);
  if (i) b.appendChild(i);
  b.onclick = fn;
  return b;
}

/* ---------- 骨架（只建一次） ---------------------------------------- */
function skBuild() {
  const host = $('#skillsPage');
  if (!host || host.querySelector('.sk-shell')) return;
  const shell = el('div', 'sk-shell');

  const side = el('aside', 'sk-side');
  const sh = el('div', 'sk-side-head');
  const logo = el('span', 'sk-logo');
  const li = iconEl('sparkles');
  if (li) logo.appendChild(li);
  sh.appendChild(logo);
  const title = el('div', 'sk-side-title');
  title.appendChild(el('span', 'sk-side-name', 'Skills'));
  title.appendChild(el('span', 'sk-side-sub', 'cell · 技能'));
  sh.appendChild(title);
  side.appendChild(sh);

  const search = el('div', 'sk-searchwrap');
  const inp = el('input', 'sk-search');
  inp.type = 'search';
  inp.placeholder = '搜索技能';
  inp.value = SK.q;
  inp.oninput = () => { SK.q = inp.value; paintSkillList(); };
  search.appendChild(inp);
  side.appendChild(search);

  side.appendChild(el('div', 'sk-list'));

  const foot = el('div', 'sk-side-foot');
  const open = el('button', 'sk-open');
  open.type = 'button';
  const fi = iconEl('folderOpen', 'sm');
  if (fi) open.appendChild(fi);
  open.appendChild(el('span', 'sk-open-txt', '打开技能目录'));
  open.onclick = () => revealSkill('');
  foot.appendChild(open);
  foot.appendChild(el('div', 'sk-foot-hint', 'Ctrl+Shift+K 打开 · Esc 关闭'));
  side.appendChild(foot);

  shell.appendChild(side);
  shell.appendChild(el('main', 'sk-main'));
  host.replaceChildren(shell);
}

/* ---------- 左栏：清单 ---------------------------------------------- */
function skRow(s) {
  const b = el('button', 'sk-row' + (s.name === SK.sel ? ' on' : ''));
  b.type = 'button';
  b.title = s.description || s.name;
  b.appendChild(el('span', 'sk-row-name', s.name));
  if (s.description) b.appendChild(el('span', 'sk-row-desc', s.description));
  b.onclick = () => selectSkill(s.name);
  return b;
}
function paintSkillList() {
  const box = $('#skillsPage .sk-list');
  if (!box) return;
  if (SK.loading && !SK.list.length) { box.replaceChildren(el('div', 'sk-hint', '读取中…')); return; }
  if (SK.err) { box.replaceChildren(el('div', 'sk-hint bad', SK.err)); return; }
  const items = skFiltered();
  if (!items.length) {
    box.replaceChildren(el('div', 'sk-hint', SK.q ? '没有匹配的技能' : '还没有技能'));
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach(s => frag.appendChild(skRow(s)));
  box.replaceChildren(frag);
}

/* ---------- 右栏：详情 ---------------------------------------------- */
function skEmpty() {
  const box = el('div', 'sk-empty');
  box.appendChild(el('div', 'sk-empty-title', SK.q ? '没有匹配的技能' : '还没有技能'));
  box.appendChild(el('p', 'sk-empty-txt',
    '技能是目录里的 Markdown：带 front matter（name / description）的 .md 文件，或者一个含 SKILL.md 的目录。放进技能目录就会出现在这里，用 /skill <名称> 按需载入。'));
  if (SK.root) box.appendChild(el('code', 'sk-path', SK.root));
  box.appendChild(skButton('打开技能目录', 'folderOpen', () => revealSkill('')));
  return box;
}
function paintSkillDetail() {
  const main = $('#skillsPage .sk-main');
  if (!main) return;
  const sk = SK.sel ? skFind(SK.sel) : null;
  const t = typeof curTab === 'function' ? curTab() : null;

  const head = el('header', 'sk-head');
  const col = el('div', 'sk-head-main');
  col.appendChild(el('h1', 'sk-head-title', sk ? sk.name : 'Skills'));
  col.appendChild(el('p', 'sk-head-desc',
    sk ? (sk.description || '这个技能没有写描述') : (SK.root ? '技能目录 ' + SK.root : '技能是一段可复用的指令，按需载入当前会话')));
  head.appendChild(col);

  const acts = el('div', 'sk-head-actions');
  if (sk) {
    const load = skButton('载入会话', 'sparkles', () => loadSkillIntoChat(sk.name), 'accent');
    load.disabled = !t;
    load.title = t ? '把技能正文注入当前会话（等价于 /skill ' + sk.name + '）' : '先打开一个工作区';
    acts.appendChild(load);
    acts.appendChild(skIconBtn('folderOpen', '在文件管理器中定位', () => revealSkill(sk.name)));
  }
  acts.appendChild(skIconBtn('refresh', '重新读取技能', () => refreshSkills()));
  // 与设置页同一个出口：整页浮层盖住了侧栏，没有这个 X 就只剩 Esc 能离开
  acts.appendChild(skIconBtn('x', '关闭 Skills (Esc)', closeSkillsPage));
  head.appendChild(acts);

  const content = el('div', 'sk-content');
  if (!sk) {
    content.appendChild(skEmpty());
  } else {
    const meta = el('div', 'sk-meta');
    meta.appendChild(el('code', 'sk-path', skJoin(SK.root, sk.file)));
    content.appendChild(meta);

    const body = el('article', 'prose sk-body');
    if (SK.err) body.appendChild(el('div', 'sk-hint bad', SK.err));
    else if (SK.bodyName !== sk.name) body.appendChild(el('div', 'sk-hint', '读取中…'));
    else body.innerHTML = renderMarkdown(SK.body);
    content.appendChild(body);
  }

  main.replaceChildren(head, content);
}
