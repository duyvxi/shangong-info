import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateAnswers } from './benchmark_ai_quality.mjs';

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function timingSummary(cases) {
  const values = cases.map((item) => item.complete_ms).filter(Number.isFinite);
  const firstTextValues = cases.map((item) => item.first_text_ms).filter(Number.isFinite);
  const answerLengths = cases.map((item) => String(item.answer || '').length);
  if (!values.length) return { n: 0, median_ms: null, p95_ms: null,
    first_text_median_ms: null, first_text_p95_ms: null, average_answer_chars: null };
  const sorted = [...values].sort((a, b) => a - b);
  const firstTextSorted = [...firstTextValues].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const firstTextMiddle = Math.floor(firstTextSorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    n: sorted.length,
    median_ms: median,
    p95_ms: percentile(sorted, 0.95),
    first_text_median_ms: firstTextSorted.length
      ? firstTextSorted.length % 2 ? firstTextSorted[firstTextMiddle]
        : (firstTextSorted[firstTextMiddle - 1] + firstTextSorted[firstTextMiddle]) / 2
      : null,
    first_text_p95_ms: percentile(firstTextSorted, 0.95),
    average_answer_chars: answerLengths.reduce((sum, length) => sum + length, 0) / answerLengths.length,
  };
}

function parsePublicConfig(source) {
  const projectUrl = source.match(/url:\s*'([^']+)'/)?.[1];
  const publicKey = source.match(/anonKey:\s*'([^']+)'/)?.[1];
  if (!projectUrl || !publicKey) throw new Error('无法从 js/api.js 读取前端公开配置。');
  return { endpoint: `${projectUrl.replace(/\/$/, '')}/functions/v1/campus-ai`, publicKey };
}

async function readStream(response, started) {
  const reader = response.body?.getReader();
  if (!reader) return { outcome: 'stream_incomplete', complete_ms: performance.now() - started };
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let firstTextMs;
  let meta = {};
  let donePayload = null;
  let streamError = false;
  const consume = (block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const raw = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!event || !raw) return;
    let data = {};
    try { data = JSON.parse(raw); } catch { return; }
    if (event === 'meta') meta = data;
    else if (event === 'delta' && typeof data.text === 'string') {
      if (!Number.isFinite(firstTextMs) && data.text) firstTextMs = performance.now() - started;
      answer += data.text;
    } else if (event === 'done') {
      donePayload = data;
      if (typeof data.answer === 'string' && data.answer.length >= answer.length) answer = data.answer;
    } else if (event === 'error') streamError = true;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  const completeMs = performance.now() - started;
  if (streamError) return { outcome: 'stream_error', complete_ms: completeMs };
  if (!donePayload || !answer) return { outcome: 'stream_incomplete', complete_ms: completeMs };
  if (!Number.isFinite(firstTextMs)) firstTextMs = completeMs;
  const noMatch = meta.noMatch === true || donePayload.noMatch === true;
  return {
    outcome: noMatch ? 'no_match' : 'ok', answer,
    sources: Array.isArray(meta.sources) ? meta.sources : Array.isArray(donePayload.sources) ? donePayload.sources : [],
    answerMode: meta.answerMode || donePayload.answerMode,
    retrievalMode: meta.retrievalMode || donePayload.retrievalMode,
    questionDimensions: Array.isArray(meta.questionDimensions) ? meta.questionDimensions : [],
    currentDate: meta.currentDate || null,
    remaining: donePayload.remaining ?? meta.remaining,
    modelApiStyle: donePayload.modelApiStyle,
    modelThinking: donePayload.modelThinking,
    serverTiming: donePayload.timing || {},
    first_text_ms: firstTextMs,
    complete_ms: completeMs,
  };
}

export async function requestCase({ endpoint, publicKey, clientId, testCase, fetchImpl = fetch, timeoutMs = 70000, stream = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { apikey: publicKey, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify({ question: testCase.question, clientId, ...(stream ? { stream: true } : {}) }),
      signal: controller.signal,
    });
    const headersMs = performance.now() - started;
    const contentType = response.headers.get('Content-Type') || '';
    if (stream && response.ok && contentType.includes('text/event-stream')) {
      const streamed = await readStream(response, started);
      if (!['ok', 'no_match'].includes(streamed.outcome)) return { ...streamed, headers_ms: headersMs };
      return {
        id: testCase.id,
        outcome: streamed.outcome,
        answer: streamed.answer,
        sources: streamed.sources.map((source) => ({
          slug: source.slug, title: source.title, sourceType: source.sourceType,
          referenceMode: source.referenceMode, noticeYear: source.noticeYear,
          requestedYear: source.requestedYear, chunkCount: source.chunkCount,
        })),
        answer_mode: streamed.answerMode,
        retrieval_mode: streamed.retrievalMode,
        question_dimensions: streamed.questionDimensions,
        current_date: streamed.currentDate,
        headers_ms: headersMs,
        first_text_ms: streamed.first_text_ms,
        complete_ms: streamed.complete_ms,
        remaining: streamed.remaining,
        model_api_style: streamed.modelApiStyle,
        model_thinking: streamed.modelThinking,
        server_timing: streamed.serverTiming,
      };
    }
    const body = await response.json().catch(() => ({}));
    const completeMs = performance.now() - started;
    if (response.status === 429) {
      return { outcome: 'rate_limited', complete_ms: completeMs, remaining: 0, reset_at: body.resetAt || null };
    }
    if (!response.ok) {
      return { outcome: 'http_error', http_status: response.status, complete_ms: completeMs, remaining: body.remaining };
    }
    return {
      id: testCase.id,
      outcome: body.noMatch === true ? 'no_match' : 'ok',
      answer: typeof body.answer === 'string' ? body.answer : '',
      sources: Array.isArray(body.sources) ? body.sources.map((source) => ({
        slug: source.slug,
        title: source.title,
        sourceType: source.sourceType,
        referenceMode: source.referenceMode,
        noticeYear: source.noticeYear,
        requestedYear: source.requestedYear,
        chunkCount: source.chunkCount,
      })) : [],
      answer_mode: body.answerMode,
      retrieval_mode: body.retrievalMode,
      question_dimensions: Array.isArray(body.questionDimensions) ? body.questionDimensions : [],
      current_date: body.currentDate || null,
      complete_ms: completeMs,
      headers_ms: headersMs,
      first_text_ms: completeMs,
      remaining: body.remaining,
      model_api_style: body.modelApiStyle,
      model_thinking: body.modelThinking,
    };
  } catch (error) {
    return { outcome: controller.signal.aborted ? 'timeout' : 'network_error', complete_ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) {
    console.log('默认不发请求。真实测试会消耗额度并写入脱敏用量日志；确认后才使用 --live。');
    return;
  }

  const output = argumentValue(args, '--output');
  const clientId = argumentValue(args, '--client-id') || process.env.AI_QUALITY_CLIENT_ID || '';
  const resume = args.includes('--resume');
  const stream = args.includes('--stream');
  if (!output || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientId)) {
    throw new Error('需要 --output 和 8～128 位的 --client-id。');
  }

  const datasetSource = await readFile(new URL('../quality/ai-answer-quality-cases.json', import.meta.url), 'utf8');
  const officialKnowledgeSource = await readFile(new URL('../knowledge/official-major-transfer-2026.json', import.meta.url), 'utf8');
  const dataset = JSON.parse(datasetSource);
  const config = parsePublicConfig(await readFile(new URL('../js/api.js', import.meta.url), 'utf8'));
  const fingerprint = createHash('sha256').update(clientId).digest('hex').slice(0, 16);
  let report;
  if (resume) {
    report = JSON.parse(await readFile(output, 'utf8'));
    if (report.schema_version !== 1 || report.client_fingerprint !== fingerprint || !Array.isArray(report.cases)) {
      throw new Error('续跑报告与当前匿名测试 ID 不匹配。');
    }
  } else {
    report = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      state: 'running',
      client_fingerprint: fingerprint,
      warning: '本地报告包含模型回答但不含凭据或匿名测试 ID；out/ 已被 Git 忽略。',
      cases: [],
      attempts: [],
    };
    await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  }

  report.metadata = {
    endpoint: config.endpoint,
    expected_case_count: dataset.cases.length,
    dataset_sha256: createHash('sha256').update(datasetSource).digest('hex'),
    official_knowledge_sha256: createHash('sha256').update(officialKnowledgeSource).digest('hex'),
    expected_official_slugs: ['official-major-transfer-policy-2024', 'official-major-transfer-notice-2026'],
    transport: stream ? 'stream' : 'json',
  };

  const completed = new Set(report.cases.map((item) => item.id));
  for (const testCase of dataset.cases.filter((item) => !completed.has(item.id))) {
    const result = await requestCase({ ...config, clientId, testCase, stream });
    const attempt = { id: testCase.id, outcome: result.outcome, complete_ms: result.complete_ms,
      first_text_ms: result.first_text_ms,
      remaining: result.remaining, reset_at: result.reset_at || null, created_at: new Date().toISOString() };
    report.attempts.push(attempt);
    if (['ok', 'no_match'].includes(result.outcome)) report.cases.push(result);
    report.state = result.outcome === 'rate_limited' ? 'quota_wait'
      : ['http_error', 'timeout', 'network_error', 'stream_error', 'stream_incomplete'].includes(result.outcome) ? 'interrupted' : 'running';
    report.reset_at = result.reset_at || report.reset_at || null;
    report.quality = evaluateAnswers(dataset.cases, report.cases).summary;
    report.timing = timingSummary(report.cases);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`${testCase.id}: ${result.outcome}，${Math.round(result.complete_ms)}ms，剩余 ${result.remaining ?? '未知'}`);
    if (report.state !== 'running') break;
  }

  if (report.cases.length === dataset.cases.length) {
    report.state = 'complete';
    report.completed_at = new Date().toISOString();
    report.quality = evaluateAnswers(dataset.cases, report.cases).summary;
    report.timing = timingSummary(report.cases);
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  console.log(`状态：${report.state}；已完成 ${report.cases.length}/${dataset.cases.length}。`);
  if (report.state === 'quota_wait' && report.reset_at) console.log(`可在 ${report.reset_at} 后使用 --resume 续跑。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
