// 账本的持久化：数据只在 SQLite 里，进程内不留长期快照。
//
// 早先的版本在内存里缓存整份账本，写的时候整表 DELETE 再 INSERT。两个宿主进程
// （桌面端 + web 端会共用同一个 ~/.dsh）各存一份，后写的会把先写的一整批覆盖掉。
// 现在每次写都开事务、事务里重新读一遍最新数据、改完再写，并且用 BEGIN IMMEDIATE
// 先拿写锁，「读旧快照覆盖别人」这条路直接堵死。
//
// 对外接口没变：load / mutate / read / invalidate。
import { getMeta, openDb, parseJson, replaceRows, setMeta, toBool, withDb } from './db.js';

const ITEM_COLUMNS = [
  'id',
  'position',
  'title',
  'detail',
  'status',
  'priority',
  'priority_auto',
  'due_at',
  'remind_at',
  'reminded_at',
  'tags',
  'actionable',
  'suggested_action',
  'offer_state',
  'recurrence',
  'assignee',
  'attachments',
  'assignment_id',
  'source',
  'notes',
  'series_id',
  'series_index',
  'created_at',
  'updated_at',
  'done_at',
];

function itemToRow(item, index) {
  return {
    id: typeof item?.id === 'string' ? item.id : '',
    position: index,
    title: typeof item.title === 'string' ? item.title : '',
    detail: typeof item.detail === 'string' ? item.detail : '',
    status: item.status ?? 'open',
    priority: item.priority ?? 'normal',
    priority_auto: item.priorityAuto ? 1 : 0,
    due_at: item.dueAt ?? null,
    remind_at: item.remindAt ?? null,
    reminded_at: item.remindedAt ?? null,
    tags: JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
    actionable: item.actionable ? 1 : 0,
    suggested_action: typeof item.suggestedAction === 'string' ? item.suggestedAction : '',
    offer_state: item.offerState ?? 'none',
    recurrence: item.recurrence ? JSON.stringify(item.recurrence) : null,
    assignee: item.assignee ? JSON.stringify(item.assignee) : null,
    attachments: JSON.stringify(Array.isArray(item.attachments) ? item.attachments : []),
    assignment_id: item.assignmentId ?? null,
    source: item.source ? JSON.stringify(item.source) : null,
    notes: JSON.stringify(Array.isArray(item.notes) ? item.notes : []),
    series_id: item.seriesId ?? null,
    // 显式判 null：Number(null) 是 0，会把「没有序号」读成第 0 期
    series_index:
      item.seriesIndex === null || item.seriesIndex === undefined || !Number.isFinite(Number(item.seriesIndex))
        ? null
        : Number(item.seriesIndex),
    created_at: item.createdAt ?? new Date().toISOString(),
    updated_at: item.updatedAt ?? item.createdAt ?? new Date().toISOString(),
    done_at: item.doneAt ?? null,
  };
}

// 从库里读回来的行做一次轻校验：没有 id 或标题的行直接丢掉。
// 宁可少一条，也不要让脏行把整个列表渲染炸掉。
function rowToItem(row) {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!id || !title) return null;
  return {
    id,
    title,
    detail: typeof row.detail === 'string' ? row.detail : '',
    status: row.status ?? 'open',
    priority: row.priority ?? 'normal',
    dueAt: row.due_at ?? null,
    remindAt: row.remind_at ?? null,
    remindedAt: row.reminded_at ?? null,
    tags: parseJson(row.tags, []),
    actionable: toBool(row.actionable),
    suggestedAction: typeof row.suggested_action === 'string' ? row.suggested_action : '',
    offerState: row.offer_state ?? 'none',
    priorityAuto: toBool(row.priority_auto),
    recurrence: parseJson(row.recurrence, null),
    assignee: parseJson(row.assignee, null),
    attachments: parseJson(row.attachments, []),
    assignmentId: row.assignment_id ?? null,
    source: parseJson(row.source, null),
    notes: parseJson(row.notes, []),
    seriesId: row.series_id ?? null,
    seriesIndex:
      row.series_index === null || row.series_index === undefined || !Number.isFinite(Number(row.series_index))
        ? null
        : Number(row.series_index),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? row.created_at ?? '',
    doneAt: row.done_at ?? null,
  };
}

// 从连接里读一份完整账本。mutate 在事务里也用它，保证读到的是最新已提交数据。
function readLedger(db) {
  const rows = db.prepare('SELECT * FROM items ORDER BY position').all();
  const items = [];
  for (const row of rows) {
    const item = rowToItem(row);
    if (item) items.push(item);
  }
  const seq = {};
  for (const row of db.prepare('SELECT day, n FROM item_seq').all()) {
    seq[row.day] = Number(row.n) || 0;
  }
  return { version: 1, items, seq };
}

function writeLedger(db, data) {
  replaceRows(db, 'items', data.items.map(itemToRow), ITEM_COLUMNS);
  replaceRows(
    db,
    'item_seq',
    Object.entries(data.seq ?? {}).map(([day, n]) => ({ day, n: Number(n) || 0 })),
    ['day', 'n'],
  );
}

export function createStore(paths, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  let queue = Promise.resolve();

  async function load() {
    return withDb(paths, { log }, readLedger);
  }

  function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // 事务里重新读 → 改 → 写。fn 可以是 async；事务期间持有写锁，
  // 别的进程要写会等 busy_timeout，而不是拿着旧数据把它覆盖掉。
  function mutate(fn) {
    return enqueue(() =>
      withDb(paths, { log }, async (db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = readLedger(db);
          const result = await fn(current);
          writeLedger(db, current);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 回滚失败时保留原始错误
          }
          log(`ledger: 改动没写进库（${err?.message ?? err}）`);
          throw err;
        }
      }),
    );
  }

  function read(fn) {
    return enqueue(() => withDb(paths, { log }, (db) => fn(readLedger(db))));
  }

  // 兼容旧接口：现在没有内存缓存了，无需失效
  function invalidate() {}

  return { load, mutate, read, invalidate };
}

// 迁移用：把老的 ledger.json 灌进库。用 meta 里的标记判断「迁过没有」，
// 不看行数 —— 否则迁移失败一次、用户又新记了一条，老数据就永远不进库了。
// 按 id 去重合并，老文件里已有 id 的行不重复插入。
export async function seedLedger(paths, data, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const db = openDb(paths, { log });
  try {
    if (getMeta(db, 'legacy_ledger_v1')) return { seeded: false, items: 0, done: true };
    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const rows = [];
    let skipped = 0;
    rawItems.forEach((item, index) => {
      const row = itemToRow(item ?? {}, index);
      if (!row.id || !row.title) {
        skipped += 1;
        return;
      }
      rows.push(row);
    });
    if (skipped) log(`migrate: 账本里有 ${skipped} 条没有 id 或标题，跳过`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = new Set(db.prepare('SELECT id FROM items').all().map((row) => row.id));
      const missing = rows.filter((row) => !existing.has(row.id));
      if (missing.length) {
        const placeholders = ITEM_COLUMNS.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO items (${ITEM_COLUMNS.join(', ')}) VALUES (${placeholders})`);
        for (const row of missing) stmt.run(...ITEM_COLUMNS.map((name) => row[name] ?? null));
      }
      const seq = data?.seq ?? {};
      for (const [day, n] of Object.entries(seq)) {
        db.prepare('INSERT INTO item_seq (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = MAX(n, excluded.n)').run(
          day,
          Number(n) || 0,
        );
      }
      setMeta(db, 'legacy_ledger_v1', { at: new Date().toISOString(), items: missing.length });
      db.exec('COMMIT');
      return { seeded: true, items: missing.length };
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
