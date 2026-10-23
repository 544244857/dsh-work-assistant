// 知识图谱：人和人之间的关系。
//
// 为什么单独一层：知识库文档是「一段话」，而「舒子淇是我的同事」是结构化的东西，
// 得能按人查、按关系查。存在 entities / relations 两张表里，抽取由 lib/analyzer.js 干。
import { openDb, replaceRows, tx, withDb } from './db.js';

// 关系类型是闭合的：让模型在一组固定词里选，比自由发挥好统计也好读
// 关系里的「另一端」是用户自己，不当联系人列出来
// 老数据里的关系端点写的是「老板」，两个都认，否则升级后旧档案会多出一个人
const SELF_NAMES = ['用户', '老板', '我', '自己', '本人'];

export const RELATION_TYPES = {
  colleague: '同事',
  subordinate: '下属',
  superior: '上级',
  client: '客户',
  partner: '合作方',
  friend: '朋友',
  family: '家人',
  other: '其他',
};

export const ENTITY_KINDS = {
  person: '人',
  self: '本人',
  org: '组织',
};

export function relationLabel(type) {
  return RELATION_TYPES[type] ?? RELATION_TYPES.other;
}

export function kindLabel(kind) {
  return ENTITY_KINDS[kind] ?? ENTITY_KINDS.person;
}

// 归一化：去空白、去标点、统一小写。用它判「是不是同一个人」，
// 所以「张 三」「张三」「张三。」都会落到同一条记录上。
export function normName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.,，。:：;；!！?？'"'""''()（）[\]【】<>《》]/g, '');
}

const PERSON_COLUMNS = ['id', 'name', 'norm', 'kind', 'aliases', 'note', 'confidence', 'mentions', 'first_seen', 'last_seen'];
const RELATION_COLUMNS = ['id', 'from_id', 'to_id', 'type', 'note', 'evidence', 'confidence', 'created_at', 'updated_at'];

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

function newId(prefix, seed) {
  return `${prefix}-${seed}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// 一个人的完整档案：自己 + 所有相关关系（两个方向都算）
export async function queryPerson(paths, query, options = {}) {
  const needle = normName(query);
  if (!needle) return null;
  return withDb(paths, { log: options.log }, (db) => {
    // 先按归一化名精确匹配，再退回包含匹配（比如只记得「子淇」）
    let row = db.prepare('SELECT * FROM entities WHERE norm = ?').get(needle);
    if (!row) {
      // 把 % 和 _ 转义掉：查「王%」不该把人全捞出来
      const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const like = `%${escaped}%`;
      row = db.prepare('SELECT * FROM entities WHERE norm LIKE ? ORDER BY mentions DESC LIMIT 1').get(like);
    }
    if (!row) return null;
    const entity = rowToEntity(row);

    const outgoing = db
      .prepare(
        `SELECT r.*, e.name AS other_name, e.kind AS other_kind
         FROM relations r JOIN entities e ON e.id = r.to_id
         WHERE r.from_id = ? ORDER BY r.updated_at DESC`,
      )
      .all(entity.id);
    const incoming = db
      .prepare(
        `SELECT r.*, e.name AS other_name, e.kind AS other_kind
         FROM relations r JOIN entities e ON e.id = r.from_id
         WHERE r.to_id = ? ORDER BY r.updated_at DESC`,
      )
      .all(entity.id);

    return {
      entity,
      relations: [
        ...outgoing.map((r) => relationFromRow(r, 'out')),
        ...incoming.map((r) => relationFromRow(r, 'in')),
      ],
    };
  });
}

function rowToEntity(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind ?? 'person',
    aliases: safeJson(row.aliases, []),
    note: row.note ?? '',
    confidence: Number(row.confidence ?? 0.5),
    mentions: Number(row.mentions ?? 1),
    firstSeen: row.first_seen ?? null,
    lastSeen: row.last_seen ?? null,
  };
}

function relationFromRow(row, direction) {
  return {
    type: row.type,
    label: relationLabel(row.type),
    direction,
    other: { name: row.other_name, kind: row.other_kind ?? 'person' },
    note: row.note ?? '',
    evidence: row.evidence ?? '',
    confidence: Number(row.confidence ?? 0.5),
  };
}

function safeJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

// 列出所有人，按提及次数排；顺带把每个人的关系数量算出来
export async function queryPeople(paths, options = {}) {
  const cap = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 50;
  return withDb(paths, { log: options.log }, (db) => {
    const rows = db.prepare("SELECT * FROM entities WHERE kind != 'self' ORDER BY mentions DESC, last_seen DESC LIMIT ?").all(cap);
    const counts = new Map();
    for (const row of db.prepare('SELECT id AS side, COUNT(*) AS n FROM (SELECT from_id AS id FROM relations UNION ALL SELECT to_id AS id FROM relations) GROUP BY id').all()) {
      counts.set(row.side, Number(row.n));
    }
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind != 'self'").get()?.n ?? 0);
    return {
      total,
      people: rows.map((row) => ({ ...rowToEntity(row), relations: counts.get(row.id) ?? 0 })),
    };
  });
}

export async function countGraph(paths, options = {}) {
  return withDb(paths, { log: options.log }, (db) => ({
    people: Number(db.prepare('SELECT COUNT(*) AS n FROM entities').get()?.n ?? 0),
    relations: Number(db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n ?? 0),
  }));
}

// 把一次抽取的结果合并进库。整个过程在一个事务里：
// 要么全进去，要么一条都不进，避免只写了一半的人。
export async function mergeExtraction(paths, extraction, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const people = Array.isArray(extraction?.people) ? extraction.people : [];
  const relations = Array.isArray(extraction?.relations) ? extraction.relations : [];
  if (!people.length && !relations.length) return { people: 0, relations: 0, addedPeople: 0, addedRelations: 0 };

  const db = openDb(paths, { log });
  try {
    let addedPeople = 0;
    let addedRelations = 0;
    tx(db, () => {
      const byNorm = new Map();
      for (const row of db.prepare('SELECT * FROM entities').all()) byNorm.set(row.norm, row);

      const upsert = (raw, countMention = true) => {
        const name = String(raw?.name ?? '').trim();
        const norm = normName(name);
        if (!norm) return null;
        const existing = byNorm.get(norm);
        const confidence = clampConfidence(raw?.confidence, 0.5);
        if (existing) {
          // 已经认识的：累加提及次数，补别名和备注，置信度取高的那个
          const aliases = new Set(safeJson(existing.aliases, []));
          for (const alias of Array.isArray(raw?.aliases) ? raw.aliases : []) {
            const text = String(alias ?? '').trim();
            if (text && normName(text) !== norm) aliases.add(text);
          }
          db.prepare(
            'UPDATE entities SET aliases = ?, note = ?, confidence = ?, mentions = mentions + ?, last_seen = ? WHERE id = ?',
          ).run(
            JSON.stringify([...aliases]),
            existing.note || String(raw?.note ?? '').trim(),
            Math.max(Number(existing.confidence ?? 0), confidence),
            countMention ? 1 : 0,
            stamp,
            existing.id,
          );
          const merged = { ...existing, aliases: [...aliases] };
          byNorm.set(norm, merged);
          return merged;
        }
        const id = newId('p', Math.floor(Math.random() * 1e9).toString(36));
        // 「用户」「我」这种是关系里的另一端，不是要列出来的联系人：
        // 标成 self，名单里默认不显示，但点开照样能看到他名下的关系。
        const kind = SELF_NAMES.includes(norm)
          ? 'self'
          : raw?.kind && ENTITY_KINDS[raw.kind]
            ? raw.kind
            : 'person';
        db.prepare(
          'INSERT INTO entities (id, name, norm, kind, aliases, note, confidence, mentions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        ).run(
          id,
          name,
          norm,
          kind,
          JSON.stringify(Array.isArray(raw?.aliases) ? raw.aliases : []),
          String(raw?.note ?? '').trim(),
          confidence,
          stamp,
          stamp,
        );
        addedPeople += 1;
        // note/confidence 必须一起带上：关系端点会拿这个内存对象再 upsert 一次，
        // 缺字段就会把刚写进去的备注和把握度覆盖成空/低值
        const created = {
          id,
          name,
          norm,
          kind,
          aliases: Array.isArray(raw?.aliases) ? raw.aliases : [],
          note: String(raw?.note ?? '').trim(),
          confidence,
        };
        byNorm.set(norm, created);
        return created;
      };

      for (const person of people) upsert(person, true);

      for (const relation of relations) {
        // 关系两端只补人，不涨「提到过几次」—— 同一份材料里既列名单又写关系，
        // 涨两次会让面板上的次数翻倍，看着像错了
        const from = upsert({ name: relation?.from, confidence: relation?.confidence }, false);
        const to = upsert({ name: relation?.to, confidence: relation?.confidence }, false);
        if (!from || !to || from.id === to.id) continue;
        const type = RELATION_TYPES[relation?.type] ? relation.type : 'other';
        const existing = db
          .prepare('SELECT * FROM relations WHERE from_id = ? AND to_id = ? AND type = ?')
          .get(from.id, to.id, type);
        const note = String(relation?.note ?? '').trim();
        const evidence = String(relation?.evidence ?? '').trim().slice(0, 500);
        const confidence = clampConfidence(relation?.confidence, 0.5);
        if (existing) {
          db.prepare('UPDATE relations SET note = ?, evidence = ?, confidence = ?, updated_at = ? WHERE id = ?').run(
            note || existing.note,
            evidence || existing.evidence,
            Math.max(Number(existing.confidence ?? 0), confidence),
            stamp,
            existing.id,
          );
        } else {
          // 同一对人只留一条关系：模型这两次判断不一致时（先同事后下属），
          // 保留新的，别让卡片上同时挂着两个互相矛盾的说法
          db.prepare('DELETE FROM relations WHERE from_id = ? AND to_id = ? AND type != ?').run(from.id, to.id, type);
          const id = newId('r', Math.floor(Math.random() * 1e9).toString(36));
          db.prepare(
            'INSERT INTO relations (id, from_id, to_id, type, note, evidence, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(id, from.id, to.id, type, note, evidence, confidence, stamp, stamp);
          addedRelations += 1;
        }
      }
    });
    return { people: people.length, relations: relations.length, addedPeople, addedRelations };
  } finally {
    try {
      db.close();
    } catch {
      // 已经关掉了
    }
  }
}

export function renderPeopleList(data, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : 1200;
  const people = data?.people ?? [];
  if (!people.length) return '知识库里还没有人。等我多听几条消息、多看几篇笔记，就能把人认出来了。';
  const lines = [`一共认出 ${data?.total ?? people.length} 个人：`];
  people.forEach((person, index) => {
    const bits = [`${index + 1}. ${person.name}`];
    if (person.kind && person.kind !== 'person') bits.push(`[${kindLabel(person.kind)}]`);
    if (person.relations) bits.push(`（${person.relations} 条关系）`);
    if (person.note) bits.push(`— ${person.note}`);
    lines.push(bits.join(' '));
  });
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 12)}……（后面还有）`;
  return text;
}

export function renderPersonCard(data, options = {}) {
  if (!data?.entity) return '知识库里没有这个人。';
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : 1200;
  const { entity, relations } = data;
  const lines = [`${entity.name}（${kindLabel(entity.kind)}，提到过 ${entity.mentions} 次）`];
  if (entity.aliases?.length) lines.push(`也叫：${entity.aliases.join('、')}`);
  if (entity.note) lines.push(`备注：${entity.note}`);
  if (relations?.length) {
    lines.push('关系：');
    for (const relation of relations) {
      const arrow = relation.direction === 'out' ? '→' : '←';
      const tail = relation.note ? `（${relation.note}）` : '';
      const sure = Number(relation.confidence);
      const sureText = Number.isFinite(sure) && sure > 0 ? `（把握 ${Math.round(sure * 100)}%）` : '';
      lines.push(`- ${entity.name} ${arrow} ${relation.other.name}：${relation.label}${tail}${sureText}`);
      // 把原话带上：用户看到「下属」这种判断时，能立刻核对我是不是看错了
      if (relation.evidence) lines.push(`  原话：${relation.evidence}`);
    }
  } else {
    lines.push('关系：还没理出来。');
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 12)}……（后面还有）`;
  return text;
}

// 迁移/维护用：清空整张图（重新分析时用不到，留着手动修数据）
export async function clearGraph(paths, options = {}) {
  await withDb(paths, { log: options.log }, (db) =>
    tx(db, () => {
      replaceRows(db, 'relations', [], RELATION_COLUMNS);
      replaceRows(db, 'entities', [], PERSON_COLUMNS);
    }),
  );
}
