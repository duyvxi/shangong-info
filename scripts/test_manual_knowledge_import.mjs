import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { importDocuments, loadKnowledgeDirectory, validateAndPrepare } from './import_manual_knowledge.mjs';

const collection = JSON.parse(await readFile(new URL('../knowledge/student-curated-2026-09.json', import.meta.url), 'utf8'));
const documents = validateAndPrepare(collection);
const allDocuments = await loadKnowledgeDirectory(new URL('../knowledge/', import.meta.url));
assert.equal(allDocuments.length, 19);
assert.equal(new Set(allDocuments.map((document) => document.slug)).size, allDocuments.length);
const sameDocument = documents[0];
const changedDocument = documents[1];
assert.equal(changedDocument.effective_until, null);
assert.equal(changedDocument.metadata.allow_no_expiry, true);
const previousVersion = structuredClone(collection.documents[1]);
delete previousVersion.metadata.allow_no_expiry;
assert.throws(
  () => validateAndPrepare({ ...collection, documents: [previousVersion] }),
  /必须设置 effective_until/,
);
previousVersion.effective_until = '2026-12-31';
const [preparedPreviousVersion] = validateAndPrepare({ ...collection, documents: [previousVersion] });
const requests = [];

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  let body = '';
  for await (const part of request) body += part;
  requests.push({ method: request.method, path: url.pathname, search: url.search, body });

  if (request.method === 'GET' && url.pathname === '/rest/v1/knowledge_documents') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([
      { id: 'doc-same', slug: sameDocument.slug, status: 'published', checksum: sameDocument.checksum, verified_at: null },
      { id: 'doc-changed', slug: changedDocument.slug, status: 'published', checksum: preparedPreviousVersion.checksum, verified_at: '2026-09-01T00:00:00Z' },
    ]));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/rest/v1/knowledge_documents') {
    response.writeHead(201);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();

try {
  const result = await importDocuments(documents, {
    projectUrl: `http://127.0.0.1:${address.port}`,
    secretKey: 'sb_secret_test_only',
  });
  assert.deepEqual(
    { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, demoted: result.demoted },
    { inserted: documents.length - 2, updated: 1, unchanged: 1, demoted: 1 },
  );

  const post = requests.find((entry) => entry.method === 'POST');
  const payload = JSON.parse(post.body);
  const updatedDocument = payload.find((row) => row.slug === changedDocument.slug);
  assert.equal(updatedDocument.status, 'draft');
  assert.equal(updatedDocument.effective_until, null);
  assert.ok(payload.every((row) => row.status === 'draft'));
  assert.equal(payload.some((row) => row.slug === sameDocument.slug), false);
  // 清理旧片段由数据库完成，导入脚本不能在写入后再按编号删除。
  assert.ok(!requests.some((entry) => entry.method === 'DELETE'));
  console.log('PASS 人工知识导入测试：重复资料跳过，新增和变化资料进入待审。');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
