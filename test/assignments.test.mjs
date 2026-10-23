import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../lib/db.js';
import { dataPaths } from '../lib/paths.js';
import {
  ASSIGN_LIMIT_MAX,
  activeAssignments,
  assertSlot,
  attachSession,
  createAssignment,
  createAssignmentStore,
  emptyAssignments,
  getAssignment,
  listAssignments,
  promote,
  recordReport,
  renderAssignmentDetail,
  renderAssignmentList,
  stopAssignment,
  updateAssignment,
} from '../lib/assignments.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-21T03:00:00.000Z'); // 2026-10-21 11:00 +08:00

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-assign-'));
  return dataPaths(dir);
}

test('createAssignment 生成按天递增的 id，默认 idle', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '整理 Q3 报销表' }, NOW, { timeZone: TZ, limit: 32 });
  const b = createAssignment(book, { purpose: '写周报' }, NOW, { timeZone: TZ, limit: 32 });

  assert.equal(a.id, 'a-20261021-001');
  assert.equal(b.id, 'a-20261021-002');
  assert.equal(a.status, 'idle');
  assert.equal(a.sessionId, null);
  assert.equal(a.report, null);
  assert.deepEqual(a.reports, []);
});

test('跨天重新计数', () => {
  const book = emptyAssignments();
  createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  const next = createAssignment(book, { purpose: '二' }, new Date('2026-10-22T03:00:00.000Z'), { timeZone: TZ, limit: 32 });
  assert.equal(next.id, 'a-20261022-001');
});

test('purpose 不能为空', () => {
  assert.throws(() => createAssignment(emptyAssignments(), { purpose: '  ' }, NOW, {}), /purpose 不能为空/);
});

test('超过并发上限抛 ASSIGN_LIMIT_REACHED，带 limit 和 active', () => {
  const book = emptyAssignments();
  createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 2 });
  createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 2 });

  let caught;
  try {
    createAssignment(book, { purpose: '三' }, NOW, { timeZone: TZ, limit: 2 });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught?.code, 'ASSIGN_LIMIT_REACHED');
  assert.equal(caught?.limit, 2);
  assert.equal(caught?.active, 2);
  assert.match(caught.message, /副手已经开满了/);
  assert.match(caught.message, /一/);
});

test('done 和 stopped 不占并发名额', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 1 });
  createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 2 });
  stopAssignment(book, a.id, '不用了', NOW);
  const c = createAssignment(book, { purpose: '三' }, NOW, { timeZone: TZ, limit: 2 });
  assert.equal(c.status, 'idle');
});

// 「已收尾 → 活跃」这条迁移有三个入口（补话、外部事件唤醒、再交一份等回话的报告），
// 各写一遍必然漏。统一走 promote，名额在这里数。
test('promote 从 done 回到 idle 时数名额，满了就抛', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 1 });
  recordReport(book, a.id, { summary: '干完了' }, NOW);
  createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 1 });

  let caught;
  try {
    promote(book, a.id, 'idle', { limit: 1 });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught?.code, 'ASSIGN_LIMIT_REACHED');
  assert.equal(getAssignment(book, a.id).status, 'done', '被拦住就不该改状态');
});

test('promote 在活跃状态之间切换不数名额', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 1 });
  promote(book, a.id, 'running', { limit: 1 });
  assert.equal(getAssignment(book, a.id).status, 'running');
});

test('promote 不会把 stopped 拉回来', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  stopAssignment(book, a.id, '不用了', NOW);
  promote(book, a.id, 'running', { limit: 32 });
  assert.equal(getAssignment(book, a.id).status, 'stopped');
});

test('promote 找不到副手时报错', () => {
  const book = emptyAssignments();
  assert.throws(() => promote(book, 'a-20990101-001', 'idle', { limit: 3 }), /找不到副手/);
});

// 给副手发消息是「先投递再记账」，所以必须在投递之前就知道名额够不够
test('assertSlot 只查不改：名额够就放过，不够就抛', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 1 });
  recordReport(book, a.id, { summary: '干完了' }, NOW);

  assert.doesNotThrow(() => assertSlot(book, a.id, 'idle', 1));
  createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 1 });
  assert.throws(() => assertSlot(book, a.id, 'idle', 1), (err) => err.code === 'ASSIGN_LIMIT_REACHED');
  assert.equal(getAssignment(book, a.id).status, 'done', 'assertSlot 不许改状态');
});

test('assertSlot 对非活跃目标状态和已停掉的副手都放过', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 2 });
  createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 2 });
  // 目标状态不是活跃态，不占名额，不用查
  assert.doesNotThrow(() => assertSlot(book, a.id, 'done', 1));

  stopAssignment(book, a.id, '不用了', NOW);
  assert.doesNotThrow(() => assertSlot(book, a.id, 'idle', 1));
});

test('attachSession 写入会话 id', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  attachSession(book, a.id, 'wa:asg:a-20261021-001', NOW);
  assert.equal(getAssignment(book, a.id).sessionId, 'wa:asg:a-20261021-001');
});

test('recordReport 落报告并把状态改成 done', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  recordReport(book, a.id, { summary: '整理好了，12 笔' }, NOW);

  const after = getAssignment(book, a.id);
  assert.equal(after.status, 'done');
  assert.equal(after.report.summary, '整理好了，12 笔');
  assert.equal(after.report.expectsReply, false);
  assert.equal(after.reports.length, 1);
});

test('recordReport 带 expectsReply 时状态是 waiting', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  recordReport(book, a.id, { summary: '卡住了，要你确认', expectsReply: true }, NOW);
  assert.equal(getAssignment(book, a.id).status, 'waiting');
});

test('recordReport 的 summary 不能为空', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  assert.throws(() => recordReport(book, a.id, { summary: '   ' }, NOW), /summary 不能为空/);
});

test('停掉之后迟到的报告留档，但不把状态复活', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  stopAssignment(book, a.id, '用户叫停', NOW);
  recordReport(book, a.id, { summary: '我这边刚干完' }, NOW);
  const after = getAssignment(book, a.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.reports.length, 1);
  assert.equal(after.report.summary, '我这边刚干完');
});

test('reports 最多留 20 条，丢最老的', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  for (let i = 0; i < 25; i += 1) {
    recordReport(book, a.id, { summary: `第 ${i} 次` }, NOW);
  }
  const after = getAssignment(book, a.id);
  assert.equal(after.reports.length, 20);
  assert.equal(after.reports[0].summary, '第 5 次');
  assert.equal(after.reports.at(-1).summary, '第 24 次');
});

test('stopAssignment 记原因', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  stopAssignment(book, a.id, '方向不对', NOW);
  const after = getAssignment(book, a.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.stopReason, '方向不对');
});

test('updateAssignment 拒绝不认识的状态', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  assert.throws(() => updateAssignment(book, a.id, { status: '飞了' }, NOW), /副手状态只能是/);
});

test('listAssignments 按状态过滤，active 只算 idle/running/waiting', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 });
  const b = createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 32 });
  const c = createAssignment(book, { purpose: '三' }, NOW, { timeZone: TZ, limit: 32 });
  recordReport(book, a.id, { summary: '好了' }, NOW);
  stopAssignment(book, b.id, '', NOW);
  updateAssignment(book, c.id, { status: 'running' }, NOW);

  assert.equal(listAssignments(book, {}, NOW).total, 3);
  assert.equal(listAssignments(book, { status: 'active' }, NOW).total, 1);
  assert.equal(listAssignments(book, { status: 'done' }, NOW).total, 1);
  assert.equal(listAssignments(book, { status: 'stopped' }, NOW).total, 1);
  assert.equal(activeAssignments(book).length, 1);
});

test('listAssignments 支持 limit', () => {
  const book = emptyAssignments();
  for (let i = 0; i < 5; i += 1) createAssignment(book, { purpose: `第 ${i} 件` }, NOW, { timeZone: TZ, limit: 32 });
  const page = listAssignments(book, { limit: 2 }, NOW);
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 5);
});

test('renderAssignmentList 空列表给人话', () => {
  assert.match(renderAssignmentList({ items: [], total: 0 }), /现在没有副手/);
});

test('renderAssignmentList 带状态、对应工作项和最新报告', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '整理 Q3 报销表', itemId: 'w-20261021-003' }, NOW, { timeZone: TZ, limit: 32 });
  recordReport(book, a.id, { summary: '12 笔，共 8642 元' }, NOW);
  const text = renderAssignmentList(listAssignments(book, {}, NOW));
  assert.match(text, /a-20261021-001/);
  assert.match(text, /已交活/);
  assert.match(text, /整理 Q3 报销表/);
  assert.match(text, /w-20261021-003/);
  assert.match(text, /12 笔/);
});

test('renderAssignmentList 超长截断', () => {
  const book = emptyAssignments();
  for (let i = 0; i < 20; i += 1) createAssignment(book, { purpose: `第 ${i} 件很长的活儿名称` }, NOW, { timeZone: TZ, limit: 32 });
  const text = renderAssignmentList(listAssignments(book, {}, NOW), { maxChars: 120 });
  assert.ok(text.length <= 120);
  assert.match(text, /后面还有/);
});

test('renderAssignmentDetail 带事件尾巴和等待回话提示', () => {
  const book = emptyAssignments();
  const a = createAssignment(book, { purpose: '整理 Q3 报销表' }, NOW, { timeZone: TZ, limit: 32 });
  attachSession(book, a.id, 'wa:asg:a-20261021-001', NOW);
  recordReport(book, a.id, { summary: '卡在审批口径', detail: '两种算法差 300 块', expectsReply: true }, NOW);

  const text = renderAssignmentDetail(getAssignment(book, a.id), { tail: ['调用了 work_list', '写了 3 个文件'] });
  assert.match(text, /等你回话/);
  assert.match(text, /整理 Q3 报销表/);
  assert.match(text, /wa:asg:a-20261021-001/);
  assert.match(text, /卡在审批口径/);
  assert.match(text, /两种算法差 300 块/);
  assert.match(text, /它在等你回话/);
  assert.match(text, /调用了 work_list/);
});

test('renderAssignmentDetail 没有副手时给人话', () => {
  assert.match(renderAssignmentDetail(null), /没有这个副手/);
});

test('createAssignmentStore 落盘再读回来', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  const created = await store.mutate((book) => createAssignment(book, { purpose: '整理报销' }, NOW, { timeZone: TZ, limit: 32 }));
  assert.equal(created.id, 'a-20261021-001');

  const reopened = createAssignmentStore(paths, { log: () => {} });
  const listed = await reopened.read((book) => listAssignments(book, {}, NOW));
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].purpose, '整理报销');
});

test('createAssignmentStore 的 limit 传进 createAssignment', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {}, limit: 1 });
  await store.mutate((book) => createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: store.limit }));
  await assert.rejects(
    () => store.mutate((book) => createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: store.limit })),
    /副手已经开满了/,
  );
});

test('createAssignmentStore 遇到坏库改名留档并回退空登记簿', async () => {
  const paths = scratch();
  // 拿一段不是 SQLite 的字节冒充库文件：真坏库就是这种表现
  writeFileSync(paths.db, '这不是一个 sqlite 库', 'utf8');
  const logs = [];
  const store = createAssignmentStore(paths, { log: (line) => logs.push(line) });
  const listed = await store.read((book) => listAssignments(book, {}, NOW));
  assert.equal(listed.total, 0);
  assert.ok(logs.some((line) => line.includes('另存为')), '坏库应该被改名留档');
});

test('createAssignmentStore 写入失败时回滚内存', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  await store.mutate((book) => createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 }));

  await assert.rejects(() => store.mutate((book) => {
    createAssignment(book, { purpose: '二' }, NOW, { timeZone: TZ, limit: 32 });
    throw new Error('半路炸了');
  }), /半路炸了/);

  const listed = await store.read((book) => listAssignments(book, {}, NOW));
  assert.equal(listed.total, 1);
});

test('createAssignmentStore 丢弃库里结构不对的行', async () => {
  const paths = scratch();
  // 直接往库里塞脏行：没 id 的、没 purpose 的，读出来都该被丢掉
  const db = openDb(paths, { log: () => {} });
  const insert = db.prepare(
    'INSERT INTO assignments (id, position, purpose, status, reports) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('a-20261021-001', 0, '好的', 'idle', '[]');
  insert.run('', 1, '没 id', 'idle', '[]');
  insert.run('a-20261021-002', 2, '', 'idle', '[]');
  db.close();

  const store = createAssignmentStore(paths, { log: () => {} });
  const listed = await store.read((book) => listAssignments(book, {}, NOW));
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].purpose, '好的');
  assert.equal(listed.items[0].status, 'idle');
});

test('ASSIGN_LIMIT_MAX 是 32', () => {
  assert.equal(ASSIGN_LIMIT_MAX, 32);
});

test('落盘落在数据库里，行字段完整', async () => {
  const paths = scratch();
  const store = createAssignmentStore(paths, { log: () => {} });
  await store.mutate((book) => createAssignment(book, { purpose: '一' }, NOW, { timeZone: TZ, limit: 32 }));
  const db = openDb(paths, { log: () => {} });
  const row = db.prepare('SELECT * FROM assignments').get();
  db.close();
  assert.equal(row.purpose, '一');
  assert.equal(row.status, 'idle');
  assert.equal(row.reports, '[]');
});
