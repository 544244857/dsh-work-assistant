import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listDocs, readDoc, search, seedKb, writeDoc } from '../lib/kb.js';
import { dataPaths } from '../lib/paths.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-20T03:00:00.000Z');

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'dwa-kb-'));
  return { paths: dataPaths(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('writeDoc 生成 id、落库、能按 id 读回来', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const a = await writeDoc(paths, { title: 'Q3 报销流程', content: '先在系统里提交，再找财务盖章。', tags: ['报销', '财务'] }, NOW, TZ);
    assert.equal(a.id, 'k-20261020-001');

    const back = await readDoc(paths, 'k-20261020-001');
    assert.equal(back.title, 'Q3 报销流程');
    assert.deepEqual(back.tags, ['报销', '财务']);

    const b = await writeDoc(paths, { title: '周报模板', content: '本周完成 / 下周计划 / 风险。' }, NOW, TZ);
    assert.equal(b.id, 'k-20261020-002');

    const listed = await listDocs(paths);
    assert.equal(listed.total, 2);
  } finally {
    cleanup();
  }
});

test('writeDoc 缺标题或正文直接抛错', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await assert.rejects(() => writeDoc(paths, { title: '', content: 'x' }, NOW, TZ), /title/);
    await assert.rejects(() => writeDoc(paths, { title: 'x', content: '   ' }, NOW, TZ), /content/);
  } finally {
    cleanup();
  }
});

test('search 标题命中权重高于正文，返回 snippet', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await writeDoc(paths, { title: '报销流程说明', content: '照着做就行。', tags: ['财务'] }, NOW, TZ);
    await writeDoc(paths, { title: '周报模板', content: '这里提到一次报销，别的地方还有报销两个字。' }, NOW, TZ);

    const hits = await search(paths, '报销');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, '报销流程说明');
    assert.ok(hits[0].score > hits[1].score);
    assert.match(hits[1].snippet, /报销/);
  } finally {
    cleanup();
  }
});

test('search 支持标签过滤与 limit', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await writeDoc(paths, { title: '发票要求', content: '需要抬头。', tags: ['财务'] }, NOW, TZ);
    await writeDoc(paths, { title: '部署流程', content: '先备份再发版。', tags: ['研发'] }, NOW, TZ);
    await writeDoc(paths, { title: '发票红冲', content: '走线下。', tags: ['财务'] }, NOW, TZ);

    const finance = await search(paths, '发票', { tags: ['财务'] });
    // 两篇同分同时间，顺序不稳定，只校验集合
    assert.deepEqual(finance.map((h) => h.title).sort(), ['发票红冲', '发票要求']);

    const limited = await search(paths, '发票', { limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    cleanup();
  }
});

test('search 空查询按更新时间倒序列出', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await writeDoc(paths, { title: '旧文档', content: 'a' }, new Date('2026-10-19T03:00:00.000Z'), TZ);
    await writeDoc(paths, { title: '新文档', content: 'b' }, NOW, TZ);

    const hits = await search(paths, '');
    assert.deepEqual(hits.map((h) => h.title), ['新文档', '旧文档']);
  } finally {
    cleanup();
  }
});

test('readDoc 返回去掉 front matter 的正文', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    const { id } = await writeDoc(paths, { title: '合同口径', content: '第一条：金额含税。\n第二条：含运费。', tags: ['合同'] }, NOW, TZ);
    const doc = await readDoc(paths, id);
    assert.equal(doc.title, '合同口径');
    assert.deepEqual(doc.tags, ['合同']);
    assert.equal(doc.content, '第一条：金额含税。\n第二条：含运费。');
    assert.ok(!doc.content.includes('---'));
  } finally {
    cleanup();
  }
});

test('readDoc 对不存在的 id 返回 null', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.equal(await readDoc(paths, 'k-19700101-001'), null);
  } finally {
    cleanup();
  }
});

test('listDocs 统计总数并按更新时间倒序', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    await writeDoc(paths, { title: 'A', content: 'a' }, new Date('2026-10-18T03:00:00.000Z'), TZ);
    await writeDoc(paths, { title: 'B', content: 'b' }, NOW, TZ);

    const listed = await listDocs(paths, { limit: 1 });
    assert.equal(listed.total, 2);
    assert.equal(listed.docs.length, 1);
    assert.equal(listed.docs[0].title, 'B');
  } finally {
    cleanup();
  }
});

test('空目录下 search/list 不报错', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    assert.deepEqual(await search(paths, '随便'), []);
    assert.equal((await listDocs(paths)).total, 0);
  } finally {
    cleanup();
  }
});

// 老版本把知识库存在 kb/index.json + kb/*.md 里，升级后要能一次性搬进数据库
test('seedKb 把老的 md 正文灌进库，库里已有内容就不动', async () => {
  const { paths, cleanup } = tempPaths();
  try {
    mkdirSync(paths.kbDir, { recursive: true });
    writeFileSync(join(paths.kbDir, 'k-20261020-001.md'), '甲方乙方约定如下内容', 'utf8');
    const index = {
      version: 1,
      seq: { 20261020: 1 },
      docs: {
        'k-20261020-001': { title: '合同模板', tags: ['合同'], file: join(paths.kbDir, 'k-20261020-001.md'), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      },
    };
    const readFileText = (file) => readFileSync(file, 'utf8');

    const first = await seedKb(paths, index, readFileText, { log: () => {} });
    assert.equal(first.seeded, true);
    assert.equal(first.docs, 1);

    const docs = await listDocs(paths);
    assert.equal(docs.total, 1);
    assert.equal(docs.docs[0].title, '合同模板');

    const again = await seedKb(paths, index, readFileText, { log: () => {} });
    assert.equal(again.seeded, false, '第二次不该重复灌');
  } finally {
    cleanup();
  }
});
