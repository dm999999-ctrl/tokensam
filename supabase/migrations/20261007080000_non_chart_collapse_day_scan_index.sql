-- retention_collapse_non_chart_daily_batch's day-finding loop (see
-- 20261005050000_bound_non_chart_collapse_by_groups.sql) runs, per call, up to 31
-- per-day existence checks:
--
--   where observed_at >= day_cursor and observed_at < day_cursor + interval '1 day'
--     and not (...chart-metric exclusions...)
--   group by token_id, metric_id, provider_id
--   having count(*) > 1
--   limit 1
--
-- EXPLAIN on this shows Postgres picking token_metric_latest_lookup_idx
-- (token_id, provider_id, metric_id, observed_at desc, ...) for its Index Only Scan,
-- because that's the only index whose column order matches the GROUP BY (letting it
-- stream the aggregate without an explicit sort). But observed_at is the 4th column in
-- that index, not a leading one, so the "Index Cond" on observed_at can't narrow the
-- scan to one day -- Postgres walks the index across every token_id/provider_id/
-- metric_id combination and filters by date afterward (cost ~24682, ~89891 rows
-- examined for a single day in the Oct 6 backlog). The loop also has no way to
-- short-circuit "this day has no excess" -- proving a negative requires scanning the
-- whole day regardless -- so a normal call pays that cost for every already-collapsed
-- historical day before it ever reaches the backlogged one.
--
-- This was always more expensive than it needed to be, but it was cheap enough against
-- the ~2-7K non-chart rows/day this ran against through Oct 5. Oct 6 jumped to ~153K
-- non-chart rows in a single day (ingest rate roughly quadrupled: new Binance provider
-- plus a shorter CoinGecko poll interval), and every scheduled retention run since has
-- failed this step with "canceling statement due to statement timeout" -- 8s for the
-- production authenticator role (see pg_roles.rolconfig), not the 120s a direct admin
-- connection gets. Zero rows have been collapsed since, so the backlog only grows.
--
-- Fix: a covering index led by observed_at lets the day-window predicate do a tight
-- index range scan instead of a filtered walk over the whole table, and still carries
-- provider_id/metric_id/token_id so the GROUP BY and chart-metric filter can be
-- evaluated index-only (no heap fetch). This does not change the function itself --
-- the query is correct, it just had nothing suited to scan with.
create index concurrently if not exists token_metric_observations_day_scan_idx
  on public.token_metric_observations (
    observed_at,
    provider_id,
    metric_id,
    token_id
  );

-- Verify:
--   explain
--   select 1 from public.token_metric_observations
--   where observed_at >= '2026-10-06' and observed_at < '2026-10-07'
--     and not (
--       (provider_id = 'coingecko' and metric_id in ('price_usd', 'volume_24h_usd'))
--       or (provider_id = 'defillama' and metric_id = 'tvl_usd')
--       or (provider_id = 'coingecko' and metric_id = 'market_cap_usd' and observed_at >= now() - interval '48 hours')
--     )
--   group by token_id, metric_id, provider_id
--   having count(*) > 1
--   limit 1;
-- -- should now show an Index Only Scan (or Index Scan) on
-- -- token_metric_observations_day_scan_idx with an Index Cond bounding both ends of
-- -- the observed_at range, not a near-full-index walk.
