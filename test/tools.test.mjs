import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { createStore } from '../lib/store.js';
import { dataPaths } from '../lib/paths.js';
import { createTools } from '../lib/tools.js';
import { readDoc } from '../lib/kb.js';
import { reportTools } from '../lib/assignment-tools.js';
import { mergeExtraction } from '../lib/graph.js';

const TZ = 'Asia/Shanghai';

let dir;
let paths;

// 副手运行时的假身：控制面 6 个工具只要它存在就会挂上来。
// 真逻辑在 assignment-runtime.test.mjs 里测，这里只验证工具层的接线和回执。
function fakeAssignments(overrides = {}) {
  const calls = [];
  const items = overrides.items ?? [];
  // 默认当作「自己开的会话」，能真释放；要测复用场景的传 released:false
  const releasedFlag = overrides.released ?? true;
  return {
    calls,
    async create(input) {
      calls.push({ op: 'create', input });
      if (overrides.createError) throw overrides.createError;
      const assignment = {
        id: 'a-20261021-001',
        sessionId: 'wa:asg:a-20261021-001',
        purpose: input.purpose,
        itemId: input.itemId ?? null,
        status: 'idle',
      };
      items.push(assignment);
      return { assignment };
    },
    async list(filter) {
      calls.push({ op: 'list', filter });
      return { items, total: items.length };
    },
    async get(id) {
      return items.find((item) => item.id === id) ?? null;
    },
    async inspect(id) {
      calls.push({ op: 'inspect', id });
      const found = items.find((item) => item.id === id);
      if (!found) throw new Error(`找不到副手 ${id}`);
      return { assignment: found, tail: ['调用了 bash', '说：干完了'] };
    },
    async send(id, message, mode) {
      calls.push({ op: 'send', id, message, mode });
      if (overrides.sendError) throw new Error(overrides.sendError);
      return { ok: true, mode };
    },
    async stop(id, reason) {
      calls.push({ op: 'stop', id, reason });
      const found = items.find((item) => item.id === id) ?? { id, purpose: '测试' };
      found.status = 'stopped';
      return { assignment: found, released: releasedFlag, sessionActive: overrides.sessionActive ?? false };
    },
    async activeCount() {
      return items.filter((item) => ['idle', 'running', 'waiting'].includes(item.status)).length;
    },
  };
}

// 测试里要核对落盘结果，把 store 抬到模块级，build() 每次重建一份
let store = null;

function build(overrides = {}) {
  store = createStore(paths, { log: () => {} });
  const sent = [];
  const tools = createTools({
    assignments: overrides.assignments ?? fakeAssignments(),
    store,
    paths,
    timeZone: TZ,
    sessionId: 'wa:main',
    notify: async (body) => {
      sent.push(body);
      return true;
    },
    ...overrides,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const run = async (name, args) => {
    const tool = byName.get(name);
    assert.ok(tool, `没有工具 ${name}`);
    return tool.execute(args, {});
  };
  return { store, tools, byName, run, sent };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-tools-'));
  paths = dataPaths(dir);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('每个工具的定义都符合宿主注册要求', () => {
  const { tools } = build();
  assert.equal(tools.length, 22);
  for (const tool of tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.trim(), 'name 不能为空');
    assert.ok(typeof tool.description === 'string' && tool.description.trim(), `${tool.name} 缺 description`);
    assert.equal(tool.parameters.type, 'object', `${tool.name} 参数根必须是 object`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 render`);
    assert.equal(typeof tool.output.schema, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.notEqual(tool.name, 'run_code');
  }
});

test('工具名不重复', () => {
  const { tools } = build();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

// 这条是真机上炸过的：render 返回字符串时宿主会调 content.some(...) 直接抛
// "content.some is not a function"，工具看着失败，模型就反复重试，账本里堆出重复条目。
test('每个工具的 render 都返回内容块数组，不是字符串', () => {
  const { tools } = build();
  for (const tool of tools) {
    const rendered = tool.output.render({}, { summary: '随便一段话', data: {} });
    assert.ok(Array.isArray(rendered), `${tool.name} 的 render 必须返回数组`);
    assert.ok(rendered.length > 0, `${tool.name} 的 render 不能返回空数组`);
    for (const block of rendered) {
      assert.equal(block.type, 'text', `${tool.name} 的 render 块必须是 text 类型`);
      assert.equal(typeof block.text, 'string', `${tool.name} 的 render 块必须带 text 字符串`);
    }
    assert.equal(rendered[0].text, '随便一段话', `${tool.name} 的 render 应该把 summary 原样吐出来`);
  }
});

test('work_capture 落账本并返回未完成计数', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-capture-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const out = await run('work_capture', {
      title: '整理 Q3 报销表',
      detail: '张三要的，含发票扫描件',
      dueAt: '2026-10-24 18:00',
      priority: 'high',
      tags: ['财务'],
      actionable: true,
      suggestedAction: '把发票按日期排序并汇总金额',
      sourceText: '张三：周五前把 Q3 报销整理好发我',
    });

    assert.equal(out.data.openCount, 1);
    assert.match(out.summary, /记下了 w-\d{8}-001/);
    // formatInstant 对当天的期限说「今天 18:00」，隔天才说「10/24 18:00」。
    // 原来这里写死 10/24，一到 10 月 24 日跑测试就红——日期的断言别钉死相对表述。
    assert.match(out.summary, /期限 (?:今天|\d{2}\/\d{2}) 18:00/);

    const ledger = await store.read((data) => data);
    assert.equal(ledger.items.length, 1);
    const item = ledger.items[0];
    assert.equal(item.title, '整理 Q3 报销表');
    assert.equal(item.priority, 'high');
    assert.deepEqual(item.tags, ['财务']);
    assert.equal(item.actionable, true);
    // 期限前自动补提醒
    assert.ok(item.remindAt);
    assert.ok(item.remindAt < item.dueAt);
    assert.equal(item.source.text, '张三：周五前把 Q3 报销整理好发我');
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_capture 的标题为空时抛错', async () => {
  const { run } = build();
  await assert.rejects(() => run('work_capture', { title: '   ' }), /title 不能为空/);
});

test('work_capture 缺省字段给出默认值', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-defaults-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const out = await run('work_capture', { title: '回复李四的合同疑问' });
    const ledger = await store.read((data) => data);
    const item = ledger.items[0];
    assert.equal(item.status, 'open');
    assert.equal(item.priority, 'normal');
    assert.equal(item.dueAt, null);
    assert.equal(item.remindAt, null);
    assert.equal(item.actionable, false);
    assert.deepEqual(item.tags, []);
    assert.match(out.summary, /现在手上共 1 件未完成/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_list 默认只列未完成，按期限排序', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-list-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    await run('work_capture', { title: '晚的', dueAt: '2026-12-01 10:00' });
    await run('work_capture', { title: '早的', dueAt: '2026-10-21 10:00' });
    await run('work_capture', { title: '没期限的' });

    const out = await run('work_list', {});
    assert.equal(out.data.total, 3);
    const titles = out.data.items.map((i) => i.title);
    assert.deepEqual(titles, ['早的', '晚的', '没期限的']);
    assert.match(out.summary, /共 3 项/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_list 支持按状态与标签过滤', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-filter-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const a = await run('work_capture', { title: '甲', tags: ['财务'] });
    await run('work_capture', { title: '乙', tags: ['合同'] });
    await run('work_update', { id: a.data.id, status: 'done' });

    const openOnly = await run('work_list', {});
    assert.deepEqual(openOnly.data.items.map((i) => i.title), ['乙']);

    const doneOnly = await run('work_list', { status: 'done' });
    assert.deepEqual(doneOnly.data.items.map((i) => i.title), ['甲']);

    const byTag = await run('work_list', { status: 'all', tag: '合同' });
    assert.deepEqual(byTag.data.items.map((i) => i.title), ['乙']);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_update 改状态，done 时写 doneAt', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-update-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '准备评审材料' });
    const id = created.data.id;

    const updated = await run('work_update', { id, status: 'doing', note: '已经开始' });
    assert.equal(updated.data.status, 'doing');

    const done = await run('work_update', { id, status: 'done' });
    assert.equal(done.data.status, 'done');

    const ledger = await store.read((data) => data);
    const item = ledger.items.find((i) => i.id === id);
    assert.ok(item.doneAt);
    assert.equal(item.notes.length, 1);
    assert.equal(item.notes[0].text, '已经开始');
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_update 找不到 id 时报错', async () => {
  const { run } = build();
  await assert.rejects(() => run('work_update', { id: 'w-19700101-999', status: 'done' }), /找不到工作项/);
});

test('work_update 传空 remindAt 取消提醒', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-remind-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '催一下供应商', dueAt: '2026-11-01 10:00' });
    const id = created.data.id;
    await run('work_update', { id, remindAt: '' });
    const ledger = await store.read((data) => data);
    assert.equal(ledger.items.find((i) => i.id === id).remindAt, null);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_digest 把逾期与今天分开报', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-digest-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    await run('work_capture', { title: '早就该交的', dueAt: '2026-10-01 10:00', priority: 'high' });
    await run('work_capture', { title: '没期限的' });

    const out = await run('work_digest', {});
    assert.equal(out.data.open, 2);
    assert.equal(out.data.overdue, 1);
    assert.match(out.summary, /逾期 1 件/);
    assert.match(out.summary, /早就该交的/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('kb_write / kb_search / kb_read / kb_list 串起来', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-kb-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const written = await run('kb_write', {
      title: 'Q3 报销流程',
      content: '先由部门助理收集发票，再交财务王五核对，最后走 OA 审批。',
      tags: ['报销', '财务'],
    });
    assert.match(written.summary, /已存进知识库：k-\d{8}-001/);
    const stored = await readDoc(paths, written.data.id);
    assert.equal(stored.title, 'Q3 报销流程');

    const found = await run('kb_search', { query: '财务' });
    assert.equal(found.data.hits.length, 1);
    assert.equal(found.data.hits[0].id, written.data.id);
    assert.match(found.data.hits[0].snippet, /王五/);

    const read = await run('kb_read', { id: written.data.id });
    assert.match(read.data.content, /OA 审批/);
    assert.doesNotMatch(read.data.content, /^---/);

    const listed = await run('kb_list', {});
    assert.equal(listed.data.total, 1);
    assert.match(listed.summary, /共 1 篇/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('kb_search 搜不到时给出明确文案而不是空串', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-kb2-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    await run('kb_write', { title: '供应商名单', content: '甲、乙、丙三家。', tags: ['采购'] });
    const out = await run('kb_search', { query: '完全不存在的词' });
    assert.equal(out.data.hits.length, 0);
    assert.match(out.summary, /没搜到/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('kb_read 读不存在的 id 时报错', async () => {
  const { run } = build();
  await assert.rejects(() => run('kb_read', { id: 'k-19700101-001' }), /知识库里没有/);
});

test('work_notify 把文本交给推送回调', async () => {
  const { run, sent } = build();
  const out = await run('work_notify', { text: '报销表整理好了，已发你邮箱。' });
  assert.equal(out.data.delivered, true);
  assert.deepEqual(sent, ['报销表整理好了，已发你邮箱。']);
});

test('work_notify 在推送失败时如实报告', async () => {
  const { run } = build({ notify: async () => false });
  const out = await run('work_notify', { text: '试试' });
  assert.equal(out.data.delivered, false);
  assert.match(out.summary, /没发出去/);
});

test('work_notify 没有通道时也不抛错', async () => {
  const { run } = build({ notify: undefined });
  const out = await run('work_notify', { text: '试试' });
  assert.equal(out.data.delivered, false);
});

test('work_notify 空文本报错', async () => {
  const { run } = build();
  await assert.rejects(() => run('work_notify', { text: '  ' }), /text 不能为空/);
});

test('两次独立 build 共用磁盘账本，不互相覆盖', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-share-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const first = build();
    await first.run('work_capture', { title: '第一件' });

    const second = build();
    const out = await second.run('work_capture', { title: '第二件' });
    assert.equal(out.data.openCount, 2);

    const ledger = await store.read((data) => data);
    assert.deepEqual(ledger.items.map((i) => i.title).sort(), ['第一件', '第二件'].sort());
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_capture 重复记同一条时不新增，只补新信息', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-dup-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const first = await run('work_capture', { title: '安排值班表' });
    assert.match(first.summary, /记下了 w-\d{8}-001/);
    assert.equal(first.data.duplicate, false);

    const again = await run('work_capture', {
      title: '安排值班表',
      dueAt: '2026-10-24 18:00',
      detail: '下周一开始，三个人轮',
    });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.id, first.data.id);
    assert.match(again.summary, /已经记过了/);
    assert.match(again.summary, /没有重复记/);

    const ledger = await store.read((data) => data);
    assert.equal(ledger.items.length, 1, '不应该多出一条');
    assert.equal(ledger.items[0].detail, '下周一开始，三个人轮');
    assert.ok(ledger.items[0].dueAt);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_capture 回执里说清紧急度排名和自动判的优先级', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-rank-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    await run('work_capture', { title: '整理旧资料', dueAt: '2026-12-01 10:00' });
    const out = await run('work_capture', { title: '催一下供应商发货' });
    assert.equal(out.data.rank, 1, '催的事应该排第一');
    assert.match(out.summary, /优先级 高/);
    assert.match(out.summary, /按紧急度排第 1 位/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_send_file 把文件交给发送通道并回一句人话', async () => {
  const calls = [];
  const { run } = build({
    sendFile: async (filePath, caption) => {
      calls.push({ filePath, caption });
      return { kind: 'file', name: '报表.xlsx', bytes: 20480 };
    },
  });
  const out = await run('work_send_file', { path: '/tmp/报表.xlsx', caption: '这是本周的' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filePath, '/tmp/报表.xlsx');
  assert.equal(calls[0].caption, '这是本周的');
  assert.equal(out.data.delivered, true);
  assert.match(out.summary, /报表\.xlsx/);
  assert.match(out.summary, /20 KB/);
});

test('work_send_file 发不出去时如实说原因，不假装成功', async () => {
  const { run } = build({
    sendFile: async () => {
      throw new Error('还没收到过你的消息，微信不允许机器人主动发起对话');
    },
  });
  const out = await run('work_send_file', { path: '/tmp/a.pdf' });
  assert.equal(out.data.delivered, false);
  assert.match(out.summary, /文件没发出去/);
  assert.match(out.summary, /不允许机器人主动发起对话/);
});

test('work_send_file 没有发送通道时不抛错', async () => {
  const { run } = build();
  const out = await run('work_send_file', { path: '/tmp/a.pdf' });
  assert.equal(out.data.delivered, false);
  assert.match(out.summary, /没有可用的发送通道/);
});

test('work_send_file 空路径直接报错', async () => {
  const { run } = build({ sendFile: async () => ({ kind: 'file', name: 'x', bytes: 1 }) });
  await assert.rejects(() => run('work_send_file', { path: '   ' }), /path 不能为空/);
});

test('work_snooze 把提醒往后推，并清掉已提醒标记', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-snooze-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run, store } = build();
    const created = await run('work_capture', { title: '交周报', dueAt: '2026-10-24 18:00' });
    const id = created.data.id;

    // 先假装已经提醒过，验证 snooze 会把这个标记清掉
    await store.mutate((ledger) => {
      const item = ledger.items.find((i) => i.id === id);
      item.remindedAt = new Date().toISOString();
      return null;
    });

    const out = await run('work_snooze', { id, minutes: 120 });
    assert.equal(out.data.id, id);
    assert.match(out.summary, /提醒推到/);

    const ledger = await store.read((data) => data);
    const item = ledger.items.find((i) => i.id === id);
    assert.equal(item.remindedAt, null, '推后提醒必须清掉已提醒标记，否则永远不会再推');
    assert.ok(item.remindAt);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_snooze 分钟数不合法时报错', async () => {
  const { run } = build();
  await assert.rejects(() => run('work_snooze', { id: 'w-20260101-001', minutes: 0 }), /minutes 要是正数/);
});

test('重复任务做完自动排下一次', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-repeat-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', {
      title: '交周报',
      dueAt: '2026-10-26 18:00',
      recurrence: { kind: 'weekly', weekdays: [1] },
    });
    assert.match(created.summary, /每周/);

    const done = await run('work_update', { id: created.data.id, status: 'done' });
    assert.ok(done.data.nextId, '做完重复任务应该生成下一条');
    assert.match(done.summary, /下一次已经排好了/);

    const list = await run('work_list', { status: 'open' });
    assert.equal(list.data.total, 1, '下一条应该是一条新的未完成项');
    assert.equal(list.data.items[0].title, '交周报');
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('不重复的任务做完不会凭空多出一条', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-norepeat-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '买咖啡豆' });
    const done = await run('work_update', { id: created.data.id, status: 'done' });
    assert.equal(done.data.nextId, null);

    const list = await run('work_list', { status: 'all' });
    assert.equal(list.data.total, 1, '不该多出一条');
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_list 支持关键词搜索', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-query-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    await run('work_capture', { title: '整理 Q3 报销表', tags: ['财务'] });
    await run('work_capture', { title: '联系供应商换货' });

    const hit = await run('work_list', { query: '报销' });
    assert.equal(hit.data.total, 1);
    assert.match(hit.data.items[0].title, /报销/);

    const byTag = await run('work_list', { query: '财务' });
    assert.equal(byTag.data.total, 1, '标签也要能被搜到');

    const miss = await run('work_list', { query: '不存在的词' });
    assert.equal(miss.data.total, 0);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_attach 把文件挂到工作项上，只记路径', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-attach-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '整理报销单' });
    const out = await run('work_attach', {
      id: created.data.id,
      path: '/tmp/报销单.xlsx',
      name: '报销单',
    });
    assert.equal(out.data.attached, 1);
    assert.match(out.summary, /挂上了 1 个文件/);

    const ledger = await store.read((data) => data);
    const item = ledger.items.find((i) => i.id === created.data.id);
    assert.equal(item.attachments[0].path, '/tmp/报销单.xlsx');
    assert.equal(item.attachments[0].name, '报销单');
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_attach 找不到工作项时如实报错', async () => {
  const { run } = build();
  await assert.rejects(
    () => run('work_attach', { id: 'w-20200101-001', path: '/tmp/a.xlsx' }),
    /找不到工作项/,
  );
});

test('work_assign 记到别人名下，并约好去问一句', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-assign-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '等广超给发票' });
    const out = await run('work_assign', {
      id: created.data.id,
      to: '广超',
      everyDays: 2,
    });
    assert.equal(out.data.assignee, '广超');
    assert.match(out.summary, /记到 广超 名下/);
    // 没约时间也要落成具体时刻，回执不能只说「每 2 天」——用户没法判断哪天会响
    assert.ok(out.data.verifyAt, '没传 verifyAt 时也要算出具体时刻');
    assert.match(out.summary, /我会提醒你去问一句/);

    const list = await run('work_list', { assignee: '广超' });
    assert.equal(list.data.total, 1);
    assert.match(list.summary, /等 广超/);
    assert.match(list.summary, /去问一句/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_assign 的 verifyAt 认不出来时如实报错，不静默换成默认值', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-assign-bad-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const created = await run('work_capture', { title: '等广超给发票' });
    await assert.rejects(
      () => run('work_assign', { id: created.data.id, to: '广超', verifyAt: '下周三左右吧' }),
      /verifyAt 认不出来/,
    );
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('work_review 总结这一周做了什么、还剩什么', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-review-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const a = await run('work_capture', { title: '整理报销表', tags: ['财务'] });
    await run('work_capture', { title: '写周报', tags: ['汇报'] });
    await run('work_update', { id: a.data.id, status: 'done' });

    const out = await run('work_review', {});
    assert.equal(out.data.done, 1);
    assert.equal(out.data.open, 1);
    assert.match(out.summary, /完成 1 件/);
    assert.match(out.summary, /整理报销表/);
    assert.match(out.summary, /财务/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('账本全空时周复盘也给一句人话，不是空串', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-tools-review-empty-'));
  const savedPaths = paths;
  paths = dataPaths(scratch);
  try {
    const { run } = build();
    const out = await run('work_review', {});
    assert.match(out.summary, /没有任何动静/);
  } finally {
    paths = savedPaths;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── 副手（分派）工具 ─────────────────────────────────────

test('6 个派活工具都在，必填项和 render 都合规', () => {
  const { byName } = build();
  const names = ['assign_create', 'assign_list', 'assign_inspect', 'assign_send', 'assign_stop', 'assign_wait'];
  for (const name of names) {
    const tool = byName.get(name);
    assert.ok(tool, `没有工具 ${name}`);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.parameters.type, 'object');
  }
  assert.deepEqual(byName.get('assign_create').parameters.required, ['purpose']);
  assert.deepEqual(byName.get('assign_send').parameters.required, ['id', 'message']);
  assert.deepEqual(byName.get('assign_inspect').parameters.required, ['id']);
});

test('没有副手运行时就不挂这 6 个工具（工具总数回到 16）', () => {
  const { tools } = build({ assignments: null });
  assert.equal(tools.length, 16);
});

test('assign_create 建完把副手挂到工作项上，回执说清编号和会话', async () => {
  const assignments = fakeAssignments();
  const marked = [];
  const { run } = build({
    assignments,
    markItemAssignment: async (itemId, assignmentId) => marked.push([itemId, assignmentId]),
  });
  const out = await run('assign_create', { purpose: '整理 Q3 报销表', itemId: 'w-20261021-001' });

  assert.match(out.summary, /派活了：a-20261021-001/);
  assert.match(out.summary, /整理 Q3 报销表/);
  assert.equal(out.data.sessionId, 'wa:asg:a-20261021-001');
  assert.deepEqual(marked, [['w-20261021-001', 'a-20261021-001']]);
});

test('assign_create 撞上并发上限时把上限翻成人话', async () => {
  const err = new Error('副手已经开满了（上限 3 个）。想再派活，先把不用的停掉：a-1（一）、a-2（二）、a-3（三）');
  err.code = 'ASSIGN_LIMIT_REACHED';
  err.limit = 3;
  err.active = 3;
  const { run } = build({ assignments: fakeAssignments({ createError: err }) });
  await assert.rejects(() => run('assign_create', { purpose: '再派一个' }), /副手已经开满了/);
});

test('assign_list 默认只看还没结束的，并把活跃数带回去', async () => {
  const assignments = fakeAssignments({
    items: [
      { id: 'a-20261021-001', purpose: '整理报销', status: 'running', sessionId: 's1', report: null },
      { id: 'a-20261021-002', purpose: '写周报', status: 'waiting', sessionId: 's2', report: { summary: '等你定' } },
    ],
  });
  const { run } = build({ assignments });
  const out = await run('assign_list', {});
  assert.equal(out.data.total, 2);
  assert.equal(out.data.active, 2);
  assert.match(out.summary, /整理报销/);
  assert.match(out.summary, /最新报告：等你定/);
});

test('assign_list 空的时候给一句人话，不是空串', async () => {
  const { run } = build({ assignments: fakeAssignments() });
  const out = await run('assign_list', {});
  assert.match(out.summary, /现在没有副手/);
});

test('assign_inspect 把最近几步带出来', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '查资料', status: 'running', sessionId: 's1', report: null }],
  });
  const { run } = build({ assignments });
  const out = await run('assign_inspect', { id: 'a-20261021-001' });
  assert.match(out.summary, /查资料/);
  assert.match(out.summary, /最近几步/);
  assert.match(out.summary, /调用了 bash/);
});

test('assign_send 默认当成新的一轮，失败时不自动重试', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '干活', status: 'idle', sessionId: 's1' }],
  });
  const { run } = build({ assignments });
  await run('assign_send', { id: 'a-20261021-001', message: '顺手把表格也做了' });
  assert.equal(assignments.calls.filter((c) => c.op === 'send').length, 1);
  assert.equal(assignments.calls.find((c) => c.op === 'send').mode, 'next-turn');
});

test('assign_send 投递失败时如实说没送到', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '干活', status: 'idle', sessionId: 's1' }],
    sendError: '宿主拒收',
  });
  const { run } = build({ assignments });
  await assert.rejects(() => run('assign_send', { id: 'a-20261021-001', message: '在吗' }), /消息没送到：宿主拒收/);
});

test('assign_stop 停掉后回执带上目的，免得只看到一个编号', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '整理报销', status: 'running', sessionId: 's1' }],
  });
  const { run } = build({ assignments });
  const out = await run('assign_stop', { id: 'a-20261021-001', reason: '不需要了' });
  assert.match(out.summary, /已停掉 a-20261021-001（整理报销）/);
  assert.equal(out.data.status, 'stopped');
});

// 复用来的会话（之前就开着的）宿主不给释放接口，只能 cancel 叫停。
// 回执不能笼统说「已停掉」，否则用户去会话列表还会看到它，以为没停成功。
test('assign_stop 只能叫停、没法释放时如实说，不谎报停干净', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '整理报销', status: 'running', sessionId: 's1' }],
    released: false,
    sessionActive: true,
  });
  const { run } = build({ assignments });
  const out = await run('assign_stop', { id: 'a-20261021-001' });
  assert.match(out.summary, /已停掉 a-20261021-001/);
  assert.match(out.summary, /还留在列表里/);
  assert.equal(out.data.released, false);
});

// 本来就没在跑（比如插件重启后会话已经没了），不能顺口说「还留在列表里」让用户白去找
test('assign_stop 对本来就没在跑的副手说清楚，不让人去列表里白找', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '整理报销', status: 'offline', sessionId: 's1' }],
    released: false,
    sessionActive: false,
  });
  const { run } = build({ assignments });
  const out = await run('assign_stop', { id: 'a-20261021-001' });
  assert.match(out.summary, /本来就没在跑/);
  assert.doesNotMatch(out.summary, /还留在列表里/);
});

// 默认视图只列活跃的。手上还有活的时候也一样要提一句失联的，
// 否则「2 个活跃 + 3 个失联」会被说成「就这 2 个」，那 3 条线等于凭空消失。
test('assign_list 默认视图里有活跃副手时，也提一句失联的', async () => {
  const items = [
    { id: 'a-20261021-001', purpose: '整理报销', status: 'running', sessionId: 's1' },
    { id: 'a-20261021-002', purpose: '比对合同', status: 'offline', sessionId: 's2' },
    { id: 'a-20261021-003', purpose: '查许可证', status: 'offline', sessionId: 's3' },
  ];
  const assignments = fakeAssignments({ items });
  assignments.list = async (filter) => {
    const want = filter?.status ?? 'active';
    const picked = want === 'all' ? items : items.filter((i) => (want === 'active' ? ['idle', 'running', 'waiting'].includes(i.status) : i.status === want));
    return { items: picked, total: picked.length };
  };
  const { run } = build({ assignments });
  const out = await run('assign_list', {});
  assert.match(out.summary, /整理报销/);
  assert.match(out.summary, /另外有 2 个失联的副手/);
  // 显式问 all 的时候不用再提醒一遍
  const all = await run('assign_list', { status: 'all' });
  assert.doesNotMatch(all.summary, /失联的副手/);
});

test('assign_wait 已经交了报告就立刻返回报告，不空等', async () => {
  const assignments = fakeAssignments({
    items: [
      {
        id: 'a-20261021-001',
        purpose: '整理报销',
        status: 'done',
        sessionId: 's1',
        report: { summary: '报销表整理好了', detail: '在 D:/out/报销.xlsx', expectsReply: false, at: '2026-10-21T03:00:00.000Z' },
      },
    ],
  });
  const { run } = build({ assignments });
  const out = await run('assign_wait', { id: 'a-20261021-001', timeoutMs: 1 });
  assert.equal(out.data.outcome, 'report');
  assert.match(out.summary, /报销表整理好了/);
  assert.match(out.summary, /在 D:\/out\/报销.xlsx/);
});

test('assign_wait 找不到副手时直接报错', async () => {
  const { run } = build({ assignments: fakeAssignments() });
  await assert.rejects(() => run('assign_wait', { id: 'a-20261021-999', timeoutMs: 1 }), /找不到副手/);
});

test('assign_wait 对已经停掉又没报告的副手立刻说清楚，不空等', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-001', purpose: '半路停了', status: 'stopped', sessionId: 's1', stopReason: '不需要了' }],
  });
  const { run } = build({ assignments });
  const started = Date.now();
  const out = await run('assign_wait', { id: 'a-20261021-001', timeoutMs: 5000 });
  assert.equal(out.data.outcome, 'settled');
  assert.match(out.summary, /已经被停掉了/);
  assert.match(out.summary, /不需要了/);
  assert.ok(Date.now() - started < 1000, '不该真的等满 5 秒');
});

test('assign_wait 对已经结束又没报告的副手说它没留报告', async () => {
  const assignments = fakeAssignments({
    items: [{ id: 'a-20261021-002', purpose: '干完了没交报告', status: 'done', sessionId: 's2' }],
  });
  const { run } = build({ assignments });
  const out = await run('assign_wait', { id: 'a-20261021-002', timeoutMs: 5000 });
  assert.equal(out.data.outcome, 'settled');
  assert.match(out.summary, /没有留下报告/);
});

// 副手被叫停时可能还有一份 expectsReply 的报告在路上。报告要留档，
// 但不能再让模型「用 assign_send 回它」—— 那条路必然被拒，模型会白白撞墙。
test('assign_wait 拿到停掉之前的报告时，不说「用 assign_send 回它」', async () => {
  const assignments = fakeAssignments({
    items: [{
      id: 'a-20261021-003',
      purpose: '停之前交过一份要拍板的报告',
      status: 'stopped',
      sessionId: 's3',
      report: { summary: '要你拍板', expectsReply: true, at: '2026-10-21T03:00:00.000Z' },
    }],
  });
  const { run } = build({ assignments });
  const out = await run('assign_wait', { id: 'a-20261021-003', timeoutMs: 5000 });
  assert.equal(out.data.outcome, 'report');
  assert.match(out.summary, /已经被停掉了/);
  assert.doesNotMatch(out.summary, /用 assign_send 回它/);
});

// 名额满时报告照样收下，只是状态不切到 waiting。
// 副手侧如果还说「用户在等你回话」，它会一直干等一句永远不会来的答复。
test('assign_report 在名额满时如实说状态没切过去', async () => {
  const reports = [];
  const runtime = {
    async report(id, input) {
      reports.push({ id, input });
      return {
        assignment: {
          id,
          status: 'done',
          report: { summary: input.summary, expectsReply: input.expectsReply },
        },
        pushed: true,
        slotBlocked: input.expectsReply === true,
      };
    },
  };
  const [tool] = reportTools({ runtime, assignment: { id: 'a-20261021-001' } });
  const out = await tool.execute({ summary: '要你拍板', expectsReply: true }, {});
  assert.match(out.summary, /名额现在满了/);
  assert.doesNotMatch(out.summary, /在等你回话/);
});

test('assign_report 正常等回话时说清用户会回它', async () => {
  const runtime = {
    async report(id, input) {
      return {
        assignment: {
          id,
          status: 'waiting',
          report: { summary: input.summary, expectsReply: true },
        },
        pushed: true,
        slotBlocked: false,
      };
    },
  };
  const [tool] = reportTools({ runtime, assignment: { id: 'a-20261021-001' } });
  const out = await tool.execute({ summary: '要你拍板', expectsReply: true }, {});
  assert.match(out.summary, /在等他回话/);
});

test('work_people 没认出人时说人话，认出来了按名字列', async () => {
  const { tools, run } = build({ assignments: null });
  const empty = await run('work_people', {});
  assert.match(empty.summary, /知识库里还没有人/);
  await mergeExtraction(paths, { people: [{ name: '舒子淇', note: '周五值班', confidence: 0.8 }] }, { log: () => {} });
  const out = await run('work_people', {});
  assert.match(out.summary, /舒子淇/);
  assert.equal(out.data.total, 1);
  assert.ok(tools.length >= 16);
});

test('work_person 查不到人时报清楚，查到了给出关系', async () => {
  const { run } = build({ assignments: null });
  const missing = await run('work_person', { name: '查无此人' });
  assert.match(missing.summary, /知识库里还没有「查无此人」/);
  await mergeExtraction(paths, { people: [{ name: '彭喻', confidence: 0.7 }] }, { log: () => {} });
  const out = await run('work_person', { name: '彭喻' });
  assert.match(out.summary, /彭喻/);
  assert.equal(out.data.name, '彭喻');
});
