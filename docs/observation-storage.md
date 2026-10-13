# Observation storage

## Lossless index reduction (13 October 2026)

`token_metric_observations` retains its existing rows and columns. Chart readers,
tooltips, provenance, and indicator calculations continue to use the same data.
Hourly CoinGecko price history remains protected for 37 days; CoinGecko volume
and DeFiLlama TVL remain protected for 30 days. Daily retention is unchanged.

The migration `20261013062048_remove_redundant_coingecko_history_index.sql`
removes only `token_metric_coingecko_gap_lookup_idx`. The retained B-tree
`token_metric_latest_lookup_idx` has keys `(token_id, provider_id, metric_id,
observed_at DESC, collected_at DESC, id DESC)`. CoinGecko gap/history lookups
constrain the first three keys, so its timestamp range also serves these queries.
Postgres can scan the timestamp range in either direction.

The removed index occupied 31,318,016 bytes (29.87 MiB) before migration. Dropping
it releases that index's disk allocation without rewriting observation rows or
running `VACUUM FULL`. Ongoing refreshes can independently change total size.
The migration checks the retained index definition and validity and refuses to
drop an unexpectedly changed or constraint-backed gap index. A 250 ms lock
timeout bounds waiting for the brief DDL lock; a busy database can reject the
migration safely for a later retry.

This change does not implement compact historical rows or shared metadata.
The earlier 100–180 MiB estimate for that broader redesign is unverified.

## Verification

The migration was applied to Token Samurai's Supabase project on 13 October
2026. Its local filename matches the version recorded in the remote migration
history. The database measured 483.54 MiB before and 454.16 MiB after; the net
29.38 MiB change includes concurrent collector activity. The removed index itself
occupied 29.87 MiB.

- Fixed-cutoff fingerprints of complete rows matched before and after for
  11,678 observations in 10 price, volume, and TVL series across Bitcoin,
  Ethereum, Lido, and PancakeSwap. The check covered all columns, not just values.
- A representative 37-day Bitcoin price query returned 1,563 rows using the
  retained latest lookup index in reverse order. Its estimated planner cost was
  1,645, compared with 1,635 before. One measured execution took 3.46 ms after
  versus 198.73 ms before; cache state differs, so this is not a speedup claim.
- The production PancakeSwap profile rendered price, volume, volatility,
  drawdown, and TVL charts. The 24H, 7D, and 30D controls worked. The 30D view
  retained 1,396 price points, 1,363 volume points, 712 hourly risk samples,
  and 75 TVL points. No browser warnings or errors were captured in that check.
- All 26 technical-indicator tests passed. All five historical-window paging
  checks in the observation-read suite passed.
- Existing tests on the unchanged main source are not completely green:
  risk-profile was 8/9 (a source-text regex expects LF but the Windows checkout
  uses CRLF), history was 6/10 (90D expectations and older backfill fixtures),
  and observation-reads was 5/6 (the latest-observation fixture differed by
  milliseconds). These failures were not altered in this storage migration.

Application source, tests, dependencies, and chart components have no changes
relative to the worktree's base commit, `f124acc`. No build was necessary for
this database-index-only migration.

## Rollback

If production query plans demonstrate a regression, recreate the old index via
a direct database connection, outside a transaction:

```sql
create index concurrently token_metric_coingecko_gap_lookup_idx
on public.token_metric_observations (token_id, metric_id, observed_at)
where provider_id = 'coingecko';
```

Recreation needs disk headroom and consumes I/O. No observation restore is needed
because this migration never changes observation data.
