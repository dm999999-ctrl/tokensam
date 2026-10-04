type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_FUNCTION = 1000;

// Retention policy:
// - 0–30 days: preserve all granular observations for the 30D-chart-required
//   metrics only (coingecko price_usd, coingecko volume_24h_usd, defillama
//   tvl_usd -- see SERIES_RULES in src/lib/indicators/series.ts and
//   MARKET_HISTORY in src/lib/ui/profile-model.ts). Every other metric
//   (market_cap_usd, supply fields, price_change_*_pct, defillama_coins
//   price_usd, all dexscreener/geckoterminal metrics, defillama fees/revenue)
//   is collapsed to one observation per UTC day as soon as that day
//   completes, since nothing reads it at finer resolution: technical
//   indicators already sample once/day via dailySamples(), and every "current
//   value" read (dashboard, Tokenomics, Market Structure, on-chain markets)
//   uses only the single latest observation, which the same-day exclusion
//   below never touches.
// - >30–<90 days: retain exactly one daily historical observation per
//   token/metric/provider/UTC calendar day: the observation closest to 00:00 UTC;
//   delete every other granular observation immediately after it crosses 30 days.
// - >=90 days: delete all observations.
// Raw provider records are retained for 7 days.
// The database trigger trg_protect_30d_chart_observations is the final guard
// against deleting protected chart observations inside the 30-day window.
const RETENTION_FUNCTIONS = [
  "retention_collapse_non_chart_daily_batch",
  "retention_collapse_daily_batch",
  "retention_expire_observations_batch",
  "retention_expire_raw_provider_records_batch",
] as const;

export type RetentionFunctionName = (typeof RETENTION_FUNCTIONS)[number];

export type RetentionRunResult = {
  deleted: Record<RetentionFunctionName, number>;
  batches: Record<RetentionFunctionName, number>;
  stoppedEarly: RetentionFunctionName[];
  failed: Record<RetentionFunctionName, string>;
  totalDeleted: number;
};

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
