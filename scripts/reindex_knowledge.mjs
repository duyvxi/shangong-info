import { chunkDocument, contentHash } from './knowledge-chunking.mjs';

const projectUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const embeddingApiKey = process.env.AI_EMBEDDING_API_KEY || process.env.AI_API_KEY || '';
const embeddingBaseUrl = String(
  process.env.AI_EMBEDDING_API_BASE_URL || process.env.AI_API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
).replace(/\/$/, '');
const embeddingModel = process.env.AI_EMBEDDING_MODEL || 'text-embedding-v4';
const embeddingDimensions = Number(process.env.AI_EMBEDDING_DIMENSIONS || 1024);
const dryRun = process.argv.includes('--dry-run');

if (!projectUrl || !secretKey) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY。');
  process.exit(1);
}
if (!dryRun && !embeddingApiKey) {
  console.error('缺少 AI_EMBEDDING_API_KEY 或 AI_API_KEY。可先使用 --dry-run 只检查切片。');
  process.exit(1);
}
if (embeddingDimensions !== 1024) {
  console.error('当前数据库固定为 1024 维，请将 AI_EMBEDDING_DIMENSIONS 设置为 1024。');
  process.exit(1);
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: secretKey, ...extra };
  if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function supabaseRequest(path, init = {}) {
  const response = await fetch(`${projectUrl}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders(init.headers || {}),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${responseText}`);

  // PostgREST 在 Prefer: return=minimal 的成功写入中可能返回 201 + 空响应体。
  // 空响应代表写入成功，不能继续调用 response.json()，否则 Node 会误报 JSON 解析失败。
  if (!responseText.trim()) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`Supabase ${response.status} 返回了无法解析的内容：${responseText.slice(0, 300)}`);
  }
}

async function createEmbeddings(inputs) {
  const response = await fetch(`${embeddingBaseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${embeddingApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: inputs,
      dimensions: embeddingDimensions,
      encoding_format: 'float',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`向量模型 ${response.status}: ${message}`);
  }
  const rows = Array.isArray(payload.data) ? [...payload.data].sort((a, b) => a.index - b.index) : [];
  if (rows.length !== inputs.length) throw new Error('向量模型返回数量与输入数量不一致。');
  const vectors = rows.map((row) => row.embedding);
  if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== embeddingDimensions)) {
    throw new Error(`向量模型没有返回 ${embeddingDimensions} 维向量。`);
  }
  return vectors;
}

// 分块策略调整时递增版本，让已完成资料重新核对切片哈希。
const signature = `chunk-v1:${embeddingModel}`;
const rpc = (name, payload) => supabaseRequest(`rpc/${name}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
let totalChunks = 0;
let completedDocuments = 0;
let visitedDocuments = 0;

async function indexDocument(document) {
  const chunks = chunkDocument(document);
  totalChunks += chunks.length;
  if (dryRun) {
    console.log(`[dry-run] ${document.slug}: ${chunks.length} 个切片`);
    return;
  }

  const existingChunks = await supabaseRequest(
    `knowledge_chunks?select=chunk_index,content_hash,embedding_model,embedding_status,document_revision&document_id=eq.${encodeURIComponent(document.id)}&embedding=not.is.null&order=chunk_index.asc`
  );
  const existingByIndex = new Map((existingChunks || []).map((chunk) => [chunk.chunk_index, chunk]));
  const preparedChunks = chunks.map((chunk) => {
    const embeddingInput = `${document.title}\n分类：${document.category}\n${chunk.content}`;
    return {
      ...chunk,
      embeddingInput,
      content_hash: contentHash(embeddingInput),
    };
  });
  const pendingChunks = preparedChunks.filter((chunk) => {
    const existing = existingByIndex.get(chunk.chunk_index);
    return !existing
      || existing.document_revision !== document.revision
      || existing.content_hash !== chunk.content_hash
      || existing.embedding_model !== embeddingModel
      || existing.embedding_status !== 'ready';
  });
  const chunkRows = [];
  for (let index = 0; index < pendingChunks.length; index += 10) {
    const batch = pendingChunks.slice(index, index + 10);
    const inputs = batch.map((chunk) => chunk.embeddingInput);
    const vectors = await createEmbeddings(inputs);
    batch.forEach((chunk, offset) => {
      const { embeddingInput: _, ...storedChunk } = chunk;
      chunkRows.push({
        document_id: document.id,
        document_revision: document.revision,
        ...storedChunk,
        embedding: vectors[offset],
        embedding_model: embeddingModel,
        embedding_status: 'ready',
        last_error: null,
        metadata: { category: document.category, slug: document.slug },
        updated_at: new Date().toISOString(),
      });
    });
  }

  if (chunkRows.length) {
    try {
      await supabaseRequest('knowledge_chunks?on_conflict=document_id,chunk_index', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(chunkRows),
      });
    } catch (error) {
      if (!error.message.includes('KNOWLEDGE_INDEX_CHANGED')) throw error;
      console.log(`[skip] ${document.slug}: 正文或发布状态已更新，等待下次索引`);
      return;
    }
  }

  const complete = await rpc('finish_knowledge_index', {
    p_id: document.id, p_revision: document.revision, p_model: embeddingModel, p_signature: signature, p_count: chunks.length,
  });
  if (!complete) {
    console.log(`[skip] ${document.slug}: 当前版本尚未完成，下次继续检查`);
    return;
  }
  completedDocuments += 1;
  console.log(`[ready] ${document.slug}: ${chunks.length} 个切片，本次生成 ${pendingChunks.length} 个向量`);
}

let after = null;
while (true) {
  const page = await rpc('get_knowledge_index_page', {
    p_after: after, p_model: embeddingModel, p_signature: signature, p_include_ready: dryRun,
  });
  if (!page.length) break;
  for (const document of page) {
    visitedDocuments += 1;
    await indexDocument(document);
  }
  // 编号不因入库或索引回写改变，下一页从本页最后一条开始。
  after = page.at(-1).id;
}

console.log(dryRun
  ? `切片检查完成：${visitedDocuments} 篇资料，共 ${totalChunks} 个切片，未写入数据库。`
  : `向量重建完成：${completedDocuments} 篇资料，共 ${totalChunks} 个切片。本轮检查 ${visitedDocuments} 篇。`);
