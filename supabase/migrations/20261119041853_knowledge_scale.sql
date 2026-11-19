begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.knowledge_search_text(value text)
returns text language sql immutable security invoker set search_path = '' as $$
    select btrim(regexp_replace(lower(normalize(coalesce(value, ''), NFKC)), '[[:space:][:punct:]]+', ' ', 'g'));
$$;

-- 写入资料时生成检索字段，问答不再重复规范化全库原文。
alter table public.knowledge_documents add column if not exists keyword_fields text[] generated always as (
    array[public.knowledge_search_text(title), public.knowledge_search_text(category),
          public.knowledge_search_text(summary), public.knowledge_search_text(content)]
) stored;

-- 分词仍由问答函数完成，数据库对全库候选使用原来的字段权重。
create or replace function public.knowledge_keyword_score(p_question text, p_tokens text[], p_fields text[])
returns double precision language sql immutable security invoker set search_path = '' as $$
    select (case when p_fields[1] <> '' and strpos(p_question, p_fields[1]) > 0 then 12 else 0 end
        + case when p_question <> '' and strpos(p_fields[1], p_question) > 0 then 10 else 0 end
        + coalesce(sum(5 * (strpos(p_fields[1], token) > 0)::int
                     + 3 * (strpos(p_fields[2], token) > 0)::int
                     + 2 * (strpos(p_fields[3], token) > 0)::int
                     +     (strpos(p_fields[4], token) > 0)::int), 0)
        + coalesce(4.0 * count(*) filter (where strpos(p_fields[1], token) > 0 or strpos(p_fields[2], token) > 0
                              or strpos(p_fields[3], token) > 0 or strpos(p_fields[4], token) > 0)
                   / nullif(count(*), 0), 0))::double precision
    from unnest(p_tokens) as token;
$$;

create or replace function public.knowledge_notice_year(p_source_type text, p_metadata jsonb)
returns integer language sql immutable security invoker set search_path = '' as $$
    select case when p_source_type = 'official_notice' and p_metadata->>'source_class' = 'official'
        and p_metadata->>'document_role' = 'annual_notice' and p_metadata->'allow_historical_reference' = 'true'::jsonb
        and btrim(coalesce(p_metadata->>'topic_key', '')) <> '' and p_metadata->>'notice_year' ~ '^[0-9]{4}$'
        then (p_metadata->>'notice_year')::integer end;
$$;

-- 只返回两路各 12 个候选和最多 1 个历史候选的标识、版本及排序字段。
create or replace function public.find_knowledge_candidates(
    p_question text, p_tokens text[], p_today date, p_history_year integer, p_rank_year integer,
    p_dimensions text[], p_major_transfer boolean, p_embedding extensions.vector(1024), p_threshold double precision
)
returns jsonb language sql stable security invoker set search_path = '' as $$
    with published as (
        select id, revision, slug, title, category, metadata, source_type, verified_at, updated_at,
            keyword_fields[1] as title_search, keyword_fields[2] as category_search,
            public.knowledge_notice_year(source_type, metadata) as history_year,
            btrim(coalesce(metadata->>'topic_key', '')) as topic,
            (effective_from is null or effective_from <= p_today)
                and (effective_until is null or effective_until >= p_today) as active
        from public.knowledge_documents where status = 'published'
    ), related as (
        select p.*, case when topic <> '' then public.knowledge_keyword_score(p_question, p_tokens,
            array[title_search, category_search, '', '']) else 0 end as topic_score from published p
    ), scope as (
        select topic from related where p_history_year is not null and history_year is not null and topic_score >= 2
            and (topic <> 'major-transfer' or p_major_transfer)
        order by topic_score desc, updated_at desc, id limit 1
    ), current_docs as (
        select r.* from related r where active and not exists (
            select 1 from scope s where s.topic = r.topic and r.history_year <> p_history_year
        )
    ), scored as materialized (
        select c.*, public.knowledge_keyword_score(p_question, p_tokens, d.keyword_fields) as base_score
        from current_docs c join public.knowledge_documents d on d.id = c.id
        where (c.title_search <> '' and p_question <> '' and
               (strpos(p_question, c.title_search) > 0 or strpos(c.title_search, p_question) > 0))
          or array_to_string(d.keyword_fields, ' ') like any (array(select '%' || token || '%' from unnest(p_tokens) token))
    ), keyword_hits as (
        select id, revision, slug, title, category,
            jsonb_build_object('document_role', metadata->>'document_role', 'topic_key', topic) as metadata,
            base_score + case when base_score < 2 then 0 else
                case when source_type = 'official_notice' or metadata->>'source_class' = 'official' then 2 else 0 end
                + case when title_search <> '' and p_question <> '' and
                    (strpos(p_question, title_search) > 0 or strpos(title_search, p_question) > 0) then 4 else 0 end
                + case when (topic = '' or (topic = 'major-transfer' and p_major_transfer)
                    or (topic <> 'major-transfer' and topic_score >= 2)) then
                        case when metadata->>'document_role' = 'annual_notice' then
                            case when '时间' = any(p_dimensions) then 3 else 0 end
                            + case when metadata->>'notice_year' ~ '^[0-9]{4}$' then
                                case when metadata->>'notice_year' = p_rank_year::text then 6 else -4 end else 0 end
                        when metadata->>'document_role' = 'policy' then
                            case when '条件' = any(p_dimensions) then 5 else 0 end
                            + case when p_dimensions && array['材料','流程'] then 2 else 0 end
                        else 0 end else 0 end
                + case when verified_at <= (p_today + 1)::timestamp at time zone 'UTC' then
                    case when verified_at >= (p_today - 180)::timestamp at time zone 'UTC' then 1.5
                         when verified_at >= (p_today - 365)::timestamp at time zone 'UTC' then 0.75 else 0 end
                    else 0 end
            end as retrieval_score, updated_at
        from scored
    ), semantic_hits as (
        select c.id, c.revision, c.slug, c.title, c.category,
            jsonb_build_object('document_role', c.metadata->>'document_role', 'topic_key', c.topic) as metadata, k.id as chunk_id,
            1 - (k.embedding OPERATOR(extensions.<=>) p_embedding) as semantic_score
        from current_docs c join public.knowledge_chunks k on k.document_id = c.id and k.document_revision = c.revision
        where p_embedding is not null and k.embedding_status = 'ready' and k.embedding is not null
          and 1 - (k.embedding OPERATOR(extensions.<=>) p_embedding) >= greatest(0, least(p_threshold, 1))
        -- 在参与检索的版本内精确排序，避免近似候选先截断再过滤。
        order by semantic_score desc, k.id limit 12
    ), historical_hit as (
        select p.id, p.revision, p.slug, p.title, p.category, p.history_year as notice_year,
            p_history_year as requested_year
        from published p join scope s using (topic)
        where p.history_year between p_history_year - 3 and p_history_year - 1
          and not exists (select 1 from published current_notice where current_notice.topic = s.topic
              and current_notice.history_year = p_history_year and current_notice.active)
        order by p.history_year desc, p.updated_at desc, p.id limit 1
    )
    select jsonb_build_object(
        'keyword', coalesce((select jsonb_agg(to_jsonb(k) - 'updated_at' order by k.retrieval_score desc, k.updated_at desc, k.id)
            from (select * from keyword_hits where retrieval_score >= 2 order by retrieval_score desc, updated_at desc, id limit 12) k), '[]'::jsonb),
        'semantic', coalesce((select jsonb_agg(to_jsonb(k) order by k.semantic_score desc, k.chunk_id) from semantic_hits k), '[]'::jsonb),
        'historical', coalesce((select jsonb_agg(to_jsonb(h)) from historical_hit h), '[]'::jsonb)
    );
$$;

create or replace function public.read_knowledge_matches(p_matches jsonb, p_today date)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'revision', d.revision, 'slug', d.slug, 'title', d.title, 'category', d.category,
        'summary', d.summary, 'content', d.content, 'source_url', coalesce(d.source_url, d.canonical_url),
        'source_type', d.source_type, 'source_date', d.source_date, 'verified_at', d.verified_at,
        'reviewed_audience', d.last_review->>'audience', 'status', d.status, 'metadata', d.metadata,
        'chunks', coalesce(chunks.items, '[]'::jsonb)
    )), '[]'::jsonb)
    from (select * from jsonb_to_recordset(p_matches) as x(id uuid, revision uuid, chunk_ids uuid[], requested_year int) limit 5) hit
    join public.knowledge_documents d on d.id = hit.id and d.revision = hit.revision and d.status = 'published'
    left join lateral (
        select jsonb_agg(jsonb_build_object('id', k.id, 'content', k.content) order by ids.position) as items
        from unnest(hit.chunk_ids[1:2]) with ordinality ids(id, position)
        join public.knowledge_chunks k on k.id = ids.id and k.document_id = d.id and k.document_revision = d.revision
            and k.embedding_status = 'ready' and k.embedding is not null
    ) chunks on true
    where (hit.requested_year is null and (d.effective_from is null or d.effective_from <= p_today)
          and (d.effective_until is null or d.effective_until >= p_today))
       or (hit.requested_year is not null and public.knowledge_notice_year(d.source_type, d.metadata)
           between hit.requested_year - 3 and hit.requested_year - 1 and not exists (
               select 1 from public.knowledge_documents n where n.status = 'published'
                 and n.metadata->>'topic_key' = d.metadata->>'topic_key'
                 and public.knowledge_notice_year(n.source_type, n.metadata) = hit.requested_year
                 and (n.effective_from is null or n.effective_from <= p_today)
                 and (n.effective_until is null or n.effective_until >= p_today)
           ));
$$;

-- 记录已验证的索引版本。旧数据首次经过脚本校验后才补记，不强制重算已有向量。
alter table public.knowledge_documents
    add column if not exists indexed_revision uuid,
    add column if not exists indexed_signature text,
    add column if not exists indexed_chunk_count integer;

create or replace function public.knowledge_index_is_ready(p_id uuid, p_revision uuid, p_model text, p_count integer)
returns boolean language sql stable security invoker set search_path = '' as $$
    select coalesce(count(*) = p_count and coalesce(bool_and(
        c.document_revision is not distinct from p_revision and c.embedding_model = p_model and c.embedding_status = 'ready'
        and c.embedding is not null and c.chunk_index between 0 and p_count - 1
    ), true), false) from public.knowledge_chunks c where c.document_id = p_id;
$$;

create or replace function public.get_knowledge_index_page(
    p_after uuid, p_model text, p_signature text, p_include_ready boolean
)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select coalesce(jsonb_agg(to_jsonb(page) order by page.id), '[]'::jsonb)
    from (select id, slug, title, category, content, revision from public.knowledge_documents d
        where d.status = 'published' and (p_after is null or d.id > p_after)
          and (p_include_ready or d.indexed_revision is distinct from d.revision or d.indexed_signature is distinct from p_signature
            or not public.knowledge_index_is_ready(d.id, d.revision, p_model, d.indexed_chunk_count))
        order by d.id limit 50) page;
$$;

create or replace function public.finish_knowledge_index(
    p_id uuid, p_revision uuid, p_model text, p_signature text, p_count integer
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
    perform 1 from public.knowledge_documents d
    where d.id = p_id and d.revision = p_revision and d.status = 'published' for update;
    if not found then return false; end if;
    -- 持有正文版本锁后再清理多余切片，避免删到并发任务写入的新版本。
    delete from public.knowledge_chunks where document_id = p_id and chunk_index >= p_count;
    update public.knowledge_documents d set indexed_revision = p_revision, indexed_signature = p_signature, indexed_chunk_count = p_count
    where d.id = p_id and d.revision = p_revision and d.status = 'published'
      and public.knowledge_index_is_ready(p_id, p_revision, p_model, p_count);
    return found;
end;
$$;

create or replace function public.find_manual_knowledge(p_slugs text[], p_urls text[])
returns table (slug text, status text, checksum text, canonical_url text, content_format text)
language sql stable security invoker set search_path = '' as $$
    select d.slug, d.status, d.checksum, d.canonical_url, d.content_format
    from public.knowledge_documents d where d.slug = any(p_slugs) or d.canonical_url = any(p_urls);
$$;

revoke all on function public.knowledge_search_text(text), public.knowledge_keyword_score(text, text[], text[]),
    public.knowledge_notice_year(text, jsonb),
    public.find_knowledge_candidates(text, text[], date, integer, integer, text[], boolean, extensions.vector, double precision),
    public.read_knowledge_matches(jsonb, date), public.knowledge_index_is_ready(uuid, uuid, text, integer),
    public.get_knowledge_index_page(uuid, text, text, boolean), public.finish_knowledge_index(uuid, uuid, text, text, integer),
    public.find_manual_knowledge(text[], text[]) from public, anon, authenticated;
grant execute on function public.knowledge_search_text(text), public.knowledge_keyword_score(text, text[], text[]),
    public.knowledge_notice_year(text, jsonb),
    public.find_knowledge_candidates(text, text[], date, integer, integer, text[], boolean, extensions.vector, double precision),
    public.read_knowledge_matches(jsonb, date), public.knowledge_index_is_ready(uuid, uuid, text, integer),
    public.get_knowledge_index_page(uuid, text, text, boolean), public.finish_knowledge_index(uuid, uuid, text, text, integer),
    public.find_manual_knowledge(text[], text[]) to service_role;
-- 管理员写入资料时需要执行纯文本转换，候选和正文接口仍只授予服务角色。
grant execute on function public.knowledge_search_text(text) to authenticated;

commit;
