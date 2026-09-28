-- GeckoTerminal recurring collection: locking infrastructure only.
--
-- A small, dedicated lease-based lock (mirrors data_refresh_runs' proven
-- pattern from 20260925090000_automated_refresh.sql: a single 'running' row
-- enforced by a partial unique index, with an expiring lease so a crashed run
-- releases itself). This lets a scheduled GeckoTerminal collection and a
-- manual `pnpm geckoterminal:sync` safely coexist without ever running
-- concurrently.
--
-- GeckoTerminal is deliberately NOT added to data_refresh_runs/
-- data_refresh_steps: those are typed to the automated ProviderStep set
-- (coingecko/dexscreener/defillama/defillama_coins), and GeckoTerminal's
-- rotation model (a time-budgeted, tolerant-of-partial-failure sweep across a
-- cursor rather than one attempt per token per tick) does not fit that shape
-- without widening the same step-check constraint and ProviderStep union the
-- GeckoTerminal provider migration (20260929090000_geckoterminal_provider.sql)
-- deliberately avoided touching.
-- No changes to token_metric_observations, raw_provider_records, or
-- provider_pairs are needed: they are already append-only with no unique
-- constraint that could overwrite a prior observation (verified before
-- writing this migration).

begin;

create table public.geckoterminal_sync_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  lease_expires_at timestamptz not null,
  summary jsonb,
  error text
);

-- Only one 'running' row at a time; a conflict on insert means another run is busy.
create unique index geckoterminal_sync_runs_one_running_idx
  on public.geckoterminal_sync_runs (status)
  where status = 'running';

create index geckoterminal_sync_runs_finished_idx
  on public.geckoterminal_sync_runs (status, finished_at desc);

alter table public.geckoterminal_sync_runs enable row level security;
revoke all on table public.geckoterminal_sync_runs from anon, authenticated;
grant select, insert, update, delete on table public.geckoterminal_sync_runs to service_role;
grant usage, select on sequence public.geckoterminal_sync_runs_id_seq to service_role;

commit;

-- Verification (expected: 0 rows until the first scheduled or manual run):
-- select trigger, status, started_at, finished_at from public.geckoterminal_sync_runs order by started_at desc;
