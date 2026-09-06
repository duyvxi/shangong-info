import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chunkDocument, normalizeWhitespace } from './knowledge-chunking.mjs';

const ALLOWED_SOURCE_TYPES = new Set(['curated', 'official_notice', 'manual']);
const ALLOWED_STATUSES = new Set(['draft', 'published']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_PATTERN = /(?:sb_secret_|service_role|sk-[a-z0-9_-]{16,})/i;

function fail(message) {
  throw new Error(`人工知识校验失败：${message}`);
}

function nullableText(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function validDate(value, field, slug) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!DATE_PATTERN.test(text) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`${slug} 的 ${field} 不是有效的 YYYY-MM-DD 日期`);
  }
  return text;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksumFor(document) {
  const tracked = {
    title: document.title,
    category: document.category,
    summary: document.summary,
    content: document.content,
    source_url: document.source_url,
    canonical_url: document.canonical_url,
    source_type: document.source_type,
    source_date: document.source_date,
    effective_from: document.effective_from,
    effective_until: document.effective_until,
    metadata: document.metadata,
  };
  return createHash('sha256').update(stableJson(tracked), 'utf8').digest('hex');
}

export function validateAndPrepare(collection) {
  if (!collection || typeof collection !== 'object') fail('文件根节点必须是 JSON 对象');
  if (collection.schema_version !== 1) fail('只支持 schema_version=1');
  if (!Array.isArray(collection.documents) || collection.documents.length === 0) fail('documents 不能为空');
  if (collection.documents.length > 200) fail('单个文件最多导入 200 条资料');

  const seen = new Set();
  return collection.documents.map((raw, index) => {
    const position = `第 ${index + 1} 条`;
    const slug = String(raw?.slug || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{2,119}$/.test(slug)) fail(`${position}的 slug 格式无效`);
    if (seen.has(slug)) fail(`slug 重复：${slug}`);
    seen.add(slug);

    const title = normalizeWhitespace(raw.title);
    const category = normalizeWhitespace(raw.category);
    const summary = normalizeWhitespace(raw.summary);
    const content = normalizeWhitespace(raw.content);
    if (title.length < 4 || title.length > 200) fail(`${slug} 的标题长度应为 4～200 个字符`);
    if (category.length < 2 || category.length > 80) fail(`${slug} 的分类长度应为 2～80 个字符`);
    if (summary.length < 8 || summary.length > 500) fail(`${slug} 的摘要长度应为 8～500 个字符`);
    if (content.length < 40 || content.length > 30000) fail(`${slug} 的正文长度应为 40～30000 个字符`);
    if (SECRET_PATTERN.test(`${title}\n${summary}\n${content}`)) fail(`${slug} 疑似包含密钥，已拒绝导入`);

    const sourceType = String(raw.source_type || 'manual').trim();
    const status = String(raw.status || 'draft').trim();
    if (!ALLOWED_SOURCE_TYPES.has(sourceType)) fail(`${slug} 的 source_type 无效`);
    if (!ALLOWED_STATUSES.has(status)) fail(`${slug} 的 status 只能是 draft 或 published`);

    const sourceUrl = nullableText(raw.source_url);
    const canonicalUrl = nullableText(raw.canonical_url);
    for (const [field, value] of [['source_url', sourceUrl], ['canonical_url', canonicalUrl]]) {
      if (value && !/^https:\/\//i.test(value)) fail(`${slug} 的 ${field} 必须使用 HTTPS`);
    }
    if (sourceType === 'official_notice' && !sourceUrl) fail(`${slug} 是官方通知但没有来源链接`);

    const effectiveFrom = validDate(raw.effective_from, 'effective_from', slug);
    const effectiveUntil = validDate(raw.effective_until, 'effective_until', slug);
    if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) {
      fail(`${slug} 的有效开始日期晚于结束日期`);
    }

    const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? structuredClone(raw.metadata)
      : {};
    if (sourceType === 'manual') {
      if (!['student_curated', 'student_submission'].includes(metadata.source_class)) {
        fail(`${slug} 必须在 metadata.source_class 标明学生整理资料`);
      }
      if (metadata.dynamic === true && !effectiveUntil) {
        fail(`${slug} 是动态人工资料，必须设置 effective_until 防止长期使用过期资料`);
      }
    }

    const document = {
      slug,
      title,
      category,
      summary,
      content,
      source_url: sourceUrl,
      canonical_url: canonicalUrl,
      source_type: sourceType,
      source_date: validDate(raw.source_date, 'source_date', slug),
      verified_at: null,
      status,
      content_format: 'manual',
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      last_crawled_at: null,
      metadata,
    };
    document.checksum = checksumFor(document);
    return document;
  });
}

export async function loadKnowledgeFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  let collection;
  try {
    collection = JSON.parse(source);
  } catch (error) {
    fail(`JSON 无法解析：${error.message}`);
  }
  return validateAndPrepare(collection);
}

function serviceHeaders(secretKey, extra = {}) {
  const headers = { apikey: secretKey, ...extra };
  if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function request(projectUrl, secretKey, restPath, init = {}) {
  const response = await fetch(`${projectUrl}/rest/v1/${restPath}`, {
    ...init,
    headers: serviceHeaders(secretKey, init.headers || {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text.trim() ? JSON.parse(text) : null;
}

export async function importDocuments(documents, options) {
  const { projectUrl, secretKey, dryRun = false } = options;
  const totalChunks = documents.reduce((sum, document) => sum + chunkDocument(document).length, 0);
  if (dryRun) return { inserted: documents.length, updated: 0, unchanged: 0, demoted: 0, totalChunks, dryRun: true };
  if (!projectUrl || !secretKey) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY。');

  const existingRows = await request(
    projectUrl,
    secretKey,
    'knowledge_documents?select=id,slug,status,checksum,verified_at&limit=1000',
  );
  const existingBySlug = new Map((existingRows || []).map((row) => [row.slug, row]));
  const changed = [];
  const staleDocumentIds = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let demoted = 0;
  const now = new Date().toISOString();

  for (const document of documents) {
    const existing = existingBySlug.get(document.slug);
    if (existing?.checksum === document.checksum) {
      unchanged += 1;
      continue;
    }

    const next = { ...document, updated_at: now };
    if (existing) {
      updated += 1;
      staleDocumentIds.push(existing.id);
      // 已对外发布的内容一旦变化，自动退回待审核，避免定时任务静默替换答案依据。
      if (existing.status === 'published') {
        next.status = 'draft';
        demoted += 1;
      } else {
        next.status = existing.status;
      }
      next.verified_at = next.status === 'published' ? existing.verified_at : null;
    } else {
      inserted += 1;
    }
    changed.push(next);
  }

  for (let index = 0; index < changed.length; index += 40) {
    await request(projectUrl, secretKey, 'knowledge_documents?on_conflict=slug', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(changed.slice(index, index + 40)),
    });
  }

  for (const documentId of staleDocumentIds) {
    await request(projectUrl, secretKey, `knowledge_chunks?document_id=eq.${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  }

  return { inserted, updated, unchanged, demoted, totalChunks, dryRun: false };
}

async function main() {
  const defaultFile = fileURLToPath(new URL('../knowledge/student-curated-2026-09.json', import.meta.url));
  const fileArgument = process.argv.find((argument) => argument.startsWith('--file='));
  const filePath = fileArgument ? path.resolve(fileArgument.slice('--file='.length)) : defaultFile;
  const dryRun = process.argv.includes('--dry-run');
  const documents = await loadKnowledgeFile(filePath);
  const result = await importDocuments(documents, {
    projectUrl: String(process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    dryRun,
  });

  if (dryRun) {
    console.log(`PASS 人工知识检查：${documents.length} 篇资料，预计 ${result.totalChunks} 个切片，未连接数据库。`);
    return;
  }
  console.log(`人工知识同步完成：新增 ${result.inserted}，更新 ${result.updated}，未变化 ${result.unchanged}。`);
  if (result.demoted) console.log(`安全处理：${result.demoted} 条已发布资料因内容变化而退回待审核。`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
