/* =====================================================================
   12 · FlowLink 管理页（整页浮层 #flowlinkPage）

   与 Skills 页同一套整页浮层语言：左侧是四个分节，右侧是内容。

     Scan Links   发现同网段的 cell（系统 / 时区 / 语言 / client_id），
                  选中一台输入配对码即可配对；也可以反过来亮出自己的码。
                  本机卡片摊开实际发现 / 接收端口，设备为空时展开「发现诊断」
                  看每轮 beacon 的目标和 rx 计数。
     已配对        信任的设备；选中后列出对端**有的工作区**（本机侧栏里能
                  看到的那一批，open=false 的是没在挂载的），挑一个加进
                  本机的「FlowLink 工作区」列表。
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
/* status 默认值。新后端的发现字段（discovery_bound / rx_port /
   discovery_state / targets / hints / rx）在旧后端或事件增量里可能缺失，
   读之前统一补一层，页面里就不用到处写 `|| []` / `|| 0`。 */
const FL_STATUS_DEFAULTS = {
  enabled: false, client_id: '', name: '',
  port: 0, port_preferred: 47822,
  discovery_port: 47821, discovery_bound: 0,
  rx_port: 0, discovery_state: '',
  announce: true, accept_remote: false,
  interfaces: [], targets: [], rx: {}, hints: [],
  settings: {}, pairing: {}, peers: [], workspaces: [],
  transfers: [], transmissions: {},
};
function flStatusObj() {
  const raw = S.flowlink;
  const st = Object.assign({}, FL_STATUS_DEFAULTS, (raw && typeof raw === 'object') ? raw : {});
  for (const k in FL_STATUS_DEFAULTS) if (st[k] == null) st[k] = FL_STATUS_DEFAULTS[k];
  return st;
}
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
function flPortText(n) {
  const v = Number(n || 0);
  return v > 0 ? String(v) : '—';
}
function flExtraTargets() {
  const t = flSettings().extra_targets;
  return Array.isArray(t) ? t.map(String).filter(Boolean) : [];
}


/* 发现状态：优先用后端字段；旧后端没有这个字段（默认空串）时按
   enabled + discovery_bound 推断，避免把「旧后端 + 已开启」误判成已关闭。 */
function flDiscoveryState() {
  const st = flStatusObj();
  const md = st.mdns || {};
  const s = md.state || st.discovery_state;
  if (s === 'active' || s === 'degraded' || s === 'off') return s;
  if (!st.enabled) return 'off';
  return 'active';
}
function flDiscoveryOn() { return !!(flStatusObj().mdns || {}).on; }
const FL_DISC_LABEL = { active: '发现中', degraded: '降级', off: '已停止' };

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
  // 打开就顺手扫一轮：设备列表本来就是「进来看一眼」的东西，要用户再点
  // 「重新扫描」才动会显得发现很迟钝。扫描是幂等的，应答异步补进列表。
  if (FL.tab === 'scan' && flEnabled() && !FL.scanning) flScan();
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
  { id: 'perm', label: '权限', icon: 'shield', sub: '工作区 / Workflow / 监视' },
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
function flTextarea(ph, val, rows) {
  const t = el('textarea', 'fl-input fl-textarea');
  t.rows = rows || 4;
  if (ph) t.placeholder = ph;
  t.value = val == null ? '' : val;
  return t;
}
function flKv(k, v, cls) {
  const row = el('div', 'fl-kv');
  row.appendChild(el('span', 'fl-k', k));
  row.appendChild(el('span', 'fl-v' + (cls ? ' ' + cls : ''), v));
  return row;
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
  else if (FL.tab === 'perm') flPaintPerm(main);
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

/* 发现诊断（可折叠）：把「beacon 到底发去哪了、有没有回音」摊开。
   设备列表为空时才显示 —— 有设备时这些只是噪音。targets 按 kind 分组，
   中文标签与后端约定一致；rx 计数用来看广播是不是根本进不来。 */
function flDiagBlock() {
  const st = flStatusObj();
  const md = st.mdns || {};
  const state = flDiscoveryState();
  const det = el('details', 'fl-diag');
  const sum = el('summary', 'fl-diag-sum');
  sum.appendChild(el('span', 'fl-diag-title', '发现诊断'));
  sum.appendChild(flPill(FL_DISC_LABEL[state] || state, state === 'active' ? 'ok' : 'warn'));
  det.appendChild(sum);

  const body = el('div', 'fl-diag-body');
  const inst = md.instance || '—';
  const host = md.host || '—';
  body.appendChild(el('div', 'fl-diag-line mono',
    'mDNS ' + (Number(md.port || 0) || 5353) + ' · 实例 ' + inst + ' · 主机 ' + host));
  body.appendChild(el('div', 'fl-hint',
    '发现走标准 DNS-SD（_cell._tcp.local）。服务类型可以被系统工具直接浏览：'
    + 'dns-sd -B _cell._tcp 与这里看到的是同一批设备。'));

  // 本机地址：A / AAAA 记录就来自这里
  const addrs = Array.isArray(md.addresses) ? md.addresses : [];
  if (addrs.length) {
    const grid = el('div', 'fl-diag-groups');
    const g = el('div', 'fl-diag-group');
    const gh = el('div', 'fl-diag-gh');
    gh.appendChild(el('span', 'fl-diag-tag', '本机地址'));
    gh.appendChild(el('span', 'fl-diag-count', String(addrs.length)));
    g.appendChild(gh);
    const lines = el('div', 'fl-diag-list mono');
    for (const a of addrs) {
      const item = el('div', 'fl-diag-item', a.addr + (a.family ? '  (' + a.family + ')' : ''));
      item.title = a.loopback ? '回环地址，不会写进 A/AAAA 记录' : (a.scope ? 'scope ' + a.scope : '');
      lines.appendChild(item);
    }
    g.appendChild(lines);
    grid.appendChild(g);
    body.appendChild(grid);
  } else {
    body.appendChild(el('div', 'fl-hint', '还没有枚举到本机地址：服务未开启。'));
  }

  const stats = el('div', 'fl-diag-stats');
  const stat = (k, v, cls) => {
    const s = el('span', 'fl-diag-stat' + (cls ? ' ' + cls : ''));
    s.appendChild(el('span', 'fl-diag-stat-k', k));
    s.appendChild(el('span', 'fl-diag-stat-v mono', String(v == null || v === '' ? '—' : v)));
    return s;
  };
  stats.appendChild(stat('收到查询', md.rx_query));
  stats.appendChild(stat('收到应答', md.rx_response));
  stats.appendChild(stat('已发查询', md.tx_query));
  stats.appendChild(stat('已发应答', md.tx_response));
  stats.appendChild(stat('缓存设备', md.peers));
  stats.appendChild(stat('最后来源', md.last_from));
  body.appendChild(stats);
  if (md.error) body.appendChild(el('div', 'fl-hint bad', 'mDNS 绑定降级：' + md.error));

  det.appendChild(body);
  return det;
}

function flPaintScan(main) {
  const on = flEnabled();
  const discovering = on && flDiscoveryOn();
  flHead(main, 'Scan Links',
    on ? '同一网段里开着 FlowLink 的 cell 会出现在这里。选中一台，输入它显示的配对码即可建立互信。'
       : 'FlowLink 服务当前关闭：打开开关后才能发现设备。',
    [flBtn(FL.scanning ? '扫描中…' : '重新扫描', 'refresh', () => flScan(), 'ghost'),
     flBtn(discovering ? '停止发现' : '开始发现', discovering ? 'x' : 'link',
           () => flToggleDiscovery(!discovering), discovering ? 'ghost' : 'accent')]);

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

  // 发现端口 = rendezvous（well-known）端口，best effort；接收端口 = 每次
  // 随机分配的 beacon 端口。两者分开之后，用户最常问的两件事——「WSL 里
  // 为什么没地址」和「两台机器为什么抢端口」——都能在这里直接回答。
  const selfSt = flStatusObj();
  const discBound = Number(selfSt.discovery_bound || 0);
  const discCfg = Number(selfSt.discovery_port || 0) || 47821;
  const discState = flDiscoveryState();
  let discTxt, discPill, discPillCls;
  if (discState === 'off') {
    discTxt = '已停止（不再广播/监听）';
    discPill = '已停止'; discPillCls = 'warn';
  } else if (discBound) {
    discTxt = discBound + '（收发中）';
    discPill = '发现中'; discPillCls = 'ok';
  } else {
    discTxt = discCfg + ' 被占用 · 降级';
    discPill = '降级'; discPillCls = 'warn';
  }
  const discRow = flKv('发现 (mDNS)', discTxt, 'mono');
  discRow.appendChild(flPill(discPill, discPillCls));
  discRow.title = 'DNS-SD 端口（默认 5353）：本机在这里收发 _cell._tcp.local 的查询与应答。'
    + '被别的 mDNS 程序独占时会退化成随机端口（仍能收单播应答），「停止发现」则完全关掉。';
  self.appendChild(discRow);

  const mdObj = selfSt.mdns || {};
  const instRow = flKv('服务实例', mdObj.instance || '—', 'mono');
  instRow.title = 'DNS-SD 实例名：' + (mdObj.instance || '') + '.' + (mdObj.service || '_cell._tcp.local')
    + '；主机记录 ' + (mdObj.host || '—') + ' 同时带 A 与 AAAA。';
  self.appendChild(instRow);

  const p = flPairing();
  const reqs = Array.isArray(p.requests) ? p.requests : [];
  const outs = Array.isArray(p.outgoing) ? p.outgoing : [];
  if (p.open && p.code) {
    const box = el('div', 'fl-codebox');
    box.appendChild(el('code', 'fl-code', p.code));
    const left = Math.max(0, (p.expires || 0) - Math.floor(Date.now() / 1000));
    box.appendChild(el('div', 'fl-hint',
      '第一步：把这段码交给对方，让对方在它的 FlowLink 页里输入。'
      + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒后失效。'));
    box.appendChild(el('div', 'fl-hint',
      '第二步：对方输入后会在这里出现一条请求，你再输入对方的配对码 —— 双方都输入过，才算配对完成。'));
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
    row.appendChild(el('span', 'fl-hint', '配对要双方各输入一次对方的码；先亮出自己的，再让对方请求。'));
    self.appendChild(row);
  }
  // 进来的请求：对方已经输入了本机的码（握手证明了这一点），本机输入对方的码即完成
  if (reqs.length) {
    const box = el('div', 'fl-pairbox');
    box.appendChild(el('div', 'fl-pair-title', '配对请求 · 等待你输入对方的码'));
    for (const q of reqs) {
      const row = el('div', 'fl-wsrow');
      const col = el('div', 'fl-wsrow-main');
      col.appendChild(el('span', 'fl-wsrow-name trunc', q.name || String(q.client_id || '').slice(0, 8)));
      col.appendChild(el('span', 'fl-wsrow-path trunc', '已输入本机的配对码 · ' + flAgo(q.since)));
      row.appendChild(col);
      const inCode = flInput('对方的配对码');
      inCode.style.maxWidth = '220px';
      row.appendChild(inCode);
      const go = flBtn('批准', 'check', () => flApprove(q.client_id, inCode.value), 'accent');
      row.appendChild(go);
      inCode.onkeydown = ev => { if (ev.key === 'Enter') flApprove(q.client_id, inCode.value); };
      box.appendChild(row);
    }
    self.appendChild(box);
  }
  // 发出去的请求：本机已输入对方的码，等对方输入本机的码
  if (outs.length) {
    const box = el('div', 'fl-pairbox');
    box.appendChild(el('div', 'fl-pair-title', '已发出的请求 · 等待对方批准'));
    for (const q of outs) {
      const row = el('div', 'fl-row');
      row.appendChild(flPill('等待中', 'warn'));
      row.appendChild(el('span', 'fl-hint',
        (q.name || String(q.client_id || '').slice(0, 8)) + ' 需要输入本机的配对码（见上方）'));
      box.appendChild(row);
    }
    self.appendChild(box);
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
    // hints[] 是后端按当前状态给出的中文句子（端口被占、还没收到包、WSL
    // 镜像网络、防火墙……）。有就照抄，没有就退回原来的通用文案。
    const st = flStatusObj();
    const hints = Array.isArray(st.hints) ? st.hints.filter(h => h) : [];
    const state = flDiscoveryState();
    if (hints.length) {
      for (const h of hints)
        list.appendChild(el('div', 'fl-hint' + (state === 'active' ? '' : ' bad'), h));
    } else {
      list.appendChild(el('div', 'fl-hint', '还没有发现设备。确认对方也开了 FlowLink、在同一个网段，然后点「重新扫描」。'));
      const rx = st.rx || {};
      if (!Number(rx.announce || 0) && state !== 'off') {
        list.appendChild(el('div', 'fl-hint bad',
          '本机还没有收到任何广播。若对方在 WSL 里、跨了 NAT，或被防火墙挡住，广播到不了 —— 用下面的「按地址探测」直接填对方的地址。'));
      }
    }
    list.appendChild(flDiagBlock());
  } else {
    const wrap = el('div', 'fl-devs');
    for (const d of devs) wrap.appendChild(flDeviceRow(d));
    list.appendChild(wrap);

    const sel = devs.find(d => d.client_id === FL.sel) || null;
    if (sel) {
      const pair = el('div', 'fl-pairbox');
      pair.appendChild(el('div', 'fl-pair-title', sel.paired ? '已与这台设备互信' : '与 ' + (sel.name || sel.client_id.slice(0, 8)) + ' 配对 · 第一步'));
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
        pair.appendChild(flField('对方的配对码', codeIn,
          '提交后对方会看到一条请求；对方再输入本机的配对码（上方「本机」里那段）即完成。'));
        pair.appendChild(flField('地址', addrIn));
        const row = el('div', 'fl-row');
        const go = flBtn('请求配对', 'link', () => flPairJoin(codeIn.value, addrIn.value), 'accent');
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
    '广播 / 组播到不了时用这个：填对方「本机」里显示的地址。WSL2 的 NAT 与镜像网络、'
    + '跨网段、或防火墙挡住 UDP 时，单播探测是唯一能直接摸到对方的路。端口默认 '
    + (Number(flStatusObj().discovery_port || 0) || 47821) + '，也可以写 ip:port。'));

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
  if (FL.scanning) return;
  FL.scanning = true;
  flPaint();
  try {
    const out = await cmd('flowlink.scan', {});
    if (out && out.ok !== false) {
      flMerge(out);
      FL.devices = Array.isArray(out.devices) ? out.devices : [];
      FL.scannedAt = nowSec();
      flPickSel();
      flPaint();
    }
    // 应答是异步到的：广播（mDNS）之外还有单播扫描，慢网段 / 跨虚拟网卡
    // （WSL ↔ Windows）要一两秒才回。再补看两轮，别让「扫完 0 台」停留在
    // 屏幕上 —— 之前就是这么显得「扫描很迟钝」。
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 800));
      const st = await api('flowlink.status', {});
      if (!st || st.ok === false) break;
      flMerge(st);
      flPickSel();
      flPaint();
    }
    toast('扫描完成 · ' + flDevices().length + ' 台设备', 'ok', 1600);
  } catch (e) { toast(e.message || String(e), 'bad'); }
  FL.scanning = false;
  flPaint();
}
// 选中项跟着扫描结果走：原来选的那台不在了就落到第一台
function flPickSel() {
  const devs = flDevices();
  if (!devs.some(d => d.client_id === FL.sel)) FL.sel = devs.length ? devs[0].client_id : '';
}

async function flToggleDiscovery(on) {
  try {
    const out = await cmd('flowlink.discovery', { on: !!on });
    if (out && out.ok !== false) {
      flMerge(out);
      toast(on ? '已开始广播与监听' : '已停止发现（配对与重连不受影响）', 'ok', 2000);
      flPaint();
    } else {
      toast((out && out.error) || '切换失败', 'bad');
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
    } else if (out.pending) {
      // 双向配对：本机只完成了「输入对方的码」，link 还不存在
      const p = out.pending || {};
      toast('请求已发送给 ' + (p.name || p.client_id || '对端') + '，等对方输入本机的配对码', 'info', 3200);
      FL.joinCode = '';
      flMerge(out);
      FL.sel = p.client_id || FL.sel;
      await refreshFlowlink();
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

/* 完成双向配对的另一半：本机输入发起方（它已输入本机的码）的配对码 */
async function flApprove(cell, code) {
  const text = String(code || '').trim();
  if (!text) { toast('请输入对方的配对码', 'bad'); return; }
  try {
    const out = await api('flowlink.pair.approve', { client_id: cell, code: text });
    if (!out || out.ok === false) { toast((out && out.error) || '批准失败', 'bad'); return; }
    const r = out.paired || {};
    toast('已与 ' + (r.name || cell.slice(0, 8)) + ' 完成双向配对', 'ok', 2600);
    flMerge(out);
    await refreshFlowlink();
    if (typeof renderFlowWsSidebar === 'function') renderFlowWsSidebar();
  } catch (e) { toast(e.message || String(e), 'bad'); }
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
  // 没有本机授权时连列表都不拉：对端会不会给是另一回事，本机先不该去问
  if (!flSettings().access_workspace) {
    box.appendChild(el('div', 'fl-hint bad', '「使用对端工作区」未开启：拿不到对端的工作区列表。'));
    const row = el('div', 'fl-row');
    row.appendChild(flBtn('去权限设置', 'shield', () => { FL.tab = 'perm'; flPaint(); }, 'ghost'));
    box.appendChild(row);
    return box;
  }
  if (FL.remoteFor !== d.client_id) {
    box.appendChild(el('div', 'fl-hint', '正在读取 ' + (d.name || d.client_id.slice(0, 8)) + ' 上的工作区…'));
    flLoadRemote(d.client_id);
    return box;
  }
  const title = el('div', 'fl-pair-title', '该设备上的工作区');
  box.appendChild(title);
  // 读失败和「对端一个工作区都没有」是两件事：错误原样显示，别让人按空列表排查
  if (FL.err) {
    box.appendChild(el('div', 'fl-hint', FL.err));
    return box;
  }
  if (!FL.remote.length) {
    box.appendChild(el('div', 'fl-hint', '对端没有打开任何工作区。'));
    return box;
  }
  for (const w of FL.remote) {
    const row = el('div', 'fl-wsrow');
    const col = el('div', 'fl-wsrow-main');
    col.appendChild(el('span', 'fl-wsrow-name trunc', w.name || baseName(w.cwd) || w.cwd));
    col.appendChild(el('span', 'fl-wsrow-path trunc', w.cwd));
    const tags = el('div', 'fl-wsrow-tags');
    if (w.busy) tags.appendChild(flPill('运行中', 'warn'));
    if (w.open === false) tags.appendChild(flPill('未打开', ''));
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
  FL.err = '';
  if (!flSettings().access_workspace) { FL.err = '「使用对端工作区」未开启（FlowLink → 权限）'; flPaint(); return; }
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

/* 实际绑定端口（只读）：来自 status，和下面的偏好输入框不是一回事。
   TCP 抢不到首选会退到随机端口，UDP rendezvous 抢不到只会退化为仅探测。 */
function flActualPorts() {
  const st = flStatusObj();
  const on = !!st.enabled;
  const wrap = el('div', 'fl-actual');
  const head = el('div', 'fl-actual-head');
  head.appendChild(el('span', 'fl-actual-title', '实际端口'));
  head.appendChild(flPill(on ? '服务运行中' : '服务未开启', on ? 'ok' : 'warn'));
  wrap.appendChild(head);

  const rows = el('div', 'fl-actual-rows');
  const row = (k, v) => {
    const r = el('div', 'fl-portrow');
    r.appendChild(el('span', 'fl-portk', k));
    r.appendChild(el('span', 'fl-portv mono', v));
    return r;
  };
  const tcp = Number(st.port || 0);
  const pref = Number(st.port_preferred || 0);
  let tcpTxt = flPortText(tcp);
  if (tcp && pref && pref !== tcp) tcpTxt += '（首选 ' + pref + ' 被占用，已自动改用随机端口）';
  rows.appendChild(row('当前传输端口', tcpTxt));
  const db = Number(st.discovery_bound || 0);
  const dp = Number(st.discovery_port || 0);
  const discState = flDiscoveryState();
  rows.appendChild(row('当前发现端口',
    discState === 'off' ? '已关闭（主动发现关闭）'
      : db ? db + '（监听中）'
      : dp ? dp + ' 被占用 · 仅主动探测' : '—'));
  const rx = Number(st.rx_port || 0);
  rows.appendChild(row('接收端口', rx ? rx + '（随机 UDP）' : '—'));
  wrap.appendChild(rows);
  wrap.appendChild(el('div', 'fl-hint',
    '实际端口只读。下面的输入框是「首选端口」：保存后会重新挂载服务；被占用时传输端口自动改用随机端口、'
    + '发现端口退化为仅主动探测，都不会让服务启动失败。'));
  return wrap;
}

/* 额外发现地址：每行一个 ip[:port]。广播 / 组播在 WSL 镜像网络、跨网段或
   防火墙下可能到不了对端，这些单播目标就是绕过它们的固定路径。 */
function flParseExtraTargets(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = line.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
async function flSaveExtra(text) {
  const list = flParseExtraTargets(text);
  if (list.length > 16) { toast('最多 16 个额外发现地址', 'bad'); return; }
  await flPatch({ extra_targets: list });
}

/* ---------- 权限 ---------------------------------------------------- */
/* 两个方向是两套开关，缺一不可：
     对端使用本机（accept_*）：本机愿意开放什么
     本机使用对端（access_*）：本机愿意去用对端什么
   关掉任何一侧，对应功能就直接不可用 —— 不是灰掉按钮，而是命令层拒绝
   （见 cell-app-core 的 fl_serve / fl_can）。 */
function flSwitchRow(on, title, hint, fn) {
  const row = el('div', 'fl-row fl-switchrow');
  const sw = el('button', 'fl-switch' + (on ? ' on' : ''));
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  sw.onclick = () => fn(!on);
  row.appendChild(sw);
  const txt = el('div', 'fl-switch-txt');
  txt.appendChild(el('div', 'fl-switch-title', title));
  if (hint) txt.appendChild(el('div', 'fl-hint', hint));
  row.appendChild(txt);
  return row;
}

function flPermCard(title, desc, rows) {
  const card = el('section', 'fl-card');
  const head = el('div', 'fl-card-head');
  head.appendChild(el('span', 'fl-card-title', title));
  card.appendChild(head);
  if (desc) card.appendChild(el('p', 'fl-note', desc));
  for (const r of rows) card.appendChild(r);
  return card;
}

function flPaintPerm(main) {
  const s = flSettings();
  flHead(main, '权限',
    '工作区、Workflow、监视是三项独立的授权。开关立刻生效，不需要重启服务；被拒绝的一侧连工作区列表都拿不到。',
    []);

  const body = el('div', 'fl-content');

  body.appendChild(flPermCard('对端使用本机', '已配对的对端能在这台机器上做什么。全部默认关闭。', [
    flSwitchRow(!!s.accept_workspace, '允许对端访问本机工作区',
      '对端可以列出本机的工作区与会话、读取工作区文件、在选中工作区里跑回合，'
      + '并为本机上的这些回合选供应商 / 模型 / 思考强度 / 沙箱 / 工具开关（它们属于这台机器，改了本机也生效）。'
      + '关闭时连工作区列表都不返回。',
      v => flPatch({ accept_workspace: v })),
    flSwitchRow(!!s.accept_workflow, '允许对端在本机运行 Workflow',
      '对端提交的 Teamwork 作业在本机执行（用本机的供应商与密钥），只把报告带回去。',
      v => flPatch({ accept_workflow: v })),
    flSwitchRow(!!s.accept_watch, '允许对端监视本机会话',
      '对端只能看到选中工作区里活跃会话的输出流，不能输入，也不能修改任何会话设置。',
      v => flPatch({ accept_watch: v })),
  ]));

  body.appendChild(flPermCard('本机使用对端', '这台机器可以去用对端什么。全部默认关闭。', [
    flSwitchRow(!!s.access_workspace, '允许使用对端工作区',
      '侧栏的 FlowLink 工作区、对端会话列表与历史、远程回合都依赖这一项。关闭时侧栏不显示对端工作区，也不拉取列表。',
      v => { flPatch({ access_workspace: v }); if (typeof renderFlowWsSidebar === 'function') renderFlowWsSidebar(); }),
    flSwitchRow(!!s.access_workflow, '允许使用对端 Workflow',
      'tw 工具把作业发到已配对的对端上执行；关闭时 tw 只在本机跑。',
      v => flPatch({ access_workflow: v })),
  ]));

  const note = el('section', 'fl-card');
  note.appendChild(el('div', 'fl-card-head')).appendChild(el('span', 'fl-card-title', '说明'));
  note.appendChild(el('p', 'fl-note',
    '配对只负责建立互信（双方各输入一次对方的配对码）；能做什么由这里的开关决定。'
    + '监视是单向只读：它既不能发消息，也不能改模型、工具或沙箱。'
    + '远程工作区页签里的模型 / 供应商 / 思考强度 / 沙箱 / 工具是**对端的**值：'
    + '改动经 flowlink.ws.config.set 写到执行回合的那台机器上，本机只显示它的实际状态。'));
  body.appendChild(note);

  main.appendChild(body);
}

/* ---------- 设置 ---------------------------------------------------- */
function flPaintSettings(main) {
  const s = flSettings();
  const st = flStatusObj();
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

  // 实际绑定值放在偏好输入框上方：先看「现在是什么」，再改「想要什么」
  card.appendChild(flActualPorts());

  const portIn = flInput('47822', String(s.port == null ? 47822 : s.port), 'number');
  const discIn = flInput('47821', String(s.discovery == null ? 47821 : s.discovery), 'number');
  const ports = el('div', 'fl-row');
  ports.appendChild(flField('传输端口 (TCP)', portIn));
  ports.appendChild(flField('发现端口 (UDP)', discIn));
  card.appendChild(ports);
  card.appendChild(el('div', 'fl-hint',
    '传输端口留空或填 0 = 每次随机；发现端口一般保持 47821，填 0 会得到一个别人不知道的随机端口。'
    + '端口被占用不会启动失败：传输端口自动改用随机端口（见上面的「当前传输端口」），'
    + '发现端口退化为仅主动探测，对端仍可用「按地址探测」连上。'));

  const annRow = el('div', 'fl-row fl-switchrow');
  const annSw = el('button', 'fl-switch' + (s.announce !== false ? ' on' : ''));
  annSw.type = 'button';
  annSw.onclick = () => flPatch({ announce: !(s.announce !== false) });
  annRow.appendChild(annSw);
  const annTxt = el('div', 'fl-switch-txt');
  annTxt.appendChild(el('div', 'fl-switch-title', '主动发现'));
  annTxt.appendChild(el('div', 'fl-hint',
    '开启后定期发出通告与探测：UDP 广播 + 组播 + 对已知对端、本机地址和额外目标的单播探测。'
    + '关闭后不创建任何发现 socket（既不能广播也不能主动探测），但 TCP 传输、已配对凭据与按地址配对仍然可用。'));
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
  row.appendChild(el('span', 'fl-hint', '保存会重新挂载服务；已配对设备用保存的互信凭据自动重连。'));
  card.appendChild(row);
  body.appendChild(card);

  /* ---- 发现：额外单播目标 ----
     广播 / 组播在 WSL2（NAT 或镜像网络）、跨网段、防火墙挡住 UDP 时都可能
     到不了对端。把对方地址加在这里，每轮发现会额外向它发一次单播探测。 */
  const discCard = el('section', 'fl-card');
  const dh = el('div', 'fl-card-head');
  dh.appendChild(el('span', 'fl-card-title', '发现'));
  discCard.appendChild(dh);
  discCard.appendChild(el('div', 'fl-hint',
    '广播 / 组播在 WSL2（NAT 或镜像网络）、跨网段、防火墙挡住 UDP 时可能到不了对端。'
    + '把对方地址加到这里，每轮发现会额外向它发一次单播探测 —— 这是穿过这些边界最可靠的路径。'
    + '端口不写就用发现端口（' + (Number(st.discovery_port || 0) || 47821) + '）。'));
  const extraIn = flTextarea('每行一个地址，例如：\n100.2.22.110\n192.168.1.9:47821',
    flExtraTargets().join('\n'), 4);
  discCard.appendChild(flField('额外发现地址', extraIn, '每行一个 ip[:port]，最多 16 个；留空 = 只用自动发现。'));
  const erow = el('div', 'fl-row');
  erow.appendChild(flBtn('保存发现地址', 'check', () => flSaveExtra(extraIn.value), 'accent'));
  erow.appendChild(el('span', 'fl-hint', '保存会重新挂载服务；已配对设备用保存的凭据自动重连。'));
  discCard.appendChild(erow);
  body.appendChild(discCard);

  const idCard = el('section', 'fl-card');
  const ih = el('div', 'fl-card-head');
  ih.appendChild(el('span', 'fl-card-title', '本机标识'));
  idCard.appendChild(ih);
  const kv = el('div', 'fl-kv');
  kv.appendChild(el('span', 'fl-k', 'client_id'));
  kv.appendChild(el('code', 'fl-v mono', flClientId() || '—'));
  idCard.appendChild(kv);
  idCard.appendChild(el('div', 'fl-hint',
    '目录：.cell/links/（identity.json 标识 / links.json 设置与连接，含额外发现地址 / transmission.json 传输索引 / <client_id>/.key 互信凭据）'));
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
/* 页签按「工作区 + 会话」定位：同一个对端工作区可以同时开多个会话页签。
   监视页签用 session='watch'，与真实会话 id 不冲突（id 是 16 位十六进制）。 */
function flTabKey(cell, cwd, session) {
  let k = 'link:' + cell + ':' + cwd;
  if (session) k += '#' + session;
  return k;
}

function flTabByRid(rid) {
  for (const key of S.tabOrder) {
    const t = S.tabs.get(key);
    if (t && t.remote && t.remote.rid === rid) return t;
  }
  return null;
}

/* 把对端的历史条目折成消息流：与本地会话同一套 detailEntries，渲染一致 */
function flRemoteEntries(entries, sid) {
  const out = [];
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++)
    for (const m of detailEntries(list[i], i, sid || 'remote')) out.push(m);
  return out;
}

/* 打开一个对端工作区（session 为空 = 对端当前的会话）。
   模型 / 工具 / 沙箱 / 思考强度属于对端：输入栏里仍然可以改，但每一次改动
   都是通过 flowlink.ws.config.set 写到对端，chip 上显示对端的真实值。 */
async function openFlowWorkspace(cell, cwd, name, session) {
  if (!cell || !cwd) return;
  try {
    const out = await api('flowlink.ws.open', { cell: cell, cwd: cwd, name: name || '' });
    if (!out || out.ok === false) { toast((out && out.error) || '无法打开远程工作区', 'bad'); return; }
    const sid = String(session || '');
    const key = flTabKey(cell, cwd, sid);
    const t = tab(key);
    t.remote = { cell: cell, cwd: cwd, name: name || baseName(cwd) || cwd, rid: '', mode: 'run', session: sid, err: '' };
    t.cwd = cwd;
    t.session = 'link';
    t.loaded = true;
    if (!S.tabOrder.includes(key)) S.tabOrder.push(key);
    if (typeof closeFlowLinkPage === 'function') closeFlowLinkPage();
    await activateWs(key);
    renderTabbar();
    if (sid) flLoadRemoteHistory(key, cell, cwd, sid);
    else toast('FlowLink 工作区：执行在对端 cell 上', 'info', 2200);
    // the turn settings belong to the peer: read them once so the composer
    // paints its real model / thinking / sandbox instead of a placeholder
    flLoadRemoteConf(t);
    // 对端这个工作区当前在用的会话：chip（用量 / 后台任务）按会话统计，
    // 没有它就只能显示「—」。顺带把对端的数字先取一次，页签一打开就是真值。
    flResolveRemoteSession(t).then(() => {
      if (S.tabs.get(key) !== t) return;
      flRefreshRemoteUsage(t);
      flRefreshRemoteTasks(t);
    });
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

/* 监视模式：只读地看一个对端工作区里活跃会话的输出。没有输入框、没有设置。 */
async function openFlowWatch(cell, cwd, name) {
  if (!cell || !cwd) return;
  try {
    const out = await api('flowlink.ws.watch', { cell: cell, cwd: cwd });
    if (!out || out.ok === false) { toast((out && out.error) || '无法监视这个工作区', 'bad'); return; }
    const key = flTabKey(cell, cwd, 'watch');
    const t = tab(key);
    t.remote = {
      cell: cell, cwd: cwd, name: name || baseName(cwd) || cwd, rid: '', mode: 'watch',
      ws: out.ws || '', session: out.session || '', err: '',
    };
    t.cwd = cwd;
    t.session = 'link';
    t.loaded = true;
    t.msgs = flRemoteEntries(out.entries, out.session || 'watch');
    t.busy = !!out.busy;
    if (!S.tabOrder.includes(key)) S.tabOrder.push(key);
    if (typeof closeFlowLinkPage === 'function') closeFlowLinkPage();
    await activateWs(key);
    renderTabbar();
    toast('监视模式：只读，无法输入或修改会话设置', 'info', 2800);
  } catch (e) { toast(e.message || String(e), 'bad'); }
}

/* 拉一条对端会话的历史，替换页签里的消息（附到已存在会话时用） */
async function flLoadRemoteHistory(key, cell, cwd, sid) {
  const t = S.tabs.get(key);
  if (!t || !t.remote) return;
  try {
    const out = await api('flowlink.ws.history', { cell: cell, cwd: cwd, session: sid });
    if (S.tabs.get(key) !== t) return;
    if (!out || out.ok === false) {
      t.remote.err = (out && out.error) || '读取对端会话历史失败';
      markChat(key);
      return;
    }
    t.msgs = flRemoteEntries(out.entries, sid);
    t.remote.err = '';
    t._stick = true;
    markChat(key);
  } catch (e) {
    t.remote.err = e.message || String(e);
    markChat(key);
  }
}

/* ---------- 对端的回合设置（模型 / 供应商 / 思考强度 / 沙箱 / 工具） ----
   远程回合在对端执行，所以这些值属于对端：本机读一次缓存到页签上
   （t.remote.conf），改动走 flowlink.ws.config.set 落到对端，并把对端返回的
   实际状态写回缓存 —— chip 上显示的始终是对端真正在用的值，而不是本机的
   全局设置（那两者以前混在一起，看着改了、实际对那个会话毫无影响）。
   权限：与「在对端跑回合」同一项授权（accept_workspace / access_workspace）。 */
function flPeerLabel(cell) {
  const id = String(cell || '');
  const d = flDevices().find(x => x.client_id === id);
  const nm = (d && (d.name || '')) || '';
  return nm || (id ? '对端 ' + id.slice(0, 8) : '对端');
}

function flRemoteConf(t) { return (t && t.remote && t.remote.conf) || null; }

/* 把一次 ws.config 的返回并进页签缓存。没有 models 字段时保留上次拉到的列表，
   只有换供应商才作废（列表属于供应商）。 */
function flApplyRemoteConf(t, out, opts) {
  if (!t || !t.remote || !out) return;
  const c = out.config;
  if (!c || typeof c !== 'object') return;
  const conf = t.remote.conf || (t.remote.conf = {});
  const prevProvider = conf.provider;
  Object.assign(conf, c);
  if (opts && Array.isArray(opts.models)) conf.models = opts.models;
  else if (!Array.isArray(conf.models) || (prevProvider && prevProvider !== conf.provider)) conf.models = [];
  conf.at = nowSec();
  conf.loaded = true;
  delete conf.loading;
  delete conf.err;
}

/* 读一次对端设置。withModels 会顺带让对端去拉一次供应商的模型列表（网络往返，
   可能要几秒）；默认只读设置，几十毫秒。 */
async function flLoadRemoteConf(t, withModels) {
  if (!t || !t.remote || t.remote.mode === 'watch') return null;
  const cell = t.remote.cell;
  if (t.remote.confLoading) return t.remote.confLoading;
  const conf = t.remote.conf || (t.remote.conf = {});
  conf.loading = true;
  const p = (async () => {
    try {
      const out = await api('flowlink.ws.config', { cell: cell, models: !!withModels });
      if (S.tabs.get(t.ws) !== t) return null;
      if (!out || out.ok === false) {
        conf.err = (out && out.error) || '读取对端设置失败';
        return null;
      }
      flApplyRemoteConf(t, out, { models: out.models });
      if (out.models_error) conf.modelsErr = out.models_error;
      renderComposer();
      if (typeof renderStatLine === 'function') renderStatLine();
      return conf;
    } catch (e) {
      conf.err = e.message || String(e);
      return null;
    } finally {
      if (S.tabs.get(t.ws) === t) { t.remote.confLoading = null; conf.loading = false; }
    }
  })();
  t.remote.confLoading = p;
  return p;
}

/* 改对端的回合设置。patch 只会带 ws.config.set 认的键：
   provider / model / think_level / tools / sandbox_mode。 */
async function flPatchRemoteConf(t, patch, okMsg) {
  if (!t || !t.remote || t.remote.mode === 'watch') return false;
  const out = await cmd('flowlink.ws.config.set', { cell: t.remote.cell, patch: patch });
  if (!out || out.ok === false) {
    toast((out && out.error) || flPeerLabel(t.remote.cell) + ' 没有接受这次修改', 'bad', 4200);
    return false;
  }
  flApplyRemoteConf(t, out);
  renderComposer();
  if (typeof renderFoot === 'function') renderFoot();
  if (typeof renderStatLine === 'function') renderStatLine();
  if (okMsg) toast(okMsg, 'ok');
  return true;
}

/* 远程页签上的 /model /provider /think /tools /sandbox：同一条命令路径，
   但落到对端。返回 true = 已处理（execSlash 不再往下走本机分支）。 */
function flRemoteSlash(t, name, arg) {
  if (!t || !t.remote) return false;
  const SET = ['/model', '/provider', '/think', '/tools', '/sandbox', '/autoallow'];
  if (t.remote.mode === 'watch') {
    if (SET.includes(name)) {
      toast('监视模式：只能看，不能改对端设置', 'info', 2600);
      return true;
    }
    return false;
  }
  const peer = flPeerLabel(t.remote.cell);
  switch (name) {
    case '/model': {
      if (!arg) { toast('用法：/model <模型名>（对端 ' + peer + ' 的供应商）'); return true; }
      flPatchRemoteConf(t, { model: arg }, '对端模型：' + arg);
      return true;
    }
    case '/provider': {
      if (!arg) { toast('用法：/provider <名称>（对端 ' + peer + ' 上已配置的供应商）'); return true; }
      // 换供应商会清空对端的当前模型：随后让用户当场选一个
      flPatchRemoteConf(t, { provider: arg }).then(ok => {
        if (!ok) return;
        const c = flRemoteConf(t);
        if (c) c.models = [];
        return flLoadRemoteConf(t, true).then(() => {
          const chip = $('#modelChip');
          if (chip && !(cmpMenu && cmpMenu.kind === 'model')) toggleModelMenu(chip);
          toast('对端供应商已切到 ' + arg + '，请选择模型', 'info', 4000);
        });
      });
      return true;
    }
    case '/think': {
      if (!arg) { toast('用法：/think 0-4 或 ' + THINK_LEVELS.map(l => l.name).join('/')); return true; }
      const lv = thinkLevelOf(arg);
      if (lv == null) { toast('无效的思考级别：' + arg, 'bad'); return true; }
      flPatchRemoteConf(t, { think_level: lv }, '对端思考级别：' + THINK_LEVELS[lv].name);
      return true;
    }
    case '/tools': {
      const on = !arg ? !effTools(t) : !/^(off|0|false|no)$/i.test(arg);
      flPatchRemoteConf(t, { tools: on }, '对端工具调用：' + (on ? '开' : '关'));
      return true;
    }
    case '/sandbox': {
      if (!arg) { toast('用法：/sandbox ' + SANDBOX_MODES.map(m => m.v).join('|')); return true; }
      setSandboxMode(arg);
      return true;
    }
    case '/autoallow': {
      const on = !arg ? true : !/^(off|0|false|no)$/i.test(arg);
      flPatchRemoteConf(t, { autoallow: on }, '对端自动放行：' + (on ? '开' : '关'));
      return true;
    }
    default: return false;
  }
}

/* ---------- 对端工作区的通用 RPC -------------------------------------
   远程页签复用本机的整套 UI，所以右栏（文件 / Git / 终端）、会话顶栏的
   chip（用量 / 后台任务）和会话动作（压缩 / 保存 / 导出 / 清空）走的都是
   **对端自己的命令名**：flowlink.ws.call 把它们连同一个 cwd 送过去，对端
   按白名单执行，答案原样回来。面板与 chip 因此不需要知道对面是谁 —— 只要
   把 api(...) 换成 flRemoteCall(...)。
   mode==='watch' 是只读订阅：任何写操作都直接拒绝。                         */
function flRemoteSessionId(t) {
  const r = (t && t.remote) || null;
  if (!r) return '';
  return r.session || r.peerSession || '';
}
async function flRemoteCall(t, method, args, opts) {
  if (!t || !t.remote) return { ok: false, error: 'not a FlowLink workspace' };
  // 监视模式是只读订阅：读类命令放行（allowWatch），写类一律拒绝
  if (t.remote.mode === 'watch' && !(opts && opts.allowWatch))
    return { ok: false, error: '监视模式：只能看，不能改对端' };
  const p = { cell: t.remote.cell, cwd: t.remote.cwd, method: method, args: args || {} };
  if (opts && opts.timeout) p.timeout = opts.timeout;
  // 终端：对端要把这条 PTY 的字节流绑到这个页签上（见 fl_serve 的 ws.call）
  if (method.indexOf('term.') === 0) p.local_ws = t.ws;
  try {
    const out = await api('flowlink.ws.call', p);
    if (out == null) return { ok: false, error: '空响应' };
    return out;
  } catch (e) { return { ok: false, error: String((e && e.message) || e || '远程调用失败') }; }
}

/* 对端这个工作区当前在用的会话 id。空会话的远程页签靠它把 chip 挂到对端的
   数字上（用量 / 后台任务都是按会话统计的）。 */
async function flResolveRemoteSession(t) {
  if (!t || !t.remote || t.remote.mode === 'watch') return '';
  if (flRemoteSessionId(t)) return flRemoteSessionId(t);
  await flLoadSessions(t.remote.cell, t.remote.cwd, false);
  const list = flSessions(t.remote.cell, t.remote.cwd);
  const hit = list.find(s => s.active) || list[0];
  if (hit && hit.id) {
    t.remote.session = hit.id;
    if (!t.remote.peerWs && hit.ws) t.remote.peerWs = hit.ws;
  }
  return (hit && hit.id) || '';
}

/* 对端的用量快照：结构与本机 S.usages 一致，只是落在页签上（一个对端一份，
   不覆盖本机那份全局统计）。 */
async function flRefreshRemoteUsage(t, force) {
  if (!t || !t.remote || t.remote.mode === 'watch') return null;
  const cur = t.remote.usage;
  if (!force && cur && Date.now() - (cur.at || 0) < 20000) return cur;
  if (t.remote.usageLoading) return cur || null;
  t.remote.usageLoading = true;
  try {
    await flResolveRemoteSession(t);
    const out = await flRemoteCall(t, 'usages.summary', {}, { allowWatch: true });
    if (!out || out.ok === false) return cur || null;
    const snap = {
      at: Date.now(),
      totals: out.totals || {},
      models: out.models || [],
      sessions: out.sessions || [],
      totalSessions: out.total_sessions || (out.sessions || []).length,
    };
    t.remote.usage = snap;
    paintChatUsage(t.ws);
    return snap;
  } finally { t.remote.usageLoading = false; }
}

/* 对端的后台任务快照（tasks.list 的同一份形状） */
async function flRefreshRemoteTasks(t) {
  if (!t || !t.remote || t.remote.mode === 'watch') return null;
  await flResolveRemoteSession(t);
  const out = await flRemoteCall(t, 'tasks.list', {}, { allowWatch: true });
  if (!out || out.ok === false) return null;
  t.remote.tasks = Array.isArray(out.tasks) ? out.tasks : [];
  t.remote.tasksAt = Date.now();
  paintChatTasks(t.ws);
  if (S.tasksOpen) paintTasksPop();
  return t.remote.tasks;
}

/* 输入框里的发送：远程工作区走 flowlink.ws.send，回合在对端跑 */
async function flSendRemote(t) {
  const text = (t.composer.text || '').trim();
  if (!text) return;
  if (t.remote && t.remote.mode === 'watch') { toast('监视模式不能输入', 'info'); return; }
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
    session: t.remote.session || '',
  });
  if (out && out.ok === false) {
    t.busy = false;
    t._stream = null;
    t.msgs.push({ id: uid(), role: 'assistant', text: '⚠ ' + ((out && out.error) || '远程回合启动失败') });
    markChat(t.ws);
    markComposer(t.ws);
    schedule('tabbar', renderTabbar);
    return;
  }
  // the peer tells us which session the turn landed in (it may have opened a
  // new one): the chips and the next turn's "session" must follow it
  if (out) {
    if (out.session) t.remote.session = out.session;
    if (out.ws) t.remote.peerWs = out.ws;
  }
}

/* 对端推回来的回合事件（agent.event） */
function flOnPeerEvent(ev) {
  const params = (ev && ev.params) || {};
  // the peer pushed its open-workspace list: refresh the picker it belongs to
  if ((ev && ev.method) === 'ws.state') {
    if (FL.tab === 'links') flLoadRemote(ev.client_id);
    return;
  }
  if ((ev && ev.method) !== 'agent.event') return;
  if (params.watch) { flOnWatchEvent(ev, params); return; }
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

/* 监视事件：按 client_id + 对端 ws 找页签（监视是订阅，没有 rid） */
function flOnWatchEvent(ev, params) {
  const cell = (ev && ev.client_id) || '';
  const ws = params.ws || '';
  let t = null;
  for (const key of S.tabOrder) {
    const x = S.tabs.get(key);
    if (x && x.remote && x.remote.mode === 'watch' && x.remote.cell === cell && x.remote.ws === ws) { t = x; break; }
  }
  if (!t) return;
  const e = params.ev || {};
  if (e.t === 'answer') {
    if (!t._stream) {
      t._stream = { id: uid(), role: 'assistant', text: '' };
      t.msgs.push(t._stream);
    }
    t._stream.text += (e.d || '');
    t.busy = true;
    markChat(t.ws);
    schedule('tabbar', renderTabbar);
    return;
  }
  if (e.t === 'turn_end') {
    t._stream = null;
    t.busy = false;
    t.thinkingSince = 0;
    markChat(t.ws);
    schedule('tabbar', renderTabbar);
  }
  // tool_begin / tool_end / status 在监视视图里不展示：只保留正文
}

/* ---------- 侧栏的 FlowLink 工作区列表 -------------------------------
   一个对端工作区一组：组头是工作区（可折叠、可直接开监视），组内是对端
   这个工作区的 session —— 点一条就附到那条会话上。
   会话列表按需拉取（展开时），30 秒内复用缓存；对端没开工作区访问时命令
   本身就会被拒绝，这里把错误原样显示，不假装「暂无会话」。 */
const FL_SESS = new Map();       // "cell\0cwd" -> {items, at, loading, err}
const FL_SESS_TTL = 30;          // seconds
function flSessKey(cell, cwd) { return cell + '\u0000' + cwd; }
function flGroupKey(cell, cwd) { return 'link:' + cell + ':' + cwd; }
function flSessions(cell, cwd) {
  const c = FL_SESS.get(flSessKey(cell, cwd));
  return c && Array.isArray(c.items) ? c.items : [];
}
function flSessState(cell, cwd) { return FL_SESS.get(flSessKey(cell, cwd)) || null; }
async function flLoadSessions(cell, cwd, force) {
  const key = flSessKey(cell, cwd);
  const cur = FL_SESS.get(key) || { items: [], at: 0, loading: false, err: '' };
  if (cur.loading) return;
  if (!force && cur.at && (Date.now() / 1000 - cur.at) < FL_SESS_TTL) return;
  cur.loading = true;
  FL_SESS.set(key, cur);
  try {
    const out = await api('flowlink.ws.sessions', { cell: cell, cwd: cwd });
    if (out && out.ok !== false) {
      cur.items = Array.isArray(out.sessions) ? out.sessions : [];
      cur.err = '';
    } else {
      cur.err = (out && out.error) || '读取会话失败';
    }
  } catch (e) {
    cur.err = e.message || String(e);
  }
  cur.loading = false;
  cur.at = Date.now() / 1000;
  renderFlowWsSidebar();
}
/* 这一段的内容指纹：renderSidebar 每帧都会被调用，FlowLink 分组没有变化时
   不该跟着重建（否则对端的会话行同样会在鼠标下被换掉） */
function flowWsSig() {
  let h = 0;
  const put = (s) => { s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
  const items = flSettings().access_workspace ? flWorkspaces() : [];
  put(items.length);
  for (const w of items) {
    const k = flGroupKey(w.cell, w.cwd);
    put(k); put(w.name || ''); put(S.groupsClosed.has(k) ? 1 : 0);
    const peer = flDevices().find(d => d.client_id === w.cell);
    put(peer && peer.online ? 1 : 0);
    const st = flSessState(w.cell, w.cwd);
    put(st && st.loading ? 1 : 0); put((st && st.err) || '');
    for (const s of flSessions(w.cell, w.cwd)) {
      put(s.id); put(s.title || ''); put(s.mtime || 0); put(s.msgs || 0);
      put(s.busy ? 1 : 0); put(s.active ? 1 : 0);
      put(S.active === flTabKey(w.cell, w.cwd, s.id) ? 1 : 0);
    }
  }
  return h;
}
/* 对端该工作区的会话按「工作区即分组」列出来 —— 与本地工作区分组同一套外观 */
function renderFlowWsSidebar(force) {
  const sec = $('#flowWsSection');
  const list = $('#flowWsList');
  if (!sec || !list) return;
  const sig = flowWsSig();
  if (!force && list.__sig === sig) return;
  list.__sig = sig;
  // 未开启「使用对端工作区」时，整段不显示 —— 也不去拉对端的会话列表
  const items = flSettings().access_workspace ? flWorkspaces() : [];
  sec.hidden = !items.length;           // 无内容时整段不显示
  if (!items.length) { list.replaceChildren(); return; }

  const groups = new Map();
  for (const w of items) {
    const k = flGroupKey(w.cell, w.cwd);
    if (!groups.has(k)) groups.set(k, { key: k, cell: w.cell, cwd: w.cwd, name: w.name || '' });
  }

  const nodes = [];
  for (const g of groups.values()) {
    const collapsed = S.groupsClosed.has(g.key);
    const peer = flDevices().find(d => d.client_id === g.cell);
    const sessions = flSessions(g.cell, g.cwd);
    const st = flSessState(g.cell, g.cwd);
    const busy = sessions.some(s => s.busy);

    const gEl = el('div', 'sgroup fl-sgroup');
    const head = el('div', 'sgroup-head');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const gico = el('span', 'gico');
    gico.appendChild(iconEl('folder', 'sm'));
    head.appendChild(gico);
    const gname = el('span', 'gname trunc', g.name || baseName(g.cwd) || g.cwd);
    gname.title = g.cwd;
    head.appendChild(gname);
    head.appendChild(el('span', 'cnt', String(sessions.length)));
    if (!peer || !peer.online) head.appendChild(el('span', 'cnt', '离线'));
    const pulse = el('span', 'pulse' + (busy ? ' busy' : ''));
    pulse.title = busy ? '对端正在运行回合' : (collapsed ? '已折叠' : '已展开');
    if (!busy) pulse.style.background = collapsed ? 'var(--fg4)' : 'var(--ok)';
    head.appendChild(pulse);
    head.title = g.cwd + ' | 对端 ' + (peer ? (peer.name || g.cell.slice(0, 8)) : g.cell.slice(0, 8));
    onPress(head, () => {
      if (S.groupsClosed.has(g.key)) S.groupsClosed.delete(g.key);
      else S.groupsClosed.add(g.key);
      saveGroupState();
      renderFlowWsSidebar(true);
    });
    // 监视：只看这条工作区里活跃会话的输出，不能输入
    const mon = el('button', 'gdel fl-mon');
    mon.appendChild(iconEl('eye', 'sm'));
    mon.title = '监视这个工作区（只读，无法输入）';
    onPress(mon, ev => {
      ev.stopPropagation();
      openFlowWatch(g.cell, g.cwd, g.name);
    });
    head.appendChild(mon);
    gEl.appendChild(head);

    const box = el('div', 'sgroup-items');
    box.hidden = collapsed;
    if (!sessions.length) {
      const msg = (st && st.loading) ? '读取对端会话…'
        : (st && st.err) ? st.err
        : '（对端没有会话）';
      box.appendChild(el('div', 'dim tiny', msg)).style.padding = '2px 10px 6px';
    }
    for (const s of sessions) {
      const key = flTabKey(g.cell, g.cwd, s.id);
      const it = el('div', 'sitem' + (S.active === key ? ' active' : ''));
      const title = el('div', 'stitle trunc', s.title || shortId(s.id));
      title.title = (s.title || s.id) + ' · ' + s.id;
      it.appendChild(title);
      const meta = el('div', 'smeta');
      meta.appendChild(el('span', 'stag fl-tag', '对端'));
      meta.appendChild(el('span', null, relTime(s.mtime)));
      meta.appendChild(el('span', null, (s.msgs || 0) + ' 条'));
      if (s.active) meta.appendChild(el('span', 'stag', '当前'));
      if (s.busy) { const d = el('span', 'dot run'); d.style.marginLeft = 'auto'; meta.appendChild(d); }
      it.appendChild(meta);
      onPress(it, () => openFlowWorkspace(g.cell, g.cwd, g.name, s.id));
      box.appendChild(it);
    }
    gEl.appendChild(box);
    nodes.push(gEl);
    if (!collapsed) flLoadSessions(g.cell, g.cwd);
  }
  list.replaceChildren(...nodes);
}

/* FlowLink 事件（00-core 分发到这里）：配对完成、设备上线、收到传输、工作区变化 */
function onFlowlinkEvent(ev) {
  if (!ev) return;
  const type = ev.type || '';
  if (type === 'paired') {
    toast('已与 ' + (ev.name || ev.client_id || '对端') + ' 完成双向配对', 'ok');
    refreshFlowlink();
    renderFlowWsSidebar();
  } else if (type === 'pair_request') {
    // 对方输入了本机的配对码；本机还要输入对方的码才算完成
    toast((ev.name || String(ev.client_id || '').slice(0, 8)) + ' 请求配对 —— 在 Scan Links 里输入它的配对码', 'info', 4200);
    refreshFlowlink();
  } else if (type === 'pair_request_expired') {
    toast('配对请求已过期', 'info');
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
  } else if (type === 'config') {
    // 本机的模型 / 思考强度 / 沙箱 / 工具被对端改过：本机窗口跟着刷新，
    // 否则 composer 与设置页还停在旧值上（改的是真的，显示的是假的）
    refreshFlowlink();
    resync();
  }
  if (FL.tab && $('#flowlinkPage') && $('#flowlinkPage').classList.contains('show')) flPaint();
}
