import { withDb } from './db.js';
import { dayKey } from './time.js';

// 微信里的往来记录。入站消息在 index.js 收到时落库，助手的回复在推出去之后补记一条，
// 目的是让面板上能按天回看「那天都聊了什么」，而不是只有工作项这一层摘要。
//
// 为什么不复用 session 里的事件：会话是模型的工作记录，里面混着工具调用、思考、
// 重试的中间态，人看着累；这里存的是「微信窗口里真实出现过的那几句话」。

const MAX_SCAN = 5000;
const DEFAULT_THREADS = 20;
const DEFAULT_MESSAGES = 300;

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.floor(value) : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function textOf(row) {
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  return text;
}

// 一行标题：太长的正文压成一句，列表里不至于把卡片撑爆
export function previewOf(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

// 列出最近的对话：按「哪一天 + 哪个微信联系人」分组，新的在前。
export async function listConversations(paths, options = {}) {
  const timeZone = options.timeZone ?? '';
  const limit = clampInt(options.limit, 1, 200, DEFAULT_THREADS);
  return withDb(paths, { log: options.log }, (db) => {
    const rows = db
      .prepare('SELECT id, chat_id, role, text, at FROM messages ORDER BY id DESC LIMIT ?')
      .all(MAX_SCAN);
    const groups = new Map();
    for (const row of rows) {
      const text = textOf(row);
      if (!text) continue;
      const at = typeof row.at === 'string' ? row.at : '';
      let day = '';
      try {
        day = at ? dayKey(at, timeZone) : '';
      } catch {
        day = at.slice(0, 10);
      }
      const chatId = typeof row.chat_id === 'string' ? row.chat_id : '';
      const key = `${day}\u0000${chatId}`;
      const found = groups.get(key);
      if (found) {
        found.count += 1;
        found.oldestId = row.id;
        continue;
      }
      groups.set(key, {
        day,
        chatId,
        count: 1,
        lastAt: at,
        oldestId: row.id,
        preview: previewOf(text),
        lastRole: row.role === 'assistant' ? 'assistant' : 'user',
      });
    }
    const threads = [...groups.values()]
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.oldestId - a.oldestId))
      .slice(0, limit)
      .map((row) => ({
        day: row.day,
        chatId: row.chatId,
        count: row.count,
        lastAt: row.lastAt,
        preview: row.preview,
        lastRole: row.lastRole,
      }));
    return { total: groups.size, threads };
  });
}

// 读某一天跟某个人之间的全部往来（老的在前，方便从上下文往下读）
export async function readConversation(paths, input = {}, options = {}) {
  const timeZone = options.timeZone ?? input.timeZone ?? '';
  const day = typeof input.day === 'string' ? input.day.trim() : '';
  const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  const limit = clampInt(input.limit, 1, 1000, DEFAULT_MESSAGES);
  if (!day) throw new Error('day 不能为空，写法像 2026-10-22');
  return withDb(paths, { log: options.log ?? input.log }, (db) => {
    const rows = chatId
      ? db
          .prepare('SELECT id, chat_id, role, text, at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
          .all(chatId, MAX_SCAN)
      : db.prepare('SELECT id, chat_id, role, text, at FROM messages ORDER BY id DESC LIMIT ?').all(MAX_SCAN);
    const messages = [];
    for (const row of rows) {
      const text = textOf(row);
      if (!text) continue;
      const at = typeof row.at === 'string' ? row.at : '';
      let rowDay = '';
      try {
        rowDay = at ? dayKey(at, timeZone) : '';
      } catch {
        rowDay = at.slice(0, 10);
      }
      if (rowDay !== day) continue;
      messages.push({ role: row.role === 'assistant' ? 'assistant' : 'user', text, at });
      if (messages.length >= limit) break;
    }
    messages.reverse();
    return { day, chatId, total: messages.length, messages };
  });
}

// 面板上想知道「一共有多少条」，省得再去解析一遍
export async function countMessages(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    return Number(row?.n ?? 0);
  });
}
