import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { buildMediaContent } from '../lib/inbound-media.js';
import { encryptAesEcb } from '../lib/media.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// 造一个假的微信 CDN：按 URL 里的名字返回指定明文（加密后）
function fakeFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const param = decodeURIComponent(new URL(url).searchParams.get('encrypted_query_param') ?? '');
    const entry = files[param];
    if (!entry) return { ok: false, status: 404, headers: { get: () => null } };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      body: null,
      arrayBuffer: async () => entry.buf,
    };
  };
  return { impl, calls };
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-inbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('图片下载后落盘并转成 base64 图片块', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const cipher = encryptAesEcb(PNG, key);
  const { impl, calls } = fakeFetch({ q1: { buf: cipher } });

  const out = await buildMediaContent(
    [{ kind: 'image', mediaRef: { encrypt_query_param: 'q1' }, aesKey: key }],
    { fetch: impl, dir: join(dir, 'media') },
  );

  assert.equal(calls.length, 1);
  assert.equal(out.failed.length, 0);
  assert.equal(out.saved.length, 1);
  assert.ok(existsSync(out.saved[0]));
  assert.deepEqual(readFileSync(out.saved[0]), PNG);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'image');
  assert.equal(out.content[0].mediaType, 'image/png');
  assert.deepEqual(Buffer.from(out.content[0].data, 'base64'), PNG);
});

test('文件落盘后只给路径，正文是给人看的一句话', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const payload = Buffer.from('这是表格内容', 'utf8');
  const { impl } = fakeFetch({ q2: { buf: encryptAesEcb(payload, key) } });

  const out = await buildMediaContent(
    [{ kind: 'file', mediaRef: { encrypt_query_param: 'q2' }, aesKey: key, name: '报表.xlsx' }],
    { fetch: impl, dir },
  );

  assert.equal(out.saved.length, 1);
  assert.match(out.saved[0], /报表\.xlsx$/);
  assert.deepEqual(readFileSync(out.saved[0]), payload);
  assert.equal(out.content[0].type, 'text');
  assert.match(out.content[0].text, /\[附件 报表\.xlsx\]/);
  assert.match(out.content[0].text, /本机路径：/);
});

test('语音和视频各自给不同的提示文案', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const { impl } = fakeFetch({
    v1: { buf: encryptAesEcb(Buffer.from('silk'), key) },
    v2: { buf: encryptAesEcb(Buffer.from('mp4'), key) },
  });

  const out = await buildMediaContent(
    [
      { kind: 'voice', mediaRef: { encrypt_query_param: 'v1' }, aesKey: key, name: 'voice.silk' },
      { kind: 'video', mediaRef: { encrypt_query_param: 'v2' }, aesKey: key, name: 'video.mp4' },
    ],
    { fetch: impl, dir },
  );

  assert.equal(out.saved.length, 2);
  assert.match(out.content[0].text, /收到一段语音/);
  assert.match(out.content[1].text, /收到一段视频/);
});

test('下载失败时给一句可读提示并记日志，不影响其它附件', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const { impl } = fakeFetch({ ok: { buf: encryptAesEcb(PNG, key) } });
  const logs = [];

  const out = await buildMediaContent(
    [
      { kind: 'image', mediaRef: { encrypt_query_param: 'missing' }, aesKey: key },
      { kind: 'image', mediaRef: { encrypt_query_param: 'ok' }, aesKey: key },
    ],
    { fetch: impl, dir, log: (line) => logs.push(line) },
  );

  assert.equal(out.failed.length, 1);
  assert.equal(out.saved.length, 1, '坏的那个不该影响好的那个');
  assert.equal(out.content[0].type, 'text');
  assert.match(out.content[0].text, /没取下来/);
  assert.equal(out.content[1].type, 'image');
  assert.ok(logs.some((line) => /处理失败/.test(line)));
});

test('认不出的图片格式要报错而不是硬塞给模型', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const bogus = Buffer.from('this is definitely not an image');
  const { impl } = fakeFetch({ x: { buf: encryptAesEcb(bogus, key) } });

  const out = await buildMediaContent(
    [{ kind: 'image', mediaRef: { encrypt_query_param: 'x' }, aesKey: key }],
    { fetch: impl, dir },
  );

  assert.equal(out.saved.length, 0);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].reason, /格式不认识/);
  assert.match(out.content[0].text, /没取下来/);
});

test('没有落盘目录时只说个数，不抛错', async () => {
  const out = await buildMediaContent([{ kind: 'image', mediaRef: { encrypt_query_param: 'q' } }], {});
  assert.equal(out.content.length, 1);
  assert.match(out.content[0].text, /没有可用的存放目录/);
  assert.equal(out.saved.length, 0);
});

test('空列表返回空结果，不发任何请求', async () => {
  const { impl, calls } = fakeFetch({});
  const out = await buildMediaContent([], { fetch: impl, dir: '/tmp/x' });
  assert.deepEqual(out.content, []);
  assert.equal(calls.length, 0);
});

test('文件名里的非法字符会被替换，不会跳出目录', async (t) => {
  const dir = scratch(t);
  const key = randomBytes(16);
  const { impl } = fakeFetch({ q: { buf: encryptAesEcb(Buffer.from('x'), key) } });

  const out = await buildMediaContent(
    [{ kind: 'file', mediaRef: { encrypt_query_param: 'q' }, aesKey: key, name: '../../etc/passwd' }],
    { fetch: impl, dir },
  );

  assert.equal(out.saved.length, 1);
  assert.ok(out.saved[0].startsWith(dir), '必须留在指定目录里');
  assert.ok(!out.saved[0].includes('..'));
});
