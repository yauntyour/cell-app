/* =====================================================================
   12 · FlowLink 管理页（整页浮层 #flowlinkPage）

   与 Skills 页同一套整页浮层语言：左侧是四个分节，右侧是内容。

     Scan Links   发现同网段的 cell（系统 / 时区 / 语言 / client_id），
                  选中一台输入配对码即可配对；也可以反过来亮出自己的码。
     已配对        信任的设备；选中后列出对端**已打开的工作区**，挑一个
                  加进本机的「FlowLink 工作区」列表。
     传输列表      对端分享过来的会话 / 已存档会话（JSONL 落盘，索引在
                  .cell/links/transmission.json）。
     设置          服务开关、名称、端口、是否接受远程作业。

   数据来源：flowlink.status（state.flowlink 同源）、flowlink.scan、
   flowlink.transfers、flowlink.ws.remote。所有写操作都回到后端由
   cell::link 落到 .cell/links/links.json，页面本身不持有副本。

   FlowLink 工作区是**远程**工作区：页签、转录、输入框都在本机，回合在
   对端执行。事件经 FlowLink 的 evt 帧回来（method = agent.event），
   这里按 rid 找回对应的页签，把流式正文接上。
   ===================================================================== */
'use strict';

const FL = {
  tab: 'scan',            // scan | links | transfers | settings
  devices: [],            // 最近一次扫描的结果（flowlink.scan）
  remote: [],             // 选中设备上已打开的工作区
  remoteFor: '',          // remote 属于哪个 client_id
  sel: '',                // 已配对页选中的设备
  tsel: '',               // 传输列表选中的条目
  tdetail: null,
  code: '',               // 本机亮出的配对码
  joinCode: '',           // 用户输入的配对码
  joinAddr: '',
  probeAddr: '',          // 「按地址探测」里填的 ip[:port]
  busy: false,
  err: '',
  scannedAt: 0,
};

/* 远程工作区页签：ws key -> 运行时（msgs 在 tab 上，这里只放链路信息） */
const FLT = new Map();

/* ---------- 数据 ---------------------------------------------------- */
function flStatusObj() { return S.flowlink || {}; }
function flSettings() { return flStatusObj().settings || {}; }
function flPeers() {
  const p = flStatusObj().peers;
  return Array.isArray(p) ? p : [];
}
function flEnabled() { return !!flStatusObj().enabled; }
function flWorkspaces() {
  const w = flStatusObj().workspaces;
  return Array.isArray(w) ? w : [];
}
function flTransfers() {
  const t = flStatusObj().transfers;
  return Array.isArray(t) ? t : [];
}
function flClientId() { return flStatusObj().client_id || ''; }
function flName() { return flStatusObj().name || flSettings().name || ''; }
function flPairing() { return flStatusObj().pairing || {}; }

/* 设备列表 = 已配对 + 扫到的；同一台只出现一次，已配对信息优先 */
function flDevices() {
  const out = [];
  const seen = new Set();
  for (const p of flPeers()) {
    const id = p.client_id || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      client_id: id,
      name: p.name || '',
      os: p.os || '', tz: p.tz || '', lang: p.lang || '',
      addr: p.addr || '', port: p.port || 0,
      paired: !!p.trusted || !!p.paired,
      online: !!p.online,
      pairing: !!p.pairing,
      discovered: !!p.discovered,
      last_seen: p.last_seen || 0,
    });
  }
  // 最近一次扫描里发现、但状态还没刷新的设备
  for (const d of (FL.devices || [])) {
    if (!d || !d.client_id || seen.has(d.client_id)) continue;
    seen.add(d.client_id);
    out.push(d);
  }
  return out;
}

function flMerge(out) {
  if (!out || typeof out !== 'object') return;
  const keep = flStatusObj();
  const next = Object.assign({}, keep, out);
  if (out.settings) next.settings = Object.assign({}, keep.settings || {}, out.settings);
  S.flowlink = next;
}

/* ---------- 打开 / 关闭 --------------------------------------------- */
function openFlowLinkPage() {
  const host = $('#flowlinkPage');
  if (!host) return;
  if (host.classList.contains('show')) return;
  if (S.settingsOpen && typeof closeSettings === 'function') closeSettings();
  if (S.skillsOpen && typeof closeSkillsPage === 'function') closeSkillsPage();
  host.classList.add('show');
  S.flowlinkOpen = true;
  flBuild();
  flPaint();
  refreshFlowlink();
}
function closeFlowLinkPage() {
  const host = $('#flowlinkPage');
  if (!host) return;
  host.classList.remove('show');
  S.flowlinkOpen = false;
  host.replaceChildren(); // 下次打开重新建骨架（数据每次重拉）
}
function toggleFlowLinkPage() {
  const host = $('#flowlinkPage');
  if (host && host.classList.contains('show')) closeFlowLinkPage();
  else openFlowLinkPage();
}

/* 状态同步：打开时全量拉一次；事件到达时只并进 S.flowlink 再重画 */
async function refreshFlowlink() {
  try {
    const out = await api('flowlink.status', {});
    if (out && out.ok !== false) {
      flMerge(out);
      if (!FL.sel && flDevices().length) FL.sel = flDevices()[0].client_id;
      flPaint();
      if (typeof renderFlowWsSidebar === 'function') renderFlowWsSidebar();
    }
  } catch (e) { /* 状态由下一次 state 广播补上 */ }
}

/* ---------- 骨架 ---------------------------------------------------- */
const FL_TABS = [
  { id: 'scan', label: 'Scan Links', icon: 'search', sub: '发现与配对' },
  { id: 'links', label: '已配对', icon: 'link', sub: '设备与远程工作区' },
  { id: 'transfers', label: '传输列表', icon: 'download', sub: '收到的会话' },
  { id: 'settings', label: '设置', icon: 'sliders', sub: '服务与端口' },
];

function flBuild() {
  const host = $('#flowlinkPage');
  if (!host || host.querySelector('.fl-shell')) return;
  const shell = el('div', 'fl-shell');

  const side = el('aside', 'fl-side');
  const head = el('div', 'fl-side-head');
  const logo = el('span', 'fl-logo');
  const li = iconEl('link', 'sm');
  if (li) logo.appendChild(li);
  head.appendChild(logo);
  const title = el('div', 'fl-side-title');
  title.appendChild(el('span', 'fl-side-name', 'FlowLink'));
  title.appendChild(el('span', 'fl-side-sub', 'cell · 远程互联'));
  head.appendChild(title);
  side.appendChild(head);

  const nav = el('nav', 'fl-nav');
  for (const t of FL_TABS) {
    const b = el('button', 'fl-nav-item' + (FL.tab === t.id ? ' on' : ''));
    b.type = 'button';
    b.dataset.tab = t.id;
    const ic = iconEl(t.icon, 'sm');
    if (ic) b.appendChild(ic);
    const col = el('span', 'fl-nav-txt');
    col.appendChild(el('span', 'fl-nav-label', t.label));
    col.appendChild(el('span', 'fl-nav-sub', t.sub));
    b.appendChild(col);
    b.onclick = () => { FL.tab = t.id; FL.err = ''; flPaint(); };
    nav.appendChild(b);
  }
  side.appendChild(nav);

  const foot = el('div', 'fl-side-foot');
  const idLine = el('div', 'fl-id');
  idLine.appendChild(el('span', 'fl-id-k', '本机'));
  idLine.appendChild(el('span', 'fl-id-v trunc', flName() || 'cell'));
  foot.appendChild(idLine);
  foot.appendChild(el('div', 'fl-foot-hint', 'Ctrl+Shift+L 打开 · Esc 关闭'));
  side.appendChild(foot);

  shell.appendChild(side);
  shell.appendChild(el('main', 'fl-main'));
  host.replaceChildren(shell);
}

function flHead(main, title, desc, actions) {
  const head = el('header', 'fl-head');
  const col = el('div', 'fl-head-main');
  col.appendChild(el('h1', 'fl-head-title', title));
  if (desc) col.appendChild(el('p', 'fl-head-desc', desc));
  head.appendChild(col);
  const acts = el('div', 'fl-head-actions');
  for (const a of (actions || [])) acts.appendChild(a);
  // 整页浮层盖住了侧栏：没有这个 X 就只剩 Esc 能离开
  acts.appendChild(flIconBtn('x', '关闭 FlowLink (Esc)', closeFlowLinkPage));
  head.appendChild(acts);
  main.appendChild(head);
  return head;
}

function flBtn(label, icon, fn, cls) {
  const b = el('button', 'btn ' + (cls || ''));
  b.type = 'button';
  if (icon) { const i = iconEl(icon, 'sm'); if (i) b.appendChild(i); }
  if (label) b.appendChild(el('span', 'btn-label', label));
  b.onclick = fn;
  return b;
}
function flIconBtn(icon, title, fn, cls) {
  const b = el('button', 'icon-btn ' + (cls || ''));
  b.type = 'button';
  b.title = title || '';
  b.setAttribute('aria-label', title || icon);
  const i = iconEl(icon);
  if (i) b.appendChild(i);
  b.onclick = fn;
  return b;
}
function flPill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }
function flField(label, input, hint) {
  const w = el('label', 'fl-field');
  w.appendChild(el('span', 'fl-field-label', label));
  w.appendChild(input);
  if (hint) w.appendChild(el('span', 'fl-field-hint', hint));
  return w;
}
function flInput(ph, val, type) {
  const i = el('input', 'fl-input');
  i.type = type || 'text';
  if (ph) i.placeholder = ph;
  if (val != null) i.value = val;
  return i;
}
function flFmtBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function flAgo(sec) {
  if (!sec) return '—';
  return relTime(sec);
}

/* ---------- 重画 ---------------------------------------------------- */
function flPaint() {
  const host = $('#flowlinkPage');
  if (!host || !host.classList.contains('show')) return;
  flBuild();
  $$('#flowlinkPage .fl-nav-item').forEach(b => b.classList.toggle('on', b.dataset.tab === FL.tab));
  const main = $('#flowlinkPage .fl-main');
  if (!main) return;
  main.replaceChildren();
  if (FL.tab === 'links') flPaintLinks(main);
  else if (FL.tab === 'transfers') flPaintTransfers(main);
  else if (FL.tab === 'settings') flPaintSettings(main);
  else flPaintScan(main);
}

/* ---------- Scan Links ---------------------------------------------- */
function flDeviceRow(d) {
  const row = el('div', 'fl-dev' + (FL.sel === d.client_id ? ' on' : ''));
  const ico = el('span', 'fl-dev-ico');
  const ic = iconEl(d.paired ? 'link' : 'cpu', 'sm');
  if (ic) ico.appendChild(ic);
  row.appendChild(ico);

  const main = el('div', 'fl-dev-main');
  const line1 = el('div', 'fl-dev-line1');
  line1.appendChild(el('span', 'fl-dev-name trunc', d.name || d.client_id.slice(0, 8)));
  if (d.paired) line1.appendChild(flPill('已配对', 'ok'));
  else if (d.pairing) line1.appendChild(flPill('可配对', 'accent'));
  if (d.online) line1.appendChild(flPill('在线', 'ok'));
  main.appendChild(line1);
  const meta = el('div', 'fl-dev-meta');
  const bits = [d.os || '未知系统', d.tz || '本地时区', d.lang || '—'];
  if (d.addr) bits.push(d.addr + (d.port ? ':' + d.port : ''));
  meta.textContent = bits.join(' · ');
  main.appendChild(meta);
  main.appendChild(el('div', 'fl-dev-id', d.client_id));
  row.appendChild(main);

  row.onclick = () => {
    FL.sel = d.client_id;
    FL.joinAddr = d.addr ? (d.addr + (d.port ? ':' + d.port : '')) : '';
    flPaint();
  };
  return row;
}

function flPaintScan(main) {
  const on = flEnabled();
  flHead(main, 'Scan Links',
    on ? '同一网段里开着 FlowLink 的 cell 会出现在这里。选中一台，输入它显示的配对码即可建立互信。'
       : 'FlowLink 服务当前关闭：打开开关后才能发现设备。',
    [flBtn('重新扫描', 'refresh', () => flScan(), 'ghost')]);

  const body = el('div', 'fl-content');

  if (!on) {
    const off = el('div', 'fl-empty');
    off.appendChild(el('div', 'fl-empty-title', 'FlowLink 服务未开启'));
    off.appendChild(el('p', 'fl-empty-txt', '开启后本机会广播自己、也能发现同网段的其他 cell。设置里可以改设备名与端口。'));
    off.appendChild(flBtn('去设置', 'sliders', () => { FL.tab = 'settings'; flPaint(); }, 'accent'));
    body.appendChild(off);
    main.appendChild(body);
    return;
  }

  // 本机身份 + 亮码
  const self = el('section', 'fl-card');
  const sh = el('div', 'fl-card-head');
  sh.appendChild(el('span', 'fl-card-title', '本机'));
  sh.appendChild(el('span', 'grow'));
  sh.appendChild(flPill(on ? '服务运行中' : '已关闭', on ? 'ok' : 'warn'));
  self.appendChild(sh);
  const idRow = el('div', 'fl-kv');
  idRow.appendChild(el('span', 'fl-k', '名称'));
  idRow.appendChild(el('span', 'fl-v', flName() || 'cell'));
  self.appendChild(idRow);
  const idRow2 = el('div', 'fl-kv');
  idRow2.appendChild(el('span', 'fl-k', 'client_id'));
  idRow2.appendChild(el('code', 'fl-v mono', flClientId() || '—'));
  self.appendChild(idRow2);
  // 本机在每个网段上的地址：对方「按地址探测」时要填的就是这里的一个
  const ifaces = Array.isArray(flStatusObj().interfaces) ? flStatusObj().interfaces : [];
  const addrRow = el('div', 'fl-kv');
  addrRow.appendChild(el('span', 'fl-k', '地址'));
  addrRow.appendChild(el('span', 'fl-v mono',
    ifaces.length ? ifaces.map(i => i.addr + '/' + i.prefix).join(' · ') : '—'));
  if (ifaces.length)
    addrRow.title = ifaces.map(i => (i.name || '?') + '  ' + i.addr + '/' + i.prefix +
      (i.gateway ? '  网关 ' + i.gateway : '')).join('\n');
  self.appendChild(addrRow);

  const p = flPairing();
  if (p.open && p.code) {
    const box = el('div', 'fl-codebox');
    box.appendChild(el('code', 'fl-code', p.code));
    const left = Math.max(0, (p.expires || 0) - Math.floor(Date.now() / 1000));
    box.appendChild(el('div', 'fl-hint',
      '把这段码交给对方输入，' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒后失效。'));
    const row = el('div', 'fl-row');
    row.appendChild(flBtn('取消', 'x', () => cmd('flowlink.pair.cancel').then(o => { flMerge(o); flPaint(); }), 'ghost'));
    box.appendChild(row);
    self.appendChild(box);
  } else {
    const row = el('div', 'fl-row');
    row.appendChild(flBtn('亮出配对码', 'link', () => {
      cmd('flowlink.pair.begin', { ttl: 300 }).then(o => {
        if (o && o.ok !== false) { flMerge(o); toast('配对码已生成', 'ok'); flPaint(); }
      });
    }, 'accent'));
    row.appendChild(el('span', 'fl-hint', '对方输入这段码即可与本机配对（只需一方输入）。'));
    self.appendChild(row);
  }
  body.appendChild(self);

  // 设备列表
  const list = el('section', 'fl-card');
  const lh = el('div', 'fl-card-head');
  lh.appendChild(el('span', 'fl-card-title', '设备'));
  lh.appendChild(el('span', 'grow'));
  const devs = flDevices();
  lh.appendChild(flPill(String(devs.filter(d => d.paired).length) + ' 台已配对'));
  list.appendChild(lh);

  if (!devs.length) {
    list.appendChild(el('div', 'fl-hint', '还没有发现设备。确认对方也开了 FlowLink、在同一个网段，然后点「重新扫描」。'));
    // 发现靠 UDP 广播：一个都没收到，多半是广播根本出不去（不同网段、防火墙、
    // WSL2 的 NAT），而不是对方没开。把广播目标摊开，用户才知道下一步该填哪个地址。
    const rx = flStatusObj().rx || {};
    if (!rx.announce) {
      list.appendChild(el('div', 'fl-hint bad',
        '本机还没有收到任何广播。若对方在 WSL 里、跨了 NAT，或被防火墙挡住，广播到不了 —— 用下面的「按地址探测」直接填对方的地址。'));
    }
    const targets = flStatusObj().targets || [];
    if (targets.length) {
      const line = el('div', 'fl-hint mono', '广播目标：' + targets.join(' · '));
      line.title = 'UDP ' + (flStatusObj().discovery_port || 47821) + ' 上每个 beacon 会发往的地址';
      list.appendChild(line);
    }
  } else {
    const wrap = el('div', 'fl-devs');
    for (const d of devs) wrap.appendChild(flDeviceRow(d));
    list.appendChild(wrap);

    const sel = devs.find(d => d.client_id === FL.sel) || null;
    if (sel) {
      const pair = el('div', 'fl-pairbox');
      pair.appendChild(el('div', 'fl-pair-title', sel.paired ? '已与这台设备互信' : '与 ' + (sel.name || sel.client_id.slice(0, 8)) + ' 配对'));
      if (sel.paired) {
        pair.appendChild(el('div', 'fl-hint', '需要更换凭据时，先在「已配对」里断开，再重新配对。'));
        const row = el('div', 'fl-row');
        row.appendChild(flBtn('查看远程工作区', 'folder', () => { FL.tab = 'links'; flPaint(); flLoadRemote(sel.client_id); }, 'ghost'));
        pair.appendChild(row);
      } else {
        const codeIn = flInput('对方的配对码（空格可忽略）', FL.joinCode);
        codeIn.oninput = () => { FL.joinCode = codeIn.value; };
        const addrIn = flInput('可选：对方的 ip[:port]（留空自动发现）', FL.joinAddr);
        addrIn.oninput = () => { FL.joinAddr = addrIn.value; };
        pair.appendChild(flField('配对码', codeIn));
        pair.appendChild(flField('地址', addrIn));
        const row = el('div', 'fl-row');
        const go = flBtn('配对', 'link', () => flPairJoin(codeIn.value, addrIn.value), 'accent');
        go.disabled = FL.busy;
        row.appendChild(go);
        if (FL.err) row.appendChild(el('span', 'fl-hint bad', FL.err));
        pair.appendChild(row);
      }
      list.appendChild(pair);
    }
  }

  // 手动探测：广播到不了对方时的唯一出口（WSL2 NAT、跨网段、AP 客户端隔离）
  const prow = el('div', 'fl-row');
  const pin = flInput('对方的 ip[:port]，例如 172.28.240.1', FL.probeAddr);
  pin.oninput = () => { FL.probeAddr = pin.value; };
  pin.onkeydown = ev => { if (ev.key === 'Enter') flProbe(pin.value); };
  prow.appendChild(pin);
  const pgo = flBtn('按地址探测', 'search', () => flProbe(pin.value), 'ghost');
  pgo.disabled = FL.busy;
  prow.appendChild(pgo);
  list.appendChild(flField('探测地址', prow,
    '广播出不去时用这个：填对方「本机」里显示的地址（端口默认 ' +
    (flStatusObj().discovery_port || 47821) + '，可写 ip:port）。'));

  body.appendChild(list);
  main.appendChild(body);
}

// 单播探测一台设备：发出后等对方回 announce，再拉一次状态
async function flProbe(addr) {
  const text = String(addr || '').trim();
  if (!text) { toast('先填对方的地址', 'info'); return; }
  FL.busy = true;
  try {
    const out = await cmd('flowlink.probe', { addr: text });
    if (out && out.ok !== false) {
      flMerge(out);
      flPaint();
      toast('已向 ' + text + ' 发出探测', 'ok', 1600);
      // 回包是异步的：给对方一点时间，再刷新一次设备列表
      setTimeout(() => { if (flStatusObj().enabled) refreshFlowlink(); }, 800);
    }
  } finally {
    FL.busy = false;
  }
}

async function flScan() {
  if (!flEnabled()) { toast('先开启 FlowLink 服务', 'info'); return; }
  try {
    const out = await cmd('flowlink.scan', {});
    if (out && out.ok !== false) {
      flMerge(out);
      FL.devices = Array.isArray(out.devices) ? out.devices : [];
      FL.scannedAt = nowSec();
      const devs = flDevices();
      if (!devs.some(d => d.client_id === FL.sel)) FL.sel = devs.length ? devs[0].client_id : '';
      toast('扫描完成 · ' + devs.length + ' 台设备', 'ok', 1600);
      flPaint();
    }
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

async function flPairJoin(code, addr) {
  code = String(code || '').trim();
  if (!code) { toast('请输入配对码', 'bad'); return; }
  FL.busy = true;
  FL.err = '';
  try {
    const out = await api('flowlink.pair.join', { code: code, addr: String(addr || '').trim() });
    if (!out || out.ok === false) {
      FL.err = (out && out.error) || '配对失败';
      toast(FL.err, 'bad');
    } else {
      toast('已与 ' + (out.name || out.client_id || '对端') + ' 配对', 'ok');
      FL.joinCode = '';
      FL.sel = out.client_id || FL.sel;
      await refreshFlowlink();
      if (typeof renderFlowWsSidebar === 'function') renderFlowWsSidebar();
    }
  } catch (e) {
    FL.err = e.message || String(e);
  }
  FL.busy = false;
  flPaint();
}

/* ---------- 已配对 ---------------------------------------------- */
function flPaintLinks(main) {
  flHead(main, '已配对',
    '已互信的设备。选中一台可以看到它上面已打开的工作区，挑一个加进本机的 FlowLink 工作区列表。',
    [flBtn('刷新', 'refresh', () => refreshFlowlink(), 'ghost')]);

  const body = el('div', 'fl-content');
  const links = flDevices().filter(d => d.paired);
  if (!links.length) {
    const empty = el('div', 'fl-empty');
    empty.appendChild(el('div', 'fl-empty-title', '还没有已配对的设备'));
    empty.appendChild(el('p', 'fl-empty-txt', '在 Scan Links 里选中一台设备、输入它的配对码，或者亮出自己的码让对方输入。'));
    empty.appendChild(flBtn('去 Scan Links', 'search', () => { FL.tab = 'scan'; flPaint(); }, 'accent'));
    body.appendChild(empty);
    main.appendChild(body);
    return;
  }
  if (!links.some(d => d.client_id === FL.sel)) FL.sel = links[0].client_id;

  for (const d of links) {
    const card = el('section', 'fl-card fl-link' + (FL.sel === d.client_id ? ' on' : ''));
    const head = el('div', 'fl-card-head');
    head.appendChild(el('span', 'fl-card-title', d.name || d.client_id.slice(0, 8)));
    head.appendChild(el('span', 'grow'));
    head.appendChild(flPill(d.online ? '在线' : '离线', d.online ? 'ok' : ''));
    head.appendChild(flPill(d.os || '未知系统'));
    head.onclick = () => { FL.sel = d.client_id; flPaint(); flLoadRemote(d.client_id); };
    card.appendChild(head);

    const meta = el('div', 'fl-dev-meta');
    meta.textContent = [d.tz || '本地时区', d.lang || '—', d.addr ? d.addr + (d.port ? ':' + d.port : '') : '地址未知']
      .join(' · ');
    card.appendChild(meta);
    card.appendChild(el('div', 'fl-dev-id', d.client_id));

    const acts = el('div', 'fl-row');
    acts.appendChild(flBtn('远程工作区', 'folder', () => { FL.sel = d.client_id; flLoadRemote(d.client_id); }, 'ghost'));
    acts.appendChild(flBtn('断开连接', 'x', () => flDisconnect(d), 'ghost'));
    acts.appendChild(flBtn('移除', 'trash', () => flForget(d), 'ghost'));
    card.appendChild(acts);

    if (FL.sel === d.client_id) card.appendChild(flRemoteBlock(d));
    body.appendChild(card);
  }

  // 本机已加入的 FlowLink 工作区
  const mine = flWorkspaces();
  const card = el('section', 'fl-card');
  const ch = el('div', 'fl-card-head');
  ch.appendChild(el('span', 'fl-card-title', 'FlowLink 工作区'));
  ch.appendChild(el('span', 'grow'));
  ch.appendChild(flPill(String(mine.length) + ' 个'));
  card.appendChild(ch);
  if (!mine.length) {
    card.appendChild(el('div', 'fl-hint', '还没有。选中上面的设备，从它已打开的工作区里挑一个加入。'));
  } else {
    for (const w of mine) {
      const row = el('div', 'fl-wsrow');
      const col = el('div', 'fl-wsrow-main');
      col.appendChild(el('span', 'fl-wsrow-name trunc', w.name || baseName(w.cwd) || w.cwd));
      col.appendChild(el('span', 'fl-wsrow-path trunc', w.cwd));
      row.appendChild(col);
      row.appendChild(flBtn('打开', 'external', () => openFlowWorkspace(w.cell, w.cwd, w.name), 'ghost'));
      row.appendChild(flIconBtn('trash', '从列表移除', () => {
        cmd('flowlink.ws.remove', { cell: w.cell, cwd: w.cwd }).then(o => {
          if (o && o.ok !== false) { flMerge(o); refreshFlowlink(); renderFlowWsSidebar(); flPaint(); }
        });
      }));
      card.appendChild(row);
    }
  }
  body.appendChild(card);
  main.appendChild(body);
}

function flRemoteBlock(d) {
  const box = el('div', 'fl-remote');
  if (FL.remoteFor !== d.client_id) {
    box.appendChild(el('div', 'fl-hint', '正在读取 ' + (d.name || d.client_id.slice(0, 8)) + ' 上已打开的工作区…'));
    flLoadRemote(d.client_id);
    return box;
  }
  const title = el('div', 'fl-pair-title', '该设备上已打开的工作区');
  box.appendChild(title);
  if (!FL.remote.length) {
    box.appendChild(el('div', 'fl-hint', '对端没有打开任何工作区（或它关闭了「接受远程作业」）。'));
    return box;
  }
  for (const w of FL.remote) {
    const row = el('div', 'fl-wsrow');
    const col = el('div', 'fl-wsrow-main');
    col.appendChild(el('span', 'fl-wsrow-name trunc', w.name || baseName(w.cwd) || w.cwd));
    col.appendChild(el('span', 'fl-wsrow-path trunc', w.cwd));
    const tags = el('div', 'fl-wsrow-tags');
    if (w.busy) tags.appendChild(flPill('运行中', 'warn'));
    if (w.session) tags.appendChild(el('span', 'fl-hint', '会话 ' + String(w.session).slice(0, 8)));
    col.appendChild(tags);
    row.appendChild(col);
    const added = flWorkspaces().some(x => x.cell === d.client_id && x.cwd === w.cwd);
    const add = flBtn(added ? '已加入' : '加入列表', added ? 'check' : 'plus', () => {
      if (added) { openFlowWorkspace(d.client_id, w.cwd, w.name); return; }
      cmd('flowlink.ws.add', { cell: d.client_id, cwd: w.cwd, name: w.name || baseName(w.cwd) }).then(o => {
        if (o && o.ok !== false) {
          flMerge(o);
          toast('已加入 FlowLink 工作区', 'ok', 1600);
          refreshFlowlink();
          renderFlowWsSidebar();
          flPaint();
        }
      });
    }, added ? 'ghost' : 'accent');
    row.appendChild(add);
    box.appendChild(row);
  }
  return box;
}

async function flLoadRemote(cell) {
  if (!cell) return;
  FL.remoteFor = cell;
  FL.remote = [];
  flPaint();
  try {
    const out = await api('flowlink.ws.remote', { cell: cell });
    if (FL.remoteFor !== cell) return;
    if (out && out.ok !== false) FL.remote = Array.isArray(out.workspaces) ? out.workspaces : [];
    else FL.err = (out && out.error) || '读取失败';
  } catch (e) {
    FL.err = e.message || String(e);
  }
  if (FL.remoteFor === cell) flPaint();
}

async function flDisconnect(d) {
  if (!confirm('断开与 ' + (d.name || d.client_id.slice(0, 8)) + ' 的连接？\n\n只删除本机保存的互信凭据（.key），已传输的文件保留；重新配对后可继续使用。')) return;
  const out = await cmd('flowlink.disconnect', { client_id: d.client_id });
  if (out && out.ok !== false) {
    flMerge(out);
    toast('已断开连接', 'ok');
    refreshFlowlink();
    flPaint();
  }
}

async function flForget(d) {
  if (!confirm('彻底移除 ' + (d.name || d.client_id.slice(0, 8)) + '？\n\n会删除互信凭据、设备记录，以及它传过来的全部文件。')) return;
  const out = await cmd('flowlink.forget', { client_id: d.client_id });
  if (out && out.ok !== false) {
    flMerge(out);
    toast('已移除', 'ok');
    refreshFlowlink();
    flPaint();
  }
}

/* ---------- 传输列表 ---------------------------------------------- */
function flPaintTransfers(main) {
  flHead(main, '传输列表',
    '对端分享过来的会话与已存档会话。分享时对端把 JSONL 文件写到本机 .cell/links/<client_id>/，这里按时间列出。',
    [flBtn('刷新', 'refresh', () => refreshFlowlink(), 'ghost')]);

  const body = el('div', 'fl-content');
  const items = flTransfers();
  const card = el('section', 'fl-card');
  const ch = el('div', 'fl-card-head');
  ch.appendChild(el('span', 'fl-card-title', '收到的内容'));
  ch.appendChild(el('span', 'grow'));
  ch.appendChild(flPill(String(items.length) + ' 条'));
  card.appendChild(ch);

  if (!items.length) {
    card.appendChild(el('div', 'fl-hint', '还没有收到任何传输。对端在会话里分享时，会出现在这里。'));
  } else {
    for (const t of items) {
      const row = el('div', 'fl-trow' + (FL.tsel === t.id ? ' on' : ''));
      const ico = el('span', 'fl-dev-ico');
      const ic = iconEl(t.kind === 'session' ? 'message' : 'download', 'sm');
      if (ic) ico.appendChild(ic);
      row.appendChild(ico);
      const col = el('div', 'fl-trow-main');
      const l1 = el('div', 'fl-dev-line1');
      l1.appendChild(el('span', 'fl-dev-name trunc', t.subject || t.id));
      if (!t.read) l1.appendChild(flPill('未读', 'accent'));
      l1.appendChild(flPill(t.kind === 'session' ? '会话' : '内容'));
      col.appendChild(l1);
      col.appendChild(el('div', 'fl-dev-meta',
        (t.from_name || String(t.from || '').slice(0, 8)) + ' · ' + flAgo(t.created) + ' · ' + flFmtBytes(t.bytes)));
      if (t.file) col.appendChild(el('div', 'fl-dev-id', t.file));
      row.appendChild(col);
      row.appendChild(flIconBtn('trash', '删除这条传输', () => flDropTransfer(t.id)));
      row.onclick = () => flReadTransfer(t.id);
      card.appendChild(row);
    }
  }
  body.appendChild(card);

  if (FL.tdetail) {
    const d = FL.tdetail;
    const view = el('section', 'fl-card');
    const vh = el('div', 'fl-card-head');
    vh.appendChild(el('span', 'fl-card-title', d.subject || d.id));
    vh.appendChild(el('span', 'grow'));
    vh.appendChild(el('span', 'fl-hint', (d.from_name || '') + ' · ' + flFmtBytes(d.bytes)));
    view.appendChild(vh);
    if (d.note) view.appendChild(el('p', 'fl-note', d.note));
    const msgs = el('div', 'fl-transcript');
    for (const m of (d.messages || [])) {
      const item = el('div', 'fl-msg ' + (m.role === 'user' ? 'user' : 'assistant'));
      item.appendChild(el('div', 'fl-msg-role', m.role === 'user' ? '用户' : '助手'));
      const bodyEl = el('div', 'fl-msg-body prose');
      bodyEl.innerHTML = renderMarkdown(m.text || '');
      item.appendChild(bodyEl);
      msgs.appendChild(item);
    }
    view.appendChild(msgs);
    body.appendChild(view);
  }
  main.appendChild(body);
}

async function flReadTransfer(id) {
  FL.tsel = id;
  try {
    const out = await cmd('flowlink.transfer.read', { id: id });
    if (out && out.ok !== false) {
      FL.tdetail = out;
      // 读过的条目在索引里已标记：同步一次状态
      refreshFlowlink();
    }
  } catch (e) { toast(e.message || String(e), 'bad'); }
  flPaint();
}

async function flDropTransfer(id) {
  if (!confirm('删除这条传输？本机保存的 JSONL 文件也会删除。')) return;
  const out = await cmd('flowlink.transfer.drop', { id: id });
  if (out && out.ok !== false) {
    if (FL.tsel === id) { FL.tsel = ''; FL.tdetail = null; }
    refreshFlowlink();
    toast('已删除', 'ok', 1400);
    flPaint();
  }
}

/* ---------- 设置 ---------------------------------------------------- */
function flPaintSettings(main) {
  const s = flSettings();
  flHead(main, '设置',
    '服务开关与端口。这些设置随 FlowLink 一起存在 .cell/links/links.json，不写进系统主配置。',
    []);

  const body = el('div', 'fl-content');
  const card = el('section', 'fl-card');
  card.appendChild(el('div', 'fl-card-head')).appendChild(el('span', 'fl-card-title', '服务'));

  // 开关
  const swRow = el('div', 'fl-row fl-switchrow');
  const sw = el('button', 'fl-switch' + (flEnabled() ? ' on' : ''));
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', flEnabled() ? 'true' : 'false');
  sw.onclick = () => {
    cmd(flEnabled() ? 'flowlink.disable' : 'flowlink.enable').then(o => {
      if (o && o.ok !== false) {
        flMerge(o);
        toast(flEnabled() ? 'FlowLink 已开启' : 'FlowLink 已关闭', 'ok');
        refreshFlowlink();
        flPaint();
      }
    });
  };
  swRow.appendChild(sw);
  const swTxt = el('div', 'fl-switch-txt');
  swTxt.appendChild(el('div', 'fl-switch-title', '启用 FlowLink 服务'));
  swTxt.appendChild(el('div', 'fl-hint', '关闭时不监听任何端口、不起线程；已配对凭据与传输记录保留在磁盘上。'));
  swRow.appendChild(swTxt);
  card.appendChild(swRow);

  const nameIn = flInput('留空 = 主机名', s.name || '');
  card.appendChild(flField('设备名', nameIn, '对方在设备列表里看到的名字'));

  const portIn = flInput('47822', String(s.port == null ? 47822 : s.port), 'number');
  const discIn = flInput('47821', String(s.discovery == null ? 47821 : s.discovery), 'number');
  const ports = el('div', 'fl-row');
  ports.appendChild(flField('传输端口 (TCP)', portIn));
  ports.appendChild(flField('发现端口 (UDP)', discIn));
  card.appendChild(ports);

  const annRow = el('div', 'fl-row fl-switchrow');
  const annSw = el('button', 'fl-switch' + (s.announce !== false ? ' on' : ''));
  annSw.type = 'button';
  annSw.onclick = () => flPatch({ announce: !(s.announce !== false) });
  annRow.appendChild(annSw);
  const annTxt = el('div', 'fl-switch-txt');
  annTxt.appendChild(el('div', 'fl-switch-title', '广播自身'));
  annTxt.appendChild(el('div', 'fl-hint', '关闭后仍可主动配对，但不会被同网段的设备自动发现。'));
  annRow.appendChild(annTxt);
  card.appendChild(annRow);

  const accRow = el('div', 'fl-row fl-switchrow');
  const accSw = el('button', 'fl-switch' + (s.accept ? ' on' : ''));
  accSw.type = 'button';
  accSw.onclick = () => flPatch({ accept: !s.accept });
  accRow.appendChild(accSw);
  const accTxt = el('div', 'fl-switch-txt');
  accTxt.appendChild(el('div', 'fl-switch-title', '接受远程作业'));
  accTxt.appendChild(el('div', 'fl-hint',
    '允许已配对的对端在这里运行回合、读取工作区文件。FlowLink 工作区的「执行在对端」也依赖这一项。'));
  accRow.appendChild(accTxt);
  card.appendChild(accRow);

  const wsIn = flInput('留空 = 当前工作目录', s.workspace || '');
  card.appendChild(flField('远程作业落地目录', wsIn, '对端发来的作业在本机的默认目录'));

  const row = el('div', 'fl-row');
  row.appendChild(flBtn('保存', 'check', () => {
    flPatch({
      name: nameIn.value.trim(),
      port: Number(portIn.value) || 0,
      discovery: Number(discIn.value) || 0,
      workspace: wsIn.value.trim(),
    });
  }, 'accent'));
  row.appendChild(el('span', 'fl-hint', '改端口会重新挂载服务。'));
  card.appendChild(row);
  body.appendChild(card);

  const idCard = el('section', 'fl-card');
  const ih = el('div', 'fl-card-head');
  ih.appendChild(el('span', 'fl-card-title', '本机标识'));
  idCard.appendChild(ih);
  const kv = el('div', 'fl-kv');
  kv.appendChild(el('span', 'fl-k', 'client_id'));
  kv.appendChild(el('code', 'fl-v mono', flClientId() || '—'));
  idCard.appendChild(kv);
  idCard.appendChild(el('div', 'fl-hint',
    '目录：.cell/links/（identity.json 标识 / links.json 设置与连接 / transmission.json 传输索引 / <client_id>/.key 互信凭据）'));
  body.appendChild(idCard);
  main.appendChild(body);
}

async function flPatch(patch) {
  try {
    const out = await api('flowlink.settings', patch);
    if (!out || out.ok === false) { toast((out && out.error) || '保存失败', 'bad'); return; }
    flMerge(out);
    toast('已保存', 'ok', 1400);
    refreshFlowlink();
    flPaint();
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

/* ---------- 远程工作区（页签 + 回合） -------------------------------- */
function flTabKey(cell, cwd) { return 'link:' + cell + ':' + cwd; }

function flTabByRid(rid) {
  for (const key of S.tabOrder) {
    const t = S.tabs.get(key);
    if (t && t.remote && t.remote.rid === rid) return t;
  }
  return null;
}

async function openFlowWorkspace(cell, cwd, name) {
  if (!cell || !cwd) return;
  try {
    const out = await api('flowlink.ws.open', { cell: cell, cwd: cwd, name: name || '' });
    if (!out || out.ok === false) { toast((out && out.error) || '无法打开远程工作区', 'bad'); return; }
    const key = flTabKey(cell, cwd);
    const t = tab(key);
    t.remote = { cell: cell, cwd: cwd, name: name || baseName(cwd) || cwd, rid: '' };
    t.cwd = cwd;
    t.session = 'link';
    t.loaded = true;
    if (!S.tabOrder.includes(key)) S.tabOrder.push(key);
    if (typeof closeFlowLinkPage === 'function') closeFlowLinkPage();
    await activateWs(key);
    renderTabbar();
    toast('FlowLink 工作区：执行在对端 cell 上', 'info', 2200);
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

/* 输入框里的发送：远程工作区走 flowlink.ws.send，回合在对端跑 */
async function flSendRemote(t) {
  const text = (t.composer.text || '').trim();
  if (!text) return;
  if (t.busy) {
    cmd('flowlink.ws.stop', { cell: t.remote.cell, cwd: t.remote.cwd, rid: t.remote.rid });
    return;
  }
  t.composer.text = '';
  const ta = $('#ta');
  if (ta) ta.value = '';
  t.msgs.push({ id: uid(), role: 'user', text: text, ts: nowSec() });
  const stream = { id: uid(), role: 'assistant', text: '' };
  t.msgs.push(stream);
  t._stream = stream;
  t.busy = true;
  t.thinkingSince = Date.now();
  t.remote.rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  markChat(t.ws);
  markComposer(t.ws);
  schedule('tabbar', renderTabbar);
  const out = await cmd('flowlink.ws.send', {
    cell: t.remote.cell, cwd: t.remote.cwd, text: text, rid: t.remote.rid,
  });
  if (out && out.ok === false) {
    t.busy = false;
    t._stream = null;
    t.msgs.push({ id: uid(), role: 'assistant', text: '⚠ ' + ((out && out.error) || '远程回合启动失败') });
    markChat(t.ws);
    markComposer(t.ws);
    schedule('tabbar', renderTabbar);
  }
}

/* 对端推回来的回合事件（agent.event） */
function flOnPeerEvent(ev) {
  const params = (ev && ev.params) || {};
  if ((ev && ev.method) !== 'agent.event') return;
  const rid = params.rid || '';
  const t = flTabByRid(rid);
  if (!t) return;
  const e = params.ev || {};
  if (e.t === 'answer') {
    if (t._stream) t._stream.text += (e.d || '');
    markChat(t.ws);
    return;
  }
  if (e.t === 'error') {
    t.msgs.push({ id: uid(), role: 'assistant', text: '⚠ ' + (e.d || '远程回合出错') });
    markChat(t.ws);
    return;
  }
  if (e.t === 'turn_end') {
    t.busy = false;
    t._stream = null;
    t.remote.rid = '';
    markChat(t.ws);
    markComposer(t.ws);
    schedule('tabbar', renderTabbar);
  }
}

/* ---------- 侧栏的 FlowLink 工作区列表 ------------------------------- */
function renderFlowWsSidebar() {
  const sec = $('#flowWsSection');
  const list = $('#flowWsList');
  if (!sec || !list) return;
  const items = flWorkspaces();
  sec.hidden = !items.length;           // 无内容时整段不显示
  if (!items.length) { list.replaceChildren(); return; }
  const nodes = [];
  for (const w of items) {
    const key = flTabKey(w.cell, w.cwd);
    const active = key === S.active;
    const row = el('div', 'sitem fl-sitem' + (active ? ' active' : ''));
    const title = el('div', 'stitle trunc', w.name || baseName(w.cwd) || w.cwd);
    title.title = w.cwd;
    row.appendChild(title);
    const meta = el('div', 'smeta');
    const peer = flDevices().find(d => d.client_id === w.cell);
    meta.appendChild(el('span', 'stag fl-tag', 'FlowLink'));
    meta.appendChild(el('span', null, peer ? (peer.name || w.cell.slice(0, 8)) : w.cell.slice(0, 8)));
    row.appendChild(meta);
    const del = el('button', 'idel');
    del.appendChild(iconEl('x', 'sm'));
    del.title = '从 FlowLink 工作区列表移除';
    del.onclick = ev => {
      ev.stopPropagation();
      cmd('flowlink.ws.remove', { cell: w.cell, cwd: w.cwd }).then(o => {
        if (o && o.ok !== false) { flMerge(o); refreshFlowlink(); renderFlowWsSidebar(); }
      });
    };
    row.appendChild(del);
    row.onclick = () => openFlowWorkspace(w.cell, w.cwd, w.name);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
}

/* FlowLink 事件（00-core 分发到这里）：配对完成、设备上线、收到传输、工作区变化 */
function onFlowlinkEvent(ev) {
  if (!ev) return;
  const type = ev.type || '';
  if (type === 'paired') {
    toast('已与 ' + (ev.name || ev.client_id || '对端') + ' 配对', 'ok');
    refreshFlowlink();
  } else if (type === 'pairing_expired') {
    toast('配对码已过期', 'info');
    refreshFlowlink();
  } else if (type === 'transmission' || type === 'mail') {
    toast('收到传输：' + (ev.subject || ''), 'ok', 2600);
    refreshFlowlink();
  } else if (type === 'online' || type === 'offline' || type === 'discovered') {
    refreshFlowlink();
  } else if (type === 'workspaces') {
    refreshFlowlink();
    renderFlowWsSidebar();
  } else if (type === 'peer_event') {
    flOnPeerEvent(ev);
  }
  if (FL.tab && $('#flowlinkPage') && $('#flowlinkPage').classList.contains('show')) flPaint();
}
