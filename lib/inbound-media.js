// 把微信发来的媒体变成模型能吃的内容块。
// 图片要落盘再转 base64：留个原件，出问题能查；也方便降级时把路径说给模型。
// 文件同样落盘，然后只给路径 —— 模型自己有 fs 工具，能读 xlsx/pdf 这些。

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_MEDIA_BYTES, downloadMedia, resolveAesKey, sniffImageType } from './media.js';

function safeName(name, fallback) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || fallback;
}

function stamp() {
  return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
}

function random() {
  return Math.floor(Math.random() * 1e6).toString(36);
}

// 返回 { content, saved, failed }
// content 是可直接交给 sessionController.prompt 的块数组（image 用 data+mediaType）
export async function buildMediaContent(mediaList, options = {}) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => {});
  const dir = options.dir;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_MEDIA_BYTES;

  const content = [];
  const saved = [];
  const failed = [];

  if (!list.length) return { content, saved, failed };
  if (!dir) {
    // 没有落盘目录就只报个数，总比把整条消息吞掉好
    return {
      content: [{ type: 'text', text: `[收到 ${list.length} 个附件，但没有可用的存放目录，没能处理]` }],
      saved,
      failed,
    };
  }
  await mkdir(dir, { recursive: true });

  for (const item of list) {
    try {
      if (item.kind === 'image') {
        const aesKey = item.aesKey ?? resolveAesKey(item.mediaRef, undefined, 'image');
        const { buf } = await downloadMedia(fetchImpl, item.mediaRef, aesKey, { maxBytes, signal: options.signal });
        const sniffed = sniffImageType(buf);
        if (!sniffed) throw new Error('图片格式不认识（只支持 png/jpeg/gif/webp）');
        const file = join(dir, `${stamp()}-${random()}${sniffed.ext}`);
        await writeFile(file, buf);
        saved.push(file);
        content.push({ type: 'image', data: buf.toString('base64'), mediaType: sniffed.mediaType });
        continue;
      }

      if (item.kind === 'file' || item.kind === 'voice' || item.kind === 'video') {
        const aesKey = item.aesKey ?? resolveAesKey(item.mediaRef, undefined, item.kind);
        const { buf } = await downloadMedia(fetchImpl, item.mediaRef, aesKey, { maxBytes, signal: options.signal });
        const fallback = item.kind === 'voice' ? 'voice.silk' : item.kind === 'video' ? 'video.mp4' : 'file.bin';
        const name = safeName(item.name, fallback);
        const file = join(dir, `${stamp()}-${random()}-${name}`);
        await writeFile(file, buf);
        saved.push(file);

        if (item.kind === 'video') {
          content.push({ type: 'text', text: `[收到一段视频，存在本机：${file}]` });
        } else if (item.kind === 'voice') {
          content.push({ type: 'text', text: `[收到一段语音，转文字失败，原始文件在本机：${file}]` });
        } else {
          content.push({ type: 'text', text: `[附件 ${name}] 本机路径：${file}` });
        }
        continue;
      }

      failed.push({ kind: item.kind, reason: '不认识的媒体类型' });
    } catch (err) {
      const reason = err?.message ?? String(err);
      failed.push({ kind: item.kind, reason });
      log(`inbound: ${item.kind} 处理失败 ${reason}`);
      content.push({ type: 'text', text: `[收到一个${item.kind === 'image' ? '图片' : '附件'}，但没取下来：${reason}]` });
    }
  }

  return { content, saved, failed };
}
