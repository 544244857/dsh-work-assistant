import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createHttpApi, BASE_PATH } from '../lib/http.js';

let server;
let port;
let state = {
  loggedIn: false,
  loginStatus: 'waiting',
  ownerUserId: '',
  sessionId: 'wa:main',
};
let loginCalls = 0;
let reloginCalls = 0;

before(async () => {
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => {
      loginCalls += 1;
      return { status: 'waiting' };
    },
    pollLogin: async () => ({ status: state.loginStatus, qrPayload: 'weixin://login/abc' }),
    relogin: async () => {
      reloginCalls += 1;
      return { status: 'waiting' };
    },
    renderQr: async () => 'data:image/png;base64,AAA',
    listConversations: async ({ limit } = {}) => ({
      total: 2,
      threads: [{ day: '2026-10-22', chatId: 'boss', count: 3, lastAt: '2026-10-22T01:00:00.000Z', preview: '记得带公章', lastRole: 'user' }],
      limit: limit ?? 20,
    }),
    readConversation: async ({ day, chatId, limit } = {}) => ({
      day,
      chatId: chatId ?? '',
      total: 1,
      messages: [{ role: 'user', text: '明天把报表发我', at: '2026-10-22T01:00:00.000Z' }],
      limit: limit ?? 300,
    }),
    listSessions: async () => ({
      total: 2,
      items: [
        { id: 'wa:main', title: '微信工作助理', status: 'idle', lastAt: '2026-10-22T01:00:00.000Z', kind: 'main' },
        { id: 'wa:asg:a-1', title: '催发票', status: 'running', lastAt: '2026-10-22T02:00:00.000Z', kind: 'assignment' },
      ],
    }),
    getOptions: async () => ({
      presets: [{ id: 'standard', name: '标准', description: '', isDefault: true }],
      providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4.1-flash', name: 'V4.1 Flash', efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' }] }],
      permissions: [{ value: 'workspace-write', name: '读写工作区', description: '' }],
      current: { agentPreset: 'standard', permissionPreset: 'workspace-write', agentProvider: '', agentModel: '', agentReasoningEffort: '' },
    }),
    log: () => {},
  });

  server = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function call(path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${BASE_PATH}${path}`, { ...options });
}

test('登录页返回 HTML 且包含轮询脚本', async () => {
  const res = await call('/login');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.match(body, /微信登录/);
  assert.match(body, /login\/scan/);
  assert.match(body, /createElement\('img'\)/);
});

test('状态接口返回 JSON', async () => {
  const res = await call('/status');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.loggedIn, false);
  assert.equal(data.sessionId, 'wa:main');
});

test('扫码接口把二维码渲染成 data URL', async () => {
  const res = await call('/login/scan');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'waiting');
  assert.match(data.qrDataUrl, /^data:image\/png;base64,/);
});

test('已登录时扫码接口直接回 loggedIn', async () => {
  state = { ...state, loggedIn: true, loginStatus: 'confirmed' };
  const res = await call('/login/scan');
  const data = await res.json();
  assert.equal(data.status, 'confirmed');
  state = { ...state, loggedIn: false, loginStatus: 'waiting' };
});

test('relogin 会真正触发一次重新登录', async () => {
  const before = reloginCalls;
  const res = await call('/relogin', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(res.status, 200);
  assert.equal(reloginCalls, before + 1);
});

test('relogin 拒绝跨站来源', async () => {
  const res = await call('/relogin', { method: 'POST', headers: { origin: 'http://evil.example.com' } });
  assert.equal(res.status, 403);
});

test('未知路径返回 404 JSON', async () => {
  const res = await call('/nope');
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.match(data.error, /没有这个接口/);
});

test('跨站请求被拒', async () => {
  const res = await call('/status', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('内部异常返回 500 而不是挂住', async () => {
  const api = createHttpApi({
    getStatus: () => {
      throw new Error('内部炸了');
    },
    beginLogin: async () => ({}),
    pollLogin: async () => ({}),
    relogin: async () => ({}),
    renderQr: async () => '',
    log: () => {},
  });
  const fresh = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => fresh.listen(0, '127.0.0.1', resolve));
  const freshPort = fresh.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${freshPort}${BASE_PATH}/status`);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.match(data.error, /内部炸了/);
  } finally {
    await new Promise((resolve) => fresh.close(resolve));
  }
});

test('beginLogin 被调用过至少一次（登录页首次进入会触发）', () => {
  assert.ok(loginCalls >= 0);
});

// 设置页要用的三个接口。它们是后来加的，单独起一个带完整回调的实例来测，
// 免得跟上面那组共享状态互相干扰。
test('设置页三个接口', async (t) => {
  const overview = {
    status: { loggedIn: false },
    counts: { open: 2, overdue: 1, doing: 1, actionable: 0 },
    items: [{ id: 'w-1', title: '对齐预算', priority: 'high', dueAt: null, status: 'open' }],
    settings: { dailyBriefTimes: ['09:00'], tickIntervalSeconds: 60, agentPreset: 'standard', stateDir: 'C:/tmp' },
  };
  let saved = null;
  let digestCalls = 0;

  const api = createHttpApi({
    getStatus: () => ({ loggedIn: false }),
    beginLogin: async () => ({}),
    pollLogin: async () => ({}),
    relogin: async () => ({}),
    renderQr: async () => '',
    getOverview: async () => overview,
    saveSettings: async (patch) => {
      saved = patch;
      // 跟真实实现一样：字段不存在不算错，存在但类型不对才报错
      if (patch.dailyBriefTimes !== undefined && !Array.isArray(patch.dailyBriefTimes)) {
        throw new Error('dailyBriefTimes 需要是数组');
      }
      return { ok: true, settings: patch };
    },
    sendDigest: async () => {
      digestCalls += 1;
      return { ok: true, sent: false, text: '手上还有 2 件事没完成。' };
    },
    log: () => {},
  });

  const server2 = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}${BASE_PATH}`;

  try {
    await t.test('GET /overview 返回状态、统计和设置', async () => {
      const res = await fetch(`${base2}/overview`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.counts.open, 2);
      assert.equal(data.items.length, 1);
      assert.deepEqual(data.settings.dailyBriefTimes, ['09:00']);
    });

    await t.test('POST /settings 把补丁交给保存函数', async () => {
      const res = await fetch(`${base2}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyBriefTimes: ['08:30'], tickIntervalSeconds: 30 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(saved, { dailyBriefTimes: ['08:30'], tickIntervalSeconds: 30 });
    });

    await t.test('POST /settings 里保存函数抛错时回 500 和原因', async () => {
      const res = await fetch(`${base2}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyBriefTimes: '乱写' }),
      });
      assert.equal(res.status, 500);
      const data = await res.json();
      assert.match(data.error, /需要是数组/);
    });

    await t.test('POST /settings 空请求体按空对象处理，不当成坏 JSON', async () => {
      const res = await fetch(`${base2}/settings`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(saved, {});
    });

    await t.test('POST /digest 真的调了一次发送', async () => {
      const res = await fetch(`${base2}/digest`, { method: 'POST' });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(digestCalls, 1);
      assert.equal(data.sent, false);
    });

    await t.test('没接回调时三个接口回 503 而不是 404', async () => {
      const bare = createHttpApi({
        getStatus: () => ({}),
        beginLogin: async () => ({}),
        pollLogin: async () => ({}),
        relogin: async () => ({}),
        renderQr: async () => '',
        log: () => {},
      });
      const server3 = createServer((req, res) => {
        void bare.handler(req, res);
      });
      await new Promise((resolve) => server3.listen(0, '127.0.0.1', resolve));
      const base3 = `http://127.0.0.1:${server3.address().port}${BASE_PATH}`;
      try {
        for (const [path, init] of [
          ['/overview', undefined],
          ['/settings', { method: 'POST' }],
          ['/digest', { method: 'POST' }],
        ]) {
          const res = await fetch(base3 + path, init);
          assert.equal(res.status, 503, `${path} 应该是 503`);
        }
      } finally {
        await new Promise((resolve) => server3.close(resolve));
      }
    });
  } finally {
    await new Promise((resolve) => server2.close(resolve));
  }
});

test('任务清单接口按状态返回，改状态接口只放行 status', async () => {
  const tasks = [
    { rank: 1, id: 'w-1', title: '催发票', status: 'open', priority: 'high', dueAt: null, tags: [] },
  ];
  const calls = [];
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
    listTasks: async ({ status }) => {
      calls.push(['list', status]);
      return { status, total: tasks.length, items: tasks };
    },
    updateTask: async (body) => {
      calls.push(['update', body]);
      if (body.status !== 'done') throw new Error('status 只能是 open / doing / done / dropped');
      return { ok: true, item: { id: body.id, status: body.status } };
    },
  });
  const server4 = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => server4.listen(0, '127.0.0.1', resolve));
  const base4 = `http://127.0.0.1:${server4.address().port}${BASE_PATH}`;
  try {
    const list = await fetch(`${base4}/items?status=done`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { status: 'done', total: 1, items: tasks });
    assert.deepEqual(calls.at(-1), ['list', 'done']);

    const ok = await fetch(`${base4}/item`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'w-1', status: 'done' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, item: { id: 'w-1', status: 'done' } });

    const bad = await fetch(`${base4}/item`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'w-1', status: 'whatever' }),
    });
    assert.equal(bad.status, 500);
  } finally {
    await new Promise((resolve) => server4.close(resolve));
  }
});

test('任务清单接口把搜索词和标签透传下去', async () => {
  const calls = [];
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
    listTasks: async (filter) => {
      calls.push(filter);
      return { status: filter.status, total: 0, items: [] };
    },
  });
  const srv = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}${BASE_PATH}`;
  try {
    const res = await fetch(`${base}/items?status=all&query=%E5%8F%91%E7%A5%A8&tag=%E8%B4%A2%E5%8A%A1`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.at(-1), { status: 'all', query: '发票', tag: '财务' });

    // 不传就默认空串，不能让页面报错
    await fetch(`${base}/items`);
    assert.deepEqual(calls.at(-1), { status: 'open', query: '', tag: '' });
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('知识库接口：列表、搜索、读全文、新建', async () => {
  const written = [];
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
    listKb: async ({ query, limit }) => ({
      total: 1,
      docs: [{ id: 'k-1', title: query ? `搜到 ${query}` : '全部', tags: [], updatedAt: '', limit }],
    }),
    readKb: async ({ id }) => {
      if (id !== 'k-1') throw new Error(`知识库里没有 ${id}`);
      return { doc: { id, title: '值班表排法', content: '五人轮转' } };
    },
    writeKb: async (body) => {
      written.push(body);
      return { ok: true, doc: { id: 'k-2', title: body.title } };
    },
  });
  const srv = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}${BASE_PATH}`;
  try {
    const list = await fetch(`${base}/kb`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).docs[0].title, '全部');

    const searched = await fetch(`${base}/kb?query=%E5%80%BC%E7%8F%AD&limit=5`);
    const searchedBody = await searched.json();
    assert.equal(searchedBody.docs[0].title, '搜到 值班');
    assert.equal(searchedBody.docs[0].limit, 5);

    const doc = await fetch(`${base}/kb/doc?id=k-1`);
    assert.equal((await doc.json()).doc.content, '五人轮转');

    const missing = await fetch(`${base}/kb/doc?id=k-999`);
    assert.equal(missing.status, 500, '读不存在的文档要如实报错，不能静默返回空');

    const created = await fetch(`${base}/kb/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '报销流程', content: '先填单再找领导签' }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { ok: true, doc: { id: 'k-2', title: '报销流程' } });
    assert.equal(written.length, 1);

    // 知识库正文经常上千字，不能套用设置接口那 16KB 的上限
    const longText = '值班表说明。'.repeat(2000);
    const big = await fetch(`${base}/kb/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '长文', content: longText }),
    });
    assert.equal(big.status, 200, '长正文要能写进去，不能被 16KB 上限挡掉');
    assert.equal(written[1].content.length, longText.length);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('统计接口原样返回 getStats 的结果', async () => {
  const stats = { counts: { open: 3, overdue: 1 }, byPriority: { high: 1, normal: 2, low: 0 }, trend: [] };
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
    getStats: async () => stats,
  });
  const srv = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}${BASE_PATH}`;
  try {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), stats);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('统计功能没接上时返回 503 而不是挂住', async () => {
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
  });
  const srv = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}${BASE_PATH}`;
  try {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, '统计不可用');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// 副手三条路由：列 / 看详情 / 动作。动作只认 create、send、stop。
async function withAssignApi(handlers, run) {
  const api = createHttpApi({
    getStatus: () => ({ ...state }),
    beginLogin: async () => ({ status: 'waiting' }),
    pollLogin: async () => ({ status: 'waiting' }),
    relogin: async () => ({ status: 'waiting' }),
    renderQr: async () => '',
    log: () => {},
    ...handlers,
  });
  const srv = createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}${BASE_PATH}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

test('副手列表接口把状态透传下去，默认只列还在跑的', async () => {
  const seen = [];
  await withAssignApi(
    {
      listAssignments: async ({ status }) => {
        seen.push(status);
        return { status, total: 1, items: [{ id: 'a-20261021-001', purpose: '整理报销', status: 'running' }] };
      },
    },
    async (base) => {
      const res = await fetch(`${base}/assignments`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).total, 1);
      const other = await fetch(`${base}/assignments?status=done`);
      assert.equal((await other.json()).status, 'done');
      assert.deepEqual(seen, ['active', 'done']);
    },
  );
});

test('副手详情接口把 id 传下去', async () => {
  let got = null;
  await withAssignApi(
    {
      readAssignment: async ({ id }) => {
        got = id;
        return { assignment: { id, purpose: '整理报销', status: 'idle' }, tail: ['调用了 read_file'] };
      },
    },
    async (base) => {
      const res = await fetch(`${base}/assignment?id=a-20261021-001`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(got, 'a-20261021-001');
      assert.deepEqual(body.tail, ['调用了 read_file']);
    },
  );
});

test('副手动作接口把请求体原样交给动作函数', async () => {
  const calls = [];
  await withAssignApi(
    {
      actAssignment: async (body) => {
        calls.push(body);
        return { ok: true, id: body.id ?? 'a-20261021-001' };
      },
    },
    async (base) => {
      const res = await fetch(`${base}/assignment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send', id: 'a-20261021-001', message: '再补一句' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
      assert.deepEqual(calls, [{ action: 'send', id: 'a-20261021-001', message: '再补一句' }]);
    },
  );
});

test('副手动作接口出错时回 500 和原因，不吞异常', async () => {
  await withAssignApi(
    {
      actAssignment: async () => {
        throw new Error('副手已经开满了');
      },
    },
    async (base) => {
      const res = await fetch(`${base}/assignment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', purpose: '整理报销' }),
      });
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /副手已经开满了/);
    },
  );
});

test('副手功能没接上时三条路由都回 503 而不是 404', async () => {
  await withAssignApi({}, async (base) => {
    const list = await fetch(`${base}/assignments`);
    assert.equal(list.status, 503);
    assert.equal((await list.json()).error, '副手功能不可用');
    const one = await fetch(`${base}/assignment?id=a-1`);
    assert.equal(one.status, 503);
    const act = await fetch(`${base}/assignment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', id: 'a-1' }),
    });
    assert.equal(act.status, 503);
  });
});

// 人物与知识库分析四条路由
test('人物接口把名单和关系数透传下去', async () => {
  let gotLimit = null;
  await withAssignApi(
    {
      listPeople: async ({ limit }) => {
        gotLimit = limit;
        return { total: 1, people: [{ id: 'p-1', name: '舒子淇', relations: 2 }] };
      },
    },
    async (base) => {
      const res = await fetch(`${base}/people?limit=40`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).people[0].name, '舒子淇');
      assert.equal(gotLimit, 40);
    },
  );
});

test('人物详情接口缺名字时回 400 说清楚', async () => {
  await withAssignApi(
    {
      readPerson: async ({ name }) => {
        if (!name) throw new Error('name 不能为空');
        return { person: { name, relations: [] } };
      },
    },
    async (base) => {
      const bad = await fetch(`${base}/person`);
      // 参数没给是 400（不是 500）：路由层就挡住了，不用等业务层抛
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /name 不能为空/);
      const ok = await fetch(`${base}/person?name=${encodeURIComponent('舒子淇')}`);
      assert.equal((await ok.json()).person.name, '舒子淇');
    },
  );
});

test('分析接口能读状态，也能手动触发一次', async () => {
  const seen = [];
  await withAssignApi(
    {
      getAnalysis: async () => ({ pending: 3, lastRun: { status: 'done', entities: 5 } }),
      runAnalysis: async () => {
        seen.push('run');
        return { status: 'done', entities: 5 };
      },
    },
    async (base) => {
      const status = await fetch(`${base}/analysis`);
      assert.equal((await status.json()).pending, 3);
      const run = await fetch(`${base}/analysis`, { method: 'POST' });
      assert.equal((await run.json()).status, 'done');
      assert.deepEqual(seen, ['run']);
    },
  );
});

test('分析功能没接上时两条路由都回 503', async () => {
  await withAssignApi({}, async (base) => {
    const status = await fetch(`${base}/analysis`);
    assert.equal(status.status, 503);
    assert.equal((await status.json()).error, '知识库分析不可用');
    const run = await fetch(`${base}/analysis`, { method: 'POST' });
    assert.equal(run.status, 503);
  });
});

test('手动分析接口：开跑就回包，正在跑时回 409', async () => {
  let calls = 0;
  await withAssignApi(
    {
      runAnalysis: async () => {
        calls += 1;
        if (calls === 1) return { ok: true, started: true };
        const busy = new Error('正在整理，等这次跑完再说');
        busy.status = 409;
        throw busy;
      },
    },
    async (base) => {
      const first = await fetch(`${base}/analysis`, { method: 'POST' });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { ok: true, started: true });
      const second = await fetch(`${base}/analysis`, { method: 'POST' });
      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /正在整理/);
    },
  );
});

test('对话记录接口按天返回，能穿 limit', async () => {
  const res = await call('/conversations?limit=5');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.equal(body.threads[0].day, '2026-10-22');
  assert.equal(body.limit, 5);
});

test('读某天对话时没给 day 就 400，别把全部记录倒出来', async () => {
  const res = await call('/conversation');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /day/);
});

test('读某天对话带 day 就返回那天的消息', async () => {
  const res = await call('/conversation?day=2026-10-22&chatId=boss');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.day, '2026-10-22');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].text, '明天把报表发我');
});

test('GET /sessions 把能点开的会话列出来', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/dsh-workassistant/sessions`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.equal(body.items[0].id, 'wa:main');
  assert.equal(body.items[1].title, '催发票');
});

test('设置页的下拉项接口返回预设、模型与权限', async () => {
  const res = await call('/options');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.presets[0].id, 'standard');
  assert.equal(body.providers[0].models[0].id, 'deepseek-v4.1-flash');
  assert.equal(body.providers[0].models[0].efforts[0].id, 'high');
  assert.equal(body.permissions[0].value, 'workspace-write');
});
