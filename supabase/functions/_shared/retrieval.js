const STOP_WORDS = new Set([
  '什么', '怎么', '怎样', '如何', '可以', '需要', '是否', '请问', '一下', '关于',
  '学校', '山商', '山东工商学院', '同学', '学生', '我要', '想要', '知道', '规定',
]);

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}
export function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const tokens = new Set();
  const latinWords = normalized.match(/[a-z0-9]{2,}/g) || [];
  latinWords.forEach((word) => tokens.add(word));

  const chineseRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  for (const run of chineseRuns) {
    if (run.length <= 4 && !STOP_WORDS.has(run)) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!STOP_WORDS.has(pair)) tokens.add(pair);
    }
  }

  return [...tokens].filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function scoreDocument(question, document) {
  const query = normalizeText(question);
  const title = normalizeText(document.title);
  const summary = normalizeText(document.summary);
  const category = normalizeText(document.category);
  const content = normalizeText(document.content);
  const tokens = tokenize(query);

  let score = 0;
  if (title && query.includes(title)) score += 12;
  if (query && title.includes(query)) score += 10;

  for (const token of tokens) {
    if (title.includes(token)) score += 5;
    if (category.includes(token)) score += 3;
    if (summary.includes(token)) score += 2;
    if (content.includes(token)) score += 1;
  }

  const matchedTokens = tokens.filter((token) =>
    `${title} ${summary} ${category} ${content}`.includes(token)
  ).length;

  if (tokens.length > 0) score += (matchedTokens / tokens.length) * 4;
  return Number(score.toFixed(3));
}

export function rankDocuments(question, documents, limit = 5) {
  return documents
    .map((document) => ({ ...document, retrieval_score: scoreDocument(question, document) }))
    .filter((document) => document.retrieval_score >= 2)
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, limit);
}
