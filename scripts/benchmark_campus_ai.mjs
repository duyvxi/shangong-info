import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const questions = [
  '新生报到要带什么材料', '宿舍可以使用哪些电器', '挂科以后补考怎么办',
  '家庭困难怎么申请助学金', '毕业论文和实习要注意什么', '2027年寒假什么时候开始',
  '东校区能坐哪些公交车', '52路到山东工商学院西门吗', '第三餐厅有什么吃的', '扇苑餐厅晚饭几点',
];

export function parseTiming(value = '') {
  return Object.fromEntries(value.split(',').flatMap((entry) => {
    const match = entry.trim().match(/^([a-z_]+);dur=(\d+(?:\.\d+)?)$/);
    return match ? [[match[1], Number(match[2])]] : [];
  }));
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return { n: sorted.length, median_ms: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export function summarize(samples) {
  const ok = samples.filter((sample) => sample.outcome === 'ok');
  const stages = [...new Set(ok.flatMap((sample) => Object.keys(sample.server)))];
  return {
    attempted: samples.length, successful_answers: ok.length,
    responses_with_server_timing: samples.filter((s) => Number.isFinite(s.server.total)).length,
    failure_rate: samples.length ? samples.filter((s) => !['ok', 'no_match'].includes(s.outcome)).length / samples.length : null,
    no_match_rate: samples.length ? samples.filter((s) => s.outcome === 'no_match').length / samples.length : null,
    // Do not mix fast errors/no-match responses into successful-answer latency.
    successful_headers: distribution(ok.map((s) => s.headers_ms)),
    successful_first_text: distribution(ok.map((s) => s.first_text_ms)),
    successful_complete: distribution(ok.map((s) => s.complete_ms)),
    interruption_rate: samples.length ? samples.filter((s) => ['stream_error', 'stream_incomplete'].includes(s.outcome)).length / samples.length : null,
    retry_rate: samples.length ? samples.filter((s) => s.retry_of).length / samples.length : null,
    stages: Object.fromEntries(stages.map((stage) => [stage, distribution(ok.map((s) => s.server[stage]))])),
    by_outcome: Object.fromEntries([...new Set(samples.map((s) => s.outcome))].map((outcome) =>
      [outcome, distribution(samples.filter((s) => s.outcome === outcome).map((s) => s.complete_ms))])),
  };
}

async function readEventStream(response, start, now) {
  if (!response.body?.getReader) return { outcome: 'stream_incomplete', answer_chars: 0, source_count: 0, server: {} };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answerChars = 0;
  let sourceCount = 0;
  let firstTextMs;
  let remaining;
  let server = {};
  let finished = false;
  let streamError = false;
  const consume = (block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || 'message';
    const raw = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!raw) return;
    let data = {};
    try { data = JSON.parse(raw); } catch { return; }
    if (event === 'meta') {
      sourceCount = Array.isArray(data.sources) ? data.sources.length : 0;
      if (Number.isFinite(data.remaining)) remaining = data.remaining;
    } else if (event === 'delta' && typeof data.text === 'string') {
      if (!Number.isFinite(firstTextMs) && data.text) firstTextMs = now() - start;
      answerChars += data.text.length;
    } else if (event === 'done') {
      finished = true;
      server = data.timing && typeof data.timing === 'object' ? data.timing : {};
      if (typeof data.answer === 'string') answerChars = data.answer.length;
      if (Number.isFinite(data.remaining)) remaining = data.remaining;
    } else if (event === 'error') {
      streamError = true;
      server = data.timing && typeof data.timing === 'object' ? data.timing : {};
    }
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
  return { outcome: streamError ? 'stream_error' : finished && answerChars ? 'ok' : 'stream_incomplete',
    answer_chars: answerChars, source_count: sourceCount, first_text_ms: firstTextMs, remaining, server };
}

export async function runBenchmark({ endpoint, key, clientId, repeats = 3, timeoutMs = 70000,
  fetchImpl = fetch, now = () => performance.now(), onSample = () => {},
  questionSet = questions, questionStartIndex = 0, stream = false }) {
  const samples = [];
  for (let round = 1; round <= repeats; round++) {
    for (let i = 0; i < questionSet.length; i++) {
      const start = now();
      const sample = { question_id: `q${String(i + 1 + questionStartIndex).padStart(2, '0')}`, round,
        sequence: samples.length + 1, started_at: new Date().toISOString(), instance_state: 'unknown', outcome: 'network_error', server: {} };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify({ question: questionSet[i], clientId, ...(stream ? { stream: true } : {}) }), signal: controller.signal,
        });
        sample.headers_ms = now() - start;
        sample.http_status = response.status;
        sample.server = parseTiming(response.headers.get('Server-Timing') || '');
        if (stream && response.ok && (response.headers.get('Content-Type') || '').includes('text/event-stream')) {
          Object.assign(sample, await readEventStream(response, start, now));
          if (!Object.keys(sample.server).length) sample.server = {};
        } else {
          const body = await response.json();
          if (Number.isFinite(body.remaining)) sample.remaining = body.remaining;
          if (typeof body.resetAt === 'string' && Number.isFinite(Date.parse(body.resetAt))) sample.reset_at = body.resetAt;
          sample.outcome = response.status === 429 ? 'rate_limited' : !response.ok ? 'http_error'
            : body.noMatch === true ? 'no_match' : typeof body.answer === 'string' && body.answer.trim() ? 'ok' : 'invalid_response';
          sample.source_count = Array.isArray(body.sources) ? body.sources.length : 0;
          sample.answer_chars = typeof body.answer === 'string' ? body.answer.length : 0;
          if (['responses', 'chat_completions'].includes(body.modelApiStyle)) sample.model_api_style = body.modelApiStyle;
          if (['enabled', 'disabled', 'unspecified'].includes(body.modelThinking)) sample.model_thinking = body.modelThinking;
        }
      } catch {
        sample.outcome = controller.signal.aborted ? 'timeout' : 'network_or_parse_error';
      } finally {
        clearTimeout(timer);
        sample.complete_ms = now() - start;
      }
      samples.push(sample);
      onSample(sample);
      if ([401, 403, 429].includes(sample.http_status)) return samples;
    }
  }
  return samples;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--summarize') {
    const files = args.slice(1);
    if (!files.length) throw new Error('需要至少一个报告文件。');
    const reports = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
    const reference = reports[0].metadata;
    if (reports.some((report) => report.schema_version !== 1 || !Array.isArray(report.samples) ||
        ['revision', 'model', 'knowledge_version', 'environment'].some((key) => report.metadata?.[key] !== reference?.[key]))) {
      throw new Error('报告版本或测试条件不一致，不能合并。');
    }
    console.log(JSON.stringify(summarize(reports.flatMap((report) => report.samples)), null, 2));
    return;
  }
  if (!args.includes('--live')) {
    console.log('默认不发请求。真实测试会消耗额度并写日志，获授权后才使用 --live。');
    console.log(`固定 ${questions.length} 题，默认每题 3 次；实例冷热状态标为 unknown。配置方法见 docs/AI_PERFORMANCE.md。`);
    return;
  }
  const value = (name) => args[args.indexOf(name) + 1];
  const repeats = args.includes('--repeats') ? Number(value('--repeats')) : 3;
  const stream = args.includes('--stream');
  const output = args.includes('--output') ? value('--output') : '';
  const endpoint = process.env.AI_BENCH_ENDPOINT || '';
  const key = process.env.AI_BENCH_PUBLIC_KEY || '';
  const clientId = process.env.AI_BENCH_CLIENT_ID || '';
  const metadata = Object.fromEntries(['revision', 'model', 'knowledge_version', 'environment'].map((name) =>
    [name, process.env[`AI_BENCH_${name.toUpperCase()}`] || '']));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !output ||
      Object.values(metadata).some((v) => !v) || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientId) || !key) {
    throw new Error('缺少报告路径或测试配置，或 repeats 不在 1～10；请参阅性能文档。');
  }
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('测试地址必须为 HTTPS，或本机 HTTP，且不能包含凭据或查询参数。');
  }
  if (key.startsWith('sb_secret_')) throw new Error('只能使用前端公开 key。');
  if (key.split('.').length === 3) {
    try { if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role !== 'anon') throw new Error(); }
    catch { throw new Error('JWT 必须为 anon 公开 key。'); }
  }
  // Reserve the report before making billable requests; never overwrite a prior run.
  await writeFile(output, JSON.stringify({ state: 'started', metadata }), { flag: 'wx' });
  const samples = await runBenchmark({ endpoint, key, clientId, repeats, stream,
    onSample: (sample) => console.log(`${sample.question_id} 第 ${sample.round} 次：${sample.outcome}，${Math.round(sample.complete_ms)}ms`) });
  const report = { schema_version: 1, created_at: new Date().toISOString(), metadata,
    requested_samples: repeats * questions.length, cold_start: 'unverified',
    transport: stream ? 'stream' : 'json',
    warning: stream
      ? '小样本 P95 仅供初步参考；first_text_ms 是收到首段文字的时间，不含浏览器绘制。'
      : '小样本 P95 仅供初步参考；headers_ms 不是首个可见文字时间；不含浏览器绘制。',
    summary: summarize(samples), samples };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log('已保存报告（不含问题、答案、凭据或设备 ID）。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('性能测试未完成：请检查配置、输出文件是否已存在及写入权限。'); process.exitCode = 1; });
}
