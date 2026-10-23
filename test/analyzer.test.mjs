import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../lib/paths.js';
import { createStore } from '../lib/store.js';
import { addItem } from '../lib/ledger.js';
import { writeDoc } from '../lib/kb.js';
import { countGraph, queryPeople } from '../lib/graph.js';
import {
  buildAnalysisPrompt,
  countPending,
  createAnalyzer,
  parseExtraction,
  parseDailyTime,
  recordMessage,
} from '../lib/analyzer.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-22T03:00:00.000Z'); // 北京时间 11:00

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-analyzer-'));
  return { paths: dataPaths(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parseAnalysisJson 认得纯 JSON、代码块和前后夹话', () => {
  assert.equal(parseExtraction('{"people":[],"relations":[]}').people.length, 0);
  assert.equal(parseExtraction('```json\n{"people":[{"name":"张三"}],"relations":[]}\n```').people[0].name, '张三');
  assert.equal(parseExtraction('好的，结果如下：{"people":[{"name":"李四"}],"relations":[]} 完毕').people[0].name, '李四');
  // 认不出来就抛：这种要当这次分析失败、消息留着重跑，
  // 不能悄悄返回空数组然后假装「材料里没什么人」
  assert.throws(() => parseExtraction('这不是 JSON'), /不是 JSON/);
  assert.throws(() => parseExtraction(''), /没有返回内容/);
  assert.throws(() => parseExtraction('{"people":[{"name":"张'), /不是 JSON|不完整/);
});

test('parseAnalysisJson 丢掉没有名字的人和自指关系，关系类型不认识归 other', () => {
  const parsed = parseExtraction(
    JSON.stringify({
      people: [{ name: '甲' }, { name: '' }, { name: '乙', kind: 'org' }],
      relations: [
        { from: '甲', to: '甲', type: 'colleague' },
        { from: '甲', to: '乙', type: '不明关系' },
      ],
    }),
  );
  assert.equal(parsed.people.length, 2);
  assert.equal(parsed.people[1].kind, 'org');
  assert.equal(parsed.relations.length, 1);
  assert.equal(parsed.relations[0].type, 'other');
});

test('buildAnalysisPrompt 把关系词表和已知的人写进去', () => {
  const prompt = buildAnalysisPrompt('【最近的聊天】\n- 舒子淇周五值班', ['舒子淇']);
  assert.match(prompt, /subordinate=下属/);
  assert.match(prompt, /client=客户/);
  assert.match(prompt, /已经认识的人/);
  assert.match(prompt, /只输出 JSON/);
});

test('parseDailyTime 认 03:00，拒 25:00 和乱写', () => {
  assert.deepEqual(parseDailyTime('03:00'), { hour: 3, minute: 0 });
  assert.equal(parseDailyTime('25:00'), null);
  assert.equal(parseDailyTime('早上'), null);
});

test('recordMessage 存空消息不落库，正常消息进未分析池', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.equal(await recordMessage(paths, { text: '   ' }, { log: () => {} }), null);
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '周五让舒子淇值班', at: NOW.toISOString() }, { log: () => {} });
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '彭喻负责周三', at: NOW.toISOString() }, { log: () => {} });
    assert.equal(await countPending(paths, { log: () => {} }), 2);
  } finally {
    cleanup();
  }
});

test('跑一次分析：抽人、落库、消息标已分析、推一条提示', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '值班还是舒子淇、彭喻他们五个轮', at: NOW.toISOString() }, { log: () => {} });
    const sent = [];
    let asked = '';
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      notify: async (text) => {
        sent.push(text);
        return true;
      },
      complete: async ({ user }) => {
        asked = user;
        return JSON.stringify({
          people: [{ name: '舒子淇', note: '周五值班', confidence: 0.8 }, { name: '彭喻', confidence: 0.6 }],
          relations: [{ from: '舒子淇', to: '用户', type: 'subordinate', evidence: '值班还是舒子淇' }],
        });
      },
    });

    const result = await analyzer.run('manual');
    assert.equal(result.ok, true);
    // 舒子淇、彭喻，加上关系里冒出来的「用户」
    assert.equal(result.people, 3);

    assert.match(asked, /舒子淇、彭喻/, '提示词里要带上原文');
    const people = await queryPeople(paths, { log: () => {} });
    // 名单里只列联系人：用户被标成 self，不进名单，但关系里照样存在
    assert.equal(people.total, 2, '舒子淇、彭喻');
    assert.deepEqual(people.people.map((p) => p.name).sort(), ['彭喻', '舒子淇']);
    const counts = await countGraph(paths, { log: () => {} });
    assert.equal(counts.relations, 1);

    assert.equal(await countPending(paths, { log: () => {} }), 0, '分析过的消息不再重复喂');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /舒子淇/);

    const status = await analyzer.status();
    assert.equal(status.lastRun.status, 'done');
    assert.equal(status.lastRun.trigger, 'manual');
  } finally {
    cleanup();
  }
});

test('模型抽不出人时不瞎推消息', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '今天天气不错', at: NOW.toISOString() }, { log: () => {} });
    const sent = [];
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      notify: async (text) => {
        sent.push(text);
        return true;
      },
      complete: async () => '{"people":[],"relations":[]}',
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, true);
    assert.equal(result.people, 0);
    assert.equal(sent.length, 0);
    assert.equal(await countPending(paths, { log: () => {} }), 0, '空结果也算分析过，否则会一直重试');
  } finally {
    cleanup();
  }
});

test('模型调用失败时如实记 failed，消息留在池子里等下次', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '舒子淇周五值班', at: NOW.toISOString() }, { log: () => {} });
    const logs = [];
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      log: (line) => logs.push(line),
      timeZone: TZ,
      now: () => NOW,
      complete: async () => {
        throw new Error('模型调用失败：upstream 504');
      },
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, false);
    assert.match(result.reason, /upstream 504/);
    assert.equal(await countPending(paths, { log: () => {} }), 1, '失败不能把消息标成已分析');
    const status = await analyzer.status();
    assert.equal(status.lastRun.status, 'failed');
    assert.match(status.lastRun.error, /upstream 504/);
    assert.ok(logs.some((line) => line.includes('失败')));
  } finally {
    cleanup();
  }
});

test('没有原料时跑一次直接算 empty，不调模型', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    let called = 0;
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      complete: async () => {
        called += 1;
        return '{"people":[],"relations":[]}';
      },
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, true);
    assert.equal(called, 0);
    const status = await analyzer.status();
    assert.equal(status.lastRun.status, 'empty');
  } finally {
    cleanup();
  }
});

test('工作项和知识库也算原料：光有工作项就能分析', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const store = createStore(paths, { log: () => {} });
    await store.mutate((ledger) => {
      addItem(ledger, { title: '催广超要发票', detail: '广超说周五给' }, NOW, TZ);
      return null;
    });
    await writeDoc(paths, { title: '值班表排法', content: '值班共 5 人：舒子淇、彭喻、肖航、余鹏、曹曼。' }, NOW, TZ);

    let asked = '';
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      complete: async ({ user }) => {
        asked = user;
        return '{"people":[],"relations":[]}';
      },
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, true);
    assert.match(asked, /催广超要发票/);
    assert.match(asked, /值班共 5 人/);
  } finally {
    cleanup();
  }
});

test('每天到点才跑一次，同一天不重复', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    let calls = 0;
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true, analysisDailyTime: '10:00', analysisIdleMinutes: 0 },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      complete: async () => {
        calls += 1;
        return '{"people":[],"relations":[]}';
      },
    });
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '随便一句', at: NOW.toISOString() }, { log: () => {} });

    // 北京时间 11:00，已经过了 10:00
    const first = await analyzer.tick();
    assert.ok(first, '到点应该跑');
    assert.equal(calls, 1);

    const second = await analyzer.tick();
    assert.equal(second, null, '同一天不再跑');
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});

test('没到点不跑', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true, analysisDailyTime: '23:00', analysisIdleMinutes: 0 },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      complete: async () => '{"people":[],"relations":[]}',
    });
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '随便一句', at: NOW.toISOString() }, { log: () => {} });
    assert.equal(await analyzer.tick(), null);
  } finally {
    cleanup();
  }
});

test('闲时分析：消息够静了才跑', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    let calls = 0;
    const at = new Date('2026-10-22T02:30:00.000Z');
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true, analysisDailyTime: '23:00', analysisIdleMinutes: 30 },
      log: () => {},
      timeZone: TZ,
      now: () => at,
      complete: async () => {
        calls += 1;
        return '{"people":[],"relations":[]}';
      },
    });
    // 10 分钟前刚说过话：还不算闲
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '刚说完', at: new Date(at.getTime() - 10 * 60 * 1000).toISOString() }, { log: () => {} });
    assert.equal(await analyzer.tick(), null);

    // 40 分钟前说过话：够闲了
    const later = new Date(at.getTime() + 30 * 60 * 1000);
    const analyzer2 = createAnalyzer({
      paths,
      config: { analysisEnabled: true, analysisDailyTime: '23:00', analysisIdleMinutes: 30 },
      log: () => {},
      timeZone: TZ,
      now: () => later,
      complete: async () => {
        calls += 1;
        return '{"people":[],"relations":[]}';
      },
    });
    const ran = await analyzer2.tick();
    assert.ok(ran, '够闲就该跑');
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});

test('关掉开关就什么都不跑', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: false, analysisDailyTime: '00:00', analysisIdleMinutes: 0 },
      log: () => {},
      timeZone: TZ,
      now: () => NOW,
      complete: async () => '{"people":[],"relations":[]}',
    });
    await recordMessage(paths, { chatId: 'u1', role: 'user', text: '随便一句', at: NOW.toISOString() }, { log: () => {} });
    assert.equal(await analyzer.tick(), null);
  } finally {
    cleanup();
  }
});

function fakeCtx(chunks) {
  return {
    get(name) {
      if (name === 'llm') {
        return {
          stream() {
            return (async function* run() {
              for (const chunk of chunks) yield chunk;
            })();
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
}

test('模型夹了一段「我先想一下」的 reasoning，不会把正文 JSON 弄脏', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'c1', role: 'user', text: '王伟是设计部的', at: NOW.toISOString() }, {});
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      now: () => NOW,
      ctx: fakeCtx([
        { type: 'block-end', block: { type: 'reasoning', text: '我先想一下：{"people":[{"name":"错的人"}]}' } },
        { type: 'text-delta', text: '{"people":[{"name":"王伟","note":"设计部"}],"relations":[]}' },
        { type: 'finish', reason: { kind: 'completed' } },
      ]),
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, true);
    assert.equal(result.people, 1);
    const people = await queryPeople(paths, {});
    assert.deepEqual(people.people.map((p) => p.name), ['王伟']);
  } finally {
    cleanup();
  }
});

test('模型输出被 max-tokens 截断时算失败，消息留着重跑', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'c1', role: 'user', text: '舒子淇负责周三值班', at: NOW.toISOString() }, {});
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      now: () => NOW,
      ctx: fakeCtx([
        { type: 'text-delta', text: '{"people":[{"name":"舒子' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]),
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, false);
    assert.match(result.reason, /截断/);
    assert.equal(await countPending(paths, {}), 1);
  } finally {
    cleanup();
  }
});

test('模型返回一堆人话而不是 JSON 时算失败，不会把消息标成已分析', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await recordMessage(paths, { chatId: 'c1', role: 'user', text: '值班名单：舒子淇、彭喻', at: NOW.toISOString() }, {});
    const analyzer = createAnalyzer({
      paths,
      config: { analysisEnabled: true },
      now: () => NOW,
      complete: async () => '好的，我看了一下，材料里主要是值班安排。',
    });
    const result = await analyzer.run('manual');
    assert.equal(result.ok, false);
    assert.match(result.reason, /不是 JSON/);
    assert.equal(await countPending(paths, {}), 1);
  } finally {
    cleanup();
  }
});
