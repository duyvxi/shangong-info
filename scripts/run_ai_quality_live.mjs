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
  const answerLengths = cases.map((item) => String(item.answer || '').length);
  if (!values.length) return { n: 0, median_ms: null, p95_ms: null, average_answer_chars: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    n: sorted.length,
    median_ms: median,
    p95_ms: percentile(sorted, 0.95),
    average_answer_chars: answerLengths.reduce((sum, length) => sum + length, 0) / answerLengths.length,
  };
}

function parsePublicConfig(source) {
  const projectUrl = source.match(/url:\s*'([^']+)'/)?.[1];
  const publicKey = source.match(/anonKey:\s*'([^']+)'/)?.[1];
  if (!projectUrl || !publicKey) throw new Error('无法从 js/api.js 读取前端公开配置。');
  return { endpoint: `${projectUrl.replace(/\/$/, '')}/functions/v1/campus-ai`, publicKey };
}

export async function requestCase({ endpoint, publicKey, clientId, testCase, fetchImpl = fetch, timeoutMs = 70000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { apikey: publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: testCase.question, clientId }),
      signal: controller.signal,
    });
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
  };

  const completed = new Set(report.cases.map((item) => item.id));
  for (const testCase of dataset.cases.filter((item) => !completed.has(item.id))) {
    const result = await requestCase({ ...config, clientId, testCase });
    const attempt = { id: testCase.id, outcome: result.outcome, complete_ms: result.complete_ms,
      remaining: result.remaining, reset_at: result.reset_at || null, created_at: new Date().toISOString() };
    report.attempts.push(attempt);
    if (['ok', 'no_match'].includes(result.outcome)) report.cases.push(result);
    report.state = result.outcome === 'rate_limited' ? 'quota_wait'
      : ['http_error', 'timeout', 'network_error'].includes(result.outcome) ? 'interrupted' : 'running';
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
