-- Dashboard calculated-metric read fix: support the "newest calculated_at
-- among the dashboard's metric_ids" lookup in readDashboardCalculated()
-- (src/lib/data/live-data.ts) without scanning every matching row.
--
-- Root cause: calculated_metric_observations only had indexes leading with
-- token_id (calculated_metrics_latest_idx, calculated_metrics_period_idx).
-- The dashboard's first read has no token_id filter — it asks for the newest
-- calculated_at across a metric_id list — so Postgres had to Index-Only-Scan
-- every row for those metric_ids (~109k rows on production) and sort them to
-- get ORDER BY calculated_at DESC LIMIT 1, taking ~7.2s and eventually
-- exceeding statement_timeout (57014). Verified via EXPLAIN (ANALYZE,
-- BUFFERS) against production before writing this migration.
--
-- This is unrelated to the Phase 11B migration (20260925090000): Phase 11B's
-- latest_token_metric_observations / latest_raw_provider_records views and
-- indexes never covered calculated_metric_observations, so there is no
-- "Phase 11B path" for this table to fall back from.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so unlike
-- the repo's other migrations this file intentionally has no begin/commit
-- wrapper and contains only this one statement.

create index concurrently if not exists calculated_metrics_metric_calculated_at_idx
  on public.calculated_metric_observations (metric_id, calculated_at desc);

-- Verification (expected: Index Only Scan on calculated_metrics_metric_calculated_at_idx,
-- no full metric_id-filtered scan/sort):
-- explain (analyze, buffers) select calculated_at from public.calculated_metric_observations
--   where metric_id in ('market_cap_to_tvl', 'volume_to_market_cap') order by calculated_at desc limit 1;
