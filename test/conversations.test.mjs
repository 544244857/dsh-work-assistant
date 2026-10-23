// 对话记录：微信里说过的话按天归堆，能回看。
// 这块的数据来源只有 messages 表，所以测试直接用 recordMessage 往里写。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../lib/paths.js';
import { recordMessage } from '../lib/analyzer.js';
import { countMessages, listConversations, previewOf, readConversation } from '../lib/conversations.js';

const TZ = 'Asia/Shanghai';

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-conv-'));
  // Windows 上 SQLite 关掉后偶尔还会短暂占着文件，删不掉不影响断言，别让它把测试带红
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录残留无所谓 */
    }
  };
  return { paths: dataPaths(dir), cleanup };
}

test('previewOf 把换行压平，太长就截断', () => {
  assert.equal(previewOf('  你好\n世界  '), '你好 世界');
  const long = '一'.repeat(80);
  const cut = previewOf(long, 10);
  assert.equal(cut.length, 11);
  assert.ok(cut.endsWith('…'));
  assert.equal(previewOf(''), '');
  assert.equal(previewOf(null), '');
});

test('按「天 + 联系人」分组，新的在前，count 是这一组的总条数', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    // 北京时间 10-21 上午与晚上、10-22 上午
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '明天把报表发我', at: '2026-10-21T01:00:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'assistant', text: '记下了，明天上午发', at: '2026-10-21T01:01:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '记得带公章', at: '2026-10-21T12:00:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '今天还有一件事', at: '2026-10-22T01:00:00.000Z' });

    const data = await listConversations(paths, { timeZone: TZ });
    assert.equal(data.total, 2);
    assert.equal(data.threads.length, 2);
    // 新的那组在前
    assert.equal(data.threads[0].day, '2026-10-22');
    assert.equal(data.threads[0].count, 1);
    assert.equal(data.threads[0].chatId, 'boss');
    assert.equal(data.threads[1].day, '2026-10-21');
    assert.equal(data.threads[1].count, 3);
    // 预览取的是这组里最新那句
    assert.equal(data.threads[1].preview, '记得带公章');
    assert.equal(data.threads[1].lastRole, 'user');
  } finally {
    cleanup();
  }
});

test('两个人分在同一天时是两组，不会混成一锅', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'a', role: 'user', text: '甲说的话', at: '2026-10-21T02:00:00.000Z' });
    await recordMessage(paths, { chatId: 'b', role: 'user', text: '乙说的话', at: '2026-10-21T02:30:00.000Z' });
    const data = await listConversations(paths, { timeZone: TZ });
    assert.equal(data.total, 2);
    assert.deepEqual(data.threads.map((row) => row.chatId).sort(), ['a', 'b']);
  } finally {
    cleanup();
  }
});

test('limit 只影响返回条数，不影响 total', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    for (let day = 20; day <= 24; day += 1) {
      await recordMessage(paths, {
        chatId: 'boss',
        role: 'user',
        text: `第 ${day} 天`,
        at: `2026-10-${day}T02:00:00.000Z`,
      });
    }
    const data = await listConversations(paths, { timeZone: TZ, limit: 2 });
    assert.equal(data.threads.length, 2);
    assert.equal(data.total, 5);
  } finally {
    cleanup();
  }
});

test('readConversation 只给这一天的，老的在前', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '早上好', at: '2026-10-21T00:30:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'assistant', text: '早上好，今天有三件事', at: '2026-10-21T00:31:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '第二天的话', at: '2026-10-22T00:30:00.000Z' });

    const data = await readConversation(paths, { day: '2026-10-21', chatId: 'boss' }, { timeZone: TZ });
    assert.equal(data.total, 2);
    assert.deepEqual(data.messages.map((row) => row.text), ['早上好', '早上好，今天有三件事']);
    assert.equal(data.messages[1].role, 'assistant');

    // 只按天不按人也要能读
    const loose = await readConversation(paths, { day: '2026-10-22' }, { timeZone: TZ });
    assert.equal(loose.total, 1);
  } finally {
    cleanup();
  }
});

test('readConversation 没有 day 就报错，不会悄悄返回全部', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await assert.rejects(() => readConversation(paths, {}), /day/);
    await assert.rejects(() => readConversation(paths, { day: '   ' }), /day/);
  } finally {
    cleanup();
  }
});

test('countMessages 数的是全部往来', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.equal(await countMessages(paths), 0);
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '一', at: '2026-10-21T02:00:00.000Z' });
    await recordMessage(paths, { chatId: 'boss', role: 'assistant', text: '二', at: '2026-10-21T02:01:00.000Z' });
    assert.equal(await countMessages(paths), 2);
  } finally {
    cleanup();
  }
});
