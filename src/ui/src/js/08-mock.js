/* ---------- L. 演示模式（mock 后端） ------------------------------- */
const Mock = {
  A: 'mock0001a', B: 'mock0002b',
  cwdA: 'D:\\Developments\\CXX\\cell-app',
  cwdB: 'D:\\Projects\\demo-site',
  now: () => Math.floor(Date.now() / 1000),
  _seq: 0,
  providers: [
    { name: 'openai', api_style: 'openai-chat', base: 'https://api.openai.com/v1', proxy: '', has_key: true, current: true },
    { name: 'deepseek', api_style: 'openai-chat', base: 'https://api.deepseek.com/v1', proxy: '', has_key: false, current: false },
  ],
  settings: {
    think_level: 2, tools: true, sandbox_mode: 'full-access', autoallow: false,
    compact_auto: true, compact_provider: '', compact_model: '',
    system_prompt: 'You are a helpful assistant.', teamwork_max_children: 5, max_threads: 8,
  },
  models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'deepseek-chat', 'deepseek-reasoner'],
  model: 'gpt-4o-mini',

  sessions() {
    const n = this.now();
    return [
      { id: 'sms0001-1-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '重构事件总线并补充测试', mtime: n - 90, msgs: 24, active: true, busy: false, open: true, archives: 2 },
      { id: 'sms0001-2-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '给 WebUI 增加多标签支持', mtime: n - 5400, msgs: 61, active: false, busy: false, open: true },
      { id: 'sms0001-3-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '', mtime: n - 90000, msgs: 3, active: false, busy: false, open: true },
      { id: 'sms0002-1-mock', ws: this.B, group: this.B, cwd: this.cwdB, title: '产品官网落地页设计', mtime: n - 3200, msgs: 42, active: false, busy: false, open: true },
      { id: 'sms0002-2-mock', ws: this.B, group: this.B, cwd: this.cwdB, title: '把首页改成暗色主题', mtime: n - 260000, msgs: 18, active: false, busy: false, open: true },
    ];
  },
  workspaces() {
    return [
      { ws: this.A, cwd: this.cwdA, session: 'sms0001-1-mock', busy: false, active: true },
      { ws: this.B, cwd: this.cwdB, session: 'sms0002-1-mock', busy: false, active: false },
    ];
  },
  jobs: {
    'tw-mockgate01': {
      id: 'tw-mockgate01', status: 'running', work_type: 'parallel', created_at: 0,
      provider: 'openai', model: 'gpt-4o-mini',
      stages: [
        { name: '调研', mode: 'parallel', gate: false, agents: [{ name: 'worker_0' }, { name: 'worker_1' }] },
        { name: '评审关卡', mode: 'serial', gate: true, agents: [{ name: 'worker_2' }] },
        { name: '实现', mode: 'serial', gate: false, agents: [{ name: 'worker_3' }] },
      ],
      current_stage: 1, next_stage: 2,
      workers: [
        { name: 'worker_0', works: '调研现有事件总线的实现', report_status: 'ok', rounds: 3, tool_calls: 7, stage: '0', stage_name: '调研', has_report: true, reviews_approved: 1 },
        { name: 'worker_1', works: '调研前端订阅与重连', report_status: 'ok', rounds: 2, tool_calls: 5, stage: '0', stage_name: '调研', has_report: true },
        { name: 'worker_2', works: '评审调研结论并给出裁决', report_status: 'running', rounds: 1, tool_calls: 2, stage: '1', stage_name: '评审关卡' },
        { name: 'worker_3', works: '按结论实现重构', report_status: '', rounds: 0, tool_calls: 0, stage: '2', stage_name: '实现' },
      ],
    },
  },
  notices: [
    { id: 'n1', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "已复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp' 中的事件分发，未发现重复投递。", created_at: 0, pending: false },
    { id: 'n2', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "再次复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp'，订阅清理逻辑一致，建议合并。", created_at: 0, pending: false },
    { id: 'n3', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "第三次复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp'，无新增问题。", created_at: 0, pending: false },
    { id: 'n4', from: 'teamwork/tw-mockgate01/supervisor', topic: 'gate', body: '评审关卡已就绪，等待你确认后继续。tw-mockgate01 处于待批状态。', created_at: 0, pending: true },
    { id: 'n5', from: 'teamwork/tw-mockgate01/worker_3', topic: 'worker', body: '开始实现阶段，准备读取 cell-app-http.hpp。', created_at: 0, pending: false },
    { id: 'n6', from: 'teamwork/tw-mockgate01/supervisor', topic: 'job', body: '任务 tw-mockgate01 已进入第 2 阶段。', created_at: 0, pending: true },
    { id: 'n7', from: 'user', session: 'deb905474f99aa0a-1792154467683-8378c362', topic: '', body: '来自另一个会话的通知：首页的暗色主题配色已经定稿，请同步更新截图。', created_at: 0, pending: true },
  ],

  hello(ws) {
    const wk = this.workspaces();
    const cur = wk.find(w => w.ws === ws) || wk[0];
    const isA = cur.ws === this.A;
    return {
      t: 'hello', ws: cur.ws, active: cur.ws, session: cur.session, cwd: cur.cwd,
      model: this.model, provider: 'openai', sandbox: 'full-access', tools: true,
      providers: this.providers, settings: this.settings, busy: false,
      promptChars: 1240, skills: 3, promptInjected: true,
      history: isA ? [
        { role: 'user', text: '帮我看一下 cell-app-core.hpp 里的事件总线实现。' },
        { role: 'assistant', text: '好的，事件总线在 app_core::bus 上，每个事件都带 ws 标签。主要入口是 `post()`，SSE 与 WebView 两条传输共用同一条总线。\n\n需要我展开哪一部分？' },
        { role: 'user', text: '把所有事件类型列个清单。' },
        { role: 'assistant', text: '事件类型包括：\n- hello / turn_begin / turn_end\n- answer / reason / summary（增量文本）\n- round / tool_begin / tool_end\n- notice / approval / approval_resolved\n\n每条都带 ws（工作区键）。' },
      ] : [
        { role: 'user', text: '首页想做成暗色主题，配色偏青紫。' },
        { role: 'assistant', text: '可以，用一组 CSS 变量统一管理主题即可。' },
      ],
      teamwork: Object.values(this.jobs),
      workspaces: wk,
    };
  },

  api(name, args) {
    args = args || {};
    const ws = args.ws || S.active || this.A;
    switch (name) {
      case 'state': return Promise.resolve(Object.assign({ ok: true }, this.hello(ws)));
      case 'workspace.list': return Promise.resolve({ ok: true, workspaces: this.workspaces() });
      case 'workspace.open': {
        const cwd = args.cwd || this.cwdB;
        const key = this.A + '-x' + (++this._seq);
        this._extra = this._extra || {};
        this._extra[key] = cwd;
        return Promise.resolve({ ok: true, ws: key, cwd: cwd, session: 'mock-new-' + this._seq });
      }
      case 'workspace.close': case 'workspace.activate': return Promise.resolve({ ok: true });
      case 'sessions.list': return Promise.resolve({ ok: true, sessions: this.sessions() });
      case 'sessions.search': {
        const q = String(args.q || '').toLowerCase();
        const out = [];
        let total = 0;
        for (const s of this.sessions()) {
          const hits = [];
          if (q && (s.title || '').toLowerCase().includes(q))
            hits.push({ kind: 'chat', role: 'user', text: s.title, line: 1 });
          if (hits.length) {
            total += hits.length;
            out.push({ id: s.id, ws: s.ws, cwd: s.cwd, title: s.title, mtime: s.mtime, hits, more: 0 });
          }
        }
        return Promise.resolve({ ok: true, results: out, total: total });
      }
      case 'session.history': {
        // 与 cell.cpp 一致：压缩摘要以 role:assistant 落盘（前缀即摘要标记）；
        // reasoning 条目对应落盘 content 数组里的思考块（先思考后正文）
        const entries = [
          { role: 'system', kind: 'system', text: 'You are a helpful assistant. Do not multiply entities beyond necessity.' },
          { role: 'assistant', kind: 'summary', text: '# Here is a summary that captures the previous conversation:\n- 工作目录：`D:\\Developments\\CXX\\cell-app`\n- 目标：梳理事件总线实现\n- 结论：`bus.post()` 广播给所有 sink，SSE 与 WebView 共用同一条总线' },
          { role: 'user', kind: 'user', text: '帮我看一下 cell-app-core.hpp 里的事件总线实现。' },
          { role: 'assistant', kind: 'reasoning', text: '用户想了解事件总线。先读取 cell-app-core.hpp，定位 app_core::bus 的定义与投递路径，再总结主要入口。' },
          { role: 'assistant', kind: 'tool', name: 'read', args: '{"path": "cell-app-core.hpp"}', result: '… 已读取 2001 行 / 69 KB', status: 'ok' },
          { role: 'assistant', kind: 'assistant', text: '好的，事件总线在 `app_core::bus` 上，每个事件都带 ws 标签。主要入口是 post()。\n\n1. SSE 与 WebView 两条传输共用同一条总线\n2. 顺序一致，前端按 ws 归档即可' },
          { role: 'tool', kind: 'tool_result', text: 'tool="read" path="cell-app-core.hpp" — 读取完成' },
        ];
        return Promise.resolve({ ok: true, id: args.id || 'sms0001-1-mock', ws: args.ws || this.A, total: entries.length, entries: entries, archives: [
          { name: 'msg-20261013-161454.jsonl', mtime: this.now() - 86400, msgs: 24 },
          { name: 'msg-20261012-093002.jsonl', mtime: this.now() - 172800, msgs: 41 },
        ] });
      }
      case 'session.archive': {
        // notice 归档（清空通知/清空上下文的产物）：按通知行形状返回
        if (String(args.name || '').startsWith('notice-'))
          return Promise.resolve({ ok: true, name: args.name, notices: [
            { id: 'nt-0', from: 'teamwork/tw-x/supervisor', topic: 'gate', body: '评审关卡已就绪，等待确认后继续。', created_at: this.now() - 600, state: 'dropped' },
            { id: 'nt-1', from: 'teamwork/tw-x/worker_0', topic: 'worker', body: '子代理已完成调研并写入报告。', created_at: this.now() - 300, state: 'delivered' },
          ] });
        const arc = [
          { role: 'system', kind: 'system', text: 'You are a helpful assistant.' },
          { role: 'user', kind: 'user', text: '压缩前的历史消息（演示）' },
          { role: 'assistant', kind: 'assistant', text: '这是存档里的一条助手消息，展开后应能看到正文。' },
          { role: 'tool', kind: 'tool', name: 'read', args: '{"path":"cell-app-core.hpp"}', result: '… 2001 行', status: 'ok' },
        ];
        return Promise.resolve({ ok: true, name: args.name || '', entries: arc });
      }
      case 'session.archives': {
        // 两个存档：验证「多个存档 → 多个独立小窗」
        const n = this.now();
        return Promise.resolve({ ok: true, id: args.id || 'sms0001-1-mock', ws: args.ws || this.A, archives: [
          { name: 'msg-20261013-161454.jsonl', mtime: n - 86400, msgs: 24 },
          { name: 'msg-20261012-093002.jsonl', mtime: n - 172800, msgs: 41 },
        ] });
      }
      case 'session.select': case 'session.new': return Promise.resolve({ ok: true });
      case 'settings.get': return Promise.resolve({ ok: true, settings: this.settings });
      case 'settings.set':
        Object.assign(this.settings, args.patch || {});
        return Promise.resolve({ ok: true, settings: this.settings });
      case 'providers.select': return Promise.resolve({ ok: true, providers: this.providers });
      case 'providers.rm': this.providers = this.providers.filter(p => p.name !== args.name); return Promise.resolve({ ok: true, providers: this.providers });
      case 'providers.add': this.providers.push({ name: args.name || args.api_style, api_style: args.api_style, base: args.base, proxy: args.proxy || '', has_key: !!args.key, current: false }); return Promise.resolve({ ok: true, name: args.name || args.api_style, providers: this.providers });
      case 'provider.set_key': { const p = this.providers.find(x => x.name === args.name); if (p) p.has_key = true; return Promise.resolve({ ok: true, providers: this.providers }); }
      case 'models.fetch': return Promise.resolve({ ok: true, models: this.models });
      case 'model.set': this.model = args.model; return Promise.resolve({ ok: true });
      case 'teamwork.list': return Promise.resolve({ ok: true, jobs: Object.values(this.jobs) });
      case 'teamwork.report':
        return Promise.resolve({ ok: true, report: '# 报告 · ' + args.worker + '\n\n这是演示模式下的子代理报告。\n\n- 已完成调研\n- 已给出结论\n- 建议合并到主分支' });
      case 'teamwork.worker': return Promise.resolve(this.workerDelta(args));
      case 'teamwork.create': {
        const id = 'tw-mock' + (++this._seq);
        const st = ((args.workflow && args.workflow.stages) || []).map((s, i) => ({
          name: s.name || ('stage ' + (i + 1)), mode: s.mode || 'serial', gate: !!s.gate,
          agents: (s.agents || []).map(a => ({ name: a.name || '' })),
        }));
        const workers = [];
        ((args.workflow && args.workflow.stages) || []).forEach((s, i) => (s.agents || []).forEach((a, ai) => {
          workers.push({ name: a.name || ('worker_' + workers.length), works: a.works, report_status: '', rounds: 0, tool_calls: 0, stage: String(i), stage_name: st[i] ? st[i].name : '' });
        }));
        this.jobs[id] = { id, status: 'pending', work_type: args.work_type || 'serial', created_at: this.now(), stages: st, workers, current_stage: -1, next_stage: 0, provider: 'openai', model: this.model };
        return Promise.resolve({ ok: true, job: id });
      }
      case 'teamwork.run': case 'teamwork.resume': {
        const j = this.jobs[args.id]; if (j) { j.status = 'running'; j.current_stage = 0; }
        setTimeout(() => this.emit({ t: 'teamwork_changed', ws: ws }), 30);
        return Promise.resolve({ ok: true, message: 'started' });
      }
      case 'teamwork.stop': { const j = this.jobs[args.id]; if (j) j.status = 'pending'; setTimeout(() => this.emit({ t: 'teamwork_changed', ws: ws }), 30); return Promise.resolve({ ok: true, message: 'stop requested' }); }
      case 'notice.list': return Promise.resolve({ ok: true, notices: this.notices });
      case 'notice.clear': { const n = this.notices.length; this.notices = []; return Promise.resolve({ ok: true, dropped: n, seen: 0 }); }
      case 'notice.send': {
        const tgt = String(args.session || '').trim();
        if (!String(args.body || '').trim()) return Promise.resolve({ ok: false, error: '通知内容不能为空' });
        const id = 'nm' + (++this._seq);
        this.notices.push({ id, from: args.from || 'user', session: tgt || 'mock-self-session-0000', topic: args.topic || '', body: args.body, created_at: this.now(), pending: true });
        return Promise.resolve({ ok: true, id, target: tgt, reply_to: 'mock-self-session-0000' });
      }
      case 'upload': return Promise.resolve({ ok: true, path: 'D:\\tmp\\.cell\\uploads\\' + (args.name || 'file'), name: args.name || 'file', size: (args.data_b64 || '').length * 3 / 4 | 0 });
      case 'send': this.simulateTurn(ws, args.text || ''); return Promise.resolve({ ok: true });
      case 'stop': { const t = S.tabs.get(ws); if (t) { t.busy = false; t.thinkingSince = 0; } this.cancel = true; return Promise.resolve({ ok: true }); }
      case 'approve': { setTimeout(() => this.emit({ t: 'approval_resolved', ws: ws, id: args.id, allow: !!args.allow }), 60); return Promise.resolve({ ok: true }); }
      default: return Promise.resolve({ ok: false, error: '演示模式不支持：' + name });
    }
  },

  workerDelta(args) {
    const j = this.jobs[args.job];
    const since = Number(args.since || 0);
    const all = [];
    all.push({ role: 'system', content: '你是子代理 ' + args.worker + '，负责：' + (this._worksOf(args.job, args.worker) || '任务') });
    all.push({ role: 'user', content: '请在当前工作区执行你的任务，并给出简明报告。' });
    all.push({ role: 'assistant', content: [{ type: 'text', text: '我先查看相关文件。' }, { type: 'tool_use', name: 'read_file' }] });
    all.push({ role: 'user', content: [{ type: 'tool_result', text: '已读取 cell-app-core.hpp（2001 行）' }] });
    all.push({ role: 'assistant', content: '事件总线使用 app_core::bus，post() 会广播给所有 sink；SSE 与 WebView 两条传输共用。结论：无需改动投递顺序。' });
    const delta = all.slice(since);
    const w = j ? (j.workers || []).find(x => x.name === args.worker) : null;
    const status = w && w.report_status ? w.report_status : (since + delta.length >= all.length ? 'done' : 'running');
    return { ok: true, status: status, rounds: 2, tool_calls: 2, total: all.length, messages: delta };
  },
  _worksOf(jobId, worker) {
    const j = this.jobs[jobId]; if (!j) return '';
    const w = (j.workers || []).find(x => x.name === worker);
    return w ? w.works : '';
  },

  emit(obj) { setTimeout(() => handleEvent(obj), 0); },

  simulateTurn(ws, text) {
    this.cancel = false;
    const t = S.tabs.get(ws);
    const seqTool = ++this._seq;
    const steps = [
      [60, () => this.emit({ t: 'turn_begin', ws })],
      [200, () => this.emit({ t: 'progress', ws, ms: 320 })],
      // 第一段思考（工具调用之前）
      [300, () => this.emit({ t: 'reason', ws, d: '先看一下工作区结构，确定文件该写到哪里。' })],
      [340, () => this.emit({ t: 'tool_begin', ws, seq: seqTool, name: 'read_file', args: '{\n  "path": "cell-app-core.hpp"\n}', policy: 'read' })],
      // 回合中段的通知：转录重载后应被补回聊天流
      [500, () => this.emit({ t: 'notice', ws, d: '[notice] from=teamwork/tw-mockgate01/worker_0 topic=worker', nid: 'nn-mid-turn', from: 'teamwork/tw-mockgate01/worker_0', topic: 'worker', body: "新进展：已更新 'cell-app-core.hpp' 的注释。", created_at: this.now() })],
      [900, () => this.emit({ t: 'tool_end', ws, seq: seqTool, name: 'read_file', status: 'ok', display: '… 已读取 2001 行 / 69 KB', marker: '', sec: 0.56, chars: 69000, multimodal: false })],
      // 第二段思考（被 toolcall 分开）——应与前一段合并进同一张思考卡
      [960, () => this.emit({ t: 'reason', ws, d: '目录结构清楚了，直接创建四个游戏文件。' })],
      [1000, () => this.emit({ t: 'round', ws, round: 1, tok_in: 1240, tok_out: 420, cache: 512, sec: 1.9, ttft: 260 })],
      [1060, () => this.emit({ t: 'answer_begin', ws })],
    ];
    const answer = '好的，我看了事件总线的实现。要点如下：\n\n1. 所有事件经 `bus.post()` 广播，每条都带 `ws` 工作区键。\n2. SSE（`api/events`）与 WebView 两条传输共用同一个总线，顺序一致。\n3. 前端应把事件按 ws 归入各自的标签状态。\n\n需要我针对某个事件类型再展开吗？';
    for (const [ms, fn] of steps) setTimeout(fn, ms);
    let acc = '';
    const chars = Array.from(answer);
    chars.forEach((ch, i) => {
      setTimeout(() => { if (!this.cancel) this.emit({ t: 'answer', ws, d: ch }); }, 1200 + i * 14);
    });
    const total = 1200 + chars.length * 14 + 200;
    setTimeout(() => {
      if (this.cancel) return;
      this.emit({ t: 'round', ws, round: 2, tok_in: 1660, tok_out: chars.length, cache: 900, sec: 3.4, ttft: 210 });
      this.emit({ t: 'turn_end', ws, natural: true, rounds: 2, tool_calls: 1 });
      this.emit({ t: 'notice', ws, d: '[notice] from=teamwork/tw-mockgate01/worker_0 topic=worker', nid: 'nn' + (++this._seq), from: 'teamwork/tw-mockgate01/worker_0', topic: 'worker', body: "新进展：已更新 '" + this.cwdA + "\\cell-app-core.hpp' 的注释。", created_at: this.now() });
    }, total);
  },

  start() {
    this.emit(this.hello(S.mode === 'demo' ? this.A : this.A));
    // 演示：延迟推送通知与审批样例
    setTimeout(() => {
      this.emit({ t: 'notice', ws: this.A, d: '[notice] gate', nid: 'ng' + (++this._seq), from: 'teamwork/tw-mockgate01/supervisor', topic: 'gate', body: '评审关卡已就绪，等待确认后继续：tw-mockgate01', created_at: this.now() });
    }, 2400);
    setTimeout(() => {
      this.emit({ t: 'approval', ws: this.A, id: 'ap' + (++this._seq), tool: 'write_file', args: '{\n  "path": "D:\\\\Developments\\\\CXX\\\\cell-app\\\\ui\\\\index.html",\n  "bytes": 128430\n}' });
    }, 5200);
  },
};
