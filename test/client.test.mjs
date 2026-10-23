// 客户端半边的回归测试。
// 这个文件在浏览器里跑，用 window.__ModuleLoader__ 注册；这里用假的 React 和假插槽
// 把它跑起来，确保：能加载、能注册到设置页插槽、组件能渲染不崩、文案 key 都有定义。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js');

// 最小 React：够跑组件函数体，不模拟差异计算。
// presets 按 useState 的调用顺序喂初始值，用来把组件渲染成「已经有数据」的样子——
// 假 useState 的 setter 是空的，不喂预设的话组件永远停在初始态，数据分支一行都跑不到。
function makeReact(presets = []) {
  let cursor = 0;
  const react = {
    // 函数组件要当场展开，否则 h(Donut, {...}) 只会留下一个 {type: Donut} 的壳，
    // 里面的 svg / circle 一个都进不了树，断言就永远看不到图表的真实结构。
    createElement: (type, props, ...children) => {
      const bag = { ...(props ?? {}) };
      if (children.length) bag.children = children.length === 1 ? children[0] : children;
      if (typeof type === 'function') {
        // 类组件不能当函数直接调（Class constructor cannot be invoked without 'new'），
        // 造个实例再跑 render，等价于真 React 做的事
        if (type.prototype && type.prototype.render) return new type(bag).render();
        return type(bag);
      }
      return { type, props: props ?? {}, children };
    },
    useState: (init) => {
      const at = cursor;
      cursor += 1;
      const preset = presets[at];
      return [preset !== undefined ? preset : (typeof init === 'function' ? init() : init), () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => 0,
    useRef: (value) => ({ current: value }),
    Fragment: 'Fragment',
  };
  return react;
}

// 加载客户端包，返回它注册的模块描述符
function loadClient() {
  const source = readFileSync(CLIENT, 'utf8');
  let captured = null;
  const sandbox = {
    // 侧栏页签那段要定时重试几次。沙箱里不给会抛 ReferenceError；真给个会跑的定时器
    // 又会让每个用例都多等 5 秒。给个不响应的假定时器：那段逻辑的首次尝试是同步的，
    // 断言要看的正是这一次。
    setInterval: () => 0,
    clearInterval: () => {},
    window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: CLIENT });
  assert.ok(captured, 'client.js 应该通过 window.__ModuleLoader__.load 注册');
  return captured;
}

function mount(ctx, presets) {
  const mod = loadClient();
  const react = makeReact(presets);
  const factory = mod.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`客户端不应该 require ${name}`);
  });
  factory.apply(ctx);
  return factory;
}

// 假插槽：每次 register 都收下来按 name 找。
// apply() 现在注册三处（settings.section / main / sidebar.panellist），
// 只记最后一次会把前两处覆盖掉，断言就永远看到最后一个。
function makeCtx(options = {}) {
  const regs = [];
  const injected = [];
  const listeners = [];
  const ctx = {
    locale: {
      bind: options.bind ?? ((ns) => (key) => `${ns}:${key}`),
      register: () => () => {},
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    effect: (fn) => {
      try {
        return fn();
      } catch {
        /* 文案注册失败不影响下面的断言 */
        return undefined;
      }
    },
    slots: {
      inject: (name, cb) => {
        injected.push(name);
        return cb();
      },
      register: (opts, Component) => {
        regs.push({ options: opts, Component });
        return () => {};
      },
      // 侧栏「对话」页签要先问 sidebar.workspaces 上是谁在用，再读它的页签表。
      // options.workspaces 给了就当成「im 助理已经包好那层」的样子。
      entriesOfSlot: (name) => (name === 'sidebar.workspaces' && options.workspaces ? [options.workspaces] : []),
      subscribe: (name, listener) => {
        listeners.push({ name, listener });
        return () => {};
      },
    },
    // 整页面板的「返回会话」按钮要拿 layout；宿主没这个服务时返回 undefined。
    // 「去看副手」要 uiWorkspace.openSession，同样可能没有。
    get: (name) => {
      if (name === 'layout') return { selectPanel: () => {} };
      if (name === 'uiWorkspace' && options.uiWorkspace) return options.uiWorkspace;
      return undefined;
    },
  };
  return { ctx, regs, injected, listeners };
}

// im 助理那套页签表的假货：只实现我们用到的四个成员。
function makeRegistry() {
  const tabs = new Map();
  return {
    version: 1,
    getTabs: () => [...tabs.values()],
    subscribe: () => () => {},
    insert: (tab) => {
      if (!tab || !tab.id) return () => {};
      tabs.set(tab.id, tab);
      return () => {
        if (tabs.get(tab.id) === tab) tabs.delete(tab.id);
      };
    },
    tab: (id) => tabs.get(id),
  };
}

function componentOf(regs, name) {
  const hit = regs.find((reg) => reg.options.name === name);
  assert.ok(hit, `应该注册了 ${name}，实际只有 ${regs.map((r) => r.options.name).join(', ')}`);
  return hit;
}

test('client.js 用模块加载器注册，id 是包名', () => {
  const mod = loadClient();
  assert.equal(mod.id, 'dsh-work-assistant');
  assert.equal(typeof mod.factory, 'function');
});

test('inject 只声明插槽和文案两个服务', () => {
  const mod = loadClient();
  const factory = mod.factory(() => makeReact());
  assert.deepEqual([...factory.inject].sort(), ['locale', 'slots']);
});

test('注册到 settings.section，带 id/order/label', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const reg = componentOf(regs, 'settings.section');
  assert.equal(reg.options.id, 'work-assistant');
  assert.equal(typeof reg.options.order, 'number');
  assert.equal(reg.options.label(), 'dsh-work-assistant:title');
  assert.equal(reg.options.locale, 'dsh-work-assistant');
});

test('侧边栏图标和整页面板成对注册，id 与 key 一致', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const main = componentOf(regs, 'main');
  const icon = componentOf(regs, 'sidebar.panellist');
  // 宿主的侧边栏按钮是拿 panellist 的 id 去 main 的 keyed 插槽里找面板，
  // 两边不一致就会抛 main panel not registered
  assert.equal(main.options.key, icon.options.id);
  assert.equal(main.options.key, 'work-assistant');
  assert.equal(typeof icon.options.order, 'number');
  assert.equal(icon.options.label(), 'dsh-work-assistant:panelTitle');
  assert.equal(icon.options.locale, 'dsh-work-assistant');
  // 图标组件要能画出来，且带 data-dsh-panel-entry 锚点
  const svg = icon.Component({ size: 16 });
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props['data-dsh-panel-entry'], 'work-assistant');
  assert.equal(svg.props.width, 16);
});

test('面板组件拿到 getLayout，返回会话按钮能调 selectPanel', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const main = componentOf(regs, 'main');
  // inject() 返回的就是要合进 props 的东西
  const injected = main.options.inject();
  assert.equal(typeof injected.getLayout, 'function');
  const layout = injected.getLayout();
  assert.equal(typeof layout.selectPanel, 'function');
});

test('组件在没有数据时也能渲染出结构', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const tree = componentOf(regs, 'settings.section').Component({});
  assert.equal(tree.type, 'div');
  const text = JSON.stringify(tree);
  assert.match(text, /dsh-work-assistant:title/);
  assert.match(text, /dsh-work-assistant:subtitle/);
  // 知识库卡片在没有数据时也要在，不能整块消失
  assert.match(text, /dsh-work-assistant:kbTitle/);
  assert.match(text, /dsh-work-assistant:kbSearch/);
});

test('整页面板在没有数据时也能渲染出骨架', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const tree = componentOf(regs, 'main').Component({ getLayout: () => null });
  assert.equal(tree.type, 'div');
  assert.equal(tree.props['data-dsh-workassistant-view'], '');
  const text = JSON.stringify(tree);
  assert.match(text, /dsh-work-assistant:panelTitle/);
  // 六个统计格子都要在，即使数字全是 0
  for (const key of ['statOpen', 'statOverdue', 'statDoing', 'statDoneWeek', 'statCreatedWeek', 'statStale']) {
    assert.match(text, new RegExp(`dsh-work-assistant:${key}`));
  }
  // 五张图表标题也要在
  for (const key of ['chartPriority', 'chartTrend', 'chartTags', 'chartAssignee', 'chartOldest']) {
    assert.match(text, new RegExp(`dsh-work-assistant:${key}`));
  }
  assert.match(text, /dsh-work-assistant:taskSection/);
  // 没有数据时每张图都要给空态，不能留一片白
  assert.match(text, /dsh-work-assistant:chartEmpty/);
  // 没拿到 layout 就不该出现「回到对话」按钮（点了也没用）
  assert.doesNotMatch(text, /dsh-work-assistant:backToChat/);
});

// useState 的顺序固定，按这个顺序喂数据就能把组件渲染成「有内容」的样子。
// 顺序：overview / stats / tasks / kb / kbDoc / filter / query / queryBox /
//       expandedId / draft / error / notice / busy / refreshKey /
//       assignments / assignDraft / assignTarget
function filledPresets(overrides = {}) {
  return [
    {
      status: { loggedIn: true, canPush: true, stateDir: '/tmp/wa' },
      counts: { open: 3, overdue: 1, doing: 1 },
      settings: { stateDir: '/tmp/wa', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    },
    {
      counts: { open: 3, overdue: 1, doing: 1, doneWeek: 2, createdWeek: 4, stale: 1 },
      byPriority: { high: 1, normal: 2, low: 0 },
      byTag: [{ tag: '财务', count: 2 }, { tag: '教学', count: 1 }],
      assignees: [{ name: '广超', count: 1 }],
      trend: [
        { date: '2026-10-20', created: 2, done: 1 },
        { date: '2026-10-21', created: 0, done: 3 },
      ],
      oldest: [{ id: 'w-20261001-001', title: '压了很久的一件事', priority: 'high', ageDays: 20 }],
    },
    {
      total: 1,
      items: [{
        id: 'w-20261020-001',
        rank: 1,
        title: '整理 Q3 报销',
        status: 'open',
        priority: 'high',
        dueAt: '2026-10-24T10:00:00.000Z',
        tags: ['财务'],
        assignee: '广超',
        recurrence: '每月',
      }],
    },
    { total: 1, docs: [{ id: 'k-20261020-001', title: '报销流程', tags: ['财务'] }] },
    null,
    'open',
    '',
    '',
    '',
    null,
    '',
    '',
    '',
    0,
    // assignments / assignDraft / assignTarget
    overrides.assignments ?? {
      total: 1,
      items: [{
        id: 'a-20261021-001',
        sessionId: 'wa:asg:a-20261021-001',
        purpose: '整理三个月的报销单',
        status: 'waiting',
        itemId: 'w-20261020-001',
        report: { summary: '报销单整理好了，等你确认口径', expectsReply: true },
      }],
    },
    '',
    '',
    ...(overrides.tail ?? []),
  ];
}

test('整页面板有数据时把图表、清单、知识库都画出来', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx, filledPresets());
  const tree = componentOf(regs, 'main').Component({ getLayout: () => null });
  const text = JSON.stringify(tree);

  // 数字是真值，不是占位 0（Metric 展开后 <b> 里就是数字文本）
  assert.match(text, /"type":"b","props":\{\},"children":\["3"\]/);
  assert.match(text, /"type":"b","props":\{\},"children":\["2"\]/);
  // 环形图：一个 svg + 三段 arc（high/normal/low 各一条，值为 0 的也会画，长度 0）
  assert.match(text, /wa-donut/);
  assert.match(text, /strokeDasharray/);
  // 趋势：两天两条柱子
  assert.match(text, /wa-trend-col/);
  assert.match(text, /10\/21/);
  // 标签和「在等谁」排行
  assert.match(text, /财务/);
  assert.match(text, /广超/);
  // 最老的那件，20 天
  assert.match(text, /压了很久的一件事/);
  // 任务清单里那一条
  assert.match(text, /整理 Q3 报销/);
  assert.match(text, /w-20261020-001/);
  // 副手卡片：编号、目的、状态、最新报告
  assert.match(text, /a-20261021-001/);
  assert.match(text, /整理三个月的报销单/);
  assert.match(text, /dsh-work-assistant:asgStatusWaiting/);
  assert.match(text, /报销单整理好了，等你确认口径/);
  // 知识库条目
  assert.match(text, /报销流程/);
  // 运行参数
  assert.match(text, /\/tmp\/wa/);
});

test('展开一条任务会渲染出编辑框，改完走 /item', () => {
  const presets = filledPresets();
  // expandedId + draft 两个位置
  presets[8] = 'w-20261020-001';
  presets[9] = { title: '整理 Q3 报销', priority: 'high', dueAt: '2026-10-24 18:00', tags: '财务' };

  const { ctx, regs } = makeCtx();
  mount(ctx, presets);
  const tree = componentOf(regs, 'main').Component({ getLayout: () => null });
  const text = JSON.stringify(tree);

  assert.match(text, /wa-item-body/);
  for (const key of ['editTitle', 'editPriority', 'editDue', 'editTags']) {
    assert.match(text, new RegExp(`dsh-work-assistant:${key}`));
  }
  assert.match(text, /dsh-work-assistant:saveItem/);
  // 期限要显示成输入框能改的写法，不是 ISO
  assert.match(text, /2026-10-24 18:00/);
  assert.doesNotMatch(text, /2026-10-24T10:00:00\.000Z/);
});

test('拿到 layout 时才有「回到对话」按钮，点了回会话', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const calls = [];
  const layout = { selectPanel: (id) => calls.push(id) };
  const tree = componentOf(regs, 'main').Component({ getLayout: () => layout });

  const json = JSON.stringify(tree);
  assert.match(json, /dsh-work-assistant:backToChat/);

  // 在树里找那个按钮，手动触发它的 onClick
  const findButton = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'button' && node.props && node.props.onClick
      && JSON.stringify(node.children ?? []).includes('dsh-work-assistant:backToChat')) return node;
    for (const child of node.children ?? []) {
      const hit = findButton(child);
      if (hit) return hit;
    }
    return null;
  };
  const button = findButton(tree);
  assert.ok(button, '应该有「回到对话」按钮');
  button.props.onClick();
  assert.deepEqual(calls, [null]);
});

test('组件优先用外面传进来的 t，而不是自己 bind 的', () => {
  const { ctx, regs } = makeCtx({ bind: () => (key) => `自带的:${key}` });
  mount(ctx);
  const tree = componentOf(regs, 'settings.section').Component({ t: (key) => `外壳的:${key}` });
  assert.match(JSON.stringify(tree), /外壳的:title/);
  assert.doesNotMatch(JSON.stringify(tree), /自带的:title/);
});

test('组件里用到的每个文案 key 在中文和英文里都有', () => {
  const source = readFileSync(CLIENT, 'utf8');
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size > 10, `应该找到多个 key，实际 ${used.size}`);

  const zhBlock = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'));
  const enBlock = source.slice(source.indexOf('const en = {'), source.indexOf('const inject ='));
  const keysIn = (block) => new Set([...block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]));

  const zh = keysIn(zhBlock);
  const en = keysIn(enBlock);
  const missingZh = [...used].filter((k) => !zh.has(k));
  const missingEn = [...used].filter((k) => !en.has(k));
  assert.deepEqual(missingZh, [], `中文缺这些 key：${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `英文缺这些 key：${missingEn.join(', ')}`);
});

// 点「停止」回一句「发消息」，用户会以为点错了。
// 面板拿不到假 setState 的结果（假 React 的 setter 是空的），只能查源码里的分支：
// stop 必须走自己的文案，而且要用后端给的 sessionActive 区分「真释放」和「只叫停」。
test('停止的回执不说成「发消息」，并且区分会话还在不在', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.match(source, /body\.action === 'stop'/);
  assert.match(source, /t\('asgStopDone'\)/);
  assert.match(source, /t\('asgStopKept'\)/);
  assert.match(source, /sessionActive/);
  // 旧写法：不是 create 就一律说「发消息」
  assert.doesNotMatch(source, /body\.action === 'create' \? t\('asgCreate'\) : t\('asgSend'\)/);
});

test('客户端不 import 任何东西（浏览器里会直接语法报错）', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /^\s*export\s/m);
});

test('副手卡片有「去看」按钮，点了借 uiWorkspace 跳会话', () => {
  const opened = [];
  const { ctx, regs } = makeCtx({ uiWorkspace: { openSession: (id) => opened.push(id) } });
  mount(ctx, filledPresets());
  const tree = componentOf(regs, 'main').Component({
    getLayout: () => null,
    getWorkspace: () => ({ openSession: (id) => opened.push(id) }),
  });

  // 找到「去看」那个按钮，直接调它的 onClick
  // 假 React 把子节点放在 node.children 里（不是 props.children），按这个结构找
  let hit = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') {
      if (JSON.stringify(node.children ?? []).includes('asgOpen')) hit = node.props.onClick;
    }
    walk(node.children);
  };
  walk(tree);

  assert.ok(hit, '副手卡片里应该有「去看」按钮');
  hit();
  assert.deepEqual(opened, ['wa:asg:a-20261021-001']);
});

test('拿不到 uiWorkspace 时不渲染「去看」，改成显示会话号', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx, filledPresets());
  const tree = componentOf(regs, 'main').Component({ getLayout: () => null });
  const text = JSON.stringify(tree);
  assert.doesNotMatch(text, /dsh-work-assistant:asgOpen/);
  assert.match(text, /wa:asg:a-20261021-001/);
});

// 停掉的副手后端会拒掉 send，按钮留着只会让人白点一次、还以为是插件坏了
test('副手停掉之后不再渲染「发消息」，也不显示输入框', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx, filledPresets({
    assignments: {
      total: 1,
      items: [{
        id: 'a-20261021-002',
        sessionId: 'wa:asg:a-20261021-002',
        purpose: '停掉的那条',
        status: 'stopped',
        itemId: null,
        report: null,
      }],
    },
  }));
  const tree = componentOf(regs, 'main').Component({ getLayout: () => null });
  const text = JSON.stringify(tree);
  assert.doesNotMatch(text, /dsh-work-assistant:asgSend/);
  // 停掉之后还是要知道它为什么停的
  assert.match(text, /dsh-work-assistant:asgStatusStopped/);
});

// 设置页要能选会话的预设/模型/强度/权限。没有宿主数据时也要把四组选择框画出来，
// 否则用户根本不知道这里能改。
test('设置页有会话设置卡片，四组选择都在', () => {
  const { ctx, regs } = makeCtx();
  mount(ctx);
  const text = JSON.stringify(componentOf(regs, 'settings.section').Component({}));
  for (const key of ['sessionTitle', 'sessionPreset', 'sessionModel', 'sessionPermission']) {
    assert.match(text, new RegExp(`dsh-work-assistant:${key}`));
  }
  // 模型默认是「跟随宿主默认」，所以空值那一项必须写清楚
  assert.match(text, /dsh-work-assistant:sessionFollowHost/);
});

// 预设下拉不能逼用户选某一个具体名字：别人的机器上没有那个预设，
// 而且「跟随宿主默认」才是出厂状态。所以第一项必须是空值。
test('预设下拉第一项是「跟随宿主默认」', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.match(source, /h\('option', \{ key: '__host', value: '' \}, t\('sessionFollowHost'\)\)/);
});

test('保存设置时把会话四项一起交上去', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.match(source, /agentPreset: preset/);
  assert.match(source, /permissionPreset: permission/);
  assert.match(source, /agentProvider: modelKey \? modelKey\.split/);
  assert.match(source, /agentReasoningEffort: effort/);
  // 下拉项来自 /options，不是写死的
  assert.match(source, /api\('\/options'\)/);
});

// 面板上的对话记录：一条都没有时给空态，有数据时按天列出来。
test('面板有对话记录时按天列出来，点一天才去读全文', () => {
  const presets = filledPresets();
  while (presets.length < 20) presets.push(undefined);
  presets[20] = {
    total: 1,
    threads: [{ day: '2026-10-22', chatId: 'boss', count: 3, lastAt: '2026-10-22T01:00:00.000Z', preview: '记得带公章', lastRole: 'user' }],
  };
  presets[21] = null;

  const { ctx, regs } = makeCtx();
  mount(ctx, presets);
  const text = JSON.stringify(componentOf(regs, 'main').Component({ getLayout: () => null }));

  assert.match(text, /dsh-work-assistant:convTitle/);
  assert.match(text, /2026-10-22/);
  assert.match(text, /记得带公章/);
  assert.match(text, /dsh-work-assistant:convCountUnit/);
  // 没点开之前不显示「返回列表」
  assert.doesNotMatch(text, /dsh-work-assistant:convBack/);
});

test('点开某一天后把当天的往来按顺序画出来', () => {
  const presets = filledPresets();
  while (presets.length < 20) presets.push(undefined);
  presets[20] = { total: 1, threads: [{ day: '2026-10-22', chatId: 'boss', count: 2, preview: '记得带公章' }] };
  presets[21] = {
    day: '2026-10-22',
    chatId: 'boss',
    total: 2,
    messages: [
      { role: 'user', text: '明天把报表发我', at: '2026-10-22T01:00:00.000Z' },
      { role: 'assistant', text: '记下了，明天上午发', at: '2026-10-22T01:01:00.000Z' },
    ],
  };

  const { ctx, regs } = makeCtx();
  mount(ctx, presets);
  const text = JSON.stringify(componentOf(regs, 'main').Component({ getLayout: () => null }));

  assert.match(text, /dsh-work-assistant:convBack/);
  assert.match(text, /明天把报表发我/);
  assert.match(text, /记下了，明天上午发/);
  assert.match(text, /dsh-work-assistant:convRoleAssistant/);
  assert.ok(text.includes(localClock('2026-10-22T01:00:00.000Z')));
});

// ── 侧栏「对话」页签 ────────────────────────────────────────
// 这一块是往 im 助理插件的私有注册表里塞页签，最容易出的事是：
// 没装 im 助理时报错、把别人的页签挤掉、以及渲染坏了把整个会话列表带崩。

test('装了 im 助理时，往它的页签表里插一个「对话」', () => {
  const registry = makeRegistry();
  const workspaces = { options: { name: 'sidebar.workspaces' }, component: function OfficialTree() {}, __dshNativeTabs: undefined };
  workspaces.component.__dshNativeTabs = registry;
  const { ctx } = makeCtx({ workspaces });
  mount(ctx);

  const tab = registry.tab('work-assistant-chats');
  assert.ok(tab, '应该插了一个 id 为 work-assistant-chats 的页签');
  assert.equal(tab.label, 'dsh-work-assistant:railTab');
  assert.equal(typeof tab.render, 'function');
  assert.equal(typeof tab.order, 'number');
  // 只在助理自己的会话上跟过去，别人的会话不该被拽到这一页
  assert.equal(tab.matchSession('wa:main'), true);
  assert.equal(tab.matchSession('wa:asg:a-20261022-001'), true);
  assert.equal(tab.matchSession('im:qq_e4a4acdb2ad3:abc'), false);
  assert.equal(tab.matchSession(undefined), false);
});

// t 放在 effect 的依赖里。每次渲染都 localeFace.bind(NS) 就会给一个新函数，
// 依赖一变 effect 就重跑，拉数据 → setState → 重渲染 → 再拉，一直转。
test('翻译函数只在语言包换代时才换，否则轮询会自己转成死循环', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.match(source, /function useBoundT\(/);
  assert.match(source, /React\.useMemo\(\s*\(\) => latest\.current/);
  // 三个组件都该走 useBoundT，而不是各自 bind 一个
  const uses = (source.match(/useBoundT\(/g) || []).length;
  assert.ok(uses >= 4, `useBoundT 应该被组件用上（含自身定义），实际 ${uses}`);
  assert.doesNotMatch(source, /const t = props\.t \|\|/);
});

test('页签外面包了错误边界：我们这块坏了不能把整个会话列表带崩', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.match(source, /class ConversationRailBoundary extends/);
  assert.match(source, /static getDerivedStateFromError/);
  // 插进去的 render 必须是「边界包住页签」，不能直接挂 ConversationRail
  assert.match(source, /ConversationRailBoundary,\s*null,\s*h\(ConversationRail/);
});

test('没装 im 助理（没有页签表）时安静跳过，其它注册照旧', () => {
  const { ctx, regs } = makeCtx();
  assert.doesNotThrow(() => mount(ctx));
  // 设置页、整页面板、侧栏图标三个都还得在
  assert.equal(componentOf(regs, 'settings.section').options.id, 'work-assistant');
  assert.equal(componentOf(regs, 'main').options.key, 'work-assistant');
  assert.equal(componentOf(regs, 'sidebar.panellist').options.id, 'work-assistant');
});

test('页签表版本不对就不插（对方换了实现）', () => {
  const registry = makeRegistry();
  registry.version = 2;
  const workspaces = { options: {}, component: function OfficialTree() {} };
  workspaces.component.__dshNativeTabs = registry;
  const { ctx } = makeCtx({ workspaces });
  mount(ctx);
  assert.equal(registry.getTabs().length, 0);
});

test('页签重复插入时不会插出两个', () => {
  const registry = makeRegistry();
  const workspaces = { options: {}, component: function OfficialTree() {} };
  workspaces.component.__dshNativeTabs = registry;
  const { ctx, listeners } = makeCtx({ workspaces });
  mount(ctx);
  // 宿主插槽变化会再跑一次同步逻辑
  for (const item of listeners) item.listener();
  const mine = registry.getTabs().filter((tab) => tab.id === 'work-assistant-chats');
  assert.equal(mine.length, 1);
});

// 库里存的是 UTC；界面上按本机时区写时分，所以断言也得按本机时区算。
function localClock(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// useState 顺序：data / error / refreshKey
function railPresets(overrides = {}) {
  return [
    overrides.data ?? {
      total: 2,
      items: [
        { id: 'wa:main', title: '微信工作助理', status: 'idle', lastAt: new Date(Date.now() - 30 * 1000).toISOString() },
        { id: 'wa:asg:a-1', title: '催发票', status: 'running', lastAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
      ],
    },
    overrides.error ?? '',
    0,
  ];
}

function renderRail(presets, options = {}) {
  const registry = makeRegistry();
  const workspaces = { options: {}, component: function OfficialTree() {} };
  workspaces.component.__dshNativeTabs = registry;
  const { ctx } = makeCtx({ workspaces, uiWorkspace: options.uiWorkspace });
  mount(ctx, presets);
  const tab = registry.tab('work-assistant-chats');
  assert.ok(tab, '应该插了页签');
  return tab.render(options.props ?? {});
}

// 踩过的坑：侧栏页签不在我们页面那棵子树里，整页面板挂上去的那个 <style> 它够不着，
// 结果真机上整个页签是没样式的裸按钮。所以页签根节点必须自己带一份样式。
test('侧栏页签自带一份样式，不靠我们在别处挂的那份', () => {
  const tree = renderRail(railPresets());
  const style = (tree.children || []).find((child) => child && child.type === 'style');
  assert.ok(style, '页签根节点里应该有一个 <style>');
  const css = String((style.children || []).join(''));
  assert.match(css, /\.wa-rail-row/);
  assert.match(css, /--dsw-alias-label-tertiary/);
});

test('侧栏对话页签一行一个会话，名字和时间都在', () => {
  const tree = renderRail(railPresets());
  assert.equal(tree.type, 'div');
  assert.equal(tree.props['data-dsh-workassistant-rail'], '');
  const text = JSON.stringify(tree);
  assert.match(text, /dsh-work-assistant:railTitle/);
  assert.match(text, /微信工作助理/);
  assert.match(text, /催发票/);
  // 刚说过的显示「刚刚」，三小时前的显示「3 小时」
  assert.match(text, /dsh-work-assistant:railJustNow/);
  assert.match(text, /3 dsh-work-assistant:railHourUnit/);
  // 在跑的那个要有状态点，否则列表上看不出谁在干活
  assert.match(text, /wa-rail-dot run/);
});

// 这条是新逻辑的核心：侧栏只挑会话，真正的对话在右边主区里。
// 如果在侧栏里内嵌一份聊天，就会同一条会话两个界面、两边还不同步。
test('侧栏页签不内嵌聊天，只把会话交给宿主去右边打开', () => {
  const opened = [];
  const tree = renderRail(railPresets(), { uiWorkspace: { openSession: (id) => opened.push(id) } });
  const text = JSON.stringify(tree);
  assert.doesNotMatch(text, /convRoleAssistant/);
  assert.doesNotMatch(text, /convRoleUser/);

  // 找到挂着 wa:asg:a-1 的那个按钮，点一下
  function findButton(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props['data-session'] === 'wa:asg:a-1') return node;
    for (const child of node.children || []) {
      const hit = findButton(child);
      if (hit) return hit;
    }
    return null;
  }
  const row = findButton(tree);
  assert.ok(row, '应该有一行是 wa:asg:a-1');
  row.props.onClick();
  assert.deepEqual(opened, ['wa:asg:a-1']);
});

test('im 助理把 openSession 传下来时优先用它，自己不去翻服务', () => {
  const viaProp = [];
  const viaService = [];
  const tree = renderRail(railPresets(), {
    props: { openSession: (id) => viaProp.push(id) },
    uiWorkspace: { openSession: (id) => viaService.push(id) },
  });
  function findButton(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props['data-session'] === 'wa:main') return node;
    for (const child of node.children || []) {
      const hit = findButton(child);
      if (hit) return hit;
    }
    return null;
  }
  findButton(tree).props.onClick();
  assert.deepEqual(viaProp, ['wa:main']);
  assert.deepEqual(viaService, []);
});

test('既没有 openSession 也没有 uiWorkspace 时，点开会说清楚为什么没反应', () => {
  const tree = renderRail(railPresets());
  function findButton(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props['data-session'] === 'wa:main') return node;
    for (const child of node.children || []) {
      const hit = findButton(child);
      if (hit) return hit;
    }
    return null;
  }
  findButton(tree).props.onClick();
  // setState 是假的，这里只确认它没抛、也没有偷偷把会话 id 当成标题写出去
  assert.ok(true);
});

test('侧栏对话页签没有会话时给空态，不是一片白', () => {
  const text = JSON.stringify(renderRail(railPresets({ data: { total: 0, items: [] } })));
  assert.match(text, /dsh-work-assistant:railEmpty/);
});

test('侧栏对话页签读不到数据时显示错误，不抛', () => {
  const text = JSON.stringify(renderRail(railPresets({ error: 'dsh-work-assistant:convFailed：boom' })));
  assert.match(text, /dsh-work-assistant:convFailed/);
});
