-- Phase 11B: automated refresh status, a single-run lock, and bounded "latest" reads.
-- Additive only: no existing table, column, or row is changed or removed.
-- Safe to re-run: every statement is idempotent.

-- One row per refresh attempt. The partial unique index below allows at most one
-- 'running' row, which is the lock that prevents overlapping refresh jobs.
create table if not exists public.data_refresh_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null check (status in ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  started_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error text,
  check ((status = 'running') = (finished_at is null))
);

create unique index if not exists data_refresh_runs_single_running_idx
  on public.data_refresh_runs ((true)) where status = 'running';
create index if not exists data_refresh_runs_started_idx
  on public.data_refresh_runs (started_at desc);

-- One row per provider collection or metrics calculation inside a run.
create table if not exists public.data_refresh_steps (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.data_refresh_runs(id) on delete cascade,
  step text not null check (step in ('coingecko', 'defillama', 'dexscreener', 'metrics')),
  status text not null check (status in ('succeeded', 'failed', 'timed_out', 'skipped')),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists data_refresh_steps_latest_idx
  on public.data_refresh_steps (step, status, finished_at desc);

-- Latest observation per token/provider/metric. Readers use this instead of
-- scanning the full (append-only, growing) observation history.
create index if not exists token_metric_latest_lookup_idx
  on public.token_metric_observations (token_id, provider_id, metric_id, observed_at desc, collected_at desc, id desc);

create or replace view public.latest_token_metric_observations
with (security_invoker = true) as
select distinct on (token_id, provider_id, metric_id)
  id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, status,
  observed_at, collected_at, source_field, note
from public.token_metric_observations
order by token_id, provider_id, metric_id, observed_at desc, collected_at desc, id desc;

-- Latest raw record per provider/token/chain (the metrics engine only reads the
-- newest DEX Screener pair payload per token).
create index if not exists raw_provider_latest_lookup_idx
  on public.raw_provider_records (provider_id, token_id, chain_id, collected_at desc, id desc);

create or replace view public.latest_raw_provider_records
with (security_invoker = true) as
select distinct on (provider_id, token_id, chain_id)
  id, provider_id, token_id, chain_id, collected_at, endpoint_label, payload
from public.raw_provider_records
order by provider_id, token_id, chain_id, collected_at desc, id desc;

alter table public.data_refresh_runs enable row level security;
alter table public.data_refresh_steps enable row level security;
revoke all on table
  public.data_refresh_runs,
  public.data_refresh_steps,
  public.latest_token_metric_observations,
  public.latest_raw_provider_records
from anon, authenticated;
grant select, insert, update, delete on table public.data_refresh_runs, public.data_refresh_steps to service_role;
grant select on table public.latest_token_metric_observations, public.latest_raw_provider_records to service_role;
grant usage, select on sequence public.data_refresh_runs_id_seq, public.data_refresh_steps_id_seq to service_role;
