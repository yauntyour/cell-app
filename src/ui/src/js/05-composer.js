/* ---------- I. 输入栏 ---------------------------------------------- */
// 发送/停止按钮图标（内联 SVG：随主题取色，不依赖 emoji 字体）：
//   空闲 = 浅色圆 + 深色上箭头；工作中 = 同款圆 + 深色圆角方块（停止）
const SEND_ICON = '<svg class="ico-send" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 3 21 20.5 12 15.8 3 20.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const STOP_ICON = '<svg class="ico-stop" viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect x="4.8" y="4.8" width="14.4" height="14.4" rx="3.4" fill="currentColor"/></svg>';

function focusInput() { const ta = $('#ta'); if (ta) ta.focus(); }
function syncComposerText(txt) {
  const t = S.tabs.get(S.active); if (!t) return;
  t.composer.text = txt;
  const ta = $('#ta'); if (ta) { ta.value = txt; autosize(ta); }
  buildSlash();
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; }

function setComposerMode(mode) {
  const t = S.tabs.get(S.active); if (!t) return;
  t.composer.mode = mode;
  renderComposer();
  buildSlash();
}

function renderComposer() {
  const t = curTab();
  const box = $('#inputBox');
  const composer = $('#composer');
  // 零工作区时输入栏整体停用：启动不再自动打开任何目录，没有工作区就没有
  // 可发送的上下文。与其留一个能打字但发不出去的输入框，不如明确置灰。
  if (composer) composer.classList.toggle('disabled', !t);
  if (!t || !box) {
    if (t) renderChips(t);
    // 置灰时把占位文案换成原因，否则用户只看到一句无法解释的灰框
    const ta0 = $('#ta');
    if (ta0) ta0.placeholder = '先打开一个工作区…';
    renderStatLine();
    return;
  }
  $$('.modebtn').forEach(b => b.classList.toggle('on', b.dataset.mode === t.composer.mode));
  // Teamwork 模式的工作流编辑器更高：给悬浮卡一个 team 态（见 03-molecules.css）
  if (composer) composer.classList.toggle('team', t.composer.mode === 'team');
  // 附件模式才显示文件选择条（文本/Teamwork 模式下拖拽与粘贴仍可唤起附件）
  const attachBar = $('#attachBar');
  if (attachBar) attachBar.hidden = t.composer.mode !== 'attach';
  const ta = $('#ta'), send = $('#sendBtn');
  renderChips(t);
  const teamEditor = $('#teamEditor');
  const textRow = $('.inputrow');
  if (t.composer.mode === 'team') {
    if (textRow) textRow.style.display = 'none';
    if (teamEditor) teamEditor.style.display = '';
    renderWorkflowEditor(t);
  } else {
    if (textRow) textRow.style.display = '';
    if (teamEditor) teamEditor.style.display = 'none';
  }
  if (t.busy) {
    send.classList.add('stop');
    send.title = '停止：中断当前回合与该工作区的全部 Teamwork 任务';
    send.innerHTML = STOP_ICON;
  } else {
    send.classList.remove('stop');
    send.title = '发送 (Enter)';
    send.innerHTML = SEND_ICON;
  }
  const ta2 = $('#ta');
  if (ta2) {
    if (ta2.value !== t.composer.text) { ta2.value = t.composer.text; autosize(ta2); }
    ta2.placeholder = t.composer.mode === 'attach'
      ? '为附件添加说明，或直接发送…'
      : '输入消息，/ 唤起指令…';
  }
  renderStatLine();
}

function syncComposerInput() { renderComposer(); }

function renderChips(t) {
  const wrap = $('#chips');
  if (!wrap) return;
  wrap.replaceChildren();
  const list = t.composer.attachments || [];
  if (!list.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.forEach((a, i) => {
    const c = el('div', 'chip' + (a.uploading ? ' up' : ''));
    c.appendChild(el('span', 'trunc', a.name));
    c.appendChild(el('span', 'csize', a.uploading ? '上传中…' : fmtBytes(a.size)));
    const x = el('span', 'cx', '✕');
    x.onclick = () => { list.splice(i, 1); renderChips(t); };
    c.appendChild(x);
    c.title = a.path || a.name;
    wrap.appendChild(c);
  });
}

async function addFiles(files) {
  const t = S.tabs.get(S.active); if (!t || !files || !files.length) return;
  for (const f of Array.from(files)) {
    const item = { name: f.name, size: f.size, uploading: true, path: '' };
    t.composer.attachments.push(item);
    renderChips(t);
    try {
      const b64 = await fileToB64(f);
      const out = await cmd('upload', { ws: t.ws, name: f.name, data_b64: b64 });
      if (out && out.ok) { item.path = out.path; item.name = out.name; item.size = out.size; }
      else { item.uploading = false; item.path = ''; item.error = true; }
    } catch (e) { item.error = true; toast('上传失败：' + e.message, 'bad'); }
    item.uploading = false;
    renderChips(t);
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

async function sendCurrent() {
  const t = S.tabs.get(S.active); if (!t) return;
  if (t.busy) { stopAllActivity(t); return; }
  if (t.composer.mode === 'team') { await submitWorkflow(t); return; }
  let text = (t.composer.text || '').trim();
  const atts = (t.composer.attachments || []).filter(a => a.path);
  if (!text && !atts.length) return;
  // 斜杠指令在前端执行，绝不作为消息发给模型（见 slashIntent 注释）
  const it = slashIntent(text);
  if (it.kind !== 'message') {
    $('#slashPanel').classList.remove('show');
    if (it.kind === 'exec') { syncComposerText(''); runSlash(t, it); }
    else { syncComposerText(it.name + ' '); buildSlash(); focusInput(); } // complete：先出参数候选
    return;
  }
  if (atts.length) {
    text += (text ? '\n\n' : '') + '[附件]\n' + atts.map(a => '- ' + a.path).join('\n');
  }
  const optimistic = { id: uid(), role: 'user', text: text, ts: nowSec() };
  t.msgs.push(optimistic);
  t.composer.text = '';
  t.composer.attachments = [];
  const ta = $('#ta'); if (ta) { ta.value = ''; autosize(ta); }
  renderChips(t); buildSlash(true);
  markChat(t.ws);
  const out = await cmd('send', { ws: t.ws, text: text });
  if (out && out.ok === false) { markChat(t.ws); }
}

// 「停止」= 终止该工作区的全部活动：进行中的回合 + 所有 run 状态的 Teamwork
// 任务（此前只停回合，后台团队任务会继续跑）。列表现场拉一次为准，t.jobs
// 可能还没刷新到最新状态。
async function stopAllActivity(t) {
  cmd('stop', { ws: t.ws });
  let jobs = t.jobs || [];
  try { const out = await api('teamwork.list', { ws: t.ws }); if (out && out.jobs) jobs = out.jobs; } catch (e) {}
  const running = jobs.filter(j => jobStatusClass(j.status) === 'run');
  if (!running.length) { refreshTeamwork(t.ws, true); return; }
  for (const j of running) await cmd('teamwork.stop', { ws: t.ws, id: j.id });
  toast('已停止 ' + running.length + ' 个团队任务', 'ok');
  setTimeout(() => refreshTeamwork(t.ws), 400);
}

/* ---------- 斜杠面板 ----------------------------------------------- */
// 面板浮在输入卡之上，高度不能顶穿 #centre 的顶边（标签栏/横幅下沿）。
// 把可用高度写进 --slash-max，CSS 用 min(330px, var(--slash-max)) 取用——
// 纯 CSS 表达不了「相对于卡片顶边到容器顶边的距离」，所以由 JS 量一次。
function layoutSlash() {
  const panel = $('#slashPanel');
  const stack = $('.composer-stack');
  const centre = $('#centre');
  if (!panel || !stack || !centre) return;
  const top = stack.getBoundingClientRect().top;
  const avail = Math.floor(top - centre.getBoundingClientRect().top - 10);
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
  const t = S.tabs.get(S.active);
  const c = COMMANDS.find(x => x.name === cmdName);
  if (!c || !c.ctx) return [];
  const out = [];
  const add = (label, insert, desc, run) => out.push({ label, insert, desc, run });
  switch (c.ctx) {
    case 'sessions':
      for (const s of S.sessions.filter(s => s.ws === S.active))
        add((s.title || shortId(s.id)).slice(0, 40), s.id, relTime(s.mtime));
      break;
    case 'models':
      add('↻ 拉取模型列表', '__fetch__', 'models.fetch');
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
      for (const t of Theme.list()) add(t.name, t.name, t.label + (t.desc ? ' · ' + t.desc : ''));
      break;
    case 'teamwork': {
      const t2 = S.tabs.get(S.active);
      for (const j of (t2 ? t2.jobs : [])) add(j.id, j.id, j.status + ' · ' + (j.work_type || ''));
      add('run <id>', 'run ', '运行任务'); add('resume <id>', 'resume ', '恢复任务'); add('stop <id>', 'stop ', '停止任务');
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

let slashSel = 0;
function buildSlash(forceClose) {
  const panel = $('#slashPanel');
  if (!panel) return;
  const t = S.tabs.get(S.active);
  const v = t ? (t.composer.text || '') : '';
  // team 模式下输入行是隐藏的（换成工作流编辑器），斜杠面板无从补全，
  // 留着只会是一块浮在工作流编辑器上、关不掉的死面板
  const teamMode = !!t && t.composer.mode === 'team';
  if (forceClose || teamMode || !v.startsWith('/') || !v || v.includes('\n')) { panel.classList.remove('show'); return; }
  const sp = v.indexOf(' ');
  const token = sp < 0 ? v : v.slice(0, sp);
  const rest = sp < 0 ? '' : v.slice(sp + 1);
  let entries = [];
  if (!rest && !v.includes(' ')) {
    const scored = COMMANDS.map(c => ({ c, sc: fuzzy(token.slice(1), c.name.slice(1)) }))
      .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
    entries = scored.map(x => ({ kind: 'cmd', name: x.c.name, usage: x.c.usage, desc: x.c.desc, cmd: x.c }));
  } else {
    const c = COMMANDS.find(x => x.name === token);
    if (c) entries = slashArgItems(c.name).map(a => ({ kind: 'arg', ...a, cmd: c }));
    if (!entries.length && c) entries.push({ kind: 'hint', desc: c.desc });
  }
  if (!entries.length) { panel.classList.remove('show'); return; }
  if (slashSel >= entries.length) slashSel = 0;
  panel.replaceChildren();
  panel.scrollTop = 0; // 换了候选列表就从顶部看起（否则沿用上一轮的滚动位置）
  layoutSlash();
  entries.forEach((e, i) => {
    const row = el('div', 'scmd' + (i === slashSel ? ' sel' : ''));
    if (e.kind === 'cmd') {
      row.appendChild(el('span', 'sname', e.name));
      row.appendChild(el('span', 'susage', e.usage.replace(e.name, '').trim()));
      row.appendChild(el('span', 'sdesc', e.desc));
    } else if (e.kind === 'arg') {
      row.appendChild(el('span', 'sname', e.label));
      if (e.insert && e.insert !== e.label) row.appendChild(el('span', 'susage mono', e.insert.slice(0, 24)));
      row.appendChild(el('span', 'sdesc', e.desc || ''));
    } else {
      row.appendChild(el('span', 'sdesc', e.desc));
    }
    row.onclick = () => applySlash(entries[slashSel = i]);
    panel.appendChild(row);
  });
  panel.classList.add('show');
  panel._entries = entries;
}

function applySlash(e) {
  const t = S.tabs.get(S.active); if (!t) return;
  const panel = $('#slashPanel');
  const entries = panel._entries || [];
  if (e.kind === 'cmd') {
    if (e.cmd.run) { panel.classList.remove('show'); syncComposerText(''); e.cmd.run(t); return; }
    if (e.cmd.ctx) { syncComposerText(e.name + ' '); buildSlash(); focusInput(); return; }
    panel.classList.remove('show'); syncComposerText(''); e.cmd.run && e.cmd.run(t); return;
  }
  if (e.kind === 'hint') { panel.classList.remove('show'); syncComposerText(''); execSlash(t, e.cmd.name, ''); return; }
  // arg
  if (e.run) { panel.classList.remove('show'); syncComposerText(''); e.run(t); return; }
  if (e.insert === '__fetch__') {
    cmd('models.fetch', {}).then(out => {
      if (out && out.ok && Array.isArray(out.models)) { S.models = out.models; toast('已拉取 ' + out.models.length + ' 个模型', 'ok'); }
      else if (out && out.error) toast(out.error, 'bad');
    });
    panel.classList.remove('show'); syncComposerText(''); return;
  }
  if (e.insert === '__open__') { panel.classList.remove('show'); syncComposerText(''); openWsDialog(); return; }
  const cur = t.composer.text || '';
  const sp = cur.indexOf(' ');
  const head = sp < 0 ? cur : cur.slice(0, sp);
  const tail = sp < 0 ? '' : cur.slice(sp + 1);
  if (e.cmd && (e.cmd.name === '/teamwork') && ['run ', 'resume ', 'stop '].includes(e.insert)) {
    syncComposerText(e.cmd.name + ' ' + e.insert);
    buildSlash(); focusInput(); return;
  }
  const full = head + ' ' + (e.insert || e.label);
  // 单参数指令：直接执行并清空输入框（是否生效由 execSlash 的 toast 提示）；
  // 其余（多段指令的中间补全）保留补全文本，等下一步继续选
  if (['/model', '/provider', '/think', '/sandbox', '/tools', '/autoallow', '/compact', '/theme', '/session', '/workspace'].includes(head) && e.insert && !String(e.insert).endsWith(' ')) {
    panel.classList.remove('show');
    syncComposerText('');
    execSlash(t, head, String(e.insert));
    return;
  }
  panel.classList.remove('show');
  syncComposerText(full + ' ');
  focusInput();
}

/* ---------------------------------------------------------------------
   斜杠指令的执行语义（2026-10-15 晚第三轮）

   以 / 开头的输入分三类（slashIntent）：
     exec     已写完的指令（/cmd 或 /cmd arg）——前端直接执行，绝不作为
              消息发给模型：引擎的指令表只挂在 CLI REPL，GUI 发的
              "/think 4" 只会当普通消息交给模型（模型顺着说"已设置"，
              设置其实没变）。执行的输入框一律清空。
     complete 裸指令名且需要参数（/think）——先补全出参数候选。
     message  其余（未知名字、无参指令后跟了多余文本）——普通消息。

   Enter 在面板开着时走 enterSlash：已写完整的指令按"用户输入"执行，
   不再照高亮候选执行 —— 旧行为下输入 "/think 4" 会把高亮默认项
   off(0) 执行掉（输入 4 执行成 0），且既不关面板也不清输入框。
   ↑↓ 仍移动高亮，Tab / 点击仍然接受候选（补全）。
   --------------------------------------------------------------------- */
// 思考级别：数字 0-4 与面板列出的名称（off/minimal/low/medium/high）都收
function thinkLevelOf(s) {
  s = String(s || '').trim().toLowerCase();
  if (/^[0-4]$/.test(s)) return Number(s);
  // 旧名字（minimal/medium）与 CLI 的别名仍然可用
  const alias = { minimal: 1, medium: 2, med: 2, on: 1, maximum: 4 };
  if (Object.prototype.hasOwnProperty.call(alias, s)) return alias[s];
  const hit = THINK_LEVELS.find(l => l.name === s);
  return hit ? hit.v : null;
}
// on/off 参数（tools/autoallow/compact）：非法返回 null
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
  if (!arg) return c.ctx ? { kind: 'complete', c, name, arg } : { kind: 'exec', c, name, arg };
  return c.ctx ? { kind: 'exec', c, name, arg } : { kind: 'message' };
}
// exec 形态的统一执行入口：带参指令走 execSlash（含参数校验与结果提示），
// 无参指令走指令表里的 run
function runSlash(t, it) {
  if (it.c.ctx) return execSlash(t, it.name, it.arg);
  if (it.c.run) return it.c.run(t);
  return undefined;
}
// 面板开着时的 Enter
function enterSlash() {
  const t = S.tabs.get(S.active); if (!t) return;
  const v = (t.composer.text || '').trim();
  const it = slashIntent(v);
  const panel = $('#slashPanel');
  const entries = (panel && panel._entries) || [];
  if (it.kind === 'exec') { // 已写完的指令：按输入执行
    panel.classList.remove('show');
    syncComposerText('');
    runSlash(t, it);
    return;
  }
  if (it.kind === 'complete' || v.indexOf(' ') < 0) { // 半成品：接受当前候选补全
    if (entries[slashSel]) applySlash(entries[slashSel]);
    return;
  }
  // 非指令形态（如 "/clear 请忽略"）：关面板，交回普通发送
  panel.classList.remove('show');
  sendCurrent();
}

// 设置类指令的统一收尾：成功 → resync + 结果 toast；失败 → 交给 cmd 的错误提示
function afterSet(out, msg) {
  if (!out || out.ok === false) return;
  return resync().then(() => toast(msg, 'ok'));
}

async function execSlash(t, name, arg) {
  arg = (arg || '').trim();
  switch (name) {
    case '/new': return cmd('session.new', { ws: t.ws }).then(resync);
    case '/clear': return cmd('session.clear', { ws: t.ws }).then(resync);
    case '/session': if (arg) return cmd('session.select', { ws: t.ws, id: arg }).then(resync); break;
    case '/model':
      if (!arg) { openSettings('models'); return; }
      return cmd('model.set', { model: arg }).then(() => { S.model = arg; renderFoot(); toast('模型已切换', 'ok'); });
    case '/provider':
      if (arg) return cmd('providers.select', { name: arg }).then(out => afterSet(out, '供应商：' + arg));
      break;
    case '/think': {
      const lv = thinkLevelOf(arg);
      if (lv == null) { toast('无效的思考级别：' + arg + '（0-4 或 ' + THINK_LEVELS.map(l => l.name).join('/') + '）', 'bad'); break; }
      const l = THINK_LEVELS[lv];
      return cmd('settings.set', { patch: { think_level: lv } }).then(out => afterSet(out, '思考级别：' + l.name + ' (' + l.v + ') · ' + l.desc));
    }
    case '/tools': {
      const on = onoffOf(arg);
      if (on == null) { toast('用法：/tools on|off', 'bad'); break; }
      return cmd('settings.set', { patch: { tools: on } }).then(out => afterSet(out, '工具调用：' + (on ? '开' : '关')));
    }
    case '/sandbox': {
      const m = SANDBOX_MODES.find(x => x.v === arg);
      if (!m) { toast('无效的沙箱模式：' + arg + '（' + SANDBOX_MODES.map(x => x.v).join(' / ') + '）', 'bad'); break; }
      return cmd('settings.set', { patch: { sandbox_mode: m.v } }).then(out => afterSet(out, '沙箱模式：' + m.v));
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
      const t = Theme.list().find(x => x.name === arg);
      if (!t) { toast('未知主题：' + arg + '（可用：default' + (Theme.list().length ? '、' + Theme.list().map(x => x.name).join('、') : '') + '）', 'bad'); break; }
      Theme.set(arg); toast('主题：' + t.label, 'ok');
      break;
    }
    case '/workspace':
      if (arg) { if (arg.startsWith('/') || /^[A-Za-z]:/.test(arg)) return openWorkspace(arg); return cmd('workspace.activate', { ws: arg }).then(resync); }
      openWsDialog(); break;
    case '/teamwork': {
      const m = arg.split(/\s+/);
      if (m[0] === 'run' || m[0] === 'resume' || m[0] === 'stop') return cmd('teamwork.' + m[0], { ws: t.ws, id: m[1] || '' }).then(() => refreshTeamwork(t.ws));
      if (arg) return cmd('teamwork.run', { ws: t.ws, id: arg }).then(() => refreshTeamwork(t.ws));
      openDock('teamwork'); break;
    }
    case '/notice': openDock('notices'); refreshNotices(t.ws); break;
    default: break;
  }
}

/* ---------- Teamwork 工作流编辑器 ---------------------------------- */
function renderWorkflowEditor(t) {
  let host = $('#teamEditor');
  if (!host) {
    host = el('div'); host.id = 'teamEditor';
    host.style.padding = '8px 10px';
    $('#inputBox').appendChild(host);
  }
  const wf = t.composer.workflow || (t.composer.workflow = defaultWorkflow());
  host.replaceChildren();

  const top = el('div', 'row gap6');
  top.style.marginBottom = '8px';
  top.appendChild(el('span', 'small mut', '团队工作流'));
  top.appendChild(el('span', 'grow'));
  const b1 = el('button', 'btn sm', '仅创建');
  b1.onclick = () => submitWorkflow(t, 'create');
  const b2 = el('button', 'btn sm primary', '创建并运行');
  b2.onclick = () => submitWorkflow(t, 'run');
  top.appendChild(b1); top.appendChild(b2);
  host.appendChild(top);

  const goalWrap = el('div', 'field');
  goalWrap.style.marginBottom = '10px';
  goalWrap.appendChild(el('label', null, '目标描述（用于「让 LLM 规划」）'));
  const goal = el('textarea'); goal.rows = 2; goal.id = 'twGoal';
  goal.placeholder = '例如：调研本项目的事件总线并给出重构建议，最后写一份报告';
  goal.value = t.composer.goal || '';
  goal.oninput = () => { t.composer.goal = goal.value; };
  goalWrap.appendChild(goal);
  const planBtn = el('button', 'btn sm');
  planBtn.style.marginTop = '6px'; planBtn.style.alignSelf = 'flex-start';
  planBtn.textContent = '让 LLM 规划（发送目标，并提示使用 tw 工具）';
  planBtn.onclick = () => {
    const g = (t.composer.goal || '').trim();
    if (!g) { toast('请先填写目标描述', 'bad'); return; }
    const msg = g + '\n\n请使用 teamwork（tw）工具把上述目标拆解为一个多阶段、可按需并行的团队工作流，' +
      '先创建任务（create），再按需运行（run），完成后汇总各子代理报告。';
    t.composer.text = '';
    const ta = $('#ta'); if (ta) ta.value = '';
    const optimistic = { id: uid(), role: 'user', text: msg, ts: nowSec() };
    t.msgs.push(optimistic); markChat(t.ws);
    cmd('send', { ws: t.ws, text: msg });
    toast('已发送规划请求', 'ok');
  };
  goalWrap.appendChild(planBtn);
  host.appendChild(goalWrap);

  const stagesBox = el('div'); stagesBox.style.display = 'flex'; stagesBox.style.flexDirection = 'column'; stagesBox.style.gap = '10px';
  wf.stages.forEach((st, si) => stagesBox.appendChild(renderStageEditor(t, wf, st, si, stagesBox)));
  host.appendChild(stagesBox);

  const addStage = el('button', 'btn sm');
  addStage.style.marginTop = '8px'; addStage.textContent = '＋ 添加阶段';
  addStage.onclick = () => { wf.stages.push({ name: 'stage ' + (wf.stages.length + 1), mode: 'serial', gate: false, agents: [{ works: '', name: '', model: '', think: 'off' }] }); renderWorkflowEditor(t); };
  host.appendChild(addStage);
}

function renderStageEditor(t, wf, st, si, parent) {
  const card = el('div', 'card');
  const hd = el('div', 'row gap8');
  const idx = el('span', 'pill accent', '阶段 ' + (si + 1));
  hd.appendChild(idx);
  const nm = el('input'); nm.type = 'text'; nm.value = st.name || ''; nm.placeholder = '阶段名称';
  nm.style.flex = '1'; nm.oninput = () => { st.name = nm.value; };
  hd.appendChild(nm);
  const seg = el('div', 'seg');
  const mk = (val, txt) => {
    const b = el('button', st.mode === val ? 'on' : '', txt);
    b.onclick = () => { st.mode = val; renderWorkflowEditor(t); };
    return b;
  };
  seg.appendChild(mk('serial', '串行')); seg.appendChild(mk('parallel', '并行'));
  hd.appendChild(seg);
  const gateLbl = el('label', 'row gap6 small');
  const gate = el('input'); gate.type = 'checkbox'; gate.checked = !!st.gate;
  gate.onchange = () => { st.gate = gate.checked; };
  gateLbl.appendChild(gate); gateLbl.appendChild(el('span', null, '关卡'));
  hd.appendChild(gateLbl);
  const del = el('button', 'btn ghost sm', '✕');
  del.title = '删除阶段';
  del.onclick = () => { wf.stages.splice(si, 1); renderWorkflowEditor(t); };
  hd.appendChild(del);
  card.appendChild(hd);

  const agents = el('div'); agents.style.marginTop = '9px'; agents.style.display = 'flex'; agents.style.flexDirection = 'column'; agents.style.gap = '7px';
  (st.agents || []).forEach((ag, ai) => {
    const row = el('div', 'row gap6');
    row.style.alignItems = 'flex-start';
    const works = el('textarea'); works.rows = 1; works.value = ag.works || ''; works.placeholder = '子代理任务（works）';
    works.style.flex = '2'; works.style.minHeight = '34px';
    works.oninput = () => { ag.works = works.value; works.style.height = 'auto'; works.style.height = Math.min(90, works.scrollHeight) + 'px'; };
    row.appendChild(works);
    const anm = el('input'); anm.type = 'text'; anm.value = ag.name || ''; anm.placeholder = '名称'; anm.style.flex = '1';
    anm.oninput = () => { ag.name = anm.value; };
    row.appendChild(anm);
    const amd = el('input'); amd.type = 'text'; amd.value = ag.model || ''; amd.placeholder = '模型（可空）'; amd.style.flex = '1';
    amd.oninput = () => { ag.model = amd.value; };
    row.appendChild(amd);
    const thk = el('select'); thk.style.width = '104px';
    for (const l of THINK_LEVELS) { const o = el('option', null, l.name); o.value = l.name; if ((ag.think || 'off') === l.name) o.selected = true; thk.appendChild(o); }
    thk.onchange = () => { ag.think = thk.value; };
    row.appendChild(thk);
    const ax = el('button', 'btn ghost sm', '✕');
    ax.onclick = () => { st.agents.splice(ai, 1); renderWorkflowEditor(t); };
    row.appendChild(ax);
    agents.appendChild(row);
  });
  card.appendChild(agents);
  const addAg = el('button', 'btn ghost sm', '＋ 子代理');
  addAg.style.marginTop = '7px';
  addAg.onclick = () => { (st.agents = st.agents || []).push({ works: '', name: '', model: '', think: 'off' }); renderWorkflowEditor(t); };
  card.appendChild(addAg);
  return card;
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
    const s = { agents };
    if (st.name) s.name = st.name;
    s.mode = st.mode || 'serial';
    if (st.gate) s.gate = true;
    stages.push(s);
  }
  if (!stages.length) { toast('至少需要一个带任务的阶段', 'bad'); return; }
  const out = await cmd('teamwork.create', { ws: t.ws, workflow: { stages }, work_type: wf.work_type || 'serial' });
  if (!out || out.ok === false) return;
  toast('已创建任务 ' + out.job, 'ok');
  if (mode === 'run') {
    const r = await cmd('teamwork.run', { ws: t.ws, id: out.job });
    if (r && r.ok !== false) toast('任务已运行', 'ok');
  }
  openDock('teamwork');
  setTimeout(() => refreshTeamwork(t.ws), 500);
}
