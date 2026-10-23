// 知识库：文档正文 + 索引都放在 SQLite 里（kb_docs / kb_seq 两张表）。
//
// 老版本是一篇文档一个 .md 文件 + index.json；现在正文进库，
// 好处是搜索、统计、实体抽取都能直接用 SQL，不用每次把整个目录读一遍。
import { getMeta, openDb, parseJson, replaceRows, setMeta, tx, withDb } from './db.js';
import { dayKey } from './time.js';

export function emptyIndex() {
  return { version: 1, docs: {}, seq: {} };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const text = tag.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function rowToDoc(row) {
  return {
    id: row.id,
    title: row.title,
    tags: parseJson(row.tags, []),
    content: row.content,
    source: row.source ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadIndex(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) => {
    const docs = {};
    for (const row of db.prepare('SELECT * FROM kb_docs ORDER BY position').all()) {
      docs[row.id] = {
        title: row.title,
        tags: parseJson(row.tags, []),
        source: row.source ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        bytes: Buffer.byteLength(String(row.content ?? ''), 'utf8'),
      };
    }
    const seq = {};
    for (const row of db.prepare('SELECT day, n FROM kb_seq').all()) {
      seq[row.day] = Number(row.n) || 0;
    }
    return { version: 1, docs, seq };
  });
}

export async function writeDoc(paths, input, now = new Date(), timeZone, log) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('title 不能为空');
  const content = typeof input.content === 'string' ? input.content : '';
  if (!content.trim()) throw new Error('content 不能为空');

  const stamp = new Date(now).toISOString();
  const tags = normalizeTags(input.tags);

  return withDb(paths, { log }, (db) =>
    tx(db, () => {
      const key = dayKey(now, timeZone).replace(/-/g, '');
      const current = Number(db.prepare('SELECT n FROM kb_seq WHERE day = ?').get(key)?.n ?? 0);
      const n = current + 1;
      db.prepare('INSERT INTO kb_seq (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = excluded.n').run(key, n);
      const id = `k-${key}-${String(n).padStart(3, '0')}`;
      const position = Number(db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM kb_docs').get()?.p ?? 0);
      db.prepare(
        'INSERT INTO kb_docs (id, position, title, tags, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, position, title, JSON.stringify(tags), content.trim(), input.source ?? '', stamp, stamp);
      return { id, title, tags, bytes: Buffer.byteLength(content.trim(), 'utf8'), createdAt: stamp, updatedAt: stamp };
    }),
  );
}

function snippetAround(text, at, needleLength) {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needleLength + 40);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

export async function search(paths, query, options = {}) {
  const { tags, limit } = options;
  const needle = typeof query === 'string' ? query.trim() : '';
  const tagFilter = normalizeTags(tags);
  // 中文两字词用 LIKE 才准（FTS5 的 unicode61/trigram 分词对两字中文匹配不上），
  // 数据量是几百篇的量级，全表扫一遍完全够快。
  const rows = await withDb(paths, { log: options.log }, (db) =>
    db.prepare('SELECT * FROM kb_docs ORDER BY position').all(),
  );

  const lowerNeedle = needle.toLowerCase();
  const hits = [];
  for (const row of rows) {
    const entry = rowToDoc(row);
    if (tagFilter.length && !tagFilter.every((t) => entry.tags.includes(t))) continue;

    let score = 0;
    if (lowerNeedle && entry.title.toLowerCase().includes(lowerNeedle)) score += 3;
    for (const tag of entry.tags) {
      if (lowerNeedle && tag.toLowerCase().includes(lowerNeedle)) score += 2;
    }

    let snippet = '';
    if (lowerNeedle) {
      const haystack = entry.content.toLowerCase();
      let at = haystack.indexOf(lowerNeedle);
      let occurrences = 0;
      while (at >= 0 && occurrences < 20) {
        occurrences += 1;
        at = haystack.indexOf(lowerNeedle, at + lowerNeedle.length);
      }
      if (occurrences > 0) {
        score += occurrences;
        snippet = snippetAround(entry.content, haystack.indexOf(lowerNeedle), needle.length);
      }
    }

    // 有查询词时只收命中的；没查询词时按标签/时间全列
    if (lowerNeedle && score === 0 && !tagFilter.length) continue;
    hits.push({ id: entry.id, title: entry.title, tags: entry.tags, updatedAt: entry.updatedAt, score, snippet });
  }

  hits.sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : -1));
  const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 10;
  return hits.slice(0, cap);
}

export async function readDoc(paths, id, log) {
  const row = await withDb(paths, { log }, (db) => db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(String(id)));
  if (!row) return null;
  const doc = rowToDoc(row);
  return {
    id: doc.id,
    title: doc.title,
    tags: doc.tags,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    content: doc.content.trim(),
  };
}

export async function listDocs(paths, options = {}) {
  const cap = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 20;
  const rows = await withDb(paths, { log: options.log }, (db) =>
    db.prepare('SELECT * FROM kb_docs ORDER BY updated_at DESC, position DESC').all(),
  );
  const docs = rows.map((row) => {
    const doc = rowToDoc(row);
    return { id: doc.id, title: doc.title, tags: doc.tags, updatedAt: doc.updatedAt };
  });
  return { total: docs.length, docs: docs.slice(0, cap) };
}

// 给知识库分析用：带正文、有上限，避免一次把整库塞进提示词
export async function allDocs(paths, options = {}) {
  const cap = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 50;
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0 ? Math.floor(options.maxChars) : 4000;
  const rows = await withDb(paths, { log: options.log }, (db) =>
    db.prepare('SELECT * FROM kb_docs ORDER BY updated_at DESC, position DESC LIMIT ?').all(cap),
  );
  return rows.map((row) => {
    const doc = rowToDoc(row);
    return {
      id: doc.id,
      title: doc.title,
      tags: doc.tags,
      content: String(doc.content ?? '').slice(0, maxChars),
      updatedAt: doc.updatedAt,
    };
  });
}

// 迁移用：把老的 index.json + .md 正文一次性灌进库
export async function seedKb(paths, index, readFileText, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const db = openDb(paths, { log });
  try {
    if (getMeta(db, 'legacy_kb_v1')) return { seeded: false, docs: 0, done: true };
    const entries = Object.entries(index?.docs ?? {});
    if (!entries.length) return { seeded: false, docs: 0 };
    let inserted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      let position = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM kb_docs').get()?.n ?? -1) + 1;
      for (const [id, entry] of entries) {
        const existing = db.prepare('SELECT id FROM kb_docs WHERE id = ?').get(id);
        if (existing) continue;
        // 正文读不到就抛：宁可整次迁移失败、索引留着下次再来，
        // 也不要把空正文写进库然后假装搬成功了。
        let raw;
        try {
          raw = readFileText(entry.file);
        } catch (err) {
          throw new Error(`知识库正文读不出来：${entry.file ?? id}（${err?.message ?? err}）`);
        }
        if (typeof raw !== 'string') throw new Error(`知识库正文读不出来：${entry.file ?? id}`);
        db.prepare(
          'INSERT INTO kb_docs (id, position, title, tags, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          position++,
          String(entry.title ?? ''),
          JSON.stringify(normalizeTags(entry.tags)),
          raw,
          '',
          entry.createdAt ?? '',
          entry.updatedAt ?? '',
        );
        inserted += 1;
      }
      for (const [day, n] of Object.entries(index?.seq ?? {})) {
        db.prepare('INSERT INTO kb_seq (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = MAX(n, excluded.n)').run(
          day,
          Number(n) || 0,
        );
      }
      setMeta(db, 'legacy_kb_v1', { at: new Date().toISOString(), docs: inserted });
      db.exec('COMMIT');
      return { seeded: true, docs: inserted };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 保留原始错误
      }
      throw err;
    }
  } finally {
    try {
      db.close();
    } catch {
      // 已经关掉了
    }
  }
}
