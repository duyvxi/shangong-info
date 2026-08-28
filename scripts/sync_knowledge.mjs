import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const projectUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const printSql = process.argv.includes('--print-sql');

const source = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(`${source}\n;globalThis.__KNOWLEDGE_EXPORT__ = { ITEMS, CATEGORIES };`, context, {
  filename: 'js/data.js',
});

const { ITEMS: items, CATEGORIES: categories } = context.__KNOWLEDGE_EXPORT__;
const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
const now = new Date().toISOString();

function clean(value) {
  if (value === null || value === undefined || value === '—') return '';
  return String(value).trim();
}

function stringifyTable(table) {
  if (!table) return '';
  if (Array.isArray(table)) return table.map((row) => JSON.stringify(row)).join('\n');
  const headers = Array.isArray(table.headers) ? table.headers.join('｜') : '';
  const rows = Array.isArray(table.rows)
    ? table.rows.map((row) => Array.isArray(row) ? row.join('｜') : JSON.stringify(row)).join('\n')
    : '';
  return [clean(table.title), headers, rows].filter(Boolean).join('\n');
}

function stringifyKv(kv) {
  if (!Array.isArray(kv)) return '';
  return kv.map((entry) => {
    if (Array.isArray(entry)) return entry.filter(Boolean).join('：');
    if (entry && typeof entry === 'object') {
      return `${clean(entry.key || entry.label)}：${clean(entry.value)}`;
    }
    return clean(entry);
  }).filter(Boolean).join('\n');
}

function toDocument(item) {
  const sections = [
    `标题：${clean(item.title)}`,
    `分类：${categoryNames.get(item.cat) || clean(item.cat)}`,
    item.object && `适用对象：${clean(item.object)}`,
    item.time && `办理时间：${clean(item.time)}`,
    item.dept && `负责部门：${clean(item.dept)}`,
    item.place && item.place !== '—' && `办理地点：${clean(item.place)}`,
    item.material && item.material !== '—' && `所需材料：${clean(item.material)}`,
    item.phone && `联系电话：${clean(item.phone)}`,
    item.summary && `摘要：${clean(item.summary)}`,
    item.body && `正文：${clean(item.body)}`,
    Array.isArray(item.steps) && item.steps.length > 0
      ? `办理步骤：\n${item.steps.map((step, index) => `${index + 1}. ${clean(step)}`).join('\n')}`
      : '',
    item.notes && `注意事项：${clean(item.notes)}`,
    stringifyTable(item.table) && `相关表格：\n${stringifyTable(item.table)}`,
    stringifyKv(item.kv) && `补充信息：\n${stringifyKv(item.kv)}`,
  ].filter(Boolean);

  const content = sections.join('\n\n');
  const checksum = createHash('sha256').update(content).digest('hex');
  const sourceDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(item.date)) ? clean(item.date) : null;
  const sourceUrl = /^https?:\/\//i.test(clean(item.url)) ? clean(item.url) : null;

  return {
    slug: clean(item.slug),
    title: clean(item.title),
    category: categoryNames.get(item.cat) || clean(item.cat),
    summary: clean(item.summary),
    content,
    source_url: sourceUrl,
    source_type: 'curated',
    source_date: sourceDate,
    verified_at: null,
    status: 'published',
    checksum,
    metadata: {
      category_id: item.cat,
      priority: clean(item.priority),
      department: clean(item.dept),
      phone: clean(item.phone),
    },
    updated_at: now,
  };
}

const documents = items.map(toDocument).filter((document) => document.slug && document.title && document.content);

if (printSql) {
  const json = JSON.stringify(documents);
  console.log(`
insert into public.knowledge_documents (
  slug, title, category, summary, content, source_url, source_type,
  source_date, verified_at, status, checksum, metadata, updated_at
)
select
  item.slug, item.title, item.category, item.summary, item.content,
  item.source_url, item.source_type, item.source_date, item.verified_at,
  item.status, item.checksum, item.metadata, item.updated_at
from jsonb_to_recordset($knowledge$${json}$knowledge$::jsonb) as item(
  slug text, title text, category text, summary text, content text,
  source_url text, source_type text, source_date date, verified_at timestamptz,
  status text, checksum text, metadata jsonb, updated_at timestamptz
)
on conflict (slug) do update set
  title = excluded.title,
  category = excluded.category,
  summary = excluded.summary,
  content = excluded.content,
  source_url = excluded.source_url,
  source_type = excluded.source_type,
  source_date = excluded.source_date,
  verified_at = excluded.verified_at,
  status = excluded.status,
  checksum = excluded.checksum,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;
`);
  process.exit(0);
}

if (!projectUrl || !secretKey) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY。');
  process.exit(1);
}

for (let index = 0; index < documents.length; index += 50) {
  const batch = documents.slice(index, index + 50);
  const headers = {
    apikey: secretKey,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;

  const response = await fetch(`${projectUrl}/rest/v1/knowledge_documents?on_conflict=slug`, {
    method: 'POST',
    headers,
    body: JSON.stringify(batch),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`同步失败 (${response.status})：${detail}`);
  }
}

console.log(`已同步 ${documents.length} 条校园知识，未上传任何模型密钥或聊天记录。`);
