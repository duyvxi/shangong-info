import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkDocument, contentHash, normalizeWhitespace } from './knowledge-chunking.mjs';
import { validateAndPrepare } from './import_manual_knowledge.mjs';

assert.equal(normalizeWhitespace('第一行\r\n\r\n\r\n第二行'), '第一行\n\n第二行');
assert.equal(contentHash('同一内容'), contentHash('同一内容'));
assert.notEqual(contentHash('内容甲'), contentHash('内容乙'));

const short = chunkDocument({ title: '学生会', content: '组织简介。\n\n部门设置。' });
assert.equal(short.length, 1);
assert.equal(short[0].chunk_index, 0);
assert.equal(short[0].title, '学生会');

const longText = Array.from({ length: 30 }, (_, index) => `第${index + 1}段：这是用于测试知识切片边界和语义完整性的校园资料。`).join('\n\n');
const chunks = chunkDocument({ title: '长资料', content: longText }, { maxChars: 300, overlapChars: 60 });
assert.ok(chunks.length > 1);
assert.ok(chunks.every((chunk) => chunk.content.length <= 360));
assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_, index) => index));
assert.ok(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.content_hash)));

const manualSource = JSON.parse(await readFile(new URL('../knowledge/student-curated-2026-09.json', import.meta.url), 'utf8'));
const manualDocuments = validateAndPrepare(manualSource);
assert.equal(manualDocuments.length, 17);
assert.equal(new Set(manualDocuments.map((document) => document.slug)).size, manualDocuments.length);
assert.ok(manualDocuments.every((document) => /^[a-f0-9]{64}$/.test(document.checksum)));
assert.ok(manualDocuments.filter((document) => document.source_type === 'manual').every((document) => document.metadata.source_class === 'student_curated'));
assert.equal(
  manualDocuments.find((document) => document.slug === 'manual-bus-route-62-before-2026-09-10')?.effective_until,
  '2026-09-09',
);

console.log(`PASS 第二阶段知识切片测试：生成 ${chunks.length} 个长文切片，校验 ${manualDocuments.length} 篇人工资料。`);
