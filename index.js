// 插件入口。
// 这里刻意不用对象级 inject：桌面端收集注入表只做一次，对象级 inject 会让 apply 被推迟到收集之后，
// 结果是路由和工具都没挂上。改成在 apply 里用 ctx.inject 局部等待（dsh-whale-widget 踩过这个坑）。

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataPaths, stateDir as resolveStateDir } from './lib/paths.js';
import { readJson, readText } from './lib/jsonfile.js';
import { readState, writeState } from './lib/db.js';
import { createStore, seedLedger } from './lib/store.js';
import { InboundChannel } from './lib/channel.js';
import { IlinkClient, splitText } from './lib/ilink.js';
import { Assistant, SESSION_ID, assistantText } from './lib/assistant.js';
import { createTools } from './lib/tools.js';
import { createAssignmentStore, seedAssignments } from './lib/assignments.js';
import { createAssignmentRuntime } from './lib/assignment-runtime.js';
import { reportTools } from './lib/assignment-tools.js';
import { createTicker, inQuietHours, normalizeBriefTimes } from './lib/ticker.js';
import { createHttpApi, BASE_PATH } from './lib/http.js';
import { createTypingIndicator } from './lib/typing.js';
import { buildMediaContent } from './lib/inbound-media.js';
import { decideLoginStep } from './lib/loginflow.js';
import { PRIORITIES, STATUSES, describeRecurrence, digest, listItems, renderDigest, updateItem } from './lib/ledger.js';
import { buildStats } from './lib/stats.js';
import { emptyIndex, listDocs, readDoc, search, seedKb, writeDoc } from './lib/kb.js';
import { createAnalyzer, recordMessage } from './lib/analyzer.js';
import { queryPerson, queryPeople } from './lib/graph.js';
import { countMessages, listConversations, readConversation } from './lib/conversations.js';
import { backfillMessages } from './lib/backfill.js';
import { createHostLease } from './lib/host-lease.js';
import { resolveZone } from './lib/time.js';

export const name = 'dsh-work-assistant';

const DEFAULTS = {
  stateDir: '',
  // 助手会话挂哪个预设：空字符串＝用宿主自己的默认预设。
  // 不写死 'standard' —— 别人装这个插件时，他配的默认预设才是「我的人格」。
  agentPreset: '',
  permissionPreset: 'workspace-write',
  dailyBriefTimes: ['09:00', '18:30'],
  tickIntervalSeconds: 60,
  mergeWindowMs: 1500,
  maxMessageChars: 1200,
  timeZone: '',
  // 半夜不推消息。空字符串表示关掉安静时段。
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  // 每周复盘：weekday 1-7（1 是周一），time 形如 18:00。weekday 设 0 表示关掉。
  weeklyReviewWeekday: 5,
  weeklyReviewTime: '18:00',
  // 副手：最多同时开几个、在哪儿干活、用什么模型和预设。空字符串表示跟宿主默认。
  maxAssignments: 3,
  assignmentCwd: '',
  assignmentModel: '',
  assignmentPreset: '',
  // 知识库分析：把聊天、工作项、知识库里的东西定期嚼一遍，抽出人和关系。
  // 默认每天凌晨 3 点跑一次；analysisIdleMinutes 是「闲多久算闲」，0 表示关掉闲时分析。
  analysisEnabled: true,
  analysisDailyTime: '03:00',
  analysisIdleMinutes: 30,
  analysisProvider: '',
  analysisModel: '',
  // 助手会话本身用什么模型/推理强度。空字符串表示跟宿主默认走。
  // 这三项和 agentPreset / permissionPreset 一起，对应设置页里「会话」那一组选择。
  agentProvider: '',
  agentModel: '',
  agentReasoningEffort: '',
};

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  config.tickIntervalSeconds = Number.isFinite(config.tickIntervalSeconds)
    ? Math.max(10, Math.floor(config.tickIntervalSeconds))
    : DEFAULTS.tickIntervalSeconds;
  config.mergeWindowMs = Number.isFinite(config.mergeWindowMs)
    ? Math.max(0, Math.floor(config.mergeWindowMs))
    : DEFAULTS.mergeWindowMs;
  config.maxMessageChars = Number.isFinite(config.maxMessageChars)
    ? Math.max(200, Math.floor(config.maxMessageChars))
    : DEFAULTS.maxMessageChars;
  if (!Array.isArray(config.dailyBriefTimes)) config.dailyBriefTimes = DEFAULTS.dailyBriefTimes;
  // 并发上限夹到 1..32：0 会让派活永远失败，几百会让宿主机喘不过气
  const limit = Number(config.maxAssignments);
  config.maxAssignments = Number.isFinite(limit)
    ? Math.min(32, Math.max(1, Math.floor(limit)))
    : DEFAULTS.maxAssignments;
  return config;
}

// 安静时段拆成 ticker 认的形状；两端都填了才算开
function quietHoursOf(config) {
  const start = typeof config.quietHoursStart === 'string' ? config.quietHoursStart.trim() : '';
  const end = typeof config.quietHoursEnd === 'string' ? config.quietHoursEnd.trim() : '';
  if (!start || !end) return null;
  return { start, end };
}

// 周复盘配置；weekday 设 0 或空表示关掉
function weeklyReviewOf(config) {
  const weekday = Number(config.weeklyReviewWeekday);
  const time = typeof config.weeklyReviewTime === 'string' ? config.weeklyReviewTime.trim() : '';
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !time) return null;
  return { weekday, time };
}

function emptyState() {
  return {
    version: 1,
    botToken: '',
    baseUrl: '',
    ownerUserId: '',
    cursor: '',
    status: 'idle',
    lastPollAt: '',
    lastError: '',
    briefs: null,
    login: null,
    settingsOverrides: null,
  };
}

// 微信的规则：机器人只能「回」，不能「主动发起」。
// 必须先收到你的一条消息、拿到那一轮的 context_token，才有资格往回发；
// 少了它调 sendmessage 一律被拒（ret=-2）。这里把「发不出去的原因」抽成纯函数，
// 好让接口和页面能说人话，也方便单测不联网就能覆盖。
export function pushBlocker(state) {
  if (!state?.botToken || !state?.ownerUserId) return 'not-logged-in';
  if (!state?.contextToken) return 'no-context-token';
  return null;
}

function createLog(file, maxBytes = 1024 * 1024) {
  let written = 0;
  let truncated = false;
  return (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    try {
      // 超过 1MB 就截断重来；这是排错日志，不是审计
      if (!truncated && written > maxBytes) {
        truncated = true;
        writeFileSync(file, text, 'utf8');
        written = text.length;
        return;
      }
      appendFileSync(file, text, 'utf8');
      written += text.length;
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
  };
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const dir = resolveStateDir(config);
  mkdirSync(dir, { recursive: true });
  const paths = dataPaths(dir);
  const log = createLog(paths.log);
  const zone = resolveZone(config.timeZone);

  let state = emptyState();
  let stateLoaded = false;
  let store = null;
  let client = null;
  let channel = null;
  let assistant = null;
  // 最近一条微信消息来自谁。助手回复按这个人的名下归档，面板里才不会分成两栏。
  let lastChatId = '';
  let typing = null;
  let ticker = null;
  let assignmentStore = null;
  let assignmentRuntime = null;
  // 安静时段里副手交的报告先攒着，出了安静时段再一起推，免得半夜响
  let quietReports = [];
  let reportFlusher = null;
  let analyzer = null;
  // 同一个数据目录可能被桌面端和 dsh web 同时打开，租约决定谁真的去轮询、去发提醒
  let lease = null;
  let pollAbort = null;
  let pollStarted = false;
  let loginWatcher = null;
  let loginPolling = false;
  let disposers = [];

  const status = () => ({
    loggedIn: Boolean(state.botToken && state.ownerUserId),
    ownerUserId: state.ownerUserId,
    sessionId: SESSION_ID,
    status: state.status,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    loginStatus: state.login?.status ?? 'idle',
    canPush: pushBlocker(state) === null,
    // primary 表示本实例在真正干活；standby 是「另一个宿主在跑，我等着」。
    // 面板要靠它说清楚「为什么这条提醒是别人发的 / 为什么这边不动」。
    role: lease ? (lease.isPrimary() ? 'primary' : 'standby') : 'primary',
    hosts: lease ? lease.hosts().map((row) => ({ pid: row.pid, role: row.role, startedAt: row.startedAt })) : [],
    stateDir: dir,
    loginUrl: `${BASE_PATH}/login`,
  });

  async function loadState() {
    if (stateLoaded) return state;
    // 读失败（锁、IO）必须抛：当成「没状态」再 saveState 一次，
    // 会把登录态和设置整片洗成默认值。
    let data = await readState(paths, { log });
    if (data && Object.keys(data).length) {
      state = { ...emptyState(), ...data };
      stateLoaded = true;
      return state;
    }
    if (!data || !Object.keys(data).length) {
      // 老版本把状态放在 state.json，第一次用数据库时顺手搬过来
      const legacy = await readJson(paths.state, null, {
        onCorrupt: (err, backup) => log(`state: 老状态文件解析失败（${err?.message ?? err}），原文件已另存为 ${backup || '（改名失败）'}，本次按未登录启动`),
      });
      if (legacy && typeof legacy === 'object') {
        data = legacy;
        await writeState(paths, data, { log }).catch(() => {});
      }
    }
    if (data && typeof data === 'object') state = { ...emptyState(), ...data };
    stateLoaded = true;
    return state;
  }

  async function saveState() {
    await writeState(paths, state, { log });
  }

  function push(text) {
    const body = String(text ?? '').trim();
    if (!body) return Promise.resolve(false);
    const blocker = pushBlocker(state);
    if (blocker === 'not-logged-in') {
      log('push: 未登录，丢弃');
      return Promise.resolve(false);
    }
    // 没有 context_token 就一定发不出去，先记一条能看懂的日志再试，
    // 省得界面只报「没发出去」却不知道是缺了「先给机器人发一条消息」这一步。
    if (blocker === 'no-context-token') {
      log('push: 还没收到过你的消息，微信不允许机器人主动发起对话');
    }
    const chunks = splitText(body, config.maxMessageChars);
    return (async () => {
      for (const chunk of chunks) {
        await client.sendText({
          toUserId: state.ownerUserId,
          text: chunk,
          contextToken: state.contextToken ?? '',
        });
      }
      return true;
    })().catch((err) => {
      log(`push: 发送失败 ${err?.message ?? err}`);
      return false;
    });
  }

  // 发文件走同一套登录判断：没登录、没 context_token 都发不出去，
  // 但这里要抛错而不是静默返回 false —— 工具层要把原因说给模型听。
  async function sendFile(filePath, caption = '') {
    const blocker = pushBlocker(state);
    if (blocker === 'not-logged-in') throw new Error('还没登录微信，先扫码');
    if (blocker === 'no-context-token') throw new Error('还没收到过你的消息，微信不允许机器人主动发起对话');
    const sent = await client.sendMedia({
      toUserId: state.ownerUserId,
      filePath,
      caption: String(caption ?? '').trim(),
      contextToken: state.contextToken ?? '',
    });
    log(`push: 已发送文件 ${sent.name}（${sent.bytes} 字节）`);
    return sent;
  }

  // 副手交的报告走这里推。安静时段先攒着 —— 半夜三点弹「副手交活了」只会让人关通知。
  // 攒的内容由 ticker 下一次 tick 补推，不会丢。
  async function pushAssignmentReport(text) {
    const body = String(text ?? '').trim();
    if (!body) return false;
    if (inQuietHours(new Date(), zone, quietHoursOf(config))) {
      quietReports.push(body);
      log(`assignment: 安静时段，报告攒着（${quietReports.length} 条）`);
      return false;
    }
    return push(body);
  }

  // 安静时段结束后把攒着的报告合成一条推出去
  async function flushQuietReports() {
    if (!quietReports.length) return 0;
    if (inQuietHours(new Date(), zone, quietHoursOf(config))) return 0;
    const batch = quietReports.slice();
    quietReports = [];
    const head = batch.length === 1 ? batch[0] : `安静时段里副手交了 ${batch.length} 份报告：`;
    const body = batch.length === 1 ? head : `${head}\n${batch.map((line) => `- ${line}`).join('\n')}`;
    const sent = await push(body);
    if (sent === false) {
      // 没推出去就放回去，下一轮再试，别静默丢掉
      quietReports = [...batch, ...quietReports];
      return 0;
    }
    return batch.length;
  }

  // ── 长轮询 ─────────────────────────────────────────────
  async function pollOnce(signal) {
    const { messages, nextCursor } = await client.getUpdates({
      cursor: state.cursor,
      timeoutSecs: 70,
      signal,
    });
    if (nextCursor && nextCursor !== state.cursor) {
      state.cursor = nextCursor;
      await saveState();
    }
    state.lastPollAt = new Date().toISOString();
    state.lastError = '';
    for (const message of messages) channel.accept(message);
  }

  function startPolling() {
    if (pollStarted) return;
    // 待命实例（另一个宿主在跑）绝不轮询：两边都拉同一个机器人，
    // 消息会被谁先拿到谁先处理，提醒也会推两遍。
    if (lease && !lease.isPrimary()) {
      log('poll: 本实例在待命，不轮询');
      return;
    }
    pollStarted = true;
    state.status = 'running';
    // 微信的登录态会失效（errcode -14）。失效后长轮询会一直报错，
    // 界面还显示 running，看起来在跑其实一条消息都收不到。
    // 所以连续几次失效就把凭据清掉、让用户重新扫码，而不是无声无息地重试到天荒地老。
    let staleCount = 0;

    const loop = async () => {
      if (pollStarted) {
        pollAbort = new AbortController();
        try {
          await pollOnce(pollAbort.signal);
          staleCount = 0;
        } catch (err) {
          if (err?.name !== 'AbortError') {
            state.lastError = String(err?.message ?? err);
            log(`poll: ${state.lastError}`);
            if (err?.name === 'TokenExpired') {
              staleCount += 1;
              if (staleCount >= 3) {
                await forgetLogin('登录态失效，需要重新扫码');
                return;
              }
              state.status = 'error';
              await sleep(5000);
              state.status = 'running';
            } else {
              staleCount = 0;
              state.status = 'error';
              await sleep(5000);
              state.status = 'running';
            }
          }
        } finally {
          pollAbort = null;
        }
      }
      if (pollStarted) setTimeout(loop, 200);
    };
    void loop();
    log('poll: 已启动');
  }

  // 清掉失效的凭据并回到「等扫码」状态。不清 cursor 之外的其它数据（账本不能动）。
  async function forgetLogin(reason) {
    log(`login: ${reason}`);
    stopPolling();
    client.clearLogin();
    state.botToken = '';
    state.ownerUserId = '';
    state.cursor = '';
    state.contextToken = '';
    state.status = 'idle';
    state.lastError = reason;
    state.login = null;
    await saveState();
  }

  function stopPolling() {
    pollStarted = false;
    state.status = 'idle';
    if (pollAbort) {
      try {
        pollAbort.abort();
      } catch {
        /* 忽略 */
      }
      pollAbort = null;
    }
  }

  // ── 登录 ───────────────────────────────────────────────
  async function beginLogin() {
    await loadState();
    stopPolling();
    client.clearLogin();
    state.botToken = '';
    state.ownerUserId = '';
    state.cursor = '';
    const { qrcodeId, qrPayload } = await client.startLogin();
    // qrPayload 一起存盘：页面刷新、进程重启后还能把同一张码画出来，
    // 否则只能重新申请，正在扫的那张就被作废了
    state.login = { qrcodeId, qrPayload, status: 'waiting', startedAt: new Date().toISOString() };
    await saveState();
    log('login: 已获取二维码');
    watchLogin(qrcodeId);
    return { status: 'waiting', qrcodeId, qrPayload };
  }

  // 登录状态只由这个 watcher 去问微信，HTTP 请求只读结果。
  // 微信这个接口是长轮询（最长 40 秒才返回），所以加了防重入：上一轮没回来就不再发新的。
  function watchLogin(qrcodeId) {
    if (loginWatcher) clearInterval(loginWatcher);
    loginWatcher = setInterval(async () => {
      if (loginPolling) return;
      const current = state.login;
      if (!current || current.qrcodeId !== qrcodeId) {
        clearInterval(loginWatcher);
        loginWatcher = null;
        return;
      }
      loginPolling = true;
      try {
        const result = await client.pollLogin(qrcodeId);
        state.login.status = result.status;
        if (result.status === 'confirmed') {
          const creds = result.credentials ?? {};
          state.botToken = creds.botToken ?? '';
          state.ownerUserId = creds.ownerUserId ?? '';
          if (creds.baseUrl) client.setLogin({ baseUrl: creds.baseUrl });
          client.setLogin({ botToken: state.botToken });
          state.login = {
            qrcodeId,
            qrPayload: current.qrPayload,
            status: 'confirmed',
            confirmedAt: new Date().toISOString(),
          };
          await saveState();
          log(`login: 已确认，owner=${state.ownerUserId ? '已记录' : '未返回'}`);
          if (loginWatcher) {
            clearInterval(loginWatcher);
            loginWatcher = null;
          }
          startPolling();
          return;
        }
        await saveState();
        if (result.status === 'expired') {
          // 停掉 watcher，等页面下次轮询时由 decideLoginStep 统一换新码
          if (loginWatcher) {
            clearInterval(loginWatcher);
            loginWatcher = null;
          }
          return;
        }
      } catch (err) {
        const message = String(err?.message ?? err);
        if (/expired/i.test(message)) {
          state.login.status = 'expired';
          await saveState();
          if (loginWatcher) {
            clearInterval(loginWatcher);
            loginWatcher = null;
          }
        } else {
          log(`login: 轮询失败 ${message}`);
        }
      } finally {
        loginPolling = false;
      }
    }, 2000);
    if (typeof loginWatcher.unref === 'function') loginWatcher.unref();
  }

  // 页面每 2 秒问一次，这里必须是个几乎不干活的读操作：
  // 早期版本在这里又申请又轮询，结果页面一刷就把用户正在扫的码换掉，永远扫不上。
  async function pollLoginNow() {
    await loadState();
    const step = decideLoginStep({
      loggedIn: Boolean(state.botToken && state.ownerUserId),
      login: state.login,
      watching: Boolean(loginWatcher),
    });

    if (step === 'loggedIn') {
      return { status: 'loggedIn' };
    }

    if (step === 'fresh') {
      try {
        await beginLogin();
      } catch (err) {
        log(`login: 取二维码失败 ${err?.message ?? err}`);
        return { status: 'error', error: String(err?.message ?? err) };
      }
    } else if (step === 'restore') {
      // 进程重启过：磁盘上还有没扫的码，把 watcher 接回去继续等
      watchLogin(state.login.qrcodeId);
    }

    return {
      status: state.login?.status ?? 'idle',
      qrPayload: state.login?.qrPayload ?? '',
      qrcodeId: state.login?.qrcodeId ?? '',
    };
  }

  async function relogin() {
    await loadState();
    if (loginWatcher) {
      clearInterval(loginWatcher);
      loginWatcher = null;
    }
    return beginLogin();
  }

  async function renderQr(payload) {
    try {
      const mod = await import('qrcode');
      const QRCode = mod?.default ?? mod;
      const toDataURL = QRCode?.toDataURL ?? QRCode?.default?.toDataURL;
      if (typeof toDataURL !== 'function') return '';
      return await toDataURL(payload, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
    } catch (err) {
      log(`qr: 渲染失败 ${err?.message ?? err}`);
      return '';
    }
  }

  // ── 设置页用的接口 ─────────────────────────────────────
  // 一次把登录状态、账本概览、生效中的设置全给出去，页面只打一个请求
  async function getOverview() {
    const ledger = store ? await store.read((data) => data) : { items: [], seq: {} };
    const now = new Date();
    const data = digest(ledger, now, zone);
    // 概览里这几条也按紧急度排，跟任务清单和摘要保持同一个顺序，免得三处说法不一致
    const items = listItems(ledger, { status: 'open', limit: 10 }, now, zone).items.map((item, i) => ({
      rank: i + 1,
      id: item.id,
      title: item.title,
      priority: item.priority,
      dueAt: item.dueAt,
      status: item.status,
    }));
    // 副手概览：最多 5 条，按更新时间倒序（刚动过的排前面）
    let assignments = { active: 0, items: [] };
    if (assignmentRuntime) {
      try {
        const active = await assignmentRuntime.activeCount();
        const listed = await assignmentRuntime.list({ status: 'active', limit: 5 });
        assignments = {
          active,
          items: listed.items.map((item) => ({
            id: item.id,
            sessionId: item.sessionId,
            purpose: item.purpose,
            status: item.status,
            itemId: item.itemId,
            updatedAt: item.updatedAt,
            report: item.report ? { summary: item.report.summary, expectsReply: item.report.expectsReply } : null,
          })),
        };
      } catch (err) {
        log(`overview: 读副手失败 ${err?.message ?? err}`);
      }
    }
    return {
      status: status(),
      counts: data.counts,
      items,
      assignments,
      settings: {
        dailyBriefTimes: config.dailyBriefTimes,
        tickIntervalSeconds: config.tickIntervalSeconds,
        quietHoursStart: config.quietHoursStart,
        quietHoursEnd: config.quietHoursEnd,
        weeklyReviewWeekday: config.weeklyReviewWeekday,
        weeklyReviewTime: config.weeklyReviewTime,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        agentReasoningEffort: config.agentReasoningEffort,
        maxAssignments: config.maxAssignments,
        assignmentCwd: config.assignmentCwd,
        assignmentModel: config.assignmentModel,
        assignmentPreset: config.assignmentPreset,
        analysisEnabled: config.analysisEnabled !== false,
        analysisDailyTime: config.analysisDailyTime,
        analysisIdleMinutes: config.analysisIdleMinutes,
        analysisProvider: config.analysisProvider,
        analysisModel: config.analysisModel,
        timeZone: config.timeZone,
        stateDir: dir,
      },
    };
  }

  // 改时间和检查间隔。写进 state 才能在重启后保住，否则下次启动又被 patch 里的默认值盖回去
  async function saveSettings(patch = {}) {
    const next = {};

    if (patch.dailyBriefTimes !== undefined) {
      if (!Array.isArray(patch.dailyBriefTimes)) throw new Error('dailyBriefTimes 需要是数组');
      const times = normalizeBriefTimes(patch.dailyBriefTimes);
      if (times.length === 0) throw new Error('至少要有一个有效时间，格式像 09:00');
      next.dailyBriefTimes = times;
    }

    if (patch.tickIntervalSeconds !== undefined) {
      const value = Number(patch.tickIntervalSeconds);
      if (!Number.isFinite(value) || value < 10) throw new Error('检查间隔至少 10 秒');
      next.tickIntervalSeconds = Math.floor(value);
    }

    // 安静时段：两端都传空串等于关掉。只传一端报错，免得用户以为改了其实没改
    if (patch.quietHoursStart !== undefined || patch.quietHoursEnd !== undefined) {
      const start = typeof patch.quietHoursStart === 'string' ? patch.quietHoursStart.trim() : config.quietHoursStart;
      const end = typeof patch.quietHoursEnd === 'string' ? patch.quietHoursEnd.trim() : config.quietHoursEnd;
      const off = !start && !end;
      if (!off) {
        if (!start || !end) throw new Error('安静时段的开始和结束要一起填，都留空表示关掉');
        for (const [label, value] of [['开始', start], ['结束', end]]) {
          if (!/^\d{1,2}:\d{2}$/.test(value)) throw new Error(`安静时段${label}时间格式像 22:00`);
        }
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        if (sh > 23 || eh > 23 || sm > 59 || em > 59) throw new Error('安静时段不是有效时间');
      }
      next.quietHoursStart = off ? '' : start;
      next.quietHoursEnd = off ? '' : end;
    }

    // 周复盘：weekday 传 0 表示关掉，传 1-7 表示周一至周日
    if (patch.weeklyReviewWeekday !== undefined || patch.weeklyReviewTime !== undefined) {
      const rawWeekday = patch.weeklyReviewWeekday;
      const weekday = rawWeekday === undefined ? Number(config.weeklyReviewWeekday) : Number(rawWeekday);
      const time =
        typeof patch.weeklyReviewTime === 'string' ? patch.weeklyReviewTime.trim() : config.weeklyReviewTime;
      if (weekday === 0) {
        next.weeklyReviewWeekday = 0;
      } else {
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error('周复盘的日子要填 1-7（1 是周一），0 表示关掉');
        if (!/^\d{1,2}:\d{2}$/.test(time ?? '')) throw new Error('周复盘时间格式像 18:00');
        const [h, m] = time.split(':').map(Number);
        if (h > 23 || m > 59) throw new Error('周复盘不是有效时间');
        next.weeklyReviewWeekday = weekday;
        next.weeklyReviewTime = time;
      }
    }

    // 副手：并发上限、工作目录、模型、预设
    if (patch.maxAssignments !== undefined) {
      const value = Number(patch.maxAssignments);
      if (!Number.isFinite(value) || value < 1 || value > 32) throw new Error('副手并发上限要填 1-32');
      next.maxAssignments = Math.floor(value);
    }
    if (patch.assignmentCwd !== undefined) next.assignmentCwd = typeof patch.assignmentCwd === 'string' ? patch.assignmentCwd.trim() : '';
    if (patch.assignmentModel !== undefined) next.assignmentModel = typeof patch.assignmentModel === 'string' ? patch.assignmentModel.trim() : '';
    if (patch.assignmentPreset !== undefined) {
      const preset = typeof patch.assignmentPreset === 'string' ? patch.assignmentPreset.trim() : '';
      next.assignmentPreset = preset || DEFAULTS.assignmentPreset;
    }

    // 知识库分析：开关、每天几点、闲多久算闲、用哪个模型
    if (patch.analysisEnabled !== undefined) next.analysisEnabled = Boolean(patch.analysisEnabled);
    if (patch.analysisDailyTime !== undefined) {
      const time = typeof patch.analysisDailyTime === 'string' ? patch.analysisDailyTime.trim() : '';
      if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('分析时间格式像 03:00');
      const [h, m] = time.split(':').map(Number);
      if (h > 23 || m > 59) throw new Error('分析时间不是有效时间');
      next.analysisDailyTime = time;
    }
    if (patch.analysisIdleMinutes !== undefined) {
      const value = Number(patch.analysisIdleMinutes);
      if (!Number.isFinite(value) || value < 0 || value > 1440) throw new Error('闲时分析的等待时间要填 0-1440 分钟（0 表示关掉）');
      next.analysisIdleMinutes = Math.floor(value);
    }
    if (patch.analysisProvider !== undefined) next.analysisProvider = typeof patch.analysisProvider === 'string' ? patch.analysisProvider.trim() : '';
    if (patch.analysisModel !== undefined) next.analysisModel = typeof patch.analysisModel === 'string' ? patch.analysisModel.trim() : '';

    // 助手会话：预设、权限、模型、推理强度。
    // 这几项不是「下次生效」的配置，是建会话时用的参数，所以要顺手把会话重建掉。
    let sessionChanged = false;
    if (patch.agentPreset !== undefined) {
      const preset = typeof patch.agentPreset === 'string' ? patch.agentPreset.trim() : '';
      next.agentPreset = preset || DEFAULTS.agentPreset;
      sessionChanged = true;
    }
    if (patch.permissionPreset !== undefined) {
      const preset = typeof patch.permissionPreset === 'string' ? patch.permissionPreset.trim() : '';
      next.permissionPreset = preset || DEFAULTS.permissionPreset;
      sessionChanged = true;
    }
    if (patch.agentProvider !== undefined) {
      next.agentProvider = typeof patch.agentProvider === 'string' ? patch.agentProvider.trim() : '';
      sessionChanged = true;
    }
    if (patch.agentModel !== undefined) {
      next.agentModel = typeof patch.agentModel === 'string' ? patch.agentModel.trim() : '';
      sessionChanged = true;
    }
    if (patch.agentReasoningEffort !== undefined) {
      next.agentReasoningEffort =
        typeof patch.agentReasoningEffort === 'string' ? patch.agentReasoningEffort.trim() : '';
      sessionChanged = true;
    }
    // 只填了 provider 没填 model（或反过来）会说不过去：组合起来才是一条路由
    const mergedProvider = next.agentProvider ?? config.agentProvider;
    const mergedModel = next.agentModel ?? config.agentModel;
    if (Boolean(mergedProvider) !== Boolean(mergedModel)) {
      throw new Error('模型和供应商要一起选，只选一个没法用');
    }

    if (Object.keys(next).length === 0) throw new Error('没有要改的东西');

    Object.assign(config, next);
    state.settingsOverrides = { ...(state.settingsOverrides ?? {}), ...next };
    await saveState();
    startTicker();
    // 只打标记，不在这儿拆会话：保存设置时可能正有一轮在跑，
    // 拆了这轮的回复就没了。下一条微信消息进来时按新配置重开。
    if (sessionChanged && assistant?.restart) {
      try {
        assistant.restart();
      } catch (err) {
        log(`settings: 标记重建助手会话失败 ${err?.message ?? err}`);
      }
    }
    log(`settings: 已更新 ${JSON.stringify(next)}`);
    return { ok: true, settings: { ...next } };
  }

  // 手动推一次摘要，用来验证通道通不通，不用等到点
  async function sendDigest() {
    const ledger = store ? await store.read((data) => data) : { items: [], seq: {} };
    const body = renderDigest(digest(ledger, new Date(), zone), {
      timeZone: zone,
      maxChars: config.maxMessageChars,
    });
    const blocker = pushBlocker(state);
    if (blocker) return { ok: true, sent: false, reason: blocker, text: body };
    const sent = await push(body);
    return sent === false
      ? { ok: true, sent: false, reason: 'send-failed', text: body }
      : { ok: true, sent: true, text: body };
  }

  // 设置页的完整任务清单。默认只给未完成的，也能要全部已完成的历史。
  async function listTasks({ status = 'open', query = '', tag = '' } = {}) {
    const ledger = store ? await store.read((data) => data) : { items: [], seq: {} };
    const now = new Date();
    const wanted = typeof status === 'string' && status ? status : 'open';
    const result = listItems(ledger, { status: wanted, query, tag, limit: 200 }, now, zone);
    return {
      status: wanted,
      total: result.total,
      items: result.items.map((item, i) => ({
        rank: i + 1,
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        dueAt: item.dueAt,
        tags: item.tags,
        detail: item.detail,
        actionable: item.actionable,
        suggestedAction: item.suggestedAction,
        assignee: item.assignee?.name ?? '',
        recurrence: item.recurrence ? describeRecurrence(item.recurrence) : '',
        attachments: (item.attachments ?? []).map((a) => a.name),
      })),
    };
  }

  // 设置页的知识库：列目录、读全文、新建
  async function listKb({ query = '', limit } = {}) {
    if (!paths) return { total: 0, docs: [] };
    const options = { limit: Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 30, log };
    if (typeof query === 'string' && query.trim()) {
      const found = await search(paths, query.trim(), options);
      return { total: found.length, docs: found };
    }
    const result = await listDocs(paths, options);
    return { total: result.total ?? result.docs.length, docs: result.docs };
  }

  async function readKb({ id = '' } = {}) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) throw new Error('id 不能为空');
    const doc = await readDoc(paths, key, log);
    if (!doc) throw new Error(`知识库里没有 ${key}`);
    return { doc };
  }

  async function writeKb(patch = {}) {
    const title = typeof patch.title === 'string' ? patch.title.trim() : '';
    const content = typeof patch.content === 'string' ? patch.content.trim() : '';
    if (!title) throw new Error('title 不能为空');
    if (!content) throw new Error('content 不能为空');
    const doc = await writeDoc(paths, { title, content, tags: patch.tags }, new Date(), zone, log);
    log(`kb: 新建 ${doc.id}「${doc.title}」`);
    return { ok: true, doc: { id: doc.id, title: doc.title } };
  }

  // ── 设置页的人物图谱与知识库分析接口 ───────────────────
  async function listPeopleApi({ limit } = {}) {
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 50;
    const data = await queryPeople(paths, { limit: cap, log });
    return { total: data.total, people: data.people };
  }

  async function readPersonApi({ name = '' } = {}) {
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) throw new Error('name 不能为空');
    const data = await queryPerson(paths, key, { log });
    if (!data) throw new Error(`知识库里还没有「${key}」这个人`);
    return {
      person: {
        id: data.entity.id,
        name: data.entity.name,
        kind: data.entity.kind,
        aliases: data.entity.aliases,
        note: data.entity.note,
        confidence: data.entity.confidence,
        mentions: data.entity.mentions,
        relations: data.relations,
      },
    };
  }

  async function getAnalysisApi() {
    if (!analyzer) return { enabled: false, running: false, pending: 0, people: 0, relations: 0, lastRun: null };
    return analyzer.status();
  }

  // 手动触发一次分析：微信里等不了几十秒，所以这里只负责开跑，结果稍后自己去看
  // 面板「对话记录」：按天分组的往来，点开能看全文
  async function listConversationsApi({ limit } = {}) {
    return listConversations(paths, { limit: limit ?? 20, timeZone: config.timeZone, log });
  }

  async function readConversationApi({ day = '', chatId = '', limit } = {}) {
    return readConversation(paths, { day, chatId, limit: limit ?? 300 }, { timeZone: config.timeZone, log });
  }

  // 设置页的三组下拉：会话预设、模型（含推理强度）、权限档。
  // 全部现读宿主，不写死清单 —— 宿主装了新预设、配了新模型，这里自动就多一项。
  async function getOptions() {
    const options = {
      presets: [],
      providers: [],
      permissions: [],
      current: {
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
        agentReasoningEffort: config.agentReasoningEffort,
      },
    };

    try {
      const presets = await ctx.get?.('agentPresets')?.remoteExportList?.();
      options.presets = (presets?.presets ?? [])
        .filter((row) => row && typeof row.id === 'string')
        .map((row) => ({
          id: row.id,
          name: typeof row.name === 'string' && row.name ? row.name : row.id,
          description: typeof row.description === 'string' ? row.description : '',
          isDefault: Boolean(row.isDefault),
        }));
    } catch (err) {
      log(`options: 读会话预设失败 ${err?.message ?? err}`);
    }

    try {
      const llm = ctx.get?.('llm');
      const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : [];
      for (const provider of providers) {
        const id = typeof provider?.id === 'string' ? provider.id : '';
        if (!id) continue;
        const models = [];
        let listed = [];
        try {
          listed = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
        } catch (err) {
          log(`options: 读 ${id} 的模型清单失败 ${err?.message ?? err}`);
        }
        for (const model of listed) {
          let efforts = [];
          let defaultEffort = '';
          try {
            const info = await llm.resolveModelInfo?.(id, model.id);
            efforts = (info?.reasoning?.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name || effort.id }));
            defaultEffort = info?.reasoning?.defaultEffort ?? '';
          } catch {
            // 拿不到细节就当成「这个模型没有推理强度可选」，不影响它本身可选
          }
          models.push({ id: model.id, name: model.name || model.id, efforts, defaultEffort });
        }
        options.providers.push({
          id,
          name: typeof provider.name === 'string' && provider.name ? provider.name : id,
          models,
        });
      }
    } catch (err) {
      log(`options: 读模型清单失败 ${err?.message ?? err}`);
    }

    try {
      const catalog = ctx.get?.('permissionPresets')?.catalog?.();
      options.permissions = (catalog?.options ?? []).map((row) => ({
        value: row.value,
        name: row.name || row.value,
        description: typeof row.description === 'string' ? row.description : '',
      }));
      if (catalog?.defaultPreset) options.current.permissionDefault = catalog.defaultPreset;
    } catch (err) {
      log(`options: 读权限档失败 ${err?.message ?? err}`);
    }

    return options;
  }

  async function runAnalysisApi() {
    if (!analyzer) throw new Error('分析器还没就绪');
    // 一次分析要几十秒，HTTP 别干等着：开跑就回包，结果去 /analysis 看。
    const state = await analyzer.status();
    if (state.running) {
      const busy = new Error('正在整理，等这次跑完再说');
      busy.status = 409;
      throw busy;
    }
    void analyzer.run('manual').catch((err) => log(`analysis: 手动分析出错 ${err?.message ?? err}`));
    return { ok: true, started: true };
  }

  // ── 设置页的副手接口 ───────────────────────────────────
  async function listAssignmentsApi({ status = 'active' } = {}) {
    if (!assignmentRuntime) return { status, total: 0, items: [] };
    const wanted = typeof status === 'string' && status ? status : 'active';
    const result = await assignmentRuntime.list({ status: wanted, limit: 100 });
    return {
      status: wanted,
      total: result.total,
      items: result.items.map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        purpose: item.purpose,
        status: item.status,
        itemId: item.itemId,
        updatedAt: item.updatedAt,
        lastRunAt: item.lastRunAt,
        report: item.report ? { summary: item.report.summary, expectsReply: item.report.expectsReply } : null,
      })),
    };
  }

  // 侧栏「对话」页签用：列出能点开的助手会话。主会话一条，每个副手一条。
  // 点开之后由宿主自己把会话开在主区，思考过程和继续对话都在那边，侧栏只管挑。
  async function listSessionsApi() {
    const live = (() => {
      try {
        return ctx.get?.('sessions')?.list?.() ?? [];
      } catch (err) {
        log(`sessions: 拿不到宿主的会话列表 ${err?.message ?? err}`);
        return [];
      }
    })();
    const titles = (() => {
      try {
        return ctx.get?.('sessionTitle') ?? null;
      } catch {
        return null;
      }
    })();

    const byId = new Map(live.map((session) => [session.id, session]));
    // 会话名是宿主自己起的（第一次提问后自动生成）。读不到就用能认出来的兜底名，
    // 宁可显示「微信工作助理」，也别在侧栏里露出一串 wa:main。
    const titleOf = (id, fallback) => {
      const session = byId.get(id);
      if (!session || !titles || typeof titles.get !== 'function') return fallback;
      try {
        const snapshot = titles.get(session);
        const title = snapshot && typeof snapshot.title === 'string' ? snapshot.title.trim() : '';
        return title || fallback;
      } catch {
        return fallback;
      }
    };
    const createdOf = (id) => {
      const session = byId.get(id);
      const at = session && session.header ? session.header.createdAt : NaN;
      return Number.isFinite(at) ? new Date(at).toISOString() : '';
    };

    const items = [
      {
        id: SESSION_ID,
        title: titleOf(SESSION_ID, '微信工作助理'),
        // 会话活着就算可用；没活说明宿主重启过、还没收到新消息，点开时再恢复
        status: byId.has(SESSION_ID) ? 'idle' : 'offline',
        lastAt: createdOf(SESSION_ID),
        kind: 'main',
      },
    ];

    if (assignmentRuntime) {
      try {
        const result = await assignmentRuntime.list({ status: 'all', limit: 100 });
        for (const item of result.items) {
          items.push({
            id: item.sessionId,
            title: titleOf(item.sessionId, item.purpose || item.id),
            status: item.status,
            lastAt: item.updatedAt || item.lastRunAt || '',
            kind: 'assignment',
          });
        }
      } catch (err) {
        log(`sessions: 副手列表读失败 ${err?.message ?? err}`);
      }
    }

    // 主会话钉在最上面：它是微信这条主线，不该被副手挤下去
    items.sort((a, b) => {
      if (a.kind === 'main') return -1;
      if (b.kind === 'main') return 1;
      return String(b.lastAt).localeCompare(String(a.lastAt));
    });
    return { total: items.length, items };
  }

  async function readAssignmentApi({ id = '' } = {}) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) throw new Error('id 不能为空');
    if (!assignmentRuntime) throw new Error('副手功能还没就绪');
    const { assignment, tail } = await assignmentRuntime.inspect(key);
    return {
      assignment: {
        id: assignment.id,
        sessionId: assignment.sessionId,
        purpose: assignment.purpose,
        status: assignment.status,
        itemId: assignment.itemId,
        updatedAt: assignment.updatedAt,
        lastRunAt: assignment.lastRunAt,
        report: assignment.report,
        stopReason: assignment.stopReason,
      },
      tail,
    };
  }

  // 页面能做的三件事：新建、发消息、停掉。别的（改状态、改会话）一律不放行。
  async function actAssignmentApi(patch = {}) {
    if (!assignmentRuntime) throw new Error('副手功能还没就绪');
    const action = typeof patch.action === 'string' ? patch.action : '';
    const id = typeof patch.id === 'string' ? patch.id.trim() : '';

    if (action === 'create') {
      const purpose = typeof patch.purpose === 'string' ? patch.purpose.trim() : '';
      if (!purpose) throw new Error('purpose 不能为空');
      const created = await assignmentRuntime.create({ purpose, itemId: patch.itemId });
      return { ok: true, assignment: { id: created.assignment.id, sessionId: created.assignment.sessionId } };
    }

    // 先验 action 再验 id：否则写错 action 会被误报成「id 不能为空」，排查时白跑一圈
    if (!['send', 'stop'].includes(action)) throw new Error('action 只能是 create / send / stop');
    if (!id) {
      const err = new Error('id 不能为空');
      err.status = 400;
      throw err;
    }

    if (action === 'send') {
      const message = typeof patch.message === 'string' ? patch.message.trim() : '';
      if (!message) throw new Error('message 不能为空');
      const mode = ['context-update', 'next-step', 'next-turn'].includes(patch.mode) ? patch.mode : 'next-turn';
      await assignmentRuntime.send(id, message, mode);
      return { ok: true, id, mode };
    }

    if (action === 'stop') {
      const { assignment: stopped, released, sessionActive } = await assignmentRuntime.stop(
        id,
        typeof patch.reason === 'string' ? patch.reason : '',
      );
      // released=false 表示没拿到真正的 dispose：sessionActive 才是「会话还在跑」
      return { ok: true, id, status: stopped.status, released, sessionActive };
    }
  }

  // 整页视图的统计。算账本的事交给 lib/stats.js，这里只负责把账本读出来。
  async function getStats() {
    const ledger = store ? await store.read((data) => data) : { items: [], seq: {} };
    return buildStats(ledger, new Date(), zone);
  }

  // 页面改任务。只放行下面这些字段——页面能改的东西越少，出错的面越小。
  // 白名单之外的一律静默忽略，不报错也不透传（id、source、createdAt 这些不该由页面碰）。
  async function updateTask(patch = {}) {
    const id = typeof patch.id === 'string' ? patch.id.trim() : '';
    if (!id) throw new Error('id 不能为空');

    const next = {};
    if (patch.status !== undefined) {
      const status = typeof patch.status === 'string' ? patch.status : '';
      if (!STATUSES.includes(status)) throw new Error(`status 只能是 ${STATUSES.join(' / ')}`);
      next.status = status;
    }
    if (patch.priority !== undefined) {
      const priority = typeof patch.priority === 'string' ? patch.priority : '';
      if (!PRIORITIES.includes(priority)) throw new Error(`priority 只能是 ${PRIORITIES.join(' / ')}`);
      next.priority = priority;
    }
    if (patch.title !== undefined) {
      const title = typeof patch.title === 'string' ? patch.title.trim() : '';
      if (!title) throw new Error('title 不能为空');
      next.title = title;
    }
    if (patch.detail !== undefined) next.detail = typeof patch.detail === 'string' ? patch.detail : '';
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags)) throw new Error('tags 需要是数组');
      next.tags = patch.tags;
    }
    // 空串表示「把期限清掉」，updateItem 里 parseInstant 会把它变成 null
    if (patch.dueAt !== undefined) next.dueAt = typeof patch.dueAt === 'string' ? patch.dueAt : '';
    if (patch.snoozeMinutes !== undefined) {
      const minutes = Number(patch.snoozeMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('snoozeMinutes 必须是正数');
      next.snoozeMinutes = minutes;
    }
    if (Object.keys(next).length === 0) throw new Error('没有要改的字段');

    const item = await store.mutate((ledger) => updateItem(ledger, id, next, new Date(), zone).item);
    log(`item: ${item.id} 改为 ${Object.keys(next).join('/')}`);
    return {
      ok: true,
      item: { id: item.id, status: item.status, title: item.title, priority: item.priority, dueAt: item.dueAt },
    };
  }

  function startTicker() {
    // 待命的实例不跑定时器：提醒是「一人份」的事，两个宿主都跑就会推两遍，
    // 而且另一边的账本可能还停在过去，内容还会不一样。
    if (lease && !lease.isPrimary()) {
      log('ticker: 本实例在待命，不跑定时提醒');
      return;
    }
    if (ticker) ticker.stop();
    ticker = createTicker({
      store,
      timeZone: config.timeZone,
      briefTimes: config.dailyBriefTimes,
      quietHours: quietHoursOf(config),
      weeklyReview: weeklyReviewOf(config),
      maxChars: config.maxMessageChars,
      getState: () => state,
      saveState: () => saveState().catch((err) => log(`ticker: 存简报进度失败 ${err?.message ?? err}`)),
      // 第二道保险：心跳万一刚好过期又被别人接手，这里也能拦住重复推送
      push: (text) => (lease && !lease.isPrimary() ? Promise.resolve(false) : push(text)),
      log,
      intervalMs: config.tickIntervalSeconds * 1000,
    });
    ticker.start();
    // 副手的报告不走 ticker，单独挂一个小间隔来补推安静时段攒下的
    if (reportFlusher) clearInterval(reportFlusher);
    reportFlusher = setInterval(() => {
      void flushQuietReports().catch((err) => log(`assignment: 补推报告失败 ${err?.message ?? err}`));
    }, 60 * 1000);
    if (typeof reportFlusher.unref === 'function') reportFlusher.unref();
  }

  // ── 启动 ───────────────────────────────────────────────
  // 老版本的数据分散在几个 JSON 文件里。第一次跑在数据库上时把它们搬进来，
  // 搬完把老文件改名留档 —— 不删，是因为迁移本身也可能有 bug，留着还能捞回去。
  async function migrateLegacyFiles() {
    const stamp = Date.now();
    const archive = (file) => {
      try {
        renameSync(file, `${file}.migrated-${stamp}`);
      } catch (err) {
        log(`migrate: ${file} 改名留档失败 ${err?.message ?? err}`);
      }
    };
    const onCorrupt = (label) => (err, backup) => log(`migrate: 老${label}文件解析失败（${err?.message ?? err}），已另存 ${backup || '（改名失败）'}`);

    try {
      const data = await readJson(paths.ledger, null, { onCorrupt: onCorrupt('账本') });
      if (data) {
        const result = await seedLedger(paths, data, { log });
        if (result.seeded) {
          archive(paths.ledger);
          log(`migrate: 老账本 ${result.items} 条搬进数据库`);
        }
      }
    } catch (err) {
      log(`migrate: 账本迁移失败 ${err?.message ?? err}`);
    }

    try {
      const data = await readJson(paths.assignments, null, { onCorrupt: onCorrupt('副手') });
      if (data) {
        const result = await seedAssignments(paths, data, { log });
        if (result.seeded) {
          archive(paths.assignments);
          log(`migrate: 老副手登记 ${result.items} 条搬进数据库`);
        }
      }
    } catch (err) {
      log(`migrate: 副手迁移失败 ${err?.message ?? err}`);
    }

    try {
      const index = await readJson(paths.kbIndex, null, { onCorrupt: onCorrupt('知识库索引') });
      if (index) {
        const readBodies = (file) => {
          // 老文件带 front matter（--- 包 id/title/tags），搬进库只留正文，
          // 否则搜索和给模型看的内容里全是元数据。
          // 读不到就抛：让整次迁移失败、索引留着下次再来，不要空正文冒充成功。
          const raw = readText(join(paths.kbDir, String(file ?? '')));
          return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        };
        const result = await seedKb(paths, index, readBodies, { log });
        if (result.seeded) {
          archive(paths.kbIndex);
          log(`migrate: 老知识库 ${result.docs} 篇搬进数据库`);
        }
      }
    } catch (err) {
      log(`migrate: 知识库迁移失败 ${err?.message ?? err}`);
    }
  }

  // 回填老对话。sessionQuery 是宿主服务，插件启动时它可能还没挂上，
  // 所以拿不到就用 ctx.inject 等它出现再来一次（等服务比赌加载顺序可靠）。
  function runBackfill(sessionQuery) {
    void (async () => {
      try {
        const result = await backfillMessages(paths, {
          log,
          sessionQuery,
          sessionId: SESSION_ID,
          chatId: state.ownerUserId || '',
        });
        if (result.reason !== 'ok' && result.reason !== 'already') {
          log(`backfill: 跳过（${result.reason}）`);
        }
      } catch (err) {
        log(`backfill: 失败 ${err?.message ?? err}`);
      }
    })();
  }

  function backfillHistory() {
    const ready = ctx.get?.('sessionQuery') ?? null;
    if (ready) {
      runBackfill(ready);
      return;
    }
    if (typeof ctx.inject !== 'function') {
      // 连注入都没有，只能自己去翻盘上的会话日志（backfill 内部会兜底）
      runBackfill(null);
      return;
    }
    ctx.inject(['sessionQuery'], (scoped) => {
      runBackfill(scoped.sessionQuery ?? null);
    });
  }

  async function boot() {
    await loadState();
    // 设置页改过的值存在 state 里，启动时盖回 config，否则重启就被 patch 里的默认值盖掉
    if (state.settingsOverrides && typeof state.settingsOverrides === 'object') {
      Object.assign(config, state.settingsOverrides);
      config.dailyBriefTimes = normalizeBriefTimes(config.dailyBriefTimes);
      if (!config.dailyBriefTimes.length) config.dailyBriefTimes = DEFAULTS.dailyBriefTimes;
    }
    await migrateLegacyFiles();
    // 对话记录是后加的功能，之前的聊天只留在宿主会话日志里，这里补一次，补完在 meta 里留标记。
    // 不 await：读日志要解一个快到 2MB 的 zstd，不能拖慢启动；补完面板自然就有了。
    backfillHistory();
    store = createStore(paths, { log });
    client = new IlinkClient({ log });
    // 微信的「正在输入」是一次性的，要持续显示就得定时补发，统一交给这个刷新器
    typing = createTypingIndicator({ client, log });
    if (state.botToken) {
      client.setLogin({ botToken: state.botToken, baseUrl: state.baseUrl || undefined });
    }

    channel = new InboundChannel({
      ownerUserId: state.ownerUserId,
      mergeWindowMs: config.mergeWindowMs,
      log,
      onBatch: async (batch) => {
        // 微信有时不返回 ilink_user_id，这时 ownerUserId 是空的。
        // 不补上的话：收消息不设防（谁来都收），发消息又全部丢弃（未登录判断），
        // 助理就成了只会吃不会说的哑巴。所以第一条消息的发送者直接认定为 owner。
        if (!state.ownerUserId && batch.chatId) {
          state.ownerUserId = batch.chatId;
          channel.ownerUserId = batch.chatId;
          await saveState();
          log('inbound: 微信没给用户 ID，已把第一条消息的发送者认作 owner');
        }
        state.contextToken = batch.contextToken;
        await saveState();
        // 先留一份原文当知识库分析的原料。这条失败不能拦住助理回话，
        // 所以单独 catch：大不了这一次分析少听一句。
        // 助手回复要记在同一个人名下，所以把这次的 chatId 留一手
        lastChatId = batch.chatId || lastChatId;
        if (batch.text) {
          void recordMessage(paths, { chatId: batch.chatId, role: 'user', text: batch.text, at: new Date().toISOString() }, { log })
            .catch((err) => log(`analysis: 消息没存下来 ${err?.message ?? err}`));
        }
        if (!assistant) {
          log('inbound: 助手未就绪，丢弃');
          return;
        }
        await assistant.deliver(batch);
      },
    });

    assistant = new Assistant({
      ctx,
      config,
      log,
      cwd: process.cwd(),
      sessionId: SESSION_ID,
      agentPreset: config.agentPreset,
      permissionPreset: config.permissionPreset,
      send: push,
      typing,
      // 助手推回微信的每一句都记进对话记录，面板才能按天回看
      record: async ({ role, text }) => {
        await recordMessage(
          paths,
          { chatId: lastChatId || state.ownerUserId || '', role, text, at: new Date().toISOString() },
          { log },
        );
      },
      // 微信发来的图片/文件先取下来落盘，再交给模型；取不下来就退回一句提示
      buildMedia: (mediaList) =>
        buildMediaContent(mediaList, {
          dir: paths.mediaDir,
          log,
        }),
      buildTools: () =>
        createTools({
          store,
          paths,
          notify: push,
          sendFile,
          timeZone: config.timeZone,
          sessionId: SESSION_ID,
          log,
          // 控制面才有派活工具；副手那份由 assignmentRuntime 单独注册
          assignments: assignmentRuntime,
          markItemAssignment: async (itemId, assignmentId) => {
            await store.mutate((ledger) =>
              updateItem(ledger, itemId, { assignmentId }, new Date(), zone),
            );
          },
        }),
    });

    // 副手：登记簿 + 生命周期。必须建在 Assistant 之后 —— 它的报告推送要用 push，
    // 而 push 依赖上面已经装好的 client 和 state。
    assignmentStore = createAssignmentStore(paths, { log, limit: config.maxAssignments });
    await assignmentStore.load();
    assignmentRuntime = createAssignmentRuntime({
      ctx,
      store: assignmentStore,
      config,
      log,
      push: pushAssignmentReport,
      // 副手自己那份工具只有交报告；控制面的 6 个在 createTools 里
      buildReportTools: (assignment) => reportTools({ runtime: assignmentRuntime, assignment }),
      // 报告里说「这条干完了」，就把关联工作项一起标完成
      markItemDone: async (itemId) => {
        await store.mutate((ledger) => updateItem(ledger, itemId, { status: 'done' }, new Date(), zone));
      },
    });
    // 宿主重启后原来的副手会话都没了，标成 offline，等真要用时再恢复
    await assignmentRuntime.reconcile();

    analyzer = createAnalyzer({
      ctx,
      paths,
      config,
      log,
      timeZone: config.timeZone,
      // 分析结果的通知不走副手那套「安静时段攒批」：攒批到早上一并推，
      // 会说成「副手交了报告」，听着莫名其妙。安静时段就只记日志，不打扰。
      notify: async (text) => {
        if (!text) return false;
        // 待命实例不推：同一个人的提醒只该有一份
        if (lease && !lease.isPrimary()) return false;
        if (inQuietHours(new Date(), zone, quietHoursOf(config))) {
          log('analysis: 安静时段，结果只写日志不推送');
          return false;
        }
        return push(text);
      },
    });

    // 先定「谁是主」，再决定要不要轮询、要不要跑定时器。
    // 桌面端和 dsh web 共用同一个数据目录时，只有一个能真的收发消息；
    // 另一个待命，等这边退出后自动接手（不用人工干预）。
    lease = createHostLease(paths, {
      log,
      role: 'host',
      onPromote: async () => {
        if (state.botToken) {
          startPolling();
        } else {
          state.status = 'idle';
          await saveState().catch(() => {});
        }
        startTicker();
      },
      onDemote: () => {
        stopPolling();
        if (ticker) {
          ticker.stop();
          ticker = null;
        }
        // 状态也要跟着退回去：主控被抢走以后，这张卡片不该还写着 running，
        // 否则用户看到「在跑」却收不到任何提醒。
        state.status = 'standby';
        void saveState().catch((err) => log(`lease: 记待命状态失败 ${err?.message ?? err}`));
      },
    });
    const leaseState = await lease.start();

    startTicker();

    const api = createHttpApi({
      getStatus: status,
      beginLogin,
      pollLogin: pollLoginNow,
      relogin,
      renderQr,
      getOverview,
      saveSettings,
      sendDigest,
      listTasks,
      updateTask,
      listKb,
      readKb,
      writeKb,
      getStats,
      listAssignments: listAssignmentsApi,
      readAssignment: readAssignmentApi,
      listSessions: listSessionsApi,
      actAssignment: actAssignmentApi,
      listPeople: listPeopleApi,
      readPerson: readPersonApi,
      getAnalysis: getAnalysisApi,
      runAnalysis: runAnalysisApi,
      listConversations: listConversationsApi,
      readConversation: readConversationApi,
      getOptions,
      log,
    });

    // 必须用 ctx.inject 等 webServer 就绪：直接读 ctx.webServer 会被 cordis 的反射代理判成
    // 「没有声明依赖就取服务」而抛 cannot get property "webServer" without inject，
    // 早期版本就是被这行炸掉整个 boot，路由没注册、登录页 404。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        const webServer = scoped.webServer;
        if (!webServer?.register) {
          log('http: 宿主没有 webServer，登录页不可用');
          return;
        }
        disposers.push(webServer.register({ kind: 'prefix', path: BASE_PATH, handler: api.handler }));
        log(`http: 已注册 ${BASE_PATH}`);
      });
    } else {
      log('http: 宿主没有 ctx.inject，跳过路由注册');
    }

    // 只要拿到 token 就开始轮询。早期版本这里要求 owner 也拿到，
    // 结果微信不返回 ilink_user_id 时重启后就再也不收消息，owner 永远补不上，插件彻底哑掉。
    if (!leaseState.primary) {
      const holder = leaseState.hosts.find((row) => row.id !== lease.id);
      log(`boot: 另一个宿主正在跑（pid ${holder?.pid ?? '?'}），本实例待命，等它退出后自动接手`);
      state.status = 'standby';
      await saveState();
    } else if (state.botToken) {
      log('boot: 已有登录凭据，直接开始轮询');
      startPolling();
    } else {
      log('boot: 尚未登录，等用户扫码');
    }
  }

  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      try {
        await boot();
      } catch (err) {
        log(`boot: 失败 ${err?.message ?? err}`);
      }
      if (disposed) return;
    })();

    return () => {
      disposed = true;
      stopPolling();
      if (loginWatcher) {
        clearInterval(loginWatcher);
        loginWatcher = null;
      }
      if (ticker) ticker.stop();
      // 交还主控权：另一个待命的宿主下次心跳就能立刻接手，不用等 90 秒过期
      if (lease) {
        void lease.stop();
        lease = null;
      }
      if (reportFlusher) {
        clearInterval(reportFlusher);
        reportFlusher = null;
      }
      analyzer = null;
      quietReports = [];
      if (assignmentRuntime) void assignmentRuntime.dispose();
      assignmentRuntime = null;
      assignmentStore = null;
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 忽略 */
        }
      }
      disposers = [];
      if (assistant) void assistant.dispose();
      assistant = null;
    };
  }, 'work-assistant.boot');

  // 会话事件挂 root ctx，否则收不到助手会话的回复
  ctx.effect(() => {
    const on = ctx.on?.bind(ctx);
    if (!on) return () => {};
    const dispose = on(
      'session/event',
      (session, event) => {
        try {
          assistant?.onSessionEvent(session, event);
          assignmentRuntime?.onSessionEvent(session, event);
        } catch (err) {
          log(`session/event: ${err?.message ?? err}`);
        }
      },
      { global: true },
    );
    return () => {
      try {
        dispose?.();
      } catch {
        /* 忽略 */
      }
    };
  }, 'work-assistant.events');

  // 定时清扫：过期的待投递轮次 & 状态落盘；顺手让知识库分析看一眼该不该跑
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        assistant?.sweepStale();
      } catch {
        /* 忽略 */
      }
      try {
        // 待命实例不跑分析：两边都分析会白烧 token，还可能把同一批消息记两遍
        if (lease && !lease.isPrimary()) return;
        // 分析可能要跑几十秒，不能 await 卡住这个 60 秒的清扫节拍
        void analyzer?.tick().catch((err) => log(`analysis: 定时分析出错 ${err?.message ?? err}`));
      } catch (err) {
        log(`analysis: 定时检查失败 ${err?.message ?? err}`);
      }
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'work-assistant.sweep');
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export { assistantText, DEFAULTS };
