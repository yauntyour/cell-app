/* ---------- L. 演示模式（mock 后端） -------------------------------
   演示模式要能「一眼看到完整会话」：默认数据是一条进行中的真实工作流
   ——历史里已有问有答，启动后自动跑一个回合（思考 → 工具 → 轮次 →
   流式回答 → 回合产物），结束后再把编辑卡/用量行补进消息流。
   URL 参数：
     ?mock=1              默认完整演示（自动跑一个回合）
     ?mock=1&demo=empty   空态（hero），工作区已打开但没有消息
     ?mock=1&demo=stream  停在流式中（回答持续输出、回合不结束）
     ?mock=1&demo=approval 展示审批弹窗
   右侧面板的 git.* / fs.* / term.* 演示数据由 08b-panels.js 包装 Mock.api
   提供；这里只补消息流要用的 git.numstat / git.diff。                     */
const DEMO_KIND = (() => {
  try { return (new URLSearchParams(location.search).get('demo') || '').toLowerCase(); }
  catch (e) { return ''; }
})();

const Mock = {
  A: 'mock0001a', B: 'mock0002b',
  cwdA: 'D:\\Developments\\CXX\\cell-app',
  cwdB: 'D:\\Projects\\demo-site',
  demo: DEMO_KIND,
  now: () => Math.floor(Date.now() / 1000),
  _seq: 0,
  _turns: {},          // ws:session -> 追加的 transcript 条目（模拟落盘）
  _sessions: {},       // ws -> 当前会话 id
  _numstatLive: false, // 回合结束后 numstat 切到「改动后」
  _streamA: null,      // 正在流式的回合（?demo=stream 用）
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
  // 真实核心的 model_label() 是「供应商:模型」：演示模式照抄这个形状，
  // 输入栏圆钮只显示冒号后面的模型名（供应商在底部状态行里）
  model: 'openai:deepseek-v4-flash',

  /* ---- 会话 / 工作区 ------------------------------------------------ */
  sessionOf(ws) {
    ws = ws || this.A;
    if (!this._sessions[ws]) this._sessions[ws] = (ws === this.B ? 'sms0002-1-mock' : 'sms0001-1-mock');
    return this._sessions[ws];
  },
  sessions() {
    const n = this.now();
    return [
      { id: 'sms0001-1-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '重做消息流与回合产物', mtime: n - 90, msgs: 14, active: true, busy: false, open: true, archives: 2 },
      { id: 'sms0001-2-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '给 WebUI 增加多标签支持', mtime: n - 5400, msgs: 61, active: false, busy: false, open: true },
      { id: 'sms0001-3-mock', ws: this.A, group: this.A, cwd: this.cwdA, title: '梳理事件总线实现', mtime: n - 90000, msgs: 3, active: false, busy: false, open: true },
      { id: 'sms0002-1-mock', ws: this.B, group: this.B, cwd: this.cwdB, title: '产品官网落地页设计', mtime: n - 3200, msgs: 42, active: false, busy: false, open: true, jobs: 1 },
      { id: 'sms0002-2-mock', ws: this.B, group: this.B, cwd: this.cwdB, title: '把首页改成暗色主题', mtime: n - 260000, msgs: 18, active: false, busy: false, open: true },
    ];
  },
  workspaces() {
    const out = [];
    for (const ws of [this.A, this.B]) {
      out.push({ ws: ws, cwd: ws === this.A ? this.cwdA : this.cwdB, session: this.sessionOf(ws), busy: false, active: ws === this.A });
    }
    for (const k of Object.keys(this._extraWs || {}))
      out.push({ ws: k, cwd: this._extraWs[k], session: this.sessionOf(k), busy: false, active: false });
    return out;
  },

  /* ---- 会话历史 ----------------------------------------------------
     默认演示：一段已完成的对话（含 markdown 代码块/表格/链接/思考/工具），
     结尾是一条用户消息 —— 启动后自动跑的那一轮就是它的回答。          */
  baseEntries(ws, sid) {
    if (ws === this.B) {
      return [
        { role: 'user', kind: 'user', text: '首页想做成暗色主题，配色偏靛蓝。' },
        { role: 'assistant', kind: 'assistant', text: '可以，用一组 CSS 变量统一管理主题即可。先定 **背景 / 表面 / 文字 / 强调** 四层令牌，再让组件只引用变量。' },
        { role: 'user', kind: 'user', text: '好，那先出一版配色稿。' },
      ];
    }
    if (sid && sid !== 'sms0001-1-mock') {
      return [
        { role: 'user', kind: 'user', text: '这个会话是一条较早的历史记录（演示）。' },
        { role: 'assistant', kind: 'assistant', text: '它同样走完整的历史加载链路：markdown、思考块、工具卡都能正常渲染。' },
      ];
    }
    if (this.demo === 'empty') return [];
    return [
      { role: 'user', kind: 'user', text: '帮我把 WebUI 的会话体验重做一下：消息流、工具调用、回合产物和输入栏都按 docs/ui-redesign.md 来。' },
      { role: 'assistant', kind: 'reasoning', text: '先读设计文档，确认消息流的视觉规范与协作契约：§2 令牌、§5.5 回合产物、§5.6 消息流、§7.3 演示数据。' },
      { role: 'assistant', kind: 'tool', name: 'read', args: '{"path":"docs/ui-redesign.md"}', result: '… 已读取 256 行 / 32 KB', status: 'ok', sec: 0.38 },
      { role: 'assistant', kind: 'assistant', text:
        '规范已确认，重点是三块：\n\n1. **消息流**：用户右对齐气泡；助手消息无气泡、22px logo 头像 + 正文\n2. **工具调用**：紧凑行卡（中文名 + 等宽工具名 + 状态点 + 耗时）\n3. **回合产物**：结束时插入「已编辑 N 个文件」卡与用量行\n\n```js\nfunction renderChat(ws) {\n  const t = S.tabs.get(ws);\n  if (!t) return;\n  // 消息按 role 分发渲染\n}\n```\n\n| 区域 | 状态 | 负责人 |\n| --- | --- | --- |\n| 消息流 | 进行中 | chat-stream |\n| 输入栏 | 待重做 | composer-ui |\n\n参考 [设计规范](docs/ui-redesign.md)。' },
      { role: 'user', kind: 'user', text: '好，那就先动消息流和演示数据，我等着截图验收。' },
    ];
  },
  turnEntries(ws, sid) { return (this._turns[ws + ':' + sid] || []).slice(); },
  historyEntries(ws, sid) {
    if (this.demo === 'empty') return [];
    return this.baseEntries(ws, sid).concat(this.turnEntries(ws, sid));
  },

  /* ---- Teamwork / 通知 -------------------------------------------- */
  jobs: {
    'tw-mockgate01': {
      id: 'tw-mockgate01', status: 'running', work_type: 'parallel', created_at: 0,
      provider: 'openai', model: 'deepseek-v4-flash',
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
    'tw-mockdocs02': {
      id: 'tw-mockdocs02', status: 'done', work_type: 'serial', created_at: 0,
      provider: 'openai', model: 'deepseek-v4-flash',
      stages: [
        { name: '写草案', mode: 'serial', gate: false, agents: [{ name: 'writer' }] },
        { name: '校对', mode: 'serial', gate: false, agents: [{ name: 'reviewer' }] },
      ],
      current_stage: 1, next_stage: 2,
      workers: [
        { name: 'writer', works: '起草 API 文档', report_status: 'ok', rounds: 2, tool_calls: 4, stage: '0', stage_name: '写草案', has_report: true },
        { name: 'reviewer', works: '校对措辞与示例', report_status: 'ok', rounds: 1, tool_calls: 2, stage: '1', stage_name: '校对', has_report: true },
      ],
    },
  },
  notices: [],
  _buildNotices() {
    const n = this.now();
    this.notices = [
      { id: 'n1', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "已复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp' 中的事件分发，未发现重复投递。", created_at: n - 240, pending: false },
      { id: 'n2', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "再次复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp'，订阅清理逻辑一致，建议合并。", created_at: n - 180, pending: false },
      { id: 'n3', from: 'teamwork/tw-mockgate01/worker_1', topic: 'review', body: "第三次复核 'D:\\Developments\\CXX\\cell-app\\cell-app-core.hpp'，无新增问题。", created_at: n - 120, pending: false },
      { id: 'n4', from: 'teamwork/tw-mockgate01/supervisor', topic: 'gate', body: '评审关卡已就绪，等待你确认后继续。tw-mockgate01 处于待批状态。', created_at: n - 90, pending: true },
      { id: 'n5', from: 'teamwork/tw-mockgate01/worker_3', topic: 'worker', body: '开始实现阶段，准备读取 cell-app-http.hpp。', created_at: n - 60, pending: false },
      { id: 'n6', from: 'teamwork/tw-mockgate01/supervisor', topic: 'job', body: '任务 tw-mockgate01 已进入第 2 阶段。', created_at: n - 50, pending: true },
      { id: 'n7', from: 'user', session: 'deb905474f99aa0a-1792154467683-8378c362', topic: '', body: '来自另一个会话的通知：首页的暗色主题配色已经定稿，请同步更新截图。', created_at: n - 30, pending: true },
    ];
  },

  /* ---- hello / state ----------------------------------------------- */
  hello(ws) {
    const wk = this.workspaces();
    const cur = wk.find(w => w.ws === ws) || wk[0] || wk[0];
    const sid = cur ? cur.session : this.sessionOf(this.A);
    const isB = cur && cur.ws === this.B;
    return {
      t: 'hello', ws: cur ? cur.ws : this.A, active: this.A, session: sid, cwd: cur ? cur.cwd : this.cwdA,
      model: this.model, provider: 'openai', sandbox: this.settings.sandbox_mode, tools: true,
      providers: this.providers, settings: this.settings, busy: false,
      promptChars: 1240, skills: 3, promptInjected: true,
      history: [],
      teamwork: Object.values(this.jobs),
      workspaces: wk,
      noticesTotal: this.notices.length,
    };
  },

  /* ---- numstat / diff（消息流的回合产物卡） ------------------------ */
  _numstatBase: [
    { path: 'README.md', add: 12, del: 3 },
    { path: 'src/ui/src/js/00-core.js', add: 8, del: 8 },
  ],
  _numstatAfter: [
    { path: 'README.md', add: 16, del: 7 },
    { path: 'src/ui/src/js/00-core.js', add: 8, del: 8 },
    { path: 'package.json', add: 1, del: 1 },
  ],
  numstat() {
    const files = (this._numstatLive ? this._numstatAfter : this._numstatBase)
      .map(f => ({ path: f.path, add: f.add, del: f.del, binary: false }));
    return { ok: true, files: files };
  },
  diffOf(path) {
    const head = 'diff --git a/' + path + ' b/' + path + '\n';
    if (/package\.json$/.test(path))
      return head + 'index 3f2a1c0..8b7d4e2 100644\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1,4 +1,5 @@\n {\n   "name": "cell-app",\n-  "version": "0.9.0",\n+  "version": "0.10.0",\n+  "private": true,\n   "scripts": {}\n }\n';
    return head + 'index 1a2b3c4..5d6e7f8 100644\n--- a/' + path + '\n+++ b/' + path + '\n@@ -8,7 +8,11 @@\n ## 界面\n \n-- 一条消息 = 角色点 + 正文\n-- 工具结果收进折叠卡\n+- 用户消息右对齐气泡，助手消息带 22px logo 头像\n+- 工具调用收成紧凑行卡（中文名 + 等宽名 + 状态点 + 耗时）\n+- 回合结束插入「已编辑 N 个文件」卡与用量行\n+- 流式光标为 1px accent 竖条\n \n ## 构建\n';
  },

  /* ---- Teamwork 演示数据助手 ----------------------------------------
     mock 的自动回合会用 LLM 的 tw 工具创建一个团队任务，消息流里应渲染
     成结构化的「团队任务已创建」卡；这里按引擎的 job_display 文本格式
     伪造一条工具结果，并把任务记录进 jobs 让 Teamwork 面板能查到。      */
  _stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
  },
  _twJobFromWorkflow(id, wf) {
    const stages = (wf.stages || []).map((s, i) => ({
      name: s.name || ('stage ' + (i + 1)), mode: s.mode || 'serial', gate: !!s.gate,
      agents: (s.agents || []).map(a => ({ name: a.name || '' })),
    }));
    const workers = [];
    (wf.stages || []).forEach((s, i) => (s.agents || []).forEach(a => {
      workers.push({
        name: a.name || ('worker_' + workers.length), works: a.works || '',
        report_status: '', rounds: 0, tool_calls: 0,
        stage: String(i), stage_name: stages[i] ? stages[i].name : '',
      });
    }));
    return {
      id: id, status: 'pending', work_type: wf.work_type || 'serial', created_at: this.now(),
      stages: stages, workers: workers, current_stage: -1, next_stage: 0,
      provider: 'openai', model: this.model,
    };
  },
  // 与引擎 teamwork::job_display 的单行文本一致（前端从中正则提取 id/status）
  _twDisplay(job) {
    let out = job.id + ' status=' + (job.status || 'pending') + ' work_type=' + (job.work_type || 'serial') +
      ' children=' + (job.workers || []).length + ' created=' + this._stamp();
    if (job.provider) out += ' provider=' + job.provider;
    if (job.model) out += ' model=' + job.model;
    if (job.stages && job.stages.length) {
      out += ' stages=' + job.stages.map(s => s.name + '(' +
        (s.mode === 'parallel' ? 'parallel ' : '') + (s.gate ? 'gate ' : '') +
        'x' + (s.agents || []).length + ')').join(' -> ');
      out += ' next_stage=0';
    }
    return out;
  },

  /* ---- 回合模拟 ----------------------------------------------------
     一个回合的完整时序：思考 → 工具 → 团队任务 → 轮次 → 流式回答 → 落盘
     → 回合结束。消息流前端（02-render2-chat.js）在 turn_end 后取 numstat
     前后快照生成「已编辑文件」卡，这里在回合结束前切换 numstat 数据。    */
  _runTurn(ws, opts) {
    opts = opts || {};
    const start = Math.max(0, opts.startDelay || 0);
    const turnsKey = ws + ':' + this.sessionOf(ws);
    const entries = [];  // 本回合要追加进 transcript 的条目
    const streamOnly = !!opts.streamOnly;
    const answer = opts.answer || ('消息流和演示数据都改完了，主要变化：\n\n'
      + '- 用户消息改为右对齐气泡，助手消息去掉气泡、加 22px logo 头像\n'
      + '- 思考过程折叠成一行「思考过程 · N 段」，流式中自动展开\n'
      + '- 工具调用收成紧凑行卡：中文名 + 等宽名 + 状态点 + 耗时，点开看参数与结果\n'
      + '- 回合结束追加「已编辑 N 个文件」卡与用量行，支持复制与重试\n\n'
      + '`?demo=empty` 与 `?demo=stream` 两个变体也加好了。');
    const reasonText = opts.reason || '用户要的是重做消息流与演示数据。先把渲染骨架拆成「用户 / 助手 / 思考 / 工具 / 回合产物」五类节点，再补 mock 数据；最后用一个真实回合把编辑卡和用量行跑出来。';
    const tool1 = { name: 'read_file', args: '{\n  "path": "src/ui/src/js/02-render2-chat.js"\n}', result: '… 已读取 695 行 / 28 KB', sec: 0.42 };
    // 第二个工具是 LLM 调 tw 创建团队任务：聊天里应渲染结构化卡片（旧版会
    // 直接铺参数 JSON），同时把任务写进 Mock.jobs 让 Teamwork 面板查得到。
    const twWorkflow = {
      stages: [
        { name: '调研', mode: 'parallel', gate: false, agents: [
          { works: '调研现有事件总线的实现', name: 'worker_0', think: 'low' },
          { works: '调研前端订阅与重连', name: 'worker_1', think: 'low' },
        ] },
        { name: '评审关卡', mode: 'serial', gate: true, agents: [
          { works: '评审调研结论并给出裁决', name: 'worker_2' },
        ] },
        { name: '实现', mode: 'serial', gate: false, agents: [
          { works: '按结论实现重构并补测试', name: 'worker_3', model: 'deepseek-v4-flash', think: 'med' },
        ] },
      ],
    };
    const twJobId = 'tw-' + this._stamp();
    const twJob = this._twJobFromWorkflow(twJobId, twWorkflow);
    const twArgs = JSON.stringify({ operation: 'new', workflow: twWorkflow, model: this.model, think: 'med' }, null, 2);
    const twResult = this._twDisplay(twJob);
    const at = (ms, fn) => setTimeout(fn, start + ms);
    const emit = o => this.emit(o);
    const push = e => entries.push(e);
    const seqTool = ++this._seq;

    at(0, () => emit({ t: 'turn_begin', ws }));
    at(220, () => { emit({ t: 'reason', ws, d: reasonText.slice(0, 26) }); });
    at(360, () => { emit({ t: 'reason', ws, d: reasonText.slice(26, 58) }); });
    at(480, () => { emit({ t: 'reason', ws, d: reasonText.slice(58) }); });
    push({ role: 'assistant', kind: 'reasoning', text: reasonText });
    at(620, () => emit({ t: 'tool_begin', ws, seq: seqTool, name: tool1.name, args: tool1.args, policy: 'read' }));
    at(980, () => emit({ t: 'tool_end', ws, seq: seqTool, name: tool1.name, status: 'ok', display: tool1.result, marker: '', sec: tool1.sec, chars: 28000, multimodal: false }));
    push({ role: 'assistant', kind: 'tool', name: tool1.name, args: tool1.args, result: tool1.result, status: 'ok', sec: tool1.sec });
    if (streamOnly) {
      // ?demo=stream：只演示「思考 → 工具 → 轮次 → 持续流式回答」，不排团队
      // 任务/回合结束事件；回答尽早开始并持续输出，保证任意等待时刻都能看到
      // 流式光标与「正在输出」状态。
      at(900, () => emit({ t: 'reason', ws, d: '渲染骨架已经清楚，直接把 mock 数据补齐，再跑一轮截图验证。' }));
      push({ role: 'assistant', kind: 'reasoning', text: '渲染骨架已经清楚，直接把 mock 数据补齐，再跑一轮截图验证。' });
      at(980, () => emit({ t: 'round', ws, round: 1, tok_in: 1830, tok_out: 246, cache: 1024, sec: 2.1, ttft: 280 }));
      push({ kind: 'round', round: 1, tok_in: 1830, tok_out: 246, cache: 1024, sec: 2.1, ttft: 280 });
      at(1040, () => emit({ t: 'answer_begin', ws }));
      Array.from(answer).forEach((ch, i) => {
        at(1060 + i * 34, () => {
          if (this._stopped) return;
          emit({ t: 'answer', ws, d: ch });
        });
      });
      this._streamA = { ws: ws, key: turnsKey, entries: entries, seq: seqTool };
      return;
    }
    at(1040, () => emit({ t: 'reason', ws, d: '渲染骨架已经清楚，我开一个团队任务并行补齐 mock 数据与截图验证。' }));
    push({ role: 'assistant', kind: 'reasoning', text: '渲染骨架已经清楚，我开一个团队任务并行补齐 mock 数据与截图验证。' });
    const seqTool2 = ++this._seq;
    at(1100, () => {
      this.jobs[twJobId] = twJob;
      emit({ t: 'tool_begin', ws, seq: seqTool2, name: 'tw', args: twArgs, policy: 'teamwork' });
    });
    at(1250, () => emit({ t: 'tool_end', ws, seq: seqTool2, name: 'tw', status: 'ok', display: twResult, marker: '', sec: 0.28, chars: twResult.length, multimodal: false }));
    push({ role: 'assistant', kind: 'tool', name: 'tw', args: twArgs, result: twResult, status: 'ok', sec: 0.28 });
    at(1560, () => emit({ t: 'round', ws, round: 1, tok_in: 1830, tok_out: 246, cache: 1024, sec: 2.1, ttft: 280 }));
    push({ kind: 'round', round: 1, tok_in: 1830, tok_out: 246, cache: 1024, sec: 2.1, ttft: 280 });
    // 回合中段的通知：也会作为聊天气泡出现
    at(1660, () => emit({
      t: 'notice', ws, d: '[notice] from=teamwork/tw-mockgate01/worker_0 topic=worker',
      nid: 'nn-mid-turn', from: 'teamwork/tw-mockgate01/worker_0', topic: 'worker',
      body: "新进展：已更新 'cell-app-core.hpp' 的注释与事件表。", created_at: this.now(),
    }));
    at(1700, () => emit({ t: 'answer_begin', ws }));
    const charDelay = 6;
    const chars = Array.from(answer);
    const answerStart = 1500;
    chars.forEach((ch, i) => {
      at(answerStart + i * charDelay, () => {
        if (this._stopped) return;
        emit({ t: 'answer', ws, d: ch });
      });
    });
    const answerDone = answerStart + chars.length * charDelay;
    at(answerDone + 60, () => emit({ t: 'round', ws, round: 2, tok_in: 3920, tok_out: chars.length, cache: 2816, sec: 3.6, ttft: 210 }));
    push({ kind: 'round', round: 2, tok_in: 3920, tok_out: chars.length, cache: 2816, sec: 3.6, ttft: 210 });
    push({ role: 'assistant', kind: 'assistant', text: answer });
    at(answerDone + 140, () => {
      // 落盘：回合结束后前端重载 transcript 时能看到这一回合（文件改动卡由
      // 前端取 numstat 前后快照生成，所以这里只切数据、不写 turnmeta）
      this._turns[turnsKey] = (this._turns[turnsKey] || []).concat(entries);
      this._numstatLive = true;
      emit({ t: 'turn_end', ws, natural: true, rounds: 2, tool_calls: 2 });
    });
    // 回合结束后的通知（展示通知卡进入消息流 + 右栏通知面板）
    at(answerDone + 260, () => emit({
      t: 'notice', ws, d: '[notice] gate',
      nid: 'ng' + (++this._seq), from: 'teamwork/tw-mockgate01/supervisor', topic: 'gate',
      body: '评审关卡已就绪，等待确认后继续：tw-mockgate01', created_at: this.now(),
    }));
  },

  /* ---- 启动 -------------------------------------------------------- */
  start() {
    this._buildNotices();
    if (this.demo !== 'stream') {
      // 默认演示自动跑一轮；empty / approval 不跑
    }
    this.emit(this.hello(this.A));
    if (this.demo === 'empty') return;
    if (this.demo === 'approval') {
      setTimeout(() => this.emit({
        t: 'approval', ws: this.A, id: 'ap' + (++this._seq), tool: 'write_file',
        args: '{\n  "path": "src/ui/src/js/02-render2-chat.js",\n  "bytes": 128430\n}',
      }), 1200);
      return;
    }
    if (this.demo === 'stream') this._runTurn(this.A, { startDelay: 300, streamOnly: true });
    else this._runTurn(this.A, { startDelay: 300 });
  },

  /* ---- 命令实现 ---------------------------------------------------- */
  api(name, args) {
    args = args || {};
    const ws = args.ws || S.active || this.A;
    const sid = this.sessionOf(ws);
    switch (name) {
      case 'state': return Promise.resolve(Object.assign({ ok: true }, this.hello(ws)));
      case 'workspace.list': return Promise.resolve({ ok: true, workspaces: this.workspaces() });
      case 'workspace.open': {
        const cwd = args.cwd || this.cwdB;
        const key = 'mock-ws-' + (++this._seq);
        this._extraWs = this._extraWs || {};
        this._extraWs[key] = cwd;
        this._sessions[key] = 'mock-new-' + this._seq;
        return Promise.resolve({ ok: true, ws: key, cwd: cwd, session: this._sessions[key] });
      }
      case 'workspace.close': {
        if (this._extraWs) delete this._extraWs[args.ws];
        return Promise.resolve({ ok: true });
      }
      case 'workspace.activate': return Promise.resolve({ ok: true });
      case 'workspace.delete': return Promise.resolve({ ok: true });
      case 'sessions.list': return Promise.resolve({ ok: true, sessions: this.sessions() });
      case 'sessions.search': {
        const q = String(args.q || '').toLowerCase();
        const out = [];
        let total = 0;
        for (const s of this.sessions()) {
          const hits = [];
          if (q && (s.title || '').toLowerCase().includes(q))
            hits.push({ kind: 'chat', role: 'user', text: s.title, line: 1 });
          if (hits.length) { total += hits.length; out.push({ id: s.id, ws: s.ws, cwd: s.cwd, title: s.title, mtime: s.mtime, hits, more: 0 }); }
        }
        return Promise.resolve({ ok: true, results: out, total: total });
      }
      case 'session.digest': {
        const id = args.id || sid;
        const row = this.sessions().find(x => x.id === id) || { title: '演示会话', msgs: 0 };
        return Promise.resolve({
          ok: true, id: id, ws: args.ws || ws, title: row.title, msgs: row.msgs || 0,
          turns: 12, archives: 1, source: 'summary',
          summary: '# Here is a summary that captures the previous conversation:\n'
            + '目标：把 WebUI 的会话体验重做一遍（消息流 / 工具调用 / 回合产物 / 输入栏）。\n'
            + '- 已确认设计令牌与三区外壳结构，输入栏按悬浮卡片实现。\n'
            + '- 消息流：用户右对齐气泡，助手消息带 22px logo 头像。\n'
            + '- 工具调用收成紧凑行卡；回合结束插入「已编辑 N 个文件」卡与用量行。\n'
            + '- 未完成：输入栏的 @ 引用（文件 / 会话）补全。',
        });
      }
      case 'session.history': {
        const id = args.id || sid;
        const entries = this.historyEntries(ws, id);
        return Promise.resolve({
          ok: true, id: id, ws: ws, total: entries.length, entries: entries,
          archives: [
            { name: 'msg-20261013-161454.jsonl', mtime: this.now() - 86400, msgs: 24 },
            { name: 'msg-20261012-093002.jsonl', mtime: this.now() - 172800, msgs: 41 },
          ],
        });
      }
      case 'session.archive': {
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
      case 'session.archives': return Promise.resolve({ ok: true, id: args.id || sid, ws: ws, archives: [
        { name: 'msg-20261013-161454.jsonl', mtime: this.now() - 86400, msgs: 24 },
        { name: 'msg-20261012-093002.jsonl', mtime: this.now() - 172800, msgs: 41 },
      ] });
      case 'session.select': {
        if (args.id) this._sessions[ws] = args.id;
        return Promise.resolve({ ok: true });
      }
      case 'session.new': {
        this._sessions[ws] = 'mock-new-' + (++this._seq);
        return Promise.resolve({ ok: true, session: this._sessions[ws] });
      }
      case 'session.clear': {
        this._turns[ws + ':' + sid] = [];
        this._numstatLive = false;
        return Promise.resolve({ ok: true });
      }
      case 'session.delete': return Promise.resolve({ ok: true });
      case 'settings.get': return Promise.resolve({ ok: true, settings: this.settings });
      case 'settings.set':
        Object.assign(this.settings, args.patch || {});
        return Promise.resolve({ ok: true, settings: this.settings });
      case 'providers.select': return Promise.resolve({ ok: true, providers: this.providers });
      case 'providers.rm': this.providers = this.providers.filter(p => p.name !== args.name); return Promise.resolve({ ok: true, providers: this.providers });
      case 'providers.add': this.providers.push({ name: args.name || args.api_style, api_style: args.api_style, base: args.base, proxy: args.proxy || '', has_key: !!args.key, current: false }); return Promise.resolve({ ok: true, name: args.name || args.api_style, providers: this.providers });
      case 'provider.set_key': { const p = this.providers.find(x => x.name === args.name); if (p) p.has_key = true; return Promise.resolve({ ok: true, providers: this.providers }); }
      case 'models.fetch': return Promise.resolve({ ok: true, models: this.models });
      case 'model.set': {
        const cp = (this.providers || []).find(x => x.current) || { name: 'openai' };
        this.model = cp.name + ':' + args.model;
        return Promise.resolve({ ok: true });
      }
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
        ((args.workflow && args.workflow.stages) || []).forEach((s, i) => (s.agents || []).forEach(a => {
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
      case 'send': this.sendUser(ws, args.text || ''); return Promise.resolve({ ok: true });
      case 'stop': {
        this._stopped = true;
        const t = S.tabs.get(ws); if (t) { t.busy = false; t.thinkingSince = 0; }
        this._numstatLive = false;
        return Promise.resolve({ ok: true });
      }
      case 'approve': { setTimeout(() => this.emit({ t: 'approval_resolved', ws: ws, id: args.id, allow: !!args.allow }), 60); return Promise.resolve({ ok: true }); }
      case 'git.numstat': return Promise.resolve(this.numstat());
      case 'git.diff': return Promise.resolve({ ok: true, path: args.path || '', diff: this.diffOf(args.path || 'README.md'), truncated: false, binary: false });
      default: return Promise.resolve({ ok: false, error: '演示模式不支持：' + name });
    }
  },

  /* 用户发消息：先落一条 user 条目，再跑一个回合（保证重载后对话还在） */
  sendUser(ws, text) {
    const key = ws + ':' + this.sessionOf(ws);
    this._stopped = false;
    this._turns[key] = (this._turns[key] || []).concat([{ role: 'user', kind: 'user', text: text }]);
    this._runTurn(ws, {
      startDelay: 80,
      answer: '收到。演示模式下这是一条模拟回答：\n\n> ' + String(text).slice(0, 120) + '\n\n- 这条回合同样会走完整链路：思考 → 工具 → 轮次 → 流式正文\n- 结束后会重载 transcript，所以刷新后对话仍然存在\n- 需要看空态/流式状态可用 `?demo=empty` / `?demo=stream`',
    });
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
};
