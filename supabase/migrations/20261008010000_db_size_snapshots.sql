-- No historical record of pg_database_size exists anywhere: Postgres doesn't track it
-- over time on its own, Supabase's usage dashboard only shows a current-value gauge for
-- Database Size (unlike the day-by-day bar charts it has for Egress/Log Ingestion/Log
-- Query), and manage_retention_full_vacuum()'s db_size reading is only console.logged by
-- /api/cron/retention, never persisted. That made every "how has DB size trended"
-- question answerable only from whatever manual checks happened to be run, with no way
-- to see the actual shape of growth/collapse between them.
--
-- A tiny snapshot table + its own pg_cron job, sampled every 5 minutes (same cadence as
-- the external refresh/retention scheduler), with a separate daily job pruning anything
-- older than 30 days so this doesn't become another unbounded-growth table -- at ~24
-- bytes/row * 288 rows/day it's a rounding error next to everything else in this
-- database. The snapshot insert and the prune delete are two separate jobs rather than
-- one job doing both, matching every other job in this project (VACUUM FULL, non-chart
-- collapse): a single plain statement per job, not a semicolon-separated multi-statement
-- command (the exact shape that broke a job silently before, 20261006090000).
begin;

create table if not exists public.db_size_snapshots (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  db_bytes bigint not null
);

create index if not exists db_size_snapshots_recorded_at_idx on public.db_size_snapshots (recorded_at);

alter table public.db_size_snapshots enable row level security;
revoke all on table public.db_size_snapshots from anon, authenticated;
grant select on table public.db_size_snapshots to service_role;

select cron.schedule(
  'tokensam-db-size-snapshot',
  '*/5 * * * *',
  $$insert into public.db_size_snapshots (db_bytes) values (pg_database_size(current_database()));$$
);

select cron.schedule(
  'tokensam-db-size-snapshot-prune',
  '17 3 * * *',
  $$delete from public.db_size_snapshots where recorded_at < now() - interval '30 days';$$
);

commit;

-- Manual verification after applying:
--   select jobid, jobname, schedule, active from cron.job where jobname like 'tokensam-db-size-snapshot%';
--   select recorded_at, pg_size_pretty(db_bytes) from public.db_size_snapshots order by recorded_at desc limit 5;
