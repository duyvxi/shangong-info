import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAnswers, evaluateKnowledge } from './benchmark_ai_quality.mjs';
import { requestCase } from './run_ai_quality_live.mjs';

const dataset = JSON.parse(await readFile(new URL('../quality/ai-answer-quality-cases.json', import.meta.url), 'utf8'));
assert.equal(dataset.cases.length, 24);

const caseOne = dataset.cases.find((item) => item.id === 'annual-01');
const documents = [{
  slug: 'official-major-transfer-notice-2026',
  title: '2026年转专业通知',
  category: '学籍管理',
  summary: '报名安排',
  content: '报名时间为2026年4月23日—4月27日14时。',
}];
const knowledge = evaluateKnowledge([caseOne], documents);
assert.equal(knowledge.summary.retrieval_case_pass_rate, 1);
assert.equal(knowledge.summary.retrieved_knowledge_point_coverage, 1);

const answers = evaluateAnswers([caseOne], [{
  id: 'annual-01',
  answer: '报名时间是2026年4月23日至4月27日14时。[1]',
  sources: [{ slug: 'official-major-transfer-notice-2026' }],
}]);
assert.equal(answers.summary.complete_case_rate, 1);
assert.equal(answers.summary.citation_rate, 1);

const unsafe = evaluateAnswers([caseOne], [{
  id: 'annual-01',
  answer: '请查看2014年77号规定。',
  sources: [],
}]);
assert.equal(unsafe.summary.complete_case_rate, 0);
assert.equal(unsafe.summary.forbidden_claim_cases, 1);

const abstainCase = dataset.cases.find((item) => item.id === 'abstain-02');
const safeDenial = evaluateAnswers([abstainCase], [{
  id: 'abstain-02',
  answer: '现有资料无法确认明天上午图书馆三楼是否一定有空座。',
  sources: [],
}]);
assert.equal(safeDenial.summary.complete_case_rate, 1);
assert.equal(safeDenial.summary.forbidden_claim_cases, 0);

const contradictoryClaim = evaluateAnswers([abstainCase], [{
  id: 'abstain-02',
  answer: '现有资料无法确认。但明天上午三楼一定有空座。',
  sources: [],
}]);
assert.equal(contradictoryClaim.summary.complete_case_rate, 0);
assert.equal(contradictoryClaim.summary.forbidden_claim_cases, 1);

const conditionCases = dataset.cases.filter((item) => ['condition-02', 'condition-04'].includes(item.id));
const equivalentPhrases = evaluateAnswers(conditionCases, [
  {
    id: 'condition-02',
    answer: '申请转入专业与原专业属于不同的招生录取类别时不能申请；入学未满一学期、处于休学期间或已经办理过转专业也不能申请。[1]',
    sources: [{ slug: 'official-major-transfer-policy-2024' }],
  },
  {
    id: 'condition-04',
    answer: '家距离学校较近，或因疾病不宜在集体宿舍居住时可以申请；未满18周岁原则上不得申请。[1]',
    sources: [{ slug: 'xiaowai-zhusu' }],
  },
]);
assert.equal(equivalentPhrases.summary.complete_case_rate, 1);

const calibratedCases = dataset.cases.filter((item) => ['process-01', 'process-04', 'multi-04'].includes(item.id));
const calibratedPhrases = evaluateAnswers(calibratedCases, [
  {
    id: 'process-01',
    answer: '提交正常情况转专业申请表；每名学生限选 1 个专业，之后参加笔试和面试，名单公示不少于5个工作日。[1][2]',
    sources: [{ slug: 'official-major-transfer-notice-2026' }, { slug: 'official-major-transfer-policy-2024' }],
  },
  {
    id: 'process-04',
    answer: '关注学生资助服务中心通知；勤工助学一人一岗，每月勤工工作时间原则上不超过 40 小时。[1]',
    sources: [{ slug: 'qinong-zhuxue' }],
  },
  {
    id: 'multi-04',
    answer: '图书馆借阅区开放时间是7:00–22:00，综合服务台位于二楼中厅。[1]',
    sources: [{ slug: 'tushuguan-shijian' }],
  },
]);
assert.equal(calibratedPhrases.summary.complete_case_rate, 1);

const requested = [];
const mocked = await requestCase({
  endpoint: 'https://example.invalid/functions/v1/campus-ai',
  publicKey: 'public-test-key',
  clientId: 'quality-test-client',
  testCase: caseOne,
  fetchImpl: async (_url, init) => {
    requested.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      answer: '报名时间是2026年4月23日至4月27日14时。[1]',
      sources: [{ slug: 'official-major-transfer-notice-2026', title: '通知', sourceType: 'official_notice' }],
      remaining: 11,
      modelApiStyle: 'responses',
      modelThinking: 'disabled',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});
assert.equal(requested[0].question, caseOne.question);
assert.equal(requested[0].clientId, 'quality-test-client');
assert.equal(mocked.outcome, 'ok');
assert.equal(mocked.sources[0].slug, 'official-major-transfer-notice-2026');

const streamed = await requestCase({
  endpoint: 'https://example.invalid/functions/v1/campus-ai',
  publicKey: 'public-test-key',
  clientId: 'quality-test-client',
  testCase: caseOne,
  stream: true,
  fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response([
      ': connected',
      'event: meta\ndata: {"sources":[{"slug":"official-major-transfer-notice-2026","title":"通知","sourceType":"official_notice"}],"remaining":10}',
      'event: delta\ndata: {"text":"报名时间是2026年4月23日"}',
      'event: delta\ndata: {"text":"至4月27日14时。[1]"}',
      'event: done\ndata: {"answer":"报名时间是2026年4月23日至4月27日14时。[1]","remaining":10,"modelApiStyle":"responses","modelThinking":"disabled","timing":{"total":20}}',
      '',
    ].join('\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  },
});
assert.equal(streamed.outcome, 'ok');
assert.equal(streamed.answer, '报名时间是2026年4月23日至4月27日14时。[1]');
assert.equal(streamed.sources[0].slug, 'official-major-transfer-notice-2026');
assert.ok(Number.isFinite(streamed.first_text_ms));
assert.equal(streamed.server_timing.total, 20);

const limited = await requestCase({
  endpoint: 'https://example.invalid/functions/v1/campus-ai',
  publicKey: 'public-test-key',
  clientId: 'quality-test-client',
  testCase: caseOne,
  fetchImpl: async () => new Response(JSON.stringify({ remaining: 0, resetAt: '2026-09-19T18:00:00Z' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  }),
});
assert.equal(limited.outcome, 'rate_limited');
assert.equal(limited.reset_at, '2026-09-19T18:00:00Z');

console.log('PASS AI 回答质量基线测试：24 题数据、评分与真实请求的成功/限额处理正常。');
