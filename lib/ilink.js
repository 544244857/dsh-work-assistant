// 微信 iLink Bot 协议客户端。
// 协议细节参考 @michengai/dsh-im-connect (Apache-2.0) 的 lib/channels/weixin.js，
// 这里只保留本插件需要的几个端点：扫码、查扫码状态、长轮询收消息、发文本、
// 「正在输入」用到的取票据（getconfig）与发状态（sendtyping），
// 以及收发媒体用到的上传地址申请（getuploadurl）与 CDN 上传。

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  CDN_BASE_URL,
  MAX_MEDIA_BYTES,
  aesEcbPaddedSize,
  encryptAesEcb,
  mediaKindOf,
  resolveAesKey,
} from './media.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const SEND_PATH = '/ilink/bot/sendmessage';
const CONFIG_PATH = '/ilink/bot/getconfig';
const TYPING_PATH = '/ilink/bot/sendtyping';
const UPLOAD_PATH = '/ilink/bot/getuploadurl';
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const UPLOAD_IMAGE = 1;
const UPLOAD_VIDEO = 2;
const UPLOAD_FILE = 3;
// typing_ticket 是「正在输入」状态的通行证，平台给的时效不长，这里按 5 分钟复用
const TYPING_TICKET_TTL_MS = 5 * 60 * 1000;

// 平台明确没受理（可以安全重发）；其余 5xx 可能已部分处理，不当作可重试
export class DeliveryRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeliveryRejected';
  }
}

// 登录态失效：微信在 token 过期后所有请求都回 errcode=-14。
// 单独一个类型，调用方才知道该清凭据让人重新扫码，而不是傻等重试。
export class TokenExpired extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenExpired';
  }
}

function isStaleToken(message) {
  return /(?:ret|errcode)\s*=\s*-14(?:\D|$)/i.test(String(message ?? ''));
}

function pickStr(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function messageIdOf(raw, fromUserId) {
  const direct = pickStr(raw, 'message_id', 'msg_id', 'client_id');
  if (direct) return direct;
  const at = raw?.create_time_ms ?? raw?.create_time ?? 0;
  return `${fromUserId}:${at}`;
}

export function parseInbound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw.message && typeof raw.message === 'object' ? { ...raw, ...raw.message } : raw;
  if (m.message_type !== undefined && Number(m.message_type) !== 1) return null;

  const fromUserId = pickStr(m, 'from_user_id', 'from_user');
  if (!fromUserId) return null;

  const parts = [];
  const media = [];
  let unsupported = 0;
  if (typeof m.text === 'string' && m.text.trim()) parts.push(m.text.trim());
  if (Array.isArray(m.item_list)) {
    for (const item of m.item_list) {
      const type = Number(item?.type ?? 0);
      if (type === ITEM_TEXT) {
        const text = pickStr(item.text_item, 'text');
        if (text) parts.push(text);
      } else if (type === ITEM_IMAGE) {
        // 只记下下载所需的引用，真正下载放在投递时做：解析阶段发网络请求会拖慢整轮长轮询
        const mediaRef = item.image_item?.media;
        if (mediaRef) {
          media.push({
            kind: 'image',
            mediaRef,
            aesKey: resolveAesKey(mediaRef, pickStr(item.image_item, 'aeskey'), 'image'),
            name: 'image',
          });
        } else {
          unsupported += 1;
        }
      } else if (type === ITEM_VOICE) {
        // 语音：服务端有时已经转好文字，有就直接用
        const asr = pickStr(item.voice_item, 'text');
        if (asr) parts.push(`[语音] ${asr}`);
        else if (item.voice_item?.media) media.push({ kind: 'voice', mediaRef: item.voice_item.media, name: 'voice.silk' });
        else unsupported += 1;
      } else if (type === ITEM_FILE) {
        const mediaRef = item.file_item?.media;
        const name = pickStr(item.file_item, 'file_name') ?? 'file.bin';
        if (mediaRef) media.push({ kind: 'file', mediaRef, aesKey: resolveAesKey(mediaRef, undefined, 'file'), name });
        else unsupported += 1;
      } else if (type === ITEM_VIDEO) {
        const mediaRef = item.video_item?.media;
        if (mediaRef) media.push({ kind: 'video', mediaRef, name: 'video.mp4' });
        else unsupported += 1;
      } else {
        unsupported += 1;
      }
    }
  }

  const text = parts.join('\n').trim();
  if (!text && !media.length && unsupported === 0) return null;
  return {
    fromUserId,
    contextToken: pickStr(m, 'context_token'),
    messageId: messageIdOf(m, fromUserId),
    text,
    media,
    unsupported,
  };
}

// 同一会话的发送必须串行，否则平台会拒
class SerialQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.tails.set(key, next.catch(() => {}));
    return next;
  }
}

function timeoutSignal(ms, parent) {
  const own = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([own, parent]) : own;
}

export class IlinkClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.log = options.log ?? (() => {});
    this.botToken = options.botToken ?? '';
    this.uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64');
    this.queue = new SerialQueue();
    // 每个用户一份 typing_ticket：取票要一次请求，不缓存的话每次打字都要多跑一趟
    this.typingTickets = new Map(); // toUserId -> { ticket, nextFetchAt }
  }

  setLogin({ botToken, baseUrl } = {}) {
    if (botToken) this.botToken = botToken;
    if (baseUrl) this.baseUrl = baseUrl;
  }

  clearLogin() {
    this.botToken = '';
  }

  headers() {
    const headers = {
      'content-type': 'application/json',
      'iLink-App-ClientVersion': '1',
      'X-WECHAT-UIN': this.uin,
    };
    if (this.botToken) {
      headers.Authorization = `Bearer ${this.botToken}`;
      headers.AuthorizationType = 'ilink_bot_token';
    }
    return headers;
  }

  async request(path, body, { timeoutMs = 20000, tolerateRet1 = false, signal } = {}) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
      signal: timeoutSignal(timeoutMs, signal),
    });

    if (!res.ok) {
      const message = `iLink ${path} HTTP ${res.status}`;
      if (path === SEND_PATH && (res.status === 429 || res.status === 503)) throw new DeliveryRejected(message);
      throw new Error(message);
    }

    const data = await res.json();
    const ret = Number(data.ret ?? 0);
    const errcode = Number(data.errcode ?? 0);
    if (tolerateRet1 && ret === 1 && errcode === 0) return data;
    if (ret !== 0 || errcode !== 0) {
      const message = `iLink ${path} ret=${ret} errcode=${errcode} ${String(data.errmsg ?? '')}`.trim();
      // 登录态失效：token 过期或换了号，所有请求都会回 -14
      if (ret === -14 || errcode === -14 || isStaleToken(message)) throw new TokenExpired(message);
      // ret=-2 是间歇性拒收：没入队，重发不会重复
      if (path === SEND_PATH && ret === -2 && errcode === 0) throw new DeliveryRejected(message);
      throw new Error(message);
    }
    return data;
  }

  async startLogin({ signal } = {}) {
    const data = await this.request('/ilink/bot/get_bot_qrcode?bot_type=3', {}, { timeoutMs: 15000, signal });
    const qrcodeId = pickStr(data, 'qrcode', 'qrcode_id');
    const qrPayload = pickStr(data, 'qrcode_img_content', 'qrcode_url', 'url');
    if (!qrcodeId || !qrPayload) throw new Error('二维码字段缺失');
    return { qrcodeId, qrPayload };
  }

  async pollLogin(qrcodeId, { signal } = {}) {
    const data = await this.request(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`,
      {},
      { timeoutMs: 40000, tolerateRet1: true, signal },
    );
    const status = String(data.status ?? '');
    if (Number(data.ret ?? 0) === 0 && status === 'confirmed') {
      const botToken = pickStr(data, 'bot_token');
      if (!botToken) throw new Error('扫码已确认但没拿到 bot_token');
      return {
        status: 'confirmed',
        credentials: {
          botToken,
          ownerUserId: pickStr(data, 'ilink_user_id'),
          baseUrl: pickStr(data, 'baseurl', 'base_url'),
        },
      };
    }
    if (status === 'expired') return { status: 'expired' };
    if (status === 'scanned' || status === 'scaned') return { status: 'scanned' };
    return { status: 'waiting' };
  }

  async getUpdates({ cursor = '', timeoutSecs = 70, signal } = {}) {
    const data = await this.request(
      '/ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: { channel_version: '1.0.0' } },
      { timeoutMs: timeoutSecs * 1000 + 5000, signal },
    );
    const nextCursor = pickStr(data, 'get_updates_buf', 'cursor', 'sync_buf') ?? cursor;
    const rawList = data.msgs ?? data.messages ?? data.updates;
    const messages = [];
    if (Array.isArray(rawList)) {
      for (const raw of rawList) {
        const parsed = parseInbound(raw);
        if (parsed) messages.push(parsed);
      }
    }
    return { messages, nextCursor };
  }

  async sendText({ toUserId, text, contextToken = '', signal }) {
    const clientId = `dsh-workassistant:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    await this.queue.run(toUserId, () => this.request(
      SEND_PATH,
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: ITEM_TEXT, text_item: { text } }],
        },
        base_info: { channel_version: '1.0.0' },
      },
      { timeoutMs: 15000, signal },
    ));
  }

  // 微信发文件是四步：申请上传地址 → 加密上传到 CDN → 拿下载参数 → 拼成消息发出去。
  // 本地文件读进内存再加密，所以先卡 50MB 上限，别让一个大附件把进程撑爆。
  async uploadToCdn(filePath, toUserId, mediaType, { signal } = {}) {
    const plaintext = await readFile(filePath);
    const rawsize = plaintext.length;
    if (rawsize > MAX_MEDIA_BYTES) {
      throw new Error(`文件太大，微信最多 ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}MB`);
    }
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);

    const resp = await this.request(
      UPLOAD_PATH,
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
      },
      { timeoutMs: 20000, signal },
    );

    const uploadFullUrl = pickStr(resp, 'upload_full_url');
    const uploadParam = pickStr(resp, 'upload_param');
    if (!uploadFullUrl && !uploadParam) throw new Error('getuploadurl 未返回上传地址');
    const cdnUrl = uploadFullUrl
      ?? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    const upRes = await this.fetchImpl(cdnUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(encryptAesEcb(plaintext, aeskey)),
      signal: timeoutSignal(120000, signal),
    });
    if (upRes.status !== 200) {
      const detail = upRes.headers?.get?.('x-error-message') ?? `HTTP ${upRes.status}`;
      throw new Error(`CDN 上传失败: ${detail}`);
    }
    const downloadParam = upRes.headers?.get?.('x-encrypted-param');
    if (!downloadParam) throw new Error('CDN 上传响应缺少 x-encrypted-param');

    return { downloadParam, aeskeyHex: aeskey.toString('hex'), rawsize, filesize };
  }

  // 按扩展名分图片/视频/文件三类，走不同的上传类型与 item 形状。
  // caption 先单独发一条文本，微信里显示成「文字 + 文件」两条。
  async sendMedia({ toUserId, filePath, caption = '', contextToken = '', signal } = {}) {
    const kind = mediaKindOf(filePath);
    const mediaType = kind === 'image' ? UPLOAD_IMAGE : kind === 'video' ? UPLOAD_VIDEO : UPLOAD_FILE;
    const up = await this.uploadToCdn(filePath, toUserId, mediaType, { signal });

    const media = {
      encrypt_query_param: up.downloadParam,
      aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
      encrypt_type: 1,
    };
    let item;
    if (kind === 'image') {
      item = { type: ITEM_IMAGE, image_item: { media, mid_size: up.filesize } };
    } else if (kind === 'video') {
      item = { type: ITEM_VIDEO, video_item: { media, video_size: up.filesize } };
    } else {
      item = { type: ITEM_FILE, file_item: { media, file_name: basename(filePath), len: String(up.rawsize) } };
    }

    if (caption) await this.sendText({ toUserId, text: caption, contextToken, signal });

    const clientId = `dsh-workassistant:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    await this.queue.run(toUserId, () => this.request(
      SEND_PATH,
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [item],
        },
        base_info: { channel_version: '1.0.0' },
      },
      { timeoutMs: 30000, signal },
    ));
    return { kind, name: basename(filePath), bytes: up.rawsize };
  }

  // 「正在输入」要在微信里显示，得先拿 typing_ticket。票有有效期，按用户缓存着复用。
  async typingTicket(toUserId, contextToken = '', { signal } = {}) {
    const cached = this.typingTickets.get(toUserId);
    if (cached && Date.now() < cached.nextFetchAt && cached.ticket) return cached.ticket;

    const data = await this.request(
      CONFIG_PATH,
      {
        ilink_user_id: toUserId,
        context_token: contextToken,
        base_info: { channel_version: '1.0.0' },
      },
      { timeoutMs: 15000, signal },
    );
    const ticket = pickStr(data, 'typing_ticket');
    if (!ticket) return '';
    this.typingTickets.set(toUserId, { ticket, nextFetchAt: Date.now() + TYPING_TICKET_TTL_MS });
    return ticket;
  }

  // status: 1 = 开始输入（微信里显示「对方正在输入」），2 = 停止
  // 这是「锦上添花」的状态，失败绝不能影响正经回复，所以这里不抛错，交给调用方看返回值。
  async sendTyping({ toUserId, contextToken = '', status = 1, signal } = {}) {
    try {
      const ticket = await this.typingTicket(toUserId, contextToken, { signal });
      if (!ticket) return false;
      await this.request(
        TYPING_PATH,
        {
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status,
          base_info: { channel_version: '1.0.0' },
        },
        { timeoutMs: 10000, signal },
      );
      return true;
    } catch (err) {
      // 票过期/网络抖动都会走到这里，把票丢掉下次重取
      this.typingTickets.delete(toUserId);
      this.log(`typing: 发送状态失败（忽略）${err?.message ?? err}`);
      return false;
    }
  }
}

// 长文本按段落切，尽量不超过平台单条上限
// 高位代理（emoji 这类四字节字符由两个码元组成）单独切开，发到微信是乱码方块
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

export function splitText(text, maxChars = 1200) {
  const source = String(text ?? '');
  if (source.length <= maxChars) return [source];

  const chunks = [];
  let rest = source;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export { DEFAULT_BASE_URL, ITEM_TEXT, MAX_MEDIA_BYTES };
