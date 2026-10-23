// 宿主租约：同一个数据目录只让一个宿主干活。
//
// 为什么需要：桌面端和 `dsh web` 共用 C:\Users\<用户>\.dsh\dsh-work-assistant，
// 也共用同一个微信机器人。两个宿主都长轮询、都到点发提醒，用户就会收到两份
// 内容还不一样的消息（另一个宿主的账本还停在过去）。
// 做法是在库里记一行自己的心跳：谁的行最老谁是主，主控每 30 秒续期；
// 主控退出（正常关或崩溃），心跳过期后另一个自动接手，不用人工干预。
import { randomUUID } from 'node:crypto';
import { withDb, tx } from './db.js';

// 90 秒没续期就当它已经没了：够扛住系统卡顿和一次慢写，又不会让用户等太久。
export const LEASE_TTL_MS = 90_000;
export const HEARTBEAT_MS = 30_000;

const COLUMNS = 'id, pid, role, started_at, heartbeat_at';

function pickRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    pid: Number(row.pid ?? 0),
    role: row.role,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  }));
}

// 只读：现在还有哪些宿主活着，最老的排最前。
export async function liveHosts(paths, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : LEASE_TTL_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cutoff = new Date(nowMs - ttlMs).toISOString();
  return withDb(paths, { log: options.log }, async (db) =>
    pickRows(
      db
        .prepare(`SELECT ${COLUMNS} FROM hosts WHERE heartbeat_at >= ? ORDER BY started_at ASC, id ASC`)
        .all(cutoff),
    ),
  );
}

export function createHostLease(paths, options = {}) {
  const log = options.log ?? (() => {});
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : LEASE_TTL_MS;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const id = options.id ?? `${process.pid ?? 0}-${randomUUID()}`;
  const role = options.role ?? 'host';
  const onPromote = options.onPromote ?? null;
  const onDemote = options.onDemote ?? null;

  let primary = false;
  let rows = [];
  let timer = null;
  let busy = false;

  // 一次心跳＝续期＋重新选主。整个过程在同一个写事务里：
  // 两个宿主同时进来只会有一个先写成功，另一个读到的就是对方的行。
  async function beat() {
    const at = now().toISOString();
    const cutoff = new Date(Date.parse(at) - ttlMs).toISOString();
    return withDb(paths, { log }, async (db) =>
      tx(db, () => {
        db.prepare('DELETE FROM hosts WHERE heartbeat_at < ?').run(cutoff);
        db.prepare(
          `INSERT INTO hosts (${COLUMNS}) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             heartbeat_at = excluded.heartbeat_at,
             pid = excluded.pid,
             role = excluded.role`,
        ).run(id, Number(process.pid ?? 0), role, at, at);
        return pickRows(db.prepare(`SELECT ${COLUMNS} FROM hosts ORDER BY started_at ASC, id ASC`).all());
      }),
    );
  }

  async function refresh() {
    if (busy) return { primary, hosts: rows };
    busy = true;
    try {
      rows = await beat();
      const nextPrimary = rows.length > 0 && rows[0].id === id;
      if (nextPrimary !== primary) {
        primary = nextPrimary;
        try {
          if (primary) {
            log('lease: 本实例接手（没有别的宿主在跑了），开始轮询和提醒');
            await onPromote?.();
          } else {
            const holder = rows[0];
            log(`lease: 另一个宿主在跑（pid ${holder?.pid ?? '?'}），本实例待命：不轮询、不发提醒`);
            await onDemote?.();
          }
        } catch (err) {
          log(`lease: 切换角色时出错 ${err?.message ?? err}`);
        }
      }
      return { primary, hosts: rows };
    } catch (err) {
      // 续期失败不要立刻放弃主控权：库偶尔忙一下（几毫秒）不该让提醒断档。
      log(`lease: 续期失败 ${err?.message ?? err}`);
      return { primary, hosts: rows };
    } finally {
      busy = false;
    }
  }

  return {
    id,
    role,
    async start() {
      const state = await refresh();
      if (!timer) {
        timer = setInterval(() => {
          void refresh();
        }, heartbeatMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      return state;
    },
    refresh,
    isPrimary: () => primary,
    hosts: () => rows,
    status: () => ({ id, primary, hosts: rows, ttlMs }),
    // 退出时把行删掉，另一个宿主下一次心跳就能立刻接手，不用等 90 秒过期。
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        await withDb(paths, { log }, async (db) => {
          db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
        });
        rows = rows.filter((row) => row.id !== id);
        log('lease: 已交还主控权');
      } catch (err) {
        log(`lease: 退出时注销失败 ${err?.message ?? err}`);
      }
    },
  };
}
