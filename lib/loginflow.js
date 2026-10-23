// 登录页每次轮询该做什么。
// 抽成纯函数是因为这里最容易写错：早期版本每轮都申请一张新二维码，
// 页面每 2 秒轮询一次，用户刚看到码就被作废，永远扫不上。

// 返回：
//   loggedIn —— 已经有凭据，直接告诉页面完事了
//   fresh    —— 需要（重新）申请一张二维码
//   restore  —— 码还在，但内存里没有监听器（进程重启过），补上
//   read     —— 什么都别做，把当前状态读出去就行
export function decideLoginStep({ loggedIn, login, watching }) {
  if (loggedIn) return 'loggedIn';
  // qrPayload 缺说明是旧状态文件，没有可展示的码，只能重申请
  if (!login?.qrcodeId || !login?.qrPayload) return 'fresh';
  if (login.status === 'expired') return 'fresh';
  if (login.status === 'confirmed') return 'read';
  if (!watching) return 'restore';
  return 'read';
}
