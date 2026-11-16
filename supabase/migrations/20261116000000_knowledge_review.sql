begin;

alter table public.knowledge_documents
    add column if not exists revision uuid not null default gen_random_uuid(),
    add column if not exists last_review jsonb,
    add column if not exists previous_version jsonb;

alter table public.knowledge_chunks
    add column if not exists document_revision uuid;

-- 写入新内容时换版并退审，保留一份旧稿供管理员核对。
create or replace function public.prepare_knowledge_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        new.revision := gen_random_uuid();
        new.status := 'draft';
        new.verified_at := null;
        new.last_review := null;
        new.previous_version := null;
    elsif row(new.slug, new.checksum, new.title, new.category, new.summary, new.content,
              new.source_url, new.canonical_url, new.source_type, new.source_date,
              new.effective_from, new.effective_until, new.source_id, new.content_format, new.metadata)
         is distinct from
          row(old.slug, old.checksum, old.title, old.category, old.summary, old.content,
              old.source_url, old.canonical_url, old.source_type, old.source_date,
              old.effective_from, old.effective_until, old.source_id, old.content_format, old.metadata) then
        new.revision := gen_random_uuid();
        new.status := case when old.status = 'archived' then 'archived' else 'draft' end;
        new.verified_at := null;
        new.last_review := null;
        new.previous_version := jsonb_build_object(
            'title', old.title, 'content', old.content, 'source_date', old.source_date,
            'source_url', coalesce(old.source_url, old.canonical_url),
            'effective_from', old.effective_from, 'effective_until', old.effective_until,
            'last_review', old.last_review
        );
        new.updated_at := clock_timestamp();
    else
        new.revision := old.revision;
        new.previous_version := old.previous_version;
        if new.status = 'published' and old.status <> 'published'
           and (new.last_review is not distinct from old.last_review
                or new.last_review ->> 'action' is distinct from 'publish'
                or new.last_review -> 'public_confirmed' is distinct from 'true'::jsonb) then
            raise exception '审核发布前请先核验出处和公开范围' using errcode = '22023';
        end if;
        if row(new.status, new.verified_at, new.last_review) is distinct from
           row(old.status, old.verified_at, old.last_review) then
            new.updated_at := clock_timestamp();
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists prepare_knowledge_revision on public.knowledge_documents;
create trigger prepare_knowledge_revision
before insert or update on public.knowledge_documents
for each row execute function public.prepare_knowledge_revision();

create or replace function public.clear_old_knowledge_chunks()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    -- 和正文换版在同一次数据库操作中清理旧片段。
    delete from public.knowledge_chunks where document_id = new.id;
    return new;
end;
$$;

drop trigger if exists clear_old_knowledge_chunks on public.knowledge_documents;
create trigger clear_old_knowledge_chunks
after update on public.knowledge_documents
for each row when (old.revision is distinct from new.revision)
execute function public.clear_old_knowledge_chunks();

create or replace function public.check_knowledge_chunk_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    -- 锁定对应正文，阻止还在计算的旧向量在换版后写回。
    perform 1 from public.knowledge_documents
    where id = new.document_id and status = 'published' and revision = new.document_revision
    for share;
    if not found then
        raise exception 'KNOWLEDGE_INDEX_CHANGED' using errcode = '40001';
    end if;
    return new;
end;
$$;

drop trigger if exists check_knowledge_chunk_revision on public.knowledge_chunks;
create trigger check_knowledge_chunk_revision
before insert or update on public.knowledge_chunks
for each row execute function public.check_knowledge_chunk_revision();

revoke all on function public.prepare_knowledge_revision() from public, anon, authenticated;
revoke all on function public.clear_old_knowledge_chunks() from public, anon, authenticated;
revoke all on function public.check_knowledge_chunk_revision() from public, anon, authenticated;

create or replace function public.review_knowledge_document(
    p_id uuid, p_revision uuid, p_updated_at timestamptz, p_status text,
    p_action text, p_audience text, p_evidence text, p_note text, p_public_confirmed boolean
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    item public.knowledge_documents%rowtype;
    actor uuid := auth.uid();
    audience text := btrim(coalesce(p_audience, ''));
    evidence text := btrim(coalesce(p_evidence, ''));
    note text := btrim(coalesce(p_note, ''));
    checked_at timestamptz := clock_timestamp();
    confirmed boolean := p_action in ('publish', 'verify');
    new_status text;
begin
    if actor is null or (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
        raise exception '仅管理员可以审核资料' using errcode = '42501';
    end if;

    select * into item from public.knowledge_documents where id = p_id for update;
    if not found or row(item.revision, item.updated_at, item.status)
        is distinct from row(p_revision, p_updated_at, p_status) then
        raise exception 'KNOWLEDGE_CONFLICT' using errcode = '40001';
    end if;

    new_status := case
        when item.status = 'draft' and p_action = 'publish' then 'published'
        when item.status = 'draft' and p_action = 'hold' then 'draft'
        when item.status in ('draft', 'published') and p_action = 'archive' then 'archived'
        when item.status = 'published' and p_action = 'verify' then 'published'
        when item.status = 'published' and p_action = 'hold' then
            case when item.effective_until is null then 'draft' else 'published' end
        when item.status = 'published' and p_action = 'return' then 'draft'
        when item.status = 'archived' and p_action = 'restore' then 'draft'
    end;
    if new_status is null then
        raise exception '当前状态不支持该操作' using errcode = '22023';
    end if;
    if char_length(audience) > 200 or char_length(evidence) > 500 or char_length(note) > 500 then
        raise exception '填写内容过长，请精简后重试' using errcode = '22023';
    end if;
    if confirmed and (audience = '' or evidence = '' or p_public_confirmed is not true) then
        raise exception '请填写适用对象、核验出处，并确认资料可以公开' using errcode = '22023';
    end if;
    if not confirmed and note = '' then
        raise exception '请先填写处理备注' using errcode = '22023';
    end if;

    -- 复核记录与人工维护的正文分开保存，避免下次导入覆盖。
    update public.knowledge_documents set
        status = new_status,
        verified_at = case when confirmed then checked_at when new_status = 'published' then item.verified_at else null end,
        last_review = jsonb_build_object(
            'action', p_action, 'audience', audience, 'evidence', evidence, 'note', note,
            'at', checked_at, 'by', actor, 'revision', item.revision, 'public_confirmed', confirmed
        )
    where id = p_id
    returning * into item;
    return jsonb_build_object('id', item.id, 'status', item.status, 'verified_at', item.verified_at,
        'updated_at', item.updated_at, 'revision', item.revision, 'last_review', item.last_review);
end;
$$;

revoke all on function public.review_knowledge_document(uuid, uuid, timestamptz, text, text, text, text, text, boolean)
    from public, anon, authenticated;
grant execute on function public.review_knowledge_document(uuid, uuid, timestamptz, text, text, text, text, text, boolean)
    to authenticated;

create or replace function public.resolve_knowledge_gap(
    p_id bigint, p_status text, p_slug text, p_cause text, p_result text
)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
    item public.knowledge_documents%rowtype;
    today date := (now() at time zone 'Asia/Shanghai')::date;
    result text := btrim(coalesce(p_result, ''));
    resolved_id bigint;
begin
    if auth.uid() is null or (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'admin' then
        raise exception '仅管理员可以结单' using errcode = '42501';
    end if;
    if p_cause is null or p_cause not in ('missing', 'expired', 'retrieval') or char_length(result) not between 1 and 500 then
        raise exception '请填写问题原因和复测结果' using errcode = '22023';
    end if;
    select * into item from public.knowledge_documents where slug = btrim(p_slug)
        and status = 'published' and (effective_from is null or effective_from <= today)
        and (effective_until is null or effective_until >= today) for share;
    if not found then
        raise exception '未找到已发布且有效的对应资料，请核对资料编号' using errcode = '22023';
    end if;
    update public.unanswered_questions set
        status = 'resolved', resolved_at = now(), updated_at = now(), resolution_document_id = item.id,
        metadata = metadata || jsonb_build_object('resolution', jsonb_build_object(
            'cause', p_cause, 'result', result, 'slug', item.slug, 'revision', item.revision
        ))
    where id = p_id and status = p_status and status in ('open', 'reviewing')
    returning id into resolved_id;
    if not found then
        raise exception 'KNOWLEDGE_CONFLICT' using errcode = '40001';
    end if;
    return resolved_id;
end;
$$;

revoke all on function public.resolve_knowledge_gap(bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_knowledge_gap(bigint, text, text, text, text) to authenticated;

-- 返回正文版本，并在候选排序前按北京时间筛掉无效资料。
drop function if exists public.match_knowledge_chunks(extensions.vector, double precision, integer);
create function public.match_knowledge_chunks(
    p_query_embedding extensions.vector(1024),
    p_match_threshold double precision default 0.55,
    p_match_count integer default 12
)
returns table (
    chunk_id uuid, document_id uuid, slug text, title text, category text, content text,
    source_url text, source_date date, verified_at timestamptz, semantic_score double precision,
    document_revision uuid
)
language sql stable security invoker set search_path = '' as $$
    select c.id, d.id, d.slug, d.title, d.category, c.content,
           coalesce(d.source_url, d.canonical_url), d.source_date, d.verified_at,
           1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding), c.document_revision
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id and d.revision = c.document_revision
    cross join (select (now() at time zone 'Asia/Shanghai')::date as today) dates
    where d.status = 'published' and c.embedding_status = 'ready' and c.embedding is not null
      and (d.effective_from is null or d.effective_from <= dates.today)
      and (d.effective_until is null or d.effective_until >= dates.today)
      and 1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding) >= greatest(0, least(p_match_threshold, 1))
    order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
    limit greatest(1, least(coalesce(p_match_count, 12), 50));
$$;
revoke all on function public.match_knowledge_chunks(extensions.vector, double precision, integer)
    from public, anon, authenticated;
grant execute on function public.match_knowledge_chunks(extensions.vector, double precision, integer) to service_role;

commit;
