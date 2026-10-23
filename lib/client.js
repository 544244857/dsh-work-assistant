// 浏览器半边：把工作助理的设置页挂进 DSH 的设置面板。
//
// 这个文件不是 ESM。宿主把它当普通脚本加载，靠 window.__ModuleLoader__.load 注册工厂；
// 写成 import/export 会在浏览器里直接语法报错，整页变成空白。
// React 由模块系统的基座表提供（factory 的 require 参数），不能也不需要在插件里安装。
window.__ModuleLoader__.load({
  id: 'dsh-work-assistant',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-work-assistant';
    const API = '/api/dsh-workassistant';

    const zh = {
      title: '工作助理',
      subtitle: '微信里的活儿，转给机器人就记下来了',
      loggedIn: '已登录',
      loggedOut: '未登录',
      scanning: '等待扫码',
      scanned: '已扫码，请在手机上确认',
      expired: '二维码已过期',
      confirmed: '已登录，可以关掉这个页面了',
      qrHint: '用手机微信扫这个码，把机器人加成好友。之后把被 @ 的消息转发给它就行。',
      qrUnavailable: '暂时拿不到二维码',
      relogin: '重新登录',
      reloginBusy: '正在换码…',
      loginFailed: '重新登录失败',
      openCount: '未完成',
      overdue: '已逾期',
      doing: '进行中',
      actionable: '可代做',
      items: '工作项',
      noItems: '手上没有未完成的活儿。',
      tasks: '任务清单',
      tasksHint: '按紧急度排好的，最上面的最该先做。点右边的按钮就能标完成。',
      filterOpen: '未完成',
      filterDone: '已完成',
      filterAll: '全部',
      markDone: '标完成',
      markOpen: '打回待办',
      tasksEmpty: '这一栏是空的。',
      tasksFailed: '读取任务清单失败',
      taskFailed: '改状态失败',
      rankLabel: '紧急度',
      convTitle: '对话记录',
      convHint: '跟微信那边的往来都在这儿，按天分组，点一天看全文。',
      convEmpty: '还没有对话记录。你在微信里发一句话，这里就会出现。',
      convFailed: '读对话记录失败',
      convBack: '返回列表',
      convCountUnit: '条',
      convRoleUser: '你',
      convRoleAssistant: '助理',
      railTab: '对话',
      railTitle: '最近的会话',
      railRefresh: '刷新',
      railEmpty: '还没有会话。你在微信里发一句，这里就有了。',
      railCantOpen: '打不开这个会话，去左边的会话列表里点吧',
      railJustNow: '刚刚',
      railMinuteUnit: '分钟',
      railHourUnit: '小时',
      railDayUnit: '天',
      railChat: '微信',
      railFailed: '对话页签出错了，其它页签不受影响',
      sessionTitle: '助手会话',
      sessionHint: '这里改的是助理在微信里跟你说话时用的那套设置：预设、模型、推理强度、权限。改完下一条消息就按新设置来。',
      sessionPreset: 'Agent 预设',
      sessionModel: '模型',
      sessionFollowHost: '跟随宿主默认',
      sessionEffort: '推理强度',
      sessionEffortDefault: '默认',
      sessionPermission: '权限',
      optionsFailed: '读取可选项目失败',
      kbTitle: '工作知识库',
      kbHint: '做事的方法、结论、模板都存在这里，微信里问一句就能翻出来。',
      kbSearch: '搜一下',
      kbSearchPlaceholder: '关键词，例如 值班、报销',
      kbEmpty: '知识库还是空的。让助手把结论存进来就有了。',
      kbFailed: '读知识库失败',
      peopleTitle: '认识的人',
      peopleHint: '这些是从聊天和笔记里认出来的。点名字看他和你的关系。',
      peopleEmpty: '还没认出人来。等我多听几条消息。',
      peopleFailed: '读人物失败',
      personBack: '返回名单',
      personNone: '关系还没理出来。',
      analysisTitle: '知识库分析',
      analysisHint: '每天定时把聊天、工作项、笔记整理一遍，认出人和关系。',
      analysisRun: '现在整理一次',
      analysisRunning: '正在整理…',
      analysisNever: '还没整理过',
      analysisPending: '条消息还没整理',
      analysisFound: '个认识的人',
      analysisFailed: '整理失败',
      kbBack: '返回列表',
      remindTitle: '提醒设置',
      briefTimes: '每日摘要时间',
      briefTimesHint: '用逗号分隔，例如 09:00, 18:30。到点自动把未完成的事推给你。',
      tickInterval: '提醒检查间隔（秒）',
      tickIntervalHint: '最小 10 秒。到期提醒会在每个间隔内检查一次。',
      quietTitle: '安静时段',
      quietStart: '开始',
      quietEnd: '结束',
      quietHint: '这段时间不推任何消息，到点也不响，等结束了一起补给你。两端都留空表示关掉。',
      weeklyTitle: '每周复盘',
      weeklyDay: '星期几',
      weeklyTime: '时间',
      weeklyOff: '关掉',
      weeklyHint: '到点会把这一周做完的和还欠着的发给你。',
      analysisTitle2: '知识库整理',
      analysisEnabledLabel: '自动整理',
      analysisEnabledHint: '打开后每天定时把聊天、工作项、笔记嚼一遍，认出人和关系。关掉就只能手动跑。',
      analysisTimeLabel: '每天几点整理',
      analysisTimeHint: '格式像 03:00。留空就用默认的凌晨三点。',
      analysisIdleLabel: '闲多久算闲（分钟）',
      analysisIdleHint: '最后一条消息过了这么多分钟、而且还有没整理的，就顺手跑一次。填 0 关掉闲时分析。',
      weekday1: '周一',
      weekday2: '周二',
      weekday3: '周三',
      weekday4: '周四',
      weekday5: '周五',
      weekday6: '周六',
      weekday7: '周日',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      sendDigest: '立刻发一条摘要',
      sending: '发送中…',
      digestSent: '已发到微信',
      digestFailed: '没发出去，详情看数据目录里的日志',
      digestNeedHello: '微信不允许机器人先开口。先在微信里给机器人发一句话，再点这里就能发出来了。',
      helloHint: '还没收到过你的消息，现在发不出提醒。在微信里随便给机器人发一句话，之后就正常了。',
      dataDir: '数据目录',
      preset: '助手预设',
      permission: '权限',
      presetHint: '预设和权限在 cordis.patch.yml 里改，改完要重启宿主。',
      loadFailed: '读取失败',
      saveFailed: '保存失败',
      emptyTime: '至少要有一个时间',
      bottomHint: '这个页面只在你的电脑上有效。',

      // 整页视图
      panelTitle: '工作助理',
      panelSubtitle: '手上有什么活儿、卡在哪、这周干了多少，一页看完',
      backToChat: '回到会话',
      refresh: '刷新',
      loading: '读取中…',
      statOpen: '未完成',
      statOverdue: '已逾期',
      statDoing: '进行中',
      statDoneWeek: '这周做完',
      statCreatedWeek: '这周新记',
      statStale: '拖了一周以上',
      chartPriority: '优先级分布',
      chartTrend: '近两周进出',
      chartTags: '标签分布',
      chartEmpty: '还没有数据',
      legendHigh: '高',
      legendNormal: '普通',
      legendLow: '低',
      trendCreated: '新记',
      trendDone: '做完',
      taskSection: '全部工作项',
      searchPlaceholder: '搜标题、细节、标签',
      filterDoing: '进行中',
      editTitle: '标题',
      editPriority: '优先级',
      editDue: '期限',
      editTags: '标签',
      editDueHint: '写 2026-10-24 18:00 这种，留空表示没有期限',
      editTagsHint: '用逗号分隔，例如 财务, 报销',
      saveItem: '保存',
      savingItem: '保存中…',
      itemSaved: '改好了',
      itemFailed: '没改成',
      expand: '展开',
      collapse: '收起',
      snoozeHour: '推后 1 小时',
      snoozeDay: '推后 1 天',
      priorityAuto: '自动',
      kbReadMore: '看全文',
      settingsSummary: '运行参数',
      settingsHint: '要改提醒时间、安静时段这些，去设置页里的「工作助理」。',
      noTasks: '没有符合条件的活儿。',
      chartAssignee: '在等谁',
      chartOldest: '压最久的',
      ageDays: '天',
      asgTitle: '副手',
      asgHint: '派出去的活儿由它们干，干完会回来汇报。',
      asgEmpty: '还没有副手。活儿大的时候让助手派一个出去。',
      asgCreate: '派一个',
      asgPurpose: '要它干什么',
      asgPurposeHint: '一句话说清要什么结果，例如 把这三个月的报销单整理成一张表',
      asgSend: '发消息',
      asgSendHint: '补一句要求，它会接着干',
      asgStop: '停止',
      asgStopDone: '已经停掉了',
      asgStopKept: '已经停掉了，但这个会话是之前就开着的，还留在会话列表里，你可以自己关掉',
      asgOpen: '去看',
      asgSending: '发送中…',
      asgCreating: '正在开…',
      asgStatusIdle: '空闲',
      asgStatusRunning: '干活中',
      asgStatusWaiting: '等你回话',
      asgStatusDone: '已交活',
      asgStatusStopped: '已停',
      asgStatusOffline: '掉线',
      asgReport: '最新报告',
      asgNoSession: '会话还没建好',
      asgFailed: '操作失败',
    };

    const en = {
      title: 'Work assistant',
      subtitle: 'Forward WeChat messages to the bot and they become tracked work items',
      loggedIn: 'Signed in',
      loggedOut: 'Not signed in',
      scanning: 'Waiting for scan',
      scanned: 'Scanned, confirm on your phone',
      expired: 'QR code expired',
      confirmed: 'Signed in, you can close this page',
      qrHint: 'Scan with WeChat to add the bot as a friend, then forward the messages you were mentioned in.',
      qrUnavailable: 'QR code unavailable right now',
      relogin: 'Sign in again',
      reloginBusy: 'Refreshing…',
      loginFailed: 'Sign-in failed',
      openCount: 'Open',
      overdue: 'Overdue',
      doing: 'In progress',
      actionable: 'Can do for you',
      items: 'Work items',
      noItems: 'Nothing open right now.',
      tasks: 'Task list',
      tasksHint: 'Sorted by urgency, most urgent first. Use the button on the right to close one.',
      filterOpen: 'Open',
      filterDone: 'Done',
      filterAll: 'All',
      markDone: 'Mark done',
      markOpen: 'Reopen',
      tasksEmpty: 'This list is empty.',
      tasksFailed: 'Failed to load the task list',
      taskFailed: 'Failed to change status',
      rankLabel: 'Urgency',
      convTitle: 'Conversations',
      convHint: 'Everything exchanged with WeChat, grouped by day. Click a day to read it.',
      convEmpty: 'No conversations yet. Say something in WeChat and it will show up here.',
      convFailed: 'Could not read conversations',
      convBack: 'Back to list',
      convCountUnit: 'msgs',
      convRoleUser: 'You',
      convRoleAssistant: 'Assistant',
      railTab: 'Chats',
      railTitle: 'Recent chats',
      railRefresh: 'Refresh',
      railEmpty: 'No chats yet. Send a message in WeChat and it shows up here.',
      railCantOpen: 'Cannot open this chat; use the session list on the left',
      railJustNow: 'just now',
      railMinuteUnit: 'min',
      railHourUnit: 'hr',
      railDayUnit: 'd',
      railChat: 'WeChat',
      railFailed: 'This tab failed to render; the other tabs still work',
      sessionTitle: 'Assistant session',
      sessionHint: 'These control the session the assistant uses when talking to you in WeChat: preset, model, reasoning effort, permissions. The next message uses the new settings.',
      sessionPreset: 'Agent preset',
      sessionModel: 'Model',
      sessionFollowHost: 'Follow host default',
      sessionEffort: 'Reasoning effort',
      sessionEffortDefault: 'Default',
      sessionPermission: 'Permissions',
      optionsFailed: 'Could not read the available options',
      kbTitle: 'Knowledge base',
      kbHint: 'Methods, conclusions and templates live here; ask in WeChat to pull them back out.',
      kbSearch: 'Search',
      kbSearchPlaceholder: 'keyword, e.g. rota, expenses',
      kbEmpty: 'The knowledge base is empty. Ask the assistant to save a conclusion and it shows up here.',
      kbFailed: 'Failed to read the knowledge base',
      peopleTitle: 'People',
      peopleHint: 'Recognized from chats and notes. Click a name to see the relationship.',
      peopleEmpty: 'No one recognized yet.',
      peopleFailed: 'Failed to read people',
      personBack: 'Back',
      personNone: 'No relations worked out yet.',
      analysisTitle: 'Knowledge analysis',
      analysisHint: 'Runs on a schedule and works through chats, tasks and notes to recognize people and relations.',
      analysisRun: 'Analyze now',
      analysisRunning: 'Analyzing…',
      analysisNever: 'Never analyzed yet',
      analysisPending: 'messages waiting',
      analysisFound: 'people recognized',
      analysisFailed: 'Analysis failed',
      kbBack: 'Back to list',
      remindTitle: 'Reminders',
      briefTimes: 'Daily digest times',
      briefTimesHint: 'Comma separated, e.g. 09:00, 18:30. The bot pushes what is still open at each time.',
      tickInterval: 'Check interval (seconds)',
      tickIntervalHint: 'Minimum 10 seconds.',
      quietTitle: 'Quiet hours',
      quietStart: 'From',
      quietEnd: 'To',
      quietHint: 'Nothing is pushed during this window; it is delivered after it ends. Leave both empty to turn it off.',
      weeklyTitle: 'Weekly review',
      weeklyDay: 'Day',
      weeklyTime: 'Time',
      weeklyOff: 'Off',
      weeklyHint: 'A recap of what got done and what is still open goes out at that moment.',
      analysisTitle2: 'Knowledge analysis',
      analysisEnabledLabel: 'Automatic analysis',
      analysisEnabledHint: 'When on, chats, tasks and notes are digested on a schedule to recognize people and relations.',
      analysisTimeLabel: 'Run daily at',
      analysisTimeHint: 'Format 03:00. Leave empty for the default.',
      analysisIdleLabel: 'Idle minutes',
      analysisIdleHint: 'Run once the chat has been quiet this long and there is something to digest. 0 disables it.',
      weekday1: 'Mon',
      weekday2: 'Tue',
      weekday3: 'Wed',
      weekday4: 'Thu',
      weekday5: 'Fri',
      weekday6: 'Sat',
      weekday7: 'Sun',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      sendDigest: 'Send a digest now',
      sending: 'Sending…',
      digestSent: 'Sent to WeChat',
      digestFailed: 'Not delivered, see the log in the data directory',
      digestNeedHello: 'WeChat bots cannot speak first. Send the bot any message from WeChat, then try again.',
      helloHint: 'No message from you yet, so reminders cannot be delivered. Send the bot anything in WeChat and this starts working.',
      dataDir: 'Data directory',
      preset: 'Assistant preset',
      permission: 'Permission',
      presetHint: 'Preset and permission live in cordis.patch.yml; restart the host after changing them.',
      loadFailed: 'Failed to load',
      saveFailed: 'Failed to save',
      emptyTime: 'At least one time is required',
      bottomHint: 'This page only works on your own computer.',

      // Full page view
      panelTitle: 'Work assistant',
      panelSubtitle: 'Everything on your plate, what is stuck, and what got done this week',
      backToChat: 'Back to chat',
      refresh: 'Refresh',
      loading: 'Loading…',
      statOpen: 'Open',
      statOverdue: 'Overdue',
      statDoing: 'In progress',
      statDoneWeek: 'Done this week',
      statCreatedWeek: 'Added this week',
      statStale: 'Stale over a week',
      chartPriority: 'By priority',
      chartTrend: 'Last two weeks',
      chartTags: 'By tag',
      chartEmpty: 'No data yet',
      legendHigh: 'High',
      legendNormal: 'Normal',
      legendLow: 'Low',
      trendCreated: 'Added',
      trendDone: 'Done',
      taskSection: 'All work items',
      searchPlaceholder: 'Search title, detail, tag',
      filterDoing: 'In progress',
      editTitle: 'Title',
      editPriority: 'Priority',
      editDue: 'Due',
      editTags: 'Tags',
      editDueHint: 'Like 2026-10-24 18:00, leave empty for no due date',
      editTagsHint: 'Comma separated, e.g. finance, receipts',
      saveItem: 'Save',
      savingItem: 'Saving…',
      itemSaved: 'Saved',
      itemFailed: 'Save failed',
      expand: 'Expand',
      collapse: 'Collapse',
      snoozeHour: 'Snooze 1h',
      snoozeDay: 'Snooze 1d',
      priorityAuto: 'auto',
      kbReadMore: 'Open',
      settingsSummary: 'Runtime',
      settingsHint: 'Reminder times and quiet hours live in the settings page.',
      noTasks: 'Nothing matches these filters.',
      chartAssignee: 'Waiting on',
      chartOldest: 'Oldest',
      ageDays: 'd',
      asgTitle: 'Helpers',
      asgHint: 'Dispatched work runs in its own session and reports back here.',
      asgEmpty: 'No helpers yet. Ask the assistant to dispatch one for a big job.',
      asgCreate: 'Dispatch',
      asgPurpose: 'What should it do',
      asgPurposeHint: 'One line, e.g. turn the last three months of receipts into a sheet',
      asgSend: 'Message',
      asgSendHint: 'Add a requirement, it keeps working',
      asgStop: 'Stop',
      asgStopDone: 'Stopped',
      asgStopKept: 'Stopped. This session was already open before, so it stays in your session list — close it yourself if you want.',
      asgOpen: 'Open',
      asgSending: 'Sending…',
      asgCreating: 'Starting…',
      asgStatusIdle: 'Idle',
      asgStatusRunning: 'Working',
      asgStatusWaiting: 'Needs your reply',
      asgStatusDone: 'Reported',
      asgStatusStopped: 'Stopped',
      asgStatusOffline: 'Offline',
      asgReport: 'Latest report',
      asgNoSession: 'Session not ready',
      asgFailed: 'Action failed',
    };

    const CSS = `
.wa-root { display: flex; flex-direction: column; gap: 18px; font-size: 13px; }
.wa-card { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.28)); border-radius: 12px; padding: 16px; }
.wa-card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.wa-sub { margin: -6px 0 12px; opacity: .65; line-height: 1.6; }
.wa-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wa-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
            border: 1px solid var(--dsh-color-border, rgba(128,128,128,.28)); font-size: 12px; }
.wa-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsh-color-text-secondary, #8a8a8a); }
.wa-dot.on { background: #3fa45b; }
.wa-qr { width: 208px; height: 208px; display: flex; align-items: center; justify-content: center;
         background: #fff; border-radius: 10px; overflow: hidden; margin: 12px 0; }
.wa-qr img { width: 208px; height: 208px; display: block; }
.wa-qr span { color: #8a8a8a; font-size: 12px; padding: 0 12px; text-align: center; }
.wa-stats { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 12px; }
.wa-stat b { display: block; font-size: 19px; font-weight: 600; line-height: 1.2; }
.wa-stat span { opacity: .65; font-size: 12px; }
.wa-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.wa-list li { display: flex; gap: 8px; align-items: baseline; line-height: 1.5; }
.wa-list code { font-size: 11px; opacity: .6; }
.wa-rank { min-width: 16px; font-size: 11px; opacity: .5; font-variant-numeric: tabular-nums; }
.wa-done { text-decoration: line-through; opacity: .55; }
.wa-doc { margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(128,128,128,.08);
          white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.7; max-height: 320px; overflow: auto; }
.wa-mini { padding: 2px 8px; font-size: 11px; margin-left: auto; }
.wa-pri { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; opacity: .8; }
.wa-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.wa-field label { font-weight: 600; font-size: 12px; }
.wa-field small { opacity: .6; line-height: 1.5; }
.wa-field input { padding: 7px 10px; border-radius: 7px; font-size: 13px; font-family: inherit;
                  border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35));
                  background: var(--dsh-color-input-bg, transparent); color: inherit; }
.wa-btn { padding: 7px 14px; font-size: 12px; border-radius: 7px; cursor: pointer; font-family: inherit;
          border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35));
          background: var(--dsh-color-button-bg, transparent); color: inherit; }
.wa-btn:hover:not(:disabled) { border-color: var(--dsh-color-text-secondary, #8a8a8a); }
.wa-btn:disabled { opacity: .5; cursor: default; }
.wa-btn.primary { background: var(--dsh-color-accent, #3d6ef0); border-color: transparent; color: #fff; }
.wa-msg { font-size: 12px; line-height: 1.5; }
.wa-msg.err { color: #d05555; }
.wa-msg.ok { color: #3fa45b; }
.wa-warn { margin: 0 0 12px; padding: 9px 12px; font-size: 12px; line-height: 1.6; border-radius: 8px;
           background: rgba(214,148,42,.12); border: 1px solid rgba(214,148,42,.4); color: #b57e22; }
.wa-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; opacity: .75; margin-top: 12px; }
.wa-kv div:nth-child(odd) { opacity: .7; }

/* 整页视图。高度用 100% 撑满中间列：中间列是网格项，高度确定，百分比能算出来。
   Windows 上框架自己给整帧留了标题栏高度，这里不能再加一层，否则顶部会多出一条空白；
   macOS 上框架不垫，入口型页面要自己吃 --dsh-frame-top-clearance，否则内容钻到红绿灯下面。
   这个分支和插件管理器页面的写法一致。 */
.wa-page { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; height: 100%;
           min-width: 0; min-height: 0; background: var(--dsw-alias-bg-base, transparent); }
[data-platform='darwin'] .wa-page { padding-block-start: var(--dsh-frame-top-clearance, 0px); }
.wa-page-head { display: flex; align-items: center; gap: 12px; padding: 16px 24px 12px; flex-wrap: wrap;
                border-bottom: 1px solid var(--dsh-color-border, rgba(128,128,128,.2)); }
.wa-page-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.wa-page-head p { margin: 2px 0 0; font-size: 12px; opacity: .6; }
.wa-page-head .wa-spacer { margin-left: auto; }
.wa-page-body { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px 36px;
                display: flex; flex-direction: column; gap: 16px; }
.wa-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.wa-metric { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.24)); border-radius: 10px; padding: 12px 14px; }
.wa-metric b { display: block; font-size: 22px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.wa-metric span { font-size: 12px; opacity: .62; }
.wa-metric.alert b { color: #d05555; }
.wa-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.wa-chart { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.24)); border-radius: 10px; padding: 14px; min-width: 0; }
.wa-chart h4 { margin: 0 0 12px; font-size: 12px; font-weight: 600; opacity: .8; }
.wa-chart .wa-empty { font-size: 12px; opacity: .5; padding: 18px 0; text-align: center; }
.wa-donut-wrap { display: flex; align-items: center; gap: 16px; }
.wa-donut { width: 96px; height: 96px; flex: none; }
.wa-donut text { font-size: 18px; font-weight: 600; fill: currentColor; }
.wa-legend { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 0; }
.wa-legend div { display: flex; align-items: center; gap: 6px; }
.wa-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.wa-bar-row { display: grid; grid-template-columns: minmax(48px, 96px) 1fr auto; gap: 8px;
              align-items: center; font-size: 12px; margin-bottom: 7px; }
.wa-bar-row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.wa-bar-track { height: 6px; border-radius: 3px; background: rgba(128,128,128,.16); overflow: hidden; }
.wa-bar-fill { height: 100%; border-radius: 3px; background: var(--dsh-color-accent, #3d6ef0); }
.wa-bar-num { font-variant-numeric: tabular-nums; opacity: .6; }
.wa-trend { display: flex; align-items: flex-end; gap: 4px; height: 96px; }
.wa-trend-col { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end;
                align-items: center; gap: 2px; height: 100%; }
.wa-trend-bars { display: flex; align-items: flex-end; gap: 2px; width: 100%; height: 100%; }
.wa-trend-bars i { flex: 1; border-radius: 2px 2px 0 0; min-height: 2px; }
.wa-trend-bars i.created { background: var(--dsh-color-accent, #3d6ef0); opacity: .85; }
.wa-trend-bars i.done { background: #3fa45b; opacity: .85; }
.wa-trend-col em { font-size: 9px; opacity: .45; font-style: normal; white-space: nowrap; }
.wa-trend-legend { display: flex; gap: 14px; font-size: 11px; opacity: .65; margin-top: 10px; }
.wa-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.wa-tab { padding: 5px 12px; font-size: 12px; border-radius: 999px; cursor: pointer; font-family: inherit;
          border: 1px solid var(--dsh-color-border, rgba(128,128,128,.3));
          background: transparent; color: inherit; }
.wa-tab.on { background: var(--dsh-color-accent, #3d6ef0); border-color: transparent; color: #fff; }
.wa-input { padding: 6px 10px; border-radius: 7px; font-size: 12px; font-family: inherit; min-width: 0;
            border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35));
            background: var(--dsh-color-input-bg, transparent); color: inherit; }
.wa-select { padding: 6px 8px; border-radius: 7px; font-size: 12px; font-family: inherit;
             border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35));
             background: var(--dsh-color-input-bg, transparent); color: inherit; }
.wa-item { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.2)); border-radius: 9px;
           padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.wa-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.wa-item-head .wa-title { flex: 1; min-width: 120px; line-height: 1.4; }
.wa-item-body { display: flex; flex-direction: column; gap: 10px; padding-top: 8px;
                border-top: 1px dashed var(--dsh-color-border, rgba(128,128,128,.28)); }
.wa-item-body .wa-field { margin-bottom: 0; }
.wa-item-body .wa-row { gap: 10px; }
.wa-asg { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.2)); border-radius: 9px;
          padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.wa-asg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.wa-asg-head .wa-title { flex: 1; min-width: 120px; line-height: 1.4; }
.wa-asg-report { font-size: 12px; opacity: .78; line-height: 1.6; }
.wa-asg-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.wa-asg-actions .wa-btn { margin: 0; }
.wa-flag { padding: 2px 8px; border-radius: 999px; font-size: 11px;
           background: rgba(240,170,40,.18); color: #b8791a; }

/* 左侧「对话」页签。画法照宿主原生会话列表（也就是 im 助理「频道」那一页）：
   一行 32px、圆角 8px、悬停才出底色、标题 14px 单行省略、右边 10px 小字时间。
   --dsh-session-list-* 这几个变量宿主和 im 助理都在用，跟着用才能和别的页签左右对齐。 */
.wa-rail { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column;
           --dsh-session-list-edge-inset: var(--dsh-sidebar-inline-padding, 12px);
           --dsh-session-list-scrollbar-width: 5px;
           --dsh-session-list-scrollbar-offset: 2px;
           padding: 0; padding-right: var(--dsh-session-list-edge-inset);
           box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit);
           font: 14px/20px inherit; }
.wa-rail *, .wa-rail *::before, .wa-rail *::after { box-sizing: border-box; }
.wa-rail-toolbar { flex: none; display: flex; align-items: center; gap: 4px; height: 36px;
                   margin: 2px -4px 4px 0; padding-left: 4px; position: relative; z-index: 2;
                   color: var(--dsw-alias-label-tertiary, #81858C); }
.wa-rail-spacer { margin-left: auto; }
.wa-rail-label { font-size: 13px; line-height: 20px; white-space: nowrap; overflow: hidden;
                 text-overflow: ellipsis; }
.wa-rail-ico { display: inline-flex; align-items: center; justify-content: center; flex: none;
               width: 28px; height: 28px; min-width: 28px; padding: 0; border: 0; border-radius: 50%;
               background: transparent; color: inherit; cursor: pointer; }
.wa-rail-ico:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06));
                     color: var(--dsw-alias-label-primary, inherit); }
.wa-rail-area { flex: 1; min-height: 0; display: flex; flex-direction: column; margin-left: -4px;
                margin-right: calc(-1 * var(--dsh-session-list-edge-inset)); padding-left: 4px; }
.wa-rail-tree { flex: 1; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto;
                user-select: none; margin-left: -4px; padding: 0 0 16px 4px;
                padding-right: calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));
                scrollbar-gutter: stable; }
.wa-rail-group { position: relative; min-width: 0; max-width: 100%; }
.wa-rail-group + .wa-rail-group { margin-top: 4px; }
.wa-rail-group > * + * { margin-top: 2px; }
.wa-rail-group-head, .wa-rail-row { display: flex; align-items: center; width: 100%;
                max-width: 100%; gap: 6px; height: 32px; padding: 0 8px; border: 0; border-radius: 8px;
                background: transparent; color: inherit; font: 14px/20px inherit; text-align: left;
                cursor: pointer; appearance: none; }
/* 每天那一行缩进到分组标题底下，和原生会话列表的层级一致。 */
.wa-rail-row { gap: 0; padding-left: 40px; }
.wa-rail-group-head:hover, .wa-rail-row:hover, .wa-rail-row.is-on {
                background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.wa-rail-group-head:focus-visible, .wa-rail-row:focus-visible {
                outline: none; box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary, #4c8dff); }
.wa-rail-slot { display: inline-flex; align-items: center; justify-content: center; flex: none;
                width: 16px; min-width: 16px; height: 20px; color: var(--dsw-alias-label-tertiary, #81858C); }
.wa-rail-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                font-size: 14px; line-height: 20px; font-weight: 400; }
.wa-rail-row .wa-rail-name { margin: 0 6px 0 4px; }
.wa-rail-time { flex: none; font-size: 10px; line-height: 16px; white-space: nowrap;
                color: var(--dsw-alias-label-caption, #ADB2B8); }
.wa-rail-empty { padding: 16px 12px; font-size: 13px; line-height: 1.6;
                 color: var(--dsw-alias-label-tertiary, #81858C); }
.wa-rail-error { padding: 12px; font-size: 13px; line-height: 1.6; color: #d05555; }
.wa-rail-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
               color: var(--dsw-alias-label-tertiary, #81858C); }
.wa-rail-dot.run { color: var(--dsw-alias-state-business-primary, #4c8dff); }
.wa-rail-dot.wait { color: #d99a2b; }
.wa-rail-dot.me { color: var(--dsw-alias-state-business-primary, #4c8dff); }
.wa-rail-dot.bot { color: var(--dsw-alias-label-tertiary, #81858C); }
/* 整页面板里的「对话记录」：沿用同一套字号和行高，但那是在卡片里，
   不用侧栏那套贴边变量。 */
.wa-conv { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.wa-conv-row { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px;
               border: 0; border-radius: 8px; background: transparent; color: inherit;
               font: 14px/20px inherit; text-align: left; cursor: pointer; }
.wa-conv-row:hover { background: rgba(128,128,128,.12); }
.wa-conv-day { flex: none; width: 62px; font-size: 12px; line-height: 20px; white-space: nowrap;
               overflow: hidden; text-overflow: ellipsis; opacity: .65; }
.wa-conv-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-conv-time { flex: none; font-size: 11px; line-height: 16px; opacity: .55; white-space: nowrap; }
.wa-conv-msg { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 8px; }
.wa-conv-msg:hover { background: rgba(128,128,128,.06); }
.wa-conv-msg .wa-conv-name { white-space: pre-wrap; word-break: break-word; }
.wa-conv-msg .wa-conv-time { padding-top: 2px; }
.wa-conv-slot { flex: none; width: 16px; height: 20px; display: inline-flex; align-items: center;
                justify-content: center; }
`;

    // 统一的请求封装：DSH 的接口都要求同源凭据，写操作还要带 JSON content-type。
    function useApi() {
      return React.useCallback(async (path, options) => {
        const init = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
        const method = String(init.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
          if (init.body === undefined) init.body = '{}';
        }
        const res = await fetch(API + path, init);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
        return data;
      }, []);
    }

    function loginLabel(t, step) {
      if (step === 'confirmed') return t('confirmed');
      if (step === 'scanned') return t('scanned');
      if (step === 'expired') return t('expired');
      if (step === 'error') return t('qrUnavailable');
      return t('scanning');
    }

    function priorityText(p) {
      if (p === 'high') return '高';
      if (p === 'low') return '低';
      return '普通';
    }

    function formatDue(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // 文案读取器：设置外壳有时不往组件里传 t，只靠 props.t 会整页显示成 key 名。
    // 这里留一个自己的 bind 兜底，并订阅 locale 快照，切换语言时跟着重渲染。
    let localeFace = null;
    // 侧栏页签不在我们页面里，拿不到面板那套注入的 props，服务得自己取一遍
    let appCtx = null;

    function useLocaleRevision() {
      const subscribe = React.useCallback(
        (listener) => (localeFace ? localeFace.subscribe(listener) : () => {}),
        [],
      );
      const getSnapshot = React.useCallback(
        () => (localeFace ? localeFace.getSnapshot().revision : 0),
        [],
      );
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 拿一个「只在语言包换代时才换」的翻译函数。
    // 不能每次渲染都 localeFace.bind(NS)：t 在好几个 effect 的依赖里，
    // 每渲染换一个新函数就等于每渲染把 effect 重跑一遍，轮询会变成死循环。
    function useBoundT(fallback) {
      const revision = useLocaleRevision();
      const latest = React.useRef(fallback);
      latest.current = fallback;
      return React.useMemo(
        () => latest.current || (localeFace ? localeFace.bind(NS) : (key) => key),
        [revision],
      );
    }

    function WorkAssistantSettings(props) {
      const t = useBoundT(props.t);
      const api = useApi();

      const [overview, setOverview] = React.useState(null);
      const [step, setStep] = React.useState('idle');
      const [qr, setQr] = React.useState('');
      const [times, setTimes] = React.useState('');
      const [tick, setTick] = React.useState('');
      const [quietStart, setQuietStart] = React.useState('');
      const [quietEnd, setQuietEnd] = React.useState('');
      const [weeklyDay, setWeeklyDay] = React.useState('0');
      const [weeklyTime, setWeeklyTime] = React.useState('');
      const [analysisEnabledBox, setAnalysisEnabledBox] = React.useState('true');
      const [analysisTime, setAnalysisTime] = React.useState('');
      const [analysisIdle, setAnalysisIdle] = React.useState('30');
      // 会话设置：从宿主现读的下拉项 + 当前选择
      const [options, setOptions] = React.useState(null);
      const [preset, setPreset] = React.useState('');
      const [permission, setPermission] = React.useState('');
      const [modelKey, setModelKey] = React.useState('');
      const [effort, setEffort] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [refreshKey, setRefreshKey] = React.useState(0);

      const bump = React.useCallback(() => setRefreshKey((n) => n + 1), []);

      // 输入框是否已经用服务端的值灌过。只灌一次，之后轮询不再覆盖用户正在改的内容。
      const seeded = React.useRef(false);

      // 任务清单：跟概览分开拉，能按状态筛，带紧急度排名
      const [tasks, setTasks] = React.useState(null);
      const [taskFilter, setTaskFilter] = React.useState('open');

      React.useEffect(() => {
        let alive = true;
        let timer = null;

        async function pull() {
          try {
            const data = await api(`/items?status=${encodeURIComponent(taskFilter)}`);
            if (!alive) return;
            setTasks(data);
          } catch (err) {
            if (alive) setError(`${t('tasksFailed')}：${err.message || err}`);
          }
        }

        void pull();
        timer = setInterval(pull, 8000);
        return () => {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, [api, t, taskFilter, refreshKey]);

      async function onToggleTask(item) {
        setBusy(`task:${item.id}`);
        setError('');
        try {
          const next = item.status === 'done' ? 'open' : 'done';
          await api('/item', { method: 'POST', body: JSON.stringify({ id: item.id, status: next }) });
          setNotice(next === 'done' ? t('markDone') : t('markOpen'));
          bump();
        } catch (err) {
          setError(`${t('taskFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      // 知识库：跟任务分开拉。搜索框输一个字就打一次接口没必要，按回车或点按钮才搜。
      const [kb, setKb] = React.useState(null);
      const [kbQuery, setKbQuery] = React.useState('');
      const [kbDoc, setKbDoc] = React.useState(null);

      const pullKb = React.useCallback(
        async (query) => {
          try {
            const suffix = query ? `?query=${encodeURIComponent(query)}` : '';
            const data = await api(`/kb${suffix}`);
            setKb(data);
          } catch (err) {
            setError(`${t('kbFailed')}：${err.message || err}`);
          }
        },
        [api, t],
      );

      React.useEffect(() => {
        void pullKb('');
      }, [pullKb, refreshKey]);

      async function onSearchKb() {
        setError('');
        await pullKb(kbQuery.trim());
      }

      async function onOpenKb(doc) {
        setError('');
        try {
          const data = await api(`/kb/doc?id=${encodeURIComponent(doc.id)}`);
          setKbDoc(data.doc);
        } catch (err) {
          setError(`${t('kbFailed')}：${err.message || err}`);
        }
      }

      // 下拉项：预设、模型、权限这些都在宿主里，现读一次就够了，不用轮询
      React.useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const data = await api('/options');
            if (alive) setOptions(data);
          } catch (err) {
            if (alive) setError(`${t('optionsFailed')}：${err.message || err}`);
          }
        })();
        return () => {
          alive = false;
        };
      }, [api, t, refreshKey]);

      // 概览：登录状态、账本统计、当前生效的提醒设置
      React.useEffect(() => {
        let alive = true;
        let timer = null;

        async function pull() {
          try {
            const data = await api('/overview');
            if (!alive) return;
            setOverview(data);
            setError('');
            // 输入框只在第一次拉到数据时灌一次。之后 8 秒一次的轮询不许再动它们：
            // 用户清空安静时段准备关掉，下一次轮询就把旧值填回去，等于改不动。
            if (!seeded.current) {
              seeded.current = true;
              setTimes((data.settings?.dailyBriefTimes ?? []).join(', '));
              setTick(String(data.settings?.tickIntervalSeconds ?? ''));
              setQuietStart(data.settings?.quietHoursStart ?? '');
              setQuietEnd(data.settings?.quietHoursEnd ?? '');
              setWeeklyDay(String(data.settings?.weeklyReviewWeekday ?? 0));
              setWeeklyTime(data.settings?.weeklyReviewTime ?? '');
              setAnalysisEnabledBox(data.settings?.analysisEnabled === false ? 'false' : 'true');
              setAnalysisTime(data.settings?.analysisDailyTime ?? '');
              setAnalysisIdle(String(data.settings?.analysisIdleMinutes ?? 30));
              setPreset(data.settings?.agentPreset ?? '');
              setPermission(data.settings?.permissionPreset ?? '');
              const seededProvider = data.settings?.agentProvider ?? '';
              const seededModel = data.settings?.agentModel ?? '';
              setModelKey(seededProvider && seededModel ? `${seededProvider}\u0000${seededModel}` : '');
              setEffort(data.settings?.agentReasoningEffort ?? '');
            }
          } catch (err) {
            if (alive) setError(`${t('loadFailed')}：${err.message || err}`);
          }
        }

        void pull();
        timer = setInterval(pull, 8000);
        return () => {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, [api, t, refreshKey]);

      const loggedIn = Boolean(overview?.status?.loggedIn);
      // 登录了但还没收到过你的消息：微信不允许机器人主动开口，
      // 这时候到期提醒和摘要都发不出去，必须在页面上说清楚，否则用户只会看到「没发出去」。
      const canPush = overview?.status?.canPush !== false;

      // 没登录的时候才轮询二维码，登录了就停，免得白白打接口
      React.useEffect(() => {
        if (loggedIn) return undefined;
        let alive = true;
        let timer = null;
        let stopped = false;

        async function scan() {
          if (stopped) return;
          try {
            const data = await api('/login/scan');
            if (!alive) return;
            setStep(data?.status ?? 'idle');
            if (data?.qrDataUrl) setQr(data.qrDataUrl);
            if (data?.status === 'confirmed' || data?.status === 'loggedIn') {
              stopped = true;
              if (timer) clearInterval(timer);
              timer = null;
              bump();
            }
          } catch (err) {
            if (alive) setStep('error');
          }
        }

        void scan();
        timer = setInterval(scan, 2000);
        return () => {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, [api, loggedIn, refreshKey, bump]);

      async function onRelogin() {
        setBusy('relogin');
        setNotice('');
        setError('');
        try {
          await api('/relogin', { method: 'POST' });
          setQr('');
          setStep('waiting');
          bump();
        } catch (err) {
          setError(`${t('loginFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      async function onSave() {
        setBusy('save');
        setNotice('');
        setError('');
        try {
          const list = times
            .split(/[,，\s]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (list.length === 0) throw new Error(t('emptyTime'));
          await api('/settings', {
            method: 'POST',
            body: JSON.stringify({
              dailyBriefTimes: list,
              tickIntervalSeconds: Number(tick) || undefined,
              quietHoursStart: quietStart.trim(),
              quietHoursEnd: quietEnd.trim(),
              weeklyReviewWeekday: Number(weeklyDay),
              weeklyReviewTime: weeklyTime.trim(),
              analysisEnabled: analysisEnabledBox === 'true',
              analysisDailyTime: analysisTime.trim(),
              analysisIdleMinutes: Number(analysisIdle),
              agentPreset: preset,
              permissionPreset: permission,
              agentProvider: modelKey ? modelKey.split('\u0000')[0] : '',
              agentModel: modelKey ? modelKey.split('\u0000')[1] ?? '' : '',
              agentReasoningEffort: effort,
            }),
          });
          setNotice(t('saved'));
          setDirty(false);
          bump();
        } catch (err) {
          setError(`${t('saveFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      async function onDigest() {
        setBusy('digest');
        setNotice('');
        setError('');
        try {
          const result = await api('/digest', { method: 'POST' });
          if (result?.sent) setNotice(t('digestSent'));
          else if (result?.reason === 'no-context-token') setNotice(t('digestNeedHello'));
          else setNotice(t('digestFailed'));
        } catch (err) {
          setError(`${t('saveFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      const counts = overview?.counts ?? {};
      const settings = overview?.settings ?? {};
      const presetChoices = options?.presets ?? [];
      const modelChoices = [];
      for (const provider of options?.providers ?? []) {
        for (const model of provider.models ?? []) {
          modelChoices.push({
            key: `${provider.id}\u0000${model.id}`,
            label: `${provider.name} / ${model.name}`,
            efforts: model.efforts ?? [],
          });
        }
      }
      const activeModel = modelChoices.find((row) => row.key === modelKey);
      const effortChoices = activeModel?.efforts ?? [];

      return h(
        'div',
        { className: 'wa-root' },
        h('style', null, CSS),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('title')),
          h('p', { className: 'wa-sub' }, t('subtitle')),
          h(
            'div',
            { className: 'wa-row' },
            h(
              'span',
              { className: 'wa-badge' },
              h('span', { className: `wa-dot${loggedIn ? ' on' : ''}` }),
              loggedIn ? t('loggedIn') : t('loggedOut'),
            ),
            h(
              'button',
              {
                className: 'wa-btn',
                type: 'button',
                disabled: busy === 'relogin',
                onClick: onRelogin,
              },
              busy === 'relogin' ? t('reloginBusy') : t('relogin'),
            ),
          ),
          loggedIn
            ? null
            : h(
                'div',
                null,
                h(
                  'div',
                  { className: 'wa-qr' },
                  qr ? h('img', { src: qr, alt: t('qrHint') }) : h('span', null, loginLabel(t, step)),
                ),
                h('p', { className: 'wa-sub' }, t('qrHint')),
                h('div', { className: 'wa-msg' }, loginLabel(t, step)),
              ),
          loggedIn && !canPush ? h('p', { className: 'wa-warn' }, t('helloHint')) : null,
          loggedIn
            ? null
            : h(
                'div',
                { className: 'wa-kv' },
                h('div', null, t('dataDir')),
                h('div', null, settings.stateDir ?? ''),
              ),
        ),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('sessionTitle')),
          h('p', { className: 'wa-sub' }, t('sessionHint')),
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('sessionPreset')),
            h(
              'select',
              {
                className: 'wa-select',
                value: preset,
                onChange: (event) => {
                  setPreset(event.target.value);
                  setDirty(true);
                },
              },
              // 第一项是「不指定」：用宿主自己的默认预设。别人的机器上预设名字不一样，
              // 写死某一个会让插件装过去就挂错人格。
              h('option', { key: '__host', value: '' }, t('sessionFollowHost')),
              ...presetChoices.map((row) => h('option', { key: row.id, value: row.id }, row.name)),
            ),
          ),
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('sessionModel')),
            h(
              'select',
              {
                className: 'wa-select',
                value: modelKey,
                onChange: (event) => {
                  setModelKey(event.target.value);
                  setEffort('');
                  setDirty(true);
                },
              },
              h('option', { value: '' }, t('sessionFollowHost')),
              ...modelChoices.map((row) => h('option', { key: row.key, value: row.key }, row.label)),
            ),
          ),
          effortChoices.length > 0
            ? h(
                'div',
                { className: 'wa-field' },
                h('label', null, t('sessionEffort')),
                h(
                  'select',
                  {
                    className: 'wa-select',
                    value: effort,
                    onChange: (event) => {
                      setEffort(event.target.value);
                      setDirty(true);
                    },
                  },
                  h('option', { value: '' }, t('sessionEffortDefault')),
                  ...effortChoices.map((row) => h('option', { key: row.id, value: row.id }, row.name)),
                ),
              )
            : null,
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('sessionPermission')),
            h(
              'select',
              {
                className: 'wa-select',
                value: permission,
                onChange: (event) => {
                  setPermission(event.target.value);
                  setDirty(true);
                },
              },
              ...(options?.permissions ?? []).map((row) => h('option', { key: row.value, value: row.value }, row.name)),
            ),
          ),
        ),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('items')),
          h(
            'div',
            { className: 'wa-stats' },
            h('div', { className: 'wa-stat' }, h('b', null, String(counts.open ?? 0)), h('span', null, t('openCount'))),
            h('div', { className: 'wa-stat' }, h('b', null, String(counts.overdue ?? 0)), h('span', null, t('overdue'))),
            h('div', { className: 'wa-stat' }, h('b', null, String(counts.doing ?? 0)), h('span', null, t('doing'))),
            h('div', { className: 'wa-stat' }, h('b', null, String(counts.actionable ?? 0)), h('span', null, t('actionable'))),
          ),
          h(
            'div',
            { className: 'wa-row', style: { marginTop: '14px' } },
            h(
              'button',
              { className: 'wa-btn', type: 'button', disabled: busy === 'digest', onClick: onDigest },
              busy === 'digest' ? t('sending') : t('sendDigest'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('tasks')),
          h('p', { className: 'wa-sub' }, t('tasksHint')),
          h(
            'div',
            { className: 'wa-row', style: { marginBottom: '12px' } },
            ...[
              ['open', t('filterOpen')],
              ['done', t('filterDone')],
              ['all', t('filterAll')],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: `wa-btn${taskFilter === key ? ' primary' : ''}`,
                  onClick: () => setTaskFilter(key),
                },
                label,
              ),
            ),
          ),
          !tasks || !tasks.items || tasks.items.length === 0
            ? h('p', { className: 'wa-sub' }, tasks ? t('tasksEmpty') : t('tasksHint'))
            : h(
                'ul',
                { className: 'wa-list' },
                tasks.items.map((item) =>
                  h(
                    'li',
                    { key: item.id },
                    h('span', { className: 'wa-rank' }, String(item.rank ?? '')),
                    h('span', { className: 'wa-pri' }, priorityText(item.priority)),
                    h(
                      'span',
                      { className: item.status === 'done' ? 'wa-done' : undefined },
                      item.title,
                    ),
                    item.dueAt ? h('span', { className: 'wa-sub', style: { margin: 0 } }, formatDue(item.dueAt)) : null,
                    h('code', null, item.id),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wa-btn wa-mini',
                        disabled: busy === `task:${item.id}`,
                        onClick: () => onToggleTask(item),
                      },
                      item.status === 'done' ? t('markOpen') : t('markDone'),
                    ),
                  ),
                ),
              ),
        ),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('kbTitle')),
          h('p', { className: 'wa-sub' }, t('kbHint')),
          h(
            'div',
            { className: 'wa-row', style: { marginBottom: '12px' } },
            h('input', {
              'aria-label': t('kbSearch'),
              placeholder: t('kbSearchPlaceholder'),
              value: kbQuery,
              onChange: (event) => setKbQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void onSearchKb();
              },
            }),
            h('button', { className: 'wa-btn', type: 'button', onClick: onSearchKb }, t('kbSearch')),
            kbDoc
              ? h('button', { className: 'wa-btn', type: 'button', onClick: () => setKbDoc(null) }, t('kbBack'))
              : null,
          ),
          kbDoc
            ? h(
                'div',
                null,
                h('div', { className: 'wa-row', style: { marginBottom: '8px' } }, h('strong', null, kbDoc.title)),
                kbDoc.tags?.length
                  ? h('p', { className: 'wa-sub' }, kbDoc.tags.join(' · '))
                  : null,
                h('pre', { className: 'wa-doc' }, kbDoc.content),
              )
            : (kb?.docs ?? []).length === 0
              ? h('p', { className: 'wa-sub' }, kb ? t('kbEmpty') : '…')
              : h(
                  'ul',
                  { className: 'wa-list' },
                  (kb?.docs ?? []).map((doc) =>
                    h(
                      'li',
                      { key: doc.id },
                      h('code', null, doc.id),
                      h(
                        'a',
                        {
                          href: '#',
                          onClick: (event) => {
                            event.preventDefault();
                            void onOpenKb(doc);
                          },
                        },
                        doc.title,
                      ),
                      doc.tags?.length ? h('span', { className: 'wa-sub', style: { margin: 0 } }, doc.tags.join(' · ')) : null,
                    ),
                  ),
                ),
        ),

        h(
          'div',
          { className: 'wa-card' },
          h('h3', null, t('remindTitle')),
          h(
            'div',
            { className: 'wa-field' },
            h('label', { htmlFor: 'wa-times' }, t('briefTimes')),
            h('input', {
              id: 'wa-times',
              value: times,
              placeholder: '09:00, 18:30',
              onChange: (event) => {
                setTimes(event.target.value);
                setDirty(true);
              },
            }),
            h('small', null, t('briefTimesHint')),
          ),
          h(
            'div',
            { className: 'wa-field' },
            h('label', { htmlFor: 'wa-tick' }, t('tickInterval')),
            h('input', {
              id: 'wa-tick',
              type: 'number',
              min: 10,
              value: tick,
              onChange: (event) => {
                setTick(event.target.value);
                setDirty(true);
              },
            }),
            h('small', null, t('tickIntervalHint')),
          ),
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('quietTitle')),
            h(
              'div',
              { className: 'wa-row' },
              h('input', {
                'aria-label': t('quietStart'),
                placeholder: t('quietStart'),
                style: { width: '90px' },
                value: quietStart,
                onChange: (event) => {
                  setQuietStart(event.target.value);
                  setDirty(true);
                },
              }),
              h('span', null, '—'),
              h('input', {
                'aria-label': t('quietEnd'),
                placeholder: t('quietEnd'),
                style: { width: '90px' },
                value: quietEnd,
                onChange: (event) => {
                  setQuietEnd(event.target.value);
                  setDirty(true);
                },
              }),
            ),
            h('small', null, t('quietHint')),
          ),
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('weeklyTitle')),
            h(
              'div',
              { className: 'wa-row' },
              h(
                'select',
                {
                  'aria-label': t('weeklyDay'),
                  value: weeklyDay,
                  onChange: (event) => {
                    setWeeklyDay(event.target.value);
                    setDirty(true);
                  },
                },
                h('option', { value: '0' }, t('weeklyOff')),
                h('option', { value: '1' }, t('weekday1')),
                h('option', { value: '2' }, t('weekday2')),
                h('option', { value: '3' }, t('weekday3')),
                h('option', { value: '4' }, t('weekday4')),
                h('option', { value: '5' }, t('weekday5')),
                h('option', { value: '6' }, t('weekday6')),
                h('option', { value: '7' }, t('weekday7')),
              ),
              h('input', {
                'aria-label': t('weeklyTime'),
                placeholder: '18:00',
                style: { width: '90px' },
                value: weeklyTime,
                onChange: (event) => {
                  setWeeklyTime(event.target.value);
                  setDirty(true);
                },
              }),
            ),
            h('small', null, t('weeklyHint')),
          ),
          h(
            'div',
            { className: 'wa-field' },
            h('label', null, t('analysisTitle2')),
            h(
              'div',
              { className: 'wa-row' },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('input', {
                  type: 'checkbox',
                  checked: analysisEnabledBox === 'true',
                  onChange: (event) => {
                    setAnalysisEnabledBox(event.target.checked ? 'true' : 'false');
                    setDirty(true);
                  },
                }),
                t('analysisEnabledLabel')),
              h('input', {
                'aria-label': t('analysisTimeLabel'),
                placeholder: '03:00',
                style: { width: '90px' },
                value: analysisTime,
                onChange: (event) => {
                  setAnalysisTime(event.target.value);
                  setDirty(true);
                },
              }),
              h('input', {
                'aria-label': t('analysisIdleLabel'),
                type: 'number',
                min: 0,
                style: { width: '80px' },
                value: analysisIdle,
                onChange: (event) => {
                  setAnalysisIdle(event.target.value);
                  setDirty(true);
                },
              }),
            ),
            h('small', null, t('analysisEnabledHint')),
            h('small', null, t('analysisTimeHint')),
            h('small', null, t('analysisIdleHint')),
          ),
          h(
            'div',
            { className: 'wa-row' },
            h(
              'button',
              { className: 'wa-btn primary', type: 'button', disabled: busy === 'save' || !dirty, onClick: onSave },
              busy === 'save' ? t('saving') : t('save'),
            ),
            notice ? h('span', { className: 'wa-msg ok' }, notice) : null,
          ),
          h(
            'div',
            { className: 'wa-kv' },
            h('div', null, t('preset')),
            // 空表示跟宿主默认，直接渲染空白会让人以为坏了
            h('div', null, settings.agentPreset || t('sessionFollowHost')),
            h('div', null, t('permission')),
            h('div', null, settings.permissionPreset ?? ''),
            h('div', null, t('dataDir')),
            h('div', null, settings.stateDir ?? ''),
          ),
          h('p', { className: 'wa-sub', style: { marginTop: '10px' } }, t('presetHint')),
          error ? h('div', { className: 'wa-msg err' }, error) : null,
        ),
      );
    }

    // ── 整页视图 ────────────────────────────────────────────
    // 侧边栏图标和中间整页必须用同一个 id：宿主点图标时是拿 sidebar.panellist 的 id
    // 去 main 这个 keyed 插槽里找同名面板，两边对不上就会抛「main panel not registered」。
    const PANEL_ID = 'work-assistant';

    const PRIORITY_COLOR = { high: '#d05555', normal: '#3d6ef0', low: '#8a8a8a' };

    function WorkAssistantIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h6' }),
        h('path', { d: 'M11.5 11.5l1.4 1.4 2.1-2.6' }),
      );
    }

    function Metric(props) {
      return h(
        'div',
        { className: props.alert ? 'wa-metric alert' : 'wa-metric' },
        h('b', null, String(props.value ?? 0)),
        h('span', null, props.label),
      );
    }

    function Donut(props) {
      const R = 40;
      const C = 2 * Math.PI * R;
      const total = props.total ?? 0;
      let offset = 0;
      const arcs = (props.slices ?? []).map((slice, i) => {
        const len = total > 0 ? (slice.value / total) * C : 0;
        const node = h('circle', {
          key: `arc-${i}`,
          cx: 48,
          cy: 48,
          r: R,
          fill: 'none',
          stroke: slice.color,
          strokeWidth: 14,
          strokeDasharray: `${len} ${C - len}`,
          strokeDashoffset: -offset,
          transform: 'rotate(-90 48 48)',
        });
        offset += len;
        return node;
      });
      return h(
        'svg',
        { className: 'wa-donut', viewBox: '0 0 96 96' },
        h('circle', { cx: 48, cy: 48, r: R, fill: 'none', stroke: 'rgba(128,128,128,.16)', strokeWidth: 14 }),
        ...arcs,
        h('text', { x: 48, y: 54, textAnchor: 'middle' }, String(total)),
      );
    }

    // 横向条形：标签分布和「在等谁」共用，省一套样式
    function BarList(props) {
      const rows = props.rows ?? [];
      if (!rows.length) return h('div', { className: 'wa-empty' }, props.emptyLabel);
      const max = Math.max(1, ...rows.map((row) => row.count));
      return h(
        'div',
        null,
        ...rows.map((row, i) =>
          h(
            'div',
            { className: 'wa-bar-row', key: `bar-${i}` },
            h('span', { title: row.label }, row.label),
            h('span', { className: 'wa-bar-track' },
              h('span', { className: 'wa-bar-fill', style: { width: `${(row.count / max) * 100}%` } })),
            h('span', { className: 'wa-bar-num' }, String(row.count)),
          ),
        ),
      );
    }

    function TrendChart(props) {
      const trend = props.trend ?? [];
      if (!trend.length) return h('div', { className: 'wa-empty' }, props.emptyLabel);
      const max = Math.max(1, ...trend.map((day) => Math.max(day.created, day.done)));
      const cols = trend.map((day, i) => {
        // 14 根柱子挤在一起，日期全标会糊成一团，只标首尾和每四天
        const showLabel = i === 0 || i === trend.length - 1 || i % 4 === 0;
        return h(
          'div',
          { className: 'wa-trend-col', key: day.date },
          h(
            'div',
            { className: 'wa-trend-bars' },
            h('i', { className: 'created', style: { height: `${(day.created / max) * 100}%` } }),
            h('i', { className: 'done', style: { height: `${(day.done / max) * 100}%` } }),
          ),
          h('em', null, showLabel ? day.date.slice(5).replace('-', '/') : ''),
        );
      });
      return h(
        'div',
        null,
        h('div', { className: 'wa-trend' }, ...cols),
        h(
          'div',
          { className: 'wa-trend-legend' },
          h('span', null, `▮ ${props.createdLabel}`),
          h('span', null, `▮ ${props.doneLabel}`),
        ),
      );
    }

    // ISO 时刻 → 输入框里能直接改的本地时间写法
    function toDueInput(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // ── 侧栏「对话」页签 ────────────────────────────────────
    // 侧栏那排页签不是宿主自带的座位，是 im 助理插件包了 sidebar.workspaces 之后
    // 自己维护的一张表（挂在组件的 __dshNativeTabs 上）。我们不去重复包那一层
    // ——两层包装会互相盖掉，会话树就没了——只往它已有的表里插一个页签。
    // 认不出那张表（没装 im 助理、或它换了实现）就安静地不插，整页面板照旧能用。
    const RAIL_ID = 'work-assistant-chats';

    function findNativeTabRegistry(entry) {
      const target = entry && (typeof entry === 'object' || typeof entry === 'function') && 'component' in entry
        ? entry.component
        : entry;
      const registry = target && target.__dshNativeTabs;
      if (!registry || registry.version !== 1) return null;
      if (typeof registry.getTabs !== 'function') return null;
      if (typeof registry.subscribe !== 'function') return null;
      if (typeof registry.insert !== 'function') return null;
      return registry;
    }

    // 我们自己的会话 id：控制面是 wa:main，副手是 wa:asg:*。
    // 别的会话（用户自己开的）不该把侧栏切到这一页，否则点开会话就被拽走了。
    function isAssistantSession(id) {
      if (typeof id !== 'string') return false;
      return id === 'wa:main' || id.indexOf('wa:asg:') === 0;
    }

    // 侧栏 render 一旦抛错会把整个会话列表带崩（SessionSwitcher 没有错误边界），
    // 所以自己包一层：坏了只显示一行字，别人的页签照常。
    const BoundaryBase = React.Component || class {};
    class ConversationRailBoundary extends BoundaryBase {
      constructor(props) {
        super(props);
        // 真 React 的 super(props) 已经塞好了；写一遍是为了测试里的假 Component
        this.props = props;
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(err) {
        try {
          console.error('[dsh-work-assistant] 侧栏对话页签渲染失败', err);
        } catch {
          /* 控制台不可用就算了 */
        }
      }

      render() {
        if (this.state.failed) {
          // 文案走 locale：这里挂掉的时候多半只是我们这块的数据出错，
          // 界面语言该是什么还是什么
          const t = localeFace ? localeFace.bind(NS) : (key) => key;
          return h('div', { className: 'wa-rail' },
            h('div', { className: 'wa-rail-tree' },
              h('div', { className: 'wa-rail-empty' }, t('railFailed'))));
        }
        return this.props.children;
      }
    }

    // 日期写「10月22日」，今年的不写年份；列表一行放得下才不显得挤。
    function dayLabelOf(day) {
      const text = String(day || '');
      const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (!matched) return text;
      const monthDay = `${Number(matched[2])}月${Number(matched[3])}日`;
      return matched[1] === String(new Date().getFullYear()) ? monthDay : `${matched[1]}年${monthDay}`;
    }

    // 库里存的时间是 UTC，直接切字符串会差八小时；这里按本机时区算。
    function clockOf(at) {
      const time = Date.parse(String(at || ''));
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // 侧栏这一页只做「挑会话」：一行一个会话，点一下交给宿主开在主区。
    // 和「频道」页签一个逻辑——真正的对话、思考过程、继续打字都在主区的会话里。
    // 侧栏里不内嵌一份聊天，否则同一条会话会有两个界面，两边还不同步。
    function relativeTimeOf(at, t) {
      const time = Date.parse(String(at || ''));
      if (!Number.isFinite(time)) return '';
      const diff = Date.now() - time;
      if (diff < 60000) return t('railJustNow');
      if (diff < 3600000) return `${Math.floor(diff / 60000)} ${t('railMinuteUnit')}`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${t('railHourUnit')}`;
      if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} ${t('railDayUnit')}`;
      const date = new Date(time);
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    function IconRefresh({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.53-3.68', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }),
        h('path', { d: 'M13.1 2.7v3.3H9.8', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }

    function ConversationRail(props) {
      // 不用外面传进来的 t：这个组件是 im 助理的页签壳渲染的，它传的可能是
      // 它自己命名空间的翻译函数，拿我们的 key 去查只会查回 key 名。
      const t = useBoundT(null);
      const api = useApi();

      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [refreshKey, setRefreshKey] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        api('/sessions')
          .then((next) => {
            if (!alive) return;
            setData(next);
            setError('');
          })
          .catch((err) => {
            if (alive) setError(`${t('convFailed')}：${err.message || err}`);
          });
        return () => {
          alive = false;
        };
      }, [api, t, refreshKey]);

      // 开会话有两个入口：im 助理会把 openSession 当 prop 传下来（它自己也是这么开频道会话的），
      // 没传就去宿主客户端服务里取 uiWorkspace。两条路都没有就直说，别让点击像没反应。
      function openSession(id) {
        const direct = props && (props.openSession || props.open);
        if (typeof direct === 'function') {
          try {
            direct(id);
            setError('');
          } catch (err) {
            setError(`${t('railCantOpen')}：${err.message || err}`);
          }
          return;
        }
        const workspace = appCtx ? appCtx.get('uiWorkspace') ?? null : null;
        if (workspace && typeof workspace.openSession === 'function') {
          try {
            workspace.openSession(id);
            setError('');
          } catch (err) {
            setError(`${t('railCantOpen')}：${err.message || err}`);
          }
          return;
        }
        setError(t('railCantOpen'));
      }

      const rows = (data && data.items) || [];

      const head = h(
        'div',
        { className: 'wa-rail-toolbar' },
        h('span', { className: 'wa-rail-label' }, t('railTitle')),
        h('span', { className: 'wa-rail-spacer' }),
        h('button', {
          className: 'wa-rail-ico',
          type: 'button',
          title: t('railRefresh'),
          'aria-label': t('railRefresh'),
          onClick: () => setRefreshKey((n) => n + 1),
        }, h(IconRefresh, { size: 16 })),
      );

      let body;
      if (error) {
        body = h('div', { className: 'wa-rail-tree' }, h('div', { className: 'wa-rail-error' }, error));
      } else if (!rows.length) {
        body = h('div', { className: 'wa-rail-tree' },
          h('div', { className: 'wa-rail-empty' }, data ? t('railEmpty') : t('convHint')));
      } else {
        // 一行一个会话：左边一个小圆点表示在不在跑，中间是会话名，右边是「多久以前」。
        body = h(
          'div',
          { className: 'wa-rail-tree', role: 'tree' },
          ...rows.map((row) => {
            const dot = row.status === 'running' ? 'wa-rail-dot run'
              : row.status === 'waiting' ? 'wa-rail-dot wait'
                : 'wa-rail-dot';
            return h('button', {
              className: 'wa-rail-row',
              type: 'button',
              role: 'treeitem',
              key: row.id,
              'data-session': row.id,
              title: row.title || row.id,
              onClick: () => openSession(row.id),
            },
              h('span', { className: 'wa-rail-slot' }, h('span', { className: dot })),
              h('span', { className: 'wa-rail-name' }, row.title || row.id),
              h('span', { className: 'wa-rail-time' }, relativeTimeOf(row.lastAt, t)));
          }),
        );
      }

      // 这段样式必须自己带一份：侧栏这个页签不是我们页面里的子树，
      // 整页面板那边挂在 DOM 上的 <style> 在这儿根本不存在，样式就全丢了。
      return h('div', { className: 'wa-rail', 'data-dsh-workassistant-rail': '' },
        h('style', null, CSS), head, body);
    }

    function WorkAssistantPanel(props) {
      const t = useBoundT(props.t);
      const api = useApi();

      const [overview, setOverview] = React.useState(null);
      const [stats, setStats] = React.useState(null);
      const [tasks, setTasks] = React.useState(null);
      const [kb, setKb] = React.useState(null);
      const [kbDoc, setKbDoc] = React.useState(null);
      const [filter, setFilter] = React.useState('open');
      const [query, setQuery] = React.useState('');
      const [queryBox, setQueryBox] = React.useState('');
      const [expandedId, setExpandedId] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [refreshKey, setRefreshKey] = React.useState(0);
      const [assignments, setAssignments] = React.useState(null);
      const [assignDraft, setAssignDraft] = React.useState('');
      const [assignTarget, setAssignTarget] = React.useState('');
      const [people, setPeople] = React.useState(null);
      const [personDoc, setPersonDoc] = React.useState(null);
      const [analysis, setAnalysis] = React.useState(null);
      // 对话记录：按天分组的清单 + 点开的那一天
      const [conversations, setConversations] = React.useState(null);
      const [thread, setThread] = React.useState(null);

      const bump = React.useCallback(() => setRefreshKey((n) => n + 1), []);

      async function openThread(row) {
        setError('');
        try {
          const data = await api(
            `/conversation?day=${encodeURIComponent(row.day)}&chatId=${encodeURIComponent(row.chatId)}`,
          );
          setThread(data);
        } catch (err) {
          setError(`${t('convFailed')}：${err.message || err}`);
        }
      }

      // 每块数据各自 try：统计挂了不该把任务清单也一起打空
      React.useEffect(() => {
        let alive = true;
        let timer = null;

        async function pull() {
          const fail = (label) => (err) => {
            if (alive) setError(`${label}：${err.message || err}`);
          };
          await Promise.all([
            api('/overview').then((data) => alive && setOverview(data)).catch(fail(t('loadFailed'))),
            api('/stats').then((data) => alive && setStats(data)).catch(fail(t('loadFailed'))),
            api(`/items?status=${encodeURIComponent(filter)}${query ? `&query=${encodeURIComponent(query)}` : ''}`)
              .then((data) => alive && setTasks(data))
              .catch(fail(t('tasksFailed'))),
            api('/assignments?status=all')
              .then((data) => alive && setAssignments(data))
              .catch(() => {}),
            api('/people?limit=40')
              .then((data) => alive && setPeople(data))
              .catch(() => {}),
            api('/conversations?limit=20')
              .then((data) => alive && setConversations(data))
              .catch(() => {}),
            api('/analysis')
              .then((data) => alive && setAnalysis(data))
              .catch(() => {}),
          ]);
        }

        void pull();
        timer = setInterval(pull, 15000);
        return () => {
          alive = false;
          if (timer) clearInterval(timer);
        };
      }, [api, t, filter, query, refreshKey]);

      React.useEffect(() => {
        let alive = true;
        api('/kb')
          .then((data) => alive && setKb(data))
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [api, refreshKey]);

      const layout = props.getLayout ? props.getLayout() : null;
      const counts = stats?.counts ?? overview?.counts ?? {};
      const settings = overview?.settings ?? {};
      const items = tasks?.items ?? [];
      const priorityTotal = (stats?.byPriority?.high ?? 0) + (stats?.byPriority?.normal ?? 0)
        + (stats?.byPriority?.low ?? 0);

      function backToChat() {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null);
      }

      function toggleItem(item) {
        if (expandedId === item.id) {
          setExpandedId('');
          setDraft(null);
          return;
        }
        setExpandedId(item.id);
        setDraft({
          title: item.title ?? '',
          priority: item.priority ?? 'normal',
          dueAt: toDueInput(item.dueAt),
          tags: (item.tags ?? []).join(', '),
        });
      }

      async function patchItem(body) {
        setBusy(body.id);
        setError('');
        try {
          await api('/item', { method: 'POST', body: JSON.stringify(body) });
          setNotice(t('itemSaved'));
          bump();
        } catch (err) {
          setError(`${t('itemFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      async function saveDraft(item) {
        if (!draft) return;
        await patchItem({
          id: item.id,
          title: draft.title,
          priority: draft.priority,
          dueAt: draft.dueAt,
          tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        });
      }

      function setDraftField(key, value) {
        setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
      }

      function applySearch() {
        setQuery(queryBox.trim());
      }

      // 副手的三件事：派一个、补一句话、停掉。都走同一个 POST /assignment。
      async function actOnAssignment(body) {
        setBusy(body.action === 'create' ? 'assign:create' : `assign:${body.id}`);
        setError('');
        try {
          const result = await api('/assignment', { method: 'POST', body: JSON.stringify(body) });
          // 三种动作三种回执。原来 stop 也回「发消息」，点停止看到「发消息」会以为点错了。
          if (body.action === 'create') {
            setNotice(t('asgCreate'));
          } else if (body.action === 'stop') {
            // 后端会区分「真释放了」和「会话是别人开着的、只叫停」，
            // 面板得照着说，否则用户会去会话列表里找一个其实还在的会话
            setNotice(result && result.sessionActive && result.released === false ? t('asgStopKept') : t('asgStopDone'));
          } else {
            setNotice(t('asgSend'));
          }
          bump();
        } catch (err) {
          setError(`${t('asgFailed')}：${err.message || err}`);
        } finally {
          setBusy('');
        }
      }

      async function createAssignment() {
        const purpose = assignDraft.trim();
        if (!purpose) return;
        await actOnAssignment({ action: 'create', purpose });
        setAssignDraft('');
      }

      async function sendAssignment(id) {
        const message = assignDraft.trim();
        if (!message) return;
        await actOnAssignment({ action: 'send', id, message });
        setAssignDraft('');
        setAssignTarget('');
      }

      const workspace = props.getWorkspace ? props.getWorkspace() : null;
      const workspaceReady = Boolean(workspace && typeof workspace.openSession === 'function');

      function openAssignment(sessionId) {
        if (!workspaceReady) return;
        try {
          workspace.openSession(sessionId);
        } catch (err) {
          setError(`${t('asgFailed')}：${err.message || err}`);
        }
      }

      const assignStatusText = {
        idle: t('asgStatusIdle'),
        running: t('asgStatusRunning'),
        waiting: t('asgStatusWaiting'),
        done: t('asgStatusDone'),
        stopped: t('asgStatusStopped'),
        offline: t('asgStatusOffline'),
      };

      const filterTabs = [
        ['open', t('filterOpen')],
        ['doing', t('filterDoing')],
        ['done', t('filterDone')],
        ['all', t('filterAll')],
      ];

      return h(
        'div',
        { className: 'wa-page', 'data-dsh-workassistant-view': '' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'wa-page-head' },
          h('div', null,
            h('h2', null, t('panelTitle')),
            h('p', null, t('panelSubtitle'))),
          h('span', { className: 'wa-spacer' }),
          h('button', { className: 'wa-btn', onClick: bump, type: 'button' }, t('refresh')),
          layout
            ? h('button', { className: 'wa-btn', onClick: backToChat, type: 'button' }, t('backToChat'))
            : null,
        ),
        h(
          'div',
          { className: 'wa-page-body' },
          error ? h('div', { className: 'wa-msg err' }, error) : null,
          notice ? h('div', { className: 'wa-msg ok' }, notice) : null,

          // 六个数字
          h(
            'div',
            { className: 'wa-grid' },
            h(Metric, { label: t('statOpen'), value: counts.open }),
            h(Metric, { label: t('statOverdue'), value: counts.overdue, alert: (counts.overdue ?? 0) > 0 }),
            h(Metric, { label: t('statDoing'), value: counts.doing }),
            h(Metric, { label: t('statDoneWeek'), value: counts.doneWeek }),
            h(Metric, { label: t('statCreatedWeek'), value: counts.createdWeek }),
            h(Metric, { label: t('statStale'), value: counts.stale }),
          ),

          // 图表
          h(
            'div',
            { className: 'wa-charts' },
            h(
              'div',
              { className: 'wa-chart' },
              h('h4', null, t('chartPriority')),
              priorityTotal === 0
                ? h('div', { className: 'wa-empty' }, t('chartEmpty'))
                : h(
                  'div',
                  { className: 'wa-donut-wrap' },
                  h(Donut, {
                    total: priorityTotal,
                    slices: [
                      { value: stats?.byPriority?.high ?? 0, color: PRIORITY_COLOR.high },
                      { value: stats?.byPriority?.normal ?? 0, color: PRIORITY_COLOR.normal },
                      { value: stats?.byPriority?.low ?? 0, color: PRIORITY_COLOR.low },
                    ],
                  }),
                  h(
                    'div',
                    { className: 'wa-legend' },
                    h('div', null,
                      h('i', { className: 'wa-swatch', style: { background: PRIORITY_COLOR.high } }),
                      `${t('legendHigh')} ${stats?.byPriority?.high ?? 0}`),
                    h('div', null,
                      h('i', { className: 'wa-swatch', style: { background: PRIORITY_COLOR.normal } }),
                      `${t('legendNormal')} ${stats?.byPriority?.normal ?? 0}`),
                    h('div', null,
                      h('i', { className: 'wa-swatch', style: { background: PRIORITY_COLOR.low } }),
                      `${t('legendLow')} ${stats?.byPriority?.low ?? 0}`),
                  ),
                ),
            ),
            h(
              'div',
              { className: 'wa-chart' },
              h('h4', null, t('chartTrend')),
              h(TrendChart, {
                trend: stats?.trend ?? [],
                emptyLabel: t('chartEmpty'),
                createdLabel: t('trendCreated'),
                doneLabel: t('trendDone'),
              }),
            ),
            h(
              'div',
              { className: 'wa-chart' },
              h('h4', null, t('chartTags')),
              h(BarList, {
                rows: (stats?.byTag ?? []).map((row) => ({ label: row.tag, count: row.count })),
                emptyLabel: t('chartEmpty'),
              }),
            ),
            h(
              'div',
              { className: 'wa-chart' },
              h('h4', null, t('chartAssignee')),
              h(BarList, {
                rows: (stats?.assignees ?? []).map((row) => ({ label: row.name, count: row.count })),
                emptyLabel: t('chartEmpty'),
              }),
            ),
            h(
              'div',
              { className: 'wa-chart' },
              h('h4', null, t('chartOldest')),
              (stats?.oldest ?? []).length === 0
                ? h('div', { className: 'wa-empty' }, t('chartEmpty'))
                : h(
                  'div',
                  null,
                  ...(stats?.oldest ?? []).map((row) =>
                    h('div', { className: 'wa-bar-row', key: row.id },
                      h('span', { title: row.title }, row.title),
                      h('span', { className: 'wa-bar-track' },
                        h('span', {
                          className: 'wa-bar-fill',
                          style: { width: `${Math.min(100, (row.ageDays / 30) * 100)}%`, background: PRIORITY_COLOR[row.priority] ?? PRIORITY_COLOR.normal },
                        })),
                      h('span', { className: 'wa-bar-num' }, `${row.ageDays}${t('ageDays')}`))),
                ),
            ),
          ),

          // 对话记录
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('convTitle')),
            h('p', { className: 'wa-sub' }, t('convHint')),
            !conversations || (conversations.threads ?? []).length === 0
              ? h('div', { className: 'wa-empty' }, t('convEmpty'))
              : thread
                ? h(
                    'div',
                    { className: 'wa-conv' },
                    h(
                      'button',
                      { className: 'wa-conv-row', type: 'button', 'data-day': thread.day ?? '', onClick: () => setThread(null) },
                      h('span', { className: 'wa-conv-day' }, dayLabelOf(thread.day)),
                      h('span', { className: 'wa-conv-name' }, `${thread.total ?? 0} ${t('convCountUnit')}`),
                      h('span', { className: 'wa-conv-time' }, t('convBack')),
                    ),
                    ...(thread.messages ?? []).map((msg, index) => {
                      const mine = msg.role !== 'assistant';
                      const role = mine ? t('convRoleUser') : t('convRoleAssistant');
                      return h(
                        'div',
                        { className: 'wa-conv-msg', key: index, title: role, 'aria-label': role },
                        h('span', { className: 'wa-conv-slot' },
                          h('span', { className: mine ? 'wa-rail-dot me' : 'wa-rail-dot bot' })),
                        h('span', { className: 'wa-conv-name' }, msg.text),
                        h('span', { className: 'wa-conv-time' }, clockOf(msg.at)),
                      );
                    }),
                  )
                : h(
                    'div',
                    { className: 'wa-conv' },
                    ...(conversations.threads ?? []).map((row) =>
                      h(
                        'button',
                        {
                          className: 'wa-conv-row',
                          type: 'button',
                          key: `${row.day}-${row.chatId}`,
                          'data-day': row.day,
                          onClick: () => openThread(row),
                        },
                        h('span', { className: 'wa-conv-day' }, dayLabelOf(row.day)),
                        h('span', { className: 'wa-conv-name' }, row.preview),
                        h('span', { className: 'wa-conv-time' }, `${row.count} ${t('convCountUnit')}`),
                      )),
                  ),
          ),

          // 任务清单
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('taskSection')),
            h(
              'div',
              { className: 'wa-row', style: { marginBottom: '12px' } },
              ...filterTabs.map(([value, label]) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    className: filter === value ? 'wa-tab on' : 'wa-tab',
                    onClick: () => setFilter(value),
                  },
                  label,
                )),
              h('input', {
                className: 'wa-input',
                style: { flex: '1', minWidth: '140px' },
                placeholder: t('searchPlaceholder'),
                value: queryBox,
                onChange: (event) => setQueryBox(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') applySearch();
                },
              }),
              h('button', { className: 'wa-btn', type: 'button', onClick: applySearch }, t('kbSearch')),
            ),
            tasks === null
              ? h('div', { className: 'wa-empty' }, t('loading'))
              : items.length === 0
                ? h('div', { className: 'wa-empty' }, t('noTasks'))
                : h(
                  'div',
                  { className: 'wa-list' },
                  ...items.map((item) =>
                    h(
                      'div',
                      { className: 'wa-item', key: item.id },
                      h(
                        'div',
                        { className: 'wa-item-head' },
                        h('span', { className: 'wa-rank' }, `${item.rank ?? ''}`),
                        h('span', {
                          className: 'wa-pri',
                          style: { color: PRIORITY_COLOR[item.priority] ?? PRIORITY_COLOR.normal },
                        }, item.priority === 'high' ? t('legendHigh')
                          : item.priority === 'low' ? t('legendLow') : t('legendNormal')),
                        h('span', { className: item.status === 'done' ? 'wa-title wa-done' : 'wa-title' }, item.title),
                        item.dueAt ? h('code', null, formatDue(item.dueAt)) : null,
                        item.assignee ? h('code', null, item.assignee) : null,
                        h('button', {
                          className: 'wa-btn wa-mini',
                          type: 'button',
                          disabled: busy === item.id,
                          onClick: () => patchItem({
                            id: item.id,
                            status: item.status === 'done' ? 'open' : 'done',
                          }),
                        }, item.status === 'done' ? t('markOpen') : t('markDone')),
                        h('button', {
                          className: 'wa-btn wa-mini',
                          type: 'button',
                          disabled: busy === item.id,
                          onClick: () => patchItem({ id: item.id, snoozeMinutes: 60 }),
                        }, t('snoozeHour')),
                        h('button', {
                          className: 'wa-btn wa-mini',
                          type: 'button',
                          disabled: busy === item.id,
                          onClick: () => patchItem({ id: item.id, snoozeMinutes: 1440 }),
                        }, t('snoozeDay')),
                        h('button', {
                          className: 'wa-btn wa-mini',
                          type: 'button',
                          onClick: () => toggleItem(item),
                        }, expandedId === item.id ? t('collapse') : t('expand')),
                      ),
                      expandedId === item.id && draft
                        ? h(
                          'div',
                          { className: 'wa-item-body' },
                          h('div', { className: 'wa-field' },
                            h('label', null, t('editTitle')),
                            h('input', {
                              className: 'wa-input',
                              value: draft.title,
                              onChange: (event) => setDraftField('title', event.target.value),
                            })),
                          h('div', { className: 'wa-field' },
                            h('label', null, t('editPriority')),
                            h(
                              'select',
                              {
                                className: 'wa-select',
                                value: draft.priority,
                                onChange: (event) => setDraftField('priority', event.target.value),
                              },
                              h('option', { value: 'high' }, t('legendHigh')),
                              h('option', { value: 'normal' }, t('legendNormal')),
                              h('option', { value: 'low' }, t('legendLow')),
                            )),
                          h('div', { className: 'wa-field' },
                            h('label', null, t('editDue')),
                            h('input', {
                              className: 'wa-input',
                              placeholder: '2026-10-24 18:00',
                              value: draft.dueAt,
                              onChange: (event) => setDraftField('dueAt', event.target.value),
                            }),
                            h('small', null, t('editDueHint'))),
                          h('div', { className: 'wa-field' },
                            h('label', null, t('editTags')),
                            h('input', {
                              className: 'wa-input',
                              value: draft.tags,
                              onChange: (event) => setDraftField('tags', event.target.value),
                            }),
                            h('small', null, t('editTagsHint'))),
                          h('div', { className: 'wa-row' },
                            h('button', {
                              className: 'wa-btn primary',
                              type: 'button',
                              disabled: busy === item.id,
                              onClick: () => saveDraft(item),
                            }, busy === item.id ? t('savingItem') : t('saveItem')),
                            h('code', null, item.id),
                            item.recurrence ? h('code', null, item.recurrence) : null),
                        )
                        : null,
                    ),
                  ),
                ),
          ),

          // 副手（分派出去干活的独立会话）
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('asgTitle')),
            h('p', { className: 'wa-sub' }, t('asgHint')),
            assignments === null
              ? h('div', { className: 'wa-empty' }, t('loading'))
              : (assignments.items ?? []).length === 0
                ? h('div', { className: 'wa-empty' }, t('asgEmpty'))
                : h(
                  'div',
                  { className: 'wa-list' },
                  ...(assignments.items ?? []).map((row) =>
                    h(
                      'div',
                      { className: 'wa-asg', key: row.id },
                      h(
                        'div',
                        { className: 'wa-asg-head' },
                        h('code', null, row.id),
                        row.status === 'waiting'
                          ? h('span', { className: 'wa-flag' }, assignStatusText[row.status] ?? row.status)
                          : h('span', { className: 'wa-pri' }, assignStatusText[row.status] ?? row.status),
                        h('span', { className: 'wa-title' }, row.purpose),
                        row.itemId ? h('code', null, row.itemId) : null,
                      ),
                      row.report && row.report.summary
                        ? h('div', { className: 'wa-asg-report' },
                          `${t('asgReport')}：${row.report.summary}`)
                        : null,
                      h(
                        'div',
                        { className: 'wa-asg-actions' },
                        // 停掉是终态，再发消息后端会直接拒；按钮留在那儿只会让人白点
                        row.status === 'stopped'
                          ? null
                          : h('button', {
                            className: 'wa-btn wa-mini',
                            type: 'button',
                            onClick: () => setAssignTarget(assignTarget === row.id ? '' : row.id),
                          }, t('asgSend')),
                        !row.sessionId
                          ? h('code', null, t('asgNoSession'))
                          : workspaceReady
                            ? h('button', {
                              className: 'wa-btn wa-mini',
                              type: 'button',
                              onClick: () => openAssignment(row.sessionId),
                            }, t('asgOpen'))
                            : h('code', null, row.sessionId),
                        row.status === 'stopped'
                          ? null
                          : h('button', {
                            className: 'wa-btn wa-mini',
                            type: 'button',
                            disabled: busy === `assign:${row.id}`,
                            onClick: () => actOnAssignment({ action: 'stop', id: row.id }),
                          }, t('asgStop')),
                      ),
                      assignTarget === row.id
                        ? h('div', { className: 'wa-row' },
                          h('input', {
                            className: 'wa-input',
                            placeholder: t('asgSendHint'),
                            value: assignDraft,
                            onChange: (event) => setAssignDraft(event.target.value),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') void sendAssignment(row.id);
                            },
                          }),
                          h('button', {
                            className: 'wa-btn primary',
                            type: 'button',
                            disabled: busy === `assign:${row.id}`,
                            onClick: () => void sendAssignment(row.id),
                          }, busy === `assign:${row.id}` ? t('asgSending') : t('asgSend')))
                        : null,
                    ),
                  ),
                ),
            h('div', { className: 'wa-row', style: { marginTop: '10px' } },
              h('input', {
                className: 'wa-input',
                placeholder: t('asgPurposeHint'),
                value: assignTarget ? '' : assignDraft,
                onChange: (event) => {
                  setAssignTarget('');
                  setAssignDraft(event.target.value);
                },
              }),
              h('button', {
                className: 'wa-btn primary',
                type: 'button',
                disabled: busy === 'assign:create' || !assignDraft.trim(),
                onClick: () => void createAssignment(),
              }, busy === 'assign:create' ? t('asgCreating') : t('asgCreate'))),
          ),

          // 知识库
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('kbTitle')),
            kbDoc
              ? h(
                'div',
                null,
                h('div', { className: 'wa-row', style: { marginBottom: '8px' } },
                  h('strong', null, kbDoc.title),
                  h('button', {
                    className: 'wa-btn wa-mini',
                    type: 'button',
                    onClick: () => setKbDoc(null),
                  }, t('kbBack'))),
                h('pre', { className: 'wa-doc' }, kbDoc.content ?? ''),
              )
              : kb === null
                ? h('div', { className: 'wa-empty' }, t('loading'))
                : (kb.docs ?? []).length === 0
                  ? h('div', { className: 'wa-empty' }, t('kbEmpty'))
                  : h(
                    'ul',
                    { className: 'wa-list' },
                    ...(kb.docs ?? []).map((doc) =>
                      h('li', { key: doc.id },
                        h('code', null, doc.id),
                        h('button', {
                          className: 'wa-btn wa-mini',
                          type: 'button',
                          style: { border: 'none', background: 'none', padding: 0, textAlign: 'left' },
                          onClick: () => {
                            api(`/kb/doc?id=${encodeURIComponent(doc.id)}`)
                              .then((data) => setKbDoc(data.doc))
                              .catch((err) => setError(`${t('loadFailed')}：${err.message || err}`));
                          },
                        }, doc.title),
                        h('span', { className: 'wa-bar-num' }, t('kbReadMore')))),
                  ),
          ),

          // 认识的人 + 知识库分析
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('peopleTitle')),
            personDoc
              ? h(
                'div',
                null,
                h('div', { className: 'wa-row', style: { marginBottom: '8px' } },
                  h('strong', null, personDoc.name),
                  h('button', {
                    className: 'wa-btn wa-mini',
                    type: 'button',
                    onClick: () => setPersonDoc(null),
                  }, t('personBack'))),
                personDoc.note ? h('p', { className: 'wa-sub' }, personDoc.note) : null,
                (personDoc.relations ?? []).length === 0
                  ? h('div', { className: 'wa-empty' }, t('personNone'))
                  : h(
                    'ul',
                    { className: 'wa-list' },
                    ...(personDoc.relations ?? []).map((relation, index) =>
                      h('li', { key: `${relation.type}-${index}` },
                        h('span', { className: 'wa-pri' }, relation.label),
                        h('span', null, relation.direction === 'out' ? `→ ${relation.other.name}` : `← ${relation.other.name}`),
                        relation.evidence ? h('span', { className: 'wa-sub' }, ` ${relation.evidence}`) : null)),
                  ),
              )
              : people === null
                ? h('div', { className: 'wa-empty' }, t('loading'))
                : (people.people ?? []).length === 0
                  ? h('div', { className: 'wa-empty' }, t('peopleEmpty'))
                  : h(
                    'div',
                    null,
                    h('p', { className: 'wa-sub' }, t('peopleHint')),
                    h('ul', { className: 'wa-list' },
                      ...(people.people ?? []).slice(0, 12).map((person) =>
                        h('li', { key: person.id },
                          h('button', {
                            className: 'wa-btn wa-mini',
                            type: 'button',
                            style: { border: 'none', background: 'none', padding: 0, textAlign: 'left' },
                            onClick: () => {
                              api(`/person?name=${encodeURIComponent(person.name)}`)
                                .then((data) => setPersonDoc(data.person))
                                .catch((err) => setError(`${t('peopleFailed')}：${err.message || err}`));
                            },
                          }, person.name),
                          h('span', { className: 'wa-bar-num' }, `${person.relations ?? 0}`)))),
                  ),
            h('div', { className: 'wa-row', style: { marginTop: '10px' } },
              h('h4', { style: { margin: 0 } }, t('analysisTitle')),
              h('button', {
                className: 'wa-btn wa-mini',
                type: 'button',
                disabled: busy === 'analysis',
                onClick: () => {
                  setBusy('analysis');
                  setNotice('');
                  api('/analysis', { method: 'POST' })
                    .then((data) => {
                      if (data && data.ok === false) {
                        setError(`${t('analysisFailed')}：${data.result?.reason ?? ''}`);
                        return;
                      }
                      // 后端开跑就回包了，这里说「正在整理」比说「知识库分析」实在
                      setNotice(data && data.started ? t('analysisRunning') : t('analysisTitle'));
                      bump();
                    })
                    .catch((err) => setError(`${t('analysisFailed')}：${err.message || err}`))
                    .finally(() => setBusy(''));
                },
              }, busy === 'analysis' ? t('analysisRunning') : t('analysisRun'))),
            h('p', { className: 'wa-sub' }, t('analysisHint')),
            h('div', { className: 'wa-kv' },
              h('div', null, t('analysisTitle')),
              h('div', null, analysis?.lastRun
                ? analysis.lastRun.status === 'failed'
                  ? t('analysisFailed')
                  : `${analysis.lastRun.entities ?? 0} ${t('analysisFound')}`
                : t('analysisNever')),
              h('div', null, t('analysisPending')),
              h('div', null, `${analysis?.pending ?? 0}`)),
          ),

          // 只读运行参数，改还是去设置页
          h(
            'div',
            { className: 'wa-chart' },
            h('h4', null, t('settingsSummary')),
            h('div', { className: 'wa-kv' },
              h('div', null, t('dataDir')),
              h('div', null, settings.stateDir ?? ''),
              h('div', null, t('preset')),
              h('div', null, settings.agentPreset || t('sessionFollowHost')),
              h('div', null, t('permission')),
              h('div', null, settings.permissionPreset ?? '')),
            h('p', { className: 'wa-sub', style: { marginTop: '10px' } }, t('settingsHint')),
          ),
        ),
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      localeFace = ctx.locale;
      appCtx = ctx;
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-assistant: 文案');
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'work-assistant',
            order: 45,
            label: () => t('title'),
            locale: NS,
          },
          WorkAssistantSettings,
        ),
      );

      // 侧边栏图标和整页面板成对注册：嵌套 inject 保证宿主只声明了其中一个时
      // 两个都不注册（否则会出现「有图标但点不开」或者「页面在但没入口」）。
      // 顺序是先 main 后 sidebar：宿主的 selectPanel 会先查 main 有没有这个 key。
      ctx.slots.inject('main', () =>
        ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              // 用 ctx.get 而不是 ctx.layout：没声明 inject 时访问属性会抛
              // cannot get property "layout" without inject，get 只会返回 undefined。
              // 也因此不用把 layout 加进模块级 inject 列表。
              inject: () => ({
                getLayout: () => ctx.get('layout') ?? null,
                // 副手在独立会话里，想「去看」得借 ui-workspace 的导航能力；
                // 拿不到就退化成显示 sessionId，至少能自己去列表里找。
                getWorkspace: () => ctx.get('uiWorkspace') ?? null,
              }),
            },
            WorkAssistantPanel,
          );
          const stopIcon = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => t('panelTitle'),
              locale: NS,
            },
            WorkAssistantIcon,
          );
          return () => {
            stopMain();
            stopIcon();
          };
        }),
      );

      // 侧栏「对话」页签。宿主自己没有这个座位，页签表是 im 助理插件包
      // sidebar.workspaces 时挂上去的，所以这里只能等它挂好再去插。
      // 三种时机都试：注册完立刻、插槽变化时、以及它广播的 window 事件。
      let stopRail = null;
      let railRegistry = null;

      function currentRegistry() {
        let entries = [];
        try {
          const read = ctx.slots.entriesOfSlot || ctx.slots.entries;
          entries = typeof read === 'function' ? read.call(ctx.slots, 'sidebar.workspaces') : [];
        } catch {
          return null;
        }
        const occupant = (entries || []).find((item) => item && item.component);
        return findNativeTabRegistry(occupant);
      }

      function syncRail() {
        // 每次都重新读一遍：对方可能整层重包、换了个新的注册表对象，
        // 只认缓存的旧对象就会一直往一张已经没人看的表里插。
        const registry = currentRegistry();
        if (!registry) return;
        if (registry.getTabs().some((tab) => tab.id === RAIL_ID)) {
          railRegistry = registry;
          return;
        }
        if (stopRail && railRegistry && railRegistry !== registry) {
          try {
            stopRail();
          } catch {
            /* 旧表可能已经没了，忽略 */
          }
          stopRail = null;
        }
        railRegistry = registry;
        stopRail = registry.insert({
          id: RAIL_ID,
          label: t('railTab'),
          order: 45,
          matchSession: isAssistantSession,
          render: (props) =>
            h(ConversationRailBoundary, null, h(ConversationRail, Object.assign({}, props))),
        });
      }

      ctx.effect(() => {
        syncRail();
        const cleanups = [];
        try {
          if (typeof ctx.slots.subscribe === 'function') {
            cleanups.push(ctx.slots.subscribe('sidebar.workspaces', syncRail));
            cleanups.push(ctx.slots.subscribe('sidebar', syncRail));
          }
        } catch {
          /* 宿主没有订阅能力就只靠下面的重试 */
        }
        // im 助理包好那层之后会广播这个事件，比轮询快
        const onSidebarChange = () => syncRail();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('dsh-native-sidebar-change', onSidebarChange);
          cleanups.push(() => window.removeEventListener('dsh-native-sidebar-change', onSidebarChange));
        }
        // 启动顺序不保证：页签表可能比我们晚挂几秒，头几秒多试几次，之后不再轮询
        let tries = 0;
        const timer = setInterval(() => {
          syncRail();
          tries += 1;
          if (tries >= 20) clearInterval(timer);
        }, 250);
        cleanups.push(() => clearInterval(timer));
        return () => {
          for (const dispose of cleanups) {
            try {
              dispose?.();
            } catch {
              /* 忽略 */
            }
          }
          if (stopRail) {
            try {
              stopRail();
            } catch {
              /* 忽略 */
            }
            stopRail = null;
          }
          railRegistry = null;
        };
      }, 'work-assistant: 侧栏对话页签');
    }

    return { apply, inject };
  },
});
