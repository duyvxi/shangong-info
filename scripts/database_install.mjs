import { readFile } from 'node:fs/promises';

const files = [
  'supabase-schema.sql',
  'supabase-ai-phase1.sql',
  'supabase-ai-phase2.sql',
  'supabase-security-phase2.sql',
  'supabase/migrations/20261116000000_knowledge_review.sql',
  'supabase/migrations/20261118000000_restore_project_access.sql',
  'supabase/migrations/20261118000001_sync_static_knowledge.sql',
  'supabase/migrations/20261118000002_ai_usage_cancelled.sql',
  'supabase/migrations/20261118000003_comment_paging.sql',
  'supabase/migrations/20261118000004_feed_identity.sql',
];

// 各文件也能单独迁移。空库安装由外层事务统一提交，避免只装好一半。
const parts = await Promise.all(files.map(async (file) => {
  const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  return `-- ${file}\n${sql.replace(/^begin;\r?$/m, '').replace(/\r?\ncommit;\s*$/i, '').trim()}`;
}));
process.stdout.write(`begin;\n\n${parts.join('\n\n')}\n\ncommit;\n`);
