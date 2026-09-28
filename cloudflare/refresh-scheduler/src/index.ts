export interface Env {
  /** Base URL of the Vercel deployment, e.g. "https://tokensam.vercel.app" (no trailing slash needed). */
  TARGET_BASE_URL: string;
  /** Must equal the Vercel deployment's own CRON_SECRET (see src/lib/refresh/auth.ts). Set as a Wrangler secret. */
  CRON_SECRET: string;
}

type RouteResult = { path: string; status: number; body: string; error: string | null };

/**
 * Calls one scheduled route with the same `Authorization: Bearer <CRON_SECRET>` convention
 * both /api/cron/refresh and /api/cron/geckoterminal require. `x-scheduled-by` lets those
 * routes label the run "scheduled" instead of "manual" (they cannot see Vercel's own
 * `x-vercel-cron-schedule` header from here, since this call is not Vercel Cron itself).
 */
async function callRoute(baseUrl: string, path: string, secret: string): Promise<RouteResult> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-scheduled-by": "cloudflare-worker",
      },
    });
    const body = await response.text();
    return { path, status: response.status, body, error: null };
  } catch (error) {
    return { path, status: 0, body: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs on every 5-minute Cron Trigger tick (see wrangler.toml). Both routes gate their own
 * actual work internally, so calling both on every tick is safe and is what makes their
 * intended cadences effective now that Vercel Hobby cannot run a sub-daily cron directly:
 *
 * - /api/cron/refresh: each provider's own REFRESH_POLICY interval (CoinGecko/DEX Screener
 *   15 min, DeFiLlama Coins 30 min, DeFiLlama 6 h, DUE_TOLERANCE_MS 2 min) decides what actually
 *   runs; a tick where nothing is due returns quickly with an empty `due` list.
 * - /api/cron/geckoterminal: GECKOTERMINAL_SYNC_INTERVAL (13 min by default) means two out of
 *   every three 5-minute ticks return `{"status":"skipped","reason":"not_due"}` immediately,
 *   and the third actually collects — an effective ~15-minute GeckoTerminal cadence. Its own
 *   database lock (geckoterminal_sync_runs) also means a tick that lands while a collection
 *   from a previous tick is still running just gets `{"status":"busy"}` (409) rather than
 *   starting a second, overlapping run.
 *
 * Sequential, not parallel: GeckoTerminal is rate-limit sensitive (6.5 s/request) and
 * independent of the main refresh, so there is no reason to race them against each other for
 * this Worker's own CPU-time budget.
 */
async function run(env: Env): Promise<RouteResult[]> {
  if (!env.TARGET_BASE_URL || !env.CRON_SECRET) {
    console.error("refresh-scheduler: TARGET_BASE_URL and CRON_SECRET must both be configured (see wrangler.toml).");
    return [];
  }
  const results: RouteResult[] = [];
  for (const path of ["/api/cron/refresh", "/api/cron/geckoterminal"]) {
    const result = await callRoute(env.TARGET_BASE_URL, path, env.CRON_SECRET);
    results.push(result);
    if (result.error) console.error(`refresh-scheduler: ${path} request failed: ${result.error}`);
    else console.log(`refresh-scheduler: ${path} -> ${result.status} ${result.body.slice(0, 500)}`);
  }
  return results;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },
  // A plain GET lets the deployment be smoke-tested from a browser/curl without waiting for
  // the next Cron Trigger tick; it does not run on any schedule itself.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const results = await run(env);
    return Response.json({ ok: results.every((result) => !result.error), results });
  },
};
