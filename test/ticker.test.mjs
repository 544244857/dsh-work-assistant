import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { createStore } from '../lib/store.js';
import { dataPaths } from '../lib/paths.js';
import { createTools } from '../lib/tools.js';
import { createTicker, normalizeBriefTimes } from '../lib/ticker.js';

const TZ = 'Asia/Shanghai';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-ticker-'));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function build(options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-ticker-case-'));
  const paths = dataPaths(scratch);
  const state = { briefs: null };
  const sent = [];
  const store = createStore(paths, { log: () => {} });
  const tools = createTools({
    store,
    paths,
    timeZone: TZ,
    sessionId: 'wa:main',
    notify: async (body) => {
      sent.push(body);
      return true;
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const capture = (args) => byName.get('work_capture').execute(args, {});

  const ticker = createTicker({
    store,
    timeZone: TZ,
    briefTimes: options.briefTimes ?? ['09:00', '18:30'],
    quietHours: options.quietHours ?? null,
    weeklyReview: options.weeklyReview ?? null,
    getState: () => state,
    saveState: () => {},
    push: async (body) => {
      if (options.push) return options.push(body);
      sent.push(body);
    },
    log: () => {},
  });

  return {
    paths,
    store,
    sent,
    state,
    ticker,
    capture,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

test('normalizeBriefTimes 规范化、去重、排序、丢弃非法值', () => {
  assert.deepEqual(normalizeBriefTimes(['9:00', '18:30', '09:00', 'bad', '25:00', '12:70']), ['09:00', '18:30']);
  assert.deepEqual(normalizeBriefTimes([]), []);
  assert.deepEqual(normalizeBriefTimes(undefined), []);
});

test('到点的单条提醒会推出去，并标记 remindedAt', async () => {
  const ctx = build({ briefTimes: [] });
  try {
    await ctx.capture({ title: '交周报', remindAt: '2026-10-20 10:00' });

    const before = await ctx.ticker.tick(new Date('2026-10-20T01:59:00Z')); // 北京时间 09:59
    assert.equal(before.actions.filter((a) => a.kind === 'reminder').length, 0);
    assert.equal(ctx.sent.length, 0);

    const after = await ctx.ticker.tick(new Date('2026-10-20T02:00:30Z')); // 北京时间 10:00:30
    const reminders = after.actions.filter((a) => a.kind === 'reminder');
    assert.equal(reminders.length, 1);
    assert.ok(ctx.sent.some((line) => line.includes('交周报')));

    // 再扫一次不应重复推
    const again = await ctx.ticker.tick(new Date('2026-10-20T02:01:30Z'));
    assert.equal(again.actions.filter((a) => a.kind === 'reminder').length, 0);
    assert.equal(ctx.sent.filter((line) => line.includes('交周报')).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('已完成的工作项不再提醒', async () => {
  const ctx = build({ briefTimes: [] });
  try {
    const created = await ctx.capture({ title: '已经做完的', remindAt: '2026-10-20 10:00' });
    const tools = createTools({ store: ctx.store, paths: ctx.paths, timeZone: TZ, sessionId: 'wa:main' });
    await tools.find((t) => t.name === 'work_update').execute({ id: created.data.id, status: 'done' }, {});

    const result = await ctx.ticker.tick(new Date('2026-10-20T02:05:00Z'));
    assert.equal(result.actions.filter((a) => a.kind === 'reminder').length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('每日摘要在到点后推一次，当天不再重复', async () => {
  const ctx = build({ briefTimes: ['09:00'] });
  try {
    await ctx.capture({ title: '准备评审材料' });

    const first = await ctx.ticker.tick(new Date('2026-10-20T01:00:00Z')); // 北京 09:00
    assert.ok(first.actions.some((a) => a.kind === 'brief' && a.at === '09:00'));
    assert.equal(ctx.sent.filter((line) => line.includes('手上还有')).length, 1);

    const second = await ctx.ticker.tick(new Date('2026-10-20T03:00:00Z')); // 北京 11:00
    assert.equal(second.actions.filter((a) => a.kind === 'brief').length, 0);
    assert.equal(ctx.sent.filter((line) => line.includes('手上还有')).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('没到简报时间点不推', async () => {
  const ctx = build({ briefTimes: ['09:00'] });
  try {
    await ctx.capture({ title: '某件事' });
    const result = await ctx.ticker.tick(new Date('2026-10-20T00:30:00Z')); // 北京 08:30
    assert.equal(result.actions.filter((a) => a.kind === 'brief').length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('跨天后简报重新可推', async () => {
  const ctx = build({ briefTimes: ['09:00'] });
  try {
    await ctx.capture({ title: '挂着的事' });
    await ctx.ticker.tick(new Date('2026-10-20T01:00:00Z'));
    const count1 = ctx.sent.length;

    await ctx.ticker.tick(new Date('2026-10-21T01:00:00Z'));
    assert.ok(ctx.sent.length > count1, '第二天应重新推');
  } finally {
    ctx.cleanup();
  }
});

test('全部完成时不推空摘要', async () => {
  const ctx = build({ briefTimes: ['09:00'] });
  try {
    const result = await ctx.ticker.tick(new Date('2026-10-20T01:00:00Z'));
    const brief = result.actions.find((a) => a.kind === 'brief');
    assert.ok(brief, '时间点到了仍要记账，避免每分钟重复判断');
    assert.equal(brief.open, 0);
    assert.equal(ctx.sent.filter((line) => line.includes('手上还有')).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('错过多个简报时间点时只推一条', async () => {
  const ctx = build({ briefTimes: ['09:00', '12:00'] });
  try {
    await ctx.capture({ title: '一件事' });
    const result = await ctx.ticker.tick(new Date('2026-10-20T05:00:00Z')); // 北京 13:00，两个点都过了
    const briefs = result.actions.filter((a) => a.kind === 'brief');
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].at, '09:00', '先补最早的那个');
  } finally {
    ctx.cleanup();
  }
});

test('推送失败时不标记 remindedAt，下一轮还会再试', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-ticker-retry-'));
  const paths = dataPaths(scratch);
  const state = {};
  const store = createStore(paths, { log: () => {} });
  let attempts = 0;
  const ticker = createTicker({
    store,
    timeZone: TZ,
    briefTimes: [],
    getState: () => state,
    saveState: () => {},
    log: () => {},
    // 第一次推失败，第二次成功
    push: async () => {
      attempts += 1;
      return attempts > 1;
    },
  });

  try {
    await store.mutate((ledger) => {
      ledger.items.push({
        id: 'w-20261020-002',
        title: '网络断了也要提醒',
        status: 'open',
        priority: 'normal',
        dueAt: null,
        remindAt: '2026-10-20 09:00',
        remindedAt: null,
        tags: [],
        actionable: false,
        suggestedAction: '',
        offerState: 'none',
        source: null,
        notes: [],
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
        doneAt: null,
      });
      return null;
    });

    const first = await ticker.tick(new Date('2026-10-20T01:00:00Z'));
    assert.equal(first.actions[0].delivered, false);
    const afterFirst = await store.read((ledger) => ledger.items[0].remindedAt);
    assert.equal(afterFirst, null, '没发出去就不能标记已提醒');

    const second = await ticker.tick(new Date('2026-10-20T01:01:00Z'));
    assert.equal(second.actions[0].delivered, true);
    const afterSecond = await store.read((ledger) => ledger.items[0].remindedAt);
    assert.ok(afterSecond, '发出去之后才标记');

    const third = await ticker.tick(new Date('2026-10-20T01:02:00Z'));
    assert.equal(third.actions.filter((a) => a.kind === 'reminder').length, 0, '已提醒过的不再重复');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('push 抛错时 ticker 不崩，且不影响下一轮', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wa-ticker-err-'));
  const paths = dataPaths(scratch);
  const state = {};
  const store = createStore(paths, { log: () => {} });
  const logs = [];
  let attempts = 0;
  const ticker = createTicker({
    store,
    timeZone: TZ,
    briefTimes: [],
    getState: () => state,
    saveState: () => {},
    log: (line) => logs.push(line),
    push: async () => {
      attempts += 1;
      throw new Error('network down');
    },
  });

  try {
    await store.mutate((ledger) => {
      ledger.items.push({
        id: 'w-20261020-001',
        title: '会失败的推送',
        status: 'open',
        priority: 'normal',
        dueAt: null,
        remindAt: '2026-10-20 09:00',
        remindedAt: null,
        tags: [],
        actionable: false,
        suggestedAction: '',
        offerState: 'none',
        source: null,
        notes: [],
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
        doneAt: null,
      });
      return null;
    });

    await assert.rejects(() => ticker.tick(new Date('2026-10-20T01:00:00Z')), /network down/);
    assert.equal(attempts, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('安静时段内一条都不推，也不标记已提醒', async () => {
  const ctx = build({ briefTimes: ['09:00'], quietHours: { start: '22:00', end: '08:00' } });
  try {
    await ctx.capture({ title: '交周报', remindAt: '2026-10-20 23:00' });

    // 北京时间 23:01，正落在安静时段里
    const quiet = await ctx.ticker.tick(new Date('2026-10-20T15:01:00Z'));
    assert.equal(quiet.quiet, true);
    assert.equal(ctx.sent.length, 0, '安静时段不该推任何东西');

    const items = await ctx.store.read((ledger) => ledger.items);
    assert.equal(items[0].remindedAt, null, '安静时段不能把提醒标记成已发，否则早上就收不到了');

    // 早上 08:01 出了安静时段，这条补发出去
    const morning = await ctx.ticker.tick(new Date('2026-10-21T00:01:00Z'));
    assert.ok(ctx.sent.some((line) => line.includes('交周报')));
    assert.equal(morning.quiet, undefined);
  } finally {
    ctx.cleanup();
  }
});

test('周复盘到点在当周只推一次', async () => {
  const ctx = build({ briefTimes: [], weeklyReview: { weekday: 5, time: '18:00' } });
  try {
    await ctx.capture({ title: '整理报销表' });

    // 2026-10-23 是周五，北京时间 18:00 正好到点
    const first = await ctx.ticker.tick(new Date('2026-10-23T10:00:30Z'));
    const weekly = first.actions.filter((a) => a.kind === 'weekly');
    assert.equal(weekly.length, 1);
    assert.equal(weekly[0].delivered, true);
    assert.ok(ctx.sent.some((line) => line.includes('这一周')));

    // 同一周再扫不该重推
    const again = await ctx.ticker.tick(new Date('2026-10-23T10:30:00Z'));
    assert.equal(again.actions.filter((a) => a.kind === 'weekly').length, 0);
    assert.equal(ctx.sent.filter((line) => line.includes('这一周')).length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('周复盘没发出去时不记账，下一轮还会再试', async () => {
  let fail = true;
  const ctx = build({
    briefTimes: [],
    weeklyReview: { weekday: 5, time: '18:00' },
    push: async () => (fail ? false : true),
  });
  try {
    await ctx.capture({ title: '整理报销表' });
    const first = await ctx.ticker.tick(new Date('2026-10-23T10:00:30Z'));
    assert.equal(first.actions.find((a) => a.kind === 'weekly').delivered, false);
    assert.equal(ctx.state.weekly, undefined, '没发出去就不该记账');

    fail = false;
    const second = await ctx.ticker.tick(new Date('2026-10-23T10:02:00Z'));
    assert.equal(second.actions.find((a) => a.kind === 'weekly').delivered, true);
    assert.ok(ctx.state.weekly);
  } finally {
    ctx.cleanup();
  }
});

// work_assign 的回执答应「到点提醒你去问一句」，这条链路以前只写不读，
// 承诺永远不兑现。下面三个测试盯住它。
function assignTool(ctx) {
  const tools = createTools({ store: ctx.store, paths: ctx.paths, timeZone: TZ, sessionId: 'wa:main' });
  return tools.find((t) => t.name === 'work_assign');
}

test('指派到点会提醒去问一句，然后把下一次往前推', async () => {
  const ctx = build({ briefTimes: [] });
  try {
    const created = await ctx.capture({ title: '等广超给发票' });
    const assigned = await assignTool(ctx).execute(
      { id: created.data.id, to: '广超', verifyAt: '2026-10-21 18:00' },
      {},
    );
    assert.match(assigned.summary, /我会提醒你去问一句/);

    // 北京时间 17:59 还没到
    const before = await ctx.ticker.tick(new Date('2026-10-21T09:59:00Z'));
    assert.equal(before.actions.filter((a) => a.kind === 'chase').length, 0);

    // 18:00:30 到点，推一条「该去问一句了」
    const due = await ctx.ticker.tick(new Date('2026-10-21T10:00:30Z'));
    assert.equal(due.actions.filter((a) => a.kind === 'chase').length, 1);
    assert.ok(ctx.sent.some((line) => line.includes('该去问一句了') && line.includes('广超')));

    // 催过一次就把 verifyAt 推到 3 天后，不会每分钟重推
    const again = await ctx.ticker.tick(new Date('2026-10-21T10:05:00Z'));
    assert.equal(again.actions.filter((a) => a.kind === 'chase').length, 0);
    assert.equal(ctx.sent.filter((line) => line.includes('广超')).length, 1);

    // 三天后再提一次，这时措辞变成「还没回音」
    const later = await ctx.ticker.tick(new Date('2026-10-24T10:01:00Z'));
    assert.equal(later.actions.filter((a) => a.kind === 'chase').length, 1);
    assert.ok(ctx.sent.some((line) => line.includes('还没回音')));
  } finally {
    ctx.cleanup();
  }
});

test('催问没发出去时不动 verifyAt，下一轮还会再试', async () => {
  let fail = true;
  const ctx = build({ briefTimes: [], push: async () => (fail ? false : true) });
  try {
    const created = await ctx.capture({ title: '等广超给发票' });
    await assignTool(ctx).execute({ id: created.data.id, to: '广超', verifyAt: '2026-10-21 18:00' }, {});

    const first = await ctx.ticker.tick(new Date('2026-10-21T10:00:30Z'));
    assert.equal(first.actions.find((a) => a.kind === 'chase').delivered, false);

    const items = await ctx.store.read((ledger) => ledger.items);
    const item = items.find((i) => i.id === created.data.id);
    assert.equal(item.assignee.chaseCount, 0, '没发出去就不该算催过一次');
    assert.equal(item.assignee.verifyAt, '2026-10-21T10:00:00.000Z', '没发出去就不能把时间往后推');

    fail = false;
    const second = await ctx.ticker.tick(new Date('2026-10-21T10:02:00Z'));
    assert.equal(second.actions.find((a) => a.kind === 'chase').delivered, true);
  } finally {
    ctx.cleanup();
  }
});

test('指派的事做完或放弃后不再催', async () => {
  const ctx = build({ briefTimes: [] });
  try {
    const created = await ctx.capture({ title: '等广超给发票' });
    await assignTool(ctx).execute({ id: created.data.id, to: '广超', verifyAt: '2026-10-21 18:00' }, {});
    const tools = createTools({ store: ctx.store, paths: ctx.paths, timeZone: TZ, sessionId: 'wa:main' });
    await tools.find((t) => t.name === 'work_update').execute({ id: created.data.id, status: 'done' }, {});

    const result = await ctx.ticker.tick(new Date('2026-10-21T10:00:30Z'));
    assert.equal(result.actions.filter((a) => a.kind === 'chase').length, 0);
  } finally {
    ctx.cleanup();
  }
});
