import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 解析失败（手改坏、断电留半截）时先把坏文件改名留档，再回退默认值。
// 直接回退会让下一次写入把整份数据覆盖掉，用户的工作项就无声无息没了。
export async function readJson(file, fallback = null, options = {}) {
  const onCorrupt = options.onCorrupt ?? (() => {});
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
  if (!raw.trim()) return fallback;

  try {
    return JSON.parse(raw);
  } catch (err) {
    let backup = '';
    try {
      backup = `${file}.corrupt-${Date.now()}`;
      renameSync(file, backup);
    } catch {
      backup = '';
    }
    onCorrupt(err, backup);
    return fallback;
  }
}

// 同目录临时文件 + fsync + rename，避免写一半断电留下坏文件
export async function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const body = JSON.stringify(value, null, 2);
  let fd;
  try {
    fd = openSync(temp, 'wx');
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已经关了 */ }
    }
    try { unlinkSync(temp); } catch { /* rename 成功后临时文件已不存在 */ }
  }
}

export async function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx');
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已经关了 */ }
    }
    try { unlinkSync(temp); } catch { /* rename 成功后临时文件已不存在 */ }
  }
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
