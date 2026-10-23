import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTypingIndicator } from '../lib/typing.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async sendTyping(payload) {
      calls.push(payload);
      return true;
    },
  };
}

test('start 先发一次状态 1，之后按间隔补发', async () => {
  const client = fakeClient();
  const typing = createTypingIndicator({ client, intervalMs: 20 });
  typing.start({ toUserId: 'u1', contextToken: 'ctx' });
  assert.deepEqual(client.calls, [{ toUserId: 'u1', contextToken: 'ctx', status: 1 }]);

  await new Promise((r) => setTimeout(r, 60));
  await typing.stop();
  // 至少补发过一次，说明输入状态不会因为平台自动消失而断掉
  assert.ok(client.calls.filter((c) => c.status === 1).length >= 2);
});

test('stop 发状态 2 并停掉定时器', async () => {
  const client = fakeClient();
  const typing = createTypingIndicator({ client, intervalMs: 20 });
  typing.start({ toUserId: 'u1', contextToken: 'ctx' });
  await typing.stop();

  assert.equal(client.calls.at(-1).status, 2);
  assert.equal(typing.active, false);

  const after = client.calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(client.calls.length, after, '停掉以后不该再有请求');
});

test('同一会话重复 start 不会叠出多个定时器', async () => {
  const client = fakeClient();
  const typing = createTypingIndicator({ client, intervalMs: 30 });
  typing.start({ toUserId: 'u1', contextToken: 'a' });
  typing.start({ toUserId: 'u1', contextToken: 'b' });
  typing.start({ toUserId: 'u1', contextToken: 'c' });

  await new Promise((r) => setTimeout(r, 70));
  await typing.stop();
  // 一个间隔里只该有一次补发；叠了定时器就会成倍
  const pings = client.calls.filter((c) => c.status === 1).length;
  assert.ok(pings <= 4, `补发次数 ${pings} 太多，定时器叠了`);
});

test('没登录/没客户端时不抛错，静默跳过', async () => {
  const typing = createTypingIndicator({ client: null });
  typing.start({ toUserId: 'u1', contextToken: 'ctx' });
  assert.equal(typing.active, false);
  await typing.stop();
});

test('sendTyping 抛错时不影响主流程', async () => {
  const typing = createTypingIndicator({
    client: {
      async sendTyping() {
        throw new Error('网络炸了');
      },
    },
    intervalMs: 20,
  });
  typing.start({ toUserId: 'u1', contextToken: 'ctx' });
  await new Promise((r) => setTimeout(r, 50));
  await typing.stop();
  assert.equal(typing.active, false);
});
