// 老 JSON 数据搬进 SQLite 的迁移测试：搬得进来、不留脏数据、库里已有数据时不覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataPaths } from '../lib/paths.js';
import { createStore, seedLedger } from '../lib/store.js';
import { createAssignmentStore, seedAssignments } from '../lib/assignments.js';
import { loadIndex, readDoc, seedKb } from '../lib/kb.js';

const TZ = 'Asia/Shanghai';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-migrate-'));
  return { dir, paths: dataPaths(dir) };
}

test('老账本搬进数据库，搬完能正常读写', async () => {
  const { dir, paths } = scratch();
  try {
    const data = {
      version: 1,
      items: [
        { id: 'w-20261020-001', title: '安排值班表', status: 'open', priority: 'high', tags: ['值班'] },
        { id: 'w-20261020-002', title: '催发票', status: 'done' },
      ],
      seq: { 20261020: 2 },
    };
    const result = await seedLedger(paths, data, { log: () => {} });
    assert.equal(result.seeded, true);
    assert.equal(result.items, 2);

    const store = createStore(paths, { log: () => {} });
    const ledger = await store.load();
    assert.deepEqual(ledger.items.map((item) => item.title), ['安排值班表', '催发票']);
    assert.equal(ledger.items[0].priority, 'high');
    assert.deepEqual(ledger.seq, { 20261020: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('库里已经有工作项时迁移不覆盖', async () => {
  const { dir, paths } = scratch();
  try {
    await seedLedger(paths, { items: [{ id: 'w-1', title: '先来的' }], seq: {} }, { log: () => {} });
    const second = await seedLedger(paths, { items: [{ id: 'w-2', title: '后来的' }], seq: {} }, { log: () => {} });
    assert.equal(second.seeded, false);
    const store = createStore(paths, { log: () => {} });
    const ledger = await store.load();
    assert.deepEqual(ledger.items.map((item) => item.title), ['先来的']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老副手登记搬进数据库', async () => {
  const { dir, paths } = scratch();
  try {
    const data = {
      version: 1,
      items: [{ id: 'a-20261022-001', sessionId: 'wa:asg:a-20261022-001', purpose: '整理报销', status: 'stopped' }],
      seq: { 20261022: 1 },
    };
    const result = await seedAssignments(paths, data, { log: () => {} });
    assert.equal(result.seeded, true);
    const book = createAssignmentStore(paths, { log: () => {}, limit: 3 });
    const loaded = await book.load();
    assert.equal(loaded.items[0].purpose, '整理报销');
    assert.equal(loaded.items[0].status, 'stopped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老知识库把 md 正文一起搬进来', async () => {
  const { dir, paths } = scratch();
  try {
    mkdirSync(paths.kbDir, { recursive: true });
    const file = join(paths.kbDir, 'k-20261020-001.md');
    writeFileSync(file, '值班共 5 人轮转：舒子淇、彭喻、肖航、余鹏、曹曼', 'utf8');
    const index = {
      version: 1,
      docs: {
        'k-20261020-001': { title: '值班表排法', tags: ['值班'], file: 'k-20261020-001.md', createdAt: '2026-10-20T11:52:46.983Z', updatedAt: '2026-10-20T11:52:46.983Z' },
      },
      seq: { 20261020: 1 },
    };
    const result = await seedKb(paths, index, (name) => (name === 'k-20261020-001.md' ? '值班共 5 人轮转：舒子淇、彭喻、肖航、余鹏、曹曼' : ''), { log: () => {} });
    assert.equal(result.seeded, true);
    assert.equal(result.docs, 1);

    const loaded = await loadIndex(paths, { log: () => {} });
    assert.equal(loaded.docs['k-20261020-001'].title, '值班表排法');
    const doc = await readDoc(paths, 'k-20261020-001', () => {});
    assert.match(doc.content, /舒子淇/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('库是半升级状态、版本号却已经是新的：补表不靠版本号', async () => {
  const { dir, paths } = scratch();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(paths.db);
    raw.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT) STRICT');
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const { openDb } = await import('../lib/db.js');
    const db = openDb(paths, { log: () => {} });
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      assert.ok(names.includes('entities'));
      assert.ok(names.includes('items'));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('知识库正文读不出来时整次迁移失败，修好之后还能接着迁', async () => {
  const { dir, paths } = scratch();
  try {
    mkdirSync(paths.kbDir, { recursive: true });
    const index = {
      version: 1,
      docs: {
        'k-20261020-001': { title: '值班表排法', tags: ['值班'], file: 'k-20261020-001.md', createdAt: '', updatedAt: '' },
      },
      seq: { 20261020: 1 },
    };
    // 正文缺失：不许用空串冒充成功，否则这篇笔记从此在库里是空壳
    await assert.rejects(
      () =>
        seedKb(paths, index, () => {
          throw new Error('ENOENT: k-20261020-001.md');
        }, { log: () => {} }),
      /正文读不出来/,
    );
    const before = await loadIndex(paths, { log: () => {} });
    assert.equal(Object.keys(before.docs).length, 0);

    const retried = await seedKb(paths, index, () => '值班：舒子淇、彭喻', { log: () => {} });
    assert.equal(retried.seeded, true);
    const doc = await readDoc(paths, 'k-20261020-001', () => {});
    assert.match(doc.content, /舒子淇/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移标记记下来之后不会重复搬，也不会把后来的数据冲掉', async () => {
  const { dir, paths } = scratch();
  try {
    await seedLedger(paths, { items: [{ id: 'w-1', title: '老数据' }], seq: {} }, { log: () => {} });
    const store = createStore(paths, { log: () => {} });
    await store.mutate((ledger) => {
      ledger.items.push({ id: 'w-2', title: '新记的', status: 'open', priority: 'normal', tags: [], notes: [] });
      return null;
    });
    const again = await seedLedger(paths, { items: [{ id: 'w-1', title: '老数据' }], seq: {} }, { log: () => {} });
    assert.equal(again.seeded, false);
    const ledger = await store.load();
    assert.deepEqual(ledger.items.map((item) => item.title).sort(), ['新记的', '老数据'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('两个 store 实例各写一条，谁也盖不掉谁', async () => {
  const { dir, paths } = scratch();
  try {
    const a = createStore(paths, { log: () => {} });
    const b = createStore(paths, { log: () => {} });
    await a.load();
    await b.load(); // 两边都先把「空账本」读进过内存
    await a.mutate((ledger) => {
      ledger.items.push({ id: 'w-a', title: 'A 加的', status: 'open', priority: 'normal', tags: [], notes: [] });
      return null;
    });
    await b.mutate((ledger) => {
      ledger.items.push({ id: 'w-b', title: 'B 加的', status: 'open', priority: 'normal', tags: [], notes: [] });
      return null;
    });
    const ledger = await a.load();
    assert.deepEqual(ledger.items.map((item) => item.title).sort(), ['A 加的', 'B 加的'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
