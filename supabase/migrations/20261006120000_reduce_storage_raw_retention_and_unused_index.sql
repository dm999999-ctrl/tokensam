-- Storage triage: free ~127 MB on the 500 MB Supabase Free plan.
--
-- Measured 2026-10-06, with the database at 459.7 MiB (92% of the limit, past the
-- 440 MiB alert threshold in cloudflare/refresh-scheduler/src/index.ts):
--
--   token_metric_observations  265 MB (139 MB data + 126 MB indexes)
--   raw_provider_records       161 MB ( 92 MB data +  68 MB indexes)
--
-- Both tables reported 0 dead tuples with healthy autovacuum, so none of this is
-- bloat and VACUUM FULL would reclaim nothing. The space is live, policy-compliant
-- data: ~400k of the 465k coingecko observations are the chart-protected granular
-- windows (price_usd 37 days, volume_24h_usd and market_cap_usd 30 days), which are
-- deliberately not collapsible. The policy is simply larger than this plan holds.
--
-- This migration therefore takes the two reductions that cost no chart, indicator,
-- or live value at all. It does NOT shorten any observation window: narrowing the
-- 37-day price_usd window would degrade the risk-profile curve and is a product
-- decision, not a cleanup.

-- ---- 1. raw_provider_records: 7 days -> 2 days (frees ~115 MB) ----
--
-- These are provider payloads kept for debugging, not user-facing data. Every
-- reader uses latest-only semantics -- token logos and reported FDV in
-- src/lib/data/live-data.ts, GeckoTerminal pool identity via
-- latest_raw_provider_records -- so none reads history. Two days still leaves
-- ~192 CoinGecko runs of cushion at the 15-minute cadence.
--
-- This restores the window 20261001194500_raw_provider_retention_2_days.sql set
-- deliberately; 20261003160000_retention_daily_utc_30_90.sql redefined this
-- function while reworking the observation policy and carried 7 days back in,
-- which appears to have been incidental rather than intended.
-- Mirrors the live definition exactly (language sql, security invoker, default 500,
-- deterministic (collected_at, id) ordering, greatest(batch_size,0) guard). The ONLY
-- change is the interval: 7 days -> 2 days. Nothing else about the function's behaviour
-- or privileges is altered.
CREATE OR REPLACE FUNCTION public.retention_expire_raw_provider_records_batch(batch_size integer DEFAULT 500)
RETURNS integer
LANGUAGE sql
AS $function$
  with doomed as (
    select id
    from public.raw_provider_records
    where collected_at < now() - interval '2 days'
    order by collected_at, id
    limit greatest(batch_size,0)
  ),
  deleted as (
    delete from public.raw_provider_records r
    using doomed
    where r.id = doomed.id
    returning r.id
  )
  select coalesce(count(*)::int,0) from deleted;
$function$;

-- ---- 2. Drop an effectively unused index (frees ~12 MB) ----
--
-- chain_metric_history_lookup_idx: 12.4 MB for 179 scans since statistics were
-- last reset, against 15.1M scans on token_metric_latest_lookup_idx and 47.0M on
-- token_metric_history_lookup_idx. No query path in src/ reads observations by
-- chain_id + metric_id; chain-scoped reads go through token_id.
--
-- Deliberately KEPT: token_metric_coingecko_gap_lookup_idx (24 MB, 6,960 scans).
-- Its scan count is low but it backs the daily gap audit that
-- 20261003183000_optimize_coingecko_daily_gap_audit.sql exists to make fast.
DROP INDEX IF EXISTS public.chain_metric_history_lookup_idx;

-- Verify (expect raw_provider_records to shrink as retention runs catch up):
--   select (regexp_match(prosrc, 'collected_at < now\(\) - interval ''([^'']+)'''))[1]
--     from pg_proc where proname = 'retention_expire_raw_provider_records_batch';
--   select pg_size_pretty(pg_database_size(current_database()));
--   select min(collected_at), count(*) from public.raw_provider_records;
