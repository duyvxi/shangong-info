import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptsDirectory);

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

  if (request.method === 'GET' && requestUrl.pathname === '/rest/v1/knowledge_documents') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([{
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'transport-test',
      title: '传输测试',
      category: '校园服务',
      content: '这是用于验证空响应处理的测试资料。',
      source_url: 'https://www.sdtbu.edu.cn/',
      canonical_url: null,
      status: 'published',
    }]));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/embeddings') {
    let body = '';
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      data: payload.input.map((_, index) => ({ index, embedding: Array(1024).fill(0) })),
    }));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/rest/v1/knowledge_chunks') {
    response.writeHead(201);
    response.end();
    return;
  }

  if (request.method === 'DELETE' && requestUrl.pathname === '/rest/v1/knowledge_chunks') {
    response.writeHead(204);
    response.end();
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/reindex_knowledge.mjs'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SUPABASE_URL: baseUrl,
        SUPABASE_SECRET_KEY: 'sb_secret_transport_test',
        AI_EMBEDDING_API_KEY: 'embedding-test-key',
        AI_EMBEDDING_API_BASE_URL: baseUrl,
        AI_EMBEDDING_MODEL: 'text-embedding-v4',
        AI_EMBEDDING_DIMENSIONS: '1024',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[ready\] transport-test: 1 个切片/);
  assert.match(result.stdout, /向量重建完成：1 篇资料，共 1 个切片/);
  console.log('PASS 向量上传空响应测试：201 空响应被正确识别为成功。');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
