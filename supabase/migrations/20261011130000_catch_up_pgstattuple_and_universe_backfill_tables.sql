-- Reconciliation (scoped, low-risk portion only): pgstattuple extension + table structure for five
-- tables that exist live with no definition anywhere in this repo. Captured via direct introspection
-- against the live project on 2026-10-11 (information_schema.columns, pg_constraint, pg_indexes,
-- information_schema identity columns) -- additive/idempotent (create extension/table/index if not
-- exists) so it is a no-op wherever these already exist.
--
-- Deliberately NOT included here (out of scope for this pass -- see the session discussion): the
-- ~24 custom SQL functions and 6 pg_cron jobs that actually populate and drive these tables
-- (coingecko backfill worker, provider backfill worker, universe-candidate discovery/validation
-- pipeline, daily-snapshot/retention/vacuum machinery). Those exist and run live; this migration
-- only brings the checked-in schema up to date with their current *shape*, not their behavior.
-- Re-deriving the function bodies correctly was judged too large and too risky to do from
-- introspection alone in one pass -- a future pass should do that deliberately, table/feature at a
-- time, each verified as a no-op against production before committing, same as this one.

create extension if not exists pgstattuple;

-- ---- CoinGecko history-backfill worker state (one row; its own pacing/cursor) ----
create table if not exists public.coingecko_backfill_state (
  id text primary key,
  next_index integer not null default 0,
  status text not null default 'running',
  last_token_id text,
  total_inserted bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---- Generic provider history-backfill worker state (same shape, keyed per-provider) ----
create table if not exists public.provider_backfill_state (
  id text primary key,
  provider text not null,
  next_index integer not null default 0,
  status text not null default 'running',
  last_token_id text,
  total_inserted bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---- Dedup keys for the CoinGecko UTC daily-snapshot job (one row per token/metric/day already captured) ----
create table if not exists public.coingecko_daily_snapshot_keys (
  token_id text not null,
  chain_id text not null,
  metric_id text not null,
  utc_day date not null,
  created_at timestamptz not null default now(),
  constraint coingecko_daily_snapshot_keys_pkey primary key (token_id, chain_id, metric_id, utc_day),
  constraint coingecko_daily_snapshot_keys_metric_check check (metric_id = any (array['market_cap_usd', 'circulating_supply', 'total_supply', 'maximum_supply'])),
  constraint coingecko_daily_snapshot_keys_metric_fkey foreign key (metric_id) references public.metric_definitions(id) on update cascade on delete cascade,
  constraint coingecko_daily_snapshot_keys_token_fkey foreign key (token_id, chain_id) references public.tokens(id, chain_id) on delete cascade
);

-- ---- Research-universe discovery/validation pipeline: one row per candidate token, tracking it
-- through identity resolution, CoinGecko/Binance/logo/historical-data/supply checks, and final
-- eligibility -- the pipeline that decides what joins canonical_tokens, not the canonical list itself. ----
create table if not exists public.universe_candidates (
  id bigint generated always as identity primary key,
  coingecko_id text not null,
  symbol text not null,
  name text not null,
  chain_id text references public.chains(id) on update cascade on delete set null,
  contract_address text,
  is_native boolean not null default false,
  token_id text references public.tokens(id) on update cascade on delete set null,
  identity_status text not null default 'unresolved' check (identity_status = any (array['valid', 'collision', 'unresolved'])),
  identity_evidence jsonb not null default '{}'::jsonb,
  universe_status text not null default 'candidate' check (universe_status = any (array['candidate', 'canonical', 'duplicate', 'deprecated', 'migrated', 'needs_review'])),
  duplicate_of_id bigint references public.universe_candidates(id) on delete set null,
  migrated_to_coingecko_id text,
  status_reason text,
  source text not null default 'coingecko_markets',
  market_cap_rank integer,
  discovered_at timestamptz not null default now(),
  last_seen_in_source_at timestamptz,
  coingecko_status text check (coingecko_status = any (array['pass', 'fail', 'temporarily_unavailable'])),
  coingecko_checked_at timestamptz,
  coingecko_failure_reason text,
  coingecko_has_market_data boolean,
  coingecko_has_supply_data boolean,
  binance_status text check (binance_status = any (array['pass', 'fail', 'temporarily_unavailable'])),
  binance_symbol text,
  binance_base_asset text,
  binance_quote_asset text,
  binance_market_status text,
  binance_market_type text check (binance_market_type = any (array['spot', 'futures_only', 'none'])),
  binance_resolution_method text check (binance_resolution_method = any (array['direct_usdt', 'direct_usdc', 'approved_stable', 'btc_route', 'eth_route', 'unresolved'])),
  binance_checked_at timestamptz,
  binance_failure_reason text,
  logo_url text,
  logo_source text check (logo_source = any (array['coingecko', 'binance', 'existing', 'unavailable'])),
  logo_verified boolean not null default false,
  logo_status text check (logo_status = any (array['pass', 'fail', 'temporarily_unavailable'])),
  logo_checked_at timestamptz,
  logo_failure_reason text,
  historical_data_status text check (historical_data_status = any (array['pass', 'fail', 'temporarily_unavailable'])),
  historical_coverage_days numeric,
  historical_required_days numeric,
  historical_data_checked_at timestamptz,
  historical_data_failure_reason text,
  supply_status text check (supply_status = any (array['pass', 'needs_review', 'fail'])),
  has_circulating_supply boolean,
  has_total_supply boolean,
  has_max_supply boolean,
  has_reported_fdv boolean,
  supply_checked_at timestamptz,
  supply_failure_reason text,
  eligibility_status text check (eligibility_status = any (array['eligible', 'ineligible', 'needs_review', 'temporarily_unavailable'])),
  eligibility_reason_codes text[] not null default '{}'::text[],
  eligibility_checked_at timestamptz,
  eligibility_config_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  absent_from_source_streak integer not null default 0,
  constraint universe_candidates_coingecko_id_key unique (coingecko_id)
);
create index if not exists universe_candidates_chain_id_idx on public.universe_candidates (chain_id);
create index if not exists universe_candidates_eligibility_status_idx on public.universe_candidates (eligibility_status);
create index if not exists universe_candidates_market_cap_rank_idx on public.universe_candidates (market_cap_rank);
create index if not exists universe_candidates_symbol_idx on public.universe_candidates (symbol);
create index if not exists universe_candidates_token_id_idx on public.universe_candidates (token_id);
create index if not exists universe_candidates_universe_status_idx on public.universe_candidates (universe_status);

-- ---- One row per research-universe validation pass over universe_candidates ----
create table if not exists public.universe_validation_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null default 'running' check (status = any (array['running', 'succeeded', 'failed'])),
  config jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists universe_validation_runs_started_at_idx on public.universe_validation_runs (started_at desc);
