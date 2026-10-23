// 整页视图要的统计数据。
// 全部是纯函数：喂一份账本，返回可以直接画图表的数字。
// 不碰 IO、不读系统时钟以外的状态，方便直接写单测断言。

import { OPEN_STATUSES, digest } from './ledger.js';
import { addDays, dayKey } from './time.js';

const DAY = 86400000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// 账本里的时刻可能是坏值（手改过文件、旧版本写进去的），
// 直接丢给 Intl 会抛 RangeError 把整个统计接口打成 500，所以先挡一道。
function safeDayKey(iso, timeZone) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return dayKey(new Date(time), timeZone);
}

function ageDaysOf(item, now) {
  const time = item?.createdAt ? new Date(item.createdAt).getTime() : NaN;
  if (Number.isNaN(time)) return 0;
  return Math.max(0, Math.floor((new Date(now).getTime() - time) / DAY));
}

// 名字里带「未完成」的统计一律只看 open/doing，做完的和放弃的不算，
// 否则优先级分布、标签分布都会被历史数据稀释成一片平均。
function countBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function toRanked(map, limit, nameOf) {
  return [...map.entries()]
    .map(([key, count]) => ({ [nameOf]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[nameOf]).localeCompare(String(b[nameOf])))
    .slice(0, limit);
}

export function buildStats(ledger, now = new Date(), timeZone, options = {}) {
  const trendDays = clampInt(options.trendDays, 14, 1, 60);
  const tagLimit = clampInt(options.tagLimit, 8, 1, 30);
  const assigneeLimit = clampInt(options.assigneeLimit, 5, 1, 20);
  const oldestLimit = clampInt(options.oldestLimit, 5, 1, 20);

  const items = Array.isArray(ledger?.items) ? ledger.items : [];
  const at = new Date(now);
  const open = items.filter((item) => OPEN_STATUSES.includes(item.status));
  // 逾期/今天/本周这几个口径交给 digest，别再实现一遍，两处算法迟早会漂
  const base = digest({ items }, at, timeZone).counts;
  const since = new Date(at.getTime() - 7 * DAY).toISOString();

  const byPriority = { high: 0, normal: 0, low: 0 };
  for (const item of open) {
    const key = byPriority[item.priority] === undefined ? 'normal' : item.priority;
    byPriority[key] += 1;
  }

  // 一条工作项挂多个标签时，每个标签各算一次，不做「标签组合」分组
  const tagMap = new Map();
  for (const item of open) {
    for (const tag of item.tags ?? []) {
      if (!tag) continue;
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
    }
  }

  const buckets = new Map();
  const trend = [];
  for (let i = trendDays - 1; i >= 0; i -= 1) {
    const date = dayKey(addDays(at, -i), timeZone);
    const bucket = { date, created: 0, done: 0 };
    buckets.set(date, bucket);
    trend.push(bucket);
  }
  for (const item of items) {
    const createdKey = safeDayKey(item.createdAt, timeZone);
    if (createdKey && buckets.has(createdKey)) buckets.get(createdKey).created += 1;
    if (item.status !== 'done') continue;
    const doneKey = safeDayKey(item.doneAt, timeZone);
    if (doneKey && buckets.has(doneKey)) buckets.get(doneKey).done += 1;
  }

  const assignees = toRanked(
    countBy(open, (item) => (typeof item.assignee?.name === 'string' ? item.assignee.name.trim() : '')),
    assigneeLimit,
    'name',
  );

  const oldest = open
    .filter((item) => item.createdAt)
    .map((item) => ({
      id: item.id,
      title: item.title,
      priority: item.priority,
      ageDays: ageDaysOf(item, at),
    }))
    .sort((a, b) => b.ageDays - a.ageDays || String(a.id).localeCompare(String(b.id)))
    .slice(0, oldestLimit);

  return {
    generatedAt: at.toISOString(),
    total: items.length,
    counts: {
      open: base.open,
      doing: base.doing,
      overdue: base.overdue,
      today: base.today,
      upcoming: base.upcoming,
      actionable: base.actionable,
      done: items.filter((item) => item.status === 'done').length,
      dropped: items.filter((item) => item.status === 'dropped').length,
      doneWeek: items.filter((item) => item.status === 'done' && item.doneAt && item.doneAt >= since).length,
      createdWeek: items.filter((item) => item.createdAt && item.createdAt >= since).length,
      // 「拖着」和 weeklyReview 保持同一口径：只看还没开始的 open，
      // doing 的说明已经在动了，不该算进拖着的那堆里
      stale: open.filter((item) => item.status === 'open' && item.createdAt && item.createdAt < since).length,
    },
    byPriority,
    byTag: toRanked(tagMap, tagLimit, 'tag'),
    trend,
    assignees,
    oldest,
  };
}
