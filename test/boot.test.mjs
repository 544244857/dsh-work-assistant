// boot 流程的回归测试。
// 背景：宿主 cordis 的反射代理没声明 inject 就取服务会直接抛
// cannot get property "webServer" without inject。早期版本 boot 里写
// `ctx.get?.('webServer') ?? ctx.webServer`，宿主启动时 webServer 还没就绪，
// 就走到后半个 ?? 分支把整个 boot 炸掉（路由没注册、登录页 401）。
// 这里用一个「读服务就抛错」的假 ctx 把那个场景复现出来。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../index.js';

const LOG_VALUE = 'cannot get property "webServer" without inject';

// 造一个像 cordis 的 ctx：没 inject 就读服务属性 -> 抛错
function makeCtx({ withInject = true, withWebServer = true } = {}) {
  const effects = [];
  let registered = null;
  const services = {};

  const scoped = {
    get webServer() {
      if (!withWebServer) throw new Error(LOG_VALUE);
      return services.webServer;
    },
  };

  const ctx = {
    get: () => undefined, // 宿主启动瞬间服务还没就绪
    effect(fn, name) {
      effects.push({ fn, name });
      const dispose = fn();
      if (typeof dispose === 'function') effects[effects.length - 1].dispose = dispose;
      return dispose;
    },
    on: () => () => {},
    locale: () => (key) => key,
  };

  // 这个是关键：裸读直接抛，跟真实 cordis 一样
  Object.defineProperty(ctx, 'webServer', {
    get() {
      throw new Error(LOG_VALUE);
    },
  });

  if (withInject) {
    ctx.inject = (deps, cb) => {
      assert.ok(Array.isArray(deps), 'inject 第一参应该是依赖数组');
      for (const dep of deps) {
        if (dep === 'webServer' && !withWebServer) throw new Error(LOG_VALUE);
      }
      cb(scoped);
    };
  }

  services.webServer = {
    register(route) {
      registered = route;
      return () => {
        registered = null;
      };
    },
  };

  const cleanup = () => {
    for (const item of effects.reverse()) {
      try {
        item.dispose?.();
      } catch {
        /* 忽略 */
      }
    }
  };

  return { ctx, cleanup, route: () => registered };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wa-boot-'));
}

// boot 是异步的（ctx.effect 里 void 一个 async IIFE），等一小会
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

// Windows 上 SQLite 的文件句柄关得比 await 慢一截：宿主租约的心跳和 dispose
// 都是异步的，测试收尾立刻删目录会 EPERM。这里退让着删，别让清理把用例带红。
async function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

test('宿主还没就绪 webServer 时，boot 不会因为裸读服务而崩掉', async () => {
  const dir = tempDir();
  const { ctx, cleanup, route } = makeCtx();

  apply(ctx, { stateDir: dir });
  await settle();

  const log = readFileSync(join(dir, 'gateway.log'), 'utf8');
  assert.match(log, /http: 已注册/);
  assert.doesNotMatch(log, /boot: 失败/);
  assert.ok(route(), '路由应该注册上了');
  assert.equal(route().path, '/api/dsh-workassistant');
  assert.equal(route().kind, 'prefix');

  cleanup();
  await removeDir(dir);
});

test('注册上的 handler 能直接回登录页', async () => {
  const dir = tempDir();
  const { ctx, cleanup, route } = makeCtx();

  apply(ctx, { stateDir: dir });
  await settle();

  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
      return this;
    },
    end(body) {
      this.body = body ?? '';
    },
  };

  await route().handler(
    { url: '/login', method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /微信登录/);

  cleanup();
  await removeDir(dir);
});

test('宿主没有 ctx.inject 时只记一条日志，不抛错', async () => {
  const dir = tempDir();
  const { ctx, cleanup, route } = makeCtx({ withInject: false });

  apply(ctx, { stateDir: dir });
  await settle();

  const log = readFileSync(join(dir, 'gateway.log'), 'utf8');
  assert.match(log, /宿主没有 ctx\.inject|boot: 失败/);
  // 没有 inject 就注册不上路由，但不能因此把 boot 打断
  assert.equal(route(), null);

  cleanup();
  await removeDir(dir);
});

test('设置页改过的值在重启后仍然生效', async () => {
  const dir = tempDir();
  const { writeFileSync } = await import('node:fs');

  // 模拟「上次在设置页里改过时间」，重启后 patch 里的默认值不能盖掉它
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ version: 1, settingsOverrides: { dailyBriefTimes: ['07:15'] } }),
    'utf8',
  );

  const { ctx, cleanup, route } = makeCtx();
  apply(ctx, { stateDir: dir, dailyBriefTimes: ['09:00', '18:30'] });
  await settle();

  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
      return this;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await route().handler(
    { url: '/overview', method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  assert.equal(res.statusCode, 200);

  const data = JSON.parse(res.body);
  assert.deepEqual(data.settings.dailyBriefTimes, ['07:15'], 'state 里的设置要盖过 patch 默认值');

  cleanup();
  await removeDir(dir);
});

test('pushBlocker 说清楚为什么发不出去', async () => {
  const { pushBlocker } = await import('../index.js');

  assert.equal(pushBlocker({ botToken: 't', ownerUserId: 'u', contextToken: 'c' }), null);
  assert.equal(pushBlocker({ botToken: '', ownerUserId: 'u', contextToken: 'c' }), 'not-logged-in');
  assert.equal(pushBlocker({ botToken: 't', ownerUserId: '', contextToken: 'c' }), 'not-logged-in');
  // 登录了但微信还没给过 context_token：这是「机器人不能先开口」的场景，必须单独认出来
  assert.equal(pushBlocker({ botToken: 't', ownerUserId: 'u', contextToken: '' }), 'no-context-token');
});
