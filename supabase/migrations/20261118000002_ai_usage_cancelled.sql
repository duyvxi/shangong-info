begin;

-- 只更新状态约束，保留已有日志和索引。
alter table public.ai_usage
    drop constraint if exists ai_usage_status_check,
    add constraint ai_usage_status_check
        check (status in ('ok', 'no_match', 'rate_limited', 'error', 'cancelled'));

commit;
