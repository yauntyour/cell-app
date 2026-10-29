/* =====================================================================
   02b · 文本测量（Pretext 式：不碰 DOM 算高度）
   ---------------------------------------------------------------------
   窗口化的前提是「还没挂到 DOM 上的消息也有个高度」。以前只有两个办法：
   getBoundingClientRect（强制布局，正是要避免的事）或硬编码常量。
   这里走第三条：用 canvas 量一次字宽、之后纯算术折行——测一次、永远算。

     TxMeasure.width(tok)        单 token 宽度（按 font 缓存）
     TxMeasure.lines(text, w)    折行行数（CJK 逐字断行，西文按空格断词）
     TxMeasure.blockHeight(...)  段落 / 代码围栏分开算，累计块高

   只引用本身，不依赖别的层；估算误差靠「挂载后量真值回填」收敛。
   ===================================================================== */
'use strict';

const TxMeasure = {
  _cv: null,
  _ctx: null,
  _font: '',
  _w: new Map(), // token → 宽度（当前字体）

  _ready() {
    if (!this._ctx) {
      try {
        this._cv = document.createElement('canvas');
        this._ctx = this._cv.getContext('2d');
      } catch (e) { this._ctx = null; }
    }
    return !!this._ctx;
  },
  setFont(font) {
    if (this._font === font) return;
    this._font = font;
    this._w.clear();
    if (this._ready()) this._ctx.font = font;
  },
  width(tok) {
    if (!this._ready()) return tok.length * 8; // 极端兜底：等宽近似
    let w = this._w.get(tok);
    if (w != null) return w;
    w = this._ctx.measureText(tok).width;
    if (this._w.size > 20000) this._w.clear(); // 别让缓存无限涨
    this._w.set(tok, w);
    return w;
  },
  /* 一段文字折行后的行数。
     一次 measureText 量整段宽度，再按最大行宽取整——中文可任意断行，
     误差 <1 行；西文按词断行会浪费行尾，估算阶段这点误差被「挂载后回填
     实测高度」吸收掉。逐字分词能更准，但 3M 字符要跑 90ms，不值。 */
  lines(text, maxWidth) {
    const s = String(text == null ? '' : text);
    if (!s) return 1;
    if (!(maxWidth > 0)) maxWidth = 600;
    this.setFont(this._font || '14.5px sans-serif');
    const w = this.width(s);
    if (w <= maxWidth) return 1;
    return Math.ceil(w / maxWidth);
  },
  /* 一段 markdown 的高度：代码围栏单独按等宽行算，其余按段落折行 */
  blockHeight(text, maxWidth, o) {
    const lh = o.lineHeight, paraGap = o.paraGap == null ? 12 : o.paraGap;
    const s = String(text == null ? '' : text);
    if (!s) return 0;
    this.setFont(o.font);
    let h = 0, paras = 0;
    const fence = /^\s*```/;
    for (const part of s.split(/(^```[\s\S]*?^```)/m)) {
      if (part === '') continue;
      if (fence.test(part)) {
        const codeLines = part.split('\n').length + 1;
        h += codeLines * (o.codeLineHeight || lh) + 40;
        continue;
      }
      for (const para of part.split(/\n{2,}/)) {
        const p = para.trim();
        if (!p) continue;
        paras++;
        h += this.lines(p.replace(/\n/g, ' '), maxWidth) * lh;
      }
    }
    return h + Math.max(0, paras - 1) * paraGap;
  },
};

/* ---- 各角色在消息流里的排版参数（对照 05-stream.css） --------------- */
const FLOW_GAP = { // margin-top
  user: 20, assistant: 26, thinkgrp: 18, toolgroup: 18, round: 14, status: 24,
  error: 18, notice: 16, cardmsg: 20, summary: 20, sys: 20, toolres: 16,
  reason: 16, thinking: 22, approval: 18, turnmeta: 16, twtool: 18, pad: 0,
  __grpthink__: 18, __grptools__: 18, __turnmeta__: 16, __thinking__: 22, __approval__: 18,
};
const FLOW_TEXT = {
  assistant: { font: '14.5px "Segoe UI", "Microsoft YaHei", sans-serif', lineHeight: 25.4, paraGap: 12 },
  user: { font: '14px "Segoe UI", "Microsoft YaHei", sans-serif', lineHeight: 23.8, paraGap: 8 },
  think: { font: '13px "Segoe UI", "Microsoft YaHei", sans-serif', lineHeight: 22.1, paraGap: 12 },
  summary: { font: '13px "Segoe UI", "Microsoft YaHei", sans-serif', lineHeight: 22.1, paraGap: 8 },
};

/* 未挂载消息的高度估算（含 margin-top，和实测口径一致） */
function estimateFlowItem(m, textW) {
  const gap = FLOW_GAP[m.role] == null ? 18 : FLOW_GAP[m.role];
  let h = 0;
  if (m.role === 'user') {
    h = 20 + TxMeasure.blockHeight(m.text, Math.max(120, textW * 0.78), FLOW_TEXT.user);
  } else if (m.role === 'assistant') {
    h = TxMeasure.blockHeight(m.text, Math.max(120, textW - 34), FLOW_TEXT.assistant);
  } else if (m.role === 'summary' || m.role === 'sys') {
    h = TxMeasure.blockHeight(m.text, Math.max(120, textW - 40), FLOW_TEXT.summary) + 44;
  } else if (m.role === '__grpthink__') {
    h = 30; // 收起状态就是一行
  } else if (m.role === '__grptools__') {
    let n = 0, r = 0;
    for (const it of (m.items || [])) { if (it.role === 'round') r++; else n++; }
    h = 36 + n * 33 + r * 28;
  } else if (m.role === 'tool') {
    h = 33;
  } else if (m.role === 'status') {
    h = 18;
  } else if (m.role === '__thinking__') {
    h = 26;
  } else if (m.role === '__turnmeta__') {
    h = 96;
  } else if (m.role === 'notice') {
    h = 92;
  } else if (m.role === 'toolres' || m.role === 'reason') {
    h = 34;
  } else if (m.role === 'round') {
    h = 26;
  } else {
    h = 40;
  }
  return { h: Math.max(12, h), gap: gap, pitch: gap + Math.max(12, h) };
}
