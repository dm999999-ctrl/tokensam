/**
 * Supabase free-plan limits this project must stay under, and the budgets/thresholds
 * derived from them. One file, so a plan change (or Supabase changing its own limits)
 * is a one-line edit here rather than a hunt through cron routes and migrations.
 *
 * Source: the project's Supabase dashboard usage page (org bnbabnslzpqbgclsisjc,
 * "Token Samurai", Free plan). Verify against https://supabase.com/pricing if this
 * project ever changes plans.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const SUPABASE_FREE_PLAN_LIMITS = {
  /** Hard cap; not billing-cycle, just "how big the database is right now". */
  dbSizeBytes: 500 * MB,
  /** Monthly, resets each billing cycle. */
  egressBytesPerMonth: 5 * GB,
  /** Monthly. Supabase's own dashboard reports this in GB despite the low cap. */
  logIngestionBytesPerMonth: 1 * GB,
  /** Monthly. Far higher than the others; included for completeness, unlikely to bind. */
  logQueryBytesPerMonth: 100 * GB,
} as const;

/**
 * Egress and the two log metrics are billed per month, but nothing in this app can see
 * the actual billing-cycle total (that number lives in Supabase's own metering, not
 * Postgres). What the app CAN do is track its own approximate daily read volume (request
 * count and response bytes) and compare it against a derived daily budget: monthly limit
 * divided across the cycle, with headroom reserved for traffic this app doesn't control
 * (the Supabase dashboard itself, other clients, replication, Supabase's own log
 * ingestion of its own logs). If the app stays under its daily budget every day, the
 * monthly total stays under the limit; if a day blows through it, that is the earliest
 * possible local signal, well before the monthly dashboard number would show it.
 *
 * SAFETY_MARGIN reserves headroom in the derived daily budget for everything this
 * tracker cannot see.
 */
const BILLING_CYCLE_DAYS = 30;
const SAFETY_MARGIN = 0.7;

export const DAILY_BUDGETS = {
  egressBytes: (SUPABASE_FREE_PLAN_LIMITS.egressBytesPerMonth / BILLING_CYCLE_DAYS) * SAFETY_MARGIN,
  logIngestionBytes: (SUPABASE_FREE_PLAN_LIMITS.logIngestionBytesPerMonth / BILLING_CYCLE_DAYS) * SAFETY_MARGIN,
} as const;

/**
 * Every Supabase REST request produces roughly one edge_logs line and one
 * postgrest_logs line regardless of its response size (see the Log Ingestion/Log
 * Query investigation this module was built from: GET /rest/v1/token_metric_observations
 * alone was 69% of all edge_logs traffic). Request *count* is therefore the better
 * proxy for log-ingestion pressure; response bytes is the better proxy for egress.
 * This is a rough per-request log-line size estimate (not measured from this
 * project's actual log payloads), used only to turn a request count into a
 * comparable bytes figure against logIngestionBytes above.
 */
export const ESTIMATED_LOG_BYTES_PER_REQUEST = 2048;

export type ThrottleLevel = "none" | "warn" | "critical";

/** Fraction of the respective budget/limit at which each level engages. */
export const THROTTLE_RATIOS: Record<Exclude<ThrottleLevel, "none">, number> = {
  warn: 0.7,
  critical: 0.9,
};

export function levelForRatio(ratio: number): ThrottleLevel {
  if (ratio >= THROTTLE_RATIOS.critical) return "critical";
  if (ratio >= THROTTLE_RATIOS.warn) return "warn";
  return "none";
}

/** Highest-severity level wins when several metrics are evaluated together. */
export function combineLevels(...levels: ThrottleLevel[]): ThrottleLevel {
  if (levels.includes("critical")) return "critical";
  if (levels.includes("warn")) return "warn";
  return "none";
}

/**
 * Multiplier applied to the page-read caches in ttl-cache.ts at each level. "warn"
 * trades a little more staleness for noticeably fewer repeat reads; "critical" trades
 * a lot, since by that point avoiding the next overage matters more than freshness.
 */
export const CACHE_TTL_MULTIPLIER: Record<ThrottleLevel, number> = {
  none: 1,
  warn: 4,
  critical: 15,
};
