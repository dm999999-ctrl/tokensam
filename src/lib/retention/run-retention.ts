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
//   Exception: coingecko market_cap_usd stays granular through 48 hours, not
//   just "before today" -- the Market Snapshot's "Market cap change · 24h"
//   and "Volume / market cap change · 24h" cards (live-data.ts:
//   changeOverHorizon, volumeToMarketCapChangeOverHorizon) need a market_cap_usd
//   observation within 3 hours of exactly 24 hours ago, which a same-day-only
//   collapse (leaving "yesterday" as a single near-midnight point) usually
//   can't satisfy. 48 hours is just enough margin for that lookback.
// - >30–<90 days: retain exactly one daily historical observation per
//   token/metric/provider/UTC calendar day: the observation closest to 00:00 UTC;
//   delete every other granular observation immediately after it crosses 30 days.
//   Exception: coingecko price_usd stays fully granular through day 37, not
//   30 -- the risk profile's volatility is a rolling 7-day window of hourly
//   returns (RISK_VOLATILITY_WINDOW_DAYS in src/lib/indicators/series.ts)
//   ending at each displayed point, so a correct 30D volatility curve needs
//   hourly price data a further 7 days before the window it displays.
//   Collapsing at day 30 would degrade the first ~week of that curve to
//   warm-up noise. volume_24h_usd and tvl_usd need no such extension:
//   nothing reads beyond their own display window.
// - >=90 days: delete all observations.
// Raw provider records are retained for 7 days.
// The database trigger trg_protect_30d_chart_observations is the final guard
// against deleting protected chart observations inside their granular window
// (30 days, or 37 for coingecko price_usd).
//
// retention_collapse_non_chart_daily_batch is NOT listed here any more: it ran through
// this route's client.rpc(...) over PostgREST, whose `authenticator` role has an ~8s
// statement_timeout (pg_roles.rolconfig) -- fine while the table was small, but by
// 2026-10-08 (647K rows) even its existence-check probe alone took ~6s under the planner
// plan Postgres was actually choosing, and the real GROUP BY/DELETE work pushed it over
// 8s on every call, so the cursor-based retry (20261007110000) never advanced: the same
// day kept getting re-probed and re-failing every ~8-12 minutes indefinitely, letting a
// full day's worth of non-chart observations accumulate ungated and pushing the database
// past the 500MB free-plan hard cap. Run directly outside PostgREST instead (pg_cron,
// 20261008000000_non_chart_collapse_pg_cron.sql), the same fix already proven for
// VACUUM FULL (20261006090000/20261007120000): a session's default statement_timeout is
// far longer, and the same query that timed out every time here completed in well under
// a second once not bound by PostgREST's connection.
const RETENTION_FUNCTIONS = [
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
