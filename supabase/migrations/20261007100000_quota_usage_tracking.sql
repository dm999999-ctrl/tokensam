-- Supabase meters egress and the two log metrics (Log Ingestion, Log Query) outside
-- Postgres entirely -- there is no SQL-visible number for "bytes egressed this billing
-- cycle". The closest local signal the app can keep is its own approximate daily
-- request count and response-byte volume, compared against a derived daily budget
-- (see src/lib/monitoring/quota-config.ts). This table holds that running count, one
-- row per UTC day, written by the app's own hot read paths (observation-reads.ts) and
-- evaluated once per scheduled refresh (api/cron/refresh/route.ts) alongside the
-- existing database_monitor_state (pg_database_size, which Postgres *can* see directly).
begin;

create table if not exists public.quota_usage_counters (
  usage_date date primary key,
  request_count bigint not null default 0,
  approx_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.quota_usage_counters enable row level security;
revoke all on table public.quota_usage_counters from anon, authenticated;
grant select, insert, update, delete on table public.quota_usage_counters to service_role;

-- Upsert-and-increment in one round trip: the hot read paths that call this cannot
-- afford a read-then-write (that would double their own request count against the
-- very budget this table tracks).
create or replace function public.record_quota_usage(p_requests bigint, p_bytes bigint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.quota_usage_counters (usage_date, request_count, approx_bytes)
  values (current_date, greatest(p_requests, 0), greatest(p_bytes, 0))
  on conflict (usage_date) do update
  set request_count = public.quota_usage_counters.request_count + excluded.request_count,
      approx_bytes = public.quota_usage_counters.approx_bytes + excluded.approx_bytes,
      updated_at = now();
$$;

revoke all on function public.record_quota_usage(bigint, bigint) from public;
grant execute on function public.record_quota_usage(bigint, bigint) to service_role;

-- Prune old rows so this table never itself becomes a database-size contributor
-- (a handful of bytes/day, but the earlier incident was exactly this kind of
-- unbounded-growth oversight).
create or replace function public.prune_quota_usage_counters()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.quota_usage_counters where usage_date < current_date - interval '35 days';
$$;

revoke all on function public.prune_quota_usage_counters() from public;
grant execute on function public.prune_quota_usage_counters() to service_role;

-- Current throttle level (see ThrottleLevel in quota-config.ts), shared across every
-- serverless instance so a level set by one scheduled refresh is honored by every
-- concurrent page render, not just the warm instance that set it. Mirrors
-- database_monitor_state's single-row pattern.
create table if not exists public.quota_throttle_state (
  id boolean primary key default true check (id = true),
  level text not null default 'none' check (level in ('none', 'warn', 'critical')),
  reasons text[] not null default '{}',
  updated_at timestamptz not null default now()
);

insert into public.quota_throttle_state (id, level)
values (true, 'none')
on conflict (id) do nothing;

alter table public.quota_throttle_state enable row level security;
revoke all on table public.quota_throttle_state from anon, authenticated;
grant select, insert, update, delete on table public.quota_throttle_state to service_role;

commit;
