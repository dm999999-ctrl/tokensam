import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { PROVIDER_STEPS, type ProviderStep } from "../../../../lib/refresh/config.ts";
import { runDataRefresh } from "../../../../lib/refresh/orchestrator.ts";
import { SupabaseRefreshStore } from "../../../../lib/refresh/store.ts";

export const dynamic = "force-dynamic";
// Providers run concurrently within their own budgets (<= 120 s), then metrics (<= 90 s).
export const maxDuration = 300;

/**
 * Scheduled data refresh (Vercel Cron, hourly). Requires `Authorization: Bearer <CRON_SECRET>`.
 * Optional query parameters for development: `force=1` and `providers=coingecko,dexscreener`.
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
    const result = await runDataRefresh(client, new SupabaseRefreshStore(client), {
      trigger: request.headers.get("x-vercel-cron-schedule") ? "scheduled" : "manual",
      force: url.searchParams.get("force") === "1",
      only: requested as ProviderStep[] | undefined,
    });
    const status = result.status === "busy" ? 409 : result.status === "failed" ? 500 : 200;
    return Response.json({
      status: result.status,
      runId: result.runId,
      due: result.due,
      steps: result.steps.map(({ step, status: stepStatus, finishedAt, error }) => ({ step, status: stepStatus, finishedAt, error })),
    }, { status });
  } catch (error) {
    console.error("Data refresh failed:", error);
    return Response.json({ status: "failed", error: "Refresh failed; see server logs." }, { status: 500 });
  }
}
