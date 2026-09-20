import { normalizeText, scoreDocument } from './retrieval.js';

const DIMENSION_RULES = [
  ['时间', /20\d{2}\s*年|什么时候|几月|日期|时间|截止|开始|结束|报名|开放|几点|多久|哪天|\d{1,2}\s*月/],
  ['条件', /条件|要求|资格|适用|年级|哪些情况|能不能|可以吗|限制|对象|处分|绩点|不得|不能申请/],
  ['材料', /材料|要交什么|提交什么|需要带|带什么|申请表|证明|证件/],
  ['流程', /流程|步骤|怎么办|如何|怎么申请|怎么开|接下来|审核|考核|办理|审批|公示/],
  ['地点', /哪里|在哪|地点|地址|几楼|校区|位置|办公室/],
  ['联系方式', /电话|联系方式|联系谁|咨询|邮箱|座机/],
];

export function shanghaiToday(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function detectQuestionDimensions(question) {
  return DIMENSION_RULES.filter(([, pattern]) => pattern.test(String(question || ''))).map(([name]) => name);
}

function explicitQuestionYear(question) {
  const match = String(question || '').match(/\b(20\d{2})\s*年?/);
  return match ? Number(match[1]) : null;
}

function verifiedBoost(document, today) {
  if (!document.verified_at) return 0;
  const verified = Date.parse(document.verified_at);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(verified) || !Number.isFinite(now) || verified > now + 86400000) return 0;
  const ageDays = (now - verified) / 86400000;
  if (ageDays <= 180) return 1.5;
  if (ageDays <= 365) return 0.75;
  return 0;
}

export function retrievalSignalBoost(question, document, today = shanghaiToday()) {
  const dimensions = detectQuestionDimensions(question);
  const role = String(document?.metadata?.document_role || '');
  const noticeYear = Number(document?.metadata?.notice_year);
  const targetYear = explicitQuestionYear(question) || Number(today.slice(0, 4));
  const query = normalizeText(question);
  const title = normalizeText(document.title);
  let boost = 0;

  // scoreDocument 已对完整标题匹配显著加权；这里补充来源、年份、角色和核验时效。
  if (document.source_type === 'official_notice' || document?.metadata?.source_class === 'official') boost += 2;
  if (title && (query.includes(title) || title.includes(query))) boost += 4;
  if (role === 'annual_notice' && dimensions.includes('时间')) boost += 3;
  if (role === 'annual_notice' && Number.isInteger(noticeYear)) boost += noticeYear === targetYear ? 6 : -4;
  if (role === 'policy' && dimensions.includes('条件')) boost += 5;
  if (role === 'policy' && dimensions.some((item) => ['材料', '流程'].includes(item))) boost += 2;
  boost += verifiedBoost(document, today);
  return Number(boost.toFixed(3));
}

export function rankDocumentsWithSignals(question, documents, limit = 8, today = shanghaiToday()) {
  return documents
    .map((document) => ({
      ...document,
      retrieval_score: Number((scoreDocument(question, document) + retrievalSignalBoost(question, document, today)).toFixed(3)),
    }))
    .filter((document) => document.retrieval_score >= 2)
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, limit);
}

function semanticContribution(row, rank) {
  const strength = Math.max(0, Math.min(Number(row.semantic_score) || 0, 1));
  return { strength, value: strength * 0.65 + 0.35 / (rank + 1) };
}

export function fuseDocumentMatches(keywordMatches, semanticMatches, limit = 8) {
  const combined = new Map();

  keywordMatches.forEach((document, rank) => {
    const keywordStrength = Math.min(document.retrieval_score / 20, 1);
    combined.set(document.slug, {
      ...document,
      retrieval_score: keywordStrength * 0.35 + 0.35 / (rank + 1),
      retrieval_method: 'keyword',
      _keyword_rank: rank,
      _semantic_chunks: [],
    });
  });

  semanticMatches.forEach((row, rank) => {
    const contribution = semanticContribution(row, rank);
    const existing = combined.get(row.slug);
    const chunk = { id: row.chunk_id, content: row.content, score: contribution.strength, rank };
    if (existing) {
      const duplicate = existing._semantic_chunks.some((item) =>
        (chunk.id && item.id === chunk.id) || (!chunk.id && item.content === chunk.content)
      );
      if (!duplicate) existing._semantic_chunks.push(chunk);
      if (existing._semantic_chunks.length <= 2) {
        existing.retrieval_score += contribution.value * (existing._semantic_chunks.length === 1 ? 1 : 0.25);
      }
      existing.retrieval_method = 'hybrid';
      existing.semantic_score = Math.max(existing.semantic_score || 0, contribution.strength);
      return;
    }

    combined.set(row.slug, {
      ...row,
      summary: row.summary || '',
      retrieval_score: contribution.value,
      retrieval_method: 'semantic',
      semantic_score: contribution.strength,
      _semantic_rank: rank,
      _semantic_chunks: [chunk],
    });
  });

  return [...combined.values()]
    .map((document) => {
      const chunks = document._semantic_chunks
        .sort((a, b) => b.score - a.score || a.rank - b.rank)
        .slice(0, 2);
      const content = chunks.length ? chunks[0].content : document.content;
      const additionalContents = chunks.slice(1).map((chunk) => chunk.content);
      const chunkIds = chunks.map((chunk) => chunk.id).filter(Boolean);
      const { _keyword_rank, _semantic_rank, _semantic_chunks, ...clean } = document;
      return { ...clean, content, additional_contents: additionalContents, chunk_ids: chunkIds };
    })
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, limit);
}

export function diversifyDocumentMatches(matches, dimensions, limit = 5) {
  const selected = [];
  const add = (document) => {
    if (document && !selected.some((item) => item.slug === document.slug)) selected.push(document);
  };
  const needsAnnual = dimensions.includes('时间');
  const needsPolicy = dimensions.some((item) => ['条件', '材料', '流程'].includes(item));
  if (needsAnnual) add(matches.find((document) => document?.metadata?.document_role === 'annual_notice'));
  if (needsPolicy) add(matches.find((document) => document?.metadata?.document_role === 'policy'));
  const selectedTopics = new Set(selected.map((document) => document?.metadata?.topic_key).filter(Boolean));
  const candidates = selectedTopics.size === 1
    ? matches.filter((document) => selectedTopics.has(document?.metadata?.topic_key))
    : matches;
  candidates.forEach(add);
  return selected.slice(0, limit);
}

export function applicationWindowState(document, now = Date.now()) {
  const start = document?.metadata?.application_start;
  const end = document?.metadata?.application_end;
  if (!start || !end) return null;
  const nowValue = Number(now);
  const startValue = Date.parse(`${start}T00:00:00+08:00`);
  const endValue = Date.parse(end);
  if (![nowValue, startValue, endValue].every(Number.isFinite)) return null;
  if (nowValue < startValue) return '未开始';
  if (nowValue <= endValue) return '进行中';
  return '已结束';
}

export function composeDocumentContent(document, maxChars = 4000) {
  const fragments = [document.content, ...(document.additional_contents || [])].filter(Boolean);
  let remaining = maxChars;
  const output = [];
  fragments.slice(0, 2).forEach((fragment, index) => {
    if (remaining <= 0) return;
    const prefix = index === 0 ? '' : '\n\n[同一资料的补充片段]\n';
    const value = String(fragment).slice(0, Math.max(0, remaining - prefix.length));
    if (value) {
      output.push(`${prefix}${value}`);
      remaining -= prefix.length + value.length;
    }
  });
  return output.join('');
}
