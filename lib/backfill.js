// 把「插件开始记对话之前」的往来补进 messages 表。
//
// 为什么需要它：对话记录是后来才加的功能，之前的聊天只存在于宿主的会话日志里
// （控制面那个 wa:main 会话）。不补的话，用户第一次打开面板看到的是「还没有对话记录」，
// 明明聊了半个多月，看着就像坏了。
//
// 三条边界：
// 1. 只补一次：补完在 meta 里留个标记，之后不再动，免得每次重启都灌一遍；
// 2. 只补「人真正说过的话」：会话日志里混着运行时上下文、时间提示、技能目录这些注入文本，
//    它们的 source.kind 不是 user，按这个字段筛掉；
// 3. 读不到会话日志就下次再试，不写标记 —— 写标记等于永久放弃这次机会。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { getMeta, setMeta, tx, withDb } from './db.js';
import { defaultStateRoot } from './paths.js';

export const SEED_KEY = 'messages_seed';

// 一条消息里可能有好几个内容块（正文、思考、工具调用），只取正文。
// 思考块是模型的自言自语，不该出现在「聊天记录」里。
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function instantOf(event) {
  const time = Number(event?.time);
  if (!Number.isFinite(time) || time <= 0) return '';
  return new Date(time).toISOString();
}

// 从会话事件里挑出「微信窗口里真实出现过的那几句话」。
// 导出是为了能单独测：这段逻辑最容易出错，但它不需要数据库。
export function extractHistory(events, options = {}) {
  const chatId = typeof options.chatId === 'string' ? options.chatId : '';
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const at = instantOf(event);
    if (!at) continue;
    if (event.type === 'user/message') {
      // source.kind 是 user 才是本人打的字；runtime-context / time-context / skill-catalog
      // 这些是宿主自己塞进去的，补进对话记录会让人以为自己在说胡话
      const kind = event.data?.source?.kind;
      if (kind !== 'user') continue;
      const text = textOfBlocks(event.data?.content);
      if (!text) continue;
      rows.push({ chatId, role: 'user', text, at });
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = textOfBlocks(event.data?.message?.content);
      if (!text) continue;
      rows.push({ chatId, role: 'assistant', text, at });
    }
  }
  return rows;
}

// 表里已经有的（同一个角色 + 同一句话）不再补一遍。
// 只比文字不比时间：直接记的那条用的是「现在的时刻」，补的是日志里的时刻，
// 两个时间戳差几毫秒，按时间比对永远对不上。
// 按「出现次数」比对，不是按「有没有出现过」：日志里同一句话说了两遍（比如两次「你好」）
// 是两条真实的记录，只该抵掉库里已有的那一条，不能把第二遍也吞掉。
function existingCounts(db) {
  const counts = new Map();
  const rows = db.prepare('SELECT role, text FROM messages LIMIT 20000').all();
  for (const row of rows) {
    const key = `${row.role}\u0000${row.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---- 兜底：直接读会话日志文件 ----
//
// 首选是宿主的 sessionQuery 服务（live 会话也能读）。它不在了（宿主版本差异、
// 服务没挂）就只能读盘。日志是「多个 zstd 帧首尾相接」的一个文件，整块解压只
// 会得到第一帧（只有一个 session 头），必须自己按帧边界切。
const ZSTD_MAGIC = 0xfd2fb528;

function frameEnd(buf, start) {
  if (start + 5 > buf.length) return -1;
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) return -1;
  const fhd = buf[start + 4];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  const dictSize = [0, 1, 2, 4][dictFlag];
  let pos = start + 5;
  if (!singleSegment) pos += 1; // window descriptor
  pos += dictSize + fcsSize;
  // 逐块走，块头 3 字节：bit0 最后一块、bit1-2 类型、其余是长度
  for (;;) {
    if (pos + 3 > buf.length) return -1;
    const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    pos += 3;
    if (type === 0 || type === 2) pos += size;
    else if (type === 1) pos += 1;
    else return -1; // 保留类型，说明解析跑偏了
    if (last) break;
  }
  if (checksum) pos += 4;
  return pos <= buf.length ? pos : -1;
}

// 会话目录名是 id 里非字母数字的字符转成 ~XXXX（大写十六进制）。
// 例：wa:main -> wa~003Amain。找不到就返回 ''。
function encodeSessionDir(sessionId) {
  let out = '';
  for (const ch of String(sessionId ?? '')) {
    if (/[A-Za-z0-9_-]/.test(ch)) out += ch;
    else out += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

export function decodeSessionLog(buf) {
  const events = [];
  let start = 0;
  while (start + 5 <= buf.length) {
    if (buf.readUInt32LE(start) !== ZSTD_MAGIC) break;
    const end = frameEnd(buf, start);
    if (end < 0) break;
    let text = '';
    try {
      text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      break;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 半行，丢掉 */
      }
    }
    start = end;
  }
  return events;
}

// 从 <root>/sessions/<项目桶>/<会话目录>/session.vN.jsonl.zstd 里找这个会话的日志。
export function findSessionLog(sessionId, root) {
  const dirName = encodeSessionDir(sessionId);
  if (!dirName) return '';
  const sessionsRoot = root || join(defaultStateRoot(), 'sessions');
  let buckets = [];
  try {
    buckets = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name));
  } catch {
    return '';
  }
  for (const bucket of buckets) {
    const dir = join(bucket, dirName);
    let files = [];
    try {
      files = readdirSync(dir).filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(dir, file);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* 忽略 */
      }
    }
  }
  return '';
}

function readHistoryFromDisk(sessionId, root, log) {
  const file = findSessionLog(sessionId, root);
  if (!file) return null;
  try {
    const events = decodeSessionLog(readFileSync(file));
    log?.(`backfill: 从会话日志文件读了 ${events.length} 个事件（${file}）`);
    return events;
  } catch (err) {
    log?.(`backfill: 会话日志文件读失败 ${err?.message ?? err}`);
    return null;
  }
}

export async function backfillMessages(paths, options = {}) {
  const log = options.log;
  const query = options.sessionQuery;
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  if (!sessionId) return { seeded: false, reason: 'no-session-id', inserted: 0 };

  const done = await withDb(paths, { log }, (db) => getMeta(db, SEED_KEY));
  if (done) return { seeded: false, reason: 'already', inserted: 0 };

  let events = null;
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId);
      events = Array.isArray(snapshot?.events) ? snapshot.events : null;
    } catch (err) {
      // 会话还不存在、或者日志读坏了。先试盘上的日志，还不行就下次启动再试。
      log?.(`backfill: sessionQuery 读不到（${err?.message ?? err}），改读日志文件`);
    }
  }
  if (!events) events = readHistoryFromDisk(sessionId, options.sessionsRoot, log);
  if (!events) {
    // 读不到就什么都不写：这次算了，下次启动再试，不能把「没读到」当成「补过了」
    return { seeded: false, reason: 'read-failed', inserted: 0 };
  }

  const rows = extractHistory(events, { chatId: options.chatId ?? '' });
  const result = await withDb(paths, { log }, (db) =>
    tx(db, () => {
      const known = existingCounts(db);
      const stmt = db.prepare('INSERT INTO messages (chat_id, role, text, at) VALUES (?, ?, ?, ?)');
      let inserted = 0;
      for (const row of rows) {
        const key = `${row.role}\u0000${row.text}`;
        const left = known.get(key) ?? 0;
        if (left > 0) {
          // 库里已经有这一条了（直接记过的那条），抵掉一个，不重复插
          known.set(key, left - 1);
          continue;
        }
        stmt.run(row.chatId, row.role, row.text.slice(0, 4000), row.at);
        inserted += 1;
      }
      setMeta(db, SEED_KEY, { at: new Date().toISOString(), inserted, scanned: rows.length });
      return inserted;
    }),
  );

  if (result > 0) log?.(`backfill: 补了 ${result} 条历史对话`);
  else log?.('backfill: 会话日志里没有可补的对话');
  return { seeded: true, reason: 'ok', inserted: result };
}
