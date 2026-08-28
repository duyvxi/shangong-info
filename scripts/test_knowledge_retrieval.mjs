import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { rankDocuments } from '../supabase/functions/_shared/retrieval.js';

const source = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(`${source}\n;globalThis.__ITEMS__ = ITEMS;`, context, { filename: 'js/data.js' });

const documents = context.__ITEMS__.map((item) => ({
  slug: item.slug,
  title: item.title,
  category: item.cat,
  summary: item.summary || '',
  content: [item.body, item.notes, ...(item.steps || [])].filter(Boolean).join('\n'),
}));

const cases = [
  { question: '新生报到要带什么材料', expected: ['xinsheng-baodao'] },
  { question: '宿舍可以使用哪些电器', expected: ['sushe-dianqi-yaoqiu'] },
  { question: '挂科以后补考怎么办', expected: ['xuefen-leixing'] },
  { question: '家庭困难怎么申请助学金', expected: ['xuefei-zizhu'] },
  { question: '毕业论文和实习要注意什么', expected: ['shixi-lunwen'] },
];

let failed = 0;
for (const testCase of cases) {
  const results = rankDocuments(testCase.question, documents, 5);
  const slugs = results.map((result) => result.slug);
  const passed = testCase.expected.some((expected) => slugs.some((slug) => slug.includes(expected)));
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.question} -> ${slugs.join(', ') || '无结果'}`);
  if (!passed) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} 个检索用例未通过。`);
  process.exit(1);
}

console.log('\n校园知识检索基础用例全部通过。');
