import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { PROVIDER_STEPS, type ProviderStep } from "../../../../lib/refresh/config.ts";
import { runDataRefresh } from "../../../../lib/refresh/orchestrator.ts";
import { SupabaseRefreshStore } from "../../../../lib/refresh/store.ts";

export const dynamic = "force-dynamic";
// Providers run concurrently within their own budgets (<= 120 s), then metrics (<= 90 s).
export const maxDuration = 300;

/**
 * Scheduled data refresh. Requires `Authorization: Bearer <CRON_SECRET>`.
 * Optional query parameters for development: `force=1` and `providers=coingecko,dexscreener`.
 *
 * Primarily invoked every 5 minutes by the Cloudflare Worker
 * (cloudflare/refresh-scheduler/), which is what makes REFRESH_POLICY's
 * per-provider intervals (CoinGecko/DEX Screener 15 min, DeFiLlama Coins
 * 30 min, DeFiLlama 6 h — see src/lib/refresh/config.ts) effective; each tick
 * is cheap when nothing is due, since isProviderDue() gates the actual work.
 * vercel.json also declares a once-daily Vercel Cron entry as a fallback
 * (Vercel Hobby cannot run cron more often than daily), so the route still
 * runs even if the Cloudflare Worker is ever down.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("providers")?.split(",").map((value) => value.trim()).filter(Boolean);
  if (requested?.some((value) => !PROVIDER_STEPS.includes(value as ProviderStep))) {
    return Response.json({ error: `providers must be a comma-separated subset of ${PROVIDER_STEPS.join(", ")}.` }, { status: 400 });
  }

  try {
    const client = createSupabaseAdminClient();
    // "x-vercel-cron-schedule" covers the daily Vercel Cron fallback; "x-scheduled-by" covers
    // the Cloudflare Worker, which is not Vercel Cron and so cannot set the former header.
    const trigger = request.headers.get("x-vercel-cron-schedule") || request.headers.get("x-scheduled-by") ? "scheduled" : "manual";
    const result = await runDataRefresh(client, new SupabaseRefreshStore(client), {
      trigger,
      force: url.searchParams.get("force") === "1",
      only: requested as ProviderStep[] | undefined,
    });
    // "lost_ownership" means this invocation's lease was reclaimed mid-run (see
    // runDataRefresh): its recorded steps are still committed, but it could not
    // finalize the run's own status row, so it is reported distinctly rather
    // than as an ordinary failure or success.
    const status = result.status === "busy" ? 409 : result.status === "failed" || result.status === "lost_ownership" ? 500 : 200;
    return Response.json({
      status: result.status,
      runId: result.runId,
      due: result.due,
      succeeded: result.steps.filter((step) => step.status === "succeeded").map((step) => step.step),
      failed: result.steps.filter((step) => step.status === "failed").map((step) => step.step),
      timedOut: result.steps.filter((step) => step.status === "timed_out").map((step) => step.step),
      metrics: result.steps.find((step) => step.step === "metrics")?.status ?? null,
      steps: result.steps.map(({ step, status: stepStatus, finishedAt, error }) => ({ step, status: stepStatus, finishedAt, error })),
    }, { status });
  } catch (error) {
    console.error("Data refresh failed:", error);
    return Response.json({ status: "failed", error: "Refresh failed; see server logs." }, { status: 500 });
  }
}
