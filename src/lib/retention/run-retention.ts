type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const BATCH_SIZE = 1000;
// Batches this size proved reliable in manual cleanup this same project went through;
// larger batches (2000-5000) failed unpredictably against this Postgres instance.
const MAX_BATCHES_PER_FUNCTION = 200; // safety ceiling: 200k rows/function/run

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
  totalDeleted: number;
};

/**
 * Runs every retention function to exhaustion (each stops on its own once it
 * returns 0), in priority order, stopping early if `deadlineAt` is reached —
 * the next scheduled run picks up where this one left off, since each batch
 * targets whatever currently qualifies rather than a fixed offset.
 */
export async function runRetentionBatches(client: SupabaseAdminClient, deadlineAt: number): Promise<RetentionRunResult> {
  const deleted = {} as Record<RetentionFunctionName, number>;
  const batches = {} as Record<RetentionFunctionName, number>;
  const stoppedEarly: RetentionFunctionName[] = [];

  for (const fn of RETENTION_FUNCTIONS) {
    deleted[fn] = 0;
    batches[fn] = 0;
    for (let i = 0; i < MAX_BATCHES_PER_FUNCTION; i++) {
      if (Date.now() >= deadlineAt) {
        stoppedEarly.push(fn);
        break;
      }
      const { data, error } = await client.rpc(fn, { batch_size: BATCH_SIZE });
      if (error) throw new Error(`Supabase RPC ${fn} failed: ${error.message}`);
      const count = typeof data === "number" ? data : 0;
      deleted[fn] += count;
      batches[fn] += 1;
      if (count === 0) break;
    }
  }

  const totalDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  return { deleted, batches, stoppedEarly, totalDeleted };
}
