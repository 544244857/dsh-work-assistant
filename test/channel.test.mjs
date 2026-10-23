import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { InboundChannel } from '../lib/channel.js';

const TZ = 'Asia/Shanghai';

// 手动时钟：把 setTimeout 换成可控队列，避免测试真的等待
function manualClock() {
  let seq = 0;
  const tasks = new Map();
  return {
    schedule(fn) {
      seq += 1;
      tasks.set(seq, fn);
      return seq;
    },
    cancel(id) {
      tasks.delete(id);
    },
    tick() {
      const pending = [...tasks.entries()];
      tasks.clear();
      for (const [, fn] of pending) fn();
      return pending.length;
    },
    size() {
      return tasks.size;
    },
  };
}

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-channel-'));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('owner 未设置时接受任何人，设置后只认本人', () => {
  const open = new InboundChannel({ mergeWindowMs: 0 });
  assert.equal(open.isOwner('u1'), true);

  const strict = new InboundChannel({ ownerUserId: 'u1' });
  assert.equal(strict.isOwner('u1'), true);
  assert.equal(strict.isOwner('u2'), false);
});

test('陌生人的消息被丢弃且不进缓冲', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ ownerUserId: 'u1', mergeWindowMs: 1500, ...clock });

  const result = channel.accept({ fromUserId: 'u2', messageId: 'm1', text: '帮我转账' });
  assert.deepEqual(result, { status: 'ignored', reason: 'not_owner' });
  assert.equal(clock.size(), 0);
  assert.equal(channel.takeBuffer().text, '');
});

test('重复 messageId 只收一次', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 1500, ...clock });

  assert.equal(channel.accept({ fromUserId: 'u1', messageId: 'm1', text: '第一句' }).status, 'accepted');
  assert.deepEqual(channel.accept({ fromUserId: 'u1', messageId: 'm1', text: '第一句' }), {
    status: 'ignored',
    reason: 'duplicate',
  });
  assert.equal(channel.buffer.length, 1);
});

test('没有 messageId 的消息不去重（也不能因此丢掉）', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 1500, ...clock });
  assert.equal(channel.accept({ fromUserId: 'u1', text: 'a' }).status, 'accepted');
  assert.equal(channel.accept({ fromUserId: 'u1', text: 'b' }).status, 'accepted');
});

test('seen 列表超过上限时丢弃最旧的', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 1500, ...clock });
  for (let i = 0; i < 260; i += 1) {
    channel.accept({ fromUserId: 'u1', messageId: `m${i}`, text: `t${i}` });
  }
  assert.equal(channel.seen.length, 200);
  assert.equal(channel.seen[0], 'm60');
});

test('合并窗口内多条消息合成一次批处理', async () => {
  const clock = manualClock();
  const batches = [];
  const channel = new InboundChannel({
    mergeWindowMs: 1500,
    ...clock,
    onBatch: async (batch) => {
      batches.push(batch);
    },
  });

  channel.accept({ fromUserId: 'u1', messageId: 'm1', text: '张三让我', contextToken: 'ctx-1' });
  channel.accept({ fromUserId: 'u1', messageId: 'm2', text: '周五前把报销表整理好' });

  assert.equal(batches.length, 0, '窗口没到不应该触发');
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batches.length, 1);
  assert.equal(batches[0].text, '张三让我\n周五前把报销表整理好');
  assert.equal(batches[0].chatId, 'u1');
  assert.equal(batches[0].contextToken, 'ctx-1');
  assert.deepEqual(batches[0].messageIds, ['m1', 'm2']);
});

test('新消息重置计时窗口（不会在半句话时就触发）', async () => {
  const clock = manualClock();
  const batches = [];
  const channel = new InboundChannel({
    mergeWindowMs: 1500,
    ...clock,
    onBatch: async (batch) => {
      batches.push(batch);
    },
  });

  channel.accept({ fromUserId: 'u1', messageId: 'm1', text: '前半句' });
  assert.equal(clock.size(), 1);
  channel.accept({ fromUserId: 'u1', messageId: 'm2', text: '后半句' });
  assert.equal(clock.size(), 1, '旧定时器应被取消，只剩一个');

  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].text, '前半句\n后半句');
});

test('只收到非文本消息时给出提示文案', async () => {
  const clock = manualClock();
  const batches = [];
  const channel = new InboundChannel({
    mergeWindowMs: 0,
    ...clock,
    onBatch: async (batch) => {
      batches.push(batch);
    },
  });

  channel.accept({ fromUserId: 'u1', messageId: 'm1', text: '', unsupported: 1 });
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batches.length, 1);
  assert.match(batches[0].text, /非文本消息/);
});

test('onBatch 抛错不炸整个通道，后续消息还能进来', async () => {
  const clock = manualClock();
  const errors = [];
  let calls = 0;
  const channel = new InboundChannel({
    mergeWindowMs: 0,
    ...clock,
    log: (line) => errors.push(line),
    onBatch: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });

  channel.accept({ fromUserId: 'u1', messageId: 'm1', text: 'a' });
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.ok(errors.some((line) => line.includes('boom')));

  channel.accept({ fromUserId: 'u1', messageId: 'm2', text: 'b' });
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('reset 清空缓冲与去重表', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 1500, ...clock });
  channel.accept({ fromUserId: 'u1', messageId: 'm1', text: 'a', contextToken: 'ctx' });
  assert.equal(channel.buffer.length, 1);

  channel.reset();
  assert.equal(channel.buffer.length, 0);
  assert.equal(channel.seen.length, 0);
  assert.equal(channel.contextToken, '');
  assert.equal(clock.size(), 0);
});

test('空消息对象被忽略', () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 0, ownerUserId: 'u1', ...clock });
  assert.deepEqual(channel.accept(null), { status: 'ignored', reason: 'empty' });
  assert.deepEqual(channel.accept({}), { status: 'ignored', reason: 'empty' });
  assert.deepEqual(channel.accept({ text: '没有发送者' }), { status: 'ignored', reason: 'empty' });
  assert.deepEqual(channel.accept({ fromUserId: 'x', text: '陌生人' }), { status: 'ignored', reason: 'not_owner' });
});

test('flush 在没有缓冲内容时返回 null', async () => {
  const clock = manualClock();
  const channel = new InboundChannel({ mergeWindowMs: 0, ...clock });
  assert.equal(await channel.flush(), null);
});
