import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createTimings } from '../supabase/functions/_shared/timing.js';
import { historicalReferenceMeta, selectKnowledgeScope } from '../supabase/functions/_shared/historical.js';
import { applicationWindowState, composeDocumentContent, detectQuestionDimensions, diversifyDocumentMatches,
  fuseDocumentMatches, rankDocumentsWithSignals, shanghaiToday } from '../supabase/functions/_shared/multi-intent.js';
import { normalizeText, rankDocuments } from '../supabase/functions/_shared/retrieval.js';
import { parseTiming, runBenchmark, summarize } from './benchmark_campus_ai.mjs';

let clock = 0;
const timing = createTimings(() => clock);
await timing.measure('success', () => { clock += 7; });
await assert.rejects(timing.measure('failure', () => { clock += 11; throw new Error('mock'); }));
assert.deepEqual(parseTiming(timing.header()), { success: 7, failure: 11, total: 18 });

const raw = await readFile(new URL('../supabase/functions/campus-ai/index.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(raw.replace(/^import[\s\S]*?;\r?\n/gm, ''), { mode: 'strip' });
const doc = { id: 'doc-1', slug: 'sushe', title: '宿舍电器', category: '宿舍',
  summary: '宿舍电器使用规定', content: '宿舍禁止使用大功率电器。', source_type: 'curated', metadata: {} };

async function exercise(mode) {
  let handler;
  let ticks = 0;
  let modelCalls = 0;
  let usageCalls = 0;
  let usageStatus = '';
  let modelBody;
  let embeddingInput = '';
  const currentYear = new Date().getUTCFullYear();
  const historicalDoc = {
    id: 'doc-history', slug: `major-transfer-${currentYear}`, title: `${currentYear}年转专业工作安排`, category: '学籍管理',
    summary: `${currentYear}年转专业报名时间`, content: `${currentYear}年4月报名。`, source_type: 'official_notice',
    source_date: `${currentYear}-04-01`, verified_at: `${currentYear}-04-01T00:00:00Z`,
    status: 'published',
    effective_from: `${currentYear}-04-01`, effective_until: `${currentYear}-12-31`,
    metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'annual_notice',
      notice_year: currentYear, allow_historical_reference: true },
  };
  const multiAnnualDoc = {
    ...historicalDoc, id: 'doc-annual', slug: `major-transfer-notice-${currentYear}`,
    metadata: { ...historicalDoc.metadata, application_start: `${currentYear}-04-23`,
      application_end: `${currentYear}-04-27T14:00:00+08:00` },
  };
  const multiPolicyDoc = {
    id: 'doc-policy', slug: 'major-transfer-policy', title: '普通本科学生转专业管理办法', category: '学籍管理',
    summary: '适用年级、基本条件和办理流程', content: '完整政策正文。', source_type: 'official_notice',
    source_date: '2024-01-01', verified_at: `${currentYear}-09-01T00:00:00Z`, status: 'published',
    effective_from: '2024-01-01', effective_until: null,
    metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'policy', allow_historical_reference: false },
  };
  const streamMode = mode.startsWith('stream_');
  const qwenMode = mode.startsWith('qwen_');
  const responsesMode = mode === 'qwen_responses_thinking_disabled' || streamMode;
  const settings = { SUPABASE_URL: 'https://database.invalid', SUPABASE_SECRET_KEY: 'mock-server',
    SUPABASE_ANON_KEY: mode === 'auth_fallback' ? 'different-public' : 'mock-public', AI_RATE_LIMIT_SALT: 'mock-salt',
    AI_API_KEY: 'mock-model', AI_MODEL: qwenMode ? 'qwen3.5-flash' : 'mock-model',
    AI_API_STYLE: responsesMode ? 'responses' : 'chat_completions',
    AI_API_BASE_URL: qwenMode ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://model.invalid/v1',
    AI_PROVIDER: qwenMode ? 'qwen' : 'mock',
    AI_ENABLE_THINKING: mode === 'qwen_thinking_enabled' ? 'true' : mode === 'qwen_invalid_thinking' ? 'invalid' : '' };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fakeFetch = async (url, init = {}) => {
    ticks += 5;
    if (url.includes('site_settings')) return response([]);
    if (url.includes('consume_ai_quota')) return response([{ allowed: mode !== 'rate_limit', remaining: 10 }]);
    if (url.includes('knowledge_documents')) return response(mode === 'no_match' ? []
      : mode === 'historical_reference' ? [historicalDoc]
      : mode === 'multi_intent' ? [multiAnnualDoc, multiPolicyDoc] : [doc]);
    if (url.endsWith('/embeddings')) {
      embeddingInput = JSON.parse(init.body).input;
      if (mode === 'embedding_failure') throw new Error('offline embedding failure');
      return response({ data: [{ embedding: Array(1024).fill(0.1) }] });
    }
    if (url.includes('match_knowledge_chunks')) return response(mode === 'multi_intent' ? [
      { document_id: multiPolicyDoc.id, slug: multiPolicyDoc.slug, chunk_id: 'policy-1', content: '片段一：正常转专业适用于大学一年级。', semantic_score: 0.96 },
      { document_id: multiPolicyDoc.id, slug: multiPolicyDoc.slug, chunk_id: 'policy-2', content: '片段二：须注册学籍且未受处分。', semantic_score: 0.94 },
      { document_id: multiPolicyDoc.id, slug: multiPolicyDoc.slug, chunk_id: 'policy-3', content: '片段三：不应进入模型上下文。', semantic_score: 0.92 },
      { document_id: multiAnnualDoc.id, slug: multiAnnualDoc.slug, chunk_id: 'annual-1', content: '年度通知：报名时间和材料。', semantic_score: 0.9 },
    ] : [], mode === 'vector_failure' ? 503 : 200);
    if (url.includes('record_unanswered_question')) return response({});
    if (url.endsWith('/chat/completions')) {
      modelCalls++;
      modelBody = JSON.parse(init.body);
      if (mode === 'model_timeout') throw new DOMException('mock timeout', 'AbortError');
      return response({ choices: [{ message: { content: '根据资料，宿舍禁止使用大功率电器。[1]' } }] });
    }
    if (url.endsWith('/responses')) {
      modelCalls++;
      modelBody = JSON.parse(init.body);
      if (streamMode) {
        const suffix = mode === 'stream_error'
          ? 'data: {"type":"error","error":{"message":"mock interrupted"}}\n\n'
          : 'data: {"type":"response.output_text.delta","delta":"禁止使用大功率电器。[1]"}\n\ndata: [DONE]\n\n';
        return new Response(`data: {"type":"response.output_text.delta","delta":"根据资料，宿舍"}\n\n${suffix}`,
          { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
      }
      return response({ output_text: '根据资料，宿舍禁止使用大功率电器。[1]' });
    }
    if (url.endsWith('/ai_usage')) {
      usageCalls++;
      usageStatus = JSON.parse(init.body).status;
      ticks += 20;
      if (mode === 'log_failure') throw new Error('mock log failure');
      return new Response(null, { status: 201 });
    }
    throw new Error('Unexpected mock route');
  };
  const context = vm.createContext({
    createTimings: () => createTimings(() => ticks), historicalReferenceMeta, selectKnowledgeScope,
    applicationWindowState, composeDocumentContent, detectQuestionDimensions, diversifyDocumentMatches,
    fuseDocumentMatches, rankDocumentsWithSignals, shanghaiToday, normalizeText, rankDocuments,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, ReadableStream, crypto, AbortController, DOMException,
    setTimeout, clearTimeout, fetch: fakeFetch, console: { warn() {}, error() {} },
    Deno: { env: { get: (name) => settings[name] }, serve: (callback) => { handler = callback; } },
  });
  vm.runInContext(source, context);
  const result = await handler(new Request('https://edge.invalid', { method: 'POST',
    headers: { apikey: 'mock-public', Origin: 'http://127.0.0.1:4173' },
    body: JSON.stringify({ question: mode === 'historical_reference' ? `${currentYear + 1}年转专业什么时候报名`
      : mode === 'multi_intent' ? `${currentYear}年转专业什么时候申请，需要什么条件和材料？`
      : mode === 'conversation_followup' ? '那需要什么材料？' : '宿舍可以使用哪些电器',
      clientId: 'test-client-001', stream: streamMode,
      context: mode === 'conversation_followup' ? [
        { question: '第一轮应被移除', answer: '第一轮回答' },
        { question: '第二轮宿舍规定', answer: '第二轮回答' },
        { question: '第三轮宿舍电器', answer: '第三轮回答' },
      ] : [] }) }));
  if (streamMode) {
    assert.equal(result.status, 200);
    assert.match(result.headers.get('Content-Type'), /text\/event-stream/);
    const blocks = (await result.text()).trim().split(/\n\n/).map((block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}');
      return { event, data };
    }).filter((block) => block.event);
    assert.equal(blocks[0].event, 'meta');
    assert.equal(blocks[1].event, 'delta');
    assert.equal(modelBody.stream, true);
    assert.equal(modelCalls, 1);
    assert.equal(usageCalls, 1);
    if (mode === 'stream_error') {
      assert.equal(blocks.at(-1).event, 'error');
      assert.equal(blocks.at(-1).data.code, 'MODEL_UPSTREAM');
      assert.equal(usageStatus, 'error');
    } else {
      assert.deepEqual(blocks.map((block) => block.event), ['meta', 'delta', 'delta', 'done']);
      assert.equal(blocks.at(-1).data.answer, '根据资料，宿舍禁止使用大功率电器。[1]');
      assert.ok(blocks.at(-1).data.timing.model >= 5);
      assert.equal(usageStatus, 'ok');
    }
    return;
  }
  const stages = parseTiming(result.headers.get('Server-Timing'));
  assert.equal(stages.total, ticks);
  assert.equal(stages.usage_log, 25, 'Total must include log wait, even if log fails');
  assert.equal(usageCalls, 1);
  assert.ok('auth' in stages && 'quota' in stages);
  if (mode === 'auth_fallback') assert.equal(stages.auth, 5);
  if (mode === 'rate_limit') {
    assert.equal(result.status, 429); assert.equal(modelCalls, 0);
    assert.ok(!('knowledge' in stages));
  } else if (mode === 'model_timeout') {
    assert.equal(result.status, 500); assert.equal(stages.model, 5);
  } else if (mode === 'qwen_invalid_thinking') {
    assert.equal(result.status, 500); assert.equal(modelCalls, 0);
  } else {
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(modelCalls, mode === 'no_match' ? 0 : 1);
    if (mode === 'no_match') { assert.equal(body.noMatch, true); assert.equal(stages.unanswered_log, 5); }
    else {
      const expectedFirstSlug = mode === 'historical_reference' ? historicalDoc.slug
        : mode === 'multi_intent' ? multiAnnualDoc.slug : 'sushe';
      assert.ok(body.answer); assert.equal(body.sources[0].slug, expectedFirstSlug);
      assert.equal(body.modelApiStyle, responsesMode ? 'responses' : 'chat_completions');
      assert.equal(body.modelThinking, qwenMode ? (mode === 'qwen_thinking_enabled' ? 'enabled' : 'disabled') : 'unspecified');
    }
    if (mode === 'historical_reference') {
      assert.equal(body.answerMode, 'historical_reference');
      assert.equal(body.sources[0].slug, historicalDoc.slug);
      assert.equal(body.sources[0].referenceMode, 'historical_reference');
      assert.equal(body.sources[0].noticeYear, currentYear);
      assert.equal(body.sources[0].requestedYear, currentYear + 1);
      const modelInput = modelBody.input || modelBody.messages?.[1]?.content || '';
      assert.match(modelInput, /往年官方通知（历史参考）/);
      assert.match(modelInput, /仅供时间和流程参考/);
    }
    if (mode === 'multi_intent') {
      assert.deepEqual([...body.questionDimensions], ['时间', '条件', '材料']);
      assert.equal(new Set(body.sources.map((source) => source.slug)).size, body.sources.length);
      assert.ok(body.sources.some((source) => source.slug === multiAnnualDoc.slug));
      const policySource = body.sources.find((source) => source.slug === multiPolicyDoc.slug);
      assert.equal(policySource.chunkCount, 2);
      assert.equal(body.sources.length, 2, '明确主题的年度通知与政策已足够时不混入其他主题');
      const modelInput = modelBody.input || modelBody.messages?.[1]?.content || '';
      assert.match(modelInput, /问题包含的事项：时间、条件、材料/);
      assert.match(modelInput, /申请窗口状态：/);
      assert.match(modelBody.instructions || modelBody.messages?.[0]?.content || '', /适用对象和年级/);
      assert.match(modelInput, /片段一/);
      assert.match(modelInput, /片段二/);
      assert.doesNotMatch(modelInput, /片段三/);
    }
    if (mode === 'conversation_followup') {
      const modelInput = modelBody.input || modelBody.messages?.[1]?.content || '';
      assert.doesNotMatch(modelInput, /第一轮应被移除|第一轮回答/);
      assert.match(modelInput, /第二轮宿舍规定|第二轮回答/);
      assert.match(modelInput, /第三轮宿舍电器|第三轮回答/);
      assert.match(modelInput, /当前学生问题：\n那需要什么材料/);
      assert.match(embeddingInput, /第二轮宿舍规定；第三轮宿舍电器；那需要什么材料/);
    }
    if (mode === 'embedding_failure') assert.ok(!('vector_rpc' in stages));
    if (mode === 'qwen_thinking_disabled') assert.equal(modelBody.enable_thinking, false);
    if (mode === 'qwen_responses_thinking_disabled') assert.equal(modelBody.enable_thinking, false);
    if (mode === 'qwen_thinking_enabled') assert.equal(modelBody.enable_thinking, true);
    if (mode === 'success') assert.equal('enable_thinking' in modelBody, false);
  }
  assert.ok(!result.headers.get('Server-Timing').includes('mock'));
}

for (const mode of ['success', 'auth_fallback', 'no_match', 'embedding_failure', 'vector_failure', 'model_timeout',
  'log_failure', 'rate_limit', 'historical_reference', 'multi_intent', 'conversation_followup', 'qwen_thinking_disabled', 'qwen_responses_thinking_disabled',
  'qwen_thinking_enabled', 'qwen_invalid_thinking', 'stream_success', 'stream_error']) {
  await exercise(mode);
  console.log(`PASS 服务端计时：${mode}`);
}

let calls = 0;
const samples = await runBenchmark({ endpoint: 'https://mock.invalid', key: 'mock', clientId: 'fixed-client',
  fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).clientId, 'fixed-client');
    calls++;
    return new Response(JSON.stringify(calls === 2 ? { error: 'limited' } : {
      answer: 'mock', sources: [], modelApiStyle: 'responses', modelThinking: 'disabled',
    }),
      { status: calls === 2 ? 429 : 200, headers: { 'Server-Timing': 'model;dur=20, total;dur=30' } });
  } });
assert.equal(calls, 2, 'Stop on quota exhaustion; never rotate client ID');
const summary = summarize(samples);
assert.equal(summary.failure_rate, 0.5);
assert.equal(summary.successful_complete.n, 1);
assert.equal(summary.stages.model.median_ms, 20);
assert.equal(samples[0].model_api_style, 'responses');
assert.equal(samples[0].model_thinking, 'disabled');
assert.ok(!JSON.stringify(samples).includes('fixed-client'));
assert.ok(!JSON.stringify(samples).includes('answer":"mock'));
const subset = await runBenchmark({ endpoint: 'https://mock.invalid', key: 'mock', clientId: 'fixed-client', repeats: 1,
  questionSet: ['第三题'], questionStartIndex: 2,
  fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).question, '第三题');
    return new Response(JSON.stringify({ answer: 'mock', sources: [] }),
      { status: 200, headers: { 'Server-Timing': 'model;dur=20, total;dur=30' } });
  } });
assert.equal(subset[0].question_id, 'q03');
const timeoutSamples = await runBenchmark({ endpoint: 'https://mock.invalid', key: 'mock', clientId: 'fixed-client', repeats: 1,
  timeoutMs: 1, fetchImpl: async (_, options) => {
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('mock abort')), { once: true }));
  } });
assert.ok(timeoutSamples.every((s) => s.outcome === 'timeout'));
assert.equal(summarize(timeoutSamples).successful_complete, null);
console.log('PASS 报告统计、限额停止、固定匿名 ID、超时和隐私检查（全部离线）');
