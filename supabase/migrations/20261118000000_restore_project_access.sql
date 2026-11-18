begin;

-- 恢复旧加固曾移除的知识权限。基础表仍按行校验管理员身份。
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.unanswered_questions enable row level security;
alter table public.crawl_jobs enable row level security;

revoke all on table public.knowledge_documents, public.knowledge_chunks,
    public.knowledge_sources, public.unanswered_questions, public.crawl_jobs
    from public, anon, authenticated;
grant select, insert, update, delete on table public.knowledge_documents, public.knowledge_sources to authenticated;
-- 换版触发器以调用者权限删除旧切片。删除权限也受管理员策略约束。
grant select, delete on table public.knowledge_chunks to authenticated;
grant select, update on table public.unanswered_questions to authenticated;
grant select on table public.crawl_jobs to authenticated;
grant select, insert, update, delete on table public.knowledge_documents, public.knowledge_chunks,
    public.knowledge_sources, public.unanswered_questions, public.crawl_jobs to service_role;
revoke all on sequence public.unanswered_questions_id_seq from public, anon, authenticated;
grant usage, select on sequence public.unanswered_questions_id_seq to service_role;

drop policy if exists knowledge_documents_admin_manage on public.knowledge_documents;
create policy knowledge_documents_admin_manage on public.knowledge_documents
for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists knowledge_sources_admin_manage on public.knowledge_sources;
create policy knowledge_sources_admin_manage on public.knowledge_sources
for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists knowledge_chunks_admin_read on public.knowledge_chunks;
drop policy if exists knowledge_chunks_admin_delete on public.knowledge_chunks;
create policy knowledge_chunks_admin_read on public.knowledge_chunks
for select to authenticated using ((select private.is_admin()));
create policy knowledge_chunks_admin_delete on public.knowledge_chunks
for delete to authenticated using ((select private.is_admin()));

drop policy if exists unanswered_questions_admin_manage on public.unanswered_questions;
create policy unanswered_questions_admin_manage on public.unanswered_questions
for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

drop policy if exists crawl_jobs_admin_read on public.crawl_jobs;
create policy crawl_jobs_admin_read on public.crawl_jobs
for select to authenticated using ((select private.is_admin()));

-- 只读公开视图由所有者读取底表，固定筛选已发布行并投影公开字段。
-- 审核笔记、旧稿、内部元数据和采集记录继续留在受 RLS 保护的底表。
create or replace view public.published_knowledge_documents
with (security_barrier = true, security_invoker = false) as
select slug, title, category, summary, content, source_url, source_type, source_date,
    effective_from, effective_until, verified_at
from public.knowledge_documents
where status = 'published';
revoke all on table public.published_knowledge_documents from public, anon, authenticated;
grant select on table public.published_knowledge_documents to anon, authenticated;

-- 匿名投稿的账号字段可为空。保留原外键及已有账号关联。
alter table public.feedbacks alter column user_id drop not null;
alter table public.submissions alter column user_id drop not null;
drop policy if exists feedbacks_submit_account on public.feedbacks;
create policy feedbacks_submit_account on public.feedbacks as restrictive
for insert to anon, authenticated with check (user_id is null or user_id = (select auth.uid()));
drop policy if exists submissions_submit_account on public.submissions;
create policy submissions_submit_account on public.submissions as restrictive
for insert to anon, authenticated with check (user_id is null or user_id = (select auth.uid()));

commit;
