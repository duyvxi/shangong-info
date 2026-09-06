import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { rankDocuments } from '../supabase/functions/_shared/retrieval.js';
import { validateAndPrepare } from './import_manual_knowledge.mjs';

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
const manualCollection = JSON.parse(await readFile(new URL('../knowledge/student-curated-2026-09.json', import.meta.url), 'utf8'));
documents.push(...validateAndPrepare(manualCollection));

const cases = [
  { question: '新生报到要带什么材料', expected: ['xinsheng-baodao'] },
  { question: '宿舍可以使用哪些电器', expected: ['sushe-dianqi-yaoqiu'] },
  { question: '挂科以后补考怎么办', expected: ['xuefen-leixing'] },
  { question: '家庭困难怎么申请助学金', expected: ['xuefei-zizhu'] },
  { question: '毕业论文和实习要注意什么', expected: ['shixi-lunwen'] },
  { question: '2027年寒假什么时候开始', expected: ['manual-calendar-2026-2027-semester-1'] },
  { question: '东校区能坐哪些公交车', expected: ['manual-bus-east-campus-overview-2026-09'] },
  { question: '52路到山东工商学院西门吗', expected: ['manual-bus-route-52-2026-09'] },
  { question: '第三餐厅有什么吃的', expected: ['manual-dining-east-third-2026-09'] },
  { question: '扇苑餐厅晚饭几点', expected: ['manual-dining-west-shanyuan-2026-09'] },
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
