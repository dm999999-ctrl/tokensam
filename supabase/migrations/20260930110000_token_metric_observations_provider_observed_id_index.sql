-- CoinGecko existingKeysLookup fix, part 2: this table's existing indexes all lead with
-- token_id (token_metric_history_lookup_idx, token_metric_latest_lookup_idx) or don't include
-- observed_at at all ahead of a usable trailing sort column. The query in
-- persistProviderSnapshots's existingKeysLookup (src/lib/providers/persist-snapshots.ts) filters
-- by provider_id and an observed_at window, then paginates by `id` (added in 2935c37, replacing
-- OFFSET pagination). Without an index covering exactly that shape, the first keyset page (id > 0)
-- still had to scan the whole table's history from its oldest row forward until it reached the
-- requested observed_at window, before applying LIMIT 1000 — a cost that grows every day as the
-- table grows, confirmed still consuming the full 90s CoinGecko refresh budget in production run
-- 674 (data_refresh_steps id 515), after the id-keyset fix was already live.
--
-- (provider_id, observed_at, id) directly covers this query's WHERE (provider_id equality,
-- observed_at range) and its ORDER BY/keyset column (id), so Postgres can range-scan straight to
-- the requested window regardless of how much older history exists in the table.

create index concurrently if not exists token_metric_observations_provider_observed_id_idx
  on public.token_metric_observations (provider_id, observed_at, id);

-- Verification (expected: Index Scan on token_metric_observations_provider_observed_id_idx,
-- Index Cond covering provider_id + observed_at, no scan of unrelated older history):
-- explain (analyze, buffers) select id, token_id, chain_id, metric_id, observed_at, window_days
--   from public.token_metric_observations
--   where provider_id = 'coingecko' and observed_at >= now() - interval '2 hours' and observed_at <= now()
--     and id > 0
--   order by id limit 1000;
