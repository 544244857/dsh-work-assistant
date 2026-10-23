// 插件提示词只讲工具怎么用，不定义人格。
// 以前这里塞了一套「你现在是工作助理，对方叫用户，短句分点」，
// 结果按会话挂的人格预设被压住：自称、渠道、说话方式全说错，
// 用户听着像换了一个人。这个插件会装到别人机器上，他们挂的预设才是「他是谁」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promptName, promptSection } from '../lib/prompt.js';

test('提示词把人格让给会话预设，自己不规定身份和称呼', () => {
  const text = promptSection();
  assert.match(text, /人格设定为准/);
  // 不许再规定对方叫什么。叫「用户」是某一套人格的说法，不是插件的职责
  assert.doesNotMatch(text, /用户/);
  assert.doesNotMatch(text, /你现在是/, '不要给会话指派身份');
});

test('提示词仍然把工具约定讲清楚：记账、指派、派副手、发文件', () => {
  const text = promptSection();
  for (const tool of ['work_capture', 'work_list', 'work_update', 'work_assign', 'assign_create', 'work_send_file', 'work_people', 'work_person']) {
    assert.match(text, new RegExp(tool), `少了 ${tool} 的用法`);
  }
  assert.match(text, /文件发成功之前，不许说/);
  assert.match(text, /不用 emoji/);
  assert.equal(promptName(), 'work-assistant');
});

test('渠道说法能传进去，不写死微信', () => {
  assert.match(promptSection({ channelNote: 'QQ 私聊' }), /QQ 私聊/);
  // 不传也要有个合理的默认，别渲染出 undefined
  assert.doesNotMatch(promptSection(), /undefined/);
});
