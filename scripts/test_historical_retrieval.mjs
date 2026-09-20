import assert from 'node:assert/strict';
import { historicalReferenceMeta, requestedYear, selectKnowledgeScope } from '../supabase/functions/_shared/historical.js';

const today = '2026-09-19';
const policy = {
  slug: 'major-transfer-policy', title: '普通本科学生转专业管理办法', category: '学籍管理',
  summary: '转专业条件与流程', content: '普通转专业基本条件。', source_type: 'official_notice',
  status: 'published',
  effective_from: '2024-01-01', effective_until: null,
  metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'policy', allow_historical_reference: false },
};
const notice2026 = {
  slug: 'major-transfer-2026', title: '2026年转专业工作安排', category: '学籍管理',
  summary: '2026年转专业报名时间', content: '2026年4月报名。', source_type: 'official_notice',
  status: 'published',
  effective_from: '2026-04-01', effective_until: '2026-12-31',
  metadata: { source_class: 'official', topic_key: 'major-transfer', document_role: 'annual_notice', notice_year: 2026, allow_historical_reference: true },
};
const notice2025 = {
  ...notice2026, slug: 'major-transfer-2025', title: '2025年转专业工作安排',
  effective_from: '2025-04-01', effective_until: '2025-12-31',
  metadata: { ...notice2026.metadata, notice_year: 2025 },
};
const studentNotice = {
  ...notice2026, slug: 'student-major-transfer-2026', source_type: 'manual',
  metadata: { ...notice2026.metadata, source_class: 'student_curated' },
};
const draftNotice = {
  ...notice2026, slug: 'draft-major-transfer-2026', status: 'draft',
};
const documents = [policy, notice2026, notice2025, studentNotice, draftNotice];

assert.equal(requestedYear('明年转专业什么时候报名', today), 2027);
assert.equal(requestedYear('2028年转专业什么时候报名', today), 2028);
assert.equal(requestedYear('普通转专业需要什么条件', today), null);

const current = selectKnowledgeScope('2026年转专业什么时候报名', documents, today);
assert.equal(current.requestedYear, 2026);
assert.equal(current.historicalDocuments.length, 0);
assert.ok(current.currentDocuments.some((document) => document.slug === notice2026.slug));

const future = selectKnowledgeScope('2027年转专业大概什么时候报名', documents, today);
assert.equal(future.topicKey, 'major-transfer');
assert.equal(future.requestedYear, 2027);
assert.deepEqual(future.historicalDocuments.map((document) => document.slug), [notice2026.slug]);
assert.ok(!future.currentDocuments.some((document) => document.slug === notice2026.slug));
assert.ok(future.currentDocuments.some((document) => document.slug === policy.slug));
assert.ok(!future.historicalDocuments.some((document) => document.slug === studentNotice.slug));
assert.ok(!future.historicalDocuments.some((document) => document.slug === draftNotice.slug));
assert.deepEqual(historicalReferenceMeta(notice2026, 2027), {
  reference_mode: 'historical_reference', notice_year: 2026, requested_year: 2027,
});

const monthWording = selectKnowledgeScope('明年转专业是不是也在4月底？', documents, today);
assert.equal(monthWording.requestedYear, 2027);
assert.deepEqual(monthWording.historicalDocuments.map((document) => document.slug), [notice2026.slug]);
assert.ok(!monthWording.currentDocuments.some((document) => document.slug === notice2026.slug));

const tooOld = selectKnowledgeScope('2030年转专业什么时候报名', documents, today);
assert.equal(tooOld.historicalDocuments.length, 0);

const unrelated = selectKnowledgeScope('明年图书馆几点开门', documents, today);
assert.equal(unrelated.topicKey, null);
assert.equal(unrelated.historicalDocuments.length, 0);

const generic = selectKnowledgeScope('明年大概什么时候报名', documents, today);
assert.equal(generic.topicKey, null);
assert.equal(generic.historicalDocuments.length, 0);

const nonAnnual = selectKnowledgeScope('普通转专业需要什么条件', documents, today);
assert.equal(nonAnnual.requestedYear, null);
assert.equal(nonAnnual.historicalDocuments.length, 0);
assert.ok(nonAnnual.currentDocuments.some((document) => document.slug === notice2026.slug));

console.log('PASS M3 历史参考检索：当前通知优先、三年窗口、官方白名单和历史标记均正常。');
