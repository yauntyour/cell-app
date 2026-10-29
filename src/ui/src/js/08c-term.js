/* =====================================================================
   08c · 真实终端：VT/xterm 子集模拟器 + 视图 + 会话控制器
   ---------------------------------------------------------------------
   window.CellTerm 是面板（08b-panels.js）唯一入口：
     mount(rootEl, {ws, cwd, onStatus, id?, name?}) -> view
     unmount / attach / detach / close / restart / clearBuffer / focus /
     refit / copySelection / pasteText / debug / onEvent
   一个 view = 一个后端会话（一个独立读线程的 shell）。面板里可以并存多个
   view：只有当前页签的 view 挂在文档里，其余 detach() 后继续吃输出与回看
   历史（VT 模型照常更新，只是不渲染），attach() 回来立刻整屏重绘。
   后端（src/cell-app-term.hpp）提供 term.open/input/resize/close 与
   term.out/term.exit/term.error 事件；输出是 base64 字节流，这里用
   TextDecoder(stream) 流式解码，跨 chunk 的 UTF-8 边界不会断字。
   演示模式（S.mode === 'demo'）自带本地假 shell，不依赖后端。
   ===================================================================== */
'use strict';

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------- 0. 小工具 ---------- */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64FromBytes(bytes) {
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (i + 1 === bytes.length) {
      var v1 = bytes[i] << 16;
      out += B64[(v1 >> 18) & 63] + B64[(v1 >> 12) & 63] + '==';
    } else if (i + 2 === bytes.length) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(v2 >> 18) & 63] + B64[(v2 >> 12) & 63] + B64[(v2 >> 6) & 63] + '=';
    }
    return out;
  }
  function b64ToBytes(s) {
    s = String(s || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var len = s.length, pad = 0;
    if (len && s.charAt(len - 1) === '=') pad++;
    if (len > 1 && s.charAt(len - 2) === '=') pad++;
    var out = new Uint8Array(((len * 3) >> 2) - pad);
    var acc = 0, bits = 0, o = 0, i;
    for (i = 0; i < len; i++) {
      var c = s.charAt(i);
      if (c === '=') break;
      var v = B64.indexOf(c);
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return o === out.length ? out : out.subarray(0, o);
  }
  function escHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------- 1. 颜色 ---------- */
  var BASE16 = ['#3f3f46', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0',
                '#767676', '#ff7b86', '#b5e890', '#ffd68a', '#7cc4ff', '#e094ff', '#7ad9e6', '#ffffff'];
  function xterm256(n) {
    n = Number(n) | 0;
    if (n < 0) n = 0; if (n > 255) n = 255;
    if (n < 16) return BASE16[n];
    if (n < 232) {
      var i = n - 16, r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
      var lv = function (x) { return x === 0 ? 0 : 55 + x * 40; };
      return 'rgb(' + lv(r) + ',' + lv(g) + ',' + lv(b) + ')';
    }
    var g2 = 8 + (n - 232) * 10;
    return 'rgb(' + g2 + ',' + g2 + ',' + g2 + ')';
  }
  var A_BOLD = 1, A_DIM = 2, A_ITALIC = 4, A_UNDER = 8, A_INV = 16, A_STRIKE = 32;

  /* ---------- 2. VT 模拟器 ---------- */
  function Vt(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.maxLines = 2000 + rows;
    this.lines = [];
    var i; for (i = 0; i < rows; i++) this.lines.push(this.newRow());
    this.x = 0; this.y = 0;
    this.fg = null; this.bg = null; this.attr = 0;
    this.scrollTopR = 0; this.scrollBotR = rows - 1;
    this.wrap = true; this.wrapPending = false;
    this.cursorVisible = true; this.cursorShape = 'block';
    this.appCursor = false; this.bracketedPaste = false; this.origin = false;
    this.alt = false; this.savedMain = null;
    this.st = 0; this.buf = ''; this.saved = null;
    this.tabStops = null;
    this.onResponse = null;
    this.onTitle = null;
    this.dirty = true;
  }
  Vt.prototype.newRow = function () {
    var row = new Array(this.cols);
    for (var i = 0; i < this.cols; i++) row[i] = null;
    row.v = 0;
    return row;
  };
  Vt.prototype.blankRow = function () { return this.newRow(); };
  Vt.prototype.topIndex = function () { return this.lines.length - this.rows; };
  Vt.prototype.screenRow = function (y) { return this.lines[this.topIndex() + y]; };
  Vt.prototype.touch = function (y) {
    var row = this.screenRow(y);
    if (row) row.v = (row.v || 0) + 1;
    this.dirty = true;
  };
  Vt.prototype.touchAll = function () {
    for (var i = 0; i < this.lines.length; i++) this.lines[i].v = (this.lines[i].v || 0) + 1;
    this.dirty = true;
  };
  Vt.prototype.trim = function () {
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
      if (this.scrollBackExtra) this.scrollBackExtra--;
    }
  };
  Vt.prototype.cell = function (x, y) {
    var row = this.screenRow(y);
    if (!row || x < 0 || x >= this.cols) return null;
    return row[x] || null;
  };
  Vt.prototype.putCell = function (x, y, cell) {
    var row = this.screenRow(y);
    if (!row || x < 0 || x >= this.cols) return;
    row[x] = cell;
    row.v = (row.v || 0) + 1;
    this.dirty = true;
  };
  Vt.prototype.clearRowRange = function (y, from, to) {
    var row = this.screenRow(y);
    if (!row) return;
    for (var x = from; x <= to && x < this.cols; x++) if (x >= 0) row[x] = null;
    row.v = (row.v || 0) + 1;
    this.dirty = true;
  };
  Vt.prototype.reset = function () {
    this.cols = this.cols; this.lines = [];
    for (var i = 0; i < this.rows; i++) this.lines.push(this.newRow());
    this.x = 0; this.y = 0; this.fg = null; this.bg = null; this.attr = 0;
    this.scrollTopR = 0; this.scrollBotR = this.rows - 1;
    this.wrap = true; this.wrapPending = false; this.appCursor = false;
    this.bracketedPaste = false; this.origin = false;
    this.alt = false; this.savedMain = null; this.cursorVisible = true;
    this.st = 0; this.buf = ''; this.dirty = true;
  };

  /* ---- 行/屏滚动 ---- */
  Vt.prototype.scrollUp = function (n) {
    var full = (this.scrollTopR === 0 && this.scrollBotR === this.rows - 1);
    var top = this.topIndex();
    var i, k;
    if (full && !this.alt) {
      for (k = 0; k < n; k++) this.lines.push(this.newRow());
      this.trim();
    } else {
      for (k = 0; k < n; k++) {
        this.lines.splice(top + this.scrollTopR, 1);
        this.lines.splice(top + this.scrollBotR, 0, this.newRow());
      }
    }
    this.dirty = true;
    for (i = this.scrollTopR; i <= this.scrollBotR; i++) this.touch(i);
  };
  Vt.prototype.scrollDownRegion = function (n) {
    var top = this.topIndex();
    for (var k = 0; k < n; k++) {
      this.lines.splice(top + this.scrollBotR, 1);
      this.lines.splice(top + this.scrollTopR, 0, this.newRow());
    }
    this.dirty = true;
    for (var i = this.scrollTopR; i <= this.scrollBotR; i++) this.touch(i);
  };
  Vt.prototype.lineFeed = function () {
    if (this.y === this.scrollBotR) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
    this.wrapPending = false;
  };
  Vt.prototype.reverseIndex = function () {
    if (this.y === this.scrollTopR) this.scrollDownRegion(1);
    else if (this.y > 0) this.y--;
    this.wrapPending = false;
  };

  /* ---- 字符写入 ---- */
  Vt.prototype.putChar = function (ch, width) {
    if (this.wrapPending) {
      this.wrapPending = false;
      if (this.wrap) { this.x = 0; this.lineFeed(); }
    }
    if (this.x >= this.cols) {
      if (this.wrap) { this.x = 0; this.lineFeed(); }
      else this.x = this.cols - 1;
    }
    var cell = { c: ch, fg: this.fg, bg: this.bg, a: this.attr, w: width || 1 };
    if (width === 2 && this.x === this.cols - 1) {
      this.putCell(this.x, this.y, { c: ' ', fg: this.fg, bg: this.bg, a: this.attr, w: 1 });
      if (this.wrap) { this.x = 0; this.lineFeed(); }
    }
    this.putCell(this.x, this.y, cell);
    if (width === 2) {
      this.putCell(this.x + 1, this.y, { c: '', fg: this.fg, bg: this.bg, a: this.attr, w: -1 });
    }
    this.x += width || 1;
    if (this.x >= this.cols) { this.x = this.cols; this.wrapPending = true; }
  };
  Vt.prototype.eraseChars = function (n) {
    var y = this.y, x;
    for (x = this.x; x < this.cols - n; x++) {
      var c = this.cell(x + n, y);
      this.putCell(x, y, c ? { c: c.c, fg: c.fg, bg: c.bg, a: c.a, w: c.w } : null);
    }
    for (; x < this.cols; x++) this.putCell(x, y, null);
  };
  Vt.prototype.insertChars = function (n) {
    var y = this.y, x;
    for (x = this.cols - 1; x >= this.x + n; x--) {
      var c = this.cell(x - n, y);
      this.putCell(x, y, c ? { c: c.c, fg: c.fg, bg: c.bg, a: c.a, w: c.w } : null);
    }
    for (x = this.x; x < this.x + n && x < this.cols; x++) this.putCell(x, y, null);
  };
  Vt.prototype.insertLines = function (n) {
    if (this.y < this.scrollTopR || this.y > this.scrollBotR) return;
    var top = this.topIndex();
    for (var k = 0; k < n; k++) {
      this.lines.splice(top + this.scrollBotR, 1);
      this.lines.splice(top + this.y, 0, this.newRow());
    }
    this.touchAll();
  };
  Vt.prototype.deleteLines = function (n) {
    if (this.y < this.scrollTopR || this.y > this.scrollBotR) return;
    var top = this.topIndex();
    for (var k = 0; k < n; k++) {
      this.lines.splice(top + this.y, 1);
      this.lines.splice(top + this.scrollBotR, 0, this.newRow());
    }
    this.touchAll();
  };
  Vt.prototype.eraseInDisplay = function (mode) {
    var y, x;
    if (mode === 2 || mode === 3) {
      for (y = 0; y < this.rows; y++) this.clearRowRange(y, 0, this.cols - 1);
      return;
    }
    if (mode === 1) {
      for (y = 0; y < this.y; y++) this.clearRowRange(y, 0, this.cols - 1);
      this.clearRowRange(this.y, 0, this.x);
      return;
    }
    this.clearRowRange(this.y, this.x, this.cols - 1);
    for (y = this.y + 1; y < this.rows; y++) this.clearRowRange(y, 0, this.cols - 1);
  };
  Vt.prototype.eraseInLine = function (mode) {
    if (mode === 1) this.clearRowRange(this.y, 0, this.x);
    else if (mode === 2) this.clearRowRange(this.y, 0, this.cols - 1);
    else this.clearRowRange(this.y, this.x, this.cols - 1);
  };

  /* ---- SGR ---- */
  Vt.prototype.sgr = function (ps) {
    var i;
    if (!ps.length) ps = [0];
    for (i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p === 0) { this.fg = null; this.bg = null; this.attr = 0; }
      else if (p === 1) this.attr |= A_BOLD;
      else if (p === 2) this.attr |= A_DIM;
      else if (p === 3) this.attr |= A_ITALIC;
      else if (p === 4) this.attr |= A_UNDER;
      else if (p === 7) this.attr |= A_INV;
      else if (p === 9) this.attr |= A_STRIKE;
      else if (p === 21 || p === 22) this.attr &= ~(A_BOLD | A_DIM);
      else if (p === 23) this.attr &= ~A_ITALIC;
      else if (p === 24) this.attr &= ~A_UNDER;
      else if (p === 27) this.attr &= ~A_INV;
      else if (p === 29) this.attr &= ~A_STRIKE;
      else if (p >= 30 && p <= 37) this.fg = BASE16[p - 30];
      else if (p === 39) this.fg = null;
      else if (p >= 40 && p <= 47) this.bg = BASE16[p - 40];
      else if (p === 49) this.bg = null;
      else if (p >= 90 && p <= 97) this.fg = BASE16[p - 90 + 8];
      else if (p >= 100 && p <= 107) this.bg = BASE16[p - 100 + 8];
      else if (p === 38 || p === 48) {
        var isFg = (p === 38);
        if (ps[i + 1] === 5) { var c = xterm256(ps[i + 2]); if (isFg) this.fg = c; else this.bg = c; i += 2; }
        else if (ps[i + 1] === 2) {
          var rgb = 'rgb(' + (ps[i + 2] | 0) + ',' + (ps[i + 3] | 0) + ',' + (ps[i + 4] | 0) + ')';
          if (isFg) this.fg = rgb; else this.bg = rgb; i += 4;
        }
      }
    }
  };

  /* ---- 模式 ---- */
  Vt.prototype.setMode = function (priv, n, on) {
    if (!priv) {
      if (n === 7) this.wrap = !!on;
      else if (n === 6) this.origin = !!on;
      if (n === 6 && on) this.y = 0, this.x = 0;
      return;
    }
    if (n === 1) this.appCursor = !!on;
    else if (n === 6) { this.origin = !!on; this.x = 0; this.y = 0; }
    else if (n === 7) this.wrap = !!on;
    else if (n === 25) this.cursorVisible = !!on;
    else if (n === 47 || n === 1047 || n === 1049) {
      if (on) this.enterAlt(n === 1049); else this.exitAlt();
    }
    else if (n === 2004) this.bracketedPaste = !!on;
  };
  Vt.prototype.enterAlt = function (saveCursor) {
    if (this.alt) return;
    this.savedMain = { lines: this.lines, x: this.x, y: this.y, fg: this.fg, bg: this.bg, attr: this.attr };
    this.lines = [];
    for (var i = 0; i < this.rows; i++) this.lines.push(this.newRow());
    this.alt = true;
    this.x = 0; this.y = 0; this.wrapPending = false;
    this.scrollTopR = 0; this.scrollBotR = this.rows - 1;
    this.touchAll();
  };
  Vt.prototype.exitAlt = function () {
    if (!this.alt) return;
    if (this.savedMain) {
      this.lines = this.savedMain.lines;
      this.x = this.savedMain.x; this.y = this.savedMain.y;
      this.fg = this.savedMain.fg; this.bg = this.savedMain.bg; this.attr = this.savedMain.attr;
      this.savedMain = null;
    }
    this.alt = false;
    this.x = clamp(this.x, 0, this.cols - 1);
    this.y = clamp(this.y, 0, this.rows - 1);
    this.touchAll();
  };

  /* ---- 输入流状态机 ---- */
  Vt.prototype.write = function (s) {
    for (var i = 0; i < s.length;) {
      var cp = s.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      i += ch.length;
      this.feed(cp, ch);
    }
  };
  Vt.prototype.feed = function (cp, ch) {
    if (this.st === 0) {
      if (cp === 0x1b) { this.st = 1; return; }
      if (cp === 0x0d) { this.x = 0; this.wrapPending = false; return; }
      if (cp === 0x0a || cp === 0x0b || cp === 0x0c) { this.lineFeed(); return; }
      if (cp === 0x08) { if (this.x > 0) this.x--; this.wrapPending = false; return; }
      if (cp === 0x09) {
        var nx = this.x + 1;
        while (nx < this.cols && (nx % 8) !== 0) nx++;
        this.x = Math.min(nx, this.cols - 1);
        this.wrapPending = false;
        return;
      }
      if (cp === 0x07 || cp === 0x00 || cp === 0x7f) return;
      if (cp < 0x20) return;
      var w = isWide(cp) ? 2 : 1;
      this.putChar(ch, w);
      return;
    }
    if (this.st === 1) {
      if (ch === '[') { this.st = 2; this.buf = ''; return; }
      if (ch === ']') { this.st = 3; this.buf = ''; return; }
      if (ch === 'P' || ch === '^' || ch === '_') { this.st = 4; this.buf = ''; return; }
      if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') { this.st = 5; return; }
      if (ch === '7') { this.saved = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, attr: this.attr }; this.st = 0; return; }
      if (ch === '8') {
        if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; this.fg = this.saved.fg; this.bg = this.saved.bg; this.attr = this.saved.attr; }
        this.st = 0; return;
      }
      if (ch === 'D') { this.lineFeed(); this.st = 0; return; }
      if (ch === 'E') { this.x = 0; this.lineFeed(); this.st = 0; return; }
      if (ch === 'M') { this.reverseIndex(); this.st = 0; return; }
      if (ch === 'c') { this.reset(); this.st = 0; return; }
      this.st = 0; return;
    }
    if (this.st === 5) { this.st = 0; return; }
    if (this.st === 4) {
      if (cp === 0x1b) this.st = 6; else if (cp === 0x07) this.st = 0;
      return;
    }
    if (this.st === 6) { this.st = 0; return; }
    if (this.st === 3) {
      if (cp === 0x07) { this.finishOsc(); return; }
      if (cp === 0x1b) { this.finishOsc(); this.st = 6; return; }
      this.buf += ch;
      return;
    }
    if (this.st === 2) {
      if (cp >= 0x40 && cp <= 0x7e) {
        var seq = this.buf;
        this.st = 0; this.buf = '';
        this.csi(seq, ch);
        return;
      }
      this.buf += ch;
      return;
    }
  };
  Vt.prototype.finishOsc = function () {
    this.st = 0;
    var parts = this.buf.split(';');
    if ((parts[0] === '0' || parts[0] === '2') && this.onTitle) {
      try { this.onTitle(parts.slice(1).join(';')); } catch (e) {}
    }
    this.buf = '';
  };
  function isWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd);
  }
  Vt.prototype.csi = function (seq, final) {
    var priv = '';
    var body = seq;
    if (body.charAt(0) === '?' || body.charAt(0) === '>' || body.charAt(0) === '<' || body.charAt(0) === '=') {
      priv = body.charAt(0); body = body.slice(1);
    }
    var parts = body.split(';');
    var ps = [];
    var i, inter = '';
    for (i = 0; i < parts.length; i++) {
      var p = parts[i];
      var m = /^(\d*)([^\d]*)$/.exec(p);
      if (m && m[2]) inter = m[2];
      ps.push(m && m[1] !== '' ? parseInt(m[1], 10) : 0);
    }
    var n0 = ps.length && ps[0] ? ps[0] : 0;
    var self = this;
    switch (final) {
      case 'A': this.y = Math.max(this.origin ? this.scrollTopR : 0, this.y - Math.max(1, n0)); break;
      case 'B': this.y = Math.min(this.origin ? this.scrollBotR : this.rows - 1, this.y + Math.max(1, n0)); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + Math.max(1, n0)); this.wrapPending = false; break;
      case 'D': this.x = Math.max(0, this.x - Math.max(1, n0)); this.wrapPending = false; break;
      case 'E': this.y = Math.min(this.rows - 1, this.y + Math.max(1, n0)); this.x = 0; break;
      case 'F': this.y = Math.max(0, this.y - Math.max(1, n0)); this.x = 0; break;
      case 'G': case '`': this.x = clamp(Math.max(1, n0) - 1, 0, this.cols - 1); break;
      case 'd': this.y = clamp(Math.max(1, n0) - 1 + (this.origin ? this.scrollTopR : 0), 0, this.rows - 1); break;
      case 'H': case 'f': {
        var row = ps.length > 0 && ps[0] ? ps[0] : 1;
        var col = ps.length > 1 && ps[1] ? ps[1] : 1;
        this.y = clamp(row - 1 + (this.origin ? this.scrollTopR : 0), 0, this.rows - 1);
        this.x = clamp(col - 1, 0, this.cols - 1);
        this.wrapPending = false;
        break;
      }
      case 'J': this.eraseInDisplay(n0); break;
      case 'K': this.eraseInLine(n0); break;
      case 'L': this.insertLines(Math.max(1, n0)); break;
      case 'M': this.deleteLines(Math.max(1, n0)); break;
      case 'P': this.eraseChars(Math.max(1, n0)); break;
      case '@': this.insertChars(Math.max(1, n0)); break;
      case 'X': { var k; for (k = this.x; k < this.x + Math.max(1, n0) && k < this.cols; k++) this.putCell(k, this.y, null); break; }
      case 'S': this.scrollUp(Math.max(1, n0)); break;
      case 'T': this.scrollDownRegion(Math.max(1, n0)); break;
      case 'r': {
        var t = (ps[0] || 1) - 1, b = (ps[1] || this.rows) - 1;
        b = clamp(b, 0, this.rows - 1); t = clamp(t, 0, b);
        this.scrollTopR = t; this.scrollBotR = b;
        this.x = 0; this.y = this.origin ? t : 0;
        break;
      }
      case 'm': this.sgr(ps); break;
      case 's': this.saved = { x: this.x, y: this.y, fg: this.fg, bg: this.bg, attr: this.attr }; break;
      case 'u': if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } break;
      case 'h': this.setMode(priv === '?', n0, true); break;
      case 'l': this.setMode(priv === '?', n0, false); break;
      case 'n':
        if (n0 === 5 && this.onResponse) this.onResponse('\u001b[0n');
        else if (n0 === 6 && this.onResponse) this.onResponse('\u001b[' + (this.y + 1) + ';' + (this.x + 1) + 'R');
        break;
      case 'c': if (this.onResponse) this.onResponse('\u001b[?1;2c'); break;
      case 'q': this.cursorShape = n0 === 3 || n0 === 4 ? 'underline' : (n0 === 5 || n0 === 6 ? 'bar' : 'block'); this.dirty = true; break;
      default: break;
    }
  };

  /* ---- 尺寸 ---- */
  Vt.prototype.resize = function (cols, rows) {
    cols = Math.max(2, cols | 0); rows = Math.max(2, rows | 0);
    var self = this, i;
    if (cols === this.cols && rows === this.rows) return false;
    this.lines.forEach(function (row) {
      row.length = cols;
      for (var x = 0; x < cols; x++) if (row[x] === undefined) row[x] = null;
      row.v = (row.v || 0) + 1;
    });
    this.cols = cols;
    if (rows > this.rows) {
      for (i = 0; i < rows - this.rows; i++) this.lines.push(this.newRow());
    } else if (rows < this.rows) {
      var drop = this.rows - rows;
      for (i = 0; i < drop && this.lines.length > rows; i++) this.lines.pop();
    }
    this.rows = rows;
    this.scrollTopR = 0; this.scrollBotR = rows - 1;
    this.x = clamp(this.x, 0, cols - 1);
    this.y = clamp(this.y, 0, rows - 1);
    this.touchAll();
    return true;
  };
  Vt.prototype.screenText = function (trim) {
    var out = [];
    for (var y = 0; y < this.rows; y++) {
      var row = this.screenRow(y), s = '';
      if (row) {
        for (var x = 0; x < this.cols; x++) {
          var c = row[x];
          s += c ? (c.c || ' ') : ' ';
        }
      }
      out.push(trim ? s.replace(/\s+$/, '') : s);
    }
    return out.join('\n');
  };

  /* ---------- 3. 视图 ---------- */
  var views = {};          // sessionId -> view
  var mounted = [];        // 已挂载的 view（用于窗口缩放时 refit）

  function isDemo() {
    try { return typeof S !== 'undefined' && S.mode === 'demo'; } catch (e) {}
    try { return typeof MOCK !== 'undefined' && !!MOCK; } catch (e) {}
    return false;
  }
  function notify(view, st) {
    view.status = st;
    if (view.onStatus) { try { view.onStatus(st); } catch (e) {} }
  }
  function setStatusBar(view, text, bad) {
    if (!view.statusEl) return;
    view.statusEl.textContent = text || '';
    view.statusEl.className = 'ct-status' + (text ? ' show' : '') + (bad ? ' bad' : '');
    if (view.retryEl) view.retryEl.style.display = bad ? '' : 'none';
  }

  function buildDom(view, rootEl) {
    var root = document.createElement('div');
    root.className = 'ct-root';
    root.tabIndex = -1;
    var screen = document.createElement('div');
    screen.className = 'ct-screen';
    var rows = document.createElement('div');
    rows.className = 'ct-rows';
    var cursor = document.createElement('div');
    cursor.className = 'ct-cursor off';
    rows.appendChild(cursor);
    screen.appendChild(rows);
    var ime = document.createElement('textarea');
    ime.className = 'ct-ime';
    ime.setAttribute('spellcheck', 'false');
    ime.setAttribute('autocomplete', 'off');
    ime.setAttribute('autocapitalize', 'off');
    ime.setAttribute('aria-label', '终端输入');
    var status = document.createElement('div');
    status.className = 'ct-status';
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn sm ct-retry';
    retry.textContent = '重试';
    retry.style.display = 'none';
    retry.onclick = function () { CellTerm.restart(view); };
    status.appendChild(retry);
    var statusText = document.createElement('span');
    statusText.className = 'ct-status-text';
    status.insertBefore(statusText, retry);
    root.appendChild(screen);
    root.appendChild(ime);
    root.appendChild(status);
    rootEl.appendChild(root);
    view.root = root; view.screenEl = screen; view.rowsEl = rows;
    view.cursorEl = cursor; view.imeEl = ime; view.statusEl = statusText; view.retryEl = retry;
    view.rowEls = [];
    return root;
  }

  function measure(view) {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0;padding:0;margin:0;';
    probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
    view.rowsEl.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 20;
    probe.textContent = 'Ag';
    var h = probe.getBoundingClientRect().height;
    view.rowsEl.removeChild(probe);
    var cs = null;
    try { cs = window.getComputedStyle(view.root); } catch (e) {}
    var fs = cs ? parseFloat(cs.fontSize) || 12 : 12;
    if (!isFinite(w) || w <= 0) w = fs * 0.6;
    if (!isFinite(h) || h <= 0) h = Math.ceil(fs * 1.45);
    view.cellW = Math.round(w * 100) / 100;
    view.cellH = Math.max(10, Math.round(h));
    view.rowsEl.style.setProperty('--ct-cell-w', view.cellW + 'px');
    view.rowsEl.style.setProperty('--ct-cell-h', view.cellH + 'px');
  }

  function geometry(view) {
    var cs = null;
    try { cs = window.getComputedStyle(view.screenEl); } catch (e) {}
    var padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
    var padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
    var w = view.screenEl.clientWidth - padX;
    var h = view.screenEl.clientHeight - padY;
    if (w <= 0 || h <= 0) {
      // 面板还在展开动画里 / 被收起：不能拿 0 宽去夹出 20 列（那会把首屏
      // 提示符永久硬折行）。先保留当前 VT 尺寸，等 whenStable / refit 再校正。
      return { cols: (view.vt && view.vt.cols) || 80, rows: (view.vt && view.vt.rows) || 24, pending: true };
    }
    var cols = Math.max(2, Math.floor(w / (view.cellW || 7)));
    var rows = Math.max(4, Math.floor(h / (view.cellH || 18)));
    return { cols: cols, rows: rows, pending: false };
  }

  function nowMs() {
    try { if (typeof performance !== 'undefined' && performance.now) return performance.now(); } catch (e) {}
    return Date.now();
  }
  function laidOut(view) {
    try {
      return !!(view && view.screenEl && view.screenEl.isConnected &&
        view.screenEl.clientWidth > 0 && view.screenEl.clientHeight > 0);
    } catch (e) { return false; }
  }
  // 测量 + 把 VT 尺寸对齐到当前布局。只在布局稳定后调用（见 whenStable）。
  function sizeToView(view) {
    measure(view);
    var g = geometry(view);
    if (!g.pending && (g.cols !== view.vt.cols || g.rows !== view.vt.rows)) view.vt.resize(g.cols, g.rows);
    view.cols = view.vt.cols; view.rows = view.vt.rows;
    view.lastCols = -1; // 行宽可能变了：强制下一帧整屏重绘
    view.lastW = view.screenEl.clientWidth;
    view.lastH = view.screenEl.clientHeight;
    return g;
  }
  // dock 开合有 170ms 宽度过渡：挂载 / 重新挂载那一两帧量到的是动画中的宽度，
  // 直接测量会把 cols 量小（首帧按动画宽度折行）。等连续 3 帧宽度不变
  // （即已有真实稳定尺寸）再量；2s 兜底，避免面板一直隐藏时永远不启动会话。
  function whenStable(view, cb) {
    if (view.stableRaf) { try { cancelAnimationFrame(view.stableRaf); } catch (e) {} view.stableRaf = 0; }
    var t0 = nowMs(), lastW = -1, same = 0;
    function tick() {
      view.stableRaf = 0;
      if (view.removed || !view.root) return;
      var w = 0, h = 0;
      try { w = view.screenEl.clientWidth; h = view.screenEl.clientHeight; } catch (e) {}
      if (w > 0 && h > 0 && w === lastW) same++;
      else { same = 0; lastW = w; }
      if ((w > 0 && h > 0 && same >= 2) || nowMs() - t0 >= 2000) { cb(); return; }
      view.stableRaf = requestAnimationFrame(tick);
    }
    view.stableRaf = requestAnimationFrame(tick);
  }
  // 焦点守卫：面板重建会把整棵 .ct-root 摘掉再挂回来，.ct-ime 随 blur 丢焦点。
  // 只有"因节点被摘掉而 blur"才置 wantFocus，重新挂载后由这里抢回；用户主动
  // 点别处（节点仍连着）不会置位，所以不会抢焦点。
  function restoreFocus(view) {
    if (!view || !view.wantFocus || !view.imeEl) return false;
    if (!view.root || !view.root.isConnected) return false;
    if (document.activeElement === view.imeEl) { view.wantFocus = false; return true; }
    try { view.imeEl.focus({ preventScroll: true }); } catch (e) {
      try { view.imeEl.focus(); } catch (e2) { return false; }
    }
    if (document.activeElement === view.imeEl) { view.wantFocus = false; return true; }
    return false;
  }

  function rowHtml(row, cols) {
    if (!row) return '';
    var last = -1, x;
    for (x = cols - 1; x >= 0; x--) {
      var c = row[x];
      if (c && (c.c || c.bg || c.w === 2)) { last = x; break; }
    }
    if (last < 0) return '';
    var out = '', run = null, text = '';
    function flush() {
      if (!text) return;
      if (!run || (!run.fg && !run.bg && !run.a)) { out += escHtml(text); }
      else {
        var st = '';
        var fg = run.fg, bg = run.bg;
        if (run.a & A_INV) { var tf = fg; fg = bg || '#d7dae0'; bg = tf || '#161618'; }
        if (fg) st += 'color:' + fg + ';';
        if (bg) st += 'background:' + bg + ';';
        if (run.a & A_BOLD) st += 'font-weight:700;';
        if (run.a & A_DIM) st += 'opacity:.6;';
        if (run.a & A_ITALIC) st += 'font-style:italic;';
        if (run.a & A_UNDER) st += 'text-decoration:underline;';
        if (run.a & A_STRIKE) st += 'text-decoration:line-through;';
        out += '<span style="' + st + '">' + escHtml(text) + '</span>';
      }
      text = '';
    }
    for (x = 0; x <= last; x++) {
      var cell = row[x];
      if (!cell) { if (!run || run.fg || run.bg || run.a) { flush(); run = null; } text += ' '; continue; }
      if (cell.w === -1) continue;
      var key = (cell.fg || '') + '|' + (cell.bg || '') + '|' + (cell.a || 0);
      if (!run || run.key !== key) { flush(); run = { key: key, fg: cell.fg, bg: cell.bg, a: cell.a || 0 }; }
      text += cell.c || ' ';
      if (cell.w === 2) x++;
    }
    flush();
    return out;
  }

  function maxScrollOffset(view) {
    return Math.max(0, view.vt.lines.length - view.vt.rows);
  }

  function render(view, force) {
    var vt = view.vt;
    var rowsN = vt.rows, cols = vt.cols;
    var total = vt.lines.length;
    var maxOff = maxScrollOffset(view);
    if (view.scrollOffset > maxOff) view.scrollOffset = maxOff;
    var off = view.scrollOffset;
    var first = total - rowsN - off;
    var cellH = view.cellH || 18;
    var els = view.rowEls;
    var i, abs, row, el;
    for (i = 0; i < rowsN; i++) {
      abs = first + i;
      el = els[i];
      if (!el) { el = document.createElement('div'); el.className = 'ct-row'; view.rowsEl.appendChild(el); els[i] = el; }
      row = vt.lines[abs];
      if (force || el.__abs !== abs || el.__v !== (row ? row.v : -1) || view.lastCols !== cols) {
        el.__abs = abs;
        el.__v = row ? row.v : -1;
        el.innerHTML = row ? rowHtml(row, cols) : '';
      }
    }
    for (i = rowsN; i < els.length; i++) if (els[i]) { els[i].remove(); els[i] = null; }
    els.length = Math.max(rowsN, 0);
    view.lastCols = cols;
    var padTop = off * cellH;
    var padBot = Math.max(0, (total - rowsN - off)) * cellH;
    view.rowsEl.style.paddingTop = padTop + 'px';
    view.rowsEl.style.paddingBottom = padBot + 'px';
    // 光标
    var cy = vt.y, cx = vt.x;
    // 回看时窗口上移，光标只在自己的那屏可见时显示
    var visible = (cy <= rowsN - 1 - off);
    var cur = view.cursorEl;
    if (!vt.cursorVisible || !visible) { cur.className = 'ct-cursor off'; }
    else {
      cur.className = 'ct-cursor blink' + (vt.cursorShape === 'underline' ? ' underline' : (vt.cursorShape === 'bar' ? ' bar' : ''));
      cur.style.left = (cx * (view.cellW || 7)) + 'px';
      cur.style.top = (padTop + cy * cellH) + 'px';
      // 光标格有字符时按反显画进光标（CSS 已给 .ct-cursor 前景/背景互换）
      var under = vt.cell(cx, cy);
      var underCh = (under && under.w !== -1 && under.c) ? under.c : '';
      if (cur.textContent !== underCh) cur.textContent = underCh;
    }
    var want = maxOff > 0 ? (maxOff - off) * cellH : 0;
    if (Math.abs(view.screenEl.scrollTop - want) > 1) {
      view.silentScroll = true;
      view.screenEl.scrollTop = want;
    }
    view.renderedOffset = off;
  }

  function schedule(view, force) {
    if (force) view.forceRender = true;
    // 已 detach 的 view（后台页签）继续解析输出，但不画：挂回来时 attach()
    // 用 schedule(view, true) 整屏重绘一次。
    if (view.hidden) return;
    if (view.raf) return;
    view.raf = window.requestAnimationFrame(function () {
      view.raf = 0;
      var f = view.forceRender; view.forceRender = false;
      try { render(view, f); } catch (e) { if (window.console) console.error('[term] render', e); }
    });
  }

  /* ---------- 4. 后端会话 ---------- */
  function sendBytes(view, bytes) {
    if (!bytes || !bytes.length) return;
    if (view.demo) { if (view.shell) view.shell.input(bytes); return; }
    if (!view.id || view.alive === false) return;
    var payload = { ws: view.ws, id: view.id, data: b64FromBytes(bytes) };
    api('term.input', payload).catch(function () {});
  }
  function sendText(view, text) {
    try { sendBytes(view, new TextEncoder().encode(String(text))); } catch (e) {}
  }
  function feedBytes(view, bytes) {
    if (!bytes || !bytes.length) return;
    var s = view.decoder.decode(bytes, { stream: true });
    if (!s) return;
    view.vt.write(s);
    if (view.scrollOffset === 0) schedule(view); else schedule(view);
  }
  function feedString(view, s) {
    if (!s) return;
    view.vt.write(s);
    schedule(view);
  }

  // term.open 的响应回来之前，SSE 上属于这个会话的事件会被暂存下来：
  // 响应里的 backlog 覆盖到 seq，暂存里 seq 更大的部分才是新增量（避免丢输出
  // 又避免与 backlog 重复）。
  var pending = {};
  function stashPending(e) {
    var p = pending[e.id] || (pending[e.id] = { bytes: 0, evs: [] });
    p.evs.push({ t: e.t, seq: e.seq == null ? null : e.seq, d: e.d, code: e.code, error: e.error });
    if (e.d) p.bytes += e.d.length;
    while (p.bytes > 512 * 1024 && p.evs.length > 1) {
      var drop = p.evs.shift();
      if (drop && drop.d) p.bytes -= drop.d.length;
    }
    var ids = Object.keys(pending);
    if (ids.length > 8) delete pending[ids[0]];
  }
  function drainPending(view) {
    var p = pending[view.id];
    if (!p) return;
    delete pending[view.id];
    p.evs.forEach(function (ev) {
      if (ev.seq != null && view.lastSeq != null && ev.seq <= view.lastSeq) return;
      if (ev.t === 'term.out') {
        if (ev.seq != null) view.lastSeq = ev.seq;
        feedBytes(view, b64ToBytes(ev.d));
      } else if (ev.t === 'term.exit') applyExit(view, ev);
      else if (ev.t === 'term.error') applyError(view, ev);
    });
  }
  function applyExit(view, e) {
    view.alive = false;
    view.vt.write('\r\n\u001b[90m[进程已退出，exit ' + (e.code == null ? '?' : e.code) + ']\u001b[0m\r\n');
    notify(view, { kind: 'exited', text: '已退出', code: e.code });
    setStatusBar(view, 'shell 已退出（exit ' + (e.code == null ? '?' : e.code) + '）—— 点“重试”重启', false);
    schedule(view);
  }
  function applyError(view, e) {
    notify(view, { kind: 'error', text: e.error || '终端错误' });
    setStatusBar(view, '终端错误：' + (e.error || ''), true);
  }

  function openSession(view) {
    notify(view, { kind: 'connecting', text: '正在连接终端…' });
    setStatusBar(view, '正在连接终端…', false);
    var geo = geometry(view);
    view.cols = geo.cols; view.rows = geo.rows;
    view.vt.resize(geo.cols, geo.rows);
    var payload = { ws: view.ws, cwd: view.cwd, cols: geo.cols, rows: geo.rows };
    if (view.attachId) payload.id = view.attachId;         // 接管已有会话（刷新 / 切页签）
    else payload.new = true;                               // 每次新建都是独立 shell
    if (view.wantName) payload.name = view.wantName;
    api('term.open', payload)
      .then(function (res) {
        if (!view.removed && view.root) {
          if (!res || res.ok === false) {
            notify(view, { kind: 'error', text: (res && res.error) || '终端不可用' });
            setStatusBar(view, '终端不可用：' + ((res && res.error) || '未知错误') + '（点“重试”）', true);
            return;
          }
          view.id = res.id;
          view.attachId = null;
          view.shellPath = res.shell || '';
          view.name = res.name || view.wantName || '';
          view.alive = res.alive !== false;
          view.pid = res.pid;
          view.lastSeq = res.seq == null ? 0 : Number(res.seq) || 0;
          views[res.id] = view;
          if (res.backlog) feedBytes(view, b64ToBytes(res.backlog));
          drainPending(view);
          notify(view, { kind: res.alive === false ? 'exited' : 'ready', text: res.alive === false ? '已退出' : '就绪', name: view.name, id: view.id });
          setStatusBar(view, '', false);
          schedule(view, true);
        }
      })
      .catch(function (e) {
        notify(view, { kind: 'error', text: String((e && e.message) || e) });
        setStatusBar(view, '终端连接失败：' + String((e && e.message) || e) + '（点“重试”）', true);
      });
  }

  function applyResize(view) {
    if (view.hidden) return; // detach 的后台页签：等 attach 时再对齐
    if (!laidOut(view)) return; // 收起 / 重建动画中：先不缩 VT，等 refit / RO 下一次
    var geo = geometry(view);
    if (geo.pending) return;
    view.lastW = view.screenEl.clientWidth;
    view.lastH = view.screenEl.clientHeight;
    if (geo.cols === view.vt.cols && geo.rows === view.vt.rows) return;
    view.vt.resize(geo.cols, geo.rows);
    view.cols = geo.cols; view.rows = geo.rows;
    schedule(view, true);
    if (view.demo || !view.id || view.alive === false) return;
    api('term.resize', { ws: view.ws, id: view.id, cols: geo.cols, rows: geo.rows }).catch(function () {});
  }

  function observe(view) {
    if (typeof ResizeObserver !== 'undefined') {
      view.ro = new ResizeObserver(function () {
        // RO 回调里同步改布局会触发 Chrome 的 "ResizeObserver loop completed
        // with undelivered notifications"，所以延到下一帧再处理
        if (view.roT) clearTimeout(view.roT);
        view.roT = setTimeout(function () {
          view.roT = 0;
          window.requestAnimationFrame(function () { applyResize(view); });
        }, 120);
      });
      try { view.ro.observe(view.root); } catch (e) {}
    }
    view.screenEl.addEventListener('scroll', function () {
      if (view.silentScroll) { view.silentScroll = false; return; }
      var maxOff = maxScrollOffset(view);
      var cellH = view.cellH || 18;
      var off = Math.round((maxOff * cellH - view.screenEl.scrollTop) / cellH);
      off = clamp(off, 0, maxOff);
      if (off !== view.scrollOffset) { view.scrollOffset = off; schedule(view, true); }
    });
  }

  /* ---------- 5. 键盘 / 输入 ---------- */
  var KEYS = {
    Enter: '\r', Backspace: '\u007f', Tab: '\t', Escape: '\u001b',
    ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D',
    Home: 'H', End: 'F',
  };
  var FKEYS = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
  var FKEYS_CSI = { F5: '15', F6: '17', F7: '18', F8: '19', F9: '20', F10: '21', F11: '23', F12: '24' };

  function keyToSeq(view, ev) {
    var k = ev.key;
    var app = view.vt.appCursor;
    if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (k.length === 1) {
        var c = k.toLowerCase();
        if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
        if (k === '[') return '\u001b';
        if (k === ']') return '\u001d';
        if (k === '\\') return '\u001c';
        if (k === ' ') return '\u0000';
        if (k === '^') return '\u001e';
        if (k === '_') return '\u001f';
      }
      return null;
    }
    if (KEYS[k]) {
      var code = KEYS[k];
      if (code.length === 1 && code >= 'A' && code <= 'H') return app ? '\u001bO' + code : '\u001b[' + code;
      return code;
    }
    if (k === 'PageUp') return '\u001b[5~';
    if (k === 'PageDown') return '\u001b[6~';
    if (k === 'Insert') return '\u001b[2~';
    if (k === 'Delete') return '\u001b[3~';
    if (FKEYS[k]) return '\u001bO' + FKEYS[k];
    if (FKEYS_CSI[k]) return '\u001b[' + FKEYS_CSI[k] + '~';
    if (ev.altKey && k.length === 1) return '\u001b' + k;
    if (k.length === 1) return k;
    return null;
  }

  function wireInput(view) {
    var root = view.root, ime = view.imeEl;
    function focusIme() {
      try { ime.focus({ preventScroll: true }); } catch (e) { try { ime.focus(); } catch (e2) {} }
    }
    // mousedown 的默认动作会把焦点交给 .ct-root（tabindex=-1）或 body，所以
    // 焦点在 mouseup 时接管：用户拖选文本时不抢焦点，普通点击才聚焦输入区。
    root.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.ct-retry')) return;
      view.pendingFocus = true;
    });
    root.addEventListener('mouseup', function () {
      if (!view.pendingFocus) return;
      view.pendingFocus = false;
      var sel = '';
      try { sel = String(window.getSelection ? window.getSelection() : ''); } catch (e) {}
      if (sel) return; // 正在选择文本：保留选区
      focusIme();
    });
    root.addEventListener('focus', focusIme); // 键盘 Tab 到根节点时转移焦点
    ime.addEventListener('focus', function () { root.classList.add('focused'); });
    ime.addEventListener('blur', function () {
      root.classList.remove('focused');
      // 被面板重建摘出文档导致的 blur 记为"想保持焦点"，重新挂载后由
      // CellTerm.refit -> restoreFocus 抢回；用户点别处（节点还连着）则清掉。
      // detach() 的后台页签（切到别的终端）不算：不要抢用户刚给的焦点。
      if (view.hidden) { view.wantFocus = false; return; }
      view.wantFocus = !root.isConnected;
    });
    function onKeyDown(ev) {
      if (ev.__ctTermKey) return; // 同一事件从 ime 冒泡到 root 时不重复处理
      ev.__ctTermKey = true;
      if (ev.isComposing || ev.keyCode === 229) return;
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.shiftKey && (ev.key === 'c' || ev.key === 'C')) {
        ev.preventDefault();
        CellTerm.copySelection(view);
        return;
      }
      if (mod && ev.shiftKey && (ev.key === 'v' || ev.key === 'V')) {
        ev.preventDefault();
        clipRead().then(function (t) { if (t) CellTerm.pasteText(view, t); });
        return;
      }
      if (ev.shiftKey && ev.key === 'PageUp') { ev.preventDefault(); CellTerm.scrollBy(view, view.vt.rows - 2); return; }
      if (ev.shiftKey && ev.key === 'PageDown') { ev.preventDefault(); CellTerm.scrollBy(view, -(view.vt.rows - 2)); return; }
      if (ev.shiftKey && ev.key === 'Home') { ev.preventDefault(); CellTerm.scrollBy(view, 1e9); return; }
      if (ev.shiftKey && ev.key === 'End') { ev.preventDefault(); CellTerm.scrollBy(view, -1e9); return; }
      if (mod && !ev.shiftKey && (ev.key === 'v' || ev.key === 'V')) return; // 让浏览器粘贴
      var seq = keyToSeq(view, ev);
      if (seq == null) return;
      ev.preventDefault();
      if (view.scrollOffset > 0 && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'PageUp' || ev.key === 'PageDown')) {
        CellTerm.scrollBy(view, ev.key === 'ArrowUp' || ev.key === 'PageUp' ? 3 : -3);
        return;
      }
      sendText(view, seq);
    }
    ime.addEventListener('keydown', onKeyDown);
    root.addEventListener('keydown', onKeyDown);
    ime.addEventListener('compositionstart', function () { view.composing = true; });
    ime.addEventListener('compositionend', function (ev) {
      view.composing = false;
      var data = ev.data || ime.value || '';
      ime.value = '';
      if (data) sendText(view, data);
    });
    ime.addEventListener('input', function (ev) {
      if (view.composing || ev.isComposing) return;
      var data = ev.data;
      if (data) sendText(view, data);
      ime.value = '';
    });
    ime.addEventListener('paste', function (ev) {
      var t = ev.clipboardData ? ev.clipboardData.getData('text') : '';
      if (!t) return;
      ev.preventDefault();
      CellTerm.pasteText(view, t);
    });
  }

  function clipRead() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText();
    } catch (e) {}
    return Promise.resolve('');
  }
  function clipWrite(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return Promise.resolve(!!ok);
    } catch (e2) { return Promise.resolve(false); }
  }

  /* ---------- 6. 演示模式假 shell ---------- */
  var DEMO_COMMANDS = ['help', 'ls', 'dir', 'pwd', 'cd', 'echo', 'type', 'date', 'clear', 'color', 'true', 'false'];
  // 演示模式没有真实文件系统，但补全链路要能像 cmd 一样工作（验收用
  // "type tabe" + Tab -> tabetest.txt）：给假 shell 一份虚拟文件表。
  var DEMO_FILES = ['tabetest.txt', 'README.md', 'CMakeLists.txt', 'build_ui.py', 'src', 'docs'];
  var DEMO_FILE_CONTENT = { 'tabetest.txt': 'CELL_TERM_TAB_OK' };
  function DemoShell(view) {
    this.view = view;
    this.cwd = view.cwd || 'D:\\demo';
    this.line = '';
    this.pos = 0;
    this.hist = [];
    this.hi = -1;
    this.vt = view.vt;
  }
  DemoShell.prototype.start = function () {
    this.vt.write('\u001b[90mcell demo shell\u001b[0m — 输入 \u001b[36mhelp\u001b[0m 查看命令，Tab 补全，↑↓ 历史\r\n');
    this.prompt();
  };
  DemoShell.prototype.prompt = function () {
    this.vt.write('\u001b[32m' + this.cwd + '\u001b[0m> ');
  };
  DemoShell.prototype.redraw = function () {
    var v = this.vt;
    v.write('\r\u001b[32m' + this.cwd + '\u001b[0m> ' + this.line + '\u001b[K');
    var back = this.line.length - this.pos;
    if (back > 0) v.write('\u001b[' + back + 'D');
  };
  DemoShell.prototype.input = function (bytes) {
    var s = '';
    try { s = new TextDecoder('utf-8').decode(bytes); } catch (e) { return; }
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '\u001b' && s.charAt(i + 1) === '[') {
        var f = s.charAt(i + 2);
        if (f === 'A') this.histPrev(); else if (f === 'B') this.histNext();
        else if (f === 'C') { if (this.pos < this.line.length) { this.pos++; this.redraw(); } }
        else if (f === 'D') { if (this.pos > 0) { this.pos--; this.redraw(); } }
        i += 3;
        continue;
      }
      i++;
      if (ch === '\r' || ch === '\n') { this.vt.write('\r\n'); this.run(); continue; }
      if (ch === '\u007f' || ch === '\b') {
        if (this.pos > 0) { this.line = this.line.slice(0, this.pos - 1) + this.line.slice(this.pos); this.pos--; this.redraw(); }
        continue;
      }
      if (ch === '\t') { this.complete(); continue; }
      if (ch === '\u0003') { this.vt.write('^C\r\n'); this.line = ''; this.pos = 0; this.prompt(); continue; }
      if (ch === '\u000c') { this.vt.write('\u001b[2J\u001b[H'); this.redraw(); continue; }
      if (ch < ' ') continue;
      this.line = this.line.slice(0, this.pos) + ch + this.line.slice(this.pos);
      this.pos++;
      this.redraw();
    }
  };
  DemoShell.prototype.histPrev = function () {
    if (!this.hist.length) return;
    this.hi = Math.min(this.hi + 1, this.hist.length - 1);
    this.line = this.hist[this.hist.length - 1 - this.hi];
    this.pos = this.line.length;
    this.redraw();
  };
  DemoShell.prototype.histNext = function () {
    this.hi = Math.max(this.hi - 1, -1);
    this.line = this.hi < 0 ? '' : this.hist[this.hist.length - 1 - this.hi];
    this.pos = this.line.length;
    this.redraw();
  };
  DemoShell.prototype.complete = function () {
    var head = this.line.slice(0, this.pos);
    var parts = head.split(/\s+/);
    var frag = parts.length ? parts[parts.length - 1] : '';
    // 命令位补命令名；已经敲过空格（参数位）补演示文件名，和 cmd 的
    // "type tabe"+Tab -> tabetest.txt 行为对齐
    var pool = /\s/.test(head) ? DEMO_FILES : DEMO_COMMANDS;
    if (!frag) return;
    var cands = pool.filter(function (c) { return c.indexOf(frag) === 0; });
    if (cands.length === 1) {
      var add = cands[0].slice(frag.length);
      this.line = this.line.slice(0, this.pos) + add + this.line.slice(this.pos);
      this.pos += add.length;
      this.redraw();
    } else if (cands.length > 1) {
      this.vt.write('\r\n' + cands.join('   ') + '\r\n');
      this.redraw();
    }
  };
  DemoShell.prototype.run = function () {
    var cmd = this.line.trim();
    var self = this;
    this.line = ''; this.pos = 0; this.hi = -1;
    if (!cmd) { this.prompt(); return; }
    this.hist.push(cmd);
    var argv = cmd.split(/\s+/);
    var name = argv[0].toLowerCase();
    var out = '';
    if (name === 'help') out = '可用命令：' + DEMO_COMMANDS.join(', ') + '\r\n（演示模式没有真实后端：真实 shell 由 term.open 启动）';
    else if (name === 'ls' || name === 'dir') out = 'src/   docs/   README.md   build_ui.py   CMakeLists.txt';
    else if (name === 'pwd') out = this.cwd;
    else if (name === 'cd') { if (argv[1]) this.cwd = argv[1]; out = ''; }
    else if (name === 'echo') out = argv.slice(1).join(' ');
    else if (name === 'type') {
      var fp = argv[1] || '';
      if (Object.prototype.hasOwnProperty.call(DEMO_FILE_CONTENT, fp)) out = DEMO_FILE_CONTENT[fp];
      else if (DEMO_FILES.indexOf(fp) >= 0) out = '（演示文件：' + this.cwd + '\\' + fp + '）';
      else out = '找不到文件 - ' + (fp || '');
    }
    else if (name === 'date') out = new Date().toString();
    else if (name === 'true') out = '';
    else if (name === 'false') out = '（false：退出码 1，演示模式不做进程）';
    else if (name === 'color') out = '\u001b[31mred\u001b[0m \u001b[32mgreen\u001b[0m \u001b[34mblue\u001b[0m \u001b[1;33mbold-yellow\u001b[0m \u001b[38;5;208m256-color\u001b[0m \u001b[48;5;24m bg \u001b[0m';
    else if (name === 'clear') { this.vt.write('\u001b[2J\u001b[H'); this.prompt(); return; }
    else out = 'command not found: ' + argv[0];
    var delay = out ? 90 + Math.random() * 180 : 40;
    setTimeout(function () {
      if (out) self.vt.write(out + '\r\n');
      self.prompt();
      schedule(self.view);
    }, delay);
  };

  function refitNow(view) {
    if (!view || view.removed || !view.root || !laidOut(view)) return;
    var w = view.screenEl.clientWidth, h = view.screenEl.clientHeight;
    if (!view.cellW || w !== view.lastW || h !== view.lastH) {
      measure(view);
      applyResize(view);
    }
    schedule(view, true);
    restoreFocus(view);
  }

  /* ---------- 7. 对外 API ---------- */
  function startView(view) {
    if (!view || view.removed || view.started) return;
    view.started = true;
    if (view.demo) {
      view.shell = new DemoShell(view);
      view.shell.start();
      notify(view, { kind: 'demo', text: '演示模式' });
      setStatusBar(view, '', false);
      schedule(view, true);
    } else {
      schedule(view, true);
      openSession(view);
    }
  }

  function mount(rootEl, opts) {
    opts = opts || {};
    var view = {
      ws: opts.ws || '', cwd: opts.cwd || '', demo: isDemo(),
      id: null, alive: true, removed: false, scrollOffset: 0, onStatus: opts.onStatus,
      decoder: new TextDecoder('utf-8'), status: null, started: false,
      wantFocus: false, cellW: 0, cellH: 0, lastW: 0, lastH: 0,
      stableRaf: 0, refitRaf: 0, hidden: false,
      // attachId: 接管一个已在运行的会话（刷新后的重启 / 面板重挂）；
      // wantName: 交给后端做显示名（默认取 shell 文件名）
      attachId: opts.id ? String(opts.id) : null, wantName: opts.name ? String(opts.name) : '',
      name: '', shellPath: '', pid: 0,
    };
    buildDom(view, rootEl);
    view.vt = new Vt(80, 24);
    view.vt.onResponse = function (s) { sendText(view, s); };
    observe(view);
    wireInput(view);
    mounted.push(view);
    // 先等面板有真实（稳定）宽度再测量、再写第一帧提示符 / 调 term.open：
    // 挂载时 dock 可能正在 0 -> 目标宽度的过渡动画中，此刻量到的宽度会让
    // 首屏提示符按动画宽度硬折行且永不回流。
    whenStable(view, function () {
      if (view.removed) return;
      sizeToView(view);
      startView(view);
    });
    return view;
  }

  var CellTerm = {
    mount: mount,
    unmount: function (view) {
      if (!view) return;
      view.removed = true;
      if (view.ro) { try { view.ro.disconnect(); } catch (e) {} }
      if (view.raf) { try { cancelAnimationFrame(view.raf); } catch (e) {} view.raf = 0; }
      if (view.stableRaf) { try { cancelAnimationFrame(view.stableRaf); } catch (e) {} view.stableRaf = 0; }
      if (view.refitRaf) { try { cancelAnimationFrame(view.refitRaf); } catch (e) {} view.refitRaf = 0; }
      if (view.id) delete views[view.id];
      var i = mounted.indexOf(view);
      if (i >= 0) mounted.splice(i, 1);
    },
    refit: function (view) {
      if (!view) return;
      if (view.hidden) return; // detach 的页签不测量（不在文档里，量到 0）
      view.removed = false;
      if (!view.started) return; // 首次测量 / 启动由 mount 的 whenStable 负责
      if (!view.root || !view.root.isConnected) return; // 已脱离：等面板重新挂载时再 refit
      if (view.refitRaf) { try { cancelAnimationFrame(view.refitRaf); } catch (e) {} view.refitRaf = 0; }
      var w0 = 0;
      try { w0 = view.screenEl.clientWidth; } catch (e) {}
      if (w0 > 0 && w0 === view.lastW && view.cellW) {
        // 尺寸没变（面板原地重绘）：只补一帧重绘 / 焦点恢复，避免每次 repaint
        // 都插探针强制布局
        view.refitRaf = requestAnimationFrame(function () {
          view.refitRaf = 0;
          refitNow(view);
        });
        return;
      }
      // 换过容器 / 刚重新挂载 / 窗口尺寸变化：等宽度稳定再测量
      whenStable(view, function () { refitNow(view); });
    },
    // 多终端切换：把 view 的 DOM 挂进新容器并恢复渲染（不重放 backlog，
    // VT 历史一直在内存里，挂回来整屏重绘一次即可）。
    attach: function (view, hostEl) {
      if (!view || !view.root) return view;
      if (hostEl && view.root.parentNode !== hostEl) hostEl.appendChild(view.root);
      view.hidden = false;
      view.removed = false;
      if (view.root && view.root.isConnected) {
        schedule(view, true);
        CellTerm.refit(view);
      }
      return view;
    },
    // 切走时只摘 DOM：会话（后端 shell + 读线程）照常跑，输出继续写进 VT。
    detach: function (view) {
      if (!view) return;
      view.hidden = true;
      view.wantFocus = false;
      if (view.raf) { try { cancelAnimationFrame(view.raf); } catch (e) {} view.raf = 0; }
      if (view.ro && view.roT) { clearTimeout(view.roT); view.roT = 0; }
      try { if (view.root && view.root.parentNode) view.root.parentNode.removeChild(view.root); } catch (e) {}
    },
    // 终止会话：关掉后端 shell（读线程随 join 退出）并卸载视图。
    close: function (view) {
      if (!view) return Promise.resolve(false);
      var id = view.id, ws = view.ws, demo = view.demo;
      view.hidden = false;
      view.wantFocus = false;
      view.alive = false;
      var p = (demo || !id) ? Promise.resolve(true)
        : api('term.close', { ws: ws, id: id }).then(function () { return true; }, function () { return false; });
      CellTerm.unmount(view);
      if (id) delete views[id];
      view.id = null;
      return p;
    },
    restart: function (view) {
      if (!view) return Promise.resolve(false);
      var old = view.id;
      view.id = null;
      // the server announces the old session's term.exit; this view is the one
      // that asked for the restart, so it must not draw that notice into the
      // freshly reset screen (other tabs attached to it still show it)
      view.closingId = old || null;
      view.vt.reset();
      view.scrollOffset = 0;
      schedule(view, true);
      if (view.demo) { view.shell = new DemoShell(view); view.shell.start(); notify(view, { kind: 'demo', text: '演示模式' }); return Promise.resolve(true); }
      var closeP = old ? api('term.close', { ws: view.ws, id: old }).catch(function () {}) : Promise.resolve();
      return closeP.then(function () {
        if (old) delete views[old];
        if (view.closingId === old) view.closingId = null;
        openSession(view);
        return true;
      });
    },
    clearBuffer: function (view) {
      if (!view) return;
      view.vt.reset();
      view.scrollOffset = 0;
      if (view.demo && view.shell) view.shell.prompt();
      schedule(view, true);
    },
    focus: function (view) { if (view && view.imeEl) { try { view.imeEl.focus({ preventScroll: true }); } catch (e) {} } },
    scrollBy: function (view, delta) {
      if (!view) return;
      var maxOff = maxScrollOffset(view);
      view.scrollOffset = clamp(view.scrollOffset + delta, 0, maxOff);
      schedule(view, true);
    },
    copySelection: function (view) {
      var sel = '';
      try { sel = String(window.getSelection ? window.getSelection().toString() : ''); } catch (e) {}
      if (!sel) return Promise.resolve(false);
      return clipWrite(sel);
    },
    pasteText: function (view, text) {
      if (!view || !text) return;
      var t = String(text);
      if (view.vt.bracketedPaste) t = '\u001b[200~' + t + '\u001b[201~';
      sendText(view, t);
    },
    onEvent: function (e) {
      if (!e || !e.t) return false;
      if (e.t === 'term.out') {
        var v = views[e.id];
        if (!v) { if (e.id) stashPending(e); return true; }
        if (v.removed) return true;
        if (e.seq != null && v.lastSeq != null && e.seq <= v.lastSeq) return true; // 已由 backlog 覆盖
        if (e.seq != null) v.lastSeq = e.seq;
        feedBytes(v, b64ToBytes(e.d));
        return true;
      }
      if (e.t === 'term.exit') {
        var v2 = views[e.id];
        if (!v2) { if (e.id) stashPending(e); return true; }
        if (v2.closingId && v2.closingId === e.id) { v2.closingId = null; return true; }
        applyExit(v2, e);
        return true;
      }
      if (e.t === 'term.error') {
        var v3 = views[e.id];
        if (!v3) { if (e.id) stashPending(e); return true; }
        applyError(v3, e);
        return true;
      }
      return false;
    },
    debug: function (view) {
      if (!view) {
        var it = mounted.filter(function (v) { return !v.removed && !v.hidden; });
        if (!it.length) it = mounted.filter(function (v) { return !v.removed; });
        view = it.length ? it[it.length - 1] : null;
      }
      if (!view) return { ok: false, error: 'no mounted terminal' };
      var vt = view.vt;
      return {
        ok: true, demo: !!view.demo, sessionId: view.id, alive: view.alive !== false,
        cols: vt.cols, rows: vt.rows,
        cursor: { x: vt.x, y: vt.y, visible: !!vt.cursorVisible },
        mode: { appCursor: !!vt.appCursor, bracketedPaste: !!vt.bracketedPaste, alt: !!vt.alt },
        lineCount: vt.lines.length, scrollbackTop: maxScrollOffset(view),
        screenText: vt.screenText(true),
      };
    },
    _views: views,
    _Vt: Vt, // 供验证脚本直接做 VT 解析/屏幕模型的单元断言
  };

  window.CellTerm = CellTerm;

  // 窗口尺寸变化：所有挂载中的终端重新测量（去抖）
  var winT = 0;
  window.addEventListener('resize', function () {
    if (winT) clearTimeout(winT);
    winT = setTimeout(function () {
      winT = 0;
      mounted.forEach(function (v) { if (!v.removed && !v.hidden && v.root) CellTerm.refit(v); });
    }, 180);
  });
})();