import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as timing from '../supabase/functions/_shared/timing.js';
import * as historical from '../supabase/functions/_shared/historical.js';
import * as multiIntent from '../supabase/functions/_shared/multi-intent.js';
import * as retrieval from '../supabase/functions/_shared/retrieval.js';
import { checkAiBatch2 } from './test_ai_batch2.mjs';
import { checkBatch3Browser, checkFeedCollector } from './test_batch3.mjs';

const testDependencies = process.argv[2] ?? resolve(tmpdir(), 'shangong-phase1-db-deps');
const require = createRequire(resolve(testDependencies, 'package.json'));
const { PGlite } = require('@electric-sql/pglite');
const { vector } = require('@electric-sql/pglite-pgvector');
const { chromium } = require('playwright-core');
const adminId = '00000000-0000-4000-8000-000000000001';
const studentId = '00000000-0000-4000-8000-000000000002';
const security = 'supabase-security-phase2.sql';
const review = 'supabase/migrations/20261116000000_knowledge_review.sql';
const access = 'supabase/migrations/20261118000000_restore_project_access.sql';
const sync = 'supabase/migrations/20261118000001_sync_static_knowledge.sql';
const cancellation = 'supabase/migrations/20261118000002_ai_usage_cancelled.sql';
const commentsMigration = 'supabase/migrations/20261118000003_comment_paging.sql';
const feedsMigration = 'supabase/migrations/20261118000004_feed_identity.sql';
const base = ['supabase-schema.sql', 'supabase-ai-phase1.sql', 'supabase-ai-phase2.sql'];
const knowledgeTables = ['knowledge_documents', 'knowledge_chunks', 'knowledge_sources', 'unanswered_questions', 'crawl_jobs'];
const interactions = ['feedbacks', 'submissions', 'comments'];
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const runScript = (path, ...args) => execFileSync(process.execPath,
  [fileURLToPath(new URL(`../scripts/${path}`, import.meta.url)), ...args],
  { encoding: 'utf8', env: {} });
const fixtureItems = ['public', 'archived'].map((name) => ({
  slug: `static-${name}`, cat: 'report', title: `虚构资料 ${name}`, body: '这是虚构的校园说明。',
}));
const fixtureSource = (items) => `const CATEGORIES = [{id:'report',name:'入学报到'}];
  const ITEMS = ${JSON.stringify(items)}; const LINKS = [];`;

async function apply(db, files) {
  for (const path of files) await db.exec(await read(path));
}

async function setRole(db, role, id = null, admin = false) {
  await db.exec('reset role');
  await db.query('select set_config(\'request.jwt.claims\', $1, false)', [JSON.stringify({
    sub: id, app_metadata: { role: admin ? 'admin' : 'student' },
  })]);
  await db.exec(`set role ${role}`);
}

async function seedUsers(db) {
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values
    ($1, 'local-admin@example.test', '{"role":"admin","fixture":true}'),
    ($2, 'local-student@example.test', '{}')`, [adminId, studentId]);
  await db.query("update public.profiles set role = 'admin' where id = $1", [adminId]);
}

async function reviewDocument(db, slug, action) {
  const { rows: [doc] } = await db.query(`select id, revision, status, updated_at::text
    from public.knowledge_documents where slug = $1`, [slug]);
  const { rows: [{ result }] } = await db.query(`select public.review_knowledge_document(
    $1, $2, $3, $4, $5, '测试学生', '虚构来源', '测试复核备注', true) as result`,
  [doc.id, doc.revision, doc.updated_at, doc.status, action]);
  return result;
}

async function checkKnowledgeRoles(db) {
  await setRole(db, 'service_role');
  await db.exec(`insert into public.knowledge_documents (slug, title, category, content, status, checksum) values
    ('fixture-publish', '虚构公开资料', '测试', '测试正文', 'draft', 'fixture-public'),
    ('fixture-draft', '虚构待审资料', '测试', '待审正文', 'draft', 'fixture-draft');
    insert into public.crawl_jobs (status) values ('succeeded');`);
  await db.query(`select * from public.record_unanswered_question($1, '合成问题', '合成问题', '其他', '{}')`, ['a'.repeat(64)]);
  await setRole(db, 'authenticated', adminId, true);
  for (const table of knowledgeTables) await db.query(`select * from public.${table} limit 1`);
  assert.equal((await db.query("select slug from public.knowledge_documents where status = 'draft' and slug like 'fixture-%'")).rows.length, 2);
  assert.equal((await reviewDocument(db, 'fixture-publish', 'publish')).status, 'published');
  assert.equal((await db.query(`select public.resolve_knowledge_gap(
    (select id from public.unanswered_questions where sample_question = '合成问题'),
    'open', 'fixture-publish', 'missing', '虚构复测结果')`)).rows.length, 1);
  for (const role of ['anon', 'authenticated']) {
    await setRole(db, role, role === 'authenticated' ? studentId : null);
    const result = await db.query("select * from public.published_knowledge_documents where slug like 'fixture-%'");
    assert.deepEqual(result.rows.map(({ slug }) => slug), ['fixture-publish']);
    assert.ok(!('last_review' in result.rows[0]) && !('metadata' in result.rows[0]));
  }
  for (const table of knowledgeTables) {
    assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
  }
  assert.equal((await db.query("update public.knowledge_documents set title = '学生修改' where slug = 'fixture-publish'")).affectedRows, 0);
  await assert.rejects(db.query(`select public.review_knowledge_document(null, null, null, null,
    'publish', '测试', '测试', '', true)`), { code: '42501' });
}

async function checkAnonymousForms(db) {
  const origin = 'http://localhost';
  const channel = process.env.TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  const browser = await chromium.launch({ channel, args: ['--disable-background-networking'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    // 真实页面在浏览器运行。所有请求均拦截，SDK 写入转到内存数据库。
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
      const file = url.pathname.slice(1);
      if (!/^(?:(?:index|privacy|terms)\.html|(?:js|css)\/[\w-]+\.(?:js|css))$/.test(file)) return route.abort();
      const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      const body = file === 'js/data.js' ? fixtureSource(fixtureItems) : await read(file);
      await route.fulfill({ body, contentType: `${contentType}; charset=utf-8` });
    });
    await context.exposeFunction('insertLocalRow', async (table, payload) => {
      if (!interactions.includes(table)) return { error: null };
      const fields = Object.keys(payload);
      assert.ok(fields.every((field) => /^[a-z_]+$/.test(field)));
      try {
        const placeholders = fields.map((_, index) => `$${index + 1}`);
        await db.query(`insert into public.${table} (${fields.join(', ')}) values (${placeholders.join(', ')})`, Object.values(payload));
        return { error: null };
      } catch (error) {
        return { error: { message: error.message, code: error.code } };
      }
    });
    await context.exposeFunction('readLocalRows', async (table, filters) => {
      if (!interactions.includes(table)) return { data: [], error: null };
      const fields = Object.keys(filters);
      assert.ok(fields.every((field) => /^[a-z_]+$/.test(field)));
      const conditions = fields.map((field, index) => `${field} = $${index + 1}`);
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      try {
        const { rows } = await db.query(`select * from public.${table} ${where}`, Object.values(filters));
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message, code: error.code } };
      }
    });
    await context.exposeFunction('readLocalComments', async (payload) => {
      const { rows: [{ data }] } = await db.query('select public.get_item_comments($1,$2,$3,$4) as data',
        ['p_item_slug', 'p_user_id', 'p_offset', 'p_parent_id'].map((key) => payload[key]));
      return { data, error: null };
    });
    await context.addInitScript(() => {
      window.supabase = { createClient: () => ({
        rpc: (name, payload) => {
          if (name !== 'get_item_comments') throw new Error('意外的模拟函数');
          return window.readLocalComments(payload);
        },
        from(table) {
          const filters = {};
          const query = {
            insert: (payload) => window.insertLocalRow(table, payload),
            eq(field, value) { filters[field] = value; return query; },
            then: (resolve, reject) => window.readLocalRows(table, filters).then(resolve, reject),
          };
          for (const method of ['select', 'limit', 'order', 'range', 'gte', 'in', 'maybeSingle']) query[method] = () => query;
          return query;
        },
      }) };
    });
    await setRole(db, 'anon');
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`${origin}/index.html#/ai`);
    await page.locator('#ai-input-privacy').filter({ hasText: '保存去除部分个人信息的问题样本' }).waitFor();
    await page.getByRole('link', { name: '我的', exact: true }).click();
    await page.locator('.profile-edit').click();
    await page.locator('#modal-auth').getByText('发表评论或投稿时会随内容一起保存', { exact: false }).waitFor();
    await page.locator('#auth-nickname').fill('虚构昵称');
    await page.locator('#auth-agree').check();
    await page.locator('#btn-do-auth').click();
    await page.locator('#modal-auth').waitFor({ state: 'hidden' });

    await page.goto(`${origin}/index.html#/info/static-public`);
    await page.locator('#feedback-current').click();
    await page.locator('#fb-desc').fill('虚构纠错内容');
    await page.locator('#btn-do-feedback').click();
    await page.locator('#fb-msg').filter({ hasText: '反馈已提交' }).waitFor();
    await page.locator('#modal-feedback').waitFor({ state: 'hidden' });

    await page.locator('.comment-tip').filter({ hasText: '留言和昵称会保存' }).waitFor();
    await page.locator('#comment-input').fill('虚构评论内容');
    const submissionAlert = page.waitForEvent('dialog');
    const clickComment = page.locator('#btn-post-comment').click();
    const dialog = await submissionAlert;
    assert.match(dialog.message(), /留言已提交/);
    await dialog.accept();
    await clickComment;
    assert.equal(await page.locator('#comment-input').inputValue(), '');

    await page.getByRole('button', { name: '投稿', exact: true }).click();
    await page.locator('#modal-submit').getByText('投稿和当前昵称会保存', { exact: false }).waitFor();
    await page.locator('#post-title').fill('虚构投稿');
    await page.locator('#post-content').fill('虚构投稿正文');
    await page.locator('#btn-do-post').click();
    await page.locator('#post-msg').filter({ hasText: '投稿已进入审核队列' }).waitFor();
    await page.locator('#modal-submit').waitFor({ state: 'hidden' });
    assert.equal((await db.query("select * from public.comments where content = '虚构评论内容'")).rows.length, 0);
    for (const table of ['feedbacks', 'submissions']) await assert.rejects(db.query(`select * from public.${table}`), { code: '42501' });

    await setRole(db, 'authenticated', adminId, true);
    const [feedback, posts, comments] = await page.evaluate(() => Promise.all([
      window.Api.getFeedbacks(), window.Api.getSubmissions(), window.Api.getAdminComments(),
    ]));
    assert.equal(feedback.length, 1);
    assert.equal(posts.length, 1);
    assert.equal(comments.length, 1);
    assert.deepEqual([feedback[0].description, feedback[0].status, feedback[0].user_id], ['虚构纠错内容', 'todo', null]);
    assert.deepEqual([posts[0].author_name, posts[0].status, posts[0].user_id], ['虚构昵称', 'pending', null]);
    assert.deepEqual([comments[0].user_name, comments[0].content, comments[0].status], ['虚构昵称', '虚构评论内容', 'pending']);
    assert.match(comments[0].user_id, /^[a-f0-9-]{36}$/);
    await db.query("update public.comments set status = 'approved' where id = $1", [comments[0].id]);
    await setRole(db, 'anon');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.locator('#sidebar-comment-feed').getByText('虚构昵称', { exact: true }).waitFor();
    await page.goto(`${origin}/privacy.html`);
    for (const phrase of ['当前系统未给评论、投稿和未答问题样本设置自动删除期限',
      '投稿原文及署名目前供管理员审核', '保存最多 500 字的问题样本', '未答问题样本由管理员查看']) {
      await page.getByText(phrase, { exact: false }).waitFor();
    }
    await page.goto(`${origin}/terms.html`);
    await page.getByText('当时的昵称会随内容发送并保存', { exact: false }).waitFor();
    console.log('学生页面：匿名纠错、投稿、评论各 1 条。后台 API 可见，评论审批后公开，页面与政策提示通过');
    await setRole(db, 'service_role');
    await checkAiBatch2(db, page);
  } finally {
    await browser.close();
  }
}

async function checkStaticSync(db) {
  const folder = await mkdtemp(join(tmpdir(), 'shangong-static-test-'));
  const scriptPath = join(folder, 'scripts', 'sync_knowledge.mjs');
  const dataPath = join(folder, 'js', 'data.js');
  await mkdir(join(folder, 'scripts'));
  await mkdir(join(folder, 'js'));
  await writeFile(scriptPath, await read('scripts/sync_knowledge.mjs'));
  await writeFile(dataPath, fixtureSource(fixtureItems));
  const printSql = () => execFileSync(process.execPath, [scriptPath, '--print-sql'], { encoding: 'utf8', env: {} });
  const documents = async () => (await db.query(`select to_jsonb(d) as doc from public.knowledge_documents d
    where slug like 'static-%' order by slug`)).rows.map(({ doc }) => doc);
  try {
    await setRole(db, 'service_role');
    await db.exec(printSql());
    assert.deepEqual((await documents()).map((doc) => [doc.status, doc.verified_at]), [['draft', null], ['draft', null]]);
    await setRole(db, 'authenticated', adminId, true);
    assert.equal((await reviewDocument(db, 'static-public', 'publish')).status, 'published');
    assert.equal((await reviewDocument(db, 'static-archived', 'archive')).status, 'archived');
    await setRole(db, 'service_role');
    // 模拟早期归档资料仍保有核验时间，确保原值也会保留。
    await db.exec("update public.knowledge_documents set verified_at = '2025-01-01T00:00:00Z' where slug = 'static-archived'");
    await db.exec(`insert into public.knowledge_chunks (document_id, document_revision, chunk_index, title, content, content_hash)
      select id, revision, 0, title, content, checksum from public.knowledge_documents where slug = 'static-public'`);
    const before = await documents();
    await db.exec(printSql());
    await db.exec(printSql());
    assert.deepEqual(await documents(), before);

    // 直接同步命令也必须走同一个数据库函数。拦截 fetch 后执行其实际请求载荷。
    const stub = `globalThis.fetch = async (url, init) => {
      if (url !== 'https://database.invalid/rest/v1/rpc/sync_static_knowledge') throw Error('意外网络入口');
      const body = JSON.parse(init.body);
      if (init.method !== 'POST' || !Array.isArray(body.p_documents)) throw Error('错误请求格式');
      console.log('fixture-rpc:' + JSON.stringify(body.p_documents));
      return {ok: true};
    };`;
    const importStub = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`;
    const runHttp = async () => {
      const output = execFileSync(process.execPath, ['--import', importStub, scriptPath], {
        encoding: 'utf8', env: { SUPABASE_URL: 'https://database.invalid', SUPABASE_SECRET_KEY: 'fixture-key' },
      });
      const captured = output.split(/\r?\n/).filter((line) => line.startsWith('fixture-rpc:'));
      assert.equal(captured.length, 1);
      const payload = JSON.parse(captured[0].slice('fixture-rpc:'.length));
      return db.query('select public.sync_static_knowledge($1::jsonb)', [JSON.stringify(payload)]);
    };
    await runHttp();
    assert.deepEqual(await documents(), before);
    assert.equal((await db.query('select id from public.knowledge_chunks')).rows.length, 1);

    await writeFile(dataPath, fixtureSource([...fixtureItems.map((item) => ({ ...item, body: '这是变更后的虚构正文。' })),
      { ...fixtureItems[0], slug: 'static-new', title: '虚构新资料' }]));
    await runHttp();
    const [archived, added, published] = await documents();
    assert.deepEqual([archived.status, added.status, published.status], ['archived', 'draft', 'draft']);
    assert.deepEqual([archived.verified_at, added.verified_at, published.verified_at], [null, null, null]);
    assert.notEqual(archived.revision, before[0].revision);
    assert.notEqual(published.revision, before[1].revision);
    assert.match(published.previous_version.content, /虚构的校园说明/);
    assert.equal((await db.query('select id from public.knowledge_chunks')).rows.length, 0);
    await setRole(db, 'authenticated', adminId, true);
    assert.equal((await reviewDocument(db, 'static-archived', 'restore')).status, 'draft');
    assert.equal((await reviewDocument(db, 'static-public', 'publish')).status, 'published');
    console.log('静态同步：两次 SQL 和一次直接命令保留发布/归档原值，新增待审，正文变更后换版并清理旧切片');
  } finally {
    await unlink(scriptPath);
    await unlink(dataPath);
    await rmdir(join(folder, 'scripts'));
    await rmdir(join(folder, 'js'));
    await rmdir(folder);
  }
}

async function checkPrivacyStorage(db) {
  const settings = { SUPABASE_URL: 'https://database.invalid', SUPABASE_ANON_KEY: 'fixture-public',
    SUPABASE_SECRET_KEY: 'fixture-server', AI_RATE_LIMIT_SALT: 'fixture-salt' };
  let handler;
  const fetch = async (url, init = {}) => {
    const request = new URL(url);
    assert.equal(request.origin, settings.SUPABASE_URL);
    const body = init.body ? JSON.parse(init.body) : {};
    switch (request.pathname) {
      case '/rest/v1/rpc/consume_ai_quota': {
        const { rows } = await db.query('select * from public.consume_ai_quota($1, $2, $3)',
          [body.p_client_hash, body.p_limit, body.p_window_minutes]);
        return Response.json(rows);
      }
      case '/rest/v1/knowledge_documents':
        return Response.json([]);
      case '/rest/v1/rpc/record_unanswered_question': {
        const { rows } = await db.query('select * from public.record_unanswered_question($1, $2, $3, $4, $5::jsonb)',
          [body.p_question_hash, body.p_sample_question, body.p_normalized_question, body.p_topic, JSON.stringify(body.p_metadata)]);
        return Response.json(rows);
      }
      case '/rest/v1/ai_usage': {
        await db.query(`insert into public.ai_usage
          (client_hash, provider, model, retrieval_count, input_chars, output_chars, latency_ms, status)
          values ($1, $2, $3, $4, $5, $6, $7, $8)`, [body.client_hash, body.provider, body.model,
          body.retrieval_count, body.input_chars, body.output_chars, body.latency_ms, body.status]);
        return new Response(null, { status: 201 });
      }
      default: throw new Error('意外的模型或网络请求');
    }
  };
  const source = await read('supabase/functions/campus-ai/index.ts');
  const script = stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\r?\n/gm, ''), { mode: 'strip' });
  vm.runInNewContext(script, { ...timing, ...historical, ...multiIntent, ...retrieval,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, crypto, console, fetch,
    Deno: { env: { get: (name) => settings[name] }, serve: (action) => { handler = action; } },
  });
  await setRole(db, 'service_role');
  const question = '虚构宿舍问题，邮箱 sample@example.test，手机号 19900000000，编号 123456789012';
  for (let iteration = 0; iteration < 2; iteration++) {
    const response = await handler(new Request('https://edge.invalid', { method: 'POST',
      headers: { apikey: 'fixture-public', Origin: 'http://localhost:4173' },
      body: JSON.stringify({ question, clientId: 'fixture-client' }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).noMatch, true);
  }
  await setRole(db, 'authenticated', adminId, true);
  const { rows: [gap] } = await db.query(`select * from public.unanswered_questions
    where metadata->>'source' = 'campus-ai'`);
  assert.match(gap.sample_question, /^虚构宿舍问题，邮箱 \[邮箱\]，手机号 \[手机号\]，编号 \[编号\]$/);
  assert.equal(gap.normalized_question, retrieval.normalizeText(gap.sample_question));
  assert.equal(gap.ask_count, 2);
  assert.equal(gap.topic, '宿舍生活');
  assert.equal(gap.status, 'open');
  assert.match(gap.question_hash, /^[a-f0-9]{64}$/);
  assert.ok(!('client_hash' in gap));
  await setRole(db, 'authenticated', studentId);
  assert.equal((await db.query('select id from public.unanswered_questions')).rows.length, 0);
  await setRole(db, 'anon');
  await assert.rejects(db.query('select id from public.unanswered_questions'), { code: '42501' });
  await setRole(db, 'service_role');
  const { rows: logs } = await db.query("select * from public.ai_usage where status = 'no_match'");
  assert.equal(logs.length, 2);
  assert.ok(logs.every((log) => !('question' in log) && !('answer' in log) && log.input_chars === question.length));
  await db.exec('reset role');
  // 验证维护者可按主键删除合成记录，其他记录保留。
  assert.equal((await db.query('delete from public.unanswered_questions where id = $1', [gap.id])).affectedRows, 1);
  assert.equal((await db.query('select id from public.unanswered_questions')).rows.length, 1);
  for (const table of ['comments', 'submissions']) {
    const { rows: [{ id }] } = await db.query(`select id from public.${table} limit 1`);
    assert.equal((await db.query(`delete from public.${table} where id = $1`, [id])).affectedRows, 1);
    assert.equal((await db.query(`select id from public.${table} where id = $1`, [id])).rows.length, 0);
  }
  console.log('隐私存储：真实未答处理保存替换后的样本，重复计数为 2。用量无正文，访客不可读，维护者可按主键删除');
}

async function withDatabase(run) {
  const db = await PGlite.create({ extensions: { vector } });
  try {
    // 只模拟 Supabase 提供的身份环境。应用表、策略和向量扩展均执行真实 SQL。
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb,
        created_at timestamptz not null default now());
      create schema extensions;
      grant usage on schema extensions to anon, authenticated, service_role;
      set search_path to public, extensions;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role;`);
    await run(db);
  } finally {
    await db.close();
  }
}

await withDatabase(async (db) => {
  await db.exec(runScript('database_install.mjs'));
  await seedUsers(db);
  await checkKnowledgeRoles(db);
  console.log('空库：完整安装、管理员发布与结单、学生隔离、采集角色写入通过');
  await checkStaticSync(db);
  await checkAnonymousForms(db);
  await checkPrivacyStorage(db);
  await checkBatch3Browser(db, chromium, require, setRole, adminId, studentId);
});

await withDatabase(async (db) => {
  await apply(db, base);
  await seedUsers(db);
  await db.exec(`create view public.item_stats as select 'fixture'::text as slug;
    create function public.rls_auto_enable() returns boolean language sql as $$ select true $$;
    create table public.other_module (id integer);
    alter table public.other_module enable row level security;
    grant select on public.other_module to authenticated;
    create policy other_module_read on public.other_module for select to authenticated using (true);
    insert into public.other_module values (1);`);
  await apply(db, [security, review]);
  await db.exec(`insert into public.feeds (source,source_name,title,link,fingerprint,status,published_at) values
    ('jwc','虚构来源','已有发布标题','https://jwc.sdtbu.edu.cn/info/1001/9900.htm','old-1','published',now()),
    ('jwc','虚构来源','已有忽略标题','https://jwc.sdtbu.edu.cn/info/1001/9901.htm','old-2','ignored',null),
    ('jwc','虚构来源','已有历史重复','https://jwc.sdtbu.edu.cn/detailnew.jsp?wbnewsid=9901','old-3','pending',null)`);
  const feedHistory = (await db.query('select id,title,status,published_at from public.feeds order by title')).rows;
  await db.exec(`with parent as (insert into public.comments(item_slug,user_name,content,status)
      values ('old-a','旧昵称','旧父评论','approved') returning id)
    insert into public.comments(item_slug,user_name,content,status,parent_id)
      select 'old-b','旧昵称','旧跨事项回复','approved',id from parent`);
  await db.exec(`insert into public.ai_usage (client_hash, provider, model, status)
    select 'fixture-old-log', 'fixture', 'fixture', status from unnest(array['ok', 'no_match', 'rate_limited', 'error']) as status`);
  const oldLogs = (await db.query('select * from public.ai_usage order by id')).rows;
  await db.query("insert into public.feedbacks (item_slug, description, user_id) values ('old', '旧反馈', $1)", [studentId]);
  await db.query("insert into public.submissions (cat, title, content, user_id) values ('report', '旧投稿', '旧文', $1)", [studentId]);
  await db.exec(`insert into public.knowledge_documents (slug, title, category, content, checksum)
    values ('old-doc', '旧资料', '测试', '保留正文', 'fixture-old')`);
  await setRole(db, 'authenticated', adminId, true);
  assert.equal((await reviewDocument(db, 'old-doc', 'publish')).status, 'published');
  await db.exec('reset role');
  await db.exec(`insert into public.knowledge_chunks (document_id, document_revision, chunk_index, title, content, content_hash)
    select id, revision, 0, title, content, checksum from public.knowledge_documents where slug = 'old-doc'`);
  // 重现旧加固已执行、审核迁移已上线，但知识授权和策略被清掉的旧库。
  await db.exec(`revoke all on ${knowledgeTables.map((table) => `public.${table}`).join(', ')} from authenticated;
    do $$ declare p record; begin
      for p in select tablename, policyname from pg_policies where schemaname = 'public'
        and tablename in (${knowledgeTables.map((table) => `'${table}'`).join(', ')}) loop
        execute format('drop policy %I on public.%I', p.policyname, p.tablename);
      end loop;
    end $$;`);
  const oldDocument = (await db.query("select * from public.knowledge_documents where slug = 'old-doc'")).rows[0];
  const oldChunk = (await db.query('select * from public.knowledge_chunks')).rows[0];
  await setRole(db, 'authenticated', adminId, true);
  await assert.rejects(db.query('select id from public.knowledge_documents'), { code: '42501' });
  await db.exec('reset role');
  await apply(db, [security, access, sync, cancellation, commentsMigration, feedsMigration,
    access, sync, cancellation, commentsMigration, feedsMigration]);
  assert.deepEqual((await db.query('select id,title,status,published_at from public.feeds order by title')).rows, feedHistory);
  const { rows: [legacyReplies] } = await db.query(`select count(*)::int as count from public.comments c
    join public.comments p on p.id=c.parent_id where c.item_slug <> p.item_slug`);
  assert.equal(legacyReplies.count, 1);
  await setRole(db, 'anon');
  const { rows: [publicTree] } = await db.query(`select public.get_item_comments('old-a', $1) as parent,
    public.get_item_comments('old-b', $1) as child`, [studentId]);
  assert.equal(publicTree.parent.total, 1);
  assert.deepEqual(publicTree.parent.comments[0].replies, []);
  assert.equal(publicTree.child.total, 0);
  console.log('旧库合成样本：1 条跨事项回复已保留，该回复无法挂在任何事项的公开评论树上。');
  await setRole(db, 'service_role');
  await checkFeedCollector(db);
  const { rows: [count] } = await db.query("select count(*)::int as total from public.feeds where status='pending'");
  assert.equal(count.total, 3);
  await db.exec('reset role');
  assert.deepEqual((await db.query("select id,title,status,published_at from public.feeds where title like '已有%' order by title")).rows, feedHistory);
  assert.deepEqual((await db.query('select * from public.ai_usage order by id')).rows, oldLogs);
  await setRole(db, 'service_role');
  await db.exec(`insert into public.ai_usage (client_hash, provider, model, status)
    values ('fixture-new-log', 'fixture', 'fixture', 'cancelled')`);
  await assert.rejects(db.query(`insert into public.ai_usage (client_hash, provider, model, status)
    values ('fixture-invalid', 'fixture', 'fixture', 'unknown')`), { code: '23514' });
  await db.exec('reset role');
  assert.deepEqual((await db.query("select * from public.knowledge_documents where slug = 'old-doc'")).rows[0], oldDocument);
  assert.deepEqual((await db.query('select * from public.knowledge_chunks')).rows[0], oldChunk);
  assert.deepEqual((await db.query('select raw_app_meta_data from auth.users where id = $1', [adminId])).rows[0].raw_app_meta_data,
    { role: 'admin', fixture: true });
  await checkKnowledgeRoles(db);
  await setRole(db, 'authenticated', adminId, true);
  assert.equal((await db.query("select user_id from public.feedbacks where item_slug = 'old'")).rows[0].user_id, studentId);
  assert.equal((await db.query("select user_id from public.submissions where title = '旧投稿'")).rows[0].user_id, studentId);
  assert.equal((await db.query('select id from public.other_module')).rows[0].id, 1);
  assert.equal((await db.query('select slug from public.item_stats')).rows[0].slug, 'fixture');
  assert.equal((await db.query("select has_function_privilege('authenticated', 'public.rls_auto_enable()', 'execute') as allowed")).rows[0].allowed, false);
  console.log('旧库：重复增量升级、旧数据与账号关联保留、旧对象兼容、其他模块权限保留');
});
