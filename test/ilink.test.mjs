import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryRejected, IlinkClient, parseInbound, splitText } from '../lib/ilink.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const result = handler(url, body, init);
    const payload = result ?? {};
    return {
      ok: payload.status === undefined ? true : payload.status >= 200 && payload.status < 300,
      status: payload.status ?? 200,
      json: async () => payload.data ?? {},
    };
  };
  return { impl, calls };
}

test('startLogin 解析二维码 id 与内容', async () => {
  const { impl, calls } = fakeFetch(() => ({ data: { qrcode: 'qr-1', qrcode_img_content: 'https://example.com/qr' } }));
  const client = new IlinkClient({ fetch: impl });

  const out = await client.startLogin();
  assert.deepEqual(out, { qrcodeId: 'qr-1', qrPayload: 'https://example.com/qr' });
  assert.match(calls[0].url, /\/ilink\/bot\/get_bot_qrcode\?bot_type=3$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['iLink-App-ClientVersion'], '1');
  assert.ok(calls[0].init.headers['X-WECHAT-UIN']);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('startLogin 缺字段时抛错', async () => {
  const { impl } = fakeFetch(() => ({ data: { qrcode: 'qr-1' } }));
  await assert.rejects(() => new IlinkClient({ fetch: impl }).startLogin(), /二维码字段缺失/);
});

test('pollLogin confirmed 时返回凭据，waiting/scanned/expired 各就各位', async () => {
  const states = [
    { data: { ret: 0, status: 'waiting' } },
    { data: { ret: 0, status: 'scanned' } },
    { data: { ret: 0, status: 'expired' } },
    { data: { ret: 0, status: 'confirmed', bot_token: 'tk', ilink_user_id: 'u1', baseurl: 'https://api.example.com' } },
  ];
  let i = 0;
  const { impl } = fakeFetch(() => states[i++]);
  const client = new IlinkClient({ fetch: impl });

  assert.equal((await client.pollLogin('qr-1')).status, 'waiting');
  assert.equal((await client.pollLogin('qr-1')).status, 'scanned');
  assert.equal((await client.pollLogin('qr-1')).status, 'expired');

  const done = await client.pollLogin('qr-1');
  assert.equal(done.status, 'confirmed');
  assert.deepEqual(done.credentials, { botToken: 'tk', ownerUserId: 'u1', baseUrl: 'https://api.example.com' });
});

test('pollLogin 用 tolerateRet1 容忍 ret=1', async () => {
  const { impl } = fakeFetch(() => ({ data: { ret: 1, errcode: 0 } }));
  const client = new IlinkClient({ fetch: impl });
  assert.equal((await client.pollLogin('qr-1')).status, 'waiting');
});

test('pollLogin confirmed 但没有 token 时报错', async () => {
  const { impl } = fakeFetch(() => ({ data: { ret: 0, status: 'confirmed', ilink_user_id: 'u1' } }));
  await assert.rejects(() => new IlinkClient({ fetch: impl }).pollLogin('qr-1'), /bot_token/);
});

test('setLogin 之后请求自动带上 Bearer 头', async () => {
  const { impl, calls } = fakeFetch(() => ({ data: { ret: 0, msgs: [] } }));
  const client = new IlinkClient({ fetch: impl });
  client.setLogin({ botToken: 'tk', baseUrl: 'https://api.example.com' });

  await client.getUpdates({ cursor: '' });
  assert.equal(calls[0].url, 'https://api.example.com/ilink/bot/getupdates');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tk');
  assert.equal(calls[0].init.headers.AuthorizationType, 'ilink_bot_token');
});

test('getUpdates 解析文本消息、推进游标、保留上下文 token', async () => {
  const { impl, calls } = fakeFetch(() => ({
    data: {
      ret: 0,
      get_updates_buf: 'cursor-2',
      msgs: [
        {
          from_user_id: 'u1',
          context_token: 'ctx-1',
          message_id: 'm-1',
          item_list: [{ type: 1, text_item: { text: '张三让我周五前把报销表整理好' } }],
        },
        { from_user_id: 'u1', message_id: 'm-2', item_list: [{ type: 2, image_item: {} }] },
      ],
    },
  }));
  const client = new IlinkClient({ fetch: impl });

  const out = await client.getUpdates({ cursor: 'cursor-1' });
  assert.equal(calls[0].body.get_updates_buf, 'cursor-1');
  assert.equal(out.nextCursor, 'cursor-2');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].text, '张三让我周五前把报销表整理好');
  assert.equal(out.messages[0].contextToken, 'ctx-1');
  assert.equal(out.messages[1].text, '');
  assert.equal(out.messages[1].unsupported, 1);
});

test('getUpdates 没给新游标时保持原值', async () => {
  const { impl } = fakeFetch(() => ({ data: { ret: 0, msgs: [] } }));
  const out = await new IlinkClient({ fetch: impl }).getUpdates({ cursor: 'same' });
  assert.equal(out.nextCursor, 'same');
});

test('sendText 组装正确的 body，并串行发出', async () => {
  const { impl, calls } = fakeFetch(() => ({ data: { ret: 0 } }));
  const client = new IlinkClient({ fetch: impl });
  client.setLogin({ botToken: 'tk' });

  await client.sendText({ toUserId: 'u1', text: '记下了', contextToken: 'ctx-1' });
  const body = calls[0].body;
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  assert.equal(body.msg.to_user_id, 'u1');
  assert.equal(body.msg.from_user_id, '');
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.context_token, 'ctx-1');
  assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '记下了' } }]);
  assert.equal(body.base_info.channel_version, '1.0.0');
  assert.ok(body.msg.client_id.startsWith('dsh-workassistant:'));
});

test('sendText 遇到 429 抛 DeliveryRejected（可重试）', async () => {
  const { impl } = fakeFetch(() => ({ status: 429, data: {} }));
  const client = new IlinkClient({ fetch: impl });
  await assert.rejects(() => client.sendText({ toUserId: 'u1', text: 'x' }), DeliveryRejected);
});

test('sendText 遇到 ret=-2 抛 DeliveryRejected，其它 ret 抛普通错误', async () => {
  const rejected = fakeFetch(() => ({ data: { ret: -2, errcode: 0 } }));
  await assert.rejects(
    () => new IlinkClient({ fetch: rejected.impl }).sendText({ toUserId: 'u1', text: 'x' }),
    DeliveryRejected,
  );

  const plain = fakeFetch(() => ({ data: { ret: -14, errcode: 0, errmsg: 'stale token' } }));
  await assert.rejects(
    () => new IlinkClient({ fetch: plain.impl }).sendText({ toUserId: 'u1', text: 'x' }),
    (err) => err instanceof Error && !(err instanceof DeliveryRejected) && /stale token/.test(err.message),
  );
});

test('sendText 5xx 但非 429/503 不当作可重试', async () => {
  const { impl } = fakeFetch(() => ({ status: 500, data: {} }));
  await assert.rejects(
    () => new IlinkClient({ fetch: impl }).sendText({ toUserId: 'u1', text: 'x' }),
    (err) => err instanceof DeliveryRejected === false && /HTTP 500/.test(err.message),
  );
});

test('ret=-14 抛 TokenExpired，好让上层知道该重新登录', async () => {
  for (const data of [
    { ret: -14, errcode: 0 },
    { ret: 0, errcode: -14 },
    { ret: -14, errcode: -14, errmsg: 'invalid token' },
  ]) {
    const { impl } = fakeFetch(() => ({ data }));
    await assert.rejects(
      () => new IlinkClient({ fetch: impl }).sendText({ toUserId: 'u1', text: 'x' }),
      (err) => err?.name === 'TokenExpired',
      `${JSON.stringify(data)} 应该被认成登录态失效`,
    );
  }
});

test('ret=0 且 errcode=0 就是成功，errmsg 里出现 -14 字样也不算失效', async () => {
  const { impl } = fakeFetch(() => ({ data: { ret: 0, errcode: 0, errmsg: 'ok, previous ret=-14 recovered' } }));
  await assert.doesNotReject(() => new IlinkClient({ fetch: impl }).sendText({ toUserId: 'u1', text: 'x' }));
});

test('普通的 ret 错误不会被误判成登录态失效', async () => {
  const { impl } = fakeFetch(() => ({ data: { ret: -1, errcode: 0, errmsg: 'invalid request' } }));
  await assert.rejects(
    () => new IlinkClient({ fetch: impl }).sendText({ toUserId: 'u1', text: 'x' }),
    (err) => err?.name !== 'TokenExpired',
  );
});

test('parseInbound 忽略非文本 message_type 与缺 from_user_id 的记录', () => {
  assert.equal(parseInbound({ message_type: 2, from_user_id: 'u1' }), null);
  assert.equal(parseInbound({ message_type: 1, item_list: [] }), null);
  assert.equal(parseInbound(null), null);
});

test('parseInbound 兼容 message 包裹与 voice 的 ASR 文本', () => {
  const wrapped = parseInbound({
    message: {
      from_user_id: 'u1',
      message_id: 'm-9',
      item_list: [{ type: 3, voice_item: { text: '明天上午十点开会' } }],
    },
  });
  assert.equal(wrapped.text, '[语音] 明天上午十点开会');
  assert.equal(wrapped.unsupported, 0);
  assert.equal(wrapped.messageId, 'm-9');
});

test('parseInbound 没有 message_id 时用发送者和时间兜底', () => {
  const parsed = parseInbound({
    from_user_id: 'u1',
    create_time_ms: 1234,
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
  });
  assert.equal(parsed.messageId, 'u1:1234');
});

test('splitText 短文本原样返回', () => {
  assert.deepEqual(splitText('短消息', 1200), ['短消息']);
});

test('splitText 优先在换行处切，且每段不超上限', () => {
  const line = '这是一行比较长的内容用于测试切分';
  const text = Array.from({ length: 60 }, (_, i) => `${i}${line}`).join('\n');
  const chunks = splitText(text, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `超长 ${chunk.length}`);
  assert.equal(chunks.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

// emoji 由两个 UTF-16 码元组成，切在中间会变成两个乱码方块
test('splitText 不会把 emoji 切成两半', () => {
  const loneSurrogate = (s) => /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(s);
  const cases = [
    ['一二三四五六七八九😀abcdefghij', 10],
    [`${'x'.repeat(9)}😀尾巴`, 10],
    ['😀'.repeat(40), 7],
    ['\n'.repeat(5) + '😀😀😀😀😀😀', 3],
  ];
  for (const [text, max] of cases) {
    const chunks = splitText(text, max);
    for (const chunk of chunks) assert.ok(!loneSurrogate(chunk), `被切坏：${JSON.stringify(chunk)}`);
    assert.equal(chunks.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), '切完不能丢内容');
  }
});

// ── 「正在输入」通行证与状态发送 ───────────────────────────
test('sendTyping 先取 typing_ticket 再发状态，并按用户缓存票', async () => {
  const { impl, calls } = fakeFetch((url) => {
    if (url.endsWith('/ilink/bot/getconfig')) return { data: { ret: 0, typing_ticket: 'tk-1' } };
    return { data: { ret: 0 } };
  });
  const client = new IlinkClient({ fetch: impl });

  assert.equal(await client.sendTyping({ toUserId: 'u1', contextToken: 'c1', status: 1 }), true);
  assert.equal(await client.sendTyping({ toUserId: 'u1', contextToken: 'c1', status: 2 }), true);

  const configs = calls.filter((c) => c.url.endsWith('/ilink/bot/getconfig'));
  const typings = calls.filter((c) => c.url.endsWith('/ilink/bot/sendtyping'));
  assert.equal(configs.length, 1, '同一用户只该取一次票');
  assert.equal(typings.length, 2);
  assert.equal(typings[0].body.typing_ticket, 'tk-1');
  assert.equal(typings[0].body.status, 1);
  assert.equal(typings[1].body.status, 2);
  assert.equal(configs[0].body.context_token, 'c1');
});

test('拿不到 typing_ticket 时不发状态，也不抛错', async () => {
  const { impl, calls } = fakeFetch(() => ({ data: { ret: 0 } }));
  const client = new IlinkClient({ fetch: impl });

  assert.equal(await client.sendTyping({ toUserId: 'u1', contextToken: 'c', status: 1 }), false);
  assert.equal(calls.filter((c) => c.url.endsWith('/ilink/bot/sendtyping')).length, 0);
});

test('sendtyping 失败时丢掉缓存的票，下次重新取', async () => {
  let ticketRound = 0;
  let typingRound = 0;
  const { impl } = fakeFetch((url) => {
    if (url.endsWith('/ilink/bot/getconfig')) {
      ticketRound += 1;
      return { data: { ret: 0, typing_ticket: `tk-${ticketRound}` } };
    }
    typingRound += 1;
    if (typingRound === 1) return { data: { ret: -1, errmsg: 'bad ticket' } };
    return { data: { ret: 0 } };
  });
  const client = new IlinkClient({ fetch: impl });

  assert.equal(await client.sendTyping({ toUserId: 'u1', contextToken: 'c', status: 1 }), false);
  assert.equal(await client.sendTyping({ toUserId: 'u1', contextToken: 'c', status: 1 }), true);
  assert.equal(ticketRound, 2, '票失效后应重新取一张');
});
