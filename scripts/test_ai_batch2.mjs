import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as timing from '../supabase/functions/_shared/timing.js';
import * as historical from '../supabase/functions/_shared/historical.js';
import * as multiIntent from '../supabase/functions/_shared/multi-intent.js';
import * as retrieval from '../supabase/functions/_shared/retrieval.js';
import { loadDocuments } from './benchmark_ai_quality.mjs';

const raw = await readFile(new URL('../supabase/functions/campus-ai/index.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(raw.replace(/^import[\s\S]*?;\r?\n/gm, ''), { mode: 'strip' });
const modelText = '虚构测试回答。';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frame = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`;
const question = '校外住宿需要什么材料？';
const eventNames = (wire) => [...wire.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
const getMeta = (wire) => JSON.parse(wire.match(/^event: meta\ndata: (.+)$/m)[1]);

function fakeModel(style, mode, signal) {
  const responses = style === 'responses';
  const text = frame(responses ? { type: 'response.output_text.delta', delta: modelText }
    : { choices: [{ index: 0, delta: { content: modelText }, finish_reason: null }] });
  const stop = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  const complete = responses ? frame({ type: 'response.completed', response: { status: 'completed' } }) : stop + frame('[DONE]');
  let suffix = '';
  if (mode === 'ok') suffix = complete;
  if (mode === 'bare-done') suffix = frame('[DONE]');
  if (mode === 'bare-stop') suffix = stop;
  if (mode === 'upstream-error') suffix = frame(responses
    ? { type: 'response.failed', response: { status: 'failed' } } : { error: { message: 'fixture failure' } });
  if (mode === 'truncated') suffix = frame(responses
    ? { type: 'response.incomplete', response: { status: 'incomplete' } }
    : { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + frame('[DONE]');
  const stream = new ReadableStream({
    start(controller) {
      const split = text.indexOf('\r') + 1;
      controller.enqueue(encoder.encode(text.slice(0, split)));
      controller.enqueue(encoder.encode(text.slice(split)));
      if (mode === 'cancel') {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } else {
        if (suffix) controller.enqueue(encoder.encode(suffix));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function exercise(db, documents, options) {
  const { style = 'responses', mode = 'ok', cancellation, rejectLog = false } = options;
  const controller = new AbortController();
  const logged = Promise.withResolvers();
  const warnings = [];
  let handler;
  let backgroundTask;
  let modelInput;
  const settings = {
    SUPABASE_URL: 'https://database.invalid', SUPABASE_ANON_KEY: 'fixture-public',
    SUPABASE_SECRET_KEY: 'fixture-server', AI_RATE_LIMIT_SALT: 'fixture-salt',
    AI_API_BASE_URL: 'https://model.invalid', AI_MODEL: 'fixture-model', AI_API_KEY: 'fixture-model-key',
    AI_API_STYLE: style, AI_EMBEDDING_ENABLED: 'true', AI_MODEL_TIMEOUT_MS: '10000',
  };
  const fetch = async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (origin === settings.AI_API_BASE_URL && pathname === '/embeddings') return new Response(null, { status: 503 });
    if (origin === settings.AI_API_BASE_URL && ['/responses', '/chat/completions'].includes(pathname)) {
      modelInput = body.input || body.messages[1].content;
      return fakeModel(style, mode, init.signal);
    }
    assert.equal(origin, settings.SUPABASE_URL);
    if (pathname.endsWith('/consume_ai_quota')) return Response.json([{ allowed: true, remaining: 5 }]);
    if (pathname.endsWith('/knowledge_documents')) return Response.json(documents);
    if (pathname.endsWith('/ai_usage')) {
      if (rejectLog) {
        logged.resolve(null);
        return new Response('fixture database detail', { status: 503 });
      }
      const { rows: [entry] } = await db.query(`insert into public.ai_usage
        (client_hash, provider, model, retrieval_count, input_chars, output_chars, latency_ms, status)
        values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, status, output_chars`, [body.client_hash, body.provider,
        body.model, body.retrieval_count, body.input_chars, body.output_chars, body.latency_ms, body.status]);
      logged.resolve(entry);
      return new Response(null, { status: 201 });
    }
    throw new Error(`意外的测试请求路径 ${pathname}`);
  };
  vm.runInNewContext(source, { ...timing, ...historical, ...multiIntent, ...retrieval,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, ReadableStream, crypto,
    AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, fetch,
    console: { warn: (...args) => warnings.push(args), error() {} },
    EdgeRuntime: { waitUntil(task) { backgroundTask = task; } },
    Deno: { env: { get: (name) => settings[name] }, serve: (action) => { handler = action; } },
  });
  const response = await handler(new Request('https://edge.invalid', { method: 'POST', signal: controller.signal,
    headers: { apikey: 'fixture-public', Origin: 'http://localhost:4173' },
    body: JSON.stringify({ clientId: 'fixture-batch2', question, ...options.body, stream: true }),
  }));
  assert.equal(response.status, 200);
  let wire = '';
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    wire += decoder.decode(value);
    if (cancellation && wire.includes('event: delta')) {
      if (cancellation === 'reader') { await reader.cancel(); break; }
      controller.abort();
    }
  }
  // 显式等待落库，浏览器关闭连接后仍需完成服务端取消记录。
  let watchdog;
  const entry = await Promise.race([logged.promise, new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('AI 用量日志未收到')), 2000);
  })]).finally(() => clearTimeout(watchdog));
  assert.ok(backgroundTask);
  await backgroundTask;
  return { wire, entry, warnings, modelInput };
}

export async function checkAiBatch2(db, page) {
  const documents = (await loadDocuments()).map((doc) => ({ status: 'published', ...doc }));
  const scenarios = {};
  for (const style of ['responses', 'chat_completions']) {
    for (const [mode, status, terminal] of [
      ['ok', 'ok', 'done'], ['disconnect', 'error', 'error'],
      ['upstream-error', 'error', 'error'], ['truncated', 'error', 'error'], ['bare-done', 'error', 'error'],
    ]) {
      const result = await exercise(db, documents, { style, mode });
      assert.deepEqual(eventNames(result.wire), ['meta', 'delta', terminal]);
      assert.equal(result.entry.status, status);
      assert.equal(result.entry.output_chars, modelText.length);
      if (['disconnect', 'truncated', 'bare-done'].includes(mode)) assert.match(result.wire, /MODEL_INCOMPLETE.*|回答中断/);
      if (mode === 'upstream-error') assert.match(result.wire, /MODEL_UPSTREAM/);
      scenarios[mode] = result.wire;
    }
    const cancelled = await exercise(db, documents, { style, mode: 'cancel', cancellation: 'request' });
    assert.deepEqual(eventNames(cancelled.wire), ['meta', 'delta']);
    assert.equal(cancelled.entry.status, 'cancelled');
    assert.equal(cancelled.entry.output_chars, modelText.length);
    scenarios.cancel = cancelled.wire;
  }
  const missingTrailer = await exercise(db, documents, { style: 'chat_completions', mode: 'bare-stop' });
  assert.equal(missingTrailer.entry.status, 'error');
  assert.doesNotMatch(missingTrailer.wire, /event: done/);
  const rejected = await exercise(db, documents, { style: 'responses', mode: 'cancel', cancellation: 'reader', rejectLog: true });
  assert.equal(rejected.entry, null);
  assert.deepEqual(eventNames(rejected.wire), ['meta', 'delta']);
  assert.equal(rejected.warnings.find(([name]) => name === 'AI usage log failed')?.[1]?.httpStatus, 503);
  assert.equal(rejected.warnings.find(([name]) => name === 'AI usage log failed')?.[1]?.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(rejected.warnings), /fixture database detail/);
  scenarios.rejected = rejected.wire;
  const completedWithoutLog = await exercise(db, documents, { rejectLog: true });
  assert.deepEqual(eventNames(completedWithoutLog.wire), ['meta', 'delta', 'done']);
  assert.equal(completedWithoutLog.entry, null);
  assert.ok(completedWithoutLog.warnings.some(([name, event]) => name === 'AI usage log failed' && event.status === 'ok'));
  scenarios.completedWithoutLog = completedWithoutLog.wire;
  const { rows: [counts] } = await db.query(`select count(*) filter (where status = 'ok')::int as ok,
    count(*) filter (where status = 'cancelled')::int as cancelled from public.ai_usage`);
  assert.deepEqual(counts, { ok: 2, cancelled: 2 });
  console.log('第二批模型与入库：两个协议均验证完成、断开、明确错误、截断和取消；成功 2 条，取消 2 条，拒写 503 可见');

  const browserRequests = [];
  await page.exposeFunction('askTestAssistant', async (body) => {
    const result = await exercise(db, documents, { body });
    browserRequests.push({ body, meta: getMeta(result.wire), modelInput: result.modelInput });
    return result.wire;
  });
  await page.addInitScript((fixtures) => {
    // 浏览器只重放实测云函数事件，或把请求交给本地云函数实例。
    window.fetch = async (url, init) => {
      if (!String(url).endsWith('/functions/v1/campus-ai')) throw new Error('禁止外部请求');
      const mode = window.usageTestMode;
      const wire = mode ? fixtures[mode] : await window.askTestAssistant(JSON.parse(init.body));
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        if (mode === 'cancel' || mode === 'rejected') {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        } else controller.close();
      } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, scenarios);
  await page.goto('http://localhost/index.html#/ai');
  const ask = async (text) => {
    await page.locator('#ai-input').fill(text);
    await page.locator('#ai-send').click();
  };
  const latest = page.locator('.ai-message-assistant').last();
  const ready = () => page.locator('#ai-send:enabled').waitFor();
  for (const mode of ['ok', 'completedWithoutLog', 'disconnect', 'upstream-error', 'cancel', 'rejected']) {
    await page.evaluate((name) => { window.usageTestMode = name; }, mode);
    await ask(question);
    await latest.locator('.ai-bubble').getByText(modelText, { exact: true }).waitFor();
    if (mode === 'cancel' || mode === 'rejected') {
      await page.locator('[data-nav="info"]:visible').click();
      await page.locator('[data-nav="ai"]:visible').click();
      await latest.locator('.ai-stream-status').filter({ hasText: '提问已取消' }).waitFor();
    } else if (mode !== 'ok' && mode !== 'completedWithoutLog') {
      await latest.locator('.ai-stream-status').filter({ hasText: '回答中断' }).waitFor();
    }
    await ready();
    if (mode === 'ok' || mode === 'completedWithoutLog') await latest.locator('[data-copy-answer]').waitFor();
    else assert.equal(await latest.locator('[data-follow-up]').count(), 0);
  }
  await page.locator('#ai-new-question').click();
  await page.evaluate(() => { window.usageTestMode = ''; });
  await ask('转专业什么时候报名？');
  await ready();
  await ask(question);
  await ready();
  await ask('那要带什么？');
  await ready();
  await latest.locator('[data-follow-up]').filter({ hasText: '查看申请条件' }).click();
  await ready();
  assert.equal(browserRequests.length, 4);
  assert.equal(browserRequests[1].body.context[0].question, browserRequests[0].body.question);
  for (const result of browserRequests.slice(1)) {
    assert.equal(result.meta.retrievalMode, 'keyword');
    assert.equal(result.meta.sources[0].slug, 'xiaowai-zhusu');
    assert.doesNotMatch(result.modelInput, /第\d轮学生问题：转专业/);
  }
  assert.match(browserRequests[2].modelInput, /第1轮学生问题：校外住宿/);
  assert.equal(browserRequests[3].body.question, '申请条件和限制是什么？');
  assert.match(browserRequests[3].modelInput, /第1轮学生问题：校外住宿/);
  console.log('第二批学生页面与检索：真实按钮验证完成、中断保留、取消，换题、追问和跟进按钮均召回校外住宿（关键词降级）');
}
