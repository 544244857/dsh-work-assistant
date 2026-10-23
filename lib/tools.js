import {
  PRIORITY_LABEL,
  addItem,
  describeRecurrence,
  digest,
  findDuplicate,
  findItem,
  listItems,
  renderDigest,
  renderItemList,
  renderWeeklyReview,
  updateItem,
  urgencyOf,
  weeklyReview,
} from './ledger.js';
import { listDocs, readDoc, search, writeDoc } from './kb.js';
import { addDays, formatInstant, parseInstant, resolveZone } from './time.js';
import { controlTools } from './assignment-tools.js';
import { queryPeople, queryPerson, renderPeopleList, renderPersonCard } from './graph.js';
import { definition, text } from './tool-kit.js';

// 工具定义的最小公共件在 ./tool-kit.js，控制面工具和副手工具共用同一套写法。

const OPTIONAL_STR = { type: 'string' };

export function createTools(deps) {
  const { store, paths, notify, sendFile, timeZone, sessionId, log, assignments } = deps;
  const zone = resolveZone(timeZone);
  const kbLog = typeof log === 'function' ? log : () => {};

  const tools = [];

  tools.push(definition({
    name: 'work_capture',
    description: '把一条消息里的工作记进账本。只在确实有“要做的事”时调用；寒暄、通知、已完成的事不要记。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话说清要做什么，动词开头，20 字以内' },
        detail: { type: 'string', description: '补充细节：要求、背景、验收标准' },
        dueAt: { type: 'string', description: '期限，写 2026-10-24 18:00 或 2026-10-24；说不清就留空' },
        remindAt: { type: 'string', description: '提醒时间，格式同上；留空则按期限提前一小时自动设' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '一般不用填，留空就按措辞和期限自动判；只有你确定自动判得不对时才显式指定',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 财务、合同、汇报' },
        actionable: { type: 'boolean', description: '这件事你是否能直接代做（查资料、改表格、写文档）' },
        suggestedAction: { type: 'string', description: '可代做时，具体打算怎么做' },
        sourceText: { type: 'string', description: '原始消息里最关键的一两句，便于回溯' },
        recurrence: {
          type: 'object',
          description: '重复任务，如每周一交周报。做完会自动生成下一次',
          properties: {
            kind: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: '每天/每周/每月' },
            every: { type: 'integer', description: '每隔几个周期，默认 1' },
            weekdays: {
              type: 'array',
              items: { type: 'integer' },
              description: '每周几，1 是周一、7 是周日；kind=weekly 时用',
            },
          },
        },
      },
      required: ['title'],
    },
    output: {
      id: OPTIONAL_STR,
      openCount: { type: 'integer' },
    },
    async execute(args) {
      const now = new Date();
      const result = await store.mutate((ledger) => {
        // 同一个标题的活儿重复记进来（模型重试、用户重发）时不再新增一条，
        // 只把这次带来的新信息补到旧条目上，否则账本会越用越乱。
        const dup = findDuplicate(ledger, args.title);
        if (dup) {
          const patch = {};
          if (!dup.dueAt && args.dueAt) patch.dueAt = args.dueAt;
          if (dup.priority === 'normal' && args.priority) patch.priority = args.priority;
          if (!dup.detail && args.detail) patch.detail = args.detail;
          if (args.tags?.length) patch.tags = [...new Set([...dup.tags, ...args.tags])];
          if (Object.keys(patch).length) updateItem(ledger, dup.id, patch, now, zone);
          const open = ledger.items.filter((i) => i.status === 'open' || i.status === 'doing').length;
          return { item: findItem(ledger, dup.id), open, duplicate: true, merged: Object.keys(patch) };
        }

        const { item } = addItem(ledger, {
          ...args,
          source: args.sourceText
            ? { sessionId, text: String(args.sourceText).slice(0, 500), at: now.toISOString() }
            : { sessionId, at: now.toISOString() },
        }, now, zone);
        const open = ledger.items.filter((i) => i.status === 'open' || i.status === 'doing').length;
        return { item, open, duplicate: false, merged: [] };
      });

      const item = result.item;
      const rank = await store.read((ledger) => {
        const open = ledger.items.filter((i) => i.status === 'open' || i.status === 'doing');
        const sorted = [...open].sort((a, b) => urgencyOf(b, now) - urgencyOf(a, now));
        return sorted.findIndex((i) => i.id === item.id) + 1;
      });

      const bits = [];
      if (result.duplicate) {
        bits.push(`这条已经记过了：${item.id}「${item.title}」，没有重复记`);
        if (result.merged.length) bits.push(`把这次的新信息补上去了（${result.merged.join('/')}）`);
      } else {
        bits.push(`记下了 ${item.id}：${item.title}`);
      }
      if (item.dueAt) bits.push(`期限 ${formatInstant(item.dueAt, zone)}`);
      bits.push(`优先级 ${PRIORITY_LABEL[item.priority] ?? '普通'}`);
      if (item.recurrence) {
        const repeat = describeRecurrence(item.recurrence);
        if (repeat) bits.push(repeat);
      }
      if (item.tags.length) bits.push(`标签 ${item.tags.join('/')}`);
      bits.push(`现在手上共 ${result.open} 件未完成`);
      if (rank > 0) bits.push(`按紧急度排第 ${rank} 位`);
      return text(bits.join('，'), {
        id: item.id,
        openCount: result.open,
        dueAt: item.dueAt,
        duplicate: result.duplicate,
        rank,
      });
    },
  }));

  tools.push(definition({
    name: 'work_list',
    description: '列出工作项，已按紧急度排好（最该先做的在前）。被问到“有哪些活”“哪几件最急”时必须调用它，把真实条目念出来。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'doing', 'done', 'dropped', 'all'], description: '默认 open' },
        dueWithinDays: { type: 'number', description: '只看这么多天内到期的' },
        tag: { type: 'string', description: '按标签过滤' },
        query: { type: 'string', description: '关键词搜索，标题、细节、标签都会匹配' },
        assignee: { type: 'string', description: '只看挂在某个人手上的' },
        limit: { type: 'integer', description: '最多返回几条，默认 20' },
      },
    },
    output: { total: { type: 'integer' }, items: { type: 'array', items: { type: 'object' } } },
    async execute(args) {
      const now = new Date();
      const result = await store.read((ledger) => listItems(ledger, args, now, zone));
      return text(renderItemList(result, { timeZone: zone }), result);
    },
  }));

  tools.push(definition({
    name: 'work_update',
    description: '改一条工作项：改状态、改期限、补细节、加备注。也可以把 offerState 设成 accepted 表示“我接了”。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作项 id，形如 w-20261020-001' },
        status: { type: 'string', enum: ['open', 'doing', 'done', 'dropped'] },
        title: { type: 'string' },
        detail: { type: 'string' },
        dueAt: { type: 'string' },
        remindAt: { type: 'string', description: '传空字符串表示取消提醒' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        tags: { type: 'array', items: { type: 'string' } },
        actionable: { type: 'boolean' },
        suggestedAction: { type: 'string' },
        offerState: { type: 'string', enum: ['none', 'offered', 'accepted', 'declined'] },
        note: { type: 'string', description: '追加一条带时间戳的备注' },
      },
      required: ['id'],
    },
    output: { id: OPTIONAL_STR, status: OPTIONAL_STR },
    async execute(args) {
      const now = new Date();
      const result = await store.mutate((ledger) => updateItem(ledger, args.id, args, now, zone));
      const item = result.item;
      const bits = [`${item.id} 已更新：${item.title}`];
      bits.push(`状态 ${item.status}`);
      if (item.dueAt) bits.push(`期限 ${formatInstant(item.dueAt, zone)}`);
      // 重复任务做完会自动排下一次，得告诉用户，不然他以为这事儿没了
      if (result.spawned) {
        bits.push(`下一次已经排好了：${result.spawned.id}，${formatInstant(result.spawned.dueAt, zone)}`);
      }
      return text(bits.join('，'), {
        id: item.id,
        status: item.status,
        dueAt: item.dueAt,
        nextId: result.spawned?.id ?? null,
      });
    },
  }));

  tools.push(definition({
    name: 'work_snooze',
    description: '把一条工作项的提醒往后推一段时间。用户说“待会儿再说”“晚点提醒我”“明天再提”时用它。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作项 id' },
        minutes: { type: 'integer', description: '往后推多少分钟，比如 30、120；说“明天”就传 1440' },
      },
      required: ['id', 'minutes'],
    },
    output: { id: OPTIONAL_STR, remindAt: OPTIONAL_STR },
    async execute(args) {
      const now = new Date();
      const minutes = Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes 要是正数');
      const item = await store.mutate(
        (ledger) => updateItem(ledger, args.id, { snoozeMinutes: minutes }, now, zone).item,
      );
      return text(
        `${item.id}「${item.title}」的提醒推到 ${formatInstant(item.remindAt, zone)}。`,
        { id: item.id, remindAt: item.remindAt },
      );
    },
  }));

  tools.push(definition({
    name: 'work_digest',
    description: '看当前未完成工作的整体情况：逾期、今天到期、本周内、可代做的各有几件。',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: '返回文本的长度上限，默认 1200' },
      },
    },
    output: { open: { type: 'integer' }, overdue: { type: 'integer' }, today: { type: 'integer' } },
    async execute(args) {
      const now = new Date();
      const data = await store.read((ledger) => digest(ledger, now, zone));
      const maxChars = Number.isFinite(args.maxChars) ? Math.max(200, Math.floor(args.maxChars)) : 1200;
      const summary = renderDigest(data, { timeZone: zone, maxChars });
      return text(summary, {
        open: data.counts.open,
        overdue: data.counts.overdue,
        today: data.counts.today,
      });
    },
  }));

  tools.push(definition({
    name: 'kb_write',
    description: '把值得长期记住的东西写进工作知识库：流程、口径、人名对应、做过的方案要点。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        content: { type: 'string', description: '正文，Markdown' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
    output: { id: OPTIONAL_STR, bytes: { type: 'integer' } },
    async execute(args) {
      const now = new Date();
      const result = await writeDoc(paths, { ...args, source: sessionId }, now, zone, kbLog);
      return text(`已存进知识库：${result.id} ${result.title}`, result);
    },
  }));

  tools.push(definition({
    name: 'kb_search',
    description: '在工作知识库里按关键词或标签搜，返回命中片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词；留空则按标签或时间列最近的' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', description: '默认 8' },
      },
    },
    output: { hits: { type: 'array', items: { type: 'object' } } },
    async execute(args) {
      const hits = await search(paths, args.query ?? '', { tags: args.tags, limit: args.limit ?? 8, log: kbLog });
      if (!hits.length) return text('知识库里没搜到相关内容。', { hits: [] });
      const lines = hits.map((hit, i) => {
        const head = `${i + 1}. ${hit.id} ${hit.title}`;
        return hit.snippet ? `${head}\n   ${hit.snippet}` : head;
      });
      return text(`搜到 ${hits.length} 篇：\n${lines.join('\n')}`, { hits });
    },
  }));

  tools.push(definition({
    name: 'kb_read',
    description: '读出知识库里某篇文档的全文。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '文档 id，形如 k-20261020-001' } },
      required: ['id'],
    },
    output: { id: OPTIONAL_STR, content: OPTIONAL_STR },
    async execute(args) {
      const doc = await readDoc(paths, args.id, kbLog);
      if (!doc) throw new Error(`知识库里没有 ${args.id}`);
      return text(doc.content, doc);
    },
  }));

  tools.push(definition({
    name: 'kb_list',
    description: '列出知识库最近更新的文档。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 20' } },
    },
    output: { total: { type: 'integer' }, docs: { type: 'array', items: { type: 'object' } } },
    async execute(args) {
      const result = await listDocs(paths, { limit: args.limit ?? 20, log: kbLog });
      if (!result.docs.length) return text('知识库还是空的。', result);
      const lines = result.docs.map((doc, i) => `${i + 1}. ${doc.id} ${doc.title}${doc.tags.length ? ` [${doc.tags.join('/')}]` : ''}`);
      return text(`共 ${result.total} 篇，最近 ${result.docs.length} 篇：\n${lines.join('\n')}`, result);
    },
  }));

  tools.push(definition({
    name: 'work_notify',
    description: '主动给用户推一条微信消息。用于干完活汇报、发现风险提前打招呼、或者异步进度更新。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要推的内容，简洁为主' },
      },
      required: ['text'],
    },
    output: { delivered: { type: 'boolean' } },
    async execute(args) {
      const body = typeof args.text === 'string' ? args.text.trim() : '';
      if (!body) throw new Error('text 不能为空');
      if (typeof notify !== 'function') return text('当前没有可用的推送通道，消息没发出去。', { delivered: false });
      const res = await notify(body);
      const delivered = res !== false;
      return text(delivered ? '已推送到微信。' : '推送通道当前不可用（未登录或不在线），消息没发出去。', { delivered });
    },
  }));

  tools.push(definition({
    name: 'work_review',
    description: '看最近这一周的情况：做完了什么、还剩什么、哪些拖了一周没动。用户问「这周怎么样」「帮我复盘一下」时用它。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '看最近几天，默认 7' },
      },
    },
    output: { done: { type: 'integer' }, open: { type: 'integer' }, overdue: { type: 'integer' } },
    async execute(args) {
      const now = new Date();
      const days = Number.isFinite(Number(args.days)) && Number(args.days) > 0 ? Math.floor(Number(args.days)) : 7;
      const data = await store.read((ledger) => weeklyReview(ledger, now, zone, days));
      return text(renderWeeklyReview(data, { timeZone: zone }), data.counts);
    },
  }));

  tools.push(definition({
    name: 'work_send_file',
    description: '把本机上的一个文件发到微信：图片、视频或任意文档都行。这是微信里唯一能把文件真正送到他手机上的办法，别的工具都送不到。发成功返回 delivered: true。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        caption: { type: 'string', description: '随文件一起发的一句话说明，可留空' },
      },
      required: ['path'],
    },
    output: { delivered: { type: 'boolean' }, kind: OPTIONAL_STR, name: OPTIONAL_STR, bytes: { type: 'integer' } },
    async execute(args) {
      const filePath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!filePath) throw new Error('path 不能为空');
      if (typeof sendFile !== 'function') {
        return text('当前没有可用的发送通道，文件没发出去。', { delivered: false });
      }
      try {
        const sent = await sendFile(filePath, args.caption ?? '');
        return text(`已把 ${sent.name} 发到微信（${Math.round(sent.bytes / 1024)} KB）。`, { delivered: true, ...sent });
      } catch (err) {
        const reason = err?.message ?? String(err);
        return text(`文件没发出去：${reason}`, { delivered: false });
      }
    },
  }));

  tools.push(definition({
    name: 'work_attach',
    description: '把本机上的一个文件挂到某条工作项上，方便以后找。只记路径，不复制文件内容。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作项 id' },
        path: { type: 'string', description: '文件的绝对路径' },
        name: { type: 'string', description: '显示名，留空就用文件名' },
      },
      required: ['id', 'path'],
    },
    output: { id: OPTIONAL_STR, attached: { type: 'integer' } },
    async execute(args) {
      const filePath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!filePath) throw new Error('path 不能为空');
      const now = new Date();
      const item = await store.mutate((ledger) => {
        const found = findItem(ledger, args.id);
        if (!found) throw new Error(`找不到工作项 ${args.id}`);
        const next = [...(found.attachments ?? []), { name: args.name, path: filePath, addedAt: now.toISOString() }];
        return updateItem(ledger, args.id, { attachments: next }, now, zone).item;
      });
      return text(
        `${item.id}「${item.title}」挂上了 ${item.attachments.length} 个文件。`,
        { id: item.id, attached: item.attachments.length },
      );
    },
  }));

  tools.push(definition({
    name: 'work_assign',
    description: '把一条工作项记到别人名下，并约好隔几天去问一句。用来追别人该做的事，不是给自己排活。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作项 id' },
        to: { type: 'string', description: '交给谁，写名字' },
        verifyAt: { type: 'string', description: '什么时候去问一句，格式像 2026-10-24 18:00；留空就按 everyDays 算' },
        everyDays: { type: 'integer', description: '隔几天问一次，默认 3 天' },
      },
      required: ['id', 'to'],
    },
    output: { id: OPTIONAL_STR, assignee: OPTIONAL_STR, verifyAt: OPTIONAL_STR },
    async execute(args) {
      const to = typeof args.to === 'string' ? args.to.trim() : '';
      if (!to) throw new Error('to 不能为空');
      const now = new Date();
      const everyDays = Number.isFinite(Number(args.everyDays)) && Number(args.everyDays) > 0
        ? Math.floor(Number(args.everyDays))
        : 3;
      // verifyAt 一律落成具体时刻。解析不了就报错让模型换个写法，
      // 静默回落到默认值会让用户以为约好了某个时间，实际约的是另一个。
      let verifyAt;
      if (args.verifyAt) {
        verifyAt = parseInstant(args.verifyAt, zone);
        if (!verifyAt) throw new Error('verifyAt 认不出来，写法像 2026-10-24 18:00');
      } else {
        verifyAt = addDays(now.toISOString(), everyDays);
      }
      const item = await store.mutate((ledger) => {
        const assignee = { name: to, at: now.toISOString(), verifyAt, everyDays, chaseCount: 0 };
        return updateItem(ledger, args.id, { assignee }, now, zone).item;
      });
      const bits = [`${item.id}「${item.title}」记到 ${to} 名下了`];
      // 一定要回一个确切时刻：只写「每 3 天」用户没法判断到底哪天会响。
      bits.push(`${formatInstant(item.assignee.verifyAt, zone)} 我会提醒你去问一句`);
      return text(bits.join('，'), { id: item.id, assignee: to, verifyAt: item.assignee.verifyAt });
    },
  }));

  // 知识图谱：问「值班的是谁」「广超是谁」这类问题时，念真实结构，别靠记忆瞎猜。
  tools.push(definition({
    name: 'work_people',
    description: '列出知识库里已经认出来的人（按提及次数排）。用户问「都有谁」「我手底下有几个人」时用它。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多列几个，默认 20' },
      },
    },
    output: { total: { type: 'integer' } },
    async execute(args) {
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20;
      const data = await queryPeople(paths, { limit, log: kbLog });
      return text(renderPeopleList(data, { maxChars: 1200 }), { total: data.total });
    },
  }));

  tools.push(definition({
    name: 'work_person',
    description: '查一个人的档案：他怎么称呼、跟用户是什么关系、在哪件事里出现过。用户提到某个具体的人时用它。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '人名或称呼，比如 舒子淇、广超、张总' },
      },
      required: ['name'],
    },
    output: { name: OPTIONAL_STR, relations: { type: 'integer' } },
    async execute(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) throw new Error('name 不能为空');
      const data = await queryPerson(paths, name, { log: kbLog });
      if (!data) return text(`知识库里还没有「${name}」这个人。等我多听几条消息、多看几篇笔记应该能认出来。`, { relations: 0 });
      return text(renderPersonCard(data, { maxChars: 1200 }), { name: data.entity.name, relations: data.relations.length });
    },
  }));

  // 副手（分派）的 6 个控制面工具。只有控制面拿得到 —— 副手自己那份由
  // assignment-runtime 单独注册，里面只有 assign_report。
  if (assignments) {
    tools.push(
      ...controlTools({
        runtime: assignments,
        store,
        timeZone,
        now: typeof deps.now === 'function' ? deps.now : () => new Date(),
        markItemAssignment: deps.markItemAssignment,
        log,
      }),
    );
  }

  return tools;
}

export { findItem };