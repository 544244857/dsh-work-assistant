import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../lib/paths.js';
import {
  clearGraph,
  countGraph,
  mergeExtraction,
  normName,
  queryPeople,
  queryPerson,
  renderPeopleList,
  renderPersonCard,
} from '../lib/graph.js';

const NOW = new Date('2026-10-22T10:00:00.000Z');

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'wa-graph-'));
  return { paths: dataPaths(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('mergeExtraction 建人、建关系，并能按名字查回来', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const result = await mergeExtraction(
      paths,
      {
        people: [
          { name: '舒子淇', note: '周五值班', confidence: 0.8 },
          { name: '彭喻', confidence: 0.6 },
        ],
        relations: [
          { from: '舒子淇', to: '用户', type: 'subordinate', evidence: '值班表：舒子淇', confidence: 0.7 },
        ],
      },
      { now: NOW, log: () => {} },
    );
    // 关系里出现的「用户」也会被建成实体，所以新增的是 3 个
    assert.equal(result.addedPeople, 3);
    assert.equal(result.addedRelations, 1);

    const counts = await countGraph(paths, { log: () => {} });
    // 关系里冒出来的「用户」也会被建成一个实体，所以是 3 个人
    assert.equal(counts.people, 3);
    assert.equal(counts.relations, 1);

    const person = await queryPerson(paths, '舒子淇', { log: () => {} });
    assert.equal(person.entity.name, '舒子淇');
    assert.equal(person.relations.length, 1);
    assert.equal(person.relations[0].label, '下属');
    assert.equal(person.relations[0].other.name, '用户');
    assert.equal(person.relations[0].direction, 'out');
  } finally {
    cleanup();
  }
});

test('同一个人换个写法不会重复建，别名和提及次数会累加', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(paths, { people: [{ name: '张 三', note: '客户' }] }, { now: NOW, log: () => {} });
    await mergeExtraction(paths, { people: [{ name: '张三。', aliases: ['张总'] }] }, { now: NOW, log: () => {} });

    const people = await queryPeople(paths, { log: () => {} });
    assert.equal(people.total, 1, '去空白去标点后是同一个人');
    assert.equal(people.people[0].mentions, 2);
    assert.ok(people.people[0].aliases.includes('张总'));
    assert.equal(people.people[0].note, '客户', '已有备注不被空备注覆盖');
  } finally {
    cleanup();
  }
});

test('只记得一部分名字也能查到人', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(paths, { people: [{ name: '舒子淇' }, { name: '肖航' }] }, { now: NOW, log: () => {} });
    const found = await queryPerson(paths, '子淇', { log: () => {} });
    assert.equal(found.entity.name, '舒子淇');
    const missing = await queryPerson(paths, '不存在的人', { log: () => {} });
    assert.equal(missing, null);
  } finally {
    cleanup();
  }
});

test('关系方向分得清：别人认到用户头上时是 in', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(
      paths,
      { people: [{ name: '广超' }], relations: [{ from: '用户', to: '广超', type: 'superior' }] },
      { now: NOW, log: () => {} },
    );
    const person = await queryPerson(paths, '广超', { log: () => {} });
    assert.equal(person.relations[0].direction, 'in');
    assert.equal(person.relations[0].label, '上级');
  } finally {
    cleanup();
  }
});

test('不认识的关系类型落到 other，不会丢关系', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(
      paths,
      { people: [{ name: '甲' }, { name: '乙' }], relations: [{ from: '甲', to: '乙', type: '宿敌' }] },
      { now: NOW, log: () => {} },
    );
    const person = await queryPerson(paths, '甲', { log: () => {} });
    assert.equal(person.relations[0].label, '其他');
  } finally {
    cleanup();
  }
});

test('一次抽取里自己指向自己、缺名字的关系直接丢掉', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const result = await mergeExtraction(
      paths,
      {
        people: [{ name: '甲' }, { name: '   ' }],
        relations: [
          { from: '甲', to: '甲', type: 'colleague' },
          { from: '', to: '甲', type: 'colleague' },
        ],
      },
      { now: NOW, log: () => {} },
    );
    assert.equal(result.addedPeople, 1);
    assert.equal(result.addedRelations, 0);
  } finally {
    cleanup();
  }
});

test('normName 把空白和标点都抹平', () => {
  assert.equal(normName('  张 三。 '), '张三');
  assert.equal(normName(''), '');
  assert.equal(normName(null), '');
});

test('renderPeopleList 空库给人话，有数据时带关系数', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.match(renderPeopleList({ total: 0, people: [] }), /还没有人/);

    await mergeExtraction(
      paths,
      { people: [{ name: '舒子淇' }], relations: [{ from: '舒子淇', to: '用户', type: 'subordinate' }] },
      { now: NOW, log: () => {} },
    );
    const data = await queryPeople(paths, { log: () => {} });
    const line = renderPeopleList(data);
    assert.match(line, /舒子淇/);
    assert.match(line, /1 条关系/);
  } finally {
    cleanup();
  }
});

test('renderPersonCard 说清关系、证据和别名', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(
      paths,
      {
        people: [{ name: '舒子淇', aliases: ['子淇'], note: '周五值班' }],
        relations: [{ from: '舒子淇', to: '用户', type: 'subordinate', evidence: '值班表：舒子淇、彭喻' }],
      },
      { now: NOW, log: () => {} },
    );
    const person = await queryPerson(paths, '舒子淇', { log: () => {} });
    const card = renderPersonCard(person);
    assert.match(card, /舒子淇/);
    assert.match(card, /下属/);
    assert.match(card, /值班表/);
    assert.match(card, /子淇/);
  } finally {
    cleanup();
  }
});

test('clearGraph 清空人和关系', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(
      paths,
      { people: [{ name: '甲' }], relations: [{ from: '甲', to: '乙', type: 'colleague' }] },
      { now: NOW, log: () => {} },
    );
    await clearGraph(paths, { log: () => {} });
    const counts = await countGraph(paths, { log: () => {} });
    assert.equal(counts.people, 0);
    assert.equal(counts.relations, 0);
  } finally {
    cleanup();
  }
});

test('同一次抽取里，人的备注和把握度不会被关系端点那次 upsert 抹掉', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(paths, {
      people: [{ name: '王伟', note: '设计部，负责海报', confidence: 0.9 }],
      relations: [{ from: '王伟', to: '用户', type: 'subordinate', confidence: 0.6 }],
    }, { now: NOW, log: () => {} });
    const card = await queryPerson(paths, '王伟', {});
    assert.equal(card.entity.note, '设计部，负责海报');
    assert.ok(Number(card.entity.confidence) >= 0.9);
  } finally {
    cleanup();
  }
});

test('同一对人换了关系类型时，只留最新那条，不会两个说法并存', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await mergeExtraction(paths, {
      people: [{ name: '余鹏' }],
      relations: [{ from: '余鹏', to: '用户', type: 'colleague' }],
    }, { now: NOW, log: () => {} });
    await mergeExtraction(paths, {
      people: [{ name: '余鹏' }],
      relations: [{ from: '余鹏', to: '用户', type: 'subordinate' }],
    }, { now: new Date(NOW.getTime() + 1000), log: () => {} });
    const card = await queryPerson(paths, '余鹏', {});
    assert.deepEqual(card.relations.map((r) => r.type), ['subordinate']);
  } finally {
    cleanup();
  }
});
