type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

// Lowered from 1000, then from 200, during 2026-09-30's production incident. batch_size=200 still hit
// "canceling statement due to statement timeout" (the database default, 2 minutes -- service_role has
// no shorter override) on the three functions whose correlated EXISTS subquery has no index led by
// metric_id or observed_at to narrow the outer scan; only the (token_id, metric_id, observed_at) index
// helps the subquery itself, not finding candidate rows in the first place. Until that's indexed
// properly, keep this small enough that even a slow candidate-row scan finishes inside 2 minutes.
const BATCH_SIZE = 40;
const MAX_BATCHES_PER_FUNCTION = 1000; // safety ceiling: 200k rows/function/run, unchanged from the prior 1000x200

const RETENTION_FUNCTIONS = [
  "retention_collapse_series_intraday_batch",
  "retention_collapse_other_intraday_batch",
  "retention_collapse_weekly_batch",
  "retention_expire_observations_batch",
  "retention_expire_raw_provider_records_batch",
] as const;

export type RetentionFunctionName = (typeof RETENTION_FUNCTIONS)[number];

export type RetentionRunResult = {
  deleted: Record<RetentionFunctionName, number>;
  batches: Record<RetentionFunctionName, number>;
  stoppedEarly: RetentionFunctionName[];
  /** Functions whose RPC call errored (e.g. a statement timeout); the next function still runs. */
  failed: Record<RetentionFunctionName, string>;
  totalDeleted: number;
};

/**
 * Runs every retention function to exhaustion (each stops on its own once it
 * returns 0), in priority order, stopping early if `deadlineAt` is reached —
 * the next scheduled run picks up where this one left off, since each batch
 * targets whatever currently qualifies rather than a fixed offset.
 *
 * One function's RPC error (a timeout, most likely) is recorded and moves on to the next
 * function rather than aborting the whole run: a single struggling function must never
 * block every other function's cleanup, which is what let raw_provider_records grow
 * unchecked while collapse_series_intraday kept timing out ahead of it in this list.
 */
export async function runRetentionBatches(client: SupabaseAdminClient, deadlineAt: number): Promise<RetentionRunResult> {
  const deleted = {} as Record<RetentionFunctionName, number>;
  const batches = {} as Record<RetentionFunctionName, number>;
  const stoppedEarly: RetentionFunctionName[] = [];
  const failed = {} as Record<RetentionFunctionName, string>;

  for (const fn of RETENTION_FUNCTIONS) {
    deleted[fn] = 0;
    batches[fn] = 0;
    for (let i = 0; i < MAX_BATCHES_PER_FUNCTION; i++) {
      if (Date.now() >= deadlineAt) {
        stoppedEarly.push(fn);
        break;
      }
      const { data, error } = await client.rpc(fn, { batch_size: BATCH_SIZE });
      if (error) {
        failed[fn] = error.message;
        break;
      }
      const count = typeof data === "number" ? data : 0;
      deleted[fn] += count;
      batches[fn] += 1;
      if (count === 0) break;
    }
  }

  const totalDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  return { deleted, batches, stoppedEarly, failed, totalDeleted };
}
