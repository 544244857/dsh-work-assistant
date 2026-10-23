// 「对方正在输入」状态的刷新器。
//
// 微信的输入状态是一次性的：发一次过几秒就自己消失了，所以模型跑工具的时候要定时补发，
// 否则用户只能看到一个没有任何动静的聊天窗口，不知道机器人到底有没有在干活。
//
// 反过来也必须撤掉：回复一旦发出、这一轮结束，还挂着「正在输入」就是骗人。

export const DEFAULT_TYPING_INTERVAL_MS = 5000;

export function createTypingIndicator({ client, log = () => {}, intervalMs = DEFAULT_TYPING_INTERVAL_MS } = {}) {
  let timer = null;
  let target = null;

  function clear() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function ping() {
    if (!target) return;
    const current = target;
    try {
      await client?.sendTyping?.({ toUserId: current.toUserId, contextToken: current.contextToken, status: 1 });
    } catch (err) {
      // 状态是锦上添花，失败就当没这回事，绝不能影响正经回复
      log(`typing: 刷新失败（忽略）${err?.message ?? err}`);
    }
  }

  return {
    get active() {
      return Boolean(target);
    },

    // 同一个会话重复调用只更新 context_token，不会叠出多个定时器
    start(next) {
      const toUserId = String(next?.toUserId ?? '').trim();
      if (!toUserId || !client?.sendTyping) return;
      const sameTarget = target?.toUserId === toUserId;
      target = { toUserId, contextToken: String(next?.contextToken ?? '') };
      if (timer && sameTarget) return;
      clear();
      void ping();
      timer = setInterval(() => void ping(), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },

    async stop() {
      clear();
      if (!target) return;
      const current = target;
      target = null;
      try {
        await client?.sendTyping?.({ toUserId: current.toUserId, contextToken: current.contextToken, status: 2 });
      } catch (err) {
        log(`typing: 停止失败（忽略）${err?.message ?? err}`);
      }
    },
  };
}
