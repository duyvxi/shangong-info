import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [source, apiSource, aiSource, indexSource] = await Promise.all([
  readFile(new URL('../js/ai-conversation.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/api.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ai.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);
const context = vm.createContext({});
context.globalThis = context;
vm.runInContext(source, context);
const conversation = context.AIConversation;

const session = conversation.createSession(2);
session.add('第一问', '第一答');
session.add('第二问', '第二答');
session.add('第三问', '第三答');
assert.deepEqual(JSON.parse(JSON.stringify(session.getContext())), [
  { question: '第二问', answer: '第二答' },
  { question: '第三问', answer: '第三答' },
]);
const copy = session.getContext();
copy[0].question = '篡改';
assert.equal(session.getContext()[0].question, '第二问');
session.clear();
assert.equal(session.getContext().length, 0);

const administrative = conversation.buildFollowUps('转专业什么时候申请？', ['时间']);
assert.equal(administrative.length, 3);
assert.ok(administrative.every((item) => item.label && item.question));
assert.ok(!administrative.some((item) => item.label === '查看时间安排'));
assert.deepEqual(
  JSON.parse(JSON.stringify(conversation.buildFollowUps('东校区有哪些公交车？', []))).map((item) => item.label),
  ['查看途经站点', '查看乘车位置', '查看运营时间'],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(conversation.buildFollowUps('宿舍能用什么电器？', []))).map((item) => item.label),
  ['查看禁止事项', '查看违规后果', '查看住宿要求'],
);
assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
assert.match(apiSource, /context: Array\.isArray\(options\.context\) \? options\.context : \[\]/);
assert.match(aiSource, /AIConversation\?\.createSession\(2\)/);
assert.match(aiSource, /data-follow-up/);
assert.ok(indexSource.indexOf('js/ai-conversation.js?v=20260920-1') < indexSource.indexOf('js/ai.js?v=20260922-1'));

console.log('PASS M7 页面内存：仅保留最近两轮，跟进按钮按问题类型生成，未使用浏览器存储。');
