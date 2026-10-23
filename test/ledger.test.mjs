import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addItem,
  digest,
  dueReminders,
  emptyLedger,
  findDuplicate,
  findItem,
  listItems,
  renderDigest,
  updateItem,
  urgencyOf,
} from '../lib/ledger.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-20T03:00:00.000Z'); // 2026-10-20 11:00 +08:00

test('addItem 生成按天递增的 id 并补齐默认值', () => {
  const ledger = emptyLedger();
  const a = addItem(ledger, { title: '整理 Q3 报销表' }, NOW, TZ).item;
  const b = addItem(ledger, { title: '回复李四' }, NOW, TZ).item;

  assert.equal(a.id, 'w-20261020-001');
  assert.equal(b.id, 'w-20261020-002');
  assert.equal(a.status, 'open');
  assert.equal(a.priority, 'normal');
  assert.equal(a.actionable, false);
  assert.deepEqual(a.tags, []);
  assert.equal(a.remindAt, null);
});

test('addItem 打标签去重、期限归一化，并自动提前一小时提醒', () => {
  const ledger = emptyLedger();
  const { item } = addItem(
    ledger,
    { title: '准备评审', tags: ['评审', '评审', ' 材料 '], dueAt: '2026-10-23 15:00', priority: 'high' },
    NOW,
    TZ,
  );

  assert.deepEqual(item.tags, ['评审', '材料']);
  assert.equal(item.dueAt, '2026-10-23T07:00:00.000Z');
  assert.equal(item.remindAt, '2026-10-23T06:00:00.000Z');
  assert.equal(item.priority, 'high');
});

test('addItem 标题为空直接抛错', () => {
  const ledger = emptyLedger();
  assert.throws(() => addItem(ledger, { title: '   ' }, NOW, TZ), /title/);
});

test('updateItem 把状态改成 done 时记 doneAt，并停止提醒', () => {
  const ledger = emptyLedger();
  const { item } = addItem(ledger, { title: '回复邮件', remindAt: '2026-10-20 11:30' }, NOW, TZ);
  assert.equal(item.remindAt, '2026-10-20T03:30:00.000Z');

  const later = new Date('2026-10-20T05:00:00.000Z');
  const updated = updateItem(ledger, item.id, { status: 'done', note: '已经回完了' }, later, TZ).item;
  assert.equal(updated.status, 'done');
  assert.equal(updated.doneAt, later.toISOString());
  assert.equal(updated.remindedAt, later.toISOString());
  assert.equal(updated.notes.length, 1);
  assert.equal(updated.notes[0].text, '已经回完了');
});

test('updateItem 对不存在的 id 抛错', () => {
  const ledger = emptyLedger();
  assert.throws(() => updateItem(ledger, 'w-19700101-001', { status: 'done' }, NOW, TZ), /找不到/);
});

test('updateItem 清空 remindAt 时同时清 remindedAt', () => {
  const ledger = emptyLedger();
  const { item } = addItem(ledger, { title: '看看风险清单' }, NOW, TZ);
  updateItem(ledger, item.id, { remindAt: '2026-10-20 11:10' }, NOW, TZ);
  const cleared = updateItem(ledger, item.id, { remindAt: '' }, NOW, TZ).item;
  assert.equal(cleared.remindAt, null);
  assert.equal(cleared.remindedAt, null);
});

test('listItems 默认只列未完成，按期限与优先级排序', () => {
  const ledger = emptyLedger();
  addItem(ledger, { title: '低优先无期限', priority: 'low' }, NOW, TZ);
  addItem(ledger, { title: '后天到期', dueAt: '2026-10-22 10:00' }, NOW, TZ);
  addItem(ledger, { title: '明天到期', dueAt: '2026-10-21 10:00', priority: 'high' }, NOW, TZ);
  const done = addItem(ledger, { title: '已经做完' }, NOW, TZ).item;
  updateItem(ledger, done.id, { status: 'done' }, NOW, TZ);

  const result = listItems(ledger, {}, NOW, TZ);
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map((i) => i.title), ['明天到期', '后天到期', '低优先无期限']);

  const all = listItems(ledger, { status: 'all' }, NOW, TZ);
  assert.equal(all.total, 4);
});

test('listItems 支持 dueWithinDays 与 tag 过滤', () => {
  const ledger = emptyLedger();
  addItem(ledger, { title: '本周内', dueAt: '2026-10-24 10:00', tags: ['财务'] }, NOW, TZ);
  addItem(ledger, { title: '下周', dueAt: '2026-11-05 10:00', tags: ['财务'] }, NOW, TZ);
  addItem(ledger, { title: '本周别的', dueAt: '2026-10-22 10:00', tags: ['研发'] }, NOW, TZ);

  const soon = listItems(ledger, { dueWithinDays: 7 }, NOW, TZ);
  assert.deepEqual(soon.items.map((i) => i.title), ['本周别的', '本周内']);

  const finance = listItems(ledger, { tag: '财务' }, NOW, TZ);
  assert.equal(finance.total, 2);
});

test('dueReminders 只取到期且未提醒的未完成项', () => {
  const ledger = emptyLedger();
  const due = addItem(ledger, { title: '马上提醒', remindAt: '2026-10-20 10:59' }, NOW, TZ).item;
  addItem(ledger, { title: '还没到', remindAt: '2026-10-20 12:00' }, NOW, TZ);
  const doneItem = addItem(ledger, { title: '已完成但设了提醒', remindAt: '2026-10-20 10:00' }, NOW, TZ).item;
  updateItem(ledger, doneItem.id, { status: 'done' }, NOW, TZ);

  const list = dueReminders(ledger, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, due.id);
});

test('digest 把未完成项分成逾期/今天/本周/更远', () => {
  const ledger = emptyLedger();
  addItem(ledger, { title: '前天就过期', dueAt: '2026-10-18 10:00', priority: 'high' }, NOW, TZ);
  addItem(ledger, { title: '今天要做', dueAt: '2026-10-20 18:00' }, NOW, TZ);
  addItem(ledger, { title: '本周要做', dueAt: '2026-10-23 10:00' }, NOW, TZ);
  addItem(ledger, { title: '下个月再说', dueAt: '2026-11-20 10:00' }, NOW, TZ);
  addItem(ledger, { title: '没定日期', actionable: true, suggestedAction: '帮你查资料' }, NOW, TZ);

  const data = digest(ledger, NOW, TZ);
  assert.equal(data.counts.open, 5);
  assert.deepEqual(data.overdue.map((i) => i.title), ['前天就过期']);
  assert.deepEqual(data.today.map((i) => i.title), ['今天要做']);
  assert.deepEqual(data.upcoming.map((i) => i.title), ['本周要做']);
  assert.equal(data.someday.length, 2);
  assert.equal(data.counts.actionable, 1);
});

test('renderDigest 输出人话并对空账本给一句结论', () => {
  const empty = renderDigest(digest(emptyLedger(), NOW, TZ), { timeZone: TZ });
  assert.equal(empty, '手上没有未完成的活儿。');

  const ledger = emptyLedger();
  addItem(ledger, { title: '整理报销表', dueAt: '2026-10-18 10:00', priority: 'high', actionable: true }, NOW, TZ);
  addItem(ledger, { title: '回复李四', dueAt: '2026-10-20 18:00' }, NOW, TZ);

  const text = renderDigest(digest(ledger, NOW, TZ), { timeZone: TZ });
  assert.match(text, /还有 2 件事没完成/);
  assert.match(text, /其中 1 件已逾期/);
  assert.match(text, /逾期 1 件/);
  assert.match(text, /1\. \[高\] 整理报销表 原定 10\/18/);
  assert.match(text, /其中第 1 件我可以直接代做/);
});

test('renderDigest 超过长度上限会截断', () => {
  const ledger = emptyLedger();
  for (let i = 0; i < 40; i += 1) {
    addItem(ledger, { title: `第 ${i} 件比较长的工作项名称用于撑爆长度`, dueAt: '2026-10-18 10:00' }, NOW, TZ);
  }
  const text = renderDigest(digest(ledger, NOW, TZ), { timeZone: TZ, maxChars: 300 });
  assert.ok(text.length <= 300, `实际 ${text.length}`);
  assert.match(text, /后面还有/);
});

test('findItem 找不到返回 null', () => {
  const ledger = emptyLedger();
  assert.equal(findItem(ledger, 'nope'), null);
});

test('没给优先级时按措辞和期限自动判', () => {
  const ledger = emptyLedger();
  const urgent = addItem(ledger, { title: '催一下供应商发货' }, NOW, TZ).item;
  assert.equal(urgent.priority, 'high');
  assert.equal(urgent.priorityAuto, true);

  const soon = addItem(ledger, { title: '交周报', dueAt: '2026-10-21 10:00' }, NOW, TZ).item;
  assert.equal(soon.priority, 'high', '48 小时内到期算高');

  const far = addItem(ledger, { title: '整理旧资料', dueAt: '2026-11-20 10:00' }, NOW, TZ).item;
  assert.equal(far.priority, 'normal');

  const manual = addItem(ledger, { title: '随便记一下', priority: 'low' }, NOW, TZ).item;
  assert.equal(manual.priority, 'low');
  assert.equal(manual.priorityAuto, false);
});

test('人工改过优先级之后不再算自动推断', () => {
  const ledger = emptyLedger();
  const { item } = addItem(ledger, { title: '催一下供应商发货' }, NOW, TZ);
  assert.equal(item.priorityAuto, true);
  const changed = updateItem(ledger, item.id, { priority: 'low' }, NOW, TZ).item;
  assert.equal(changed.priority, 'low');
  assert.equal(changed.priorityAuto, false);
});

test('urgencyOf 让逾期和临近到期的排前面', () => {
  const base = { status: 'open', priority: 'normal', createdAt: NOW.toISOString() };
  const overdue = urgencyOf({ ...base, dueAt: '2026-10-18 10:00' }, NOW);
  const today = urgencyOf({ ...base, dueAt: '2026-10-20 18:00' }, NOW);
  const far = urgencyOf({ ...base, dueAt: '2026-11-20 10:00' }, NOW);
  const none = urgencyOf({ ...base, dueAt: null }, NOW);
  assert.ok(overdue > today);
  assert.ok(today > far);
  assert.ok(far > none);
});

test('findDuplicate 认出同标题的未完成项，做完的就不算', () => {
  const ledger = emptyLedger();
  const { item } = addItem(ledger, { title: '安排值班表' }, NOW, TZ);
  assert.equal(findDuplicate(ledger, ' 安排值班表 ')?.id, item.id);
  assert.equal(findDuplicate(ledger, '安排值班表。')?.id, item.id, '标点差异也算同一条');
  assert.equal(findDuplicate(ledger, '准备周五教学材料'), null);
  updateItem(ledger, item.id, { status: 'done' }, NOW, TZ);
  assert.equal(findDuplicate(ledger, '安排值班表'), null, '做完的可以重新记');
});

test('renderDigest 不再漏掉没定期限的活儿', () => {
  const ledger = emptyLedger();
  addItem(ledger, { title: '安排值班表' }, NOW, TZ);
  addItem(ledger, { title: '准备教学材料' }, NOW, TZ);
  const text = renderDigest(digest(ledger, NOW, TZ), { timeZone: TZ });
  assert.match(text, /还有 2 件事没完成/);
  assert.match(text, /没定期限 2 件/);
  assert.match(text, /安排值班表/);
  assert.match(text, /准备教学材料/);
});
