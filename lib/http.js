// 登录页与状态接口。只给回环 Host 用，跨站请求一律拒。
// 二维码渲染交给注入的 renderQr（内部用 qrcode 包），本文件不直接依赖它。

export const BASE_PATH = '/api/dsh-workassistant';

export function createHttpApi(options) {
  const {
    getStatus,
    beginLogin,
    pollLogin,
    relogin,
    log = () => {},
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
    listAssignments,
    readAssignment,
    actAssignment,
    listPeople,
    readPerson,
    getAnalysis,
    runAnalysis,
    listConversations,
    readConversation,
    listSessions,
    getOptions,
  } = options;

  function guard(req) {
    const remote = req.socket?.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) return { status: 403, body: { error: '只接受本机访问' } };

    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (site === 'cross-site') return { status: 403, body: { error: '拒绝跨站请求' } };
    return null;
  }

  function send(res, status, payload, type = 'application/json; charset=utf-8') {
    const body = type.startsWith('application/json') ? JSON.stringify(payload) : payload;
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function html(res, status, body) {
    send(res, status, body, 'text/html; charset=utf-8');
  }

  // 设置页提交的是 JSON；体积上限压得很低，这个接口只用来改几个数字和时间
  function readJsonBody(req, limitBytes = 16 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limitBytes) {
          reject(new Error('请求体太大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function handler(req, res) {
    const denied = guard(req);
    if (denied) {
      send(res, denied.status, denied.body);
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || '/' : url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/login')) {
        html(res, 200, loginPage());
        return;
      }

      if (req.method === 'GET' && path === '/login/status') {
        const status = getStatus();
        send(res, 200, status);
        return;
      }

      if (req.method === 'GET' && path === '/status') {
        send(res, 200, getStatus());
        return;
      }

      if (req.method === 'POST' && path === '/login/start') {
        const result = await beginLogin();
        send(res, 200, result);
        return;
      }

      if (req.method === 'GET' && path === '/login/scan') {
        const result = await pollLogin();
        if (result?.qrPayload && renderQr) {
          const dataUrl = await renderQr(result.qrPayload);
          send(res, 200, { ...result, qrDataUrl: dataUrl });
          return;
        }
        send(res, 200, result ?? { status: 'idle' });
        return;
      }

      if (req.method === 'POST' && path === '/relogin') {
        const origin = String(req.headers.origin ?? '');
        const host = String(req.headers.host ?? '');
        if (origin && host) {
          let originHost = '';
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = '';
          }
          if (originHost && originHost !== host) {
            send(res, 403, { error: '来源不匹配' });
            return;
          }
        }
        const result = await relogin();
        send(res, 200, result);
        return;
      }

      // 设置页用：一次拿全（登录状态 + 账本概览 + 生效中的设置）
      if (req.method === 'GET' && path === '/overview') {
        if (!getOverview) {
          send(res, 503, { error: '概览功能不可用' });
          return;
        }
        send(res, 200, await getOverview());
        return;
      }

      // 整页视图的统计：优先级分布、近 14 天趋势、标签分布、等谁、最久没动
      if (req.method === 'GET' && path === '/stats') {
        if (!getStats) {
          send(res, 503, { error: '统计不可用' });
          return;
        }
        send(res, 200, await getStats());
        return;
      }

      // 设置页要能看全部活儿、并且就地标完成，所以单开两个接口。
      // 把完整的任务清单交给页面，而不是让它从概览里那十条凑。
      if (req.method === 'GET' && path === '/items') {
        if (!listTasks) {
          send(res, 503, { error: '任务列表不可用' });
          return;
        }
        const status = url.searchParams.get('status') ?? 'open';
        const query = url.searchParams.get('query') ?? '';
        const tag = url.searchParams.get('tag') ?? '';
        send(res, 200, await listTasks({ status, query, tag }));
        return;
      }

      if (req.method === 'POST' && path === '/item') {
        if (!updateTask) {
          send(res, 503, { error: '改任务不可用' });
          return;
        }
        const body = await readJsonBody(req);
        send(res, 200, await updateTask(body));
        return;
      }

      if (req.method === 'POST' && path === '/settings') {
        if (!saveSettings) {
          send(res, 503, { error: '改设置的接口不可用' });
          return;
        }
        const body = await readJsonBody(req);
        send(res, 200, await saveSettings(body));
        return;
      }

      if (req.method === 'POST' && path === '/digest') {
        if (!sendDigest) {
          send(res, 503, { error: '发摘要的接口不可用' });
          return;
        }
        send(res, 200, await sendDigest());
        return;
      }

      // 知识库：设置页要能翻、能搜、能读全文
      if (req.method === 'GET' && path === '/kb') {
        if (!listKb) {
          send(res, 503, { error: '知识库不可用' });
          return;
        }
        const query = url.searchParams.get('query') ?? '';
        const limit = Number(url.searchParams.get('limit')) || undefined;
        send(res, 200, await listKb({ query, limit }));
        return;
      }

      if (req.method === 'GET' && path === '/kb/doc') {
        if (!readKb) {
          send(res, 503, { error: '知识库不可用' });
          return;
        }
        const id = url.searchParams.get('id') ?? '';
        send(res, 200, await readKb({ id }));
        return;
      }

      if (req.method === 'POST' && path === '/kb/doc') {
        if (!writeKb) {
          send(res, 503, { error: '知识库不可用' });
          return;
        }
        // 知识库正文可以很长，单独放宽上限；设置接口那 16KB 不够用
        const body = await readJsonBody(req, 256 * 1024);
        send(res, 200, await writeKb(body));
        return;
      }

      // 人物与关系：知识库分析抽出来的东西，页面上要看得到
      if (req.method === 'GET' && path === '/people') {
        if (!listPeople) {
          send(res, 503, { error: '人物图谱不可用' });
          return;
        }
        const limit = Number(url.searchParams.get('limit')) || undefined;
        send(res, 200, await listPeople({ limit }));
        return;
      }

      if (req.method === 'GET' && path === '/person') {
        if (!readPerson) {
          send(res, 503, { error: '人物图谱不可用' });
          return;
        }
        const name = url.searchParams.get('name') ?? '';
        if (!name.trim()) {
          send(res, 400, { error: 'name 不能为空' });
          return;
        }
        send(res, 200, await readPerson({ name }));
        return;
      }

      // 知识库分析：看状态、手动跑一次
      if (req.method === 'GET' && path === '/analysis') {
        if (!getAnalysis) {
          send(res, 503, { error: '知识库分析不可用' });
          return;
        }
        send(res, 200, await getAnalysis());
        return;
      }

      if (req.method === 'POST' && path === '/analysis') {
        if (!runAnalysis) {
          send(res, 503, { error: '知识库分析不可用' });
          return;
        }
        send(res, 200, await runAnalysis());
        return;
      }

      // 对话记录：按天回看跟微信之间的往来（入站 + 助手回复）
      if (req.method === 'GET' && path === '/conversations') {
        if (!listConversations) {
          send(res, 503, { error: '对话记录不可用' });
          return;
        }
        const limit = Number(url.searchParams.get('limit')) || undefined;
        send(res, 200, await listConversations({ limit }));
        return;
      }

      if (req.method === 'GET' && path === '/conversation') {
        if (!readConversation) {
          send(res, 503, { error: '对话记录不可用' });
          return;
        }
        const day = url.searchParams.get('day') ?? '';
        if (!day.trim()) {
          send(res, 400, { error: 'day 不能为空' });
          return;
        }
        const chatId = url.searchParams.get('chatId') ?? '';
        const limit = Number(url.searchParams.get('limit')) || undefined;
        send(res, 200, await readConversation({ day, chatId, limit }));
        return;
      }

      // 侧栏「对话」页签：能点开的助手会话（主会话 + 副手）。
      // 只给会话坐标和名字，点开是宿主自己的事，不在这里内嵌聊天。
      if (req.method === 'GET' && path === '/sessions') {
        if (!listSessions) {
          send(res, 503, { error: '会话列表不可用' });
          return;
        }
        send(res, 200, await listSessions());
        return;
      }

      // 设置页的下拉项：会话预设、模型（含推理强度）、权限档
      if (req.method === 'GET' && path === '/options') {
        if (!getOptions) {
          send(res, 503, { error: '选项不可用' });
          return;
        }
        send(res, 200, await getOptions());
        return;
      }

      // 副手：列、看详情、发消息/停掉/新建
      if (req.method === 'GET' && path === '/assignments') {
        if (!listAssignments) {
          send(res, 503, { error: '副手功能不可用' });
          return;
        }
        const status = url.searchParams.get('status') ?? 'active';
        send(res, 200, await listAssignments({ status }));
        return;
      }

      if (req.method === 'GET' && path === '/assignment') {
        if (!readAssignment) {
          send(res, 503, { error: '副手功能不可用' });
          return;
        }
        const id = url.searchParams.get('id') ?? '';
        send(res, 200, await readAssignment({ id }));
        return;
      }

      if (req.method === 'POST' && path === '/assignment') {
        if (!actAssignment) {
          send(res, 503, { error: '副手功能不可用' });
          return;
        }
        const body = await readJsonBody(req);
        send(res, 200, await actAssignment(body));
        return;
      }

      send(res, 404, { error: '没有这个接口' });
    } catch (err) {
      log(`http: ${path} 失败 ${err?.message ?? err}`);
      // 参数错给 400、正在忙给 409：别一律 500，前端和排查的人都靠状态码分辨
      send(res, Number(err?.status) || 500, { error: String(err?.message ?? err) });
    }
  }

  return { handler, BASE_PATH };
}

function loginPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>工作助理 - 微信登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #12100e; color: #f2ede4; }
  .card { width: min(92vw, 420px); padding: 28px; border-radius: 18px; background: #1e1a17;
          box-shadow: 0 18px 48px rgba(0,0,0,.45); text-align: center; }
  h1 { font-size: 19px; margin: 0 0 6px; font-weight: 600; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #a89e91; line-height: 1.6; }
  .qr { width: 240px; height: 240px; margin: 0 auto; display: flex; align-items: center; justify-content: center;
        background: #fff; border-radius: 12px; overflow: hidden; }
  .qr img { width: 240px; height: 240px; display: block; }
  .qr .placeholder { color: #6b6257; font-size: 13px; }
  .status { margin-top: 16px; font-size: 14px; min-height: 22px; color: #c9c0b3; }
  .status.ok { color: #6fd08c; }
  .status.err { color: #ef8080; }
  button { margin-top: 18px; padding: 9px 18px; font-size: 13px; border-radius: 9px; cursor: pointer;
           border: 1px solid #3a322b; background: #2a241f; color: #f2ede4; }
  button:hover { background: #342c26; }
  .hint { margin-top: 14px; font-size: 12px; color: #7d7368; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <h1>微信登录</h1>
  <p class="sub">用手机微信扫这个二维码，把机器人加成好友。登录后你转发的消息就会进工作账本。</p>
  <div class="qr" id="qr"><div class="placeholder">正在获取二维码…</div></div>
  <div class="status" id="status">准备中</div>
  <button id="reload" type="button">重新获取二维码</button>
  <div class="hint">只在你的电脑上打开这个页面。登录凭据只存在本机。</div>
</div>
<script>
(function () {
  var qrEl = document.getElementById('qr');
  var statusEl = document.getElementById('status');
  var reloadEl = document.getElementById('reload');
  var timer = null;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function showQr(dataUrl) {
    if (!dataUrl) return;
    if (qrEl.dataset.url === dataUrl) return;
    qrEl.dataset.url = dataUrl;
    qrEl.innerHTML = '';
    var img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '微信登录二维码';
    qrEl.appendChild(img);
  }

  function poll() {
    fetch('${BASE_PATH}/login/scan', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.qrDataUrl) showQr(data.qrDataUrl);
        if (data.status === 'confirmed') {
          setStatus('已登录，可以关掉这个页面了', 'ok');
          stop();
          return;
        }
        if (data.status === 'scanned') { setStatus('已扫码，请在手机上确认'); return; }
        if (data.status === 'expired') { setStatus('二维码过期，点下面重新获取', 'err'); stop(); return; }
        if (data.status === 'waiting') { setStatus('等待扫码…'); return; }
        if (data.status === 'loggedIn') { setStatus('已登录，可以关掉这个页面了', 'ok'); stop(); return; }
        setStatus('等待扫码…');
      })
      .catch(function (err) { setStatus('连接失败：' + err.message, 'err'); });
  }

  function start() {
    stop();
    timer = setInterval(poll, 2000);
    poll();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  reloadEl.addEventListener('click', function () {
    qrEl.dataset.url = '';
    qrEl.innerHTML = '<div class="placeholder">正在重新获取…</div>';
    setStatus('正在刷新二维码');
    fetch('${BASE_PATH}/relogin', { method: 'POST', credentials: 'same-origin' })
      .then(function () { start(); })
      .catch(function (err) { setStatus('刷新失败：' + err.message, 'err'); });
  });

  start();
})();
</script>
</body>
</html>`;
}
