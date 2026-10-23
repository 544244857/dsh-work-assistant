// 存储层：所有数据放在一个 SQLite 库里。
//
// 为什么用 node:sqlite 而不是 better-sqlite3：插件是零运行时依赖（只有 qrcode），
// 装原生模块要跟着 Node ABI 编译，宿主升级就得重装。node:sqlite 是 Node 22+ 自带的，
// 宿主已经用它（@deepseek-ai/dsh-session-query-sqlite 里就是 await import('node:sqlite')），
// 所以这里直接用，不新增依赖。
//
// 每次操作开一次连接、用完关掉：单机插件的数据量很小（几百行），开一次是毫秒级；
// 好处是 Windows 上不会因为长期持有句柄导致删目录/换文件失败，也没有连接泄漏。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// 表结构版本。改结构就 +1，并在 migrate() 里补一段升级。
export const SCHEMA_VERSION = 2;

const SCHEMA = `
-- 迁移标记之类的小事实，跟业务数据分开存
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  priority_auto INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  remind_at TEXT,
  reminded_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  actionable INTEGER NOT NULL DEFAULT 0,
  suggested_action TEXT NOT NULL DEFAULT '',
  offer_state TEXT NOT NULL DEFAULT 'none',
  recurrence TEXT,
  assignee TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  assignment_id TEXT,
  source TEXT,
  notes TEXT NOT NULL DEFAULT '[]',
  series_id TEXT,
  series_index INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS items_status ON items (status, due_at);
CREATE INDEX IF NOT EXISTS items_updated ON items (updated_at);

CREATE TABLE IF NOT EXISTS item_seq (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  session_id TEXT,
  item_id TEXT,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  cwd TEXT,
  model TEXT,
  preset TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_run_at TEXT,
  report TEXT,
  reports TEXT NOT NULL DEFAULT '[]',
  stop_reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS assignments_status ON assignments (status);

CREATE TABLE IF NOT EXISTS assignment_seq (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS kb_updated ON kb_docs (updated_at);

CREATE TABLE IF NOT EXISTS kb_seq (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) STRICT;

-- 收到/发出的消息原文，是知识库分析的原料。analyzed_at 为空表示还没被分析过。
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  analyzed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS messages_pending ON messages (analyzed_at, id);

-- 知识库的人物（以后可以是项目、地点，kind 留着扩展）
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'person',
  aliases TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  mentions INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT,
  last_seen TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS entities_kind ON entities (kind, name);

-- 人和人之间的关系。from/to 都指向 entities.id，(from,to,type) 唯一，重复分析只更新不新增。
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (from_id, to_id, type)
) STRICT;
CREATE INDEX IF NOT EXISTS relations_from ON relations (from_id);

-- 每次自动分析留一行，方便回看「它到底分析了什么、花了多少」
CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT,
  model TEXT,
  messages INTEGER NOT NULL DEFAULT 0,
  entities INTEGER NOT NULL DEFAULT 0,
  relations INTEGER NOT NULL DEFAULT 0,
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS messages_pending ON messages (analyzed_at, id);
CREATE INDEX IF NOT EXISTS analysis_runs_started ON analysis_runs (started_at);
CREATE INDEX IF NOT EXISTS analysis_runs_status ON analysis_runs (status, started_at);
`;

// 真的坏了（SQLITE_CORRUPT / NOTADB）才把原文件改名留档，再起一个新的。
// 锁竞争（SQLITE_BUSY / LOCKED）绝不能走这里 —— 那是「现在忙」，不是「文件坏了」，
// 把正常库改名等于凭空丢数据。主机上两个宿主进程共用同一个库是常态。
function isCorrupt(err) {
  const code = Number(err?.errcode ?? 0);
  const text = String(err?.message ?? err ?? '');
  if (code === 11 || code === 26) return true; // SQLITE_CORRUPT / SQLITE_NOTADB
  return /malformed|not a database|file is encrypted/i.test(text);
}

function openFresh(dbPath, err, log) {
  const stamp = `${Date.now()}`;
  const backup = `${dbPath}.corrupt-${stamp}`;
  const moved = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbPath}${suffix}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${backup}${suffix}`);
      moved.push(suffix || 'main');
    } catch (renameError) {
      log(`db: 坏库改名失败（${renameError?.message ?? renameError}）`);
    }
  }
  log(
    `db: 数据库文件坏了（${err?.message ?? err}），原文件另存为 ${backup}` +
      `（搬走 ${moved.join(',') || '无'}），本次以空库启动`,
  );
  return new DatabaseSync(dbPath);
}

// 打开一次连接。busy_timeout 必须最先设：后面任何一条 PRAGMA 碰到别人正在写，
// 没有超时就会立刻抛 SQLITE_BUSY，被误当成坏库。
function connect(dbPath, log) {
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    if (!isCorrupt(err)) throw err;
    db = openFresh(dbPath, err, log);
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    // 只有还不是 WAL 时才切。切 journal_mode 需要短暂的排他锁，每次开库都切
    // 会在并发时白撞锁；已经是 WAL 的库直接跳过。
    try {
      const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (String(mode ?? '').toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL');
    } catch (err) {
      if (!/busy|locked/i.test(String(err?.message ?? err))) throw err;
      log('db: 切换 WAL 时库正忙，先用现有模式');
    }
    db.exec('PRAGMA synchronous = NORMAL');
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // 关不掉就交给下面重新打开
    }
    if (!isCorrupt(err)) throw err;
    db = openFresh(dbPath, err, log);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}

export function openDb(paths, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const dbPath = paths.db;
  if (!dbPath) throw new Error('没有数据库路径，检查 lib/paths.js 的 dataPaths');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = connect(dbPath, log);
  try {
    migrate(db, log);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // 关不掉就算了
    }
    if (!isCorrupt(err)) throw err;
    const fresh = openFresh(dbPath, err, log);
    fresh.exec('PRAGMA busy_timeout = 5000');
    migrate(fresh, log);
    return fresh;
  }
}

function migrate(db, log) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  const hasItems =
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()?.n ?? 0,
    ) > 0;

  // 版本对得上、表也在，就什么都不做：读操作不该每次都跑建表脚本拿写锁。
  if (current === SCHEMA_VERSION && hasItems) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    if (current !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时下面的 throw 会带上原始原因
    }
    throw err;
  }
  if (current > 0 && current < SCHEMA_VERSION) log(`db: 表结构从 v${current} 升到 v${SCHEMA_VERSION}`);
}

// 打开→做事→关掉。所有读写都走这个，省得每处都写 try/finally。
export async function withDb(paths, options, fn) {
  const db = openDb(paths, options);
  try {
    return await fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // 已经关掉了就算了
    }
  }
}

// 事务包一层。fn 里抛错就整体回滚，不会留下写了一半的数据。
export function tx(db, fn) {
  // IMMEDIATE 一上来就拿写锁：两个进程同时写时，第二个会等而不是先读后写、
  // 到 COMMIT 才发现冲突（那种情况下 SQLite 会直接抛 SQLITE_BUSY，容易误判成故障）。
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误
    }
    throw err;
  }
}

// 把一堆行一次性写进表里：先清空再插入。数据量小，图的就是简单和一致。
export function replaceRows(db, table, rows, columns) {
  db.prepare(`DELETE FROM ${table}`).run();
  if (!rows.length) return;
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
  for (const row of rows) stmt.run(...columns.map((name) => row[name] ?? null));
}

// 状态文件（原来是 state.json）：现在是 state 表里的 key/value，值是 JSON 文本。
export async function readState(paths, options = {}) {
  return withDb(paths, options, (db) => {
    const rows = db.prepare('SELECT key, value FROM state').all();
    const data = {};
    for (const row of rows) {
      try {
        data[row.key] = JSON.parse(row.value);
      } catch {
        data[row.key] = row.value;
      }
    }
    return data;
  });
}

export async function writeState(paths, state, options = {}) {
  return withDb(paths, options, (db) =>
    tx(db, () => {
      db.prepare('DELETE FROM state').run();
      const stmt = db.prepare('INSERT INTO state (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(state ?? {})) {
        stmt.run(key, JSON.stringify(value ?? null));
      }
    }),
  );
}

// 迁移标记这类小事实：存在 meta 表里，跟业务数据分开
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value ?? null),
  );
}

export function parseJson(text, fallback) {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function toBool(value) {
  return value === true || value === 1 || value === '1';
}
