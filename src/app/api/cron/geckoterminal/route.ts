import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import {
  acquireGeckoTerminalSyncLock,
  finishGeckoTerminalSyncLock,
  lastSuccessfulGeckoTerminalSync,
  type GeckoTerminalSyncTrigger,
} from "../../../../lib/providers/geckoterminal-sync-lock.ts";
import { runGeckoTerminalScheduledCollection } from "../../../../lib/providers/run-geckoterminal-collection.ts";

export const dynamic = "force-dynamic";
// Same ceiling as /api/cron/refresh on this deployment. A full 63-token sync
// can exceed this even without throttling (~7 min unthrottled, more with 429
// cooldowns), so PROCESSING_BUDGET_MS below leaves the collector time to stop
// early and persist whatever it collected rather than being hard-killed. With
// the current 63 mapped tokens, 6.5 s pacing fits ~30-40 tokens in this
// budget, so rotation (not a single run) is what covers the full universe.
export const maxDuration = 300;

// Stops starting new tokens with this much of maxDuration left, so the last
// in-flight request, its retries, and the final Supabase writes always have
// time to finish before the platform's own timeout would apply.
const PROCESSING_BUDGET_MS = 270_000;
// Longer than maxDuration so a genuinely running invocation is never stolen,
// short enough that a crashed invocation self-heals well within a few cron ticks.
const LOCK_LEASE_MS = 15 * 60 * 1000;
// Consistent with the */15 * * * * Vercel Cron schedule (see vercel.json): a
// due-check shorter than the cron cadence means a scheduled tick is always
// due, while still guarding against a duplicate manual trigger moments later.
const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000;

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Scheduled GeckoTerminal collection (Vercel Cron, every 15 minutes; see
 * vercel.json). Requires `Authorization: Bearer <CRON_SECRET>`, the same
 * secret and header convention as /api/cron/refresh.
 *
 * Gated behind `GECKOTERMINAL_SYNC_ENABLED=true` (unset/false: no-op, so
 * deploying this route never silently starts spending GeckoTerminal's rate
 * limit). `GECKOTERMINAL_SYNC_INTERVAL` (ms) controls the due-check —
 * default 10 min — independent of how often the cron itself fires, mirroring
 * the existing refresh's due-check pattern. Each invocation processes only as
 * many tokens as fit the time budget (rotation, not a full-universe sync), so
 * the 15-minute cadence is the collection tick, not the freshness of every
 * mapped token; see docs/geckoterminal-integration.md for rotation timing.
 * `GECKOTERMINAL_BATCH_DELAY_MS` may only raise pacing above the collector's
 * own conservative floor, never lower it. `force=1` bypasses the due-check
 * for manual testing.
 *
 * GeckoTerminal is entirely independent of the main refresh: it never calls
 * CoinGecko's /onchain endpoints, never spends CoinGecko quota, and this
 * route does not touch data_refresh_runs/data_refresh_steps or any
 * CoinGecko/DeFiLlama/DEX Screener collector.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.GECKOTERMINAL_SYNC_ENABLED?.trim().toLowerCase() !== "true") {
    return Response.json({ status: "disabled", message: "Set GECKOTERMINAL_SYNC_ENABLED=true to enable scheduled GeckoTerminal collection." });
  }

  const client = createSupabaseAdminClient();
  const now = new Date();
  const trigger: GeckoTerminalSyncTrigger = request.headers.get("x-vercel-cron-schedule") ? "scheduled" : "manual";
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (!force) {
    const intervalMs = positiveNumber(process.env.GECKOTERMINAL_SYNC_INTERVAL) ?? DEFAULT_SYNC_INTERVAL_MS;
    const lastSuccess = await lastSuccessfulGeckoTerminalSync(client);
    if (lastSuccess && now.getTime() - Date.parse(lastSuccess) < intervalMs) {
      return Response.json({ status: "skipped", reason: "not_due", lastSuccess, intervalMs });
    }
  }

  const runId = await acquireGeckoTerminalSyncLock(client, trigger, now, LOCK_LEASE_MS);
  if (runId === null) {
    return Response.json({ status: "busy", message: "A GeckoTerminal collection is already running." }, { status: 409 });
  }

  const startedAtIso = now.toISOString();
  console.log(`[geckoterminal-cron] started (${trigger}), run ${runId}, at ${startedAtIso}.`);
  try {
    const result = await runGeckoTerminalScheduledCollection(client, {
      deadlineAt: Date.now() + PROCESSING_BUDGET_MS,
      minRequestIntervalMs: positiveNumber(process.env.GECKOTERMINAL_BATCH_DELAY_MS) ?? undefined,
    });
    const status = result.failed.length === 0 && result.skipped.length === 0
      ? "succeeded"
      : result.succeeded.length > 0
        ? "partial"
        : "failed";
    await finishGeckoTerminalSyncLock(client, runId, status, new Date(), result as unknown as Record<string, unknown>, null);
    console.log(
      `[geckoterminal-cron] ${status} in ${result.durationMs}ms: ${result.succeeded.length}/${result.attempted} succeeded, `
      + `${result.failed.length} failed, ${result.skipped.length} skipped, ${result.observations} observations written, `
      + `${result.unavailable.length} unavailable, ${result.rateLimitEvents} rate-limit events, ${result.retries} retries.`,
    );
    return Response.json({ status, runId, ...result }, { status: status === "failed" ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    await finishGeckoTerminalSyncLock(client, runId, "failed", new Date(), {}, message).catch(() => undefined);
    console.error(`[geckoterminal-cron] failed: ${message}`);
    return Response.json({ status: "failed", runId, error: message }, { status: 500 });
  }
}
