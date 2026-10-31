/* =====================================================================
   O. 桌面壳：无边框窗口 + 启动页

   O.1 窗口
   ---------------------------------------------------------------------
   Windows 上窗口是真的没有边框（src/cell-app.cpp 的 frame：WM_NCCALCSIZE
   把非客户区算成 0），所以「拖窗口 / 缩放 / 最小化 / 最大化 / 关闭」全得
   由这一栏自己发起，走 host_win 绑定：

       drag    → 系统自己的移动循环（Aero Snap、贴边分屏照旧）
       resize  → 同一个循环的缩放版本
       min / max / restore / toggle / close

   WebView2 是覆盖整个客户区的子窗口，父窗口收不到 WM_NCHITTEST，所以
   连"鼠标在不在边框上"都只能由页面判断 —— 这就是 #edges 那八条热区的
   由来（光标样式也交给 CSS）。

   浏览器里打开同一个页面时 host_win 不存在：窗口按钮和热区都不出现，
   布局照旧（那一栏仍然可用，只是没有窗口操作）。

   O.2 启动页
   ---------------------------------------------------------------------
   整窗覆盖，第一帧就在（HTML 里先于 #app），boot 完成后淡出。内容按
   .cell/cell-app.json 的 splash 段定制，三种形态：
     内置动画（默认）/ 自定义图片 / 自定义整页（.cell/splash/index.html）
   ===================================================================== */

/* ---------- O.1 窗口控制 ------------------------------------------- */
const Win = {
  avail: typeof window.host_win === 'function',
  maximized: false,

  call(op, extra) {
    if (!this.avail) return Promise.resolve(null);
    const payload = Object.assign({ op: op }, extra || {});
    return window.host_win(payload).then(r => {
      if (r && typeof r.maximized === 'boolean') this.setMax(r.maximized);
      return r;
    }).catch(() => null);
  },

  // 最大化状态：按钮图标、缩放热区、页面留白都跟着它变
  setMax(on) {
    on = !!on;
    if (on === this.maximized) return;
    this.maximized = on;
    const b = $('#wcMax');
    if (b) {
      b.title = on ? '还原' : '最大化';
      b.setAttribute('aria-label', b.title);
      const a = b.querySelector('.ico-max'), r = b.querySelector('.ico-restore');
      if (a) a.hidden = on;
      if (r) r.hidden = !on;
    }
    // 最大化时没有可拖的边
    const e = $('#edges');
    if (e) e.hidden = !this.avail || on;
  },

  drag() { return this.call('drag'); },
  resize(dir) { return this.call('resize', { dir: dir }); },
  minimize() { return this.call('min'); },
  toggle() { return this.call('toggle'); },
  close() { return this.call('close'); },
  ready() { return this.call('ready'); },
};
// C++ 侧在 WM_SIZE 里广播：双击 / Win+↑ / 贴边分屏都不经过页面
window.__cellWinState = st => { if (st && typeof st.maximized === 'boolean') Win.setMax(st.maximized); };

/* ---------- O.2 启动页 --------------------------------------------- */
const SPLASH_DEFAULT_SUB = '本地代理工作台';

const Splash = {
  node: null,
  tpl: null,
  started: 0,
  minMs: 1400,
  hidden: false,
  cfg: null,

  init() {
    this.node = $('#splash');
    if (!this.node) return;
    this.tpl = this.node.cloneNode(true); // 「预览」时用它重挂一份
    this.started = performance.now();
  },

  remount() {
    if (!this.tpl) return null;
    if (this.node) this.node.remove();
    const n = this.tpl.cloneNode(true);
    document.body.insertBefore(n, document.body.firstChild);
    this.node = n;
    this.hidden = false;
    this.started = performance.now();
    return n;
  },

  /* cfg = prefs.splash：{on, ms, title, sub, bg, image, anim, page} */
  apply(cfg) {
    cfg = cfg || {};
    if (!this.node) this.init();
    if (!this.node) return;
    this.cfg = cfg;
    if (cfg.on === false) { this.hideNow(); return; }

    this.minMs = Math.max(0, Number(cfg.ms) || 0);
    const root = this.node;
    root.style.background = cfg.bg || '';

    const title = $('#splashTitle'), sub = $('#splashSub');
    if (title) title.textContent = (cfg.title || '').trim() || 'cell';
    if (sub) sub.textContent = (cfg.sub || '').trim() || SPLASH_DEFAULT_SUB;

    // 自定义整页优先：同源 iframe 铺满，内置内容整体让位
    const frame = $('#splashFrame'), inner = $('#splashInner');
    if (cfg.page && frame) {
      if (!frame.getAttribute('src')) frame.src = '/api/splash/page';
      frame.hidden = false;
      if (inner) inner.hidden = true;
      return;
    }
    if (frame) frame.hidden = true;
    if (inner) inner.hidden = false;

    // 自定义图片替换 logo；图片坏了就退回内置 logo（onerror）
    const img = $('#splashImage'), logo = $('#splashLogo');
    if (cfg.image && img) {
      img.onerror = () => { img.hidden = true; if (logo) logo.hidden = false; };
      img.src = '/api/splash/asset?v=' + Date.now();
      img.hidden = false;
      if (logo) logo.hidden = true;
    } else {
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (logo) logo.hidden = false;
    }

    if (logo) {
      const anim = cfg.anim || 'draw';
      logo.classList.toggle('anim-pulse', anim === 'pulse');
      logo.classList.toggle('anim-none', anim === 'none');
    }
  },

  /* boot 结束：至少展示 minMs 再淡出（快启动时不会一闪而过） */
  finish() {
    if (this.hidden || !this.node) return;
    const wait = Math.max(0, this.minMs - (performance.now() - this.started));
    setTimeout(() => this.hideNow(), wait);
  },

  hideNow() {
    const n = this.node;
    if (!n || this.hidden) return;
    this.hidden = true;
    n.classList.add('gone');
    setTimeout(() => { if (n.parentNode) n.remove(); if (this.node === n) this.node = null; }, 700);
  },

  /* 设置页的「预览」：重挂一份，按当前配置跑一遍再收起来 */
  preview(cfg) {
    if (!this.tpl) this.init();
    this.remount();
    this.apply(cfg);
    this.finish();
  },
};

/* ---------- O.3 装配 ------------------------------------------------- */
function wireShell() {
  if (!Win.avail) return;

  const ctl = $('#winCtl');
  if (ctl) ctl.hidden = false;
  const edges = $('#edges');
  if (edges) edges.hidden = false;

  const min = $('#wcMin'), max = $('#wcMax'), close = $('#wcClose');
  if (min) min.onclick = () => Win.minimize();
  if (max) max.onclick = () => Win.toggle();
  if (close) close.onclick = () => Win.close();

  // 标题栏空白处 = 拖拽区。按钮 / 页签 / 输入控件不算。
  const tb = $('#titlebar');
  if (tb) {
    let lastDown = 0;
    tb.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      if (ev.target.closest('button, a, input, textarea, select, .tab, .no-drag')) return;
      ev.preventDefault();
      const now = performance.now();
      // 双击标题栏 = 最大化/还原。不能靠浏览器 dblclick：第一次按下就把
      // 线程交给系统的移动循环了，第二次按下未必还能凑成一次 dblclick。
      if (now - lastDown < 420) { lastDown = 0; Win.toggle(); return; }
      lastDown = now;
      Win.drag();
    });
  }

  // 四边四角的缩放热区
  $$('#edges i').forEach(h => {
    h.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      Win.resize(h.dataset.dir);
    });
  });

  Win.ready(); // 告诉 C++：页面在听了，最大化状态可以广播过来
  // 首帧**先要实色**、画完再切透明：alpha=0 的第一帧会让窗口最上面几像素
  // 留成白色（"左上角一条浅灰带"，2026-10-31）。延迟放在启动页还盖着的时候。
  setTimeout(() => Win.call('glass'), 260);


}
