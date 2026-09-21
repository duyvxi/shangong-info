import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkDocument } from './knowledge-chunking.mjs';
import {
  applicationWindowState,
  composeDocumentContent,
  detectQuestionDimensions,
  diversifyDocumentMatches,
  fuseDocumentMatches,
  rankDocumentsWithSignals,
  retrievalSignalBoost,
} from '../supabase/functions/_shared/multi-intent.js';

const today = '2026-09-19';
const annual = {
  id: 'annual-id', slug: 'transfer-2026', title: '2026年转专业工作安排', category: '学籍管理',
  summary: '报名时间、材料与考核安排', content: '4月23日至27日报名。', source_type: 'official_notice',
  verified_at: '2026-09-18T00:00:00Z', metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'annual_notice',
    notice_year: 2026, application_start: '2026-04-23', application_end: '2026-04-27T14:00:00+08:00' },
};
const policy = {
  id: 'policy-id', slug: 'transfer-policy', title: '普通本科学生转专业管理办法', category: '学籍管理',
  summary: '适用年级、基本条件和办理流程', content: '完整政策正文。', source_type: 'official_notice',
  verified_at: '2026-09-18T00:00:00Z', metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'policy' },
};
const guide = {
  id: 'guide-id', slug: 'transfer-guide', title: '转专业办事指南', category: '学籍管理',
  summary: '转专业入口', content: '请关注通知。', source_type: 'curated', metadata: { topic_key: 'other-topic', document_role: 'guide' },
};
const question = '2026年转专业什么时候申请，需要什么条件和材料？';

assert.deepEqual(detectQuestionDimensions(question), ['时间', '条件', '材料']);
assert.ok(retrievalSignalBoost(question, annual, today) > retrievalSignalBoost(question, guide, today));
assert.ok(retrievalSignalBoost(question, policy, today) > retrievalSignalBoost(question, guide, today));
const ranked = rankDocumentsWithSignals(question, [guide, policy, annual], 3, today);
assert.ok(ranked.find((item) => item.slug === annual.slug));
assert.ok(ranked.find((item) => item.slug === policy.slug));

const semantic = [
  { ...policy, document_id: policy.id, chunk_id: 'p1', content: '片段一：适用于大学一年级学生。', semantic_score: 0.96 },
  { ...policy, document_id: policy.id, chunk_id: 'p2', content: '片段二：须注册学籍且未受处分。', semantic_score: 0.94 },
  { ...policy, document_id: policy.id, chunk_id: 'p3', content: '片段三：这是不应进入上下文的第三片段。', semantic_score: 0.92 },
  { ...annual, document_id: annual.id, chunk_id: 'a1', content: '年度通知：报名时间和申请材料。', semantic_score: 0.9 },
];
const fused = fuseDocumentMatches(ranked, semantic, 8);
const fusedPolicy = fused.find((item) => item.slug === policy.slug);
assert.equal(fused.filter((item) => item.slug === policy.slug).length, 1, '来源按文档去重');
assert.deepEqual(fusedPolicy.chunk_ids, ['p1', 'p2']);
assert.equal(fusedPolicy.additional_contents.length, 1);
const policyContext = composeDocumentContent(fusedPolicy);
assert.match(policyContext, /片段一/);
assert.match(policyContext, /片段二/);
assert.doesNotMatch(policyContext, /片段三/);

const diversified = diversifyDocumentMatches([guide, ...fused], detectQuestionDimensions(question), 5, question);
assert.ok(diversified.some((item) => item.metadata?.document_role === 'annual_notice'));
assert.ok(diversified.some((item) => item.metadata?.document_role === 'policy'));
assert.equal(new Set(diversified.map((item) => item.slug)).size, diversified.length);
assert.ok(!diversified.some((item) => item.slug === guide.slug), '已有明确主题时应排除其他主题资料');

assert.equal(applicationWindowState(annual, Date.parse('2026-04-20T00:00:00+08:00')), '未开始');
assert.equal(applicationWindowState(annual, Date.parse('2026-04-25T00:00:00+08:00')), '进行中');
assert.equal(applicationWindowState(annual, Date.parse('2026-05-01T00:00:00+08:00')), '已结束');

// 用仓库内的真实官方资料验证 M4 目标问题可同时拿到时间、条件、材料和流程细则。
const officialCollection = JSON.parse(await readFile(
  new URL('../knowledge/official-major-transfer-2026.json', import.meta.url),
  'utf8',
));
const officialDocuments = officialCollection.documents;
const officialPolicy = officialDocuments.find((item) => item.slug === 'official-major-transfer-policy-2024');
const officialAnnual = officialDocuments.find((item) => item.slug === 'official-major-transfer-notice-2026');
const officialRanked = rankDocumentsWithSignals(question, officialDocuments, 5, today);
const officialSemantic = [officialPolicy, officialAnnual].flatMap((document) =>
  chunkDocument(document).map((chunk, index) => ({
    ...document,
    document_id: document.slug,
    chunk_id: `${document.slug}-${chunk.chunk_index}`,
    content: chunk.content,
    semantic_score: 0.98 - index * 0.02,
  }))
);
const officialMatches = diversifyDocumentMatches(
  fuseDocumentMatches(officialRanked, officialSemantic, 8),
  detectQuestionDimensions(question),
  5,
  question,
);
const officialContext = officialMatches.map((item) => composeDocumentContent(item)).join('\n');
assert.ok(officialMatches.some((item) => item.slug === officialAnnual.slug));
assert.ok(officialMatches.some((item) => item.slug === officialPolicy.slug));
for (const expected of ['4月23日', '大学一年级', '已注册学籍', '申请表', '只能选择1个专业', '笔试', '面试', '公示不少于5个工作日']) {
  assert.match(officialContext, new RegExp(expected), `真实资料上下文缺少：${expected}`);
}

const unrelatedQuestion = '宿舍能不能用超过100W的电器？';
const unrelatedMatches = diversifyDocumentMatches(
  rankDocumentsWithSignals(unrelatedQuestion, [guide, policy, annual], 5, today),
  detectQuestionDimensions(unrelatedQuestion),
  5,
  unrelatedQuestion,
);
assert.ok(!unrelatedMatches.some((document) => document.slug.includes('transfer')),
  '宿舍条件问题不得因“条件”维度强行混入转专业政策');

console.log('PASS M4 多意图检索：维度识别、角色分散、双切片、去重、加权和窗口状态均正常。');
