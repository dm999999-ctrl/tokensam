export interface Env {
  /** Base URL of the Vercel deployment, e.g. "https://tokensam.vercel.app" (no trailing slash needed). */
  REFRESH_URL: string;
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
 * Only a clean 2xx from `/api/cron/refresh` counts as "the refresh completed" for
 * deciding whether it is safe to add GeckoTerminal's own database work on top of it
 * this tick. `succeeded`/`partial`/nothing-due are all 200s. Anything else — a
 * network-level failure (`result.error`, which is what a `fetch` throwing looks
 * like, including the connection dropping mid-request the way a `maxDuration`-killed
 * Vercel invocation does), a 4xx (409 busy included: another invocation may still be
 * doing heavy work), or a 5xx — means Postgres may still be under load from that
 * attempt, so GeckoTerminal is skipped for this tick.
 */
function isSuccessfulResponse(result: RouteResult): boolean {
  return !result.error && result.status >= 200 && result.status < 300;
}

/**
 * Runs on every 5-minute Cron Trigger tick (see wrangler.toml).
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
 * this Worker's own CPU-time budget. It is also a correctness requirement now, not just a CPU
 * choice: GeckoTerminal only runs after `/api/cron/refresh`'s response is actually in hand, and
 * only when that response indicates the refresh completed (not necessarily every provider
 * succeeding — `partial`/`busy`/`skipped` still mean the route itself ran and returned cleanly).
 * A network-level failure or a 5xx (including a 504, which is what a `maxDuration`-killed
 * invocation looks like to an external caller) means Postgres may still be under load from that
 * failed attempt, so GeckoTerminal is skipped for this tick rather than adding more concurrent
 * database work on top of it. `ctx.waitUntil(run(env))` in the scheduled handler below already
 * means this whole sequential sequence — refresh, then conditionally GeckoTerminal — completes
 * (or the tick ends) before the next Cron Trigger tick's own `run(env)` starts; there is no
 * second, independent path that launches either route out of order.
 */
async function run(env: Env): Promise<RouteResult[]> {
  if (!env.REFRESH_URL || !env.CRON_SECRET) {
    console.error("refresh-scheduler: REFRESH_URL and CRON_SECRET must both be configured (see wrangler.toml).");
    return [];
  }

  const refreshResult = await callRoute(env.REFRESH_URL, "/api/cron/refresh", env.CRON_SECRET);
  if (refreshResult.error) console.error(`refresh-scheduler: /api/cron/refresh request failed: ${refreshResult.error}`);
  else console.log(`refresh-scheduler: /api/cron/refresh -> ${refreshResult.status} ${refreshResult.body.slice(0, 500)}`);

  if (!isSuccessfulResponse(refreshResult)) {
    console.error(
      `refresh-scheduler: skipping /api/cron/geckoterminal this tick because /api/cron/refresh did not return 2xx `
      + `(status ${refreshResult.status}${refreshResult.error ? `, error: ${refreshResult.error}` : ""}); `
      + "avoiding additional database load while refresh may still be under pressure.",
    );
    return [refreshResult];
  }

  const geckoTerminalResult = await callRoute(env.REFRESH_URL, "/api/cron/geckoterminal", env.CRON_SECRET);
  if (geckoTerminalResult.error) console.error(`refresh-scheduler: /api/cron/geckoterminal request failed: ${geckoTerminalResult.error}`);
  else console.log(`refresh-scheduler: /api/cron/geckoterminal -> ${geckoTerminalResult.status} ${geckoTerminalResult.body.slice(0, 500)}`);
  return [refreshResult, geckoTerminalResult];
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
