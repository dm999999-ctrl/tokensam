# Lossless observation compaction

This storage format shares repeated `note`, `source_field`, `scope`, and
`provider_asset_id` values. Every observation keeps its ID, identity, exact value,
status, units/metric, timestamps, window length, mapping/raw-record references,
and exclusion reason. It does not downsample history or change website elements,
chart sampling, tooltip units, indicators, cross-metric rules, or retention windows.

## Deployment order

1. Apply `20261013071254_compact_observation_metadata_foundation.sql` and
   `20261013073807_compact_metadata_failure_pause.sql`. Both have been applied to
   Token Samurai's Supabase project. Packing initializes disabled.
2. Deploy the server readers in `observation-reads.ts` and `observation-storage.ts`
   to the intended main Vercel deployment. No new environment variables or
   dependencies are needed; existing server-side Supabase configuration is used.
3. Verify the deployed commit and the dashboard, profiles, chart periods,
   provenance, indicators, and cross-metric analysis. Then activate a small canary
   and compare complete logical rows and website outputs before allowing the worker
   to continue. Local SQL transaction tests alone do not authorize early activation.

The compatibility view is `token_metric_observations_resolved`. It reconstructs
the original fields, preserving explicit nulls. Metadata-free base reads and
collector writes remain compatible. Existing latest/metrics RPCs, snapshot-label
trigger, and historical note editor resolve the shared metadata. Public roles
have no access to the dictionary, view, or maintenance functions; RLS is enabled.

## Operator commands

Use pnpm **11.19.0**, with the existing server environment or gitignored root
`.env.local`. Do not put secrets in commands or chat. These commands print only
maintenance status and a non-secret deployment SHA.

```powershell
pnpm storage:compact
pnpm storage:compact --enable=<verified-deployed-commit-SHA>
pnpm storage:compact --batch=25
pnpm storage:compact --disable
```

No-argument execution reports status. Enabling records the operator-verified
deployed SHA and permits the registered pg_cron worker to scan at most 100 rows
per minute. Disabling pauses future packing; existing compacted rows remain
readable. No Codex background agent is required. Dictionary cleanup runs daily
and deletes only unreferenced entries; the foreign key prevents deletion of used
metadata. Environments without pg_cron can run bounded batches from an existing
server-side scheduler instead. Never add a browser credential or public worker.

## Guards and progress

- Each source row is locked briefly and compared in full against its reconstructed
  result before its batch can commit. A mismatch or hash collision rolls back the
  entire batch and persists a paused state with an error code. Statement cancellation
  is also caught. Investigate `last_error_code` before explicitly enabling again.
- Compaction is idempotent. Rows from the incomplete current UTC day are deferred
  until that day completes. A primary-key cursor bounds scans without adding a
  second large history index. Completed observations are not retimed or averaged.
- The default allocation guard stops packing at **470 MiB** of database size.
  `headroom_required` changes no observations. Do not raise the guard without checking
  current disk usage and quota. Batches can create transient dead tuples and index
  growth before space becomes reusable.
- The table now starts ordinary autovacuum at 1% dead tuples plus 1,000, with a
  10 ms cost delay. The previous table settings were defaults. This bounds update
  churn and paces cleanup; actual progress depends on worker availability and load.
  It does not add a `VACUUM FULL` job or alter the existing full-vacuum controller.
- The metadata-reference FK and physical compactness check were installed `NOT
  VALID` to avoid an extra full-table validation scan while the column was all null.
  They enforce new and changed rows. Validate them during an appropriate maintenance
  window with `ALTER TABLE ... VALIDATE CONSTRAINT` after checking resource headroom.

The measured design projects roughly 30–40 MiB of additional row savings, subject
to index/dictionary overhead and the full migration result. This is not an immediate
physical disk reduction: ordinary vacuum makes old space reusable. Reclaiming
allocated disk space requires separately planned maintenance and a current free-disk
check. This feature does not initiate a full-table rewrite.

## Verification performed

- Seven new storage checks passed, including exact price/volume/TVL chart payload
  parity, risk outputs, null preservation, missing-schema compatibility, and refusal
  of unsafe fallback after compaction has been enabled or used.
- All 26 technical-indicator checks passed. Five historical paging checks passed.
- The real database canary packed 20 observations, verified exact reconstruction,
  verified idempotence, restored all fields, and rolled back its transaction.
- A separate real-data transaction compacted 24h baseline inputs and verified that
  the cross-metric RPC output was identical, then rolled back.
- A collision-injection transaction verified batch rollback, automatic pause, and
  the database-size guard, then rolled back. No corrupted dictionary entry committed.
- A four-token live query compared 12,655 source/resolved rows with zero differences.
- The updated production-build preview displayed live dashboard/profile data; search,
  chain filtering, sorting, and 24H/7D/30D controls worked. Price, volume, TVL, volatility,
  and drawdown rendered on desktop and mobile without captured browser warnings/errors.
- Production webpack build and TypeScript checks passed. Full lint passed with nine
  pre-existing warnings; the modified JavaScript/TypeScript files were clean.
- The full test command still stops at the existing canonical-token count assertion
  (177 versus 238). Unchanged `main` reproduced that failure, the legacy 90D history
  assertion, the millisecond-sensitive latest-row fixture, and two stale pagination
  assertions. None were introduced by the storage change or repaired in this scope.

Executable SQL canaries are in `scripts/verify-observation-compaction*.sql`. They
use the service role and explicitly roll back. Do not remove their `ROLLBACK`.

## Pause and rollback

Pause first with `pnpm storage:compact --disable`. If an older application version
must be deployed, restore **all** compacted rows first while current readers remain
live. Run small batches through `restore_observation_metadata`, checking disk and I/O
headroom between batches; do not perform one unbounded restoration update.

```sql
select public.restore_observation_metadata(array(
  select id from public.token_metric_observations
  where metadata_id is not null order by id limit 100
));
```

Repeat until no rows have a metadata reference. Restoration preserves values and
IDs. The cumulative compaction counter intentionally stays nonzero so a missing
compatibility view cannot silently produce incomplete provenance in new readers.
Keep dictionary entries until unused; the daily cleanup can reclaim them later.
