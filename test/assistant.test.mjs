import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant, SESSION_ID, assistantText, readHostModel } from '../lib/assistant.js';

// 用假 agent 顶替 ctx.agents，验证注入与投递的归属判定
function fakeCtx(overrides = {}) {
  const created = [];
  const models = [];
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('no session');
    },
    create: async (options) => {
      created.push(options);
      const agent = {
        session: { id: options.sessionId },
        followup(message) {
          models.push(message);
        },
      };
      return { agent, dispose: async () => {} };
    },
    withoutInitiator: (fn) => fn(),
  };
  return {
    created,
    models,
    ctx: {
      get: (name) => (name === 'agents' ? agents : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
      agents,
      ...overrides,
    },
  };
}

function buildAssistant(ctx, sent = []) {
  return new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    send: async (text) => {
      sent.push(text);
      return true;
    },
    buildTools: () => [],
  });
}

test('assistantText 拼接文本块', () => {
  assert.equal(assistantText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]), '第一段\n第二段');
});

test('assistantText 跳过含工具调用的中间叙述', () => {
  const content = [{ type: 'text', text: '我去查一下' }, { type: 'tool-call', name: 'bash' }];
  assert.equal(assistantText(content, true), undefined);
  assert.equal(assistantText(content, false), '我去查一下');
});

test('assistantText 空内容返回空串', () => {
  assert.equal(assistantText([]), '');
  assert.equal(assistantText(undefined), '');
});

test('readHostModel 读到默认模型', () => {
  const model = readHostModel({
    get: () => ({ currentSelection: () => ({ provider: ' deepseek ', model: ' chat ' }) }),
  });
  assert.deepEqual(model, { provider: 'deepseek', model: 'chat' });
});

test('readHostModel 缺字段时返回 undefined', () => {
  assert.equal(readHostModel({ get: () => undefined }), undefined);
  assert.equal(readHostModel({ get: () => ({ currentSelection: () => ({ provider: '', model: 'm' }) }) }), undefined);
  assert.equal(
    readHostModel({
      get: () => {
        throw new Error('boom');
      },
    }),
    undefined,
  );
});

test('ensureSession 在缺默认模型时抛错', async () => {
  const { ctx } = fakeCtx();
  ctx.get = (name) => (name === 'agents' ? ctx.agents : undefined);
  const assistant = buildAssistant(ctx);
  await assert.rejects(() => assistant.ensureSession(), /没有可用的默认模型/);
});

test('ensureSession 创建会话时带上工作区与预设', async () => {
  const { ctx, created } = fakeCtx();
  const assistant = buildAssistant(ctx);
  await assistant.ensureSession();
  assert.equal(created.length, 1);
  assert.equal(created[0].sessionId, SESSION_ID);
  assert.equal(created[0].meta.cwd, 'C:/tmp');
  assert.equal(created[0].meta.agentPreset, 'standard');
  assert.deepEqual(created[0].agentOptions, { provider: 'p', model: 'm' });
  assert.equal(typeof created[0].setup, 'function');
});

test('已有实时 agent 时复用，不重复创建', async () => {
  const { ctx, created } = fakeCtx();
  const live = { session: { id: SESSION_ID }, followup() {} };
  ctx.agents.get = () => live;
  const assistant = buildAssistant(ctx);
  await assistant.ensureSession();
  assert.equal(created.length, 0);
});

test('deliver 注入一条 user 消息并带上来源标记', async () => {
  const { ctx, models } = fakeCtx();
  const assistant = buildAssistant(ctx);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '张三让我周五前整理报销表', contextToken: 'ctx' });

  assert.equal(models.length, 1);
  assert.equal(models[0].role, 'user');
  assert.equal(models[0].content[0].text, '张三让我周五前整理报销表');
  assert.equal(models[0].source.kind, 'user');
  assert.equal(models[0].source.rpcId, rpcId);
});

test('只有微信触发的那一轮才把回复推回微信', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 1 } });
  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'user/message', data: { turn: 1, source: { rpcId } } },
  );
  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '记下了' }] } } },
  );

  assert.deepEqual(sent, ['记下了']);
});

test('GUI 直接触发的轮次不推微信', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  await assistant.ensureSession();

  // 没有 deliver，直接从 turn/start 开始，模拟用户在 GUI 里打字
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 1 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 1, source: { kind: 'user' } } });
  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '这是 GUI 的回复' }] } } },
  );

  assert.deepEqual(sent, []);
});

test('别的会话的事件一律忽略', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assistant.onSessionEvent({ id: 'other:session' }, { type: 'turn/start', data: { turn: 1 } });
  assistant.onSessionEvent({ id: 'other:session' }, { type: 'user/message', data: { turn: 1, source: { rpcId } } });
  assistant.onSessionEvent(
    { id: 'other:session' },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '不该推' }] } } },
  );

  // pending 还在，说明没被别的会话消费掉
  assert.equal(assistant.pending.size, 1);
  assert.deepEqual(sent, []);
});

test('含工具调用的中间叙述不投递', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '帮我看下', contextToken: 'c' });

  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 1 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 1, source: { rpcId } } });
  assistant.onSessionEvent(
    { id: SESSION_ID },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: { content: [{ type: 'text', text: '我去查一下' }, { type: 'tool-call', name: 'kb_search' }] },
      },
    },
  );

  assert.deepEqual(sent, []);
});

test('同一轮结束后不再重复投递', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 3 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 3, source: { rpcId } } });
  const message = { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '好的' }] } } };
  assistant.onSessionEvent({ id: SESSION_ID }, message);
  assistant.onSessionEvent({ id: SESSION_ID }, message);

  assert.deepEqual(sent, ['好的', '好的']);

  // turn/end 之后该轮归属被清掉，后续同轮消息不再推
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'ok' } } });
  assistant.onSessionEvent({ id: SESSION_ID }, message);
  assert.deepEqual(sent, ['好的', '好的']);
});

test('回合失败时推一条失败提示', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 2 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 2, source: { rpcId } } });
  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '模型超时' } } } },
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0], /没有生成回复/);
});

test('被取消、被拦、超长截断这几种结束方式也要给用户一句反馈', async () => {
  const cases = [
    ['aborted', /被取消/],
    ['blocked', /没跑起来/],
    ['max-tokens', /被截断/],
  ];
  for (const [kind, pattern] of cases) {
    const { ctx } = fakeCtx();
    const sent = [];
    const assistant = buildAssistant(ctx, sent);
    const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

    assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 3 } });
    assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 3, source: { rpcId } } });
    assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 3, reason: { kind } } });

    assert.equal(sent.length, 1, `${kind} 应该推一条`);
    assert.match(sent[0], pattern, `${kind} 的文案不对`);
  }
});

test('正常结束不多嘴，只有正文', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  const rpcId = await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 4 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 4, source: { rpcId } } });
  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '记好了' }] } } },
  );
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });

  assert.deepEqual(sent, ['记好了']);
});

test('sweepStale 清掉超时的待归属轮次', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });
  assert.equal(assistant.pending.size, 1);

  // 把所有 pending 的时间戳往前拨 20 分钟
  for (const value of assistant.pending.values()) value.at -= 20 * 60 * 1000;
  assistant.sweepStale(15 * 60 * 1000);
  assert.equal(assistant.pending.size, 0);
});

// 回归：曾经 pending 一被搬到 turns 就空了，sweepStale 顺手把 turns 也清掉，
// 模型超过清扫间隔才回复（调工具几乎必然超过）时整条回复被丢，用户在微信里永远等不到。
test('模型回复慢于清扫间隔时，回复仍然推得出去', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  await assistant.deliver({ chatId: 'u1', text: '帮我查一下', contextToken: 'c' });

  const rpcId = [...assistant.pending.keys()][0];
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 7 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 7, source: { rpcId } } });
  assert.equal(assistant.pending.size, 0);
  assert.equal(assistant.turns.size, 1);

  // 宿主每 60 秒清扫一次，此时模型还在调工具，这一轮还没结束
  assistant.sweepStale(15 * 60 * 1000);
  assert.equal(assistant.turns.size, 1, '还没到超时，不该被清掉');

  assistant.onSessionEvent(
    { id: SESSION_ID },
    { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '查好了' }] } } },
  );
  assert.deepEqual(sent, ['查好了']);
});

test('sweepStale 也会清掉超时未结束的轮次', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  const rpcId = [...assistant.pending.keys()][0];
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 3 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 3, source: { rpcId } } });

  for (const value of assistant.turns.values()) value.at -= 20 * 60 * 1000;
  assistant.sweepStale(15 * 60 * 1000);
  assert.equal(assistant.turns.size, 0);
});

test('dispose 之后不再推消息', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const assistant = buildAssistant(ctx, sent);
  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });
  await assistant.dispose();
  assert.equal(assistant.pending.size, 0);
});

// ── 「正在输入」状态 ─────────────────────────────────────
function fakeTyping() {
  const events = [];
  return {
    events,
    start(payload) {
      events.push(['start', payload]);
    },
    async stop() {
      events.push(['stop']);
    },
  };
}

test('收到微信消息就把正在输入点起来', async () => {
  const { ctx } = fakeCtx();
  const sent = [];
  const typing = fakeTyping();
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async (text) => {
      sent.push(text);
      return true;
    },
    typing,
    buildTools: () => [],
  });

  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });
  assert.deepEqual(typing.events, [['start', { toUserId: 'u1', contextToken: 'c' }]]);
});

test('一轮结束时撤掉正在输入', async () => {
  const { ctx } = fakeCtx();
  const typing = fakeTyping();
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    typing,
    buildTools: () => [],
  });

  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });
  const rpcId = [...assistant.pending.keys()][0];
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 2 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'user/message', data: { turn: 2, source: { rpcId } } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'ok' } } });

  assert.deepEqual(typing.events.filter((e) => e[0] === 'stop').length, 1);
});

test('没有认领到轮次的消息，轮次结束时也要把正在输入收掉', async () => {
  const { ctx } = fakeCtx();
  const typing = fakeTyping();
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    typing,
    buildTools: () => [],
  });

  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/start', data: { turn: 9 } });
  assistant.onSessionEvent({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'ok' } } });

  assert.equal(typing.events.filter((e) => e[0] === 'stop').length, 1);
});

test('会话建不起来时不能一直挂着正在输入', async () => {
  const typing = fakeTyping();
  const ctx = {
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    typing,
    buildTools: () => [],
  });

  await assert.rejects(() => assistant.deliver({ chatId: 'u1', text: '在吗', contextToken: 'c' }), /agents/);
  assert.equal(typing.events.filter((e) => e[0] === 'stop').length, 1);
});

// 带图的投递必须走 sessionController：agent.followup 不做附件准入，
// 图片块里的 base64 会被丢掉，模型根本看不到图。
function ctxWithController(prompts, followups) {
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('no session');
    },
    create: async (options) => ({
      agent: {
        session: { id: options.sessionId },
        followup: (message) => followups.push(message),
      },
      dispose: async () => {},
    }),
    withoutInitiator: (fn) => fn(),
  };
  return {
    get: (name) => {
      if (name === 'agents') return agents;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'sessionController') {
        return {
          prompt: async (request) => {
            prompts.push(request);
            return { accepted: true };
          },
        };
      }
      return undefined;
    },
  };
}

test('有图片时走 sessionController.prompt，不走 followup', async () => {
  const prompts = [];
  const followups = [];
  const ctx = ctxWithController(prompts, followups);
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
    buildMedia: async () => ({ content: [{ type: 'image', data: 'QUJD', mediaType: 'image/png' }], saved: [], failed: [] }),
  });

  const rpcId = await assistant.deliver({
    chatId: 'u1',
    text: '这张截图里的活帮我记一下',
    contextToken: 'c',
    media: [{ kind: 'image', mediaRef: { encrypt_query_param: 'q' } }],
  });

  assert.equal(prompts.length, 1, '应该走 prompt');
  assert.equal(followups.length, 0, '不该走 followup');
  assert.equal(prompts[0].requestId, rpcId);
  assert.equal(prompts[0].sessionId, SESSION_ID);
  assert.equal(prompts[0].mode, 'queue');
  assert.deepEqual(prompts[0].content[0], { type: 'text', text: '这张截图里的活帮我记一下' });
  assert.equal(prompts[0].content[1].type, 'image');
});

test('纯文本仍然走 followup，不惊动 sessionController', async () => {
  const prompts = [];
  const followups = [];
  const ctx = ctxWithController(prompts, followups);
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
  });

  await assistant.deliver({ chatId: 'u1', text: '记一下', contextToken: 'c' });

  assert.equal(prompts.length, 0);
  assert.equal(followups.length, 1);
  assert.deepEqual(followups[0].content, [{ type: 'text', text: '记一下' }]);
});

test('宿主没有 sessionController 时降级成纯文本，消息不能丢', async () => {
  const followups = [];
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('no session');
    },
    create: async (options) => ({
      agent: { session: { id: options.sessionId }, followup: (m) => followups.push(m) },
      dispose: async () => {},
    }),
    withoutInitiator: (fn) => fn(),
  };
  const ctx = {
    get: (name) =>
      name === 'agents'
        ? agents
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
    buildMedia: async () => ({ content: [{ type: 'image', data: 'QUJD', mediaType: 'image/png' }], saved: [], failed: [] }),
  });

  await assistant.deliver({ chatId: 'u1', text: '看图', contextToken: 'c', media: [{ kind: 'image' }] });

  assert.equal(followups.length, 1, '必须退化成一条文本');
  assert.match(followups[0].content[0].text, /图片没能交给模型/);
});

test('附件取不下来时也要把文字发出去', async () => {
  const followups = [];
  const ctx = ctxWithController([], followups);
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
    buildMedia: async () => {
      throw new Error('网络炸了');
    },
  });

  await assistant.deliver({ chatId: 'u1', text: '看图', contextToken: 'c', media: [{ kind: 'image' }] });

  assert.equal(followups.length, 1);
  assert.match(followups[0].content[0].text, /^看图/);
  assert.match(followups[0].content[1].text, /没能处理/);
});

test('助手会话里屏蔽掉只在电脑界面才有意义的工具', async () => {
  const denied = [];
  const registered = [];
  const ctx = {
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [{ name: 'work_capture' }],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: {
      register: (tool) => registered.push(tool.name),
      restrict: (filter) => denied.push(...(filter.deny ?? [])),
      guard: () => () => {},
    },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.deepEqual(registered, ['work_capture']);
  assert.deepEqual(denied, ['present', 'visualize', 'ask_user_question']);
});

test('某个工具在当前环境不存在时，其余屏蔽照旧生效', async () => {
  const denied = [];
  const ctx = { get: () => undefined };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: {
      register: () => {},
      restrict: (filter) => {
        const name = filter.deny[0];
        // 模拟宿主没注册 visualize 的情况：restrict 抛 unknown global tool
        if (name === 'visualize') throw new Error('tools.restrict() names unknown global tool "visualize"');
        denied.push(name);
      },
      guard: () => () => {},
    },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.deepEqual(denied, ['present', 'ask_user_question']);
});

// 这是丢文件那件事的回归测试。present / visualize 是 agent preset 带进来的，
// 预设没挂完时 restrict 看不见它们，会抛 unknown global tool 被静默吞掉。
// 所以必须等挂载完成再 restrict，否则「屏蔽」是句空话。
test('等预设挂完再屏蔽，不然 restrict 看不见预设带进来的工具', async () => {
  const order = [];
  const mounted = [];
  const ctx = {
    get: (name) => {
      if (name === 'agentPresets') {
        return {
          mount: async () => {
            // 模拟真实时序：挂载是异步的，完成之后 present 才出现在名单里
            await new Promise((resolve) => setTimeout(resolve, 5));
            mounted.push('present', 'visualize', 'ask_user_question');
            order.push('mount-done');
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    agentPreset: 'standard',
    send: async () => true,
    buildTools: () => [],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: {
      register: () => {},
      restrict: (filter) => {
        const name = filter.deny[0];
        order.push(`restrict:${name}`);
        // 真实宿主的行为：名字还没出现就报错
        if (!mounted.includes(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"`);
      },
      guard: () => () => {},
    },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.equal(order[0], 'mount-done', '必须先挂完预设再 restrict');
  assert.deepEqual(order.slice(1), ['restrict:present', 'restrict:visualize', 'restrict:ask_user_question']);
});

// 名单是挂载快照，时序一变就可能漏。执行期的 guard 不依赖名单，
// 名字对上就直接拒绝 —— 这是最后一道硬闸。
test('执行期闸门拦住 present，并让模型改用 work_send_file', async () => {
  let installed;
  const ctx = { get: () => undefined };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: {
      register: () => {},
      restrict: () => () => {},
      guard: (fn) => {
        installed = fn;
        return () => {};
      },
    },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.equal(typeof installed, 'function');
  const reason = installed({ name: 'present' });
  assert.match(reason, /work_send_file/);
  assert.equal(installed({ name: 'work_send_file' }), undefined);
  assert.equal(installed({ name: 'work_capture' }), undefined);
  assert.equal(installed({}), undefined);
});

// 这是「微信里说工具不存在」那件事的回归测试。
// 会话可能已经被 GUI 点开过，宿主自己建的 agent 只挂了那一侧的预设，台账工具一个都没有。
// 复用这种会话之前必须把本插件的范围补挂上去，否则模型手里空无一物。
test('复用一个已经开着的会话时，要就地把工具与人格补挂上去', async () => {
  const registered = [];
  const sections = [];
  const live = {
    session: { id: 'wa:main' },
    ctx: {
      tools: {
        register: (tool) => registered.push(tool.name),
        restrict: () => {},
        guard: () => () => {},
      },
      systemPrompt: { section: (section) => sections.push(section.name) },
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: (id) => (id === 'wa:main' ? live : undefined) };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    agentPreset: 'xiaozhui',
    send: async () => true,
    buildTools: () => [{ name: 'work_capture' }, { name: 'work_list' }],
  });

  const handle = await assistant.ensureSession();

  assert.equal(handle.agent, live);
  assert.deepEqual(registered, ['work_capture', 'work_list']);
  assert.deepEqual(sections, ['work-assistant']);

  // 同一个 agent 再进一次不该重复注册（宿主会因为重名直接抛错）
  await assistant.ensureSession();
  assert.deepEqual(registered, ['work_capture', 'work_list']);
});

// 「already owned by an active write handle」是真实遇到过的死路：
// 恢复说被占用、新建说已存在，消息直接丢。这里要能退让一步把还活着的会话接管下来。
test('会话被写句柄占着时，退让一下接管活着的会话，而不是把消息丢了', async () => {
  const registered = [];
  let probes = 0;
  const live = {
    session: { id: 'wa:main' },
    ctx: {
      tools: {
        register: (tool) => registered.push(tool.name),
        restrict: () => {},
        guard: () => () => {},
      },
      systemPrompt: { section: () => {} },
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'agents') {
        return {
          // 第一次看还没活，重试的时候已经在了
          get: () => (++probes === 1 ? undefined : live),
          resume: async () => {
            throw new Error('session "wa:main" is already owned by an active write handle');
          },
          create: async () => {
            throw new Error('session "wa:main" already exists');
          },
          withoutInitiator: (fn) => fn(),
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [{ name: 'work_capture' }],
  });

  const handle = await assistant.ensureSession();

  assert.equal(handle.agent, live);
  assert.deepEqual(registered, ['work_capture']);
});

// GUI 里点开会话直接聊的时候，宿主那侧建 agent 不会经过我们的 setup。
// turn/start 是唯一能察觉到的时机：补挂一次，下一轮工具就回来了。
test('GUI 里打开的会话开跑时，顺手把台账工具补挂上', async () => {
  const registered = [];
  const live = {
    session: { id: 'wa:main' },
    ctx: {
      tools: {
        register: (tool) => registered.push(tool.name),
        restrict: () => {},
        guard: () => () => {},
      },
      systemPrompt: { section: () => {} },
    },
  };
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: () => live };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [{ name: 'work_capture' }],
  });

  assistant.onSessionEvent({ id: 'wa:main' }, { type: 'turn/start', data: { turn: 9 } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(registered, ['work_capture']);
});

// 预设是「这个会话是谁」的来源：人格、称呼、语气、以及它带进来的那批工具。
// 没选预设时不能自己编一个名字（老版本写死 'standard'），要让宿主用它自己的默认 ——
// 插件装到别人机器上时，他那边的默认预设才是对的。
test('没指定预设就挂宿主默认，不去猜一个名字', async () => {
  const calls = [];
  const ctx = {
    get: (name) => {
      if (name === 'agentPresets') {
        return {
          mount: async (...args) => {
            calls.push(args);
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: {},
    log: () => {},
    cwd: 'C:/tmp',
    agentPreset: '',
    send: async () => true,
    buildTools: () => [],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: { register: () => {}, restrict: () => {}, guard: () => () => {} },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [agentCtx], 'mount 不传 id 就是挂宿主默认预设');
});

// 预设名可能是从别人机器上抄来的，或者后来被删了。
// 这种时候退回默认还能聊，直接抛出去用户看到的是「机器人死了」。
test('预设挂不上就退回宿主默认，不让会话起不来', async () => {
  const logs = [];
  const calls = [];
  const ctx = {
    get: (name) => {
      if (name === 'agentPresets') {
        return {
          mount: async (...args) => {
            calls.push(args);
            if (args.length > 1) throw new Error('agent-preset/unknown: 没有这个预设');
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const assistant = new Assistant({
    ctx,
    config: { agentPreset: '别人机器上的预设' },
    log: (line) => logs.push(line),
    cwd: 'C:/tmp',
    send: async () => true,
    buildTools: () => [],
  });
  const agentCtx = {
    agent: { session: { id: 'wa:main' } },
    tools: { register: () => {}, restrict: () => {}, guard: () => () => {} },
    systemPrompt: { section: () => {} },
  };

  await assistant.setupScope(agentCtx);

  assert.equal(calls.length, 2, '先按用户选的挂，失败再挂默认');
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[1], [agentCtx]);
  assert.ok(logs.some((line) => line.includes('改用宿主默认')));
});

