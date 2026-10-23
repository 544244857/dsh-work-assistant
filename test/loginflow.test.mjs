import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideLoginStep } from '../lib/loginflow.js';

// 这一组用例锁住一个曾经真出过的坑：登录页每 2 秒轮询一次，
// 如果每次轮询都申请新二维码，用户看到的码会在扫码前就被换掉，永远扫不上。

test('已登录时不申请新码', () => {
  const step = decideLoginStep({
    loggedIn: true,
    login: { qrcodeId: 'a', qrPayload: 'p', status: 'confirmed' },
    watching: true,
  });
  assert.equal(step, 'loggedIn');
});

test('没有二维码时才申请', () => {
  assert.equal(decideLoginStep({ loggedIn: false, login: null, watching: false }), 'fresh');
  assert.equal(decideLoginStep({ loggedIn: false, login: {}, watching: false }), 'fresh');
});

test('码已经在了就只读，不换', () => {
  const login = { qrcodeId: 'a', qrPayload: 'p', status: 'waiting' };
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: true }), 'read');
  // 连续轮询仍然只读，这是防回归的关键断言
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: true }), 'read');
});

test('只有 qrcodeId 没有 payload 的旧状态要重新申请', () => {
  const login = { qrcodeId: 'a', status: 'waiting' };
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: true }), 'fresh');
});

test('码过期了才换新的', () => {
  const login = { qrcodeId: 'a', qrPayload: 'p', status: 'expired' };
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: true }), 'fresh');
});

test('码已确认但还没落凭据时不要动它', () => {
  const login = { qrcodeId: 'a', qrPayload: 'p', status: 'confirmed' };
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: false }), 'read');
});

test('进程重启后把监听接回去而不是换码', () => {
  const login = { qrcodeId: 'a', qrPayload: 'p', status: 'waiting' };
  assert.equal(decideLoginStep({ loggedIn: false, login, watching: false }), 'restore');
});
