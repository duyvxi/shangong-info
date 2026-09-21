import { rankDocuments, topicMatchesQuestion } from './retrieval.js';

const ANNUAL_INTENT = /什么时候|几月|日期|时间|报名|安排|通知|截止|开始|开放/;
const MONTH_INTENT = /\d{1,2}\s*月/;

function hasAnnualIntent(question) {
  return ANNUAL_INTENT.test(question) || MONTH_INTENT.test(question);
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function noticeYear(document) {
  const year = Number(document?.metadata?.notice_year);
  return Number.isInteger(year) ? year : null;
}

function isApprovedHistoricalNotice(document) {
  return document?.status === 'published'
    && document?.source_type === 'official_notice'
    && document?.metadata?.source_class === 'official'
    && document?.metadata?.document_role === 'annual_notice'
    && document?.metadata?.allow_historical_reference === true
    && typeof document?.metadata?.topic_key === 'string'
    && document.metadata.topic_key.trim().length > 0
    && noticeYear(document) !== null;
}

function isEffective(document, today) {
  return (!document.effective_from || document.effective_from <= today)
    && (!document.effective_until || document.effective_until >= today);
}

export function requestedYear(question, today = shanghaiToday()) {
  const currentYear = Number(String(today).slice(0, 4));
  const explicit = String(question || '').match(/\b(20\d{2})\s*年?/);
  if (explicit) return Number(explicit[1]);
  if (/明年|下一年|下年度/.test(question)) return currentYear + 1;
  if (/今年|本年度/.test(question)) return currentYear;
  if (/去年|上一年|上年度/.test(question)) return currentYear - 1;
  return hasAnnualIntent(question) ? currentYear : null;
}

export function selectKnowledgeScope(question, documents, today = shanghaiToday()) {
  const activeDocuments = documents.filter((document) => isEffective(document, today));
  const targetYear = requestedYear(question, today);
  if (!targetYear || !hasAnnualIntent(question)) {
    return { currentDocuments: activeDocuments, historicalDocuments: [], requestedYear: null, topicKey: null };
  }

  const eligibleNotices = documents.filter((document) =>
    isApprovedHistoricalNotice(document) && topicMatchesQuestion(question, document)
  );
  // 只用标题和分类识别主题，避免“报名、时间”等通用词从正文中误选其他事项。
  const topicMatch = rankDocuments(question, eligibleNotices.map((document) => ({
    ...document,
    summary: '',
    content: '',
  })), 1)[0];
  const topicKey = topicMatch?.metadata?.topic_key || null;
  if (!topicKey) {
    return { currentDocuments: activeDocuments, historicalDocuments: [], requestedYear: targetYear, topicKey: null };
  }

  const topicNotices = eligibleNotices.filter((document) => document.metadata.topic_key === topicKey);
  const currentNoticeExists = topicNotices.some((document) =>
    noticeYear(document) === targetYear && isEffective(document, today)
  );
  const currentDocuments = activeDocuments.filter((document) =>
    !(isApprovedHistoricalNotice(document)
      && document.metadata.topic_key === topicKey
      && noticeYear(document) !== targetYear)
  );

  if (currentNoticeExists) {
    return { currentDocuments, historicalDocuments: [], requestedYear: targetYear, topicKey };
  }

  const historicalDocuments = topicNotices
    .filter((document) => {
      const year = noticeYear(document);
      return year < targetYear && year >= targetYear - 3;
    })
    .sort((a, b) => noticeYear(b) - noticeYear(a))
    .slice(0, 1);

  return { currentDocuments, historicalDocuments, requestedYear: targetYear, topicKey };
}

export function historicalReferenceMeta(document, targetYear) {
  const year = noticeYear(document);
  return {
    reference_mode: 'historical_reference',
    notice_year: year,
    requested_year: targetYear,
  };
}
