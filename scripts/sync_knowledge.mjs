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
    source_date: sourceDate,
    checksum,
    metadata: {
      category_id: item.cat,
      priority: clean(item.priority),
      department: clean(item.dept),
      phone: clean(item.phone),
    },
  };
}

const documents = items.map(toDocument).filter((document) => document.slug && document.title && document.content);

if (printSql) {
  const json = JSON.stringify(documents);
  // 避开正文中可能出现的 SQL 文本分隔符。
  let delimiter = '$knowledge$';
  while (json.includes(delimiter)) delimiter = delimiter.replace(/\$$/, '_$');
  console.log(`select public.sync_static_knowledge(${delimiter}${json}${delimiter}::jsonb);`);
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
  };
  if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;

  const response = await fetch(`${projectUrl}/rest/v1/rpc/sync_static_knowledge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_documents: batch }),
  });

  if (!response.ok) {
    throw new Error(`同步失败 (${response.status})。请检查服务端权限和静态知识同步迁移是否已安装。`);
  }
}

console.log(`已同步 ${documents.length} 条校园知识，未上传任何模型密钥或聊天记录。`);
