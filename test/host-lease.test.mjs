// 宿主租约：同一个数据目录只让一个宿主干活。
// 这一组测试盯的是「两个宿主同时开着」时到底谁会发消息，所以都用独立的临时库。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHostLease, liveHosts } from '../lib/host-lease.js';

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-lease-'));
  return {
    paths: { dir, db: join(dir, 'work-assistant.db') },
    // Windows 上 SQLite 的文件有时还没完全放开，删不掉不算测试失败
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

const T0 = new Date('2026-10-23T10:00:00.000Z');

test('先启动的宿主是主，后来的待命，且能看到对方', async () => {
  const { paths, cleanup } = tempPaths();
  const a = createHostLease(paths, { id: 'a', role: 'desktop', now: () => T0 });
  const b = createHostLease(paths, {
    id: 'b',
    role: 'web',
    now: () => new Date(T0.getTime() + 1000),
  });
  try {
    const first = await a.start();
    const second = await b.start();
    assert.equal(first.primary, true);
    assert.equal(second.primary, false);
    assert.deepEqual(second.hosts.map((row) => row.id), ['a', 'b']);
    assert.equal(second.hosts[1].role, 'web');
    // 待命的那个不是「没数据」，只是不该动
    assert.equal(b.isPrimary(), false);
    assert.equal(a.isPrimary(), true);
  } finally {
    await a.stop();
    await b.stop();
    cleanup();
  }
});

test('主退出后，待命的下一次心跳就接手，不用等过期', async () => {
  const { paths, cleanup } = tempPaths();
  const a = createHostLease(paths, { id: 'a', now: () => T0 });
  const b = createHostLease(paths, { id: 'b', now: () => new Date(T0.getTime() + 1000) });
  try {
    await a.start();
    await b.start();
    assert.equal(b.isPrimary(), false);
    await a.stop();
    const next = await b.refresh();
    assert.equal(next.primary, true);
    assert.deepEqual(next.hosts.map((row) => row.id), ['b']);
  } finally {
    await a.stop();
    await b.stop();
    cleanup();
  }
});

test('心跳过期的宿主算已经没了，不会永久占着主控', async () => {
  const { paths, cleanup } = tempPaths();
  const ttlMs = 90_000;
  const a = createHostLease(paths, { id: 'a', now: () => T0, ttlMs });
  const later = new Date(T0.getTime() + 3 * 60 * 1000);
  const b = createHostLease(paths, { id: 'b', now: () => later, ttlMs });
  try {
    await a.start();
    // a 那边崩了，心跳停在 T0；三分钟后 b 启动并清掉这行
    const incoming = await b.start();
    assert.equal(incoming.primary, true);
    assert.deepEqual(incoming.hosts.map((row) => row.id), ['b']);
  } finally {
    await a.stop();
    await b.stop();
    cleanup();
  }
});

test('liveHosts 只列心跳还活着的，最老的排最前', async () => {
  const { paths, cleanup } = tempPaths();
  const ttlMs = 90_000;
  const a = createHostLease(paths, { id: 'a', now: () => T0, ttlMs });
  const later = new Date(T0.getTime() + 30 * 1000);
  const b = createHostLease(paths, { id: 'b', now: () => later, ttlMs });
  try {
    await a.start();
    await b.start();
    const alive = await liveHosts(paths, { nowMs: later.getTime(), ttlMs });
    assert.deepEqual(alive.map((row) => row.id), ['a', 'b']);
  } finally {
    await a.stop();
    await b.stop();
    cleanup();
  }
});

// 租约本身对不够：入口必须真的用它拦住轮询、定时器、知识库分析，
// 不然两个宿主照样各跑各的，还是两遍提醒。
test('入口把租约接进了轮询、定时器和分析', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('lease = createHostLease(paths'), '启动时要创建租约');
  assert.ok(source.includes('const leaseState = await lease.start()'), '要等租约给出主/待命');
  assert.ok(source.includes("log('poll: 本实例在待命，不轮询')"), '待命时不轮询');
  assert.ok(source.includes("log('ticker: 本实例在待命，不跑定时提醒')"), '待命时不跑定时器');
  assert.ok(source.includes("state.status = 'standby'"), '待命状态要落盘，面板才说得清');
  assert.ok(source.includes('void lease.stop()'), '退出时要交还主控权');
});

test('面板会说清楚「另一个宿主在跑」', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("overview?.status?.role === 'standby'"), '面板要读租约角色');
  assert.ok(client.includes("h('div', { className: 'wa-msg warn' }, t('standbyHint'))"), '待命要有提示条');
  assert.ok((client.match(/standbyHint:/g) ?? []).length >= 2, '中英两份文案都要有');
});
