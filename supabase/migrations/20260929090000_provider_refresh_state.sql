-- Provider rate-limit cooldown state.
-- Additive only: no existing table, column, or row is changed or removed.
-- Safe to re-run: every statement is idempotent.
--
-- The Cloudflare Worker scheduler calls /api/cron/refresh every 5 minutes
-- (see docs/automated-refresh.md), far more often than a provider's own
-- refresh interval. Previously, a provider whose final refresh attempt
-- failed with HTTP 429 stayed "due" (its last-successful timestamp never
-- advanced) and was re-attempted on every 5-minute tick, adding pressure to
-- a rate limiter that was already refusing requests. This table lets the
-- refresh orchestrator (src/lib/refresh/orchestrator.ts) skip a rate-limited
-- provider for a backoff period instead, without touching the Cloudflare
-- schedule or the provider's normal refresh interval.

-- One row per provider; updated in place (upsert), never accumulated.
create table if not exists public.provider_refresh_state (
  provider text primary key,
  consecutive_rate_limit_failures integer not null default 0 check (consecutive_rate_limit_failures >= 0),
  cooldown_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

-- The orchestrator looks up cooldown state by provider before building its due list.
create index if not exists provider_refresh_state_cooldown_idx
  on public.provider_refresh_state (provider, cooldown_until);

alter table public.provider_refresh_state enable row level security;
revoke all on table public.provider_refresh_state from anon, authenticated;
grant select, insert, update, delete on table public.provider_refresh_state to service_role;
