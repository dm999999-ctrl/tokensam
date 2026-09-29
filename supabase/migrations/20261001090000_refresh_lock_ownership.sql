-- Ownership-safe refresh/GeckoTerminal locks.
--
-- Problem: RUN_LEASE_MS (10 min) and LOCK_LEASE_MS (15 min) both exceed the
-- Vercel route's 300 s maxDuration. When an invocation is killed by the
-- platform at ~300 s, its 'running' row survives for several more minutes,
-- and the Cloudflare Worker's 5-minute ticks see repeated 409s until the
-- lease finally expires (10-15 min later = 2-3 dead ticks).
--
-- Fix: shrink the lease close to maxDuration (330 s) and add an explicit
-- ownership credential (lock_token) plus a heartbeat column, so:
--   - a genuinely long-running invocation renews its own lease (and is
--     never stolen out from under it);
--   - a killed invocation stops renewing, so its lease expires ~30 s after
--     the platform kill instead of 10-15 minutes later;
--   - a stale invocation that (rarely) survives past its lease's expiry
--     cannot finalize a run that has since been reclaimed by a new owner,
--     because finishRun/renewLease now require the caller's lock_token to
--     match the row's *current* lock_token and status='running'.
--
-- Additive only: no existing column, row, index, or RLS policy is changed
-- or removed. gen_random_uuid() is built into PostgreSQL 13+ (Supabase's
-- minimum supported version), so no extension needs to be enabled.

begin;

alter table public.data_refresh_runs
  add column if not exists lock_token uuid not null default gen_random_uuid(),
  add column if not exists heartbeat_at timestamptz not null default now();

alter table public.geckoterminal_sync_runs
  add column if not exists lock_token uuid not null default gen_random_uuid(),
  add column if not exists heartbeat_at timestamptz not null default now();

commit;

-- Verification (expected: both columns present, NOT NULL, on both tables):
-- select table_name, column_name, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('data_refresh_runs', 'geckoterminal_sync_runs')
--    and column_name in ('lock_token', 'heartbeat_at')
--  order by table_name, column_name;
