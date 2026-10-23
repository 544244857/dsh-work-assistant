import { addDays, dayKey, formatInstant, formatDay, parseInstant } from './time.js';

const STATUSES = ['open', 'doing', 'done', 'dropped'];
const PRIORITIES = ['low', 'normal', 'high'];
const OPEN_STATUSES = ['open', 'doing'];
const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低' };

export function emptyLedger() {
  return { version: 1, items: [], seq: {} };
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

function normalizeStatus(value, fallback) {
  return STATUSES.includes(value) ? value : fallback;
}

function normalizePriority(value, fallback) {
  return PRIORITIES.includes(value) ? value : fallback;
}

// 指派：只记「谁」和「隔几天去问一句」，不替用户去催 —— 催人这件事得他自己开口
export function normalizeAssignee(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const days = Number(value.everyDays);
  return {
    name,
    at: typeof value.at === 'string' && value.at ? value.at : null,
    verifyAt: typeof value.verifyAt === 'string' && value.verifyAt ? value.verifyAt : null,
    everyDays: Number.isFinite(days) && days > 0 ? Math.min(365, Math.floor(days)) : 3,
    chaseCount: Number.isFinite(Number(value.chaseCount)) ? Math.max(0, Math.floor(Number(value.chaseCount))) : 0,
  };
}

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!path) continue;
    out.push({
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.split(/[\\/]/).pop(),
      path,
      bytes: Number.isFinite(Number(entry.bytes)) ? Math.max(0, Math.floor(Number(entry.bytes))) : 0,
      addedAt: typeof entry.addedAt === 'string' && entry.addedAt ? entry.addedAt : null,
    });
  }
  return out;
}

function nextId(ledger, now, timeZone) {
  const key = dayKey(now, timeZone).replace(/-/g, '');
  const seq = ledger.seq ?? (ledger.seq = {});
  const n = (Number(seq[key]) || 0) + 1;
  seq[key] = n;
  return `w-${key}-${String(n).padStart(3, '0')}`;
}

export function findItem(ledger, id) {
  return ledger.items.find((item) => item.id === id) ?? null;
}

// 没说优先级时自己判一个：措辞急的先算高，其次看期限离得多近。
// 用户不用每次都想「这件事算高还是普通」，排错了他还能用 work_update 改回来。
const URGENT_WORDS = ['急', '马上', '立刻', '尽快', '催', '今天', '今晚', '截止', '最后期限', 'asap'];
const HIGH_WORDS = ['明天', '这周', '本周', '周五', '周四', '领导', '老板', '用户', '客户'];

export function inferPriority(input, dueAt, now = new Date()) {
  const hay = `${input.title ?? ''} ${input.detail ?? ''}`.toLowerCase();
  if (URGENT_WORDS.some((word) => hay.includes(word))) return 'high';

  if (dueAt) {
    const at = new Date(dueAt).getTime();
    const stamp = new Date(now).getTime();
    if (Number.isFinite(at)) {
      const hours = (at - stamp) / 3600000;
      if (hours <= 48) return 'high';
      if (hours <= 24 * 7) return 'normal';
    }
  }
  if (HIGH_WORDS.some((word) => hay.includes(word))) return 'high';
  return 'normal';
}

export function addItem(ledger, input, now = new Date(), timeZone) {
  const stamp = new Date(now).toISOString();
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('title 不能为空');

  const dueAt = parseInstant(input.dueAt, timeZone) ?? null;
  const priority = PRIORITIES.includes(input.priority)
    ? input.priority
    : inferPriority({ title, detail: input.detail }, dueAt, now);

  const item = {
    id: nextId(ledger, now, timeZone),
    title,
    detail: typeof input.detail === 'string' ? input.detail.trim() : '',
    status: normalizeStatus(input.status, 'open'),
    priority,
    dueAt,
    remindAt: parseInstant(input.remindAt, timeZone) ?? null,
    remindedAt: null,
    tags: normalizeTags(input.tags),
    actionable: input.actionable === true,
    suggestedAction: typeof input.suggestedAction === 'string' ? input.suggestedAction.trim() : '',
    offerState: 'none',
    priorityAuto: !PRIORITIES.includes(input.priority),
    // 重复任务：完成一条时按这个节奏自动生成下一条
    recurrence: normalizeRecurrence(input.recurrence),
    // 挂在别人手上的事：谁做、什么时候该去问一句、隔几天问一次
    assignee: normalizeAssignee(input.assignee),
    // 相关文件只记路径，不复制内容 —— 用户自己的文件放哪就还在哪
    attachments: normalizeAttachments(input.attachments),
    // 派出去干的活会挂上副手 id，列表里就能看出「这条有人在办」
    assignmentId: typeof input.assignmentId === 'string' && input.assignmentId.trim() ? input.assignmentId.trim() : null,
    source: input.source ?? null,
    notes: [],
    createdAt: stamp,
    updatedAt: stamp,
    doneAt: null,
  };
  if (item.dueAt && !item.remindAt) {
    // 默认提前一小时提醒，太晚就不设（避免一创建就立刻炸）
    const lead = new Date(new Date(item.dueAt).getTime() - 3600000).toISOString();
    if (lead > stamp) item.remindAt = lead;
  }
  ledger.items.unshift(item);
  return { ledger, item };
}

export function updateItem(ledger, id, patch = {}, now = new Date(), timeZone) {
  const item = findItem(ledger, id);
  if (!item) throw new Error(`找不到工作项 ${id}`);
  const stamp = new Date(now).toISOString();

  if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim();
  if (typeof patch.detail === 'string') item.detail = patch.detail.trim();
  if (patch.priority !== undefined) {
    item.priority = normalizePriority(patch.priority, item.priority);
    // 人工指定过优先级就不再算自动的了，否则下次改别的字段会被覆盖回去
    item.priorityAuto = false;
  }
  if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags);
  if (patch.actionable !== undefined) item.actionable = patch.actionable === true;
  if (typeof patch.suggestedAction === 'string') item.suggestedAction = patch.suggestedAction.trim();
  if (patch.offerState !== undefined) {
    const next = ['none', 'offered', 'accepted', 'declined'].includes(patch.offerState)
      ? patch.offerState
      : item.offerState;
    item.offerState = next;
  }

  if (patch.dueAt !== undefined) item.dueAt = parseInstant(patch.dueAt, timeZone) ?? null;
  if (patch.remindAt !== undefined) {
    item.remindAt = parseInstant(patch.remindAt, timeZone) ?? null;
    if (!item.remindAt) item.remindedAt = null;
  }
  if (patch.recurrence !== undefined) {
    item.recurrence = patch.recurrence === null ? null : normalizeRecurrence(patch.recurrence);
  }
  if (patch.assignee !== undefined) {
    item.assignee = patch.assignee === null ? null : normalizeAssignee(patch.assignee);
  }
  if (patch.attachments !== undefined) {
    item.attachments = normalizeAttachments(patch.attachments);
  }
  if (patch.assignmentId !== undefined) {
    item.assignmentId =
      typeof patch.assignmentId === 'string' && patch.assignmentId.trim() ? patch.assignmentId.trim() : null;
  }
  // 稍后提醒：把 remindAt 往后推，并清掉「已经提醒过」的标记，否则推了也不会再触发
  if (patch.snoozeMinutes !== undefined) {
    const minutes = Number(patch.snoozeMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('snoozeMinutes 必须是正数');
    const base = item.remindAt && item.remindAt > stamp ? item.remindAt : stamp;
    item.remindAt = new Date(new Date(base).getTime() + Math.floor(minutes) * 60000).toISOString();
    item.remindedAt = null;
  }

  if (patch.status !== undefined) {
    const next = normalizeStatus(patch.status, item.status);
    if (next !== item.status) {
      item.status = next;
      item.doneAt = next === 'done' ? stamp : null;
      if (next === 'done' || next === 'dropped') item.remindedAt = stamp;
      // 重复任务做完就自动排下一次，不用每次手动再记一遍
      if (next === 'done' && item.recurrence) {
        const nextDue = nextOccurrence(item.dueAt, item.recurrence, now);
        if (nextDue) {
          const spawned = addItem(
            ledger,
            {
              title: item.title,
              detail: item.detail,
              priority: item.priority,
              tags: item.tags,
              actionable: item.actionable,
              suggestedAction: item.suggestedAction,
              dueAt: nextDue,
              recurrence: item.recurrence,
              assignee: item.assignee,
              attachments: item.attachments,
              source: item.source,
            },
            now,
            timeZone,
          );
          item.nextId = spawned.item.id;
          item.updatedAt = stamp;
          return { ledger, item, spawned: spawned.item };
        }
      }
    }
  }

  if (typeof patch.note === 'string' && patch.note.trim()) {
    item.notes.push({ at: stamp, text: patch.note.trim() });
  }

  item.updatedAt = stamp;
  return { ledger, item };
}

// 自动排优先级：把「离到期还有多久」和「人工标的优先级」折成一个紧急度分数，分越高越该先干。
// 逾期按天加权但封顶，免得一件陈年旧账永远压在第一条；没期限的只吃优先级分。
const PRIORITY_SCORE = { high: 30, normal: 12, low: 0 };
const HOUR = 3600000;

export function urgencyOf(item, now = new Date()) {
  const stamp = new Date(now).getTime();
  let score = PRIORITY_SCORE[item.priority] ?? PRIORITY_SCORE.normal;

  if (item.dueAt) {
    const at = new Date(item.dueAt).getTime();
    if (Number.isFinite(at)) {
      const hours = (at - stamp) / HOUR;
      if (hours < 0) score += 60 + Math.min(30, Math.ceil(-hours / 24) * 3);
      else if (hours <= 24) score += 50;
      else if (hours <= 72) score += 40;
      else if (hours <= 24 * 7) score += 25;
      else score += 10;
    }
  }
  if (item.status === 'doing') score += 5; // 动过手的比没动的更容易收尾
  return score;
}

function sortItems(items, now = new Date()) {
  return [...items].sort((a, b) => {
    const diff = urgencyOf(b, now) - urgencyOf(a, now);
    if (diff !== 0) return diff;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 同一个标题的活儿很容易被重复记（模型重试、用户重发）。
// 这里做一次宽松比对：去空白、统一大小写、去掉标点，再看未完成项里有没有同名的。
function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?“”"'（）()《》<>【】[\]]/g, '');
}

export function findDuplicate(ledger, title) {
  const key = titleKey(title);
  if (!key) return null;
  return (
    ledger.items.find((item) => OPEN_STATUSES.includes(item.status) && titleKey(item.title) === key) ?? null
  );
}

// ── 重复任务 ────────────────────────────────────────────
// 只支持三种最常见的节奏：每天、每周、每月。更复杂的 cron 交给用户自己排，
// 这里够用就行 —— 收个值班表、每周交材料，基本都是这三种。

export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'];// 工具参数用 kind/every/weekdays，账本内部用 freq/interval；
// 两种写法都认，免得模型按提示词写 kind 就静默失效（踩过这个坑）。
export function normalizeRecurrence(value) {
  if (!value || typeof value !== 'object') return null;
  const rawKind = value.kind ?? value.freq;
  const freq = RECURRENCE_FREQS.includes(rawKind) ? rawKind : '';
  if (!freq) return null;
  const rawEvery = value.every ?? value.interval;
  const n = Number(rawEvery);
  const interval = Number.isFinite(n) ? Math.max(1, Math.min(365, Math.floor(n))) : 1;
  const weekdays = Array.isArray(value.weekdays)
    ? [...new Set(value.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : [];
  return { freq, interval, weekdays: freq === 'weekly' ? weekdays : [] };
}

// 月份加减要处理月末：1 月 31 日加一个月是 2 月 28/29 日，不能滚到 3 月
function addMonths(iso, months) {
  const from = new Date(iso);
  const day = from.getUTCDate();
  const target = new Date(from.getTime());
  target.setUTCMonth(target.getUTCMonth() + months);
  if (target.getUTCDate() < day) target.setUTCDate(0);
  return target.toISOString();
}

// 从原期限往后推，一直推到未来。中间漏掉的几次不补 ——
// 一次性补出五条过期的「交周报」只会把账本淹掉。
export function nextOccurrence(dueAt, recurrence, now = new Date()) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec || !dueAt) return null;
  const stamp = new Date(now).getTime();
  let cursor = dueAt;

  // 指定了每周几：直接找下一个落在这些星期几上的时刻，不用一天天试
  if (rec.freq === 'weekly' && rec.weekdays.length) {
    const base = new Date(dueAt);
    for (let i = 1; i <= 400; i += 1) {
      const probe = new Date(base.getTime() + i * 86400000);
      const weekday = probe.getUTCDay() === 0 ? 7 : probe.getUTCDay();
      if (!rec.weekdays.includes(weekday)) continue;
      if (probe.getTime() > stamp) return probe.toISOString();
    }
    return null;
  }

  for (let i = 0; i < 400; i += 1) {
    if (rec.freq === 'daily') {
      cursor = new Date(new Date(cursor).getTime() + rec.interval * 86400000).toISOString();
    } else if (rec.freq === 'weekly') {
      cursor = new Date(new Date(cursor).getTime() + rec.interval * 7 * 86400000).toISOString();
    } else {
      cursor = addMonths(cursor, rec.interval);
    }
    if (new Date(cursor).getTime() > stamp) return cursor;
  }
  return null;
}

const WEEKDAY_LABEL = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };

export function describeRecurrence(recurrence) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return '';
  const unit = rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '月';
  const base = rec.interval === 1 ? `每${unit}` : `每 ${rec.interval} ${unit}`;
  if (rec.freq === 'weekly' && rec.weekdays.length) {
    return `${base}周${rec.weekdays.map((d) => WEEKDAY_LABEL[d] ?? d).join('、')}`;
  }
  return base;
}

export function listItems(ledger, filter = {}, now = new Date(), timeZone) {
  const { status, dueWithinDays, tag, query, assignee, limit } = filter;
  let items = [...ledger.items];

  if (status === 'open') items = items.filter((i) => OPEN_STATUSES.includes(i.status));
  else if (status === 'all') items = items;
  else if (STATUSES.includes(status)) items = items.filter((i) => i.status === status);
  else items = items.filter((i) => OPEN_STATUSES.includes(i.status));

  if (typeof dueWithinDays === 'number' && Number.isFinite(dueWithinDays)) {
    const until = addDays(now, dueWithinDays);
    items = items.filter((i) => i.dueAt && i.dueAt <= until);
  }
  if (typeof tag === 'string' && tag.trim()) {
    const needle = tag.trim();
    items = items.filter((i) => i.tags.includes(needle));
  }
  // 关键词搜索：标题、细节、标签都算，大小写不敏感。
  // 账本条目多了以后只靠翻列表找不到东西，用户会问「上次说的那个报表是哪条」。
  if (typeof query === 'string' && query.trim()) {
    const needle = query.trim().toLowerCase();
    items = items.filter((i) =>
      [i.title, i.detail, (i.tags ?? []).join(' '), i.suggestedAction ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }
  if (typeof assignee === 'string' && assignee.trim()) {
    const needle = assignee.trim();
    items = items.filter((i) => (i.assignee?.name ?? '') === needle);
  }

  const sorted = sortItems(items, now);
  const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
  return { items: sorted.slice(0, cap), total: sorted.length };
}

export function dueReminders(ledger, now = new Date()) {
  const stamp = new Date(now).toISOString();
  return ledger.items.filter(
    (item) => OPEN_STATUSES.includes(item.status) && item.remindAt && item.remindAt <= stamp && !item.remindedAt,
  );
}

// 指派出去的活儿什么时候该去问一句：显式约的时间优先，
// 没约就按「记下来那天 + 每 N 天」推。保证每一条指派都有明确的催问时刻，
// 否则 work_assign 回执里那句「我会提醒你去问一句」就是空头支票。
export function chaseAtOf(assignee) {
  if (!assignee || !assignee.name) return null;
  if (assignee.verifyAt) return assignee.verifyAt;
  if (!assignee.at) return null;
  const days = Number.isFinite(Number(assignee.everyDays)) && Number(assignee.everyDays) > 0
    ? Math.floor(Number(assignee.everyDays))
    : 3;
  return addDays(assignee.at, days);
}

// 到点该去催别人的指派。和 dueReminders 分开算：
// 那是「你自己该做的事到期了」，这是「该去问别人一句了」，话术和后续处理都不一样。
export function dueChases(ledger, now = new Date()) {
  const stamp = new Date(now).toISOString();
  return ledger.items.filter((item) => {
    if (!OPEN_STATUSES.includes(item.status)) return false;
    const at = chaseAtOf(item.assignee);
    return Boolean(at) && at <= stamp;
  });
}

// 催过一次之后把下一次往前推。用户没回「问过了」就不停，
// 隔 N 天再提一次；一旦标成 done/dropped 自然就不再进 dueChases。
export function markChased(ledger, id, now = new Date()) {
  const item = findItem(ledger, id);
  if (!item || !item.assignee?.name) return null;
  const days = Number.isFinite(Number(item.assignee.everyDays)) && Number(item.assignee.everyDays) > 0
    ? Math.floor(Number(item.assignee.everyDays))
    : 3;
  item.assignee = {
    ...item.assignee,
    chaseCount: (Number(item.assignee.chaseCount) || 0) + 1,
    verifyAt: addDays(now, days),
  };
  item.updatedAt = new Date(now).toISOString();
  return item;
}

export function digest(ledger, now = new Date(), timeZone) {
  const stamp = new Date(now).toISOString();
  const todayKey = dayKey(now, timeZone);
  const weekEnd = addDays(now, 7);
  const open = ledger.items.filter((i) => OPEN_STATUSES.includes(i.status));

  const overdue = [];
  const today = [];
  const upcoming = [];
  const someday = [];
  for (const item of open) {
    if (!item.dueAt) {
      someday.push(item);
      continue;
    }
    if (item.dueAt < stamp && dayKey(item.dueAt, timeZone) !== todayKey) overdue.push(item);
    else if (dayKey(item.dueAt, timeZone) === todayKey) today.push(item);
    else if (item.dueAt <= weekEnd) upcoming.push(item);
    else someday.push(item);
  }

  return {
    counts: {
      open: open.length,
      doing: open.filter((i) => i.status === 'doing').length,
      overdue: overdue.length,
      today: today.length,
      upcoming: upcoming.length,
      actionable: open.filter((i) => i.actionable && i.offerState !== 'accepted').length,
    },
    overdue: sortItems(overdue, now),
    today: sortItems(today, now),
    upcoming: sortItems(upcoming, now),
    someday: sortItems(someday, now),
    actionable: sortItems(open.filter((i) => i.actionable && i.offerState !== 'accepted'), now),
  };
}

// 周复盘：只看这一周发生的事，模板拼装，不烧 token。
// 用户要的是「这周干了什么、还剩什么」，不是长篇分析。
export function weeklyReview(ledger, now = new Date(), timeZone, days = 7) {
  const stamp = new Date(now).toISOString();
  const since = new Date(new Date(now).getTime() - days * 86400000).toISOString();
  const items = ledger.items ?? [];

  const doneThisWeek = items.filter((i) => i.status === 'done' && i.doneAt && i.doneAt >= since);
  const createdThisWeek = items.filter((i) => i.createdAt && i.createdAt >= since);
  const droppedThisWeek = items.filter((i) => i.status === 'dropped' && i.updatedAt && i.updatedAt >= since);
  const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
  const overdue = open.filter((i) => i.dueAt && i.dueAt < stamp && dayKey(i.dueAt, timeZone) !== dayKey(now, timeZone));

  const tagCount = new Map();
  for (const item of [...doneThisWeek, ...open]) {
    for (const tag of item.tags ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 一直在往后拖的事：创建超过一周还没动，多半是卡住了或者根本不想做
  const stale = open.filter((i) => i.createdAt && i.createdAt < since && i.status === 'open');

  return {
    days,
    since,
    counts: {
      done: doneThisWeek.length,
      created: createdThisWeek.length,
      dropped: droppedThisWeek.length,
      open: open.length,
      overdue: overdue.length,
      stale: stale.length,
    },
    done: sortItems(doneThisWeek, now),
    overdue: sortItems(overdue, now),
    stale: sortItems(stale, now),
    topTags,
  };
}

export function renderWeeklyReview(data, { timeZone, maxChars = 1200 } = {}) {
  const { counts } = data;
  if (counts.done === 0 && counts.created === 0 && counts.open === 0) {
    return `这一周（近 ${data.days} 天）账本里没有任何动静。`;
  }

  const lines = [];
  lines.push(`这一周：完成 ${counts.done} 件，新记 ${counts.created} 件，手上还剩 ${counts.open} 件。`);

  if (counts.done > 0) {
    lines.push('');
    lines.push('做完的');
    data.done.slice(0, 8).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title}`);
    });
    if (data.done.length > 8) lines.push(`……还有 ${data.done.length - 8} 件`);
  }

  if (counts.overdue > 0) {
    lines.push('');
    lines.push(`逾期的 ${counts.overdue} 件`);
    data.overdue.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${lineOf(item, timeZone, false)}`);
    });
  }

  if (counts.stale > 0) {
    lines.push('');
    lines.push(`记了一周还没动的 ${counts.stale} 件`);
    data.stale.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title}`);
    });
    lines.push('这些要么排个时间，要么干脆删掉，挂着最耗神。');
  }

  if (data.topTags.length) {
    lines.push('');
    lines.push(`这一周集中在：${data.topTags.map(([tag, n]) => `${tag}（${n}）`).join('、')}`);
  }

  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 12)}\n……（已截断）`;
  return out;
}

function lineOf(item, timeZone, withTime = true) {
  const bits = [`[${PRIORITY_LABEL[item.priority]}]`, item.title];
  if (item.status === 'doing') bits.push('（进行中）');
  if (item.dueAt) bits.push(withTime ? `原定 ${formatInstant(item.dueAt, timeZone)}` : `原定 ${formatDay(item.dueAt, timeZone)}`);
  const repeat = describeRecurrence(item.recurrence);
  if (repeat) bits.push(`（${repeat}）`);
  if (item.assignee?.name) bits.push(`等 ${item.assignee.name}`);
  return bits.join(' ');
}

// 模板摘要：确定性输出，不烧 token，便于测试
export function renderDigest(data, { timeZone, maxChars = 1200 } = {}) {
  const { counts } = data;
  if (counts.open === 0) return '手上没有未完成的活儿。';

  const lines = [];
  lines.push(`手上还有 ${counts.open} 件事没完成${counts.overdue ? `，其中 ${counts.overdue} 件已逾期` : ''}。`);

  const sections = [
    ['逾期', data.overdue, false],
    ['今天到期', data.today, true],
    ['本周内', data.upcoming, true],
    // 没期限的活儿以前在这里被整段丢掉，用户会看到「还有 3 件没完成」却不知道是哪三件。
    ['没定期限', data.someday, false],
  ];
  let index = 0;
  const order = [];
  for (const [label, list, withTime] of sections) {
    if (!list.length) continue;
    lines.push('');
    lines.push(`${label} ${list.length} 件`);
    for (const item of list) {
      index += 1;
      order.push(item);
      lines.push(`${index}. ${lineOf(item, timeZone, withTime)}`);
    }
  }

  if (data.actionable.length) {
    const nums = [];
    for (const item of data.actionable) {
      const at = order.indexOf(item);
      if (at >= 0) nums.push(at + 1);
    }
    if (nums.length) {
      lines.push('');
      lines.push(`其中第 ${nums.join('、')} 件我可以直接代做，回我“做第 ${nums[0]} 件”就行。`);
    } else {
      lines.push('');
      lines.push(`另外还有 ${data.actionable.length} 件我可以代做，说一声就动手。`);
    }
  }

  let text = lines.join('\n').trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n……（后面还有，先列这些）`;
  return text;
}

export function renderItemList(result, { timeZone, maxChars = 1200 } = {}) {
  if (!result.items.length) return '没有匹配的工作项。';
  const lines = [`共 ${result.total} 项，列出前 ${result.items.length} 项：`];
  result.items.forEach((item, i) => {
    const statusMark = item.status === 'doing' ? '进行中' : item.status === 'done' ? '已完成' : item.status === 'dropped' ? '已放弃' : '待办';
    const badge = item.assignmentId ? `（副手 ${item.assignmentId}）` : '';
    const bits = [`${i + 1}. ${item.id} [${statusMark}] [${PRIORITY_LABEL[item.priority]}] ${item.title}${badge}`];
    if (item.dueAt) bits.push(`   期限 ${formatInstant(item.dueAt, timeZone)}`);
    if (item.assignee?.name) {
      // 带上「什么时候去问」，不然用户只看到「等某人」，不知道系统到底哪天会提醒
      const chaseAt = chaseAtOf(item.assignee);
      bits.push(chaseAt
        ? `   等 ${item.assignee.name}（${formatInstant(chaseAt, timeZone)} 去问一句）`
        : `   等 ${item.assignee.name}`);
    }
    const repeat = describeRecurrence(item.recurrence);
    if (repeat) bits.push(`   ${repeat}`);
    if (item.attachments?.length) bits.push(`   附件 ${item.attachments.map((a) => a.name).join(', ')}`);
    if (item.tags.length) bits.push(`   标签 ${item.tags.join(', ')}`);
    if (item.actionable) bits.push(`   可代做：${item.suggestedAction || '是'}`);
    lines.push(bits.join('\n'));
  });
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n……（已截断）`;
  return text;
}

export { PRIORITY_LABEL, STATUSES, PRIORITIES, OPEN_STATUSES };
