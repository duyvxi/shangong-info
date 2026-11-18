begin;

-- 旧异常保留待核对，新回复和修改后的关联必须属于同一事项。
create unique index if not exists idx_comments_id_item on public.comments (id, item_slug);
do $$
declare
    mismatches bigint;
begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.comments'::regclass
                   and conname = 'comments_parent_item_fkey') then
        alter table public.comments add constraint comments_parent_item_fkey
            foreign key (parent_id, item_slug) references public.comments (id, item_slug)
            on delete cascade not valid;
    end if;
    select count(*) into mismatches from public.comments child join public.comments parent
        on parent.id = child.parent_id where child.item_slug <> parent.item_slug;
    raise notice '跨事项历史回复：% 条，记录已保留', mismatches;
end;
$$;

create index if not exists idx_comments_public_page
    on public.comments (item_slug, parent_id, created_at, id) where status = 'approved';

-- 每次最多 20 条主评论或回复，首页每个主评论附带前 5 条回复。
create or replace function public.get_item_comments(
    p_item_slug text, p_user_id uuid, p_offset integer default 0, p_parent_id uuid default null
)
returns jsonb language sql stable security invoker set search_path = '' as $$
    with page as (
        select c.id, c.user_name, c.content, c.reply_to_name, c.created_at
        from public.comments c
        where c.item_slug = p_item_slug and c.status = 'approved'
          and ((p_parent_id is null and c.parent_id is null) or
               (c.parent_id = p_parent_id and exists (
                   select 1 from public.comments parent where parent.id = p_parent_id
                     and parent.item_slug = p_item_slug and parent.status = 'approved' and parent.parent_id is null
               )))
        order by case when p_parent_id is null then c.created_at end desc,
                 case when p_parent_id is not null then c.created_at end, c.id
        offset greatest(p_offset, 0) limit 21
    ), numbered as (
        select page.*, row_number() over (order by
            case when p_parent_id is null then created_at end desc,
            case when p_parent_id is not null then created_at end, id) as position
        from page
    ), result as (
        select n.position, jsonb_build_object(
            'id', n.id, 'user_name', n.user_name, 'content', n.content,
            'reply_to_name', n.reply_to_name, 'created_at', n.created_at,
            'like_count', coalesce(likes.total, 0), 'has_liked', coalesce(likes.mine, false),
            'replies', coalesce(replies.items, '[]'::jsonb), 'has_more_replies', coalesce(replies.total > 5, false)
        ) as entry
        from numbered n
        left join lateral (
            select count(*) as total, bool_or(l.user_id = p_user_id) as mine
            from public.comment_likes l where l.comment_id = n.id
        ) likes on p_parent_id is null
        left join lateral (
            select count(*) as total,
                jsonb_agg(to_jsonb(r) - 'position' order by r.position) filter (where r.position <= 5) as items
            from (
                select c.id, c.user_name, c.content, c.reply_to_name, c.created_at,
                    row_number() over (order by c.created_at, c.id) as position
                from public.comments c
                where c.parent_id = n.id and c.item_slug = p_item_slug and c.status = 'approved'
                order by c.created_at, c.id limit 6
            ) r
        ) replies on p_parent_id is null
        where n.position <= 20
    )
    select jsonb_build_object('comments', coalesce(jsonb_agg(entry order by position), '[]'::jsonb),
        'has_more', (select count(*) > 20 from page),
        'total', case when p_parent_id is null then (
            select count(*) from public.comments c where c.item_slug = p_item_slug
                and c.parent_id is null and c.status = 'approved'
        ) end)
    from result;
$$;

create or replace function public.record_comment_like(p_comment_id uuid, p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
    if not exists (select 1 from public.comments where id = p_comment_id and status = 'approved') then
        raise exception '该评论已不可见' using errcode = '22023';
    end if;
    insert into public.comment_likes (comment_id, user_id) values (p_comment_id, p_user_id)
        on conflict (comment_id, user_id) do nothing;
    return (select jsonb_build_object('like_count', count(*), 'has_liked', coalesce(bool_or(user_id = p_user_id), false))
        from public.comment_likes where comment_id = p_comment_id);
end;
$$;

revoke all on function public.get_item_comments(text, uuid, integer, uuid), public.record_comment_like(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.get_item_comments(text, uuid, integer, uuid), public.record_comment_like(uuid, uuid)
    to anon, authenticated;

commit;
