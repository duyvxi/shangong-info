import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rankDocuments } from '../supabase/functions/_shared/retrieval.js';
import { validateAndPrepare } from './import_manual_knowledge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CASES = path.join(ROOT, 'quality', 'ai-answer-quality-cases.json');
const DEFAULT_KNOWLEDGE = path.join(ROOT, 'knowledge');

function normalized(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function includesAny(text, candidates) {
  const haystack = normalized(text);
  return candidates.some((candidate) => haystack.includes(normalized(candidate)));
}

const CLAIM_NEGATIONS = ['无法确认', '不能确认', '无法保证', '不能保证', '不能确定', '不确定', '没有资料', '未有资料', '并非', '不是', '未必', '不一定'];
const CLAIM_CONTRASTS = ['但', '不过', '然而', '其实'];

function includesForbiddenClaim(text, pattern) {
  const needle = normalized(pattern);
  if (!needle) return false;
  const segments = String(text || '').split(/[。！？!?；;\n]+/);
  return segments.some((segment) => {
    const haystack = normalized(segment);
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const before = haystack.slice(Math.max(0, index - 40), index);
      const negationIndex = Math.max(...CLAIM_NEGATIONS.map((marker) => before.lastIndexOf(normalized(marker))));
      const negated = negationIndex >= 0
        && !CLAIM_CONTRASTS.some((marker) => before.slice(negationIndex).includes(normalized(marker)));
      if (!negated) return true;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return false;
  });
}

function assertDataset(dataset) {
  if (dataset?.schema_version !== 1 || !Array.isArray(dataset.cases) || dataset.cases.length !== 24) {
    throw new Error('质量评测集必须是 schema_version=1，并固定包含 24 道题。');
  }
  const ids = new Set();
  for (const testCase of dataset.cases) {
    if (!/^[a-z]+-\d{2}$/.test(testCase.id) || ids.has(testCase.id)) throw new Error(`题目 ID 无效或重复：${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.question || !['answer', 'historical_reference', 'abstain'].includes(testCase.expected_behavior)) {
      throw new Error(`题目 ${testCase.id} 缺少问题或预期行为无效。`);
    }
    if (!Array.isArray(testCase.required_source_groups) || !Array.isArray(testCase.required_points)) {
      throw new Error(`题目 ${testCase.id} 的来源或答案点格式无效。`);
    }
  }
  return dataset;
}

function clean(value) {
  if (value === null || value === undefined || value === '—') return '';
  return String(value).trim();
}

function staticItemContent(item) {
  const table = item.table && typeof item.table === 'object'
    ? [item.table.title, ...(item.table.headers || []), ...(item.table.rows || []).flat()].filter(Boolean).join('\n')
    : '';
  return [
    item.object && `适用对象：${clean(item.object)}`,
    item.time && `办理时间：${clean(item.time)}`,
    item.material && `所需材料：${clean(item.material)}`,
    item.summary,
    item.body,
    ...(item.steps || []),
    item.notes,
    table,
  ].filter(Boolean).join('\n');
}

export async function loadDocuments({ root = ROOT, knowledgeDir = DEFAULT_KNOWLEDGE } = {}) {
  const source = await readFile(path.join(root, 'js', 'data.js'), 'utf8');
  const context = vm.createContext({ window: {} });
  vm.runInContext(`${source}\n;globalThis.__ITEMS__ = ITEMS;`, context, { filename: 'js/data.js' });
  const documents = context.__ITEMS__.map((item) => ({
    slug: item.slug,
    title: item.title,
    category: item.cat,
    summary: item.summary || '',
    content: staticItemContent(item),
  }));

  const files = (await readdir(knowledgeDir)).filter((name) => name.endsWith('.json')).sort();
  for (const name of files) {
    const collection = JSON.parse(await readFile(path.join(knowledgeDir, name), 'utf8'));
    documents.push(...validateAndPrepare(collection));
  }
  return documents;
}

function sourceGroupsCovered(groups, slugs) {
  return groups.filter((group) => group.some((slug) => slugs.includes(slug))).length;
}

function scorePoints(points, text) {
  const covered = points.filter((point) => includesAny(text, point.any || []));
  return { covered: covered.length, total: points.length, missing: points.filter((point) => !covered.includes(point)).map((point) => point.label) };
}

export function evaluateKnowledge(cases, documents, limit = 5) {
  const results = cases.map((testCase) => {
    const matches = rankDocuments(testCase.question, documents, limit);
    const slugs = matches.map((item) => item.slug);
    const groupsCovered = sourceGroupsCovered(testCase.required_source_groups, slugs);
    const points = testCase.expected_behavior === 'abstain'
      ? { covered: 0, total: 0, missing: [] }
      : scorePoints(testCase.required_points, matches.map((item) => `${item.title}\n${item.summary}\n${item.content}`).join('\n'));
    return {
      id: testCase.id,
      category: testCase.category,
      source_groups_covered: groupsCovered,
      source_groups_total: testCase.required_source_groups.length,
      knowledge_points_covered: points.covered,
      knowledge_points_total: points.total,
      missing_points: points.missing,
      top_slugs: slugs,
    };
  });
  const assessed = results.filter((item) => item.source_groups_total > 0);
  const totalGroups = assessed.reduce((sum, item) => sum + item.source_groups_total, 0);
  const coveredGroups = assessed.reduce((sum, item) => sum + item.source_groups_covered, 0);
  const totalPoints = assessed.reduce((sum, item) => sum + item.knowledge_points_total, 0);
  const coveredPoints = assessed.reduce((sum, item) => sum + item.knowledge_points_covered, 0);
  return {
    mode: 'knowledge',
    summary: {
      cases: results.length,
      assessed_cases: assessed.length,
      retrieval_case_pass_rate: assessed.length
        ? assessed.filter((item) => item.source_groups_covered === item.source_groups_total).length / assessed.length
        : null,
      source_group_coverage: totalGroups ? coveredGroups / totalGroups : null,
      retrieved_knowledge_point_coverage: totalPoints ? coveredPoints / totalPoints : null,
    },
    cases: results,
  };
}

export function evaluateAnswers(cases, responseCases) {
  const responses = new Map(responseCases.map((item) => [item.id, item]));
  const results = cases.map((testCase) => {
    const response = responses.get(testCase.id) || {};
    const answer = String(response.answer || '');
    const sourceSlugs = Array.isArray(response.sources)
      ? response.sources.map((source) => typeof source === 'string' ? source : source?.slug).filter(Boolean)
      : [];
    const points = scorePoints(testCase.required_points, answer);
    const groupsCovered = sourceGroupsCovered(testCase.required_source_groups, sourceSlugs);
    const forbiddenHits = (testCase.forbidden || []).filter((pattern) => includesForbiddenClaim(answer, pattern));
    const citationPresent = testCase.expected_behavior === 'abstain' || /\[\d+\]/.test(answer);
    return {
      id: testCase.id,
      category: testCase.category,
      behavior: testCase.expected_behavior,
      points_covered: points.covered,
      points_total: points.total,
      missing_points: points.missing,
      source_groups_covered: groupsCovered,
      source_groups_total: testCase.required_source_groups.length,
      forbidden_hits: forbiddenHits,
      citation_present: citationPresent,
      passed: points.covered === points.total
        && groupsCovered === testCase.required_source_groups.length
        && forbiddenHits.length === 0
        && citationPresent,
    };
  });
  const totalPoints = results.reduce((sum, item) => sum + item.points_total, 0);
  const coveredPoints = results.reduce((sum, item) => sum + item.points_covered, 0);
  const historical = results.filter((item) => item.behavior === 'historical_reference');
  const abstain = results.filter((item) => item.behavior === 'abstain');
  return {
    mode: 'answers',
    summary: {
      cases: results.length,
      complete_case_rate: results.filter((item) => item.passed).length / results.length,
      answer_point_coverage: totalPoints ? coveredPoints / totalPoints : null,
      citation_rate: results.filter((item) => item.citation_present).length / results.length,
      historical_label_rate: historical.length ? historical.filter((item) => item.passed).length / historical.length : null,
      abstention_rate: abstain.length ? abstain.filter((item) => item.passed).length / abstain.length : null,
      forbidden_claim_cases: results.filter((item) => item.forbidden_hits.length > 0).length,
    },
    cases: results,
  };
}

function percent(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function printReport(report) {
  const summary = report.summary;
  console.log(`质量基线模式：${report.mode === 'knowledge' ? '离线知识就绪度' : '回答质量'}`);
  if (report.mode === 'knowledge') {
    console.log(`题目：${summary.cases}；可离线评估：${summary.assessed_cases}`);
    console.log(`正确来源进入前 5 条：${percent(summary.retrieval_case_pass_rate)}`);
    console.log(`来源组覆盖率：${percent(summary.source_group_coverage)}`);
    console.log(`召回资料关键点覆盖率：${percent(summary.retrieved_knowledge_point_coverage)}`);
  } else {
    console.log(`完整通过率：${percent(summary.complete_case_rate)}`);
    console.log(`答案关键点覆盖率：${percent(summary.answer_point_coverage)}`);
    console.log(`引用率：${percent(summary.citation_rate)}`);
    console.log(`历史资料正确标注率：${percent(summary.historical_label_rate)}`);
    console.log(`无依据克制率：${percent(summary.abstention_rate)}`);
  }
  for (const item of report.cases.filter((entry) => entry.missing_points.length || entry.forbidden_hits?.length
    || entry.source_groups_covered !== entry.source_groups_total)) {
    const parts = [];
    if (item.source_groups_covered !== item.source_groups_total) parts.push(`来源 ${item.source_groups_covered}/${item.source_groups_total}`);
    if (item.missing_points.length) parts.push(`缺少：${item.missing_points.join('、')}`);
    if (item.forbidden_hits?.length) parts.push(`禁用表述：${item.forbidden_hits.join('、')}`);
    console.log(`FAIL ${item.id} ${parts.join('；')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : '';
  };
  const dataset = assertDataset(JSON.parse(await readFile(value('--cases') || DEFAULT_CASES, 'utf8')));
  const responsesPath = value('--responses');
  const report = responsesPath
    ? evaluateAnswers(dataset.cases, JSON.parse(await readFile(responsesPath, 'utf8')).cases || [])
    : evaluateKnowledge(dataset.cases, await loadDocuments());
  printReport(report);
  const output = value('--output');
  if (output) {
    await writeFile(output, JSON.stringify({ schema_version: 1, created_at: new Date().toISOString(), ...report }, null, 2), { flag: 'wx' });
    console.log(`报告已写入 ${output}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
