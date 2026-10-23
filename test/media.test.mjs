import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  aesEcbPaddedSize,
  cdnUrlOf,
  decryptAesEcb,
  encryptAesEcb,
  mediaKindOf,
  parseAesKey,
  resolveAesKey,
  sniffImageType,
} from '../lib/media.js';

test('aesEcbPaddedSize 按 16 字节对齐且总比明文长', () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(17), 32);
  for (const n of [1, 100, 1000, 65535]) {
    assert.ok(aesEcbPaddedSize(n) > n, `${n} 的密文应该更长`);
    assert.equal(aesEcbPaddedSize(n) % 16, 0, `${n} 的密文长度应该对齐`);
  }
});

test('AES-128-ECB 加密再解密能还原', () => {
  const key = randomBytes(16);
  const plain = Buffer.from('值班表：周一张三，周二李四', 'utf8');
  const cipher = encryptAesEcb(plain, key);
  assert.equal(cipher.length, aesEcbPaddedSize(plain.length));
  assert.deepEqual(decryptAesEcb(cipher, key), plain);
});

test('parseAesKey 认得 base64(16 字节) 和 base64(hex 字符串) 两种', () => {
  const raw = randomBytes(16);
  assert.deepEqual(parseAesKey(raw.toString('base64')), raw);

  const hex = randomBytes(16).toString('hex');
  const asB64 = Buffer.from(hex, 'utf8').toString('base64');
  assert.deepEqual(parseAesKey(asB64), Buffer.from(hex, 'hex'));
});

test('parseAesKey 遇到不认识的长度要报错而不是瞎猜', () => {
  assert.throws(() => parseAesKey(Buffer.from('short').toString('base64'), 'image'), /aes_key 无法解析/);
  assert.throws(() => parseAesKey('', 'file'), /aes_key 无法解析/);
});

test('resolveAesKey 优先用 32 位 hex，其次 media.aes_key', () => {
  const hex = randomBytes(16).toString('hex');
  assert.deepEqual(resolveAesKey({}, hex), Buffer.from(hex, 'hex'));

  const raw = randomBytes(16);
  assert.deepEqual(resolveAesKey({ aes_key: raw.toString('base64') }), raw);

  assert.equal(resolveAesKey({}), undefined);
  assert.equal(resolveAesKey(undefined, 'not-hex'), undefined);
});

test('cdnUrlOf 优先 encrypt_query_param，其次 full_url', () => {
  assert.match(cdnUrlOf({ encrypt_query_param: 'abc' }), /encrypted_query_param=abc$/);
  assert.equal(cdnUrlOf({ full_url: 'https://example.com/x' }), 'https://example.com/x');
  assert.equal(cdnUrlOf({}), undefined);
  assert.equal(cdnUrlOf(null), undefined);
});

test('sniffImageType 只认魔数，不认扩展名', () => {
  assert.equal(sniffImageType(Buffer.from('89504e470d0a1a0a0000000d', 'hex'))?.ext, '.png');
  assert.equal(sniffImageType(Buffer.from('ffd8ffe000104a464946000101', 'hex'))?.ext, '.jpg');
  assert.equal(sniffImageType(Buffer.from('GIF89a0000000000', 'ascii'))?.ext, '.gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  assert.equal(sniffImageType(webp)?.ext, '.webp');
  assert.equal(sniffImageType(Buffer.from('not an image at all')), undefined);
  assert.equal(sniffImageType(Buffer.alloc(4)), undefined);
});

test('mediaKindOf 按扩展名分类，认不出的一律当文件', () => {
  assert.equal(mediaKindOf('/a/b.png'), 'image');
  assert.equal(mediaKindOf('/a/b.JPEG'), 'image');
  assert.equal(mediaKindOf('/a/b.mp4'), 'video');
  assert.equal(mediaKindOf('/a/b.xlsx'), 'file');
  assert.equal(mediaKindOf('/a/b'), 'file');
  assert.equal(mediaKindOf(''), 'file');
});
