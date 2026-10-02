begin;

-- Data retention framework for token_metric_observations / raw_provider_records.
--
-- Without this, token_metric_observations grows ~83,000 rows/day (238-token universe)
-- uncapped, which alone would exceed the Supabase Free Plan's 0.5 GB quota within
-- roughly 2 weeks. This framework keeps the tables at a bounded steady-state size by
-- deleting/downsampling data no current reader needs:
--
--   token_metric_observations:
--     - Full raw resolution for the 5 metrics run-calculation.ts's SERIES_INPUTS reads
--       over a rolling window (see SERIES_LOOKBACK_DAYS there): 14 days.
--     - Full raw resolution for every other metric (only ever read as "latest" by
--       live-data.ts / research-context.ts): 1 day.
--     - Beyond each metric's raw window (up to 30 days total): downsampled to 1 row per
--       token/metric/day — enough resolution for the 90-day historical charts.
--     - 30-90 days: downsampled further to 1 row per token/metric/week.
--     - Beyond 90 days (HISTORY_DAYS): deleted entirely — nothing reads it.
--
--   raw_provider_records: kept 7 days raw (provider-payload/debugging data, not
--     charted history) and deleted entirely beyond that.
--
-- Each function processes one bounded batch (default 1000 rows) per call, mirroring
-- the batching that proved reliable in this session's manual cleanup — callers loop
-- until a function returns 0, so a single slow invocation never risks a statement
-- timeout or an all-or-nothing rollback on a large one-shot delete.

create or replace function public.retention_collapse_series_intraday_batch(batch_size int default 1000)
returns int
language sql
as $$
  with series_metrics as (
    select unnest(array['price_usd','market_cap_usd','tvl_usd','revenue_24h_usd','fees_24h_usd']) as metric_id
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    join series_metrics s on s.metric_id = t.metric_id
    where t.observed_at < now() - interval '14 days'
      and t.observed_at >= now() - interval '30 days'
      and exists (
        select 1 from public.token_metric_observations newer
        where newer.token_id = t.token_id and newer.metric_id = t.metric_id
          and date_trunc('day', newer.observed_at) = date_trunc('day', t.observed_at)
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

create or replace function public.retention_collapse_other_intraday_batch(batch_size int default 1000)
returns int
language sql
as $$
  with series_metrics as (
    select unnest(array['price_usd','market_cap_usd','tvl_usd','revenue_24h_usd','fees_24h_usd']) as metric_id
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    where t.metric_id not in (select metric_id from series_metrics)
      and t.observed_at < now() - interval '1 day'
      and t.observed_at >= now() - interval '30 days'
      and exists (
        select 1 from public.token_metric_observations newer
        where newer.token_id = t.token_id and newer.metric_id = t.metric_id
          and date_trunc('day', newer.observed_at) = date_trunc('day', t.observed_at)
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

create or replace function public.retention_collapse_weekly_batch(batch_size int default 1000)
returns int
language sql
as $$
  with doomed as (
    select t.id
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '90 days'
      and exists (
        select 1 from public.token_metric_observations newer
        where newer.token_id = t.token_id and newer.metric_id = t.metric_id
          and date_trunc('week', newer.observed_at) = date_trunc('week', t.observed_at)
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

create or replace function public.retention_expire_observations_batch(batch_size int default 40)
returns int
language sql
as $
  with doomed as (
    select id
    from public.token_metric_observations
    where observed_at < now() - interval '90 days'
    order by observed_at, id
    limit batch_size
    for update skip locked
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$;

create or replace function public.retention_expire_raw_provider_records_batch(batch_size int default 1000)
returns int
language sql
as $$
  with doomed as (
    select id from public.raw_provider_records
    where collected_at < now() - interval '7 days'
    limit batch_size
  ),
  deleted as (
    delete from public.raw_provider_records t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

revoke all on function
  public.retention_collapse_series_intraday_batch(int),
  public.retention_collapse_other_intraday_batch(int),
  public.retention_collapse_weekly_batch(int),
  public.retention_expire_observations_batch(int),
  public.retention_expire_raw_provider_records_batch(int)
from public;

grant execute on function
  public.retention_collapse_series_intraday_batch(int),
  public.retention_collapse_other_intraday_batch(int),
  public.retention_collapse_weekly_batch(int),
  public.retention_expire_observations_batch(int),
  public.retention_expire_raw_provider_records_batch(int)
to service_role;

-- Lease-based lock, mirroring geckoterminal_sync_runs: a single 'running' row at a
-- time, self-releasing if a run crashes or is killed mid-flight.
create table public.retention_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  lease_expires_at timestamptz not null,
  lock_token text not null,
  summary jsonb,
  error text
);

create unique index retention_runs_one_running_idx
  on public.retention_runs (status)
  where status = 'running';

create index retention_runs_finished_idx
  on public.retention_runs (status, finished_at desc);

alter table public.retention_runs enable row level security;
revoke all on table public.retention_runs from anon, authenticated;
grant select, insert, update, delete on table public.retention_runs to service_role;
grant usage, select on sequence public.retention_runs_id_seq to service_role;

commit;

-- Verification:
-- select proname from pg_proc where proname like 'retention_%';
-- select trigger, status, started_at, finished_at, summary from public.retention_runs order by started_at desc limit 5;
