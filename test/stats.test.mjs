import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStats } from '../lib/stats.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-21T04:00:00.000Z'); // 2026-10-21 12:00 +08:00

function item(over) {
  return {
    id: 'w-x',
    title: 'x',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    createdAt: '2026-10-20T01:00:00.000Z',
    doneAt: null,
    tags: [],
    assignee: null,
    ...over,
  };
}

test('空账本也给出一份能画图的空统计', () => {
  const s = buildStats({ items: [] }, NOW, TZ);
  assert.equal(s.counts.open, 0);
  assert.equal(s.counts.doneWeek, 0);
  assert.equal(s.counts.stale, 0);
  assert.deepEqual(s.byPriority, { high: 0, normal: 0, low: 0 });
  assert.deepEqual(s.byTag, []);
  assert.deepEqual(s.assignees, []);
  assert.deepEqual(s.oldest, []);
  assert.equal(s.trend.length, 14);
  assert.equal(s.trend[13].date, '2026-10-21');
  assert.equal(s.trend[0].date, '2026-10-08');
});

test('账本字段缺失或不是数组时不抛', () => {
  assert.equal(buildStats({}, NOW, TZ).counts.open, 0);
  assert.equal(buildStats(null, NOW, TZ).counts.open, 0);
  assert.equal(buildStats({ items: null }, NOW, TZ).total, 0);
});

test('优先级分布只统计未完成项', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', priority: 'high' }),
        item({ id: 'b', priority: 'normal' }),
        item({ id: 'c', priority: 'low', status: 'doing' }),
        item({ id: 'd', priority: 'high', status: 'done', doneAt: '2026-10-21T02:00:00.000Z' }),
      ],
    },
    NOW,
    TZ,
  );
  assert.deepEqual(s.byPriority, { high: 1, normal: 1, low: 1 });
  assert.equal(s.counts.open, 3);
  assert.equal(s.counts.doing, 1);
  assert.equal(s.counts.done, 1);
});

test('标签按出现次数降序，一条挂多个标签各算一次', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', tags: ['财务', '报销'] }),
        item({ id: 'b', tags: ['财务'] }),
        item({ id: 'c', tags: [] }),
      ],
    },
    NOW,
    TZ,
  );
  assert.deepEqual(s.byTag, [
    { tag: '财务', count: 2 },
    { tag: '报销', count: 1 },
  ]);
});

test('趋势按天分桶，新增和完成各走各的字段', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', createdAt: '2026-10-21T01:00:00.000Z' }),
        item({ id: 'b', status: 'done', createdAt: '2026-10-18T01:00:00.000Z', doneAt: '2026-10-21T02:00:00.000Z' }),
      ],
    },
    NOW,
    TZ,
  );
  const today = s.trend.find((d) => d.date === '2026-10-21');
  const threeDaysAgo = s.trend.find((d) => d.date === '2026-10-18');
  assert.equal(today.created, 1);
  assert.equal(today.done, 1);
  assert.equal(threeDaysAgo.created, 1);
  assert.equal(threeDaysAgo.done, 0);
});

test('趋势不把坏时间戳算进去', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', createdAt: '不是时间' }),
        item({ id: 'b', status: 'done', createdAt: '也坏了', doneAt: 'oops' }),
      ],
    },
    NOW,
    TZ,
  );
  assert.equal(
    s.trend.reduce((sum, d) => sum + d.created + d.done, 0),
    0,
  );
});

test('等谁只算有名字的未完成项，同名合并', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', assignee: { name: '广超' } }),
        item({ id: 'b', assignee: { name: '广超' } }),
        item({ id: 'c', assignee: { name: '李四' } }),
        item({ id: 'd', assignee: null }),
        item({ id: 'e', assignee: { name: '王五' }, status: 'done' }),
      ],
    },
    NOW,
    TZ,
  );
  assert.deepEqual(s.assignees, [
    { name: '广超', count: 2 },
    { name: '李四', count: 1 },
  ]);
});

test('最久没动按创建时间倒序，只含未完成项，默认最多 5 条', () => {
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    items.push(item({ id: `w-${i}`, createdAt: `2026-10-${String(10 + i).padStart(2, '0')}T01:00:00.000Z` }));
  }
  items.push(item({ id: 'done-one', status: 'done', createdAt: '2026-01-01T01:00:00.000Z' }));
  const s = buildStats({ items }, NOW, TZ);
  assert.equal(s.oldest.length, 5);
  assert.equal(s.oldest[0].id, 'w-0');
  assert.ok(s.oldest.every((row) => row.id !== 'done-one'));
  assert.ok(s.oldest[0].ageDays > s.oldest[4].ageDays);
});

test('一周内做完的和新记的分开计数，超过一周没动的算拖着', () => {
  const s = buildStats(
    {
      items: [
        item({ id: 'a', createdAt: '2026-10-20T01:00:00.000Z' }),
        item({ id: 'b', status: 'done', createdAt: '2026-10-20T01:00:00.000Z', doneAt: '2026-10-21T01:00:00.000Z' }),
        item({ id: 'c', createdAt: '2026-09-01T01:00:00.000Z' }),
        item({ id: 'd', status: 'doing', createdAt: '2026-09-01T01:00:00.000Z' }),
      ],
    },
    NOW,
    TZ,
  );
  assert.equal(s.counts.createdWeek, 2);
  assert.equal(s.counts.doneWeek, 1);
  // 拖着只看 open：doing 那条不算
  assert.equal(s.counts.stale, 1);
});

test('时区不同，日期桶落在不同天', () => {
  const ledger = { items: [item({ id: 'a', createdAt: '2026-10-20T20:00:00.000Z' })] };
  const shanghai = buildStats(ledger, NOW, 'Asia/Shanghai');
  const utc = buildStats(ledger, NOW, 'UTC');
  const shDate = shanghai.trend.find((d) => d.created === 1)?.date;
  const utcDate = utc.trend.find((d) => d.created === 1)?.date;
  assert.equal(shDate, '2026-10-21');
  assert.equal(utcDate, '2026-10-20');
});
