/* =====================================================================
   01 · Markdown 渲染（输出与 cell.cpp /export 相同的 prose 结构）

   导出页的正文是一篇文档：段落 / 标题 / 列表 / 引用 / 分割线 / 代码块 /
   表格，全部带 .md-* 类名（见 05-stream.css）。这里用同一套类名渲染聊天
   正文，保证「界面里的会话」和「导出的会话」长得一样。

   安全性：所有输入先整体转义，只有解析器自己产出的标签会进入 DOM；链接
   只放行 http/https/mailto 与相对路径。
   ===================================================================== */
'use strict';

// 行内强调 / 代码 / 链接。输入应为未转义原文（内部会先转义）
function mdInline(src) {
  let h = esc(src == null ? '' : src);
  // 行内代码先抽出来，避免其中的 * _ [ ] 被后续规则误伤
  const codes = [];
  h = h.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  h = h.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  h = h.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const u = String(url);
    if (/^(https?:|mailto:|\/|#|\.{1,2}\/)/i.test(u)) {
      const safe = esc(u).replace(/"/g, '&quot;');
      return '<a href="' + safe + '" target="_blank" rel="noreferrer noopener">' + label + '</a>';
    }
    return label; // 不认识协议：退化成纯文本，绝不拼出危险 href
  });
  // 裸链接（http://…）也做成链接，但先跳过已经在 href 里的内容
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');
  h = h.replace(/\u0000(\d+)\u0000/g, (_m, n) => '<code class="ic mono">' + codes[Number(n)] + '</code>');
  return h;
}

function isBlank(l) { return /^\s*$/.test(l); }
function isTableSep(l) { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0; }
function listMark(l) {
  const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  return m ? { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] } : null;
}
function isHr(l) { return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l) && /^[\s\-*_]+$/.test(l); }

// 表格：表头 + 分隔行 + 若干数据行
function parseTable(lines, i) {
  const cells = l => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  };
  const head = cells(lines[i]);
  i += 2; // 跳过分隔行
  const rows = [];
  while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) {
    rows.push(cells(lines[i]));
    i++;
  }
  let h = '<div class="tabwrap"><table class="md-tab"><thead><tr>';
  for (const c of head) h += '<th>' + mdInline(c) + '</th>';
  h += '</tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr>';
    for (let k = 0; k < head.length; k++) h += '<td>' + mdInline(r[k] == null ? '' : r[k]) + '</td>';
    h += '</tr>';
  }
  return { html: h + '</tbody></table></div>', next: i };
}

// 列表：按缩进递归，支持有序 / 无序 / 任务清单与嵌套
function parseList(lines, i, baseIndent) {
  const first = listMark(lines[i]);
  if (!first) return { html: '', next: i };
  const ordered = first.ordered;
  const items = [];
  while (i < lines.length) {
    const m = listMark(lines[i]);
    if (!m || m.indent < baseIndent) break;
    if (m.indent > baseIndent) { // 更深的缩进：交给下一层递归
      const sub = parseList(lines, i, m.indent);
      if (!sub.html) break;
      if (items.length) items[items.length - 1].push(sub.html);
      i = sub.next;
      continue;
    }
    if (m.ordered !== ordered && items.length) break; // 类型切换：另起一个列表
    if (m.ordered !== ordered) break;
    items.push([m.text]);
    i++;
    // 续行：缩进更深但不是列表项 / 空行后跟缩进内容
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        const nx = lines[i + 1] || '';
        if (listMark(nx) && listMark(nx).indent >= baseIndent) break;
        if (!/^\s{2,}\S/.test(nx)) break;
        i++;
        continue;
      }
      if (listMark(l) && listMark(l).indent <= baseIndent) break;
      if (isHr(l) || /^\s*#{1,6}\s/.test(l) || /^\s*>/.test(l) || /^\s*```/.test(l)) break;
      items[items.length - 1].push(l.trim());
      i++;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  let h = '<' + tag + ' class="md-list">';
  for (const it of items) {
    const body = renderBlocks(it.join('\n'));
    // 单项内容只有一个段落时去掉 <p>，让列表更紧凑
    h += '<li>' + body.replace(/^<p class="md-p">([\s\S]*?)<\/p>$/, '$1') + '</li>';
  }
  return { html: h + '</' + tag + '>', next: i };
}

// 块级解析：把一段文本变成 HTML（供列表项 / 引用递归调用）
function renderBlocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push('<p class="md-p">' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    // 代码围栏
    const fence = l.match(/^\s*```+\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾围栏
      out.push('<div class="codeblock">' + (lang ? '<span class="lang">' + esc(lang) + '</span>' : '') +
               '<pre class="code">' + esc(buf.join('\n')) + '</pre></div>');
      continue;
    }
    if (isBlank(l)) { flushPara(); i++; continue; }
    if (isHr(l)) { flushPara(); out.push('<div class="md-hr"></div>'); i++; continue; }
    const hd = l.match(/^\s*(#{1,6})\s+(.*)$/);
    if (hd) {
      flushPara();
      const lv = hd[1].length;
      out.push('<h' + lv + ' class="md-h">' + mdInline(hd[2]) + '</h' + lv + '>');
      i++;
      continue;
    }
    if (/^\s*>/.test(l)) { // 引用
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote class="md-q">' + renderBlocks(buf.join('\n')) + '</blockquote>');
      continue;
    }
    if (l.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const t = parseTable(lines, i);
      out.push(t.html);
      i = t.next;
      continue;
    }
    if (listMark(l)) {
      flushPara();
      const r = parseList(lines, i, listMark(l).indent);
      out.push(r.html);
      i = r.next;
      continue;
    }
    para.push(l);
    i++;
  }
  flushPara();
  return out.join('');
}

// 会话正文入口：整段 markdown → HTML 字符串
function renderMarkdown(text) {
  if (text == null || text === '') return '';
  return renderBlocks(text);
}
// 兼容旧名（流式渲染与工具回显仍可能按旧名调用）
function mdLite(text) { return renderMarkdown(text); }

/* =====================================================================
   内容块渲染：与 cell.cpp 的 message_export_html 同一套语义

   一条消息的 content 可以是字符串，也可以是内容块数组（text /
   reasoning / tool_use / tool_result / image）。导出页把每种块渲染成
   对应的 HTML；这里用同一套规则，主会话与子代理浮窗共用同一个入口，
   因此「界面里的会话」和「导出的会话」对同一条消息给出同样的排版。

   工具结果与工具调用一律收进 <details>（默认折叠）——这就是折叠会话里
   工具输出被收纳的地方；思考块同理。
   ===================================================================== */

// 把一个内容块（字符串 / 块数组 / 其它）压成纯文本，用于工具结果卡正文
function blockContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const b of content) {
      if (b == null) continue;
      if (typeof b === 'string') out += b;
      else if (typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') out += b.text;
      else if (typeof b === 'object') out += JSON.stringify(b, null, 1);
      out += '\n';
    }
    return out;
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content, null, 1); } catch (e) { return String(content); }
  }
  return String(content);
}

// 拆开 box::wrap_tool_output 的包裹：<tool_output tool="n" path="p">…</tool_output>
// 不匹配时原样返回为正文，属性留空
function splitToolOutput(content) {
  const s = String(content == null ? '' : content);
  const out = { tool: '', path: '', body: s };
  if (s.slice(0, 12) !== '<tool_output') return out;
  const tagEnd = s.indexOf('>');
  if (tagEnd < 0) return out;
  const close = s.lastIndexOf('</tool_output>');
  if (close < tagEnd) return out;
  const attrs = s.slice(0, tagEnd);
  const attr = key => {
    const p = attrs.indexOf(key + '="');
    if (p < 0) return '';
    const vs = p + key.length + 2;
    const ve = attrs.indexOf('"', vs);
    return ve < 0 ? '' : attrs.slice(vs, ve);
  };
  out.tool = attr('tool');
  out.path = attr('path');
  out.body = s.slice(tagEnd + 1, close);
  // 包裹在开标签后与闭标签前各写了一个换行
  if (out.body.slice(0, 1) === '\n') out.body = out.body.slice(1);
  if (out.body.slice(-1) === '\n') out.body = out.body.slice(0, -1);
  return out;
}

// 一张折叠的工具结果卡：摘要带工具名 / 路径 / 调用 id
function toolResultCard(tool, path, body, callId) {
  let summary = '工具结果';
  if (tool) summary += ': ' + tool;
  if (path) summary += ' | ' + path;
  if (callId) summary += ' [' + callId + ']';
  return '<details class="toolresult"><summary>' + esc(summary) + '</summary>' +
         '<pre class="code">' + esc(body) + '</pre></details>';
}
// 一张折叠的工具调用卡：摘要带工具名，正文是参数
function toolCallCard(name, args) {
  const a = typeof args === 'string' ? args
    : (args == null ? '' : JSON.stringify(args, null, 2));
  return '<details class="toolcall"><summary>工具调用: ' + esc(name || '?') +
         '</summary><pre class="code">' + esc(a) + '</pre></details>';
}

// 一条消息的 content → HTML。role 用于区分「整条就是工具结果」的旧格式，
// callId 供该结果标注调用来源。
function renderContentHtml(content, role, callId) {
  if (content == null) return '';
  if (typeof content === 'string') {
    if (role === 'tool') {
      const t = splitToolOutput(content);
      return toolResultCard(t.tool, t.path, t.body, callId);
    }
    return renderMarkdown(content);
  }
  if (!Array.isArray(content)) return renderMarkdown(blockContentText(content));
  let out = '';
  for (const b of content) {
    if (b == null) continue;
    if (typeof b === 'string') { out += renderMarkdown(b); continue; }
    if (typeof b !== 'object') continue;
    const bt = b.type || '';
    if (bt === 'text' && typeof b.text === 'string') out += renderMarkdown(b.text);
    else if (bt === 'reasoning' || bt === 'thinking') {
      const body = String(b[bt] == null ? '' : b[bt]);
      if (body) out += '<details class="think"><summary>思考</summary><div class="prose">' +
                       esc(body) + '</div></details>';
    }
    else if (bt === 'tool_result') {
      const t = splitToolOutput(blockContentText(b.content != null ? b.content : b.text));
      out += toolResultCard(t.tool, t.path, t.body, b.tool_use_id || '');
    }
    else if (bt === 'tool_use') out += toolCallCard(b.name, b.input);
    else if (bt === 'image' || bt === 'image_url') out += '<div class="prose">[图片]</div>';
    else out += '<pre class="code">' + esc(JSON.stringify(b, null, 2)) + '</pre>';
  }
  return out;
}
