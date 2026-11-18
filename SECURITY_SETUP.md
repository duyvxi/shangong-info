# 后台与数据库安全说明

## 已完成

- 管理员权限保存在 Supabase Auth `app_metadata`，普通用户不能自行修改。
- `admin.html` 必须登录并通过管理员身份校验后才能显示。
- 数据库使用最小表权限和 RLS 双重保护。
- 匿名访客不能读取用户档案、反馈、投稿、搜索记录或原始浏览记录。
- 新评论进入待审核状态，管理员放行后才公开显示。
- 旧统计视图按调用者身份执行。公开知识视图只返回已发布记录及公开字段，审核备注、旧稿和内部元数据继续受底表权限保护。
- 公共角色不能直接执行 `SECURITY DEFINER` 函数。
- 后台渲染用户内容前会做 HTML 转义，避免存储型 XSS。

## 管理员登录

打开：`https://duyvxi.github.io/shangong-info/admin.html`

使用已由维护者开通管理员权限的 Auth 账号。管理员权限更新后，请重新登录以刷新身份令牌。

如管理员账号使用无法收信的 `@user.sdtbu.local` 虚拟邮箱且忘记密码，可在项目电脑上双击 `重置管理员密码.cmd`。工具只更新固定管理员 UUID 的密码，不改变邮箱、用户资料或管理员权限；Supabase Secret key 和新密码均隐藏输入，并在进程结束时清理，不会写入文件。Secret key 权限极高，只能从 Supabase Dashboard 复制到这个本地工具，禁止发送、截图或写入仓库。

## 必须手动配置：GitHub Actions 抓取密钥

安全迁移后，定时抓取任务不再使用公开匿名 Key 写数据库。

1. 打开 GitHub 仓库 `duyvxi/shangong-info`。
2. 进入 **Settings → Secrets and variables → Actions**。
3. 新建 Repository secret：`SUPABASE_SECRET_KEY`。
4. 值填写 Supabase 项目的服务端 Secret Key。
5. 不要把该值写进仓库、截图、Issue 或聊天记录。
6. 保存后，到 **Actions → 抓取校园新内容 → Run workflow** 手动运行一次。

## 建议手动开启：泄露密码保护

Supabase 安全顾问仍提示 Leaked Password Protection 未开启。请在 Supabase Dashboard 的 Auth 密码安全设置中启用该功能，然后要求管理员使用强密码。

## 空库安装

先准备一个 Supabase 空项目或本地 Supabase 数据库。应用 SQL 依赖平台提供的 Auth 表和服务角色。仓库根目录执行 `node scripts/database_install.mjs`，将完整输出交给目标库的 SQL Editor 或 `psql` 执行。输出只生成 SQL，不连接数据库。安装在一个事务内完成，包含基础表、AI 一期与二期、安全权限和后续增量迁移。

建表后创建 Auth 账号，由有权维护数据库的人用 Auth 用户编号核对目标账号后单独授权。下面的 `<已核对的 Auth 用户 UUID>` 是占位符，两处账号资料应对应同一人。旧库保留已有管理员。

```sql
do $$
declare
    admin_id uuid := '<已核对的 Auth 用户 UUID>';
begin
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
    where id = admin_id;
    if not found then raise exception '找不到 Auth 账号'; end if;

    update public.profiles set role = 'admin', updated_at = now() where id = admin_id;
    if not found then raise exception '找不到对应档案'; end if;
end;
$$;
```

## 已有数据库升级

1. 对照已有表和迁移记录。尚未完成 AI 二期的库，先按顺序补齐尚未执行的 `supabase-ai-phase1.sql`、`supabase-ai-phase2.sql`。已经完成知识审核迁移的库从下一步开始。
2. 执行最新版 `supabase-security-phase2.sql`。尚未启用知识审核的库接着执行 `supabase/migrations/20261116000000_knowledge_review.sql`。
3. 依次执行 `supabase/migrations/20261118000000_restore_project_access.sql`、`supabase/migrations/20261118000001_sync_static_knowledge.sql` 和 `supabase/migrations/20261118000002_ai_usage_cancelled.sql`。仅更新 AI 取消日志的现有库，可在确认已有 `ai_usage` 表后单独执行最后一份迁移。
4. 用管理员账号确认能打开知识列表、审核并发布草稿、结单。用匿名身份及普通账号检查只读公开资料，再检查采集角色能写入草稿。学生端更新前应先完成数据库迁移。

第三批按顺序应用 `20261118000003_comment_paging.sql` 和 `20261118000004_feed_identity.sql`。前者为新增回复校验父评论与事项，并提供分页和点赞汇总接口。后者为旧消息回填新版去重指纹，并保留原记录、审核状态和发布时间。新版页面与采集作业需在迁移完成后更新。

评论迁移会报告已有跨事项回复数量并保留这些记录。这类回复无法挂到公开的评论树。维护者可用下方只读 SQL 再核对数量，归属修正或清理需另行确认。

```sql
select count(*) as cross_item_replies
from public.comments child
join public.comments parent on parent.id = child.parent_id
where child.item_slug <> parent.item_slug;
```

## 本地验收

在仓库根目录运行以下 PowerShell 命令。使用 Node.js 22.13 或更新版本、Python 3.12 及本机 Edge。测试依赖安装在临时目录，数据库在内存中运行。脚本覆盖三批验收，包括消息采集模拟、分页、来源表单和局部刷新。GitHub 的 Linux 检查安装专用 Chromium。测试不需要项目凭据。

```powershell
$dbTestDir = Join-Path $env:TEMP 'shangong-phase1-db-deps'
npm.cmd install --prefix $dbTestDir --no-save --no-package-lock --ignore-scripts --no-audit --no-fund '@electric-sql/pglite@0.5.4' '@electric-sql/pglite-pgvector@0.0.5' 'playwright-core@1.57.0' '@supabase/supabase-js@2.119.0'
$crawlerTestDir = Join-Path $env:TEMP 'shangong-crawler-test'
python -m venv $crawlerTestDir
$env:TEST_PYTHON = Join-Path $crawlerTestDir 'Scripts/python.exe'
& $env:TEST_PYTHON -m pip install -r scripts/requirements-crawler.txt
& $env:TEST_PYTHON -m pip check
& $env:TEST_PYTHON -B scripts/test_crawl_knowledge.py
node scripts/test_database_phase1.mjs $dbTestDir
Remove-Item Env:TEST_PYTHON
```

要比较改动前后的请求数与响应大小，可将基线的 `admin.html`、`index.html`、`api.js`、`app.js` 放在同一个目录，把该目录设为 `TEST_BATCH3_BASELINE_DIR` 后运行同一命令。脚本会在同一份合成数据上比较后台评论放行和学生端首屏评论请求。大小统计为响应正文的字节数。

## 隐私请求处理

学生通过纠错反馈联系维护者。先核对记录类型、提交时间和事项等信息，确认只定位到对应记录。管理员可在后台查看评论、投稿和未答问题。实际删除目前由有数据库维护权限的人按记录主键操作，分别对应 `public.comments`、`public.submissions`、`public.unanswered_questions`。删除父评论会连带删除它的回复及点赞；未答样本的「忽略」或「结单」仅改变状态。保留期限、备份副本的清理周期、处理时限和实际模型供应商的政策由维护者确认。
