// 知识库「解析」：定期把聊天、工作项、笔记嚼一遍，抽出人和关系。
//
// 为什么要它：知识库里躺着「值班表：舒子淇、彭喻、肖航、余鹏、曹曼」这种原文，
// 但「这几个人是我的同事」是没人写过的一句话。这一步就是用模型把它读出来，
// 存成结构化的 entities / relations，之后问「值班的是谁」能直接答。
//
// 三条边界：
// 1. 只根据材料说话，材料里没有的人不许编；
// 2. 拿不准的关系可以不写（宁可少写，别写错）；
// 3. 模型输出必须是严格 JSON，解析失败就当这次没跑，不写脏数据。
import { tx, withDb } from './db.js';
import { allDocs } from './kb.js';
import { mergeExtraction, RELATION_TYPES } from './graph.js';
import { dayKey, zonedParts } from './time.js';

export const MAX_MESSAGES_PER_RUN = 60;
export const MAX_ITEMS_PER_RUN = 30;
export const MAX_DOCS_PER_RUN = 8;
export const MAX_MATERIAL_CHARS = 12000;
export const MAX_OUTPUT_TOKENS = 2000;

// 收到/发出的一条消息落库，当分析原料
export async function recordMessage(paths, message, options = {}) {
  const text = String(message?.text ?? '').trim();
  if (!text) return null;
  const at = message?.at ?? new Date().toISOString();
  return withDb(paths, { log: options.log }, (db) =>
    db
      .prepare('INSERT INTO messages (chat_id, role, text, at) VALUES (?, ?, ?, ?)')
      .run(message?.chatId ?? null, message?.role ?? 'user', text.slice(0, 4000), at),
  );
}

export async function pendingMessages(paths, options = {}) {
  const limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : MAX_MESSAGES_PER_RUN;
  return withDb(paths, { log: options.log }, (db) =>
    db
      .prepare('SELECT id, chat_id, role, text, at FROM messages WHERE analyzed_at IS NULL ORDER BY id ASC LIMIT ?')
      .all(limit),
  );
}

export async function countPending(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) =>
    Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE analyzed_at IS NULL').get()?.n ?? 0),
  );
}

async function markAnalyzed(paths, ids, at, options = {}) {
  if (!Array.isArray(ids) || !ids.length) return;
  await withDb(paths, { log: options.log }, (db) =>
    tx(db, () => {
      const stmt = db.prepare('UPDATE messages SET analyzed_at = ? WHERE id = ?');
      for (const id of ids) stmt.run(at, id);
    }),
  );
}

async function latestMessageAt(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) =>
    db.prepare('SELECT MAX(at) AS at FROM messages').get()?.at ?? null,
  );
}

async function openItems(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) =>
    db
      .prepare(
        "SELECT id, title, detail, status, tags, assignee FROM items WHERE status IN ('open','doing') ORDER BY updated_at DESC LIMIT ?",
      )
      .all(options.limit ?? MAX_ITEMS_PER_RUN),
  );
}

function safeJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

// 把一堆原料拼成一段给模型看的文字。每段都标了来源，方便它写 evidence。
// 顺带记下「哪几条消息真的进了这段文字」——只有它们能被标成已分析，
// 被预算截掉的消息要留到下次，不能当成看过了。
export function buildMaterialParts({ messages = [], items = [], docs = [] }, budget = MAX_MATERIAL_CHARS) {
  const head = [];
  const itemLines = [];
  const docLines = [];
  const picked = [];

  // 消息从最新的往里装，装不下就先丢最老的：截断时丢掉新消息最亏
  const reserve = 2000; // 留给工作项和笔记的位置
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const line = `- ${message.at ?? ''} ${message.role === 'assistant' ? '助理' : '用户'}：${String(message.text ?? '').slice(0, 400)}`;
    if (used + line.length + 1 > budget - reserve && picked.length) break;
    picked.push(line);
    used += line.length + 1;
  }
  picked.reverse();

  for (const item of items) {
    const bits = [`- ${item.title}`];
    if (item.detail) bits.push(`（${String(item.detail).slice(0, 200)}）`);
    const assignee = safeJson(item.assignee, null);
    if (assignee?.name) bits.push(`等 ${assignee.name}`);
    itemLines.push(bits.join(''));
  }
  for (const doc of docs) {
    docLines.push(`- 《${doc.title}》${doc.tags?.length ? `[${doc.tags.join('、')}]` : ''}`);
    docLines.push(`  ${String(doc.content ?? '').slice(0, 1500).replace(/\s+/g, ' ')}`);
  }

  const parts = [];
  let messageIds = [];
  const remaining = () => budget - parts.join('\n').length - 1;
  if (picked.length) {
    const block = ['【最近的聊天】', ...picked];
    if (block.join('\n').length <= remaining()) parts.push(...block);
    if (parts.includes('【最近的聊天】')) {
      // 只算真正进了 parts 的那些行
      const startIndex = parts.indexOf('【最近的聊天】') + 1;
      const kept = parts.slice(startIndex);
      messageIds = messages.filter((m) => kept.includes(`- ${m.at ?? ''} ${m.role === 'assistant' ? '助理' : '用户'}：${String(m.text ?? '').slice(0, 400)}`)).map((m) => m.id);
    }
  }
  if (itemLines.length) {
    const block = ['', '【手上的工作项】', ...itemLines];
    if (block.join('\n').length <= remaining()) parts.push(...block);
  }
  if (docLines.length) {
    const block = ['', '【知识库笔记】', ...docLines];
    if (block.join('\n').length <= remaining()) parts.push(...block);
  }
  const text = parts.join('\n');
  return { text: text.slice(0, budget), messageIds, chars: text.length };
}

export function buildMaterial(material, budget = MAX_MATERIAL_CHARS) {
  return buildMaterialParts(material, budget).text;
}

export function buildAnalysisPrompt(material, knownNames = []) {
  const known = knownNames.length ? `已经认识的人（不用重复输出，除非有新信息）：${knownNames.join('、')}` : '还没有认识的人。';
  return [
    '下面是用户最近的聊天、工作项和知识库笔记。请从中抽出「人」和他们之间的关系。',
    '',
    material,
    '',
    known,
    '',
    '规则：',
    '1. 只抽材料里确实出现过的人或称呼（真名、昵称、「张总」「广超」这种都算），不许编造。',
    `2. 关系类型只能从这个表里选：${Object.entries(RELATION_TYPES).map(([key, label]) => `${key}=${label}`).join('、')}。`,
    '3. 拿不准的关系别写，宁可少写；不确定的人 confidence 给低一点（0.3-0.5）。',
    '4. evidence 抄材料里的一句话，最多 60 字，用来以后核对。',
    '5. 判断关系按这个顺序想：被用户派活、被安排值班、被催着交东西的人 → subordinate（下属）；和用户一起被安排、平级协作、同组干活 → colleague（同事）；材料里写「客户」「甲方」→ client；写「领导」「上面」→ superior。',
    '6. 材料里并列出现的一串人名（值班名单、项目组成员、参会人），如果是在用户自己的工作场景里一起排班或分工，默认按 colleague 处理；如果是用户在安排他们干活，按 subordinate 处理。这一条是用来认人的，但只在材料确实把他们放在工作场景里时才用，别扩展到纯社交场合。',
    '7. 只输出 JSON，不要代码块，不要解释。格式：',
    '{"people":[{"name":"舒子淇","aliases":[],"kind":"person","note":"负责周五值班","confidence":0.8}],',
    ' "relations":[{"from":"舒子淇","to":"用户","type":"subordinate","note":"","evidence":"值班表：舒子淇、彭喻…","confidence":0.7}]}',
    '8. 如果材料里没有任何值得记的人，就输出 {"people":[],"relations":[]}。',
  ].join('\n');
}

// 模型有时候会包一层 ```json，或者前后带解释。抓第一个 { 到最后一个 } 再解析。
export function parseExtraction(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('模型没有返回内容');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    // 解析不出来就是这次分析失败：消息留着重跑，不能当「没什么人」记成功
    throw new Error('模型返回的不是 JSON，认不出人和关系');
  }
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('模型返回的 JSON 不完整，可能被截断了');
  }
  const people = [];
  for (const person of Array.isArray(data?.people) ? data.people : []) {
    const name = String(person?.name ?? '').trim();
    if (!name || name.length > 40) continue;
    people.push({
      name,
      aliases: Array.isArray(person?.aliases) ? person.aliases.map((x) => String(x).trim()).filter(Boolean).slice(0, 5) : [],
      kind: person?.kind === 'self' || person?.kind === 'org' ? person.kind : 'person',
      note: String(person?.note ?? '').trim().slice(0, 200),
      confidence: person?.confidence,
    });
  }
  const relations = [];
  for (const relation of Array.isArray(data?.relations) ? data.relations : []) {
    const from = String(relation?.from ?? '').trim();
    const to = String(relation?.to ?? '').trim();
    if (!from || !to || from === to) continue;
    const type = RELATION_TYPES[relation?.type] ? relation.type : 'other';
    relations.push({
      from,
      to,
      type,
      note: String(relation?.note ?? '').trim().slice(0, 200),
      evidence: String(relation?.evidence ?? '').trim().slice(0, 500),
      confidence: relation?.confidence,
    });
  }
  return { people: people.slice(0, 50), relations: relations.slice(0, 80) };
}

// 真正调用模型的默认实现。拿不到 llm 服务就抛出人话，让上层把这次标成失败。
function createCompletion(ctx, config, log) {
  return async function complete({ system, user }) {
    const llm = ctx?.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('宿主没提供 llm 服务，知识库分析跑不了');
    }
    const route = resolveRoute(ctx, config);
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      temperature: 0.2,
      maxTokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          id: `wa-analyze-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-work-assistant' },
        },
      ],
    });
    let text = '';
    let streamed = false;
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
        streamed = true;
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        // 只收正文块。reasoning 块也有 text，拼进来会把 JSON 弄脏。
        // 已经按 delta 收过正文的话就不再重复拼一遍。
        if (!streamed) text += chunk.block.text;
      } else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind === 'error') throw new Error(`模型调用失败：${chunk.reason?.error?.message ?? '未知原因'}`);
        // max-tokens 意味着输出被截断，JSON 多半残了：当失败，别把半份结果记成功
        if (kind === 'max-tokens') throw new Error('模型输出被截断（max-tokens），这次分析作废');
      }
    }
    if (!text.trim()) throw new Error('模型没有返回任何文字');
    return text;
  };
}

function resolveRoute(ctx, config) {
  const provider = typeof config?.analysisProvider === 'string' ? config.analysisProvider.trim() : '';
  const model = typeof config?.analysisModel === 'string' ? config.analysisModel.trim() : '';
  if (provider && model) return { provider, model };
  const current = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
  if (current?.provider && current?.model) return { provider: current.provider, model: current.model };
  throw new Error('没有可用的模型，先在设置里选好默认模型');
}

// 每天几点跑：返回 {hour, minute} 或 null
export function parseDailyTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function createAnalyzer(options = {}) {
  const ctx = options.ctx ?? null;
  const paths = options.paths;
  const config = options.config ?? {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const push = typeof options.notify === 'function' ? options.notify : async () => false;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const timeZone = options.timeZone ?? '';
  const complete = options.complete ?? createCompletion(ctx, config, log);

  let running = false;

  function enabled() {
    return config.analysisEnabled !== false;
  }

  // 今天这个「每日分析」跑过没有
  async function ranDailyToday(now) {
    const day = dayKey(now, timeZone);
    return withDb(paths, { log }, (db) => {
      const row = db
        .prepare("SELECT started_at FROM analysis_runs WHERE trigger = 'daily' AND status IN ('done', 'empty') ORDER BY id DESC LIMIT 1")
        .get();
      if (!row) return false;
      return dayKey(new Date(row.started_at), timeZone) === day;
    });
  }

  function dueDaily(now) {
    if (!enabled()) return false;
    const at = parseDailyTime(config.analysisDailyTime);
    if (!at) return false;
    const parts = zonedParts(now, timeZone);
    const minutes = parts.hour * 60 + parts.minute;
    return minutes >= at.hour * 60 + at.minute;
  }

  async function idleDue(now) {
    const minutes = Number(config.analysisIdleMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    const pending = await countPending(paths, { log });
    if (!pending) return false;
    const latest = await latestMessageAt(paths, { log });
    if (!latest) return false;
    const idleMs = now.getTime() - new Date(latest).getTime();
    return idleMs >= minutes * 60 * 1000;
  }

  async function collect() {
    // 只喂「还没分析过」的消息。没有新消息时就只用工作项和笔记，
    // 不拿旧消息充数 —— 否则每跑一次，里面每个人的 mentions 都白涨一次。
    // 取最新的 MAX_MESSAGES_PER_RUN 条（再按时间升序摆好），太老的留给下一轮
    const recent = await withDb(paths, { log }, (db) =>
      db
        .prepare('SELECT id, chat_id, role, text, at FROM messages WHERE analyzed_at IS NULL ORDER BY id DESC LIMIT ?')
        .all(MAX_MESSAGES_PER_RUN)
        .map((row) => ({ ...row })),
    );
    const messages = recent.reverse();
    const items = await openItems(paths, { log });
    const docs = await allDocs(paths, { log, limit: MAX_DOCS_PER_RUN, maxChars: 1500 });
    return { messages, items, docs };
  }

  async function knownNames() {
    return withDb(paths, { log }, (db) =>
      db.prepare('SELECT name FROM entities ORDER BY mentions DESC LIMIT 40').all().map((row) => row.name),
    );
  }

  async function run(trigger = 'manual') {
    if (running) return { ok: false, reason: 'busy' };
    running = true;
    const startedAt = clock().toISOString();
    let runId = null;
    try {
      const noNews = await withDb(paths, { log }, (db) => {
        const pending = Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE analyzed_at IS NULL').get()?.n ?? 0);
        const known = Number(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind != 'self'").get()?.n ?? 0);
        return pending === 0 && known > 0;
      });
      if (noNews) {
        return { ok: true, people: 0, relations: 0, messages: 0, skipped: 'no-news' };
      }
      runId = await withDb(paths, { log }, (db) =>
        Number(
          db
            .prepare("INSERT INTO analysis_runs (started_at, status, trigger) VALUES (?, 'running', ?)")
            .run(startedAt, trigger).lastInsertRowid,
        ),
      );
      const material = await collect();
      const builtParts = buildMaterialParts(material);
      const built = builtParts.text;
      if (!built.trim()) {
        await finishRun(runId, { status: 'empty', startedAt });
        return { ok: true, people: 0, relations: 0, messages: 0 };
      }
      const prompt = buildAnalysisPrompt(built, await knownNames());
      const answer = await complete({ system: ANALYSIS_SYSTEM, user: prompt });
      const extraction = parseExtraction(answer);
      const merged = await mergeExtraction(paths, extraction, { now: clock(), log });
      // 只标真正喂进去的消息；被预算截掉的留到下一轮，不能假装看过
      const analyzed = builtParts.messageIds;
      await markAnalyzed(paths, analyzed, clock().toISOString(), { log });
      await finishRun(runId, {
        status: 'done',
        startedAt,
        messages: analyzed.length,
        entities: merged.addedPeople,
        relations: merged.addedRelations,
      });
      if (merged.addedPeople > 0) {
        const names = extraction.people.slice(0, 5).map((p) => p.name).join('、');
        await push(`知识库又认了几个人：${names}${merged.addedPeople > 5 ? ' 等' : ''}。`).catch(() => {});
      }
      log(
        `analysis: ${trigger} 跑完了，${analyzed.length} 条消息，新增 ${merged.addedPeople} 人 / ${merged.addedRelations} 条关系`,
      );
      return { ok: true, people: merged.addedPeople, relations: merged.addedRelations, messages: analyzed.length };
    } catch (err) {
      log(`analysis: ${trigger} 失败 ${err?.message ?? err}`);
      if (runId) await finishRun(runId, { status: 'failed', startedAt, error: String(err?.message ?? err) }).catch(() => {});
      return { ok: false, reason: String(err?.message ?? err) };
    } finally {
      running = false;
    }
  }

  async function finishRun(runId, patch) {
    if (!runId) return;
    await withDb(paths, { log }, (db) =>
      db
        .prepare(
          "UPDATE analysis_runs SET finished_at = ?, status = ?, messages = ?, entities = ?, relations = ?, error = ? WHERE id = ?",
        )
        .run(
          clock().toISOString(),
          patch.status,
          Number(patch.messages ?? 0),
          Number(patch.entities ?? 0),
          Number(patch.relations ?? 0),
          patch.error ?? null,
          runId,
        ),
    );
  }

  // 宿主被关掉时留下 status='running' 的行，会让当天 daily 永远不再跑。
  // 超过 30 分钟还挂着的，按失败处理。
  async function reapStaleRuns(now) {
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    await withDb(paths, { log }, (db) =>
      db
        .prepare(
          "UPDATE analysis_runs SET status = 'failed', finished_at = ?, error = COALESCE(error, '分析中断了（可能宿主被关掉）') WHERE status = 'running' AND started_at < ?",
        )
        .run(now.toISOString(), cutoff),
    );
  }

  // 失败之后别每 60 秒重试一次：1、2、4…最多 60 分钟退避
  async function backoffUntil(now) {
    return withDb(paths, { log }, (db) => {
      const row = db
        .prepare("SELECT started_at, COUNT(*) AS n FROM analysis_runs WHERE status = 'failed' GROUP BY status ORDER BY id DESC LIMIT 1")
        .get();
      if (!row?.started_at) return null;
      const failures = Number(row.n ?? 0);
      const delay = Math.min(60, 2 ** Math.max(0, Math.min(failures - 1, 6))) * 60 * 1000;
      return new Date(new Date(row.started_at).getTime() + delay);
    });
  }

  // ticker 每秒/每分钟叫一次：先看每日，再看闲时。都跑不起来就什么都不做。
  async function tick() {
    if (!enabled() || running) return null;
    const now = clock();
    await reapStaleRuns(now).catch((err) => log(`analysis: 收拾中断的分析失败 ${err?.message ?? err}`));
    const waitUntil = await backoffUntil(now).catch(() => null);
    if (waitUntil && now < waitUntil) return null;
    if (dueDaily(now) && !(await ranDailyToday(now))) return run('daily');
    if (await idleDue(now)) return run('idle');
    return null;
  }

  async function status() {
    return withDb(paths, { log }, (db) => {
      const last = db.prepare('SELECT * FROM analysis_runs ORDER BY id DESC LIMIT 1').get();
      const pending = Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE analyzed_at IS NULL').get()?.n ?? 0);
      // 「用户」是关系里的另一端，不算「认识的人」，跟名单口径保持一致
      const people = Number(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind != 'self'").get()?.n ?? 0);
      const relations = Number(db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n ?? 0);
      return {
        enabled: enabled(),
        running,
        pending,
        people,
        relations,
        lastRun: last
          ? {
              at: last.started_at,
              finishedAt: last.finished_at,
              status: last.status,
              trigger: last.trigger,
              messages: Number(last.messages ?? 0),
              entities: Number(last.entities ?? 0),
              relations: Number(last.relations ?? 0),
              error: last.error ?? null,
            }
          : null,
      };
    });
  }

  return { run, tick, status, dueDaily, idleDue, collect, enabled: () => enabled() };
}

const ANALYSIS_SYSTEM = [
  '你在帮用户整理他的工作知识库。',
  '你只做一件事：从材料里读出「有哪些人」和「他们跟用户是什么关系」。',
  '宁可漏掉，也不要猜错。材料里没写过的话，一个字都不要编。',
  '输出必须是严格 JSON。',
].join('\n');
