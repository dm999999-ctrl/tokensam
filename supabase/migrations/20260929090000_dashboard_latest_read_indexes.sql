-- Dashboard latest-observation and latest-raw-record indexes.
--
-- The application reads the latest_* views, which use DISTINCT ON over the
-- full observation/raw-record history. These indexes match each view's
-- DISTINCT ON and descending freshness order, allowing PostgreSQL to stop at
-- the newest row for each token/provider/metric (or provider/token/chain)
-- instead of sorting/scanning the historical tables on every dashboard load.

create index concurrently if not exists token_metric_observations_latest_dashboard_idx
  on public.token_metric_observations (
    token_id,
    provider_id,
    metric_id,
    observed_at desc,
    collected_at desc,
    id desc
  )
  where excluded_reason is null;

create index concurrently if not exists raw_provider_records_latest_token_idx
  on public.raw_provider_records (
    provider_id,
    token_id,
    chain_id,
    collected_at desc,
    id desc
  )
  where excluded_reason is null;

-- Logo fallback reads recent CoinGecko market records by endpoint/token/time.
create index concurrently if not exists raw_provider_records_coingecko_markets_lookup_idx
  on public.raw_provider_records (
    provider_id,
    endpoint_label,
    token_id,
    collected_at desc
  )
  where excluded_reason is null;
