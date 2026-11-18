import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const slugA = 'batch3-a';
const slugB = 'batch3-b';
const fixtureData = `const CATEGORIES = [{id:'report',name:'入学报到'}];
  const ITEMS = [{slug:'${slugA}',cat:'report',title:'虚构事项甲'}, {slug:'${slugB}',cat:'report',title:'虚构事项乙'}]; const LINKS = [];`;
const origin = 'http://localhost';
const sdkUrl = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js';

export async function checkFeedCollector(db) {
  const test = fileURLToPath(new URL('./test_fetch_feeds.py', import.meta.url));
  const child = spawn(process.env.TEST_PYTHON || 'python', ['-B', test, '--local-database'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(process.stdout);
  const complete = new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', (code) => code === 0 ? done() : fail(new Error(`消息采集验收退出码 ${code}`)));
  });
  // 只接收两种预定查询。用内存 PostgreSQL 执行脚本生成的真实参数。
  for await (const line of createInterface({ input: child.stdout })) {
    const { method, path, payload } = JSON.parse(line);
    let response;
    if (method === 'GET' && path === 'site_settings') {
      response = { data: (await db.query("select value from public.site_settings where key = 'crawl_paused'")).rows };
    } else {
      assert.equal(`${method} ${path}`, 'POST rpc/ingest_feed_notice');
      try {
        const { rows: [{ added }] } = await db.query('select public.ingest_feed_notice($1,$2,$3,$4,$5) as added',
          ['p_source', 'p_source_name', 'p_title', 'p_link', 'p_pub_date'].map((key) => payload[key]));
        response = { data: added };
      } catch (error) {
        assert.equal(error.code, '23502');
        response = { error: 'Supabase 400: fixture not-null failure' };
      }
    }
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }
  await complete;
}

const tables = new Set(['profiles', 'item_views', 'item_likes', 'comments', 'comment_likes', 'feedbacks', 'submissions',
  'knowledge_documents', 'knowledge_chunks', 'knowledge_sources', 'unanswered_questions', 'crawl_jobs', 'feeds',
  'site_settings', 'view_top_items', 'view_search_ranking']);
function column(name) {
  assert.match(name, /^[a-z_]+$/);
  return name;
}

async function mockPostgrest(db, url, method, headers, body) {
  const table = url.pathname.split('/').at(-1);
  if (url.pathname.includes('/rpc/')) {
    assert.equal(method, 'POST');
    const rpc = {
      get_item_comments: ['p_item_slug', 'p_user_id', 'p_offset', 'p_parent_id'],
      record_comment_like: ['p_comment_id', 'p_user_id'],
    }[table];
    assert.ok(rpc);
    const args = rpc.map((_, index) => `$${index + 1}`).join(',');
    const { rows: [{ result }] } = await db.query(`select public.${table}(${args}) as result`, rpc.map((key) => body[key]));
    return { data: result };
  }

  assert.ok(tables.has(table), `意外的测试表 ${table}`);
  const args = [];
  const filters = [];
  const param = (value) => `$${args.push(value)}`;
  const p = url.searchParams;
  for (const [key, value] of p) {
    if (value.startsWith('eq.')) filters.push(`${column(key)} = ${param(value.slice(3))}`);
    if (value.startsWith('gte.')) filters.push(`${column(key)} >= ${param(value.slice(4))}`);
    if (value === 'not.is.null') filters.push(`${column(key)} is not null`);
    if (value.startsWith('in.(')) {
      const list = value.slice(4, -1).split(',');
      filters.push(`${column(key)} in (${list.map(param).join(',')})`);
    }
  }
  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  if (method === 'POST') {
    const fields = Object.keys(body).map(column);
    const returning = (headers.prefer || '').includes('return=representation');
    const { rows } = await db.query(`insert into public.${table} (${fields.join(',')})
      values (${fields.map((key) => param(body[key])).join(',')}) ${returning ? 'returning *' : ''}`, args);
    return returning ? { data: rows[0], status: 201 } : { status: 201 };
  }
  if (method === 'PATCH') {
    assert.ok(where);
    const sets = Object.entries(body).map(([key, value]) => `${column(key)} = ${param(value)}`);
    await db.query(`update public.${table} set ${sets.join(',')} ${where}`, args);
    return { status: 204 };
  }
  assert.ok(['GET', 'HEAD'].includes(method));
  const limit = Math.max(1, Math.min(1000, Number(p.get('limit')) || 1000));
  const offset = Math.max(0, Number(p.get('offset')) || 0);
  const order = p.get('order')?.split(',').map((part) => {
    const [key, direction] = part.split('.');
    return `${column(key)} ${direction === 'desc' ? 'desc' : 'asc'}`;
  }).join(',');
  const fields = p.get('select') || '*';
  const select = fields === '*' ? fields : fields.split(',').map((field) =>
    field === 'knowledge_sources(name)' ? 'null as knowledge_sources' : column(field)).join(',');
  const responseHeaders = {};
  if (method === 'HEAD' || (headers.prefer || '').includes('count=exact')) {
    const { rows: [{ count }] } = await db.query(`select count(*) as count from public.${table} ${where}`, args);
    responseHeaders['content-range'] = `0-0/${count}`;
  }
  if (method === 'HEAD') return { headers: responseHeaders };
  const { rows } = await db.query(`select ${select} from public.${table} ${where}
    ${order ? `order by ${order}` : ''} limit ${limit} offset ${offset}`, args);
  const single = (headers.accept || '').includes('object+json');
  return { data: single ? rows[0] ?? null : rows, headers: responseHeaders };
}

async function localPage(browser, sdk, db, adminId, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const requests = [];
  const failures = {};
  const user = { id: adminId, role: 'authenticated', app_metadata: { role: 'admin' }, user_metadata: {}, aud: 'authenticated' };
  const fakeToken = ['e30', Buffer.from(JSON.stringify({ sub: adminId, exp: 4102444800 })).toString('base64url'), 'fixture'].join('.');
  const auth = { access_token: fakeToken, refresh_token: 'fixture-refresh', expires_at: 4102444800, user };
  const superscript = `${sdk}\n;{const create = window.supabase.createClient;
    window.supabase = {...window.supabase, createClient: () => create('https://fixture.invalid', 'fixture-key', {
      auth: {storageKey: 'fixture-auth', autoRefreshToken: false, detectSessionInUrl: false}})};}`;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      const body = url.href === sdkUrl || (options.baseline && url.href.endsWith('supabase-js@2')) ? superscript : '';
      return route.fulfill({ status: 200, contentType: 'application/javascript', body });
    }
    const file = url.pathname.slice(1);
    if (!/^(?:admin\.html|index\.html|(?:js|css)\/[\w-]+\.(?:js|css))$/.test(file)) return route.abort();
    const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    let body;
    if (file === 'js/data.js') body = fixtureData;
    else if (options.baseline && ['admin.html', 'index.html', 'js/api.js', 'js/app.js'].includes(file)) {
      body = await readFile(join(options.baseline, file.split('/').at(-1)), 'utf8');
    } else body = await read(file);
    await route.fulfill({ body, contentType: `${contentType}; charset=utf-8` });
  });
  await page.exposeFunction('localDbRequest', async ({ target, method, headers, payload }) => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://fixture.invalid');
    const name = url.pathname.split('/').at(-1);
    const entry = { method, name, payload, bytes: 0, finished: false };
    requests.push(entry);
    let outcome;
    try {
      if (failures[`${method} ${name}`]) throw { code: 'fixture_error', message: '模拟服务失败' };
      if (url.pathname === '/auth/v1/user') outcome = { data: user };
      else {
        if (name === 'get_item_comments') await options.beforeComments?.(payload);
        outcome = await mockPostgrest(db, url, method, headers, payload);
      }
    } catch (error) {
      if (!error.code) throw error;
      outcome = { status: error.code === '23505' ? 409 : 400, data: { code: error.code, message: error.message } };
    }
    const body = outcome.data === undefined ? null : JSON.stringify(outcome.data);
    entry.bytes = body === null ? 0 : Buffer.byteLength(body);
    entry.finished = true;
    return { status: outcome.status || 200, headers: outcome.headers || {}, body };
  });
  await page.addInitScript(({ session, admin }) => {
    if (admin) localStorage.setItem('fixture-auth', JSON.stringify(session));
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      const response = await window.localDbRequest({ target: request.url, method: request.method,
        headers: Object.fromEntries(request.headers), payload: text ? JSON.parse(text) : null });
      return new Response(response.body, { status: response.status,
        headers: { 'content-type': 'application/json', ...response.headers } });
    };
  }, { session: auth, admin: options.admin });
  page.on('dialog', (dialog) => dialog.accept());
  return { context, page, requests, failures };
}

async function waitForRequest(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail('等待本地请求超时');
}

function totals(requests) {
  return { requests: requests.length, bytes: requests.reduce((sum, item) => sum + item.bytes, 0) };
}

async function adminChecks(browser, sdk, db, adminId, commentId, studentId, baseline) {
  const { context, page, requests, failures } = await localPage(browser, sdk, db, adminId, { admin: true, baseline });
  try {
    if (!baseline) failures['HEAD item_views'] = true;
    await page.goto(`${origin}/admin.html`);
    await page.locator('#admin-app').waitFor();
    await waitForRequest(() => requests.some((r) => r.name === 'submissions' && r.method === 'GET' && r.finished));
    await page.locator('#tbl-comments').getByText('虚构待审评论').waitFor({ state: 'attached' });
    if (!baseline) {
      await page.locator('#stat-pv').filter({ hasText: '读取失败' }).waitFor({ state: 'attached' });
      await page.waitForFunction(() => Number(document.getElementById('stat-users').textContent) > 0);
    }
    await page.locator('#nav-comments').click();
    requests.length = 0;
    await page.locator('#tbl-comments tr').filter({ hasText: '虚构待审评论' }).getByRole('button', { name: '放行' }).click();
    await waitForRequest(() => baseline ? requests.some((r) => r.name === 'submissions' && r.method === 'GET' && r.finished)
      : requests.filter((r) => r.finished).length >= 3);
    await page.locator('#tbl-comments tr').filter({ hasText: '虚构待审评论' }).getByText('正常显示').waitFor();
    const measurement = totals(requests);
    assert.equal((await db.query('select status from public.comments where id=$1', [commentId])).rows[0].status, 'approved');
    if (baseline) return measurement;
    assert.deepEqual(requests.map(({ method, name }) => `${method} ${name}`).sort(), ['GET comments', 'HEAD comments', 'PATCH comments']);
    await page.locator('#comments-next').click();
    await page.getByText('第 2 页', { exact: true }).waitFor();
    await page.locator('#comments-prev').click();
    await page.getByText('第 1 页', { exact: true }).waitFor();

    await page.locator('#nav-users').click();
    requests.length = 0;
    await page.locator('#tbl-users tr').filter({ hasText: 'local-student' }).getByRole('button', { name: '封禁' }).click();
    await waitForRequest(() => requests.filter((r) => r.finished).length >= 3);
    await page.locator('#tbl-users tr').filter({ hasText: 'local-student' }).getByRole('button', { name: '解封' }).waitFor();
    assert.deepEqual(requests.map(({ method, name }) => `${method} ${name}`).sort(), ['GET profiles', 'HEAD profiles', 'PATCH profiles']);
    assert.equal((await db.query('select status from public.profiles where id=$1', [studentId])).rows[0].status, 'banned');

    await page.locator('#nav-knowledge').click();
    const form = page.locator('#knowledge-source-form');
    const status = page.locator('#knowledge-source-status');
    for (const [name, host, expected, failedSave, failedRefresh] of [
      ['虚构新来源', 'batch3-test', '已保存。', false, false],
      ['虚构重复来源', 'batch3-test', '该官网地址已存在', false, false],
      ['虚构失败来源', 'batch3-failure', '添加失败', true, false],
      ['虚构刷新失败来源', 'batch3-refresh', '已保存，列表刷新失败', false, true],
    ]) {
      requests.length = 0;
      failures['POST knowledge_sources'] = failedSave;
      failures['GET knowledge_sources'] = failedRefresh;
      await form.locator('#source-name').fill(name);
      await form.locator('#source-url').fill(`https://${host}.sdtbu.edu.cn/`);
      await form.getByRole('button', { name: '添加来源' }).click();
      await status.filter({ hasText: expected }).waitFor();
      await form.getByRole('button', { name: '添加来源' }).waitFor();
      const saved = !failedSave && !expected.includes('已存在');
      assert.equal(await form.locator('#source-name').inputValue(), saved ? '' : name);
      assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
      assert.equal(requests.filter((r) => r.method === 'GET').length, saved ? 1 : 0);
      const { rows } = await db.query('select name from public.knowledge_sources where domain=$1', [`${host}.sdtbu.edu.cn`]);
      assert.equal(rows.length, failedSave ? 0 : 1);
      if (saved && !failedRefresh) await page.locator('#tbl-knowledge-sources').getByText(name, { exact: true }).waitFor();
    }
    console.log('PASS 来源表单四种结果；评论与用户状态操作各只调用写入、列表和计数，统计失败只影响对应卡片。');
    return measurement;
  } finally { await context.close(); }
}

async function studentChecks(browser, sdk, db, adminId, baseline) {
  const startA = Promise.withResolvers();
  const endA = Promise.withResolvers();
  const { context, page, requests } = await localPage(browser, sdk, db, adminId, { baseline, beforeComments: async (payload) => {
    if (payload.p_item_slug === slugA) { startA.resolve(); await endA.promise; }
  } });
  try {
    if (!baseline) {
      await page.goto(`${origin}/index.html#/info/${slugA}`);
      await startA.promise;
      await page.evaluate((slug) => { location.hash = `#/info/${slug}`; }, slugB);
      await page.locator('.comment-card').getByText('乙事项评论', { exact: true }).waitFor();
    } else {
      await page.goto(`${origin}/index.html#/info/${slugB}`);
      await page.locator('.comment-card').getByText('乙事项评论', { exact: true }).waitFor();
    }
    const measurement = totals(requests.filter((r) => (['comments', 'comment_likes', 'get_item_comments'].includes(r.name)
      && r.finished)));
    if (baseline) return measurement;
    assert.equal(measurement.requests, 1);
    endA.resolve();
    await waitForRequest(() => requests.some((r) => r.payload?.p_item_slug === slugA && r.finished));
    await page.waitForFunction(() => !document.querySelector('#sidebar-comment-more').disabled);
    assert.equal(await page.getByText('甲事项评论', { exact: true }).count(), 0);
    assert.equal(await page.locator('.comment-card').count(), 20);
    await page.locator('#sidebar-comment-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.comment-card').length === 22);
    const card = page.locator('.comment-card').filter({ hasText: '乙事项评论' });
    assert.equal(await card.locator('.reply-item').count(), 5);
    await card.getByRole('button', { name: '更多回复' }).click();
    await card.locator('.reply-item').last().filter({ hasText: '虚构回复 7' }).waitFor();
    assert.equal(await card.locator('.reply-item').count(), 7);
    await card.getByRole('button', { name: '回复', exact: true }).click();
    await card.locator('textarea').fill('虚构正常回复');
    await card.getByRole('button', { name: '发送', exact: true }).click();
    await waitForRequest(() => requests.some((r) => r.method === 'POST' && r.name === 'comments' && r.finished));
    const payload = requests.find((r) => r.name === 'comments' && r.method === 'POST').payload;
    assert.equal(payload.item_slug, slugB);
    assert.equal(payload.parent_id, await card.getAttribute('data-comment-id'));
    assert.match(await card.locator('[data-action="comment-like"] span').textContent(), /^1050$/);
    await card.getByRole('button', { name: /有帮助/ }).click();
    await card.locator('[data-action="comment-like"] span').filter({ hasText: /^1051$/ }).waitFor();
    assert.match(await card.locator('[data-action="comment-like"]').getAttribute('class'), /liked/);
    await card.getByRole('button', { name: /有帮助/ }).click();
    await card.locator('[data-action="comment-like"]:enabled').waitFor();
    assert.equal(await card.locator('[data-action="comment-like"] span').textContent(), '1051');
    console.log('PASS 学生评论：A 的晚返回未覆盖 B，同事项回复成功，主评论和回复分页，点赞计数包含超过 1000 条的全部记录。');
    return measurement;
  } finally { endA.resolve(); await context.close(); }
}

export async function checkBatch3Browser(db, chromium, require, setRole, adminId, studentId) {
  const localSdk = process.env.TEST_SUPABASE_SDK_DIR ? createRequire(resolve(process.env.TEST_SUPABASE_SDK_DIR, 'package.json')) : require;
  const sdk = await readFile(join(dirname(localSdk.resolve('@supabase/supabase-js')), 'umd', 'supabase.js'), 'utf8');
  for (const file of ['admin.html', 'index.html']) assert.ok((await read(file)).includes(`src="${sdkUrl}"`));
  await setRole(db, 'postgres');
  const { rows: roots } = await db.query(`insert into public.comments(item_slug, user_name, content, status, created_at) values
    ($1, '甲昵称', '甲事项评论', 'approved', now()),
    ($2, '乙昵称', '乙事项评论', 'approved', now()),
    ($1, '待审昵称', '虚构待审评论', 'pending', now() + interval '1 day') returning id`, [slugA, slugB]);
  await db.query(`insert into public.comments(item_slug, user_name, content, status, created_at)
    select $1, '分页昵称', '第 ' || n || ' 条乙事项内容', 'approved', now() - n * interval '1 day'
    from generate_series(1,21) n`, [slugB]);
  await db.query(`insert into public.comments(item_slug, user_name, content, status, created_at)
    select $1, '后台分页昵称', '后台第 ' || n || ' 条', 'pending', now() - n * interval '1 day'
    from generate_series(1,18) n`, [slugA]);
  await db.query(`insert into public.comments(item_slug, user_name, content, status, parent_id, created_at)
    select $1, '回复昵称', '虚构回复 ' || n, 'approved', $2, now() + n * interval '1 minute'
    from generate_series(1,7) n`, [slugB, roots[1].id]);
  await db.query(`insert into public.comment_likes(comment_id, user_id)
    select $1, gen_random_uuid() from generate_series(1,1050)`, [roots[1].id]);
  const channel = process.env.TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  const browser = await chromium.launch({ channel, args: ['--disable-background-networking'] });
  try {
    const baseline = process.env.TEST_BATCH3_BASELINE_DIR;
    await setRole(db, 'authenticated', adminId, true);
    const oldAdmin = baseline ? await adminChecks(browser, sdk, db, adminId, roots[2].id, studentId, baseline) : null;
    await db.query("update public.comments set status='pending' where id=$1", [roots[2].id]);
    const newAdmin = await adminChecks(browser, sdk, db, adminId, roots[2].id, studentId);
    await setRole(db, 'anon');
    const oldStudent = baseline ? await studentChecks(browser, sdk, db, adminId, baseline) : null;
    const newStudent = await studentChecks(browser, sdk, db, adminId);
    await assert.rejects(db.query(`insert into public.comments (item_slug,parent_id,user_name,content,status)
      values ($1,$2,'虚构昵称','跨事项回复','pending')`, [slugB, roots[0].id]), { code: '23503' });
    await setRole(db, 'postgres');
    const { rows } = await db.query("select item_slug, parent_id, status from public.comments where content = '虚构正常回复'");
    assert.deepEqual(rows, [{ item_slug: slugB, parent_id: roots[1].id, status: 'pending' }]);
    if (baseline) {
      assert.ok(newAdmin.requests < oldAdmin.requests && newAdmin.bytes < oldAdmin.bytes);
      assert.ok(newStudent.requests < oldStudent.requests && newStudent.bytes < oldStudent.bytes);
      console.log('本地同数据比较', JSON.stringify({ admin: { before: oldAdmin, after: newAdmin }, student: { before: oldStudent, after: newStudent } }));
    }
  } finally { await browser.close(); }
}
