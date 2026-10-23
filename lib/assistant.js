import { promptSection } from './prompt.js';

// 助手会话的生命周期：创建/恢复 wa:main、把微信消息注入、把回复推回微信。
// 投递只认“我们自己发起的那一轮”，避免 GUI 里的对话被推到微信上。

export const SESSION_ID = 'wa:main';

// 微信里用不上、还会误导模型的宿主工具。present 最典型：它只在 Web 界面里
// 画一张文件卡片，返回却是「Presented <路径>」，模型以为已经发过去了。
export const WECHAT_HIDDEN_TOOLS = ['present', 'visualize', 'ask_user_question'];

// 一轮结束时用户一条消息都没收到的情况，各给一句能看懂的话。
// completed 不在里面：正常结束会自己推正文。
const TURN_NOTICE = {
  error: '助手没有生成回复，详情看本机日志。',
  aborted: '这一轮被取消了，没生成回复。',
  blocked: '这一轮没跑起来，可能缺了前置条件，你再说一次试试。',
  'max-tokens': '回复太长被截断了，你让我接着说就行。',
};

function randomId() {
  return `wa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// 含工具调用的中间叙述不投递，只发最终文字
export function assistantText(content = [], skipInterim = true) {
  const blocks = Array.isArray(content) ? content : [];
  if (skipInterim && blocks.some((block) => block?.type === 'tool-call')) return undefined;
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function readHostModel(ctx) {
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
    const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
    if (!provider || !model) return undefined;
    return { provider, model };
  } catch {
    return undefined;
  }
}

export class Assistant {
  constructor(options) {
    this.ctx = options.ctx;
    this.config = options.config;
    this.log = options.log ?? (() => {});
    this.buildTools = options.buildTools;
    // async (mediaList) => { content, saved, failed }：把微信的图片/文件取下来，
    // 变成模型能吃的块。不传就只处理纯文本（测试里通常不传）。
    this.buildMedia = options.buildMedia ?? null;
    this.send = options.send; // async (text) => boolean
    // 「正在输入」刷新器，可不传（测试里就不传）。模型调工具时可能跑十几秒，
    // 没有这个的话微信那边一直静悄悄，用户不知道机器人在不在干活。
    this.typing = options.typing ?? null;
    this.sessionId = options.sessionId ?? SESSION_ID;
    this.cwd = options.cwd;
    // 空字符串 = 不指定，交给宿主用它自己的默认预设。
    // 别在这里写死 'standard'：这个插件会装到别人机器上，他那边的默认预设才是对的。
    this.agentPreset = options.agentPreset ?? '';
    this.permissionPreset = options.permissionPreset ?? '';
    // async ({role, text}) => void：把微信里真实出现过的话记一笔，面板按天回看用。
    // 不传就只记入站消息（测试里通常不传）。
    this.record = options.record ?? null;

    this.handle = null;
    this.starting = null;
    // 哪些 agent 已经补挂过本插件的范围。WeakSet 不拦着会话被回收。
    this.scoped = new WeakSet();
    // 设置改过了，需要按新的预设/模型/权限重开会话。不立刻拆：
    // 保存设置的时候可能正有一轮在跑，拆了这轮的回复就没了。
    this.stale = false;
    this.currentTurn = null;
    this.pending = new Map(); // rpcId -> { chatId, contextToken, at }
    this.turns = new Map(); // turn -> { chatId, contextToken }
  }

  async ensureSession() {
    // 配置改过就先把旧会话放掉。放在建会话之前，此时还没有待归属的轮次，
    // 拆起来不会丢任何一条微信消息。
    if (this.stale && this.handle) {
      this.log('assistant: 设置变了，按新配置重开会话');
      await this.dispose();
    }
    this.stale = false;
    if (this.handle) return this.handle;
    if (this.starting) return this.starting;

    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start(attempt = 0) {
    // 只能用 ctx.get 反射读取：直接 this.ctx.agents 在没有声明 inject 时会被代理拦截抛错。
    const agents = this.ctx.get?.('agents');
    if (!agents) throw new Error('宿主没有 agents 服务，无法创建助手会话');

    const live = agents.get?.(this.sessionId);
    if (live) {
      // 这个会话可能已经被 GUI 打开过：宿主自己建过一个 agent，只挂了那一侧的预设，
      // 台账工具一个都没有，人格也不是这里配的那个。直接拿来用，模型就会说「工具不存在」。
      // 所以复用之前先把我们这层范围补挂上去。
      await this.adopt(live);
      this.handle = { agent: live, dispose: async () => {} };
      this.log(`assistant: 复用已在运行的会话 ${this.sessionId}`);
      return this.handle;
    }

    const agentOptions = this.agentOptions();
    const setup = (agentCtx, explicitAgent) => this.setupScope(agentCtx, explicitAgent);

    // 优先恢复已有会话，恢复不了才新建
    if (agents.resume) {
      try {
        const handle = await agents.resume({
          resumeSessionId: this.sessionId,
          agentOptions,
          setup,
        });
        this.handle = handle;
        this.log(`assistant: 恢复会话 ${this.sessionId}`);
        return handle;
      } catch (err) {
        this.log(`assistant: 恢复失败，改为新建 ${err?.message ?? err}`);
        const retried = await this.retryStart(agents, err, attempt);
        if (retried) return retried;
      }
    }

    const create = () =>
      agents.create({
        sessionId: this.sessionId,
        meta: {
          cwd: this.cwd,
          ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
        },
        agentOptions,
        setup,
      });

    let handle;
    try {
      handle = await (agents.withoutInitiator ? agents.withoutInitiator(create) : create());
    } catch (err) {
      const retried = await this.retryStart(agents, err, attempt);
      if (retried) return retried;
      throw err;
    }
    this.handle = handle;
    this.log(`assistant: 新建会话 ${this.sessionId}`);
    return handle;
  }

  // 上一轮会话可能还没被宿主彻底放掉：这时恢复会说「already owned by an active write handle」、
  // 新建会说「already exists」，两条路一起堵死，用户眼里就是「机器人死了」。
  // 这种错误一律退让一下再看一眼：会话要是还活着就直接接管，不然隔一会儿重试。
  async retryStart(agents, err, attempt) {
    const message = String(err?.message ?? err);
    if (!/already owned|already exists|is already/i.test(message)) return null;
    if (attempt >= 2) return null;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    const live = agents.get?.(this.sessionId);
    if (live) {
      await this.adopt(live);
      this.handle = { agent: live, dispose: async () => {} };
      this.log(`assistant: 会话还在运行，直接接管 ${this.sessionId}`);
      return this.handle;
    }
    return this.#start(attempt + 1);
  }

  // 给一个已经活着的会话补挂本插件的范围（工具、人格、权限、提示词）。
  // 同一个 agent 只补一次：重复注册只会刷一屏「already registered」。
  async adopt(agent) {
    const agentCtx = agent?.ctx;
    if (!agentCtx?.tools) {
      this.log('assistant: 这个会话没有可写的作用域，跳过补挂');
      return false;
    }
    if (this.scoped.has(agent)) return true;
    try {
      await this.setupScope(agentCtx, agent);
      this.scoped.add(agent);
      this.log('assistant: 已给复用的会话补挂工具与人格');
      return true;
    } catch (err) {
      this.log(`assistant: 补挂失败 ${err?.message ?? err}`);
      return false;
    }
  }

  // 用哪个模型：设置页里显式选过就用选的，没选才用宿主的默认模型。
  // 这样用户可以给助理配一个便宜的模型，不必跟着全局默认走。
  agentOptions() {
    const configuredProvider = typeof this.config?.agentProvider === 'string' ? this.config.agentProvider.trim() : '';
    const configuredModel = typeof this.config?.agentModel === 'string' ? this.config.agentModel.trim() : '';
    const explicit = configuredProvider && configuredModel ? { provider: configuredProvider, model: configuredModel } : null;
    const model = explicit ?? readHostModel(this.ctx);
    if (!model) throw new Error('没有可用的默认模型，请先在设置里选好模型');
    const effort = typeof this.config?.agentReasoningEffort === 'string' ? this.config.agentReasoningEffort.trim() : '';
    return effort ? { provider: model.provider, model: model.model, reasoningEffort: effort } : { ...model };
  }

  // 设置页改了模型/预设/权限之后要让它真的生效：agentOptions 与 setupScope 都只在建会话时跑一次，
  // 不重建会话的话改了等于没改。
  // 但这里不能立刻拆：保存设置的那一刻可能正有一轮在跑（用户刚发完消息就顺手改设置），
  // 拆了这轮的回复就丢了。所以只打标记，等下一条微信消息进来时再换。
  restart() {
    this.stale = true;
    this.log('assistant: 设置变了，下一条消息进来时按新配置重开会话');
  }

  // 预设决定这个会话「是谁」：人格、称呼、语气、以及它带进来的那批工具。
  // 用户选过就用选的；没选就让宿主用它自己的默认预设（mount 不传 id 就是默认）。
  // 预设名可能是别人机器上抄来的、或者后来被删了 —— 挂不上就退回默认，
  // 绝不能让整个会话起不来（那样用户看到的是「机器人死了」）。
  async mountPreset(presets, agentCtx, wanted) {
    if (typeof presets?.mount !== 'function') return null;
    const name = typeof wanted === 'string' ? wanted.trim() : '';
    if (!name) return presets.mount(agentCtx);
    try {
      return await presets.mount(agentCtx, name);
    } catch (err) {
      this.log(`assistant: 预设 ${name} 挂不上，改用宿主默认 ${err?.message ?? err}`);
      return presets.mount(agentCtx);
    }
  }

  // 只对助手会话生效：注册工具与提示词，不污染其它会话
  // 返回 Promise：调用方（宿主的 setup 回调）会 await 它，所以这里能安全地等预设挂完。
  async setupScope(agentCtx, explicitAgent) {
    const agent = explicitAgent ?? agentCtx.agent;
    const session = agent?.session;

    // 必须等预设真的挂完。present / visualize 这些工具是预设带进来的，
    // 挂载完成之前它们不在可见名单里；这时候去 restrict 会报 unknown global tool，
    // 被下面的 catch 吞掉，于是「屏蔽」变成了一句空话 —— 之前就是这么漏的。
    try {
      const presets = this.ctx.get?.('agentPresets');
      await this.mountPreset(presets, agentCtx, this.config?.agentPreset ?? this.agentPreset);
    } catch (err) {
      this.log(`assistant: 挂载预设失败 ${err?.message ?? err}`);
    }

    const permission = this.config?.permissionPreset ?? this.permissionPreset;
    if (permission && session) {
      try {
        const permissionPresets = this.ctx.get?.('permissionPresets');
        permissionPresets?.set?.(session, permission);
      } catch (err) {
        this.log(`assistant: 应用权限预设失败 ${err?.message ?? err}`);
      }
    }

    // 逐个注册：复用别人的会话时，可能已经有一部分工具挂在同一个作用域上，
    // 一个名字撞车不该把后面十几个也一起废掉。
    try {
      const tools = this.buildTools();
      for (const tool of tools) {
        try {
          agentCtx.tools.register(tool);
        } catch (err) {
          this.log(`assistant: 注册工具 ${tool?.name} 失败 ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      this.log(`assistant: 准备工具失败 ${err?.message ?? err}`);
    }

    // 把只在电脑界面里有意义的工具从助手会话里摘掉。
    // present 的返回是「Presented <路径>」，模型会当成「已经发给他了」，
    // 但微信那边一个字节都收不到 —— 实测就是这么丢文件的。visualize 同理，
    // 它只在 Web 界面里渲染一张卡片；ask_user_question 更是把问题问到没人看的界面上。
    // 逐个 try：某个工具在当前环境里不存在时（用户关掉了对应插件），
    // 单独跳过就好，不能让一次失败把整组屏蔽都废掉。
    for (const name of WECHAT_HIDDEN_TOOLS) {
      try {
        agentCtx.tools.restrict({ deny: [name] });
      } catch (err) {
        this.log(`assistant: 屏蔽工具 ${name} 失败 ${err?.message ?? err}`);
      }
    }

    // 上面那层是「从名单里拿掉」，模型看不见就不会调。但名单是挂载快照，
    // 时序一变就可能漏（预设被换掉、工具被别的插件重新注册）。
    // 这里再加一道执行期的硬闸：名字对上了就直接拒绝，不依赖名单是否正确。
    // guard 是同步检查，返回字符串即拒绝，所以不会拖慢正常调用。
    try {
      const blocked = new Set(WECHAT_HIDDEN_TOOLS);
      agentCtx.tools.guard((exec) => {
        const name = exec?.name;
        if (!blocked.has(name)) return undefined;
        return `${name} 在微信里发不出任何东西，要给他看文件请用 work_send_file`;
      });
    } catch (err) {
      this.log(`assistant: 安装工具闸门失败 ${err?.message ?? err}`);
    }

    try {
      agentCtx.systemPrompt.section({
        name: 'work-assistant',
        order: 900,
        text: promptSection({ channelNote: '微信私聊' }),
      });
    } catch (err) {
      this.log(`assistant: 注入提示词失败 ${err?.message ?? err}`);
    }

    // 会话列表里得一眼看出这是谁：不然一堆「新开会话了」分不清哪个是微信那头。
    try {
      const titles = this.ctx.get?.('sessionTitle');
      if (titles?.rename && session) titles.rename(session, '微信工作助理');
    } catch (err) {
      this.log(`assistant: 改会话名失败 ${err?.message ?? err}`);
    }
  }

  // 微信来消息：注入一轮，并记下这轮的投递目标
  async deliver({ chatId, text, contextToken, media }) {
    // 一收到消息就把「正在输入」点起来：模型思考、调工具都可能花十几秒，
    // 微信那边完全没有动静的话，用户根本不知道消息是不是被收到了。
    // 放在创建会话之前，是因为第一次建会话本身也要一两秒。
    this.typing?.start?.({ toUserId: chatId, contextToken });

    let handle;
    try {
      handle = await this.ensureSession();
    } catch (err) {
      void this.stopTyping();
      throw err;
    }
    const agent = handle?.agent;
    if (!agent?.followup) {
      void this.stopTyping();
      throw new Error('助手会话当前没有运行中的 agent');
    }

    const rpcId = randomId();
    this.pending.set(rpcId, { chatId, contextToken, at: Date.now() });

    // 附件先落盘再决定走哪条投递路径。图片必须交给 sessionController：
    // agent.followup 不做附件准入，image 块里的 base64 会被当成普通字段扔掉，
    // 模型那边根本看不到图。纯文本仍然走 followup，路径最短、也最稳。
    let content = text ? [{ type: 'text', text }] : [];
    const mediaList = Array.isArray(media) ? media : [];
    if (mediaList.length && typeof this.buildMedia === 'function') {
      try {
        const built = await this.buildMedia(mediaList);
        if (Array.isArray(built?.content) && built.content.length) content = content.concat(built.content);
        if (built?.saved?.length) this.log(`assistant: 附件已落盘 ${built.saved.length} 个`);
      } catch (err) {
        this.log(`assistant: 附件处理失败 ${err?.message ?? err}`);
        content.push({ type: 'text', text: `[收到 ${mediaList.length} 个附件，但没能处理]` });
      }
    }

    const hasImage = content.some((part) => part?.type === 'image');
    if (hasImage) {
      const submitted = await this.#promptWithAttachments({ rpcId, content });
      if (!submitted) {
        // 宿主不支持带图投递时退化成一句话，总比整条消息消失好
        this.pending.delete(rpcId);
        void this.stopTyping();
        agent.followup({
          id: rpcId,
          role: 'user',
          content: [{ type: 'text', text: `${text || ''}\n[图片没能交给模型：当前宿主不支持图片输入]`.trim() }],
          source: { kind: 'user', rpcId },
        });
        this.pending.set(rpcId, { chatId, contextToken, at: Date.now() });
        this.log(`assistant: 图片投递不可用，已退化为纯文本 ${rpcId}`);
        return rpcId;
      }
      this.log(`assistant: 注入微信消息 ${rpcId}（含图片），文本长度 ${text?.length ?? 0}`);
      return rpcId;
    }

    agent.followup({
      id: rpcId,
      role: 'user',
      content: content.length ? content : [{ type: 'text', text: '' }],
      source: { kind: 'user', rpcId },
    });
    this.log(`assistant: 注入微信消息 ${rpcId}，长度 ${text?.length ?? 0}`);
    return rpcId;
  }

  // 带图投递必须走 sessionController：只有它会把 base64 落成 durable 附件
  // 再换成引用交给模型，并且会先校验当前模型到底吃不吃图。
  async #promptWithAttachments({ rpcId, content }) {
    const controller = this.ctx.get?.('sessionController');
    if (typeof controller?.prompt !== 'function') {
      this.log('assistant: 宿主没有 sessionController，图片投递不可用');
      return false;
    }
    try {
      await controller.prompt({
        requestId: rpcId,
        sessionId: this.sessionId,
        mode: 'queue',
        content,
      });
      return true;
    } catch (err) {
      this.log(`assistant: 带附件投递失败 ${err?.message ?? err}`);
      return false;
    }
  }

  // root ctx 上的 session/event 监听
  onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? '');
    if (sessionId !== this.sessionId) return;
    if (!event || typeof event !== 'object') return;

    const turn = event.data?.turn;

    if (event.type === 'turn/start' && Number.isSafeInteger(turn)) {
      this.currentTurn = turn;
      // GUI 里点开这个会话直接聊的时候，宿主是拿默认预设建的 agent，没有台账工具。
      // 这里补挂一次，下一轮就能看见；补挂失败也不影响这一轮继续跑。
      const live = this.ctx.get?.('agents')?.get?.(this.sessionId);
      if (live && !this.scoped.has(live)) void this.adopt(live);
      return;
    }

    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId;
      if (!rpcId || !this.pending.has(rpcId)) return;
      const target = this.pending.get(rpcId);
      this.pending.delete(rpcId);
      const turnNo = Number.isSafeInteger(turn) ? turn : this.currentTurn;
      if (Number.isSafeInteger(turnNo)) {
        this.turns.set(turnNo, target);
        this.log(`assistant: 第 ${turnNo} 轮归属微信，将回推`);
      } else {
        this.log('assistant: 收到微信消息但没拿到轮次号，本轮不投递');
      }
      return;
    }

    if (event.type === 'assistant/message') {
      const turnNo = Number.isSafeInteger(turn) ? turn : this.currentTurn;
      const target = Number.isSafeInteger(turnNo) ? this.turns.get(turnNo) : undefined;
      if (!target) return;
      const text = assistantText(event.data?.message?.content, true);
      if (!text) return;
      void this.push(text).catch((err) => this.log(`assistant: 回推失败 ${err?.message ?? err}`));
      return;
    }

    if (event.type === 'turn/end') {
      const turnNo = Number.isSafeInteger(turn) ? turn : this.currentTurn;
      if (!Number.isSafeInteger(turnNo)) return;
      const target = this.turns.get(turnNo);
      if (target) this.turns.delete(turnNo);
      // 这一轮跑完了就撤掉「正在输入」：晚一步撤，用户会看到回复已经到了、
      // 聊天框还写着「对方正在输入」，等于一直在骗人。
      // 用 turns.size 判断而不是 target 存不存在，是因为没认领到轮次的微信消息
      // 也要能把状态收掉，不然会一直转到下次清扫。
      if (this.turns.size === 0) void this.stopTyping();
      if (!target) return;
      // 除了 error，还有几种结束方式用户也看不到任何回复：
      // aborted（GUI 里点了取消）、blocked（前置条件不满足）、max-tokens（输出被截断）。
      // 全都静默的话，用户会以为机器人死了。
      const kind = event.data?.reason?.kind;
      const notice = TURN_NOTICE[kind];
      if (notice) {
        const detail = event.data?.reason?.error?.message ?? kind;
        this.log(`assistant: 第 ${turnNo} 轮以 ${kind} 结束 ${detail}`);
        void this.push(notice).catch(() => {});
      }
      return;
    }
  }

  async push(text) {
    if (typeof this.send !== 'function') return false;
    const ok = await this.send(text);
    // 推出去的这句话也要留档：面板上「按天回看」靠的就是入站与回复这两份记录。
    // 记录失败不影响发送结果，最多是回看里少一句。
    if (ok && this.record && typeof text === 'string' && text.trim()) {
      try {
        await this.record({ role: 'assistant', text });
      } catch (err) {
        this.log(`assistant: 回复没记进对话记录 ${err?.message ?? err}`);
      }
    }
    return ok;
  }

  async stopTyping() {
    try {
      await this.typing?.stop?.();
    } catch {
      /* 状态清理失败无所谓 */
    }
  }

  // 长时间没收到本轮结束事件时清掉，防止把后来的 GUI 对话也推出去。
  // 注意 turns 必须按自己的时间戳清：正常流程里 pending 一收到 user/message 就空了
  // （那正是它被搬到 turns 的时刻），如果这时无条件清空 turns，
  // 模型超过清扫间隔才回复（调工具几乎必然超过）时整条回复会被丢掉，用户在微信里永远等不到回应。
  sweepStale(maxAgeMs = 15 * 60 * 1000) {
    const now = Date.now();
    for (const [rpcId, target] of this.pending) {
      if (now - target.at > maxAgeMs) this.pending.delete(rpcId);
    }
    let dropped = 0;
    for (const [turnNo, target] of this.turns) {
      if (now - (target?.at ?? 0) > maxAgeMs) {
        this.turns.delete(turnNo);
        dropped += 1;
      }
    }
    // 轮次被丢弃说明这一轮不会再有 turn/end 了，正在输入必须自己收掉，否则会一直挂着
    if (dropped > 0) void this.stopTyping();
  }

  async dispose() {
    const handle = this.handle;
    this.handle = null;
    // 拆掉之后那层范围就没了，标记也要跟着清掉，否则下次复用时会被当成「已经补挂过」。
    if (handle?.agent) this.scoped.delete(handle.agent);
    this.pending.clear();
    this.turns.clear();
    await this.stopTyping();
    if (handle?.dispose) {
      try {
        await handle.dispose();
      } catch (err) {
        this.log(`assistant: 关闭会话失败 ${err?.message ?? err}`);
      }
    }
  }
}
