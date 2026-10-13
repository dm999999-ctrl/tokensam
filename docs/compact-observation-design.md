# Compact observation metadata: measured design

Status: feasibility prototype only. No production schema, observations, readers,
collectors, retention rules, or website components have changed for this design.

## Measured prototype

On 13 October 2026 a read-only 2% block sample of the live observation table
contained 9,934 rows and 966 distinct combinations of `note`, `source_field`,
`scope`, and `provider_asset_id`. The companion SQL script reconstructs every
original row from compact core fields and its shared metadata. It found **zero
round-trip mismatches**, including null fields and all numeric/timestamp values.

| Sample representation | Bytes |
| --- | ---: |
| Original rows | 2,513,312 |
| Compact rows, including an eight-byte metadata reference | 1,555,456 |
| Shared metadata rows | 188,809 |
| Net payload saving | 769,047 |

At the catalog's estimate of 538,349 observations, the sample projects about
39.75 MiB of payload savings. A cautious planning range is **30–40 MiB** after
dictionary/index overhead. This is additional to the separately applied 29.87
MiB index removal. It is not a guaranteed reduction in physical database size:
block sampling, row alignment, dictionary cardinality, index pages, concurrent
writes, and existing free space affect the eventual result. There has been no
full-scale migration benchmark. The earlier 100–180 MiB estimate is unsupported.

## Proposed representation

Keep observation IDs, canonical identity, provider and metric IDs, exact numeric
values, status, observed/collection/creation timestamps, raw-record references,
window length, mapping IDs, and exclusion reasons on the observation itself.
Store the four repeated metadata fields in a shared dictionary, referenced by
an optional bigint on each compacted row. Do not downsample, round, interpolate,
retime, aggregate, or delete observations as part of compaction.

A server-only compatibility view must return exactly the current logical values
and types by resolving the metadata reference. Direct rows and compacted rows
must be interchangeable to readers. An explicit presence check, rather than
blind COALESCE, must preserve intentionally null metadata. Dictionary references
need referential integrity; dictionary entries must not disappear while used.
Any hash used to deduplicate arbitrary-length notes must check full field equality
before reuse so even a hash collision cannot substitute different provenance.

Keep all existing retention windows and chart sampling rules: hourly price
inputs for the 37-day risk-profile window, volume/TVL's 30-day granular windows,
and the existing metric-specific daily history expiry. Charts, axes, tooltips,
coverage labels, indicator formulas, and cross-metric alignment must not change.

## Compatibility dependencies confirmed in the live database

- `latest_observations_bounded` and `metrics_series_recent_points` return
  `SETOF token_metric_observations`. Adding a column changes that composite
  type. Their projections must be replaced atomically with the schema change;
  daily synthetic rows also need the correct projection. The resolved fields
  must retain the original meanings and caller-selected shapes.
- `label_coingecko_daily_snapshot_aggregate` reads the source note to recognize
  `[utc-daily-snapshot-v1]`. It must resolve metadata so snapshot labels do not
  silently turn into daily averages.
- `retime_coingecko_backfill_5m_batch` reads and edits notes. If retained, it must
  read resolved metadata and preserve it when updating a compacted row.
- Historical and recent application reads in `observation-reads.ts` select all
  four fields. They must use the compatibility layer. Metadata-free volume,
  sidebar, and collector deduplication queries can keep their indexed base reads.
- Direct metadata edits need an explicit restore/update path that preserves all
  other fields and distinguishes clearing a value from leaving it unchanged.
- Existing observation deletion guards and daily aggregation must continue to
  operate correctly. Dictionary storage must not change how provider observations
  are counted, selected, or expired.

## Required rollout order

1. Build and test the dictionary, compatibility view, updated SQL routines,
   application readers, and reversible bounded compactor. Default compaction
   to disabled. Keep ordinary collector writes compatible.
2. Apply the additive foundation with bounded lock waiting and no row packing.
   Verify service-role access, RLS, null behavior, view equality, SQL routine
   results, and indexed query plans.
3. Deploy the compatible application readers. Verify dashboard, profiles,
   charts, provenance, technical indicators, and cross-metric readings on the
   deployed version, including desktop/mobile views and period controls.
4. Enable a small canary only after that deployed version is verified. Compare
   complete logical rows and computed chart/indicator payloads before/after.
   Stop and restore on any mismatch. Preserve observation IDs throughout.
5. Run small idempotent batches with a size/headroom guard and pacing that
   respects the database's I/O budget. Updates create dead tuples, so measure
   transient growth and vacuum behavior before increasing throughput. Report
   compacted rows separately from rows deleted by retention.
6. Reclaim physical space only after parity checks pass and Supabase's current
   free disk space is checked. Do not automatically run a full-table rewrite
   merely because the smaller logical rows have been written.

No active compaction job or new production migration has been created. Existing
website data and display remain as they were after the earlier index optimization.
