import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { runBenchmark, summarize } from './benchmark_campus_ai.mjs';

const source = await readFile(new URL('../js/ai-stream.js', import.meta.url), 'utf8');
const context = vm.createContext({ TextDecoder, console });
context.globalThis = context;
vm.runInContext(source, context);
const stream = context.AIStream;
assert.equal(stream.VERSION, '1.0.0');

const parsed = [];
const parser = stream.createParser((event) => parsed.push(JSON.parse(JSON.stringify(event))));
parser.push('event: meta\r\ndata: {"remaining":9}\r\n\r');
parser.push('\nevent: delta\ndata: {"text":"第一');
parser.push('段"}\n\nevent: done\ndata: {"timing":{"total":120}}\n\n');
parser.finish();
assert.deepEqual(parsed.map((entry) => entry.event), ['meta', 'delta', 'done']);
assert.equal(parsed[1].data.text, '第一段');

function responseFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

const deltas = [];
const completed = await stream.consumeResponse(responseFromChunks([
  'event: meta\ndata: {"sources":[{"slug":"one"}],"remaining":8}\n\n',
  'event: delta\ndata: {"text":"## 结论\\n"}\n\nevent: del',
  'ta\ndata: {"text":"可以办理。[1]"}\n\n',
  'event: done\ndata: {"answer":"## 结论\\n可以办理。[1]","timing":{"model":90,"total":120}}\n\n',
]), { onDelta: (delta) => deltas.push(delta) });
assert.deepEqual(deltas, ['## 结论\n', '可以办理。[1]']);
assert.equal(completed.answer, '## 结论\n可以办理。[1]');
assert.equal(completed.sources[0].slug, 'one');
assert.equal(completed.timing.total, 120);

let benchmarkRequest;
const benchmarkSamples = await runBenchmark({
  endpoint: 'https://mock.invalid/functions/v1/campus-ai',
  key: 'public-test-key',
  clientId: 'stream-test-client',
  repeats: 1,
  questionSet: ['宿舍可以使用哪些电器'],
  stream: true,
  fetchImpl: async (_url, init) => {
    benchmarkRequest = JSON.parse(init.body);
    return responseFromChunks([
      'event: meta\ndata: {"sources":[{"slug":"dorm"}],"remaining":7}\n\n',
      'event: delta\ndata: {"text":"可以参考资料。[1]"}\n\n',
      'event: done\ndata: {"answer":"可以参考资料。[1]","timing":{"model":80,"total":100}}\n\n',
    ]);
  },
});
assert.equal(benchmarkRequest.stream, true);
assert.equal(benchmarkSamples[0].outcome, 'ok');
assert.ok(Number.isFinite(benchmarkSamples[0].first_text_ms));
assert.equal(benchmarkSamples[0].source_count, 1);
assert.equal(benchmarkSamples[0].server.total, 100);
assert.equal(summarize(benchmarkSamples).interruption_rate, 0);

await assert.rejects(
  stream.consumeResponse(responseFromChunks([
    'event: meta\ndata: {}\n\n',
    'event: delta\ndata: {"text":"已经显示"}\n\n',
    'event: error\ndata: {"error":"回答中断，可重试","code":"MODEL_UPSTREAM"}\n\n',
  ])),
  (error) => error.code === 'MODEL_UPSTREAM' && error.partialAnswer === '已经显示',
);

await assert.rejects(
  stream.consumeResponse(responseFromChunks(['event: delta\ndata: {"text":"未完成"}\n\n'])),
  (error) => error.code === 'STREAM_INCOMPLETE' && error.partialAnswer === '未完成',
);

const [apiSource, aiSource, serverSource] = await Promise.all([
  readFile(new URL('../js/api.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ai.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/campus-ai/index.ts', import.meta.url), 'utf8'),
]);

let fallbackRequest;
const fallbackEvents = [];
const apiWindow = {
  location: { protocol: 'https:', hostname: 'duyvxi.github.io', origin: 'https://duyvxi.github.io' },
  AIStream: { consumeResponse() { throw new Error('JSON 回退不应读取响应流'); } },
};
const apiContext = vm.createContext({
  window: apiWindow,
  navigator: { onLine: true },
  localStorage: { getItem() { return null; }, setItem() {} },
  crypto,
  URL,
  AbortController,
  DOMException,
  setTimeout,
  clearTimeout,
  fetch: async (_url, init) => {
    fallbackRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({ answer: '旧 JSON 回退正常。[1]', sources: [], remaining: 6 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
  console,
});
vm.runInContext(apiSource, apiContext);
apiWindow.Api.getAnonymousId = () => 'stream-test-client';
const fallbackResult = await apiWindow.Api.askCampusAIStream('回退测试', {
  onMeta: () => fallbackEvents.push('meta'),
  onDelta: () => fallbackEvents.push('delta'),
  onDone: () => fallbackEvents.push('done'),
});
assert.equal(fallbackRequest.stream, true);
assert.equal(fallbackResult.answer, '旧 JSON 回退正常。[1]');
assert.deepEqual(fallbackEvents, ['meta', 'delta', 'done']);

assert.match(apiSource, /stream:\s*true/);
assert.match(apiSource, /text\/event-stream/);
assert.match(aiSource, /Math\.max\(0, 80 -/);
assert.match(aiSource, /currentRequestController\?\.abort\(\)/);
assert.match(aiSource, /回答中断/);
assert.match(serverSource, /response\.output_text\.delta/);
assert.match(serverSource, /event: \$\{event\}/);
assert.match(serverSource, /timing:\s*timing\.snapshot\(\)/);

console.log('PASS M6 流式输出：分块解析、逐段累积、完整结束、中断保留和取消请求均正常。');
