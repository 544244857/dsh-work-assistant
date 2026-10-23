import { getMeta, openDb, parseJson, replaceRows, setMeta, withDb } from './db.js';
import { dayKey } from './time.js';

// 副手 = 一条独立的工作线，跑在自己的会话里。
// 这里只管登记簿（谁在干什么、交了什么报告），不碰 agent、不碰网络。

export const ASSIGN_STATUSES = ['idle', 'running', 'waiting', 'done', 'stopped', 'offline'];
// idle 建好了还没开工，running 正在干，waiting 交了报告在等回话
export const ACTIVE_STATUSES = ['idle', 'running', 'waiting'];
export const ASSIGN_LIMIT_DEFAULT = 3;
export const ASSIGN_LIMIT_MIN = 1;
export const ASSIGN_LIMIT_MAX = 32;
const MAX_REPORTS = 20;

const STATUS_LABEL = {
  idle: '空闲',
  running: '干活中',
  waiting: '等你回话',
  done: '已交活',
  stopped: '已停',
  offline: '失联',
};

export function emptyAssignments() {
  return { version: 1, items: [], seq: {} };
}

export function assignStatusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ASSIGN_LIMIT_DEFAULT;
  return Math.min(ASSIGN_LIMIT_MAX, Math.max(ASSIGN_LIMIT_MIN, Math.floor(n)));
}

function nextId(book, now, timeZone) {
  const key = dayKey(now, timeZone).replace(/-/g, '');
  const seq = book.seq ?? (book.seq = {});
  const n = (Number(seq[key]) || 0) + 1;
  seq[key] = n;
  return `a-${key}-${String(n).padStart(3, '0')}`;
}

function normalizeReport(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!summary) return null;
  return {
    summary,
    detail: typeof value.detail === 'string' ? value.detail.trim() : '',
    expectsReply: value.expectsReply === true,
    at: typeof value.at === 'string' && value.at ? value.at : null,
  };
}

// 从磁盘读回来的记录可能有缺字段（手改、老版本），补齐但不猜内容
function normalizeAssignment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim() : '';
  if (!id || !purpose) return null;
  const reports = Array.isArray(raw.reports) ? raw.reports.map(normalizeReport).filter(Boolean).slice(-MAX_REPORTS) : [];
  return {
    id,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    itemId: typeof raw.itemId === 'string' && raw.itemId ? raw.itemId : null,
    purpose,
    status: ASSIGN_STATUSES.includes(raw.status) ? raw.status : 'idle',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    preset: typeof raw.preset === 'string' && raw.preset ? raw.preset : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
    report: normalizeReport(raw.report),
    reports,
    stopReason: typeof raw.stopReason === 'string' && raw.stopReason ? raw.stopReason : null,
  };
}

export function getAssignment(book, id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) return null;
  return book.items.find((item) => item.id === key) ?? null;
}

export function activeAssignments(book) {
  return book.items.filter((item) => ACTIVE_STATUSES.includes(item.status));
}

// 只查不算：把 id 切到 nextStatus 会不会多占一个名额，会就抛 limitError。
// 「先把话送到再记账」的路径（给副手发消息）必须提前问一句，
// 否则消息已经投出去了才发现名额满，状态留在 done，名额就永久漏算。
export function assertSlot(book, id, nextStatus, limit) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  if (assignment.status === 'stopped') return;
  if (!ACTIVE_STATUSES.includes(nextStatus)) return;
  if (ACTIVE_STATUSES.includes(assignment.status)) return;
  const others = activeAssignments(book).filter((item) => item.id !== assignment.id);
  if (others.length >= clampLimit(limit)) throw limitError(clampLimit(limit), others);
}

// 把一个副手切到新状态。凡是「已收尾 → 活跃」这种迁移都在这里数一遍名额：
// 从 done / offline 回到 idle 等于凭空多占一个位置，三个入口（用户补话、
// 外部事件唤醒、又交一份等回话的报告）都得走同一条路，各写一遍必然漏。
export function promote(book, id, nextStatus, options = {}) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  // 停掉是终态，谁都不许把它拉回来
  if (assignment.status === 'stopped') return assignment;
  assertSlot(book, id, nextStatus, options.limit);
  assignment.status = nextStatus;
  return assignment;
}

// 超上限时给一个带 code 的错，让工具层能原样转述给用户
export function limitError(limit, active) {
  const names = active.map((item) => `${item.id}（${item.purpose}）`).join('、');
  const err = new Error(`副手已经开满了（上限 ${limit} 个）。想再派活，先把不用的停掉：${names}`);
  err.code = 'ASSIGN_LIMIT_REACHED';
  err.limit = limit;
  err.active = active.length;
  return err;
}

export function createAssignment(book, input = {}, now = new Date(), options = {}) {
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
  if (!purpose) throw new Error('purpose 不能为空，一句话说清这条线在干什么');

  const limit = clampLimit(options.limit);
  const active = activeAssignments(book);
  if (active.length >= limit) throw limitError(limit, active);

  const stamp = new Date(now).toISOString();
  const assignment = {
    id: nextId(book, now, options.timeZone),
    sessionId: null,
    itemId: typeof input.itemId === 'string' && input.itemId.trim() ? input.itemId.trim() : null,
    purpose,
    status: 'idle',
    cwd: typeof input.cwd === 'string' ? input.cwd.trim() : '',
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
    preset: typeof input.preset === 'string' && input.preset.trim() ? input.preset.trim() : '',
    createdAt: stamp,
    updatedAt: stamp,
    lastRunAt: null,
    report: null,
    reports: [],
    stopReason: null,
  };
  book.items.unshift(assignment);
  return assignment;
}

export function attachSession(book, id, sessionId, now = new Date()) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  assignment.sessionId = typeof sessionId === 'string' && sessionId ? sessionId : assignment.sessionId;
  assignment.updatedAt = new Date(now).toISOString();
  return assignment;
}

export function updateAssignment(book, id, patch = {}, now = new Date()) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  if (patch.status !== undefined) {
    if (!ASSIGN_STATUSES.includes(patch.status)) throw new Error(`副手状态只能是 ${ASSIGN_STATUSES.join(' / ')}`);
    assignment.status = patch.status;
  }
  if (patch.purpose !== undefined && typeof patch.purpose === 'string' && patch.purpose.trim()) {
    assignment.purpose = patch.purpose.trim();
  }
  if (patch.lastRunAt !== undefined) assignment.lastRunAt = patch.lastRunAt;
  if (patch.stopReason !== undefined) assignment.stopReason = patch.stopReason;
  assignment.updatedAt = new Date(now).toISOString();
  return assignment;
}

export function recordReport(book, id, report = {}, now = new Date(), options = {}) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  const summary = typeof report.summary === 'string' ? report.summary.trim() : '';
  if (!summary) throw new Error('summary 不能为空，一两句话说说干成什么样了');

  const entry = {
    summary,
    detail: typeof report.detail === 'string' ? report.detail.trim() : '',
    expectsReply: report.expectsReply === true,
    at: new Date(now).toISOString(),
  };
  // 报告内容先落，再试状态迁移。
  // 反过来（先迁移再落）会有一个很难看的后果：名额满时 promote 抛错，
  // store 整笔回滚，副手刚说的话（可能是关键的一个问题）就这么没了，
  // 用户只看到「名额已满」，还以为副手什么也没说。
  assignment.report = entry;
  assignment.reports = [...(assignment.reports ?? []), entry].slice(-MAX_REPORTS);
  // 停掉是终态：用户叫停之后，agent 可能还有一份迟到的报告在路上。
  // 报告本身留档（方便回头看它干到哪了），但状态不许从 stopped 复活成 done/waiting，
  // 否则名额和面板都会以为这条线还在跑。
  // 走 promote：waiting 是活跃态，从 done 交一份「等回话」的报告
  // 会重新占一个名额，这里的复查不能省。
  if (assignment.status !== 'stopped') {
    try {
      promote(book, id, entry.expectsReply ? 'waiting' : 'done', options);
    } catch (err) {
      // 名额满了：报告留着，状态不动。调用方会把这件事如实说出来，
      // 让人知道「话收到了，但它没回到活跃状态」。
      if (err?.code !== 'ASSIGN_LIMIT_REACHED') throw err;
    }
  }
  assignment.updatedAt = entry.at;
  return assignment;
}

export function stopAssignment(book, id, reason = '', now = new Date()) {
  const assignment = getAssignment(book, id);
  if (!assignment) throw new Error(`找不到副手 ${id}`);
  assignment.status = 'stopped';
  assignment.stopReason = typeof reason === 'string' && reason.trim() ? reason.trim() : '手动停掉';
  assignment.updatedAt = new Date(now).toISOString();
  return assignment;
}

export function listAssignments(book, filter = {}, now = new Date()) {
  const status = filter.status;
  let items = book.items;
  if (status === 'active') items = activeAssignments(book);
  else if (typeof status === 'string' && ASSIGN_STATUSES.includes(status)) {
    items = book.items.filter((item) => item.status === status);
  }
  const cap = Number(filter.limit) > 0 ? Math.floor(Number(filter.limit)) : 50;
  return { items: items.slice(0, cap), total: items.length };
}

function oneLine(assignment) {
  const bits = [`${assignment.id} [${assignStatusLabel(assignment.status)}] ${assignment.purpose}`];
  if (assignment.itemId) bits.push(`对应 ${assignment.itemId}`);
  if (assignment.report) bits.push(`最新报告：${assignment.report.summary}`);
  return bits.join('｜');
}

export function renderAssignmentList(result, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : 1200;
  const items = result?.items ?? [];
  const total = Number(result?.total ?? items.length);
  if (!items.length) return '现在没有副手。要派人干活的时候会自动开一个。';

  const lines = [`共 ${total} 个副手，列出 ${items.length} 个：`];
  items.forEach((assignment, index) => {
    lines.push(`${index + 1}. ${oneLine(assignment)}`);
  });
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 12)}……（后面还有）`;
  return text;
}

export function renderAssignmentDetail(assignment, options = {}) {
  if (!assignment) return '没有这个副手。';
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : 1200;
  const lines = [
    `${assignment.id}（${assignStatusLabel(assignment.status)}）`,
    `在干什么：${assignment.purpose}`,
    assignment.itemId ? `对应工作项：${assignment.itemId}` : '',
    assignment.sessionId ? `会话：${assignment.sessionId}` : '会话：还没建起来',
    assignment.lastRunAt ? `最后一次活动：${assignment.lastRunAt}` : '',
  ].filter(Boolean);

  if (assignment.report) {
    lines.push('', `最新报告：${assignment.report.summary}`);
    if (assignment.report.detail) lines.push(`细节：${assignment.report.detail}`);
    if (assignment.report.expectsReply) lines.push('它在等你回话。');
  }
  if (assignment.stopReason) lines.push(`停止原因：${assignment.stopReason}`);

  const tail = Array.isArray(options.tail) ? options.tail : [];
  if (tail.length) {
    lines.push('', '最近几步：');
    for (const line of tail) lines.push(`- ${line}`);
  }

  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 12)}……（后面还有）`;
  return text;
}

// 和账本一样：一条 promise 链串行落盘，异常回滚内存快照。
// 落盘从 assignments.json 换成了库里的 assignments / assignment_seq 两张表。
const ASSIGN_COLUMNS = [
  'id',
  'position',
  'session_id',
  'item_id',
  'purpose',
  'status',
  'cwd',
  'model',
  'preset',
  'created_at',
  'updated_at',
  'last_run_at',
  'report',
  'reports',
  'stop_reason',
];

function assignmentToRow(assignment, index) {
  return {
    id: assignment.id,
    position: index,
    session_id: assignment.sessionId ?? null,
    item_id: assignment.itemId ?? null,
    purpose: assignment.purpose ?? '',
    status: assignment.status ?? 'idle',
    cwd: assignment.cwd ?? null,
    model: assignment.model ?? null,
    preset: assignment.preset ?? null,
    created_at: assignment.createdAt ?? null,
    updated_at: assignment.updatedAt ?? null,
    last_run_at: assignment.lastRunAt ?? null,
    report: assignment.report ? JSON.stringify(assignment.report) : null,
    reports: JSON.stringify(Array.isArray(assignment.reports) ? assignment.reports : []),
    stop_reason: assignment.stopReason ?? null,
  };
}

function rowToAssignment(row) {
  return normalizeAssignment({
    id: row.id,
    sessionId: row.session_id,
    itemId: row.item_id,
    purpose: row.purpose,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    preset: row.preset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    report: parseJson(row.report, null),
    reports: parseJson(row.reports, []),
    stopReason: row.stop_reason,
  });
}

export function createAssignmentStore(paths, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const limit = clampLimit(options.limit);
  let queue = Promise.resolve();

  // 每次都从库里读最新数据，不在进程里留一份会过期的快照。
  function readBook(db) {
    const items = [];
    for (const row of db.prepare('SELECT * FROM assignments ORDER BY position').all()) {
      const assignment = rowToAssignment(row);
      if (assignment) items.push(assignment);
    }
    const seq = {};
    for (const row of db.prepare('SELECT day, n FROM assignment_seq').all()) {
      seq[row.day] = Number(row.n) || 0;
    }
    return { version: 1, items, seq };
  }

  function writeBook(db, data) {
    replaceRows(db, 'assignments', data.items.map(assignmentToRow), ASSIGN_COLUMNS);
    replaceRows(
      db,
      'assignment_seq',
      Object.entries(data.seq ?? {}).map(([day, n]) => ({ day, n: Number(n) || 0 })),
      ['day', 'n'],
    );
  }

  async function load() {
    return withDb(paths, { log }, readBook);
  }

  function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // 事务里重读 → 改 → 写；BEGIN IMMEDIATE 先拿写锁，别的进程只能等，
  // 不会出现「两个宿主各拿旧快照互相覆盖」。
  function mutate(fn) {
    return enqueue(() =>
      withDb(paths, { log }, async (db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = readBook(db);
          const result = await fn(current);
          writeBook(db, current);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 保留原始错误
          }
          throw err;
        }
      }),
    );
  }

  function read(fn) {
    return enqueue(() => withDb(paths, { log }, (db) => fn(readBook(db))));
  }

  // 兼容旧接口：没有内存缓存了
  function invalidate() {}

  return { load, mutate, read, invalidate, limit };
}

// 迁移用：把老的 assignments.json 灌进库。用 meta 标记判断迁过没有，
// 按 id 去重合并；失败不写标记，下次还能重来。
export async function seedAssignments(paths, data, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const db = openDb(paths, { log });
  try {
    if (getMeta(db, 'legacy_assignments_v1')) return { seeded: false, items: 0, done: true };
    const raw = Array.isArray(data?.items) ? data.items : [];
    const items = raw.map(normalizeAssignment).filter(Boolean);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = new Set(db.prepare('SELECT id FROM assignments').all().map((row) => row.id));
      const missing = items.filter((item) => !existing.has(item.id));
      if (missing.length) {
        const placeholders = ASSIGN_COLUMNS.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO assignments (${ASSIGN_COLUMNS.join(', ')}) VALUES (${placeholders})`);
        missing.forEach((item, index) => {
          const row = assignmentToRow(item, index);
          stmt.run(...ASSIGN_COLUMNS.map((name) => row[name] ?? null));
        });
      }
      for (const [day, n] of Object.entries(data?.seq ?? {})) {
        db.prepare(
          'INSERT INTO assignment_seq (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = MAX(n, excluded.n)',
        ).run(day, Number(n) || 0);
      }
      setMeta(db, 'legacy_assignments_v1', { at: new Date().toISOString(), items: missing.length });
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
