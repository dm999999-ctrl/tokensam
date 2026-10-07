import "server-only";

/**
 * Per-key, time-bounded memoization for expensive async reads.
 *
 * Supabase's free-tier Log Ingestion/Log Query quotas are driven overwhelmingly by
 * GET /rest/v1/token_metric_observations: the dashboard and token-profile pages are
 * `force-dynamic` (see src/app/page.tsx, src/app/tokens/[id]/page.tsx), so every page
 * view re-runs their full multi-metric, multi-day history reads against Supabase's
 * REST API from scratch, even when the same page was rendered moments ago with data
 * that collectors only refresh every 5-15 minutes. A short TTL here coalesces that
 * burst of near-simultaneous, near-identical reads (repeat visits, crawlers, the
 * sidebar movers read firing alongside the profile read) into one underlying
 * Supabase call per key per window, without any page-level caching semantics to get
 * wrong on a fresh deploy.
 *
 * In-process only: a serverless cold start or a different warm instance gets a miss,
 * same as before. It only removes the *duplicate* reads that land on the same warm
 * instance within the TTL, which is where the bulk of the request volume was coming
 * from (see the retention/log-ingestion investigation this was added from).
 */
export function memoizeWithTtl<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  ttlMs: number | (() => number),
  keyFn: (...args: Args) => string = (...args) => JSON.stringify(args),
): (...args: Args) => Promise<T> {
  const entries = new Map<string, { at: number; value: Promise<T> }>();

  return (...args: Args): Promise<T> => {
    const key = keyFn(...args);
    const cached = entries.get(key);
    const effectiveTtlMs = typeof ttlMs === "function" ? ttlMs() : ttlMs;
    if (cached && Date.now() - cached.at < effectiveTtlMs) return cached.value;

    const value = fn(...args).catch((error: unknown) => {
      // A failed read must not poison the cache for the rest of the TTL window.
      entries.delete(key);
      throw error;
    });
    entries.set(key, { at: Date.now(), value });
    return value;
  };
}
