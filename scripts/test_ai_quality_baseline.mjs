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
