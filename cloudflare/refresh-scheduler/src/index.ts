export interface Env {
  /** Base URL of the Vercel deployment, e.g. "https://tokensam.vercel.app" (no trailing slash needed). */
  REFRESH_URL: string;
  /** Must equal the Vercel deployment's own CRON_SECRET (see src/lib/refresh/auth.ts). Set as a Wrangler secret. */
  CRON_SECRET: string;
  /**
   * CoinGecko key used only by the /coingecko-proxy route below. Cloudflare's outbound IP
   * pool is separate from Vercel's AWS Lambda IPs, which CoinGecko
   * started rejecting with 403 for this project even though the key and account are fine —
   * this proxy exists purely to give CoinGecko requests a different, unblocked egress path.
   * Set as a Wrangler secret; optional (the proxy route no-ops with a clear error if unset).
   */
  COINGECKO_API_KEY?: string;
  /** "demo" (default) or "pro" — must match the actual key's plan. */
  COINGECKO_API_PLAN?: string;
  /** Resend API key used only for threshold alerts. */
  RESEND_API_KEY?: string;
}

const COINGECKO_PROXY_PREFIX = "/coingecko-proxy";

/**
 * Forwards a CoinGecko request through Cloudflare's network instead of Vercel's, working
 * around CoinGecko blocking Vercel's shared AWS Lambda IP range for this project (the key
 * itself works fine from any other IP — confirmed directly against api.coingecko.com).
 * Requires the same `Authorization: Bearer <CRON_SECRET>` convention as the other routes
 * this Worker exposes, so it can't be used as an open CoinGecko proxy by anyone else.
 * Forwards the path/query after the prefix verbatim (e.g. /coingecko-proxy/coins/markets?...
 * -> https://api.coingecko.com/api/v3/coins/markets?...), and passes back CoinGecko's status,
 * body, and retry-after header unchanged so the caller's existing retry logic keeps working.
 */
async function handleCoinGeckoProxy(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.COINGECKO_API_KEY) {
    return Response.json({ error: "COINGECKO_API_KEY is not configured on this Worker." }, { status: 500 });
  }

  const plan = (env.COINGECKO_API_PLAN?.trim().toLowerCase() || "demo") === "pro" ? "pro" : "demo";
  const upstreamBase = plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  const keyHeader = plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key";

  const incoming = new URL(request.url);
  const upstreamPath = incoming.pathname.slice(COINGECKO_PROXY_PREFIX.length) || "/";
  const upstreamUrl = `${upstreamBase}${upstreamPath}${incoming.search}`;

  try {
    // /coins/markets (unlike /ping) sits behind an AWS CloudFront WAF that returned a
    // CloudFront-branded 403 page for this exact request when tested with no User-Agent —
    // a common bot-protection heuristic. An honest, identifying User-Agent (not a spoofed
    // browser string) costs nothing to try and is the more defensible choice long-term.
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        [keyHeader]: env.COINGECKO_API_KEY,
        accept: "application/json",
        "user-agent": "TokenSamurai/1.0",
      },
    });
    const body = await upstreamResponse.text();
    const headers = new Headers({ "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" });
    const retryAfter = upstreamResponse.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    if (!upstreamResponse.ok) {
      // Diagnostic only: status, a few response headers, and the CF-Ray id that
      // identifies which Cloudflare PoP/route handled this — never the API key or body.
      console.error("[diagnostic] coingecko-proxy: upstream returned non-2xx", {
        status: upstreamResponse.status,
        upstreamPath,
        cfRay: upstreamResponse.headers.get("cf-ray"),
        server: upstreamResponse.headers.get("server"),
        via: upstreamResponse.headers.get("via"),
        contentType: upstreamResponse.headers.get("content-type"),
      });
    }
    return new Response(body, { status: upstreamResponse.status, headers });
  } catch (error) {
    return Response.json(
      { error: `CoinGecko proxy request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

type RouteResult = { path: string; status: number; body: string; error: string | null };

const DATABASE_ALERT_RECIPIENT = "dm9381369@gmail.com";
const DATABASE_ALERT_SENDER = "onboarding@resend.dev";

async function sendDatabaseAlert(env: Env, databaseSizeMb: number): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.error("refresh-scheduler: RESEND_API_KEY is not configured; database alert email was not sent.");
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: DATABASE_ALERT_SENDER,
      to: [DATABASE_ALERT_RECIPIENT],
      subject: "Token Samurai — Supabase database storage alert",
      html: `
        <h2>Token Samurai database storage alert</h2>
        <p>Supabase database storage has reached <strong>440 MiB</strong> or more.</p>
        <ul>
          <li><strong>Current size:</strong> ${databaseSizeMb.toFixed(1)} MiB</li>
          <li><strong>Threshold:</strong> 440 MiB</li>
          <li><strong>Checked:</strong> ${new Date().toISOString()}</li>
        </ul>
        <p>Please investigate database growth before the 500 MB Supabase Free Plan limit is reached.</p>
      `,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error("refresh-scheduler: Resend database alert failed:", response.status, body.slice(0, 500));
    return;
  }

  console.log("refresh-scheduler: database storage alert email sent.");
}


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

  if (isSuccessfulResponse(refreshResult)) {
    try {
      const refreshBody = JSON.parse(refreshResult.body) as {
        databaseSizeMb?: unknown;
        databaseAlert?: unknown;
      };
      if (refreshBody.databaseAlert === true && typeof refreshBody.databaseSizeMb === "number") {
        await sendDatabaseAlert(env, refreshBody.databaseSizeMb);
      }
    } catch (error) {
      console.error("refresh-scheduler: could not parse refresh database monitoring result:", error);
    }
  }

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

  // /api/cron/retention has its own once-a-day due-check (retention windows are
  // day-granular), so calling it on every 5-minute tick like the routes above is cheap:
  // almost every tick is a `{"status":"skipped"}` no-op. Called regardless of whether
  // GeckoTerminal ran or was skipped above, since retention is independent database
  // maintenance, not additional load tied to a successful refresh.
  const retentionResult = await callRoute(env.REFRESH_URL, "/api/cron/retention", env.CRON_SECRET);
  if (retentionResult.error) console.error(`refresh-scheduler: /api/cron/retention request failed: ${retentionResult.error}`);
  else console.log(`refresh-scheduler: /api/cron/retention -> ${retentionResult.status} ${retentionResult.body.slice(0, 500)}`);

  return [refreshResult, geckoTerminalResult, retentionResult];
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },
  // A plain GET lets the deployment be smoke-tested from a browser/curl without waiting for
  // the next Cron Trigger tick; it does not run on any schedule itself. A request under
  // /coingecko-proxy instead takes the dedicated CoinGecko-egress path above.
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(COINGECKO_PROXY_PREFIX)) {
      return handleCoinGeckoProxy(request, env);
    }
    const results = await run(env);
    return Response.json({ ok: results.every((result) => !result.error), results });
  },
};
