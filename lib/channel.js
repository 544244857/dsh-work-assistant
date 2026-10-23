// 入站管道：去重、owner 校验、合并窗口。
// 微信会把一句话拆成几条发过来，短窗口合并能让模型看到完整意图，也省 token。

const MAX_SEEN = 200;

export class InboundChannel {
  constructor(options = {}) {
    this.onBatch = options.onBatch ?? (async () => {});
    this.mergeWindowMs = Number.isFinite(options.mergeWindowMs) ? Math.max(0, options.mergeWindowMs) : 1500;
    this.ownerUserId = typeof options.ownerUserId === 'string' ? options.ownerUserId : '';
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.log = options.log ?? (() => {});

    this.seen = [];
    this.buffer = [];
    this.timer = null;
    this.contextToken = '';
    this.flushing = null;
  }

  // 只认 owner 本人；陌生人发来一律丢掉，避免助理被别人指挥
  isOwner(fromUserId) {
    if (!this.ownerUserId) return true;
    return fromUserId === this.ownerUserId;
  }

  hasSeen(messageId) {
    return Boolean(messageId) && this.seen.includes(messageId);
  }

  remember(messageId) {
    if (!messageId) return;
    this.seen.push(messageId);
    if (this.seen.length > MAX_SEEN) this.seen.splice(0, this.seen.length - MAX_SEEN);
  }

  accept(message) {
    if (!message || typeof message !== 'object' || !message.fromUserId) return { status: 'ignored', reason: 'empty' };
    if (!this.isOwner(message.fromUserId)) return { status: 'ignored', reason: 'not_owner' };
    if (this.hasSeen(message.messageId)) return { status: 'ignored', reason: 'duplicate' };

    this.remember(message.messageId);
    this.buffer.push(message);

    if (message.contextToken) this.contextToken = message.contextToken;
    this.arm();
    return { status: 'accepted' };
  }

  arm() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.flush();
    }, this.mergeWindowMs);
  }

  takeBuffer() {
    const batch = this.buffer;
    this.buffer = [];
    const texts = [];
    const media = [];
    let unsupported = 0;
    for (const message of batch) {
      if (message.text) texts.push(message.text);
      if (Array.isArray(message.media)) media.push(...message.media);
      unsupported += Number(message.unsupported) || 0;
    }
    // 只有既没文字也没媒体时才提示；收到图片不该再劝人「改发文字」
    if (!texts.length && !media.length && unsupported > 0) texts.push('[收到非文本消息，暂时只认文字，麻烦改发文字]');

    return {
      chatId: batch[0]?.fromUserId ?? '',
      text: texts.join('\n'),
      media,
      contextToken: this.contextToken,
      messageIds: batch.map((m) => m.messageId).filter(Boolean),
      unsupported,
    };
  }

  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.buffer.length) return null;

    const batch = this.takeBuffer();
    if (!batch.text && !batch.media.length) {
      this.log('inbound: 合并后为空，丢弃');
      return null;
    }

    this.flushing = Promise.resolve()
      .then(() => this.onBatch(batch))
      .catch((err) => {
        this.log(`inbound: 处理失败 ${err?.message ?? err}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  // 登出/换号时清空，避免旧缓冲串到新会话
  reset() {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.contextToken = '';
    this.seen = [];
  }
}
