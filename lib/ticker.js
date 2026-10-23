import { digest, dueChases, dueReminders, findItem, markChased, renderDigest, renderWeeklyReview, weeklyReview } from './ledger.js';
import { dayKey, resolveZone, zonedParts } from './time.js';

// 定时器不烧 token：到点直接用模板拼摘要推微信。
// 所有“今天是否已经推过”的判断都落盘到 state，重启后不会重复轰炸。

function parseHm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, minuteOfDay: hour * 60 + minute };
}

export function normalizeBriefTimes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const parsed = parseHm(entry);
    if (!parsed) continue;
    out.push(`${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`);
  }
  return [...new Set(out)].sort();
}

// 安静时段：默认 22:00 到次日 08:00 不推消息。
// 半夜三点弹「提醒：交周报」只会让人关掉通知，那以后所有提醒都白推了。
// 跨零点的写法（22:00-08:00）要单独判，不能只比大小。
export function inQuietHours(at, timeZone, quietHours) {
  const range = quietHours && typeof quietHours === 'object' ? quietHours : null;
  if (!range) return false;
  const start = parseHm(range.start);
  const end = parseHm(range.end);
  if (!start || !end) return false;
  if (start.minuteOfDay === end.minuteOfDay) return false;

  const parts = zonedParts(at, timeZone);
  const now = parts.minuteOfDay;
  if (start.minuteOfDay < end.minuteOfDay) {
    return now >= start.minuteOfDay && now < end.minuteOfDay;
  }
  // 跨零点
  return now >= start.minuteOfDay || now < end.minuteOfDay;
}

export function createTicker(options) {
  const {
    intervalMs = 60000,
    getState,
    saveState,
    now = () => new Date(),
    push,
    timeZone,
    briefTimes = ['09:00', '18:30'],
    quietHours = null,
    // 注意别跟 import 进来的 weeklyReview() 重名，否则这里会被参数遮蔽
    weeklyReview: weeklyReviewConfig = null,
    maxChars = 1200,
    log = () => {},
    store,
  } = options;

  const zone = resolveZone(timeZone);
  const schedule = normalizeBriefTimes(briefTimes);
  const weekly = parseWeekly(weeklyReviewConfig);
  let timer = null;
  let running = false;

  // 周复盘配置：weekday 用 1-7（1 是周一），time 形如 18:00。
// 传 false/null 表示关掉。
function parseWeekly(value) {
  if (!value || typeof value !== 'object') return null;
  const weekday = Number(value.weekday);
  const time = parseHm(value.time);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
  if (!time) return null;
  return { weekday, time, minuteOfDay: time.minuteOfDay };
}

function briefsSentToday(state, todayKey) {
    const sent = state.briefs ?? {};
    return sent.date === todayKey ? sent.times ?? [] : [];
  }

  function rememberBrief(state, todayKey, hhmm) {
    const sent = state.briefs ?? (state.briefs = {});
    if (sent.date !== todayKey) {
      sent.date = todayKey;
      sent.times = [];
    }
    if (!sent.times.includes(hhmm)) sent.times.push(hhmm);
  }

  // 返回本次实际做的事，便于测试断言
  async function tick(at = now()) {
    if (running) return { skipped: 'busy' };
    running = true;
    const actions = [];
    try {
      const state = getState();
      const todayKey = dayKey(at, zone);

      // 0) 安静时段：一条都不推，但也不能标记成「已提醒」——
      // 那样早上起来就永远收不到了。留在队列里等安静时段结束。
      if (inQuietHours(at, zone, quietHours)) {
        return { actions, quiet: true };
      }

      // 1) 单条到期提醒：先推成功再标记，推失败留到下一轮重试。
      // 反过来做（先标记再推）在网络抖动时会静默丢提醒，用户永远收不到。
      const due = await store.read((ledger) =>
        dueReminders(ledger, at).map((item) => ({
          id: item.id,
          title: item.title,
          dueAt: item.dueAt,
          priority: item.priority,
        })),
      );

      const delivered = [];
      for (const item of due) {
        const bits = [`提醒：${item.title}`];
        if (item.dueAt) bits.push(`原定 ${formatDue(item.dueAt, zone)}`);
        const ok = await push(bits.join('，'));
        actions.push({ kind: 'reminder', id: item.id, delivered: ok !== false });
        if (ok === false) log(`ticker: 提醒 ${item.id} 没发出去，留到下一轮`);
        else delivered.push(item.id);
      }

      if (delivered.length) {
        const stamp = at.toISOString();
        await store.mutate((ledger) => {
          for (const id of delivered) {
            const item = findItem(ledger, id);
            if (item) item.remindedAt = stamp;
          }
          return null;
        });
      }

      // 1.5) 该去问别人一句了。和到期提醒分开推：话术不同，用户看到「该催谁」比
      // 「你的活儿到期了」更愿意立刻动手。推成功才把下一次往前推，失败留到下一轮。
      const chases = await store.read((ledger) =>
        dueChases(ledger, at).map((item) => ({
          id: item.id,
          title: item.title,
          who: item.assignee.name,
          count: Number(item.assignee.chaseCount) || 0,
        })),
      );
      const chased = [];
      for (const item of chases) {
        const head = item.count > 0 ? `还没回音：${item.title}` : `该去问一句了：${item.title}`;
        const ok = await push(`${head}，等 ${item.who}`);
        actions.push({ kind: 'chase', id: item.id, delivered: ok !== false });
        if (ok === false) log(`ticker: 催问 ${item.id} 没发出去，留到下一轮`);
        else chased.push(item.id);
      }
      if (chased.length) {
        await store.mutate((ledger) => {
          for (const id of chased) markChased(ledger, id, at);
          return null;
        });
      }

      // 2) 每日摘要：到点且当天没推过才推
      const parts = zonedParts(at, zone);
      const already = briefsSentToday(state, todayKey);
      for (const hhmm of schedule) {
        const target = parseHm(hhmm);
        if (!target) continue;
        if (parts.minuteOfDay < target.minuteOfDay) continue;
        if (already.includes(hhmm)) continue;

        const data = await store.read((ledger) => digest(ledger, at, zone));
        const body = renderDigest(data, { timeZone: zone, maxChars });

        // 没活儿的时候也要记账：否则每分钟都会重新判断一次这个时间点
        if (data.counts.open === 0) {
          rememberBrief(state, todayKey, hhmm);
          saveState();
          actions.push({ kind: 'brief', at: hhmm, open: 0 });
          break;
        }

        const ok = await push(body);
        actions.push({ kind: 'brief', at: hhmm, open: data.counts.open, delivered: ok !== false });
        if (ok === false) {
          // 没发出去就不记账，下一轮接着试
          log(`ticker: ${hhmm} 的摘要没发出去，留到下一轮`);
          break;
        }
        rememberBrief(state, todayKey, hhmm);
        saveState();
        break; // 一次 tick 只推一个摘要，错过多个时间点时合并成一次
      }

      // 3) 周复盘：到了设定的星期和时间点，且这周还没推过
      if (weekly) {
        const parts2 = zonedParts(at, zone);
        const weekday = parts2.weekday === 0 ? 7 : parts2.weekday;
        const weekKey = dayKey(at, zone);
        const sentWeek = state.weekly ?? '';
        if (
          weekday === weekly.weekday &&
          parts2.minuteOfDay >= weekly.minuteOfDay &&
          sentWeek !== weekKey
        ) {
          const data = await store.read((ledger) => weeklyReview(ledger, at, zone));
          const body = renderWeeklyReview(data, { timeZone: zone, maxChars });
          const ok = await push(body);
          actions.push({ kind: 'weekly', delivered: ok !== false, done: data.counts.done });
          if (ok === false) {
            // 没发出去就不记账，下一轮接着试
            log('ticker: 周复盘没发出去，留到下一轮');
          } else {
            state.weekly = weekKey;
            saveState();
          }
        }
      }

      return { actions };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => {
      tick().catch((err) => log(`ticker: ${err?.message ?? err}`));
    }, intervalMs);
    // 定时器不应该阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}

function formatDue(iso, zone) {
  const parts = zonedParts(iso, zone);
  return `${parts.date.slice(5).replace('-', '/')} ${parts.time}`;
}
