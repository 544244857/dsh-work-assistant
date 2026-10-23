import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssignmentStore } from '../lib/assignments.js';
import { assignmentPrompt, createAssignmentRuntime } from '../lib/assignment-runtime.js';
import { dataPaths } from '../lib/paths.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-21T03:00:00.000Z'); // 2026-10-21 11:00 +08:00

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-runtime-'));
  return dataPaths(dir);
}

// 假 agents：能记录 create/resume 的参数，也能模拟失败
function fakeAgents(options = {}) {
  const live = new Map();
  const created = [];
  const resumed = [];
  const agents = {
    get: (sessionId) => live.get(sessionId),
    create: async (opts) => {
      if (options.failCreate) throw new Error(options.failCreate);
      created.push(opts);
      const agent = fakeAgent(opts.sessionId);
      // 宿主会 await setup(agentCtx, agent)，这里也照着调，才能验证注册顺序
      if (options.setupWithoutAgent) await opts.setup?.({ tools: { register: () => {} }, systemPrompt: { section: () => {} } });
      else await opts.setup?.({ agent, tools: { register: () => {} }, systemPrompt: { section: () => {} } }, agent);
      live.set(opts.sessionId, agent);
      const handle = { agent, dispose: async () => { live.delete(opts.sessionId); } };
      return handle;
    },
    resume: async (opts) => {
      if (options.failResume) throw new Error(options.failResume);
      resumed.push(opts);
      const agent = fakeAgent(opts.resumeSessionId);
      live.set(opts.resumeSessionId, agent);
      return { agent, dispose: async () => { live.delete(opts.resumeSessionId); } };
    },
    withoutInitiator: (fn) => fn(),
  };
  return { agents, created, resumed, live };
}

function fakeAgent(sessionId) {
  return {
    session: { id: sessionId },
    inbox: [],
    inject(message) {
      this.inbox.push({ mode: 'inject', message });
    },
    steer(message) {
      this.inbox.push({ mode: 'steer', message });
    },
    followup(message) {
      this.inbox.push({ mode: 'followup', message });
    },
  };
}

function build(overrides = {}) {
  const paths = overrides.paths ?? scratch();
  const store = createAssignmentStore(paths, { log: () => {}, limit: overrides.limit ?? 3 });
  const fake = fakeAgents(overrides.agents);
  const pushed = [];
  const mounted = [];
  const registered = [];
  const sections = [];
  const permissions = [];
  const ctx = {
    get: (name) => {
      if (name === 'agents') return fake.agents;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }) };
      if (name === 'agentPresets') {
        // mount 不传 id 就是「挂宿主默认预设」，所以要把参数个数也记下来
        const mount = overrides.mount ?? (async (agentCtx, preset) => {
          mounted.push(preset);
        });
        return { mount };
      }
      if (name === 'permissionPresets') {
        return {
          set: (session, preset) => {
            permissions.push({ sessionId: session?.id ?? null, preset });
          },
        };
      }
      if (name === 'sessionQuery') return overrides.sessionQuery;
      return undefined;
    },
  };
  const runtime = createAssignmentRuntime({
    ctx,
    store,
    config: { maxAssignments: overrides.limit ?? 3, assignmentPreset: 'standard', timeZone: TZ },
    log: () => {},
    push: async (text) => {
      pushed.push(text);
      return true;
    },
    buildReportTools: (assignment) => [
      {
        name: 'assign_report',
        assignment: assignment.id,
        async execute() {
          return { summary: 'ok', data: {} };
        },
      },
    ],
    now: () => NOW,
    ...overrides.runtime,
  });
  return { paths, store, runtime, fake, pushed, mounted, registered, sections, permissions, ctx };
}

test('create 建会话时把 cwd 和 agentPreset 传进 meta', async () => {
  const { runtime, fake } = build({ runtime: { config: { maxAssignments: 3, assignmentPreset: 'standard', assignmentCwd: 'C:/work' } } });
  const { assignment } = await runtime.create({ purpose: '整理报销表' });

  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].sessionId, 'wa:asg:a-20261021-001');
  assert.equal(fake.created[0].meta.cwd, 'C:/work');
  assert.equal(fake.created[0].meta.agentPreset, 'standard');
  assert.equal(assignment.sessionId, 'wa:asg:a-20261021-001');
  assert.equal(assignment.status, 'idle');
});

test('create 时会话已经活着就复用，不再 create', async () => {
  const paths = scratch();
  const fake = fakeAgents();
  const existing = fakeAgent('wa:asg:a-20261021-001');
  fake.live.set('wa:asg:a-20261021-001', existing);
  const store = createAssignmentStore(paths, { log: () => {} });
  const runtime = createAssignmentRuntime({
    ctx: {
      get: (name) =>
        name === 'agents'
          ? fake.agents
          : name === 'agentDefaultModel'
            ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
            : undefined,
    },
    store,
    config: { maxAssignments: 3, assignmentPreset: 'standard', timeZone: TZ },
    log: () => {},
    push: async () => true,
    buildReportTools: () => [],
    now: () => NOW,
  });

  const { assignment } = await runtime.create({ purpose: '复用' });
  assert.equal(fake.created.length, 0);
  assert.equal(assignment.sessionId, 'wa:asg:a-20261021-001');
});

test('超过上限时 create 抛 ASSIGN_LIMIT_REACHED', async () => {
  const { runtime } = build({ limit: 1 });
  await runtime.create({ purpose: '一' });
  await assert.rejects(() => runtime.create({ purpose: '二' }), (err) => {
    assert.equal(err.code, 'ASSIGN_LIMIT_REACHED');
    assert.equal(err.limit, 1);
    assert.equal(err.active, 1);
    return true;
  });
});

test('create 建会话失败会把登记簿标成 stopped，不占名额', async () => {
  const { runtime, fake } = build({ agents: { failCreate: '炸了' } });
  await assert.rejects(() => runtime.create({ purpose: '建不起来' }), /副手会话建不起来/);
  assert.equal(fake.created.length, 0);
  const list = await runtime.list({ status: 'stopped' });
  assert.equal(list.total, 1);
  assert.match(list.items[0].stopReason, /炸了/);
  assert.equal(await runtime.activeCount(), 0);
});

// 宿主的 create 只跑 setup + publish，不会凭空起一轮：kick() 只在 wakeDriver
// 和 turn 循环里被调。所以 create 必须自己投一条 followup，否则副手建出来就躺着不动。
test('create 建完立刻投一条 followup，让副手真的开工', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '整理报销单' });
  const agent = fake.live.get(assignment.sessionId);

  assert.equal(agent.inbox.length, 1);
  const [first] = agent.inbox;
  assert.equal(first.mode, 'followup', '只有 followup 会唤醒它，inject 不会');
  assert.equal(first.message.role, 'user');
  assert.equal(typeof first.message.id, 'string');
  assert.match(first.message.content[0].text, /开始干活：整理报销单/);
});

test('send 三档分别调 inject / steer / followup', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '三档' });
  const agent = fake.live.get(assignment.sessionId);
  // create 自己会踢一脚让它开工，这里只看 send 的三档，先清掉
  agent.inbox.length = 0;

  await runtime.send(assignment.id, '只补背景', 'context-update');
  await runtime.send(assignment.id, '下一步看', 'next-step');
  await runtime.send(assignment.id, '新的一轮', 'next-turn');

  assert.deepEqual(agent.inbox.map((x) => x.mode), ['inject', 'steer', 'followup']);
  assert.deepEqual(agent.inbox.map((x) => x.message.content[0].text), ['只补背景', '下一步看', '新的一轮']);
});

// 宿主写进会话时会校验 id 非空、role 是 user；inbox 还要求 id 唯一。
// 少一个字段就会在投递那一刻炸，而且是运行期才炸，测试不覆盖就只能等真机。
// 用户说停掉之后，副手可能还有一份报告在路上。报告本身可以留档，
// 但不能再往微信推、也不能把状态从 stopped 复活。
test('停掉的副手交报告会被拒，不推微信也不改状态', async () => {
  const { runtime, pushed } = build();
  const { assignment } = await runtime.create({ purpose: '停掉之后别交报告' });
  await runtime.stop(assignment.id, '不需要了');
  const before = pushed.length;

  await assert.rejects(() => runtime.report(assignment.id, { summary: '迟到的报告' }), /已经停掉了，报告不再接收/);
  assert.equal(pushed.length, before, '叫停之后不许再往微信推');
  assert.equal((await runtime.get(assignment.id)).status, 'stopped');
});

test('send 投递的消息带 id 和 role，且两次投递 id 不同', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '消息形状' });
  const agent = fake.live.get(assignment.sessionId);

  await runtime.send(assignment.id, '第一句');
  await runtime.send(assignment.id, '第二句');

  const [first, second] = agent.inbox.map((x) => x.message);
  assert.equal(first.role, 'user');
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0);
  assert.equal(first.source.kind, 'work-assistant');
  assert.notEqual(first.id, second.id);
});

test('send 失败不重试：只调一次就抛', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '投递失败' });
  const agent = fake.live.get(assignment.sessionId);
  let calls = 0;
  agent.followup = () => {
    calls += 1;
    throw new Error('宿主拒收');
  };

  await assert.rejects(() => runtime.send(assignment.id, '一句话'), /宿主拒收/);
  assert.equal(calls, 1);
});

test('send 空消息直接报错', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '空消息' });
  await assert.rejects(() => runtime.send(assignment.id, '   '), /message 不能为空/);
});

// 用户在 GUI 里把副手会话关掉（或宿主重启），内存里缓存的 handle 就成了僵尸：
// 它指向的 agent 已经 disposed，再往里投递只会抛 "agent is disposed"。
// 这种时候必须丢掉缓存、走 resume 把会话接回来，否则「派活」从此哑火。
test('缓存的 handle 变成僵尸之后，send 会丢掉缓存并恢复会话', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '僵尸句柄' });
  const dead = fake.live.get(assignment.sessionId);
  // 模拟宿主把它拆了：内存里没有了，旧引用还能调用但会抛
  dead.followup = () => {
    throw new Error('agent is disposed');
  };
  fake.live.delete(assignment.sessionId);

  await runtime.send(assignment.id, '接着干');

  const revived = fake.live.get(assignment.sessionId);
  assert.ok(revived, '应该恢复出一个新的会话');
  assert.notEqual(revived, dead);
  assert.equal(fake.resumed.length, 1);
  assert.equal(revived.inbox.at(-1).message.content[0].text, '接着干');
});

// 失联期间不占名额，这期间用户可能又派满了新的。直接恢复会悄悄突破上限。
test('恢复失联副手前复查名额，超了就拦住', async () => {
  const { runtime, store, fake } = build({ limit: 1 });
  const first = await runtime.create({ purpose: '老的' });
  // 模拟插件重启：登记簿标成失联，宿主的活会话表里也没有它了（真实重启后就是空表）
  await store.mutate((book) => {
    const item = book.items.find((x) => x.id === first.assignment.id);
    item.status = 'offline';
    return item;
  });
  fake.live.delete(first.assignment.sessionId);
  const second = await runtime.create({ purpose: '新的' });
  await assert.rejects(() => runtime.ensure(first.assignment.id), (err) => {
    assert.equal(err.code, 'ASSIGN_LIMIT_REACHED');
    return true;
  });
  assert.equal((await runtime.get(second.assignment.id)).status, 'idle');
});

test('stop 会调 handle.dispose 并标 stopped', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '停掉' });
  const { assignment: stopped, released, sessionActive } = await runtime.stop(assignment.id, '不需要了');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReason, '不需要了');
  assert.equal(released, true);
  assert.equal(sessionActive, false);
  assert.equal(fake.live.has(assignment.sessionId), false);
});

// 插件重载后 handles 是空的，但副手会话可能还在跑。光把登记簿标成 stopped 不真停，
// 它会继续烧 token，名额也一直占着。所以要再问宿主一次，把活的会话 cancel 掉。
test('stop 对缓存里没有、但宿主里还活着的会话也发 cancel', async () => {
  const paths = scratch();
  const fake = fakeAgents();
  const store = createAssignmentStore(paths, { log: () => {} });
  const runtime = createAssignmentRuntime({
    ctx: { get: (name) => (name === 'agents' ? fake.agents : undefined) },
    store,
    config: { maxAssignments: 3, assignmentPreset: 'standard', timeZone: TZ },
    log: () => {},
    push: async () => true,
    buildReportTools: () => [],
    now: () => NOW,
  });
  const { assignment } = await runtime.create({ purpose: '重载后停' });
  // 模拟插件重载：新 runtime 没有缓存，但宿主里的会话还在
  const fresh = createAssignmentRuntime({
    ctx: { get: (name) => (name === 'agents' ? fake.agents : undefined) },
    store,
    config: { maxAssignments: 3, assignmentPreset: 'standard', timeZone: TZ },
    log: () => {},
    push: async () => true,
    buildReportTools: () => [],
    now: () => NOW,
  });
  const live = fake.live.get(assignment.sessionId);
  let cancelled = null;
  live.cancel = (cause) => {
    cancelled = cause;
  };

  const { assignment: stopped, released, sessionActive } = await fresh.stop(assignment.id, '不用了');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(cancelled, { kind: 'user' });
  // 这个会话是上一个 runtime 开的，新 runtime 只能 cancel，拿不到 dispose
  assert.equal(released, false);
  // 会话确实还在跑，回执要能区分「只能叫停」和「本来就没跑」
  assert.equal(sessionActive, true);
});

test('report 落盘并推微信，expectsReply 让状态变成 waiting', async () => {
  const { runtime, pushed } = build();
  const { assignment } = await runtime.create({ purpose: '交报告' });
  const result = await runtime.report(assignment.id, { summary: '做完了', detail: '文件在 a.xlsx' });

  assert.equal(result.assignment.status, 'done');
  assert.equal(result.assignment.report.summary, '做完了');
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /副手 a-20261021-001 交活了：做完了/);

  const waiting = await runtime.report(assignment.id, { summary: '要你拍板', expectsReply: true });
  assert.equal(waiting.assignment.status, 'waiting');
  assert.match(pushed[1], /它在等你回话/);
});

test('report 推送失败时报告照样落盘，pushed 为 false', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  const fake = fakeAgents();
  const runtime = createAssignmentRuntime({
    ctx: {
      get: (name) =>
        name === 'agents'
          ? fake.agents
          : name === 'agentDefaultModel'
            ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
            : undefined,
    },
    store,
    config: { maxAssignments: 3, timeZone: TZ },
    log: () => {},
    push: async () => {
      throw new Error('没登录');
    },
    buildReportTools: () => [],
    now: () => NOW,
  });

  const { assignment } = await runtime.create({ purpose: '推不出去' });
  const result = await runtime.report(assignment.id, { summary: '存下来就行' });
  assert.equal(result.pushed, false);
  assert.equal(result.assignment.report.summary, '存下来就行');
});

test('inspect 只取最后 4 条，每条不超过 3000 字', async () => {
  const long = 'x'.repeat(5000);
  const records = [
    { type: 'turn/start', text: '' },
    { type: 'tool/call', text: 'bash\nls' },
    { type: 'tool/result', text: 'a'.repeat(100) },
    { type: 'assistant/message', text: '中间叙述' },
    { type: 'user/message', text: '用户说的' },
    { type: 'tool/result', text: long },
    { type: 'assistant/message', text: '最后一句' },
    { type: 'turn/end', text: '' },
  ];
  const { runtime } = build({ sessionQuery: { listEvents: async () => records } });
  const { assignment } = await runtime.create({ purpose: '看尾巴' });
  const { tail } = await runtime.inspect(assignment.id);

  assert.ok(tail.length <= 4, `tail 最多 4 条，实际 ${tail.length}`);
  for (const line of tail) assert.ok(line.length <= 3000, `单条不超过 3000 字，实际 ${line.length}`);
});

test('inspect 找不到副手会抛错', async () => {
  const { runtime } = build();
  await assert.rejects(() => runtime.inspect('a-20261021-999'), /找不到副手/);
});

test('reconcile 把拿不到会话的活跃副手标 offline', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  const fake = fakeAgents();
  const runtime = createAssignmentRuntime({
    ctx: {
      get: (name) =>
        name === 'agents'
          ? fake.agents
          : name === 'agentDefaultModel'
            ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
            : undefined,
    },
    store,
    config: { maxAssignments: 3, timeZone: TZ },
    log: () => {},
    push: async () => true,
    buildReportTools: () => [],
    now: () => NOW,
  });

  const { assignment } = await runtime.create({ purpose: '重启后失联' });
  // 模拟宿主重启：会话全没了
  fake.live.clear();

  const result = await runtime.reconcile();
  assert.equal(result.offline, 1);
  const after = await runtime.get(assignment.id);
  assert.equal(after.status, 'offline');
});

test('reconcile 对已经结束的副手不折腾', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '已结束' });
  await runtime.stop(assignment.id, '完事');
  fake.live.clear();
  const result = await runtime.reconcile();
  assert.equal(result.offline, 0);
  assert.equal(result.restored, 0);
});

test('turn/start 标 running，turn/end 标 idle；副手事件不推微信', async () => {
  const { runtime, store, pushed } = build();
  const { assignment } = await runtime.create({ purpose: '状态跟着走' });
  const session = { id: `wa:asg:${assignment.id}` };

  runtime.onSessionEvent(session, { type: 'turn/start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(assignment.id)).status, 'running');

  runtime.onSessionEvent(session, { type: 'turn/end' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(assignment.id)).status, 'idle');
  assert.equal(pushed.length, 0);
});

test('非副手会话的事件被忽略', async () => {
  const { runtime, store } = build();
  const { assignment } = await runtime.create({ purpose: '别乱动' });
  runtime.onSessionEvent({ id: 'wa:main' }, { type: 'turn/start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(assignment.id)).status, 'idle');
});

test('turn/end 不会把 waiting 覆盖成 idle', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '等回话' });
  await runtime.report(assignment.id, { summary: '要你定', expectsReply: true });
  runtime.onSessionEvent({ id: `wa:asg:${assignment.id}` }, { type: 'turn/end' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(assignment.id)).status, 'waiting');
});

test('停掉之后又来 turn/start，不会把副手复活成 running', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '停掉就别动了' });
  await runtime.stop(assignment.id, '不需要了');
  runtime.onSessionEvent({ id: `wa:asg:${assignment.id}` }, { type: 'turn/start' });
  await new Promise((resolve) => setImmediate(resolve));
  const after = await runtime.get(assignment.id);
  assert.equal(after.status, 'stopped');
  assert.equal(await runtime.activeCount(), 0, '停掉的副手不能继续占名额');
});

test('交过报告的副手再来 turn/start，不会把 done 改回 running', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '交完就收工' });
  await runtime.report(assignment.id, { summary: '干完了' });
  runtime.onSessionEvent({ id: `wa:asg:${assignment.id}` }, { type: 'turn/start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(assignment.id)).status, 'done');
});

test('停掉的副手不能再 send，免得会话被重新拉起来', async () => {
  const { runtime, fake } = build();
  const { assignment } = await runtime.create({ purpose: '停了就停' });
  await runtime.stop(assignment.id, '不需要了');
  await assert.rejects(() => runtime.send(assignment.id, '再干点活'), /已经停掉了/);
  assert.equal(fake.created.length, 1, '不该为停掉的副手再建会话');
});

// 「交过活 → 再派活」等于重新占一个名额。名额满了还先把话投出去，
// 副手就会真开工，而登记簿只能留在 done —— 名额永久漏算，面板也看不出来。
test('名额满了就给交过活的副手补话会被拦住，话也不投出去', async () => {
  const { runtime, fake } = build({ limit: 1 });
  const first = await runtime.create({ purpose: '老的' });
  await runtime.report(first.assignment.id, { summary: '干完了' });
  assert.equal(await runtime.activeCount(), 0);
  await runtime.create({ purpose: '新的' }); // 占满唯一的位子

  const agent = fake.live.get(first.assignment.sessionId);
  const inboxBefore = agent.inbox.length; // create 会自己踢一脚，先把基准记下来
  await assert.rejects(() => runtime.send(first.assignment.id, '再干点'), (err) => {
    assert.equal(err.code, 'ASSIGN_LIMIT_REACHED');
    return true;
  });
  assert.equal(agent.inbox.length, inboxBefore, '名额不够就不该把话投出去');
  assert.equal((await runtime.get(first.assignment.id)).status, 'done');
});

// 从 done 交一份「等回话」的报告会把状态推回 waiting（活跃态），名额满了不能真给它占位。
// 但报告本身是副手说的话，不能因为占不到位就整份丢掉 —— 用户看到「名额已满」
// 却看不到副手问了什么，那条线索就永远断了。
test('名额满了，等回话的报告照样收下，只是状态不切到 waiting', async () => {
  const { runtime, pushed } = build({ limit: 1 });
  const first = await runtime.create({ purpose: '老的' });
  await runtime.report(first.assignment.id, { summary: '干完了' });
  await runtime.create({ purpose: '新的' });
  const pushedBefore = pushed.length;

  const result = await runtime.report(first.assignment.id, { summary: '还想问一句', expectsReply: true });
  assert.equal(result.slotBlocked, true);
  assert.equal(result.assignment.status, 'done');
  assert.equal(result.assignment.report.summary, '还想问一句');
  // 话还是要送到用户手上，否则他不知道副手卡在哪个问题上
  assert.equal(pushed.length, pushedBefore + 1);
  assert.match(pushed.at(-1), /还想问一句/);
  assert.match(pushed.at(-1), /名额已经开满了/);
  assert.equal((await runtime.get(first.assignment.id)).status, 'done');
});

// 失联的副手又被唤醒（turn/start）等于复活，名额满了就让它继续失联。
test('名额满了，失联的副手不会被 turn/start 悄悄复活', async () => {
  const { runtime, store } = build({ limit: 1 });
  const first = await runtime.create({ purpose: '失联的' });
  await store.mutate((book) => {
    const item = book.items.find((x) => x.id === first.assignment.id);
    item.status = 'offline';
    return item;
  });
  await runtime.create({ purpose: '占位的' });

  runtime.onSessionEvent({ id: `wa:asg:${first.assignment.id}` }, { type: 'turn/start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.get(first.assignment.id)).status, 'offline');
  assert.equal(await runtime.activeCount(), 1);
});

test('给交过报告的副手派新活，状态从 done 退回 idle', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '还能接着干' });
  await runtime.report(assignment.id, { summary: '第一段干完了' });
  assert.equal((await runtime.get(assignment.id)).status, 'done');

  await runtime.send(assignment.id, '再整理一份');
  assert.equal((await runtime.get(assignment.id)).status, 'idle');
});

test('给等着回话的副手回完话，状态退回 idle，旧问题不会再被等一遍', async () => {
  const { runtime } = build();
  const { assignment } = await runtime.create({ purpose: '等你拍板' });
  await runtime.report(assignment.id, { summary: '按部门还是按项目分？', expectsReply: true });
  assert.equal((await runtime.get(assignment.id)).status, 'waiting');

  await runtime.send(assignment.id, '按部门分');
  assert.equal((await runtime.get(assignment.id)).status, 'idle');
});

test('挂载预设后才注册报告工具和提示词', async () => {
  const order = [];
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  const fake = fakeAgents();
  const runtime = createAssignmentRuntime({
    ctx: {
      get: (name) => {
        if (name === 'agents') return fake.agents;
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
        if (name === 'agentPresets') {
          return {
            mount: async () => {
              order.push('mount');
            },
          };
        }
        if (name === 'permissionPresets') return { set: () => order.push('permission') };
        return undefined;
      },
    },
    store,
    config: { maxAssignments: 3, assignmentPreset: 'standard', permissionPreset: 'workspace-write', timeZone: TZ },
    log: () => {},
    push: async () => true,
    buildReportTools: () => {
      order.push('tools');
      return [];
    },
    now: () => NOW,
  });

  await runtime.create({ purpose: '顺序' });
  assert.deepEqual(order, ['mount', 'permission', 'tools']);
});

// 权限档要用 setup 传进来的 agent 拿会话。读 agentCtx.agent 会被 cordis 反射代理
// 拦下（cannot get property "agent" without inject），异常被 catch 吞掉，
// 结果就是副手连文件都改不了，「派活」变成一句空话 —— 真机上这么炸过一次。
test('权限档设到了副手会话上，会话来自 setup 的 agent 参数', async () => {
  const { runtime, permissions } = build({
    runtime: {
      config: { maxAssignments: 3, assignmentPreset: 'standard', permissionPreset: 'workspace-write', timeZone: TZ },
    },
  });
  const { assignment } = await runtime.create({ purpose: '权限' });
  assert.deepEqual(permissions, [{ sessionId: `wa:asg:${assignment.id}`, preset: 'workspace-write' }]);
});

test('拿不到会话时如实记一笔，不假装设上了', async () => {
  const logs = [];
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  // setupWithoutAgent：模拟宿主换了调用方式，只传 agentCtx 不传 agent
  const fake = fakeAgents({ setupWithoutAgent: true });
  const runtime = createAssignmentRuntime({
    ctx: {
      get: (name) => {
        if (name === 'agents') return fake.agents;
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
        if (name === 'permissionPresets') return { set: () => {} };
        return undefined;
      },
    },
    store,
    config: { maxAssignments: 3, permissionPreset: 'workspace-write', timeZone: TZ },
    log: (line) => logs.push(line),
    push: async () => true,
    buildReportTools: () => [],
    now: () => NOW,
  });
  await runtime.create({ purpose: '没会话' });
  assert.ok(
    logs.some((line) => /权限档没设上/.test(line)),
    logs.join('\n'),
  );
});

test('assignmentPrompt 带上了这条线的目的和报告要求', () => {
  const prompt = assignmentPrompt({ purpose: '整理 Q3 报销' });
  assert.match(prompt, /整理 Q3 报销/);
  assert.match(prompt, /assign_report/);
});

// 副手跑崩时错误原因只在 turn/end 的 text 里。丢了它 inspect 就只剩「这一轮结束」，
// 用户问「它怎么不动了」时完全没法回答。
test('inspect 保留 turn/end 的错误原因', async () => {
  const records = [
    { type: 'tool/call', text: 'bash' },
    { type: 'turn/end', text: 'error\n模型调用超时：upstream 504' },
  ];
  const { runtime } = build({ sessionQuery: { filterEvents: async () => records } });
  const { assignment } = await runtime.create({ purpose: '会崩的活' });
  const { tail } = await runtime.inspect(assignment.id);
  assert.match(tail.join('\n'), /upstream 504/);
});

test('dispose 释放所有会话', async () => {
  const { runtime, fake } = build();
  await runtime.create({ purpose: '一' });
  await runtime.create({ purpose: '二' });
  assert.equal(fake.live.size, 2);
  await runtime.dispose();
  assert.equal(fake.live.size, 0);
});

test('登记簿落盘：换个 store 还能读回副手', async () => {
  const paths = scratch();
  const first = build({ paths });
  const { assignment } = await first.runtime.create({ purpose: '要能读回来' });
  await first.runtime.report(assignment.id, { summary: '存住了' });

  const store2 = createAssignmentStore(paths, { log: () => {} });
  await store2.load();
  const found = await store2.read((book) => book.items.find((item) => item.id === assignment.id));
  assert.equal(found.purpose, '要能读回来');
  assert.equal(found.report.summary, '存住了');
});

// 副手的预设名也是从配置读的。别人装这个插件时，那个名字在他机器上不一定存在；
// 挂不上就退回宿主默认，别让「派活」因为一个名字派不出去。
test('副手预设挂不上就退回宿主默认', async () => {
  const calls = [];
  const logs = [];
  const { runtime } = build({
    runtime: {
      config: { maxAssignments: 3, assignmentPreset: '别人机器上的预设' },
      log: (line) => logs.push(line),
    },
    mount: async (...args) => {
      calls.push(args);
      if (args.length > 1) throw new Error('agent-preset/unknown');
    },
  });

  const { assignment } = await runtime.create({ purpose: '整理报销表' });

  assert.ok(assignment.id);
  assert.equal(calls.length, 2, '先按配置的挂，失败再挂默认');
  assert.equal(calls[0].length, 2);
  assert.equal(calls[1].length, 1, '第二次必须不传预设名');
  assert.ok(logs.some((line) => line.includes('改用宿主默认')));
});
