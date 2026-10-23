// 微信 CDN 的媒体加解密、格式识别、上传分类。
// 协议细节参考 @michengai/dsh-im-connect (Apache-2.0) 的 lib/channels/weixin.js。

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { extname } from 'node:path';

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

// 微信 CDN 用 AES-128-ECB + PKCS7：密文长度一定比明文多，且按 16 字节对齐
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// 平台给的 aes_key 有两种编码：base64(16 字节原始 key)，或 base64(32 字符 hex)。
// 图片走前者，文件/语音/视频走后者，两种都得认。
export function parseAesKey(aesKeyBase64, label = 'aes') {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: aes_key 无法解析（base64 解码后 ${decoded.length} 字节，应为 16 字节或 32 字符 hex）`);
}

// 图片的 key 可能单独放在 image_item.aeskey（32 位 hex），也可能在 media.aes_key（base64）
export function resolveAesKey(mediaRef, hexKey, label = 'aes') {
  if (typeof hexKey === 'string' && /^[0-9a-fA-F]{32}$/.test(hexKey)) return Buffer.from(hexKey, 'hex');
  const b64 = mediaRef && typeof mediaRef === 'object' ? mediaRef.aes_key : undefined;
  if (typeof b64 === 'string' && b64.trim()) return parseAesKey(b64.trim(), label);
  return undefined;
}

export function buildCdnDownloadUrl(param, baseUrl = CDN_BASE_URL) {
  return `${baseUrl}/download?encrypted_query_param=${encodeURIComponent(param)}`;
}

export function cdnUrlOf(mediaRef) {
  if (!mediaRef || typeof mediaRef !== 'object') return undefined;
  const param = typeof mediaRef.encrypt_query_param === 'string' ? mediaRef.encrypt_query_param.trim() : '';
  if (param) return buildCdnDownloadUrl(param);
  const full = typeof mediaRef.full_url === 'string' ? mediaRef.full_url.trim() : '';
  return full || undefined;
}

// 加密 CDN 一律返回 application/octet-stream，真实格式只能看明文字节
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return undefined;
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: '.png', mediaType: 'image/png' };
  if (buf.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { ext: '.jpg', mediaType: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return { ext: '.gif', mediaType: 'image/gif' };
  const riff = buf.subarray(0, 4).toString('ascii') === 'RIFF';
  const webp = buf.subarray(8, 12).toString('ascii') === 'WEBP';
  if (riff && webp) return { ext: '.webp', mediaType: 'image/webp' };
  return undefined;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi']);

// 发出去的媒体按扩展名分三类，平台的上传类型与消息 item 都跟着变
export function mediaKindOf(filePath) {
  const ext = extname(String(filePath ?? '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

function timeoutSignal(ms, parent) {
  const own = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([own, parent]) : own;
}

// 边读边数，超限立刻断开：不先整个读进内存，免得一个 500MB 的附件把进程撑爆
async function readLimited(res, maxBytes) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`媒体超过 ${maxBytes} 字节上限`);
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`媒体超过 ${maxBytes} 字节上限`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

// 下载一条媒体并解密。mediaRef 是消息里那个 { encrypt_query_param, aes_key, ... }
export async function downloadMedia(fetchImpl, mediaRef, aesKey, options = {}) {
  const url = cdnUrlOf(mediaRef);
  if (!url) throw new Error('媒体缺少下载地址');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_MEDIA_BYTES;

  const res = await fetchImpl(url, { signal: timeoutSignal(timeoutMs, options.signal) });
  if (!res.ok) throw new Error(`媒体下载 HTTP ${res.status}`);
  const cipher = await readLimited(res, maxBytes);
  const buf = aesKey ? decryptAesEcb(cipher, aesKey) : cipher;
  return { buf, contentType: res.headers?.get?.('content-type') ?? undefined };
}
