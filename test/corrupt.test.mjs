import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addItem } from '../lib/ledger.js';
import { dataPaths } from '../lib/paths.js';
import { createStore } from '../lib/store.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-20T01:00:00.000Z');

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dwa-corrupt-'));
  return { dir, paths: dataPaths(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// 手改坏一个字节就整份打不开，等于用户的工作项无声消失
test('数据库坏掉时先把原文件另存留档，并写日志', async () => {
  const { dir, paths, cleanup } = tempDir();
  try {
    const seed = createStore(paths, { log: () => {} });
    await seed.mutate((ledger) => {
      for (const title of ['一', '二', '三']) addItem(ledger, { title }, NOW, TZ);
      return null;
    });

    // 把库文件头部砸烂：真坏库（断电、磁盘满）就是这个下场
    const good = readFileSync(paths.db);
    assert.ok(good.length > 0, '先确认库文件有内容');
    writeFileSync(paths.db, Buffer.concat([Buffer.from('not a sqlite db at all'), good.subarray(0, 32)]));

    const logs = [];
    const store = createStore(paths, { log: (m) => logs.push(m) });
    const titles = await store.read((ledger) => ledger.items.map((i) => i.title));

    const saved = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.equal(saved.length, 1, '坏库应被改名留档');
    assert.ok(readFileSync(join(dir, saved[0])).length > 0, '留档要保住原内容');
    assert.ok(logs.some((m) => m.includes('另存为')), '必须留下提示，不能静默');
    assert.deepEqual(titles, []);
  } finally {
    cleanup();
  }
});

test('库文件不存在时按空账本启动，不留 corrupt 档', async () => {
  const { dir, paths, cleanup } = tempDir();
  try {
    const store = createStore(paths, { log: () => {} });
    const titles = await store.read((ledger) => ledger.items.map((i) => i.title));
    assert.deepEqual(titles, []);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.corrupt-')), []);
  } finally {
    cleanup();
  }
});
