// 副手相关的 7 个工具：6 个给控制面（wa:main），1 个给副手自己。
// 拆成两个导出，是因为它们的作用域完全不同 —— 副手绝不能拿到 assign_create，
// 否则它会自己再开副手，一层套一层就失控了。

import {
  renderAssignmentDetail,
  renderAssignmentList,
} from './assignments.js';
import { definition, text } from './tool-kit.js';

const OPTIONAL_STR = { type: 'string' };

// 默认等 60 秒而不是顶格 120 秒：等的时候 wa:main 这个控制面是阻塞的，
// 用户这会儿再发消息就得排队。宁可让模型等一会儿就回来接着陪聊，
// 让模型自己按需把 timeoutMs 调大。
const WAIT_DEFAULT_MS = 60000;
const WAIT_MIN_MS = 1;
const WAIT_MAX_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function clampWait(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.floor(n)));
}

// 把上限错误翻成人话。模型看到「副手已经开满了」才知道该怎么回用户，
// 看到 ASSIGN_LIMIT_REACHED 这种代码只会照念一遍。
function explain(err) {
  if (err?.code === 'ASSIGN_LIMIT_REACHED') {
    return new Error(`${err.message}。要腾位置就先用 assign_stop 停掉一个。`);
  }
  return err;
}

export function controlTools(deps = {}) {
  const runtime = deps.runtime;
  const clock = typeof deps.now === 'function' ? deps.now : () => new Date();
  const markItemAssignment =
    typeof deps.markItemAssignment === 'function' ? deps.markItemAssignment : null;
  const tools = [];

  tools.push(definition({
    name: 'assign_create',
    description:
      '开一个副手（独立会话）去干一件要花很久的活。写代码、整理文件、查一堆资料、做表格这类都该派出去，自己只负责记事和回话。',
    parameters: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: '一句话说清这条线在干什么，副手会拿它当任务说明' },
        itemId: { type: 'string', description: '关联的工作项 id，如 w-20261021-003；有就填' },
        cwd: { type: 'string', description: '副手的工作目录，留空就用默认工作区' },
        model: { type: 'string', description: '指定模型，写 provider/model 或只写 model；留空跟宿主默认' },
        preset: { type: 'string', description: 'agent 预设，默认 standard（有完整工具）' },
      },
      required: ['purpose'],
    },
    output: { id: OPTIONAL_STR, sessionId: OPTIONAL_STR, status: OPTIONAL_STR },
    async execute(args) {
      let created;
      try {
        created = await runtime.create({
          purpose: args.purpose,
          itemId: args.itemId,
          cwd: args.cwd,
          model: args.model,
          preset: args.preset,
        });
      } catch (err) {
        throw explain(err);
      }
      const assignment = created.assignment;
      if (assignment.itemId && markItemAssignment) {
        try {
          await markItemAssignment(assignment.itemId, assignment.id);
        } catch (err) {
          deps.log?.(`assign_create: 回写工作项失败 ${err?.message ?? err}`);
        }
      }
      const bits = [`派活了：${assignment.id}（${assignment.purpose}）`];
      // 说清它已经动起来了：create 里补了一次 followup，副手不会躺着等人催
      bits.push('已经开工了');
      bits.push(`会话 ${assignment.sessionId}，在侧栏会话列表里能看到`);
      if (assignment.itemId) bits.push(`已经挂到 ${assignment.itemId} 上`);
      return text(bits.join('，'), {
        id: assignment.id,
        sessionId: assignment.sessionId,
        status: assignment.status,
      });
    },
  }));

  tools.push(definition({
    name: 'assign_list',
    description: '看现在有哪些副手、各自在干什么、最新报告是什么。用户问「那个副手怎么样了」时先看这个。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'idle', 'running', 'waiting', 'done', 'stopped', 'offline'],
          description: '默认 active（还没结束的）',
        },
        maxChars: { type: 'integer', description: '返回文本长度上限，默认 1200' },
      },
    },
    output: { total: { type: 'integer' }, active: { type: 'integer' } },
    async execute(args) {
      const filter = { status: args.status || 'active' };
      const result = await runtime.list(filter);
      const maxChars = Number.isFinite(args.maxChars) ? Math.max(200, Math.floor(args.maxChars)) : 1200;
      let summary = renderAssignmentList(result, { maxChars });
      const active = await runtime.activeCount();
      // 失联的副手不占名额，默认视图里不列。但它们没消失，
      // 一句不提会让模型如实回「现在没有副手」，用户以为活丢了。
      // 只有默认视图才补这句：显式指定 status 的人已经知道自己要看什么。
      if (!args.status) {
        const all = await runtime.list({ status: 'all' });
        const offline = (all.items ?? []).filter((item) => item.status === 'offline').length;
        if (offline) summary += `\n另外有 ${offline} 个失联的副手（插件重启后没恢复过来），用 status=all 能看到。`;
      }
      return text(summary, { total: result.total, active });
    },
  }));

  tools.push(definition({
    name: 'assign_inspect',
    description: '看某个副手的详情：在干什么、交了什么报告、最近几步在忙什么。只取最后几步，不会把整个日志倒出来。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '副手 id，形如 a-20261021-001' },
        maxChars: { type: 'integer', description: '返回文本长度上限，默认 1200' },
      },
      required: ['id'],
    },
    output: { id: OPTIONAL_STR, status: OPTIONAL_STR },
    async execute(args) {
      const { assignment, tail } = await runtime.inspect(args.id);
      const maxChars = Number.isFinite(args.maxChars) ? Math.max(200, Math.floor(args.maxChars)) : 1200;
      const summary = renderAssignmentDetail(assignment, { tail, maxChars });
      return text(summary, { id: assignment.id, status: assignment.status, sessionId: assignment.sessionId });
    },
  }));

  tools.push(definition({
    name: 'assign_send',
    description:
      '给副手发一句话。默认当成新的一轮（会唤醒它）；想只补背景不想让它立刻动，用 context-update。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '副手 id' },
        message: { type: 'string', description: '要跟它说的话' },
        mode: {
          type: 'string',
          enum: ['context-update', 'next-step', 'next-turn'],
          description: 'context-update=只补背景不唤醒，next-step=下一步就看见，next-turn=当新的一轮（默认）',
        },
      },
      required: ['id', 'message'],
    },
    output: { id: OPTIONAL_STR, mode: OPTIONAL_STR },
    async execute(args) {
      const mode = args.mode || 'next-turn';
      try {
        const result = await runtime.send(args.id, args.message, mode);
        return text(`话已经带到了：${args.id}（${mode}）。`, { id: args.id, mode: result.mode });
      } catch (err) {
        // 投递失败不自动重试：宿主没有幂等键，重试可能让副手收到两遍。
        // 也不能一律说「它正忙」—— 停掉的副手、找不到的副手都会被说成在忙，
        // 模型会照着这句瞎猜，还可能反复重试。原样把原因端出去。
        throw new Error(`消息没送到：${err?.message ?? err}`);
      }
    },
  }));

  tools.push(definition({
    name: 'assign_stop',
    description: '停掉一个副手，把它的会话释放掉。它手上的活就不做了。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '副手 id' },
        reason: { type: 'string', description: '为什么停，留个记录' },
      },
      required: ['id'],
    },
    output: {
      id: OPTIONAL_STR,
      status: OPTIONAL_STR,
      released: { type: 'boolean' },
      // 回执文案里区分了「会话还留着」和「本来就没跑」，字段也要声明出来，
      // 否则结构化结果和说给人听的话对不上。
      sessionActive: { type: 'boolean' },
    },
    async execute(args) {
      const { assignment, released, sessionActive } = await runtime.stop(args.id, args.reason || '');
      // 三种情况不能都说成「已停掉」：用户去会话列表里看，说法对不上就不信你了。
      // released=true → 会话是我们开的，已经彻底释放
      // released=false + sessionActive → 会话先前就开着，宿主不给释放接口，只叫停了，还留在列表里
      // 都不是 → 本来就没在跑，只是把登记改了
      let tail = '';
      if (!released && sessionActive) {
        tail = '这个会话是之前就开着的，我只叫停了它，会话本身还留在列表里，你可以自己关掉。';
      } else if (!released) {
        tail = '它本来就没在跑，登记已经改成停掉了。';
      }
      return text(`已停掉 ${assignment.id}（${assignment.purpose}）。${tail}`, {
        id: assignment.id,
        status: assignment.status,
        released,
        sessionActive,
      });
    },
  }));

  tools.push(definition({
    name: 'assign_wait',
    description:
      '等一个副手交报告或者停下来，最多等两分钟。等到就返回报告，没等到就返回它现在的状态 —— 不要反复调它来刷。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '副手 id' },
        timeoutMs: { type: 'integer', description: '最多等多久（毫秒），默认 60000，最大 120000' },
      },
      required: ['id'],
    },
    output: { outcome: OPTIONAL_STR, id: OPTIONAL_STR },
    async execute(args) {
      const timeoutMs = clampWait(args.timeoutMs);
      const before = await runtime.get(args.id);
      if (!before) throw new Error(`找不到副手 ${args.id}`);
      const beforeAt = before.report?.at ?? null;
      // 它已经交过报告、而且不在干了：这份报告就是答案，不用等
      const settled = ['done', 'waiting', 'stopped'].includes(before.status);
      // 已经收尾又没有报告的，等下去也不会变出报告来，直接说清楚
      const deadEnd = !beforeAt && ['done', 'stopped'].includes(before.status);
      const deadline = Date.now() + timeoutMs;

      let current = before;
      while (!deadEnd && !(settled && beforeAt) && Date.now() < deadline) {
        await sleep(500);
        current = (await runtime.get(args.id)) ?? current;
        const at = current?.report?.at ?? null;
        if (at && at !== beforeAt) break;
        if (current?.status === 'done' || current?.status === 'waiting' || current?.status === 'stopped') break;
        if (current?.status === 'offline') break;
      }

      const at = current?.report?.at ?? null;
      // 只有这一轮新交的报告才算答案：用户补了新活之后，上一份报告已经不是这次的结果了
      const fresh = Boolean(at) && (at !== beforeAt || (settled && Boolean(beforeAt)));
      // 等待期间被停掉、或者自己收尾了，都不能说成「还在干」
      const finished = current?.status === 'done' || current?.status === 'stopped';
      const outcome = fresh
        ? 'report'
        : current?.status === 'offline'
          ? 'offline'
          : deadEnd || finished
            ? 'settled'
            : 'timeout';
      const lines = [];
      if (outcome === 'report') {
        lines.push(`${current.id} 交报告了：${current.report.summary}`);
        if (current.report.detail) lines.push(`细节：${current.report.detail}`);
        // 报告是它被叫停之前就在路上的，那这份「等你回话」已经回不了了：
        // 说「用 assign_send 回它」只会让模型去撞一个必然被拒的调用。
        if (current.status === 'stopped') {
          lines.push('不过它已经被停掉了，这份报告是停之前交的，回不了话；要接着干就重新派一个。');
        } else if (current.report.expectsReply) {
          lines.push('它在等你回话，用 assign_send 回它。');
        }
      } else if (outcome === 'offline') {
        lines.push(`${current.id} 的会话找不到了（可能被删了），重新派一个吧。`);
      } else if (outcome === 'settled') {
        lines.push(
          current.status === 'stopped'
            ? `${current.id} 已经被停掉了，没交报告${current.stopReason ? `（原因：${current.stopReason}）` : ''}。`
            : `${current.id} 已经结束了，但没有留下报告。`,
        );
      } else {
        lines.push(`等满了 ${Math.round(timeoutMs / 1000)} 秒，${current?.id ?? args.id} 还没交报告。`);
        if (current?.status === 'idle') lines.push('它现在是空闲的 —— 可能是没收到活，用 assign_send 催一句。');
        else lines.push('它还在干，过一会儿再看，别一直等着。');
      }
      return text(lines.join('\n'), { outcome, id: current?.id ?? args.id, status: current?.status ?? null });
    },
  }));

  return tools;
}

// 副手作用域里唯一的一个工具：交报告。
export function reportTools(deps = {}) {
  const runtime = deps.runtime;
  const assignment = deps.assignment;

  return [definition({
    name: 'assign_report',
    description:
      '交报告。干完活、或者干不下去要用户拍板的时候调它。summary 会直接推到用户微信上，detail 只在面板里看。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一两句话的结论，会推到微信' },
        detail: { type: 'string', description: '细节、产物路径、下一步建议；不推微信，只在面板看' },
        expectsReply: { type: 'boolean', description: '你需要用户拍板才能继续时设成 true' },
        markItemDone: { type: 'boolean', description: '这条活彻底干完了，顺手把关联工作项标成已完成' },
      },
      required: ['summary'],
    },
    output: { id: OPTIONAL_STR, status: OPTIONAL_STR, pushed: { type: 'boolean' } },
    async execute(args) {
      const result = await runtime.report(assignment.id, {
        summary: args.summary,
        detail: args.detail,
        expectsReply: args.expectsReply === true,
        markItemDone: args.markItemDone === true,
      });
      const bits = [];
      // 状态没切到 waiting 说明名额满了：这时候不能跟它说「用户在等你回话」，
      // 它会以为自己在等一个永远不会来的答复。
      if (result.assignment.report.expectsReply && result.assignment.status === 'waiting') {
        bits.push('报告收到，已经告诉用户你在等他回话。');
      } else if (result.assignment.report.expectsReply) {
        bits.push('报告收到，已经告诉用户了。副手名额现在满了，状态没切到「等回话」，但用户看得到这份报告。');
      } else bits.push('报告收到，用户在微信里能看到。');
      if (!result.pushed) bits.push('（微信那边这会儿没推出去，报告已经存下来了）');
      return text(bits.join(''), {
        id: result.assignment.id,
        status: result.assignment.status,
        pushed: result.pushed,
      });
    },
  })];
}
