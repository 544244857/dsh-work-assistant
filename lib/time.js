// 所有时刻在内部统一存 UTC ISO 字符串，比较用字典序即可；
// 只有「今天是哪天」「几点了」这种面向人的判断才回到指定时区。

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function resolveZone(timeZone) {
  const zone = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

// 把某个瞬间投影到目标时区的日历字段
export function zonedParts(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: resolveZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const text = fmt.format(date); // 形如 2026-10-20 09:23:29
  const [dayPart, timePart] = text.split(' ');
  const [year, month, day] = dayPart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: dayPart,
    time: `${pad2(hour)}:${pad2(minute)}`,
    minuteOfDay: hour * 60 + minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

export function dayKey(instant, timeZone) {
  return zonedParts(instant, timeZone).date;
}

// 时区换算：先用 UTC 猜一个时刻，再按该时刻在目标时区的偏移修正，两轮收敛。
// DST 跳变的那一小时可能差一小时，对「今天/明天到期」这类判断无影响。
function civilToUtc(year, month, day, hour, minute, second, timeZone) {
  const zone = resolveZone(timeZone);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!zone) {
    // 系统时区：用本地构造函数
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }
  let ts = guess;
  for (let i = 0; i < 2; i += 1) {
    const parts = zonedParts(new Date(ts), zone);
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    ts += guess - localAsUtc;
  }
  return ts;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

// 接受：完整 ISO（带时区）、YYYY-MM-DD HH:mm、YYYY-MM-DD；纯日期按当天 18:00 算
export function parseInstant(input, timeZone, fallbackHour = 18) {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input.toISOString();
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    return new Date(input).toISOString();
  }
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ts = civilToUtc(Number(y), Number(m), Number(d), fallbackHour, 0, 0, timeZone);
    return new Date(ts).toISOString();
  }
  const dateTime = DATE_TIME.exec(text);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss] = dateTime;
    const ts = civilToUtc(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss ?? 0), timeZone);
    return new Date(ts).toISOString();
  }
  // 交给 Date 兜底：能认带 Z 或 +08:00 的写法
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function formatInstant(iso, timeZone) {
  if (!iso) return '';
  const parts = zonedParts(iso, timeZone);
  const sameDay = parts.date === dayKey(new Date(), timeZone);
  return sameDay ? `今天 ${parts.time}` : `${parts.date.slice(5).replace('-', '/')} ${parts.time}`;
}

export function formatDay(iso, timeZone) {
  if (!iso) return '';
  const parts = zonedParts(iso, timeZone);
  return parts.date.slice(5).replace('-', '/');
}

export function addDays(instant, days) {
  return new Date(new Date(instant).getTime() + days * 86400000).toISOString();
}
