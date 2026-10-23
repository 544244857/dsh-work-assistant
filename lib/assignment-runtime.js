// 副手的生命周期层：建会话、发消息、收报告、停掉。
// 登记簿在 ./assignments.js，这里只管「会话」这一层，不碰账本、不碰网络。
//
// 设计参照 DeepSeekBot 的 Assignment：
//   - 控制面（wa:main）只调度，自己不动手；
//   - 副手是独立的顶层会话，能读写文件、能跑命令，干完交一份报告；
//   - 三档投递语义映射到宿主原生能力：context-update→inject / next-step→steer / next-turn→followup。

import {
  activeAssignments,
  assertSlot,
  attachSession,
  createAssignment,
  getAssignment,
  limitError,
  listAssignments,
  promote,
  recordReport,
  stopAssignment,
} from './assignments.js';

export const ASSIGN_SESSION_PREFIX = 'wa:asg:';

// 读副手进展只取最后几条，每条截断。抄 DSB 的有界读取：
// 副手可能跑了几十轮，把整个会话灌进控制面上下文，前台立刻就废了。
const TAIL_EVENTS = 4;
const TAIL_CHARS = 3000;

export function assignmentSessionId(assignment) {
  return `${ASSIGN_SESSION_PREFIX}${assignment.id}`;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 一条事件压成一行人话。没有正文的结构事件返回空串，由调用方过滤掉。
export function summarizeEvent(record) {
  const type = String(record?.type ?? '');
  const text = typeof record?.text === 'string' ? record.text.trim() : '';
  if (type === 'tool/call') {
    const name = text.split('\n')[0] || '工具';
    return `调用了 ${name}`;
  }
  if (type === 'tool/result') return text ? `工具返回：${truncate(text, 160)}` : '工具返回了结果';
  if (type === 'assistant/message') return text ? `说：${truncate(text, 200)}` : '';
  if (type === 'user/message') return text ? `收到：${truncate(text, 120)}` : '';
  // 正常结束的 turn/end 宿主根本不会给 text（也不会进 filterEvents），
  // 能走到这儿的恰恰是出错的那次 —— 把原因扔掉等于把唯一的线索扔了
  if (type === 'turn/end') return text ? `这一轮结束（${truncate(text, 200)}）` : '这一轮结束';
  return '';
}

export function createAssignmentRuntime(options = {}) {
  const ctx = options.ctx;
  const store = options.store;
  const config = options.config ?? {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const push = typeof options.push === 'function' ? options.push : async () => false;
  const buildReportTools = typeof options.buildReportTools === 'function' ? options.buildReportTools : () => [];
  const markItemDone = typeof options.markItemDone === 'function' ? options.markItemDone : null;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  const handles = new Map(); // assignmentId -> AgentHandle

  function agents() {
    return ctx?.get?.('agents');
  }

  function limit() {
    const n = Number(config.maxAssignments);
    return Number.isFinite(n) ? n : undefined;
  }

  function defaultCwd() {
    return typeof config.assignmentCwd === 'string' && config.assignmentCwd.trim()
      ? config.assignmentCwd.trim()
      : undefined;
  }

  function agentOptionsOf(model) {
    const chosen = typeof model === 'string' && model.trim() ? model.trim() : config.assignmentModel;
    if (typeof chosen === 'string' && chosen.trim()) {
      // 允许写成 provider/model 或只写 model；只写 model 时沿用宿主的 provider
      const raw = chosen.trim();
      const slash = raw.indexOf('/');
      if (slash > 0) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
      const host = readHostSelection(ctx);
      if (host?.provider) return { provider: host.provider, model: raw };
      return { model: raw };
    }
    const host = readHostSelection(ctx);
    return host ? { ...host } : undefined;
  }

  async function setupScope(agentCtx, agent, assignment, preset) {
    // 必须等预设挂完再注册自己的东西：预设会带来完整工具集，
    // 挂载没完成就去 restrict 会报 unknown global tool。
    try {
      const presets = ctx?.get?.('agentPresets');
      // 没指定预设就让宿主用默认（mount 不传 id 就是默认）。
      // 预设名可能是别人机器上抄来的、或者被删了，挂不上就退回默认，别让副手起不来。
      if (presets?.mount) {
        const wanted = typeof preset === 'string' ? preset.trim() : '';
        if (!wanted) await presets.mount(agentCtx);
        else {
          try {
            await presets.mount(agentCtx, wanted);
          } catch (err) {
            log(`assignment: 预设 ${wanted} 挂不上，改用宿主默认 ${err?.message ?? err}`);
            await presets.mount(agentCtx);
          }
        }
      }
    } catch (err) {
      log(`assignment: 挂载预设失败 ${err?.message ?? err}`);
    }

    // 副手默认拿到和助手一样的权限档，否则它连文件都改不了，「派活」就是个空壳。
    // 会话只能从 setup 的第二个参数拿：读 agentCtx.agent 会被 cordis 反射代理拦下
    // （cannot get property "agent" without inject），权限档就静默失效了。
    try {
      const permissionPresets = ctx?.get?.('permissionPresets');
      const session = agent?.session;
      if (permissionPresets?.set && session && config.permissionPreset) {
        permissionPresets.set(session, config.permissionPreset);
      } else if (!session) {
        log('assignment: 拿不到会话，权限档没设上');
      }
    } catch (err) {
      log(`assignment: 应用权限预设失败 ${err?.message ?? err}`);
    }

    try {
      for (const tool of buildReportTools(assignment)) agentCtx.tools.register(tool);
    } catch (err) {
      log(`assignment: 注册报告工具失败 ${err?.message ?? err}`);
    }

    try {
      agentCtx.systemPrompt.section({
        name: 'work-assistant-assignment',
        order: 900,
        text: assignmentPrompt(assignment),
      });
    } catch (err) {
      log(`assignment: 注入提示词失败 ${err?.message ?? err}`);
    }
  }

  async function ensure(id) {
    const assignment = await store.read((book) => getAssignment(book, id));
    if (!assignment) throw new Error(`找不到副手 ${id}`);
    // 停掉是终态：再往里发消息会把会话重新拉起来，名额和面板都会跟着乱
    if (assignment.status === 'stopped') {
      throw new Error(`副手 ${id} 已经停掉了，不能再发消息。要接着干就重新派一个。`);
    }
    if (!assignment.sessionId) throw new Error(`副手 ${id} 还没有会话，可能是建到一半失败了`);

    const service = agents();
    if (!service) throw new Error('宿主没有 agents 服务，没法给副手开会话');

    // 先问宿主「这个会话现在还活着吗」，再决定用不用缓存。
    // 只看 handles 会踩坑：用户在 GUI 里把副手会话关掉、或者宿主重载过，
    // 缓存里的 handle 就指向一个已经 disposed 的 agent，往里投消息等于扔进黑洞，
    // 而且永远不会自愈。所以以宿主为准，缓存只用来保住那个真正的 dispose 闭包。
    const cached = handles.get(id);
    const live = service.get?.(assignment.sessionId);
    if (live) {
      if (cached?.agent === live) return cached;
      // external：这个会话是宿主里本来就活着的，不是我们用 create/resume 开出来的。
      // 宿主没给「释放别人的会话」的接口（agents.get 返回的 agent 没有 dispose），
      // 所以 stop 只能叫停它，没法把它从会话列表里抹掉 —— 回执要如实说。
      const handle = { agent: live, dispose: async () => {}, external: true };
      handles.set(id, handle);
      return handle;
    }
    if (cached) handles.delete(id);

    if (!service.resume) throw new Error('宿主不支持恢复会话，副手的会话已经找不到了');

    // 恢复一个失联的副手等于让它重新占一个名额。它离线期间不算活跃，
    // 这期间用户可能又派满了新的；不复查就会悄悄突破上限。
    // 真正的复查在 promote 里，这里只提前问一句，好在开会话之前就把话说明白。
    if (assignment.status === 'offline') {
      const book = await store.read((data) => data);
      const active = activeAssignments(book).filter((item) => item.id !== id);
      if (active.length >= limit()) throw limitError(limit(), active);
    }

    // 空 = 跟宿主默认；别硬写 'standard'，别人的机器上不一定有这个预设。
    const preset = assignment.preset || config.assignmentPreset || '';
    try {
      const handle = await service.resume({
        resumeSessionId: assignment.sessionId,
        agentOptions: agentOptionsOf(assignment.model),
        setup: (agentCtx, agent) => setupScope(agentCtx, agent, assignment, preset),
      });
      handles.set(id, handle);
      await store.mutate((book) => {
        const current = getAssignment(book, id);
        if (!current) return null;
        if (current.status === 'offline') promote(book, id, 'idle', { limit: limit() });
        current.updatedAt = clock().toISOString();
        return current;
      });
      log(`assignment: 恢复会话 ${assignment.sessionId}`);
      return handle;
    } catch (err) {
      await store.mutate((book) => {
        const current = getAssignment(book, id);
        if (!current) return null;
        current.status = 'offline';
        current.updatedAt = clock().toISOString();
        return current;
      });
      throw new Error(`副手会话恢复不了，可能被删了：${err?.message ?? err}`);
    }
  }

  // 宿主把消息写进会话时会校验 id 和 role（session 的 assertMessageEventShape），
  // inbox 还要求 id 全局唯一：不带 id 第一条会被判「没有身份」，第二条直接撞
  // 「message "undefined" is already pending」。所以消息自己造，别指望宿主补。
  function userMessage(id, body) {
    return { id, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'work-assistant' } };
  }

  async function create(input = {}) {
    const now = clock();
    // 先写登记簿拿 id：建会话要用 id 拼 sessionId，顺序反了就没法把两边对上。
    const assignment = await store.mutate((book) =>
      createAssignment(book, input, now, { limit: limit(), timeZone: config.timeZone }),
    );

    const sessionId = assignmentSessionId(assignment);
    const service = agents();
    if (!service?.create) {
      await store.mutate((book) => stopAssignment(book, assignment.id, '宿主没有 agent 服务，没法派活', now));
      throw new Error('宿主没有 agents 服务，没法派活');
    }

    // 空 = 跟宿主默认；别硬写 'standard'，别人的机器上不一定有这个预设。
    const preset = assignment.preset || config.assignmentPreset || '';
    const cwd = assignment.cwd || defaultCwd();

    let created = null;
    try {
      // 插件重载后 sessionId 可能已经活着了，先复用，别硬 create 撞 already exists
      const live = service.get?.(sessionId);
      const handle = live
        ? { agent: live, dispose: async () => {}, external: true }
        : await (service.withoutInitiator
            ? service.withoutInitiator(() =>
                service.create({
                  sessionId,
                  meta: {
                    ...(cwd ? { cwd } : {}),
                    ...(preset ? { agentPreset: preset } : {}),
                  },
                  agentOptions: agentOptionsOf(assignment.model),
                  setup: (agentCtx, agent) => setupScope(agentCtx, agent, assignment, preset),
                }),
              )
            : service.create({
                sessionId,
                meta: {
                  ...(cwd ? { cwd } : {}),
                  ...(preset ? { agentPreset: preset } : {}),
                },
                agentOptions: agentOptionsOf(assignment.model),
                setup: (agentCtx, agent) => setupScope(agentCtx, agent, assignment, preset),
              }));
      created = live ? null : handle;

      handles.set(assignment.id, handle);
      const attached = await store.mutate((book) => attachSession(book, assignment.id, sessionId, clock()));
      log(`assignment: 建好副手 ${assignment.id}（${sessionId}）`);
      // 建完必须自己踢一脚：宿主 create 只跑 setup + publish，不会凭空起一轮
      // （kick() 只在 wakeDriver 和 turn 循环里被调）。不踢的话副手就躺在会话
      // 列表里一动不动，assign_wait 必然超时，用户还以为派活成功了。
      handle.agent.followup(userMessage(`asg-kick-${assignment.id}`, `开始干活：${assignment.purpose}`));
      return { assignment: attached, agent: handle.agent };
    } catch (err) {
      // 会话已经建出来了、但登记这一步失败：必须把刚建的那个拆掉，
      // 否则它成了没人认领的野会话，一直在后台跑，名额和日志都跟着乱。
      // 只拆自己新建的：复用来的活会话不是我们开的，不能顺手杀掉。
      if (created?.dispose) {
        try {
          await created.dispose();
        } catch (disposeErr) {
          log(`assignment: 清理半成品会话失败 ${disposeErr?.message ?? disposeErr}`);
        }
      }
      handles.delete(assignment.id);
      // 会话没建成，登记簿不能留一条「活的」记录，否则并发名额被永久占住
      await store.mutate((book) =>
        stopAssignment(book, assignment.id, `建会话失败：${err?.message ?? err}`, clock()),
      );
      throw new Error(`副手会话建不起来：${err?.message ?? err}`);
    }
  }

  async function send(id, text, mode = 'next-turn') {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('message 不能为空');
    // 名额要在 ensure() 之前查：ensure() 可能会把会话恢复出来，
    // 查晚了等于白唤醒一个会话，然后才告诉用户「没位置」。
    await store.read((book) => assertSlot(book, id, 'idle', limit()));

    const handle = await ensure(id);
    const agent = handle?.agent;
    if (!agent) throw new Error('副手当前没有运行中的 agent');

    const message = userMessage(`asg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, body);
    // 投递失败不重试：宿主没有幂等键，重试可能让副手收到两遍同一句话
    if (mode === 'context-update') {
      if (typeof agent.inject !== 'function') throw new Error('当前宿主不支持 inject');
      agent.inject(message);
    } else if (mode === 'next-step') {
      if (typeof agent.steer !== 'function') throw new Error('当前宿主不支持 steer');
      agent.steer(message);
    } else {
      if (typeof agent.followup !== 'function') throw new Error('当前宿主不支持 followup');
      agent.followup(message);
    }
    await store.mutate((book) => {
      const current = getAssignment(book, id);
      if (!current) return null;
      // 交过活（或交过问题等回话）的副手被追加了新消息，就得退回「待办」：
      // 留在 done/waiting 会让 assign_wait 把上一份已经回答过的报告当成这次的结果。
      // waiting 尤其致命 —— 用户刚回完话，再等就立刻拿到那句旧问题，等于白问一遍。
      // done / waiting 都不是活跃态，退回 idle 等于重新占一个名额，得走 promote 复查。
      if (current.status === 'done' || current.status === 'waiting') {
        promote(book, id, 'idle', { limit: limit() });
      }
      current.updatedAt = clock().toISOString();
      return current;
    });
    return { ok: true, mode };
  }

  async function report(id, input = {}) {
    const now = clock();
    const before = await store.read((book) => getAssignment(book, id));
    if (!before) throw new Error(`找不到副手 ${id}`);
    // 叫停之后交上来的报告不再接收：用户刚说停掉，手机上又弹一条「副手交活了」
    // 只会让人以为它没停。数据层的 recordReport 仍会留档，这里只管不打扰人。
    if (before.status === 'stopped') throw new Error(`副手 ${id} 已经停掉了，报告不再接收`);
    // 带 limit：从 done 交一份「等回话」的报告会把状态推回 waiting（活跃态），
    // 名额满了就得拦住，否则报告一交就悄悄多占一个位置。
    // recordReport 里名额满了不会抛错：报告内容已经落盘，只是状态不迁。
    const assignment = await store.mutate((book) => recordReport(book, id, input, now, { limit: limit() }));
    // 想回到「等回话」却被名额挡住：话收到了，但它现在不算活跃。
    // 不说清楚，用户会以为自己在等一个根本没在等的副手。
    const slotBlocked = input.expectsReply === true && assignment.status !== 'waiting';
    const head = `副手 ${assignment.id} 交活了：${assignment.report.summary}`;
    const tail = slotBlocked
      ? '（它想等你回话，但副手名额已经开满了，状态没切过去；报告已经存下来了，直接回它就行）'
      : assignment.report.expectsReply
        ? '（它在等你回话）'
        : '';
    let pushed = false;
    try {
      pushed = (await push(`${head}${tail}`)) !== false;
    } catch (err) {
      log(`assignment: 报告推送失败 ${err?.message ?? err}`);
    }

    if (input.markItemDone === true && assignment.itemId && markItemDone) {
      try {
        await markItemDone(assignment.itemId, assignment.id);
      } catch (err) {
        log(`assignment: 标记工作项完成失败 ${err?.message ?? err}`);
      }
    }
    return { assignment, pushed, slotBlocked };
  }

  async function stop(id, reason = '') {
    const handle = handles.get(id);
    // 只有自己 create/resume 出来的会话才拿得到真正的 dispose；
    // 复用来的会话宿主不给释放接口，只能 cancel 叫停。
    let released = Boolean(handle) && !handle.external;
    if (handle?.dispose) {
      try {
        await handle.dispose();
      } catch (err) {
        log(`assignment: 释放会话失败 ${err?.message ?? err}`);
        // 释放失败就不能说停干净了，否则用户以为会话已经没了
        released = false;
      }
    }
    handles.delete(id);
    // 插件重载后 handles 是空的，但副手会话可能还在跑；光登记成 stopped 不真停，
    // 它会继续烧 token，名额也一直占着。所以再问一次宿主有没有活的会话。
    let sessionActive = false;
    try {
      const assignment = await store.read((book) => getAssignment(book, id));
      const live = assignment?.sessionId ? agents()?.get?.(assignment.sessionId) : undefined;
      // cancel 的 cause 是宿主固定的几种 kind；这里是我们主动叫停，用 user
      if (live && typeof live.cancel === 'function') {
        live.cancel({ kind: 'user' });
        sessionActive = true;
      }
    } catch (err) {
      log(`assignment: 停会话时出错 ${err?.message ?? err}`);
      released = false;
    }
    const assignment = await store.mutate((book) => stopAssignment(book, id, reason, clock()));
    // 三种情况要分开说，否则回执会撒谎：
    // released=true       自己开的会话，已经 dispose 掉了，干净
    // released=false + sessionActive  别人的会话，只能 cancel，还留在列表里
    // 都不是              本来就没在跑，只改了登记
    return { assignment, released, sessionActive };
  }

  async function readTail(sessionId) {
    const query = ctx?.get?.('sessionQuery');
    if (!query || !sessionId) return [];
    let records = [];
    try {
      // filterEvents 带正文，listEvents 只有元数据；优先前者，取不到再退
      if (typeof query.filterEvents === 'function') records = await query.filterEvents(sessionId, []);
      else if (typeof query.listEvents === 'function') records = await query.listEvents(sessionId);
    } catch (err) {
      log(`assignment: 读会话事件失败 ${err?.message ?? err}`);
      return [];
    }
    if (!Array.isArray(records)) return [];
    return records
      .slice(-TAIL_EVENTS * 3)
      .map(summarizeEvent)
      .filter(Boolean)
      .slice(-TAIL_EVENTS)
      .map((line) => truncate(line, TAIL_CHARS));
  }

  async function inspect(id) {
    const assignment = await store.read((book) => getAssignment(book, id));
    if (!assignment) throw new Error(`找不到副手 ${id}`);
    const tail = await readTail(assignment.sessionId);
    return { assignment, tail };
  }

  async function reconcile() {
    const book = await store.read((data) => data);
    const now = clock();
    let offline = 0;
    let restored = 0;
    const service = agents();
    for (const assignment of book.items) {
      if (!['idle', 'running', 'waiting'].includes(assignment.status)) continue;
      if (!assignment.sessionId) {
        await store.mutate((data) => stopAssignment(data, assignment.id, '没建成（会话 id 为空）', now));
        continue;
      }
      if (service?.get?.(assignment.sessionId)) {
        restored += 1;
        continue;
      }
      await store.mutate((data) => {
        const current = getAssignment(data, assignment.id);
        if (!current) return null;
        current.status = 'offline';
        current.updatedAt = now.toISOString();
        return current;
      });
      offline += 1;
    }
    if (offline || restored) log(`assignment: 启动对齐 restored=${restored} offline=${offline}`);
    return { restored, offline };
  }

  // 只更新数据，不推微信 —— 副手的中间过程不该刷到用户手机上
  function onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? '');
    if (!sessionId.startsWith(ASSIGN_SESSION_PREFIX)) return;
    const id = sessionId.slice(ASSIGN_SESSION_PREFIX.length);
    const type = event?.type;
    if (type !== 'turn/start' && type !== 'turn/end') return;

    const stamp = clock().toISOString();
    void store
      .mutate((book) => {
        const current = getAssignment(book, id);
        if (!current) return null;
        // 已经收尾的副手不许被后续事件复活：它可能刚好在 stop 之后又跑完一轮，
        // 把 stopped 改回 idle 会让名额一直漏算，也会让面板显示成还在干活
        if (current.status === 'stopped' || current.status === 'done') return current;
        if (type === 'turn/start') {
          // idle→running 本来就在活跃集合里，不占新名额；offline→running 是复活，
          // 得复查（名额满了就让它继续离线，别偷偷多开一条线）。
          promote(book, id, 'running', { limit: limit() });
          current.lastRunAt = stamp;
        } else if (current.status === 'running') {
          // 报告已经把状态改成 done / waiting，这里不能覆盖
          current.status = 'idle';
        }
        current.updatedAt = stamp;
        return current;
      })
      .catch((err) => log(`assignment: 更新状态失败 ${err?.message ?? err}`));
  }

  async function dispose() {
    for (const [id, handle] of handles) {
      try {
        await handle?.dispose?.();
      } catch (err) {
        log(`assignment: 释放 ${id} 失败 ${err?.message ?? err}`);
      }
    }
    handles.clear();
  }

  return {
    create,
    send,
    report,
    stop,
    inspect,
    ensure,
    reconcile,
    get: (id) => store.read((book) => getAssignment(book, id)),
    list: (filter) => store.read((book) => listAssignments(book, filter, clock())),
    activeCount: () => store.read((book) => activeAssignments(book).length),
    onSessionEvent,
    dispose,
  };
}

function readHostSelection(ctx) {
  try {
    const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model };
  } catch {
    /* 读不到就用宿主默认 */
  }
  return undefined;
}

export function assignmentPrompt(assignment) {
  return [
    '你是「工作助理」派出来的副手，在自己的会话里独立干活。',
    `用户交代这条线要办的事：${assignment?.purpose ?? '（没写）'}`,
    '',
    '干活的方式：',
    '- 该读文件就读、该跑命令就跑、该写东西就写。不要只给建议，把活干完。',
    '- 卡住了不要硬猜，也不要不吭声。干不下去就交报告说明卡在哪。',
    '- 干完调用 assign_report 交一份报告：summary 是一两句话的结论，detail 写细节和产物路径。',
    '- 如果你需要用户拍板才能继续，交报告时把 expectsReply 设成 true。',
    '',
    '说话方式：短、说人话、不用 emoji。报告里不要复述过程，只讲结果和下一步。',
  ].join('\n');
}
