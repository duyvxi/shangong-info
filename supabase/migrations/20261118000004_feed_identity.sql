begin;

create or replace function public.feed_fingerprint(p_link text)
returns text language sql immutable strict security invoker set search_path = '' as $$
    with parts as (
        select regexp_match(btrim(p_link), '^https?://([^/?#]+)([^#]*)', 'i') as url
    ), identity as (
        select regexp_replace(lower(url[1]), '\\.?(:443)?$', '') as host,
            coalesce(substring(url[2] from '^/info/[0-9]+/([0-9]+)\.html?(?:[?]|$)'),
                substring(url[2] from '[?&]wbnewsid=([0-9]+)(?:&|$)')) as article,
            url[2] as target
        from parts
    )
    select 'v2:' || encode(sha256(convert_to(coalesce(
        (case when host = 'www.sdtbu.edu.cn' then 'sdtbu.edu.cn' else host end)
        || case when article is not null then '/article/' || article else coalesce(nullif(target, ''), '/') end,
        split_part(btrim(p_link), '#', 1)), 'UTF8')), 'hex') from identity;
$$;

-- 每个身份保留一条记录占用新指纹。其余历史记录及审核结果原样保留。
with identities as (
    select id, fingerprint, created_at, public.feed_fingerprint(link) as new_fingerprint from public.feeds
), ranked as (
    select *, row_number() over (partition by new_fingerprint
        order by (fingerprint = new_fingerprint) desc, created_at, id) as position
    from identities
)
update public.feeds f set fingerprint = r.new_fingerprint from ranked r
where f.id = r.id and r.position = 1 and f.fingerprint <> r.new_fingerprint;

create or replace function public.ingest_feed_notice(
    p_source text, p_source_name text, p_title text, p_link text, p_pub_date text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
    insert into public.feeds (source, source_name, title, link, fingerprint, pub_date, status)
    values (p_source, p_source_name, p_title, p_link, public.feed_fingerprint(p_link), p_pub_date, 'pending')
    on conflict (fingerprint) do nothing;
    -- 只有身份指纹冲突返回 false。约束、权限等其余错误按写入失败处理。
    return found;
end;
$$;

revoke all on function public.feed_fingerprint(text), public.ingest_feed_notice(text, text, text, text, text)
    from public, anon, authenticated;
grant execute on function public.feed_fingerprint(text), public.ingest_feed_notice(text, text, text, text, text)
    to service_role;

commit;
