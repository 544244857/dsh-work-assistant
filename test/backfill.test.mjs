// 历史对话回填：把插件开始记对话之前的往来从会话日志里捞出来补进去。
// 这块最怕两件事——把注入的上下文当成人说的话、以及重复补一遍。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { dataPaths } from '../lib/paths.js';
import {
  backfillMessages,
  decodeSessionLog,
  extractHistory,
  findSessionLog,
  SEED_KEY,
} from '../lib/backfill.js';
import { getMeta, withDb } from '../lib/db.js';
import { countMessages, listConversations } from '../lib/conversations.js';
import { recordMessage } from '../lib/analyzer.js';

const TZ = 'Asia/Shanghai';

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-backfill-'));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 SQLite 关掉后偶尔还占着文件，删不掉不影响断言 */
    }
  };
  // 兜底那条路会去读盘。测试里必须指一个空目录，否则会去读开发机真实的
  // ~/.dsh/sessions，把真人的聊天记录灌进临时库、断言全乱。
  const sessionsRoot = join(dir, 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  return { paths: dataPaths(dir), sessionsRoot, cleanup };
}

function userEvent(seq, time, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id: `wa-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind, rpcId: kind === 'user' ? `wa-${seq}` : undefined },
    },
  };
}

function assistantEvent(seq, time, blocks) {
  return { type: 'assistant/message', seq, time, data: { message: { role: 'assistant', content: blocks } } };
}

// 2026-10-21 09:00 北京时间
const T0 = Date.UTC(2026, 9, 21, 1, 0, 0);

test('extractHistory 只挑真人说的话和助手的正文', () => {
  const events = [
    userEvent(1, T0, '你好'),
    userEvent(2, T0 + 1000, '现在是下午三点', 'time-context'),
    userEvent(3, T0 + 2000, '你可以用这些工具', 'skill-catalog'),
    assistantEvent(4, T0 + 3000, [
      { type: 'reasoning', text: '让我想想' },
      { type: 'text', text: '在的，今天有三件事' },
    ]),
    assistantEvent(5, T0 + 4000, [{ type: 'reasoning', text: '纯思考，没有正文' }]),
    { type: 'turn/start', seq: 6, time: T0 + 5000, data: { turn: 1 } },
    { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '没有时间戳' }] } } },
  ];
  const rows = extractHistory(events, { chatId: 'boss' });
  assert.deepEqual(rows.map((row) => [row.role, row.text]), [
    ['user', '你好'],
    ['assistant', '在的，今天有三件事'],
  ]);
  // 时间戳是毫秒 → ISO，回填之后按天分组要靠它
  assert.equal(rows[0].at, new Date(T0).toISOString());
  assert.equal(rows[0].chatId, 'boss');
});

test('extractHistory 对空输入不炸', () => {
  assert.deepEqual(extractHistory(undefined), []);
  assert.deepEqual(extractHistory(null), []);
  assert.deepEqual(extractHistory([]), []);
  assert.deepEqual(extractHistory([null, 42, 'x']), []);
  // 一条正文都没有的消息不留空行
  assert.deepEqual(extractHistory([assistantEvent(1, T0, [{ type: 'reasoning', text: '只思考' }])]), []);
});

test('回填之后面板能按天看到那几段对话', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    const events = [
      userEvent(1, T0, '安排值班表'),
      assistantEvent(2, T0 + 1000, [{ type: 'text', text: '记下了' }]),
      userEvent(3, T0 + 86400000, '催办广超发票'),
    ];
    const result = await backfillMessages(paths, {
      sessionQuery: { readSession: async () => ({ events }) },
      sessionsRoot,
      sessionId: 'wa:main',
      chatId: 'boss',
    });
    assert.equal(result.seeded, true);
    assert.equal(result.inserted, 3);
    assert.equal(await countMessages(paths), 3);

    const data = await listConversations(paths, { timeZone: TZ });
    assert.equal(data.total, 2);
    assert.equal(data.threads[0].day, '2026-10-22');
    assert.equal(data.threads[1].day, '2026-10-21');
    assert.equal(data.threads[1].count, 2);
  } finally {
    cleanup();
  }
});

test('只补一次：第二次进来直接跳过', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    let reads = 0;
    const sessionQuery = {
      readSession: async () => {
        reads += 1;
        return { events: [userEvent(1, T0, '你好')] };
      },
    };
    const first = await backfillMessages(paths, { sessionQuery, sessionsRoot, sessionId: 'wa:main', chatId: 'boss' });
    assert.equal(first.inserted, 1);
    const second = await backfillMessages(paths, { sessionQuery, sessionsRoot, sessionId: 'wa:main', chatId: 'boss' });
    assert.equal(second.reason, 'already');
    assert.equal(second.inserted, 0);
    // 已经补过了就不该再去读会话日志
    assert.equal(reads, 1);
    assert.equal(await countMessages(paths), 1);
  } finally {
    cleanup();
  }
});

test('读会话日志失败时不写标记，下次还能再试', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    const broken = { readSession: async () => { throw new Error('session not found'); } };
    const first = await backfillMessages(paths, { sessionQuery: broken, sessionsRoot, sessionId: 'wa:main' });
    assert.equal(first.reason, 'read-failed');
    assert.equal(first.inserted, 0);
    const marker = await withDb(paths, {}, (db) => getMeta(db, SEED_KEY));
    assert.equal(marker, null);

    // 下一次日志能读了就该补上
    const good = { readSession: async () => ({ events: [userEvent(1, T0, '你好')] }) };
    const second = await backfillMessages(paths, { sessionQuery: good, sessionsRoot, sessionId: 'wa:main', chatId: 'boss' });
    assert.equal(second.inserted, 1);
  } finally {
    cleanup();
  }
});

test('宿主没给 sessionQuery、盘上也没有日志时安静跳过，不写标记', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    const result = await backfillMessages(paths, { sessionId: 'wa:main', sessionsRoot });
    assert.equal(result.reason, 'read-failed');
    assert.equal(await countMessages(paths), 0);
    assert.equal(await withDb(paths, {}, (db) => getMeta(db, SEED_KEY)), null);
  } finally {
    cleanup();
  }
});

// sessionQuery 在宿主版本差异下可能没有。这条兜底路自己按帧解日志，
// 一旦解错，补进去的就是半句话或者一堆乱码。
function zstdLog(events) {
  return Buffer.concat(
    events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))),
  );
}

test('多帧 zstd 日志能完整解开（整块解只能拿到第一帧）', () => {
  const events = [userEvent(1, T0, '你好'), assistantEvent(2, T0 + 1000, [{ type: 'text', text: '在' }])];
  const buf = zstdLog(events);
  // 先确认这条测试真的覆盖到了「多帧」：两帧才有两个魔数
  assert.equal(buf.readUInt32LE(0), 0xfd2fb528);
  const decoded = decodeSessionLog(buf);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].data.content[0].text, '你好');
  // 整块解压确实只能拿到第一帧，这就是为什么必须自己切帧
  const naive = zlib.zstdDecompressSync(buf).toString('utf8').trim().split('\n').filter(Boolean);
  assert.equal(naive.length, 1);
});

test('没有 sessionQuery 也能从盘上把老对话补进来', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    // 目录名规则：wa:main -> wa~003Amain
    const bucket = join(sessionsRoot, '--C-Users-gs1-');
    const dir = join(bucket, 'wa~003Amain');
    mkdirSync(dir, { recursive: true });
    const events = [userEvent(1, T0, '安排值班表'), assistantEvent(2, T0 + 1000, [{ type: 'text', text: '记下了' }])];
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdLog(events));
    assert.equal(findSessionLog('wa:main', sessionsRoot), join(dir, 'session.v4.jsonl.zstd'));

    const result = await backfillMessages(paths, { sessionsRoot, sessionId: 'wa:main', chatId: 'boss' });
    assert.equal(result.reason, 'ok');
    assert.equal(result.inserted, 2);
    const data = await listConversations(paths, { timeZone: TZ });
    assert.equal(data.threads[0].count, 2);
  } finally {
    cleanup();
  }
});

test('会话 id 里没有可对应的目录时不炸', () => {
  assert.equal(typeof findSessionLog('wa:main', join(tmpdir(), 'wa-not-here-xyz')), 'string');
  assert.equal(findSessionLog('wa:main', join(tmpdir(), 'wa-not-here-xyz')), '');
});

test('表里已有的同一句话不再补一遍', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    // 新消息是直接记的，时间戳跟日志里的差几毫秒，所以只按「角色 + 文字」判重
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '你好', at: new Date(T0 + 7).toISOString() });
    const result = await backfillMessages(paths, {
      sessionQuery: { readSession: async () => ({ events: [userEvent(1, T0, '你好')] }) },
      sessionsRoot,
      sessionId: 'wa:main',
      chatId: 'boss',
    });
    assert.equal(result.inserted, 0);
    assert.equal(await countMessages(paths), 1);
  } finally {
    cleanup();
  }
});

test('日志里同一句话说两遍时要都留下，只抵掉库里已有的那一条', async () => {
  const { paths, sessionsRoot, cleanup } = tempPaths();
  try {
    // 升级后先直接记了一条「你好」，日志里又有两条「你好」。
    // 早先按「有没有出现过」判重，会把日志里第二遍也吞掉，看起来就像丢了一句。
    await recordMessage(paths, { chatId: 'boss', role: 'user', text: '你好', at: new Date(T0).toISOString() });
    const result = await backfillMessages(paths, {
      sessionQuery: {
        readSession: async () => ({
          events: [userEvent(1, T0, '你好'), userEvent(2, T0 + 1000, '你好')],
        }),
      },
      sessionsRoot,
      sessionId: 'wa:main',
      chatId: 'boss',
    });
    assert.equal(result.inserted, 1);
    assert.equal(await countMessages(paths), 2);
  } finally {
    cleanup();
  }
});
