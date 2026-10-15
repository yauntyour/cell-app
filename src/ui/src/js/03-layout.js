/* =====================================================================
   Layout · 三区分栏比例 + 可拖动分隔条

   三个功能区按 **20% / 50% / 30%** 划分，并且自适应缩放：
     · 侧栏 20%  │  主区 50%  │  右侧 dock 30%
   存的是**比例**（0..1）而不是像素，所以窗口怎么变都保持这个分配；
   像素只在落笔那一刻按当前视口算出来（见 rail()）。

   仍保留三条可拖动分隔条（用户要横向空间时按需偏离默认比例）：
     侧栏 │ 主区 · 主区 │ 右侧 dock · 消息区 │ 输入栏
   每处一条 6px 透明热区，拖动即改写对应区域的比例，存 localStorage
   （键 cell.layout），刷新后保留。

   约束：
     · 比例夹在 [min, max]，且**换算成像素后**再夹一次绝对区间——
       窄窗口下 20% 可能小于 180px，那就以 180px 为准（可读性优先）；
     · dock 上限不设死：Teamwork 并行分支需要横向空间，用户明确要求
       「大幅横向扩宽」，所以上限是 90% 而不是某个固定像素；
     · 侧栏收起时（.collapsed）不参与拖动；
     · 输入栏高度是纵向的，与横向比例无关，仍存像素。
   拖动用 pointer 事件（一次 pointerdown 覆盖鼠标/触控/笔），并在
   document 上挂 move/up，避免指针滑出分隔条后丢事件。
   ===================================================================== */
const LAYOUT_KEY = 'cell.layout';
const Layout = {
  // 20% / 50% / 30%。main 不存——它是"剩下的"，由 sidebar 与 dock 决定，
  // 这样任意时刻三者之和恒为 1，拖动时不可能把主区挤没。
  def: { sidebar: 0.20, dock: 0.30, composer: 148 },
  // 比例区间：侧栏最多 45%（再宽就挤掉主区），dock 最多 90%
  min: { sidebar: 0.10, dock: 0.14, composer: 96 },
  max: { sidebar: 0.45, dock: 0.90, composer: 0 }, // composer 上限按视口算
  // 像素护栏（先按比例夹，再按像素夹——窄视口下比例不够用时兜底）
  pxMin: { sidebar: 180, dock: 300 },
  pxMax: { sidebar: 560, dock: 1200 },
  // 主区（= 侧栏与 dock 之外剩下的）至少要留这么宽，否则输入栏没法用
  mainMin: 420,
  vals: null,

  load() {
    if (this.vals) return this.vals;
    const d = Object.assign({}, this.def);
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
      if (raw && raw.__v === 2) {
        // 新格式：横向已经是比例，直接用
        for (const k of ['sidebar', 'dock']) {
          const n = Number(raw[k]);
          if (n > 0) d[k] = n;
        }
        const c = Number(raw.composer);
        if (c > 0) d.composer = c;
      } else if (raw) {
        // 旧格式（无版本号）：横向存的是像素。按当前视口折算成比例，
        // 这样老用户升级后看到的布局和之前一致，而不是被硬拽回 20/50/30。
        const vw = Math.max(320, window.innerWidth);
        for (const k of ['sidebar', 'dock']) {
          const n = Number(raw[k]);
          if (n > 0) d[k] = Math.min(1, n / vw);
        }
        const c = Number(raw.composer);
        if (c > 0) d.composer = c;
      }
    } catch (e) {}
    this.vals = d;
    return d;
  },
  save() {
    try {
      const v = this.load();
      localStorage.setItem(LAYOUT_KEY,
        JSON.stringify({ __v: 2, sidebar: v.sidebar, dock: v.dock, composer: v.composer }));
    } catch (e) {}
  },
  // 夹取并落盘：v 是本轮拖动算出的原始比例
  set(key, v, commit) {
    const vals = this.load();
    const hi = key === 'composer' ? Math.max(this.min.composer, window.innerHeight - 200) : this.max[key];
    vals[key] = key === 'composer' ? Math.round(clamp(v, this.min[key], hi))
                                   : clamp(v, this.min[key], hi);
    this.apply();
    if (commit) this.save();
  },
  apply() {
    const v = this.load();
    const sb = $('#sidebar'), dk = $('#rightdock');
    // 比例 → 像素。dock 收起时宽度 0，但记下的比例保留给再次打开。
    const px = this.sizes();
    if (sb) sb.style.width = px.sidebar + 'px';
    if (dk) dk.style.width = px.dock + 'px';
    // 输入栏是悬浮卡片：高度写成 CSS 变量，消息流的底部留白读同一个值
    document.documentElement.style.setProperty('--composer-h', v.composer + 'px');
  },
  // 🔴 两个侧栏必须**一起**算，不能各算各的：它们各自的百分比基数都是整个
  // shell（dock 虽然在 DOM 里是 #main 的后代，但宽度由这里给死），分开算会
  // 各自占满 availWidth，把主区挤成 0。返回 {sidebar, dock} 像素。
  // 顺序：比例 → 像素护栏 → 主区底线（不够就让两侧等比让出，主区优先）。
  sizes() {
    const v = this.load();
    const avail = this.availWidth();
    let sb = clamp(v.sidebar * avail, this.pxMin.sidebar,
                   Math.min(this.pxMax.sidebar, avail));
    let dk = S.dockOpen
      ? clamp(v.dock * avail, this.pxMin.dock, Math.min(this.pxMax.dock, avail))
      : 0;
    // 主区底线：avail 装不下「侧栏下限 + dock 下限 + 主区」时（很窄的窗口），
    // 按当前比例等比缩小两侧，把主区保到 mainMin——它是真正干活的地方。
    // 三条竖分隔条 margin:-3px，净宽 0，所以 avail 就是 shell 的宽度。
    const need = this.mainMin;
    if (sb + dk > avail - need) {
      const budget = Math.max(0, avail - need);
      const room = sb + dk;
      if (room > 0) { sb = sb / room * budget; dk = dk / room * budget; }
    }
    return {sidebar: Math.round(sb), dock: Math.round(dk)};
  },
  // 可分配的总宽度。两条竖分隔条是 width:6px + margin:0 -3px，净占 0，
  // 所以这里就是 shell 的宽度 = 视口宽度（body overflow:hidden，无滚动条）。
  availWidth() {
    return Math.max(320, window.innerWidth);
  },

  init() {
    this.load();
    this.apply();
    this.drag($('#rzSidebar'), 'sidebar', 'x');
    this.drag($('#rzDock'), 'dock', 'x', true);
    // 把手在悬浮卡的顶边：往下拖 = 顶边下移 = 卡片变矮，所以取反
    this.drag($('#rzComposer'), 'composer', 'y', true);
    window.addEventListener('resize', () => {
      // 比例不变，像素重算——这就是"自适应缩放"：窗口变了三区仍按 20/50/30 分配
      this.set('composer', this.load().composer, false);
      this.apply();
    });
  },

  // axis: 'x' 横向拖动改比例，'y' 纵向拖动改高度
  // reverse: 分隔条在目标元素左侧（dock），向左拖是变宽
  drag(handle, key, axis, reverse) {
    if (!handle) return;
    let active = false, startPos = 0, startVal = 0;
    const pos = ev => (axis === 'x' ? ev.clientX : ev.clientY);

    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      // dock 收起时不拖（宽度为 0，边界不可见）
      if (key === 'dock' && !S.dockOpen) return;
      if (key === 'sidebar' && $('#sidebar').classList.contains('collapsed')) return;
      active = true;
      startPos = pos(ev);
      startVal = this.load()[key];
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add('dragging');
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      ev.preventDefault();
    });

    const move = ev => {
      if (!active) return;
      const d = pos(ev) - startPos;
      // 横向：像素位移 → 比例位移（除以可分配宽度），纵向仍是像素
      const next = axis === 'x'
        ? startVal + (reverse ? -d : d) / this.availWidth()
        : startVal + (reverse ? -d : d);
      this.set(key, next, false);
    };
    const up = ev => {
      if (!active) return;
      active = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { handle.releasePointerCapture(ev.pointerId); } catch (e) {}
      this.save(); // 松手才落盘
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    // 键盘可达：聚焦后用方向键微调
    handle.addEventListener('keydown', ev => {
      // 横向按比例步进（Shift 加速），纵向按像素
      const step = axis === 'x' ? (ev.shiftKey ? 0.04 : 0.01) : (ev.shiftKey ? 48 : 12);
      const v = this.load()[key];
      if (axis === 'x' && ev.key === 'ArrowLeft') this.set(key, v - (reverse ? -step : step), true);
      else if (axis === 'x' && ev.key === 'ArrowRight') this.set(key, v + (reverse ? -step : step), true);
      else if (axis === 'y' && ev.key === 'ArrowUp') this.set(key, v - step, true);
      else if (axis === 'y' && ev.key === 'ArrowDown') this.set(key, v + step, true);
      else return;
      ev.preventDefault();
    });
  },
};
