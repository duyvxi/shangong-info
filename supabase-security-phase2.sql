-- 山商信息通：第二阶段第 1 步——后台与数据库安全加固
-- 管理员由维护者按 SECURITY_SETUP.md 单独开通。迁移不修改账号。
begin;

-- 私有、无提权的管理员判断函数。
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select (select auth.uid()) is not null
       and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated, service_role;

-- 仅处理基础业务表。AI 与知识表各自管理权限。
revoke all on table public.item_likes, public.comment_likes, public.comments,
    public.feedbacks, public.submissions, public.profiles, public.item_views,
    public.search_keywords, public.daily_stats, public.feeds, public.site_settings
    from public, anon, authenticated;
grant select, insert, update, delete on table public.item_likes, public.comment_likes,
    public.comments, public.feedbacks, public.submissions, public.profiles, public.item_views,
    public.search_keywords, public.daily_stats, public.feeds, public.site_settings to service_role;

grant select, insert on public.item_likes, public.comment_likes to anon;
grant select, insert, update, delete on public.item_likes, public.comment_likes to authenticated;
grant select, insert on public.comments to anon;
grant select, insert, update, delete on public.comments to authenticated;
grant insert on public.feedbacks, public.submissions, public.item_views, public.search_keywords to anon;
grant select, insert, update, delete on public.feedbacks, public.submissions, public.item_views, public.search_keywords to authenticated;
grant select on public.feeds, public.site_settings to anon;
grant select, insert, update, delete on public.feeds, public.site_settings to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.daily_stats to authenticated;

-- 基础业务表启用 RLS。
alter table public.item_likes enable row level security;
alter table public.comment_likes enable row level security;
alter table public.comments enable row level security;
alter table public.feedbacks enable row level security;
alter table public.submissions enable row level security;
alter table public.profiles enable row level security;
alter table public.item_views enable row level security;
alter table public.search_keywords enable row level security;
alter table public.daily_stats enable row level security;
alter table public.feeds enable row level security;
alter table public.site_settings enable row level security;

-- 这 11 张基础业务表的历史策略由此脚本替换，保留其他表的策略。
do $$
declare
    p record;
begin
    for p in
        select schemaname, tablename, policyname
        from pg_policies
        where schemaname = 'public' and tablename in (
            'item_likes', 'comment_likes', 'comments', 'feedbacks', 'submissions',
            'profiles', 'item_views', 'search_keywords', 'daily_stats', 'feeds', 'site_settings'
        )
        and policyname not in ('feedbacks_submit_account', 'submissions_submit_account')
    loop
        execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    end loop;
end;
$$;

-- 点赞公开可读可新增；匿名身份无法可靠证明删除归属，因此不开放匿名删除。
create policy item_likes_public_read on public.item_likes
for select to anon, authenticated using (true);
create policy item_likes_public_insert on public.item_likes
for insert to anon, authenticated
with check (char_length(item_slug) between 1 and 160 and user_id is not null);
create policy item_likes_admin_manage on public.item_likes
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy comment_likes_public_read on public.comment_likes
for select to anon, authenticated using (true);
create policy comment_likes_public_insert on public.comment_likes
for insert to anon, authenticated
with check (comment_id is not null and user_id is not null);
create policy comment_likes_admin_manage on public.comment_likes
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- 评论公开只能读已审核内容；新内容固定进入待审核池。
create policy comments_public_read_approved on public.comments
for select to anon, authenticated using (status = 'approved');
create policy comments_public_submit_pending on public.comments
for insert to anon, authenticated
with check (
    status = 'pending'
    and char_length(item_slug) between 1 and 160
    and char_length(user_name) between 1 and 20
    and char_length(content) between 1 and 2000
);
create policy comments_owner_read on public.comments
for select to authenticated using (user_id = (select auth.uid()));
create policy comments_admin_manage on public.comments
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- 纠错、投稿只允许公众提交固定初始状态，列表和处理权归管理员。
create policy feedbacks_public_submit on public.feedbacks
for insert to anon, authenticated
with check (
    status = 'todo'
    and char_length(item_slug) between 1 and 160
    and char_length(description) between 1 and 4000
    and (contact is null or char_length(contact) <= 200)
);
create policy feedbacks_admin_manage on public.feedbacks
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy submissions_public_submit on public.submissions
for insert to anon, authenticated
with check (
    status = 'pending'
    and char_length(cat) between 1 and 80
    and char_length(title) between 1 and 200
    and char_length(content) between 1 and 20000
    and char_length(author_name) between 1 and 40
    and (summary is null or char_length(summary) <= 1000)
    and (source_url is null or char_length(source_url) <= 2000)
);
create policy submissions_admin_manage on public.submissions
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- 埋点只写不读；后台管理员可读取统计原始数据。
create policy item_views_public_insert on public.item_views
for insert to anon, authenticated
with check (
    char_length(item_slug) between 1 and 160
    and char_length(cat_id) between 1 and 80
);
create policy item_views_admin_manage on public.item_views
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy search_keywords_public_insert on public.search_keywords
for insert to anon, authenticated
with check (char_length(keyword) between 1 and 200);
create policy search_keywords_admin_manage on public.search_keywords
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- 动态内容与站点设置：公众只读，管理员管理。
create policy feeds_public_read_published on public.feeds
for select to anon, authenticated using (status = 'published');
create policy feeds_admin_manage on public.feeds
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy site_settings_public_read on public.site_settings
for select to anon, authenticated using (true);
create policy site_settings_admin_manage on public.site_settings
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

-- 用户档案：普通登录用户只管理本人且不能自升权，管理员管理全部。
create policy profiles_owner_read on public.profiles
for select to authenticated using (id = (select auth.uid()));
create policy profiles_owner_update on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (
    id = (select auth.uid())
    and role = 'student'
    and status = 'active'
);
create policy profiles_admin_manage on public.profiles
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy daily_stats_admin_read on public.daily_stats
for select to authenticated using ((select private.is_admin()));

-- 视图改为调用者权限执行，避免绕过底层 RLS。
alter view if exists public.item_stats set (security_invoker = true);
alter view public.view_active_news set (security_invoker = true);
alter view public.view_search_ranking set (security_invoker = true);
alter view public.view_top_items set (security_invoker = true);

revoke all on public.view_active_news, public.view_search_ranking, public.view_top_items
    from public, anon, authenticated;
grant select on public.view_active_news to anon, authenticated;
grant select on public.view_search_ranking, public.view_top_items to authenticated;

-- 历史 SECURITY DEFINER 函数不再暴露为公共 RPC，并固定 search_path。
alter function public.handle_new_user() set search_path = '';
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

-- 仅旧库可能有这两个对象。存在时保留并加固。
do $$
begin
    if to_regclass('public.item_stats') is not null then
        revoke all on public.item_stats from public, anon, authenticated;
        grant select on public.item_stats to anon, authenticated;
    end if;
    if to_regprocedure('public.rls_auto_enable()') is not null then
        revoke all on function public.rls_auto_enable() from public, anon, authenticated;
        grant execute on function public.rls_auto_enable() to service_role;
    end if;
end;
$$;

revoke all on function public.consume_ai_quota(text, integer, integer)
from public, anon, authenticated;
grant execute on function public.consume_ai_quota(text, integer, integer) to service_role;

-- 收紧 public schema 与未来对象的默认权限。
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
    revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
    grant all on tables to service_role;
alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated;

commit;
