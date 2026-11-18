begin;

-- 静态同步只写资料内容。审核状态、版本和核验时间继续由审核规则管理。
create or replace function public.sync_static_knowledge(p_documents jsonb)
returns void language sql security invoker set search_path = '' as $$
    insert into public.knowledge_documents as target (
        slug, title, category, summary, content, source_url, source_type,
        source_date, checksum, metadata
    )
    select slug, title, category, summary, content, source_url, 'curated',
        source_date, checksum, metadata
    from jsonb_to_recordset(p_documents) as item (
        slug text, title text, category text, summary text, content text,
        source_url text, source_date date, checksum text, metadata jsonb
    )
    on conflict (slug) do update set
        title = excluded.title,
        category = excluded.category,
        summary = excluded.summary,
        content = excluded.content,
        source_url = excluded.source_url,
        source_type = excluded.source_type,
        source_date = excluded.source_date,
        checksum = excluded.checksum,
        metadata = excluded.metadata
    where row(target.title, target.category, target.summary, target.content, target.source_url,
              target.source_type, target.source_date, target.checksum, target.metadata)
          is distinct from
          row(excluded.title, excluded.category, excluded.summary, excluded.content, excluded.source_url,
              excluded.source_type, excluded.source_date, excluded.checksum, excluded.metadata);
$$;

revoke all on function public.sync_static_knowledge(jsonb) from public, anon, authenticated;
grant execute on function public.sync_static_knowledge(jsonb) to service_role;

commit;
