import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [source, aiSource, indexSource, cssSource] = await Promise.all([
  readFile(new URL('../js/markdown.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ai.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../css/mobile-app.css', import.meta.url), 'utf8'),
]);
const context = vm.createContext({ URL, console });
vm.runInContext(source, context, { filename: 'js/markdown.js' });
const markdown = context.SafeMarkdown;

assert.equal(markdown.VERSION, '1.0.0');

const formatted = markdown.render([
  '# 办理结论',
  '',
  '**报名窗口已结束**，请查看 `教务处通知`。',
  '',
  '- 准备申请表',
  '- 准备证明材料',
  '',
  '1. 学院审核',
  '2. 参加考核',
  '',
  '> 办理前请核对最新通知。',
  '',
  '[查看官方通知](https://jwc.sdtbu.edu.cn/info/1887/10453.htm)',
  '',
  '---',
].join('\n'));
assert.match(formatted, /<h2>办理结论<\/h2>/);
assert.match(formatted, /<strong>报名窗口已结束<\/strong>/);
assert.match(formatted, /<code>教务处通知<\/code>/);
assert.match(formatted, /<ul><li>准备申请表<\/li><li>准备证明材料<\/li><\/ul>/);
assert.match(formatted, /<ol><li>学院审核<\/li><li>参加考核<\/li><\/ol>/);
assert.match(formatted, /<blockquote><p>办理前请核对最新通知。<\/p><\/blockquote>/);
assert.match(formatted, /href="https:\/\/jwc\.sdtbu\.edu\.cn\/info\/1887\/10453\.htm"/);
assert.match(formatted, /target="_blank" rel="noopener noreferrer"/);
assert.match(formatted, /<hr>/);
assert.doesNotMatch(formatted, /\*\*|^#\s/m);

const malicious = markdown.render([
  '<script>globalThis.pwned = true</script>',
  '<img src=x onerror="globalThis.pwned=true">',
  '[脚本链接](javascript:alert(1))',
  '[编码脚本](java&#x73;cript:alert(1))',
  '[数据链接](data:text/html,boom)',
  '[安全链接](https://example.com/path?q=1)',
].join('\n'));
assert.doesNotMatch(malicious, /<script|<img|href="javascript:|href="data:/i);
assert.doesNotMatch(malicious, /globalThis\.pwned|onerror/i);
assert.match(malicious, /href="https:\/\/example\.com\/path\?q=1"/);
assert.equal(context.pwned, undefined);

const sanitized = markdown.sanitizeHtml('<p onclick="bad()">正文<script>恶意内容</script><a href="javascript:bad()" onmouseover="bad()">危险链接</a><a href="https://example.com" style="color:red">安全链接</a></p>');
assert.doesNotMatch(sanitized, /onclick|onmouseover|style=|script|恶意内容|javascript:/i);
assert.match(sanitized, /<p>正文/);
assert.match(sanitized, /href="https:\/\/example\.com\/" target="_blank" rel="noopener noreferrer"/);

const malformed = markdown.render('## 未闭合格式\n\n**仍应可读\n\n`代码也未闭合');
assert.match(malformed, /未闭合格式/);
assert.match(malformed, /仍应可读/);
assert.match(malformed, /代码也未闭合/);
assert.doesNotMatch(malformed, /<script|onerror=/i);

const longList = markdown.render(Array.from({ length: 80 }, (_, index) => `- 第 ${index + 1} 项`).join('\n'));
assert.equal((longList.match(/<li>/g) || []).length, 80);

const plain = markdown.toPlainText('### 条件\n\n**已注册学籍**\n\n- 未受处分\n- 综合测评合格\n\n[查看通知](https://example.com) 和 `申请表`');
assert.equal(plain, '条件\n\n已注册学籍\n\n• 未受处分\n• 综合测评合格\n\n查看通知 和 申请表');
assert.doesNotMatch(plain, /<[^>]+>|\*\*|###|https:\/\//);
const maliciousPlain = markdown.toPlainText('正文<img src=x onerror="bad()"><script>恶意内容</script>结尾');
assert.equal(maliciousPlain, '正文结尾');

assert.ok(indexSource.indexOf('js/markdown.js?v=20260919-1') < indexSource.indexOf('js/ai.js?v=20260919-1'));
assert.match(aiSource, /SafeMarkdown\?\.render\(answer\)/);
assert.match(aiSource, /SafeMarkdown\?\.toPlainText\(answer\)/);
for (const selector of ['.ai-markdown p', '.ai-markdown ul', '.ai-markdown blockquote', '.ai-markdown code', '.ai-markdown a']) {
  assert.ok(cssSource.includes(selector), `缺少 Markdown 样式：${selector}`);
}

console.log('PASS M5 安全 Markdown：格式、白名单清理、危险协议、残缺格式、长列表和纯文本复制均正常。');
