-- Phase A: candidate-universe infrastructure (additive; safe to re-run).
--
-- This is deliberately a separate table, not an extension of `public.tokens`.
-- `tokens` remains the curated 238-token set the Dashboard and Token Profiles
-- read today (see docs/token-universe.md); nothing here changes that table or
-- what those pages query. `universe_candidates` is the much larger
-- machine-validated candidate pool (Phase A) from which a future Active 1,000
-- will eventually be selected (Phase D) and only then exposed through a
-- canonical `getActiveTokenUniverse()` (Phase D.5). A candidate may optionally
-- point at an existing `tokens.id` via `token_id` once it is confidently
-- matched to an asset already tracked there.
--
-- One row per canonical CoinGecko identity holds every Phase A concern as its
-- own column group (identity, CoinGecko, Binance, logo, historical, supply,
-- eligibility) rather than being split across several join tables: each
-- column group answers one question about one candidate, so nothing here
-- overloads a single field with unrelated meanings, and the whole row can be
-- upserted idempotently on `coingecko_id`.

create table public.universe_candidates (
  id bigint generated always as identity primary key,

  -- ---- Canonical identity (never symbol-only; see AGENTS.md Phase A #6/#12) ----
  coingecko_id text not null unique,
  symbol text not null,
  name text not null,
  chain_id text references public.chains(id) on update cascade on delete set null,
  contract_address text,
  is_native boolean not null default false,
  -- Set once this candidate is confidently matched to an existing curated token.
  token_id text references public.tokens(id) on update cascade on delete set null,
  identity_status text not null default 'unresolved'
    check (identity_status in ('valid', 'collision', 'unresolved')),
  -- Evidence used to resolve identity (e.g. symbol uniqueness, curated override,
  -- contract match); never a raw provider payload dump.
  identity_evidence jsonb not null default '{}'::jsonb,

  -- ---- Universe / structural status (distinct from eligibility; AGENTS.md #22) ----
  universe_status text not null default 'candidate'
    check (universe_status in ('candidate', 'canonical', 'duplicate', 'deprecated', 'migrated', 'needs_review')),
  duplicate_of_id bigint references public.universe_candidates(id) on delete set null,
  migrated_to_coingecko_id text,
  status_reason text,

  -- ---- Discovery / source bookkeeping ----
  source text not null default 'coingecko_markets',
  market_cap_rank integer,
  discovered_at timestamptz not null default now(),
  -- Refreshed every time the candidate is still present in the latest CoinGecko
  -- catalog fetch; a candidate that stops appearing is a deprecation signal,
  -- not a reason to delete the row (AGENTS.md #14, #30).
  last_seen_in_source_at timestamptz,

  -- ---- CoinGecko validation (AGENTS.md #7) ----
  coingecko_status text check (coingecko_status in ('pass', 'fail', 'temporarily_unavailable')),
  coingecko_checked_at timestamptz,
  coingecko_failure_reason text,
  coingecko_has_market_data boolean,
  coingecko_has_supply_data boolean,

  -- ---- Binance Spot validation (AGENTS.md #8-#12) ----
  binance_status text check (binance_status in ('pass', 'fail', 'temporarily_unavailable')),
  binance_symbol text,
  binance_base_asset text,
  binance_quote_asset text,
  binance_market_status text,
  binance_market_type text check (binance_market_type in ('spot', 'futures_only', 'none')),
  binance_resolution_method text check (
    binance_resolution_method in ('direct_usdt', 'direct_usdc', 'approved_stable', 'btc_route', 'eth_route', 'unresolved')
  ),
  binance_checked_at timestamptz,
  binance_failure_reason text,

  -- ---- Logo validation (AGENTS.md #15-#16) ----
  logo_url text,
  logo_source text check (logo_source in ('coingecko', 'binance', 'existing', 'unavailable')),
  logo_verified boolean not null default false,
  logo_status text check (logo_status in ('pass', 'fail', 'temporarily_unavailable')),
  logo_checked_at timestamptz,
  logo_failure_reason text,

  -- ---- Historical-data eligibility (AGENTS.md #17) ----
  historical_data_status text check (historical_data_status in ('pass', 'fail', 'temporarily_unavailable')),
  historical_coverage_days numeric,
  historical_required_days numeric,
  historical_data_checked_at timestamptz,
  historical_data_failure_reason text,

  -- ---- Supply / reference data (AGENTS.md #18) ----
  supply_status text check (supply_status in ('pass', 'needs_review', 'fail')),
  has_circulating_supply boolean,
  has_total_supply boolean,
  has_max_supply boolean,
  has_reported_fdv boolean,
  supply_checked_at timestamptz,
  supply_failure_reason text,

  -- ---- Eligibility engine output (AGENTS.md #19-#21, #24) ----
  eligibility_status text check (eligibility_status in ('eligible', 'ineligible', 'needs_review', 'temporarily_unavailable')),
  eligibility_reason_codes text[] not null default '{}'::text[],
  eligibility_checked_at timestamptz,
  eligibility_config_version text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index universe_candidates_universe_status_idx on public.universe_candidates (universe_status);
create index universe_candidates_eligibility_status_idx on public.universe_candidates (eligibility_status);
create index universe_candidates_chain_id_idx on public.universe_candidates (chain_id);
create index universe_candidates_token_id_idx on public.universe_candidates (token_id);
create index universe_candidates_symbol_idx on public.universe_candidates (symbol);
create index universe_candidates_market_cap_rank_idx on public.universe_candidates (market_cap_rank);

-- One row per end-to-end Phase A validation run, for idempotency auditing and
-- as the input Phase B will read (AGENTS.md #32, #34, #35).
create table public.universe_validation_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  config jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index universe_validation_runs_started_at_idx on public.universe_validation_runs (started_at desc);

-- Binance is a new provider identity used only for Spot-market validation
-- metadata here; no raw Binance ticks are ever stored (AGENTS.md #10, #30).
insert into public.data_providers (id, name, enabled)
values ('binance', 'Binance (Spot market metadata)', true)
on conflict (id) do nothing;

alter table public.universe_candidates enable row level security;
alter table public.universe_validation_runs enable row level security;

revoke all on table public.universe_candidates, public.universe_validation_runs from anon, authenticated;

grant select, insert, update, delete on table public.universe_candidates, public.universe_validation_runs to service_role;

grant usage, select on all sequences in schema public to service_role;
