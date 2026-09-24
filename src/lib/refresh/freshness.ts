import { PROVIDER_STEPS, REFRESH_POLICY, type ProviderStep, type RefreshStep } from "./config.ts";

export type FreshnessState = "current" | "stale" | "unavailable";

export type ProviderFreshness = {
  id: ProviderStep;
  label: string;
  refreshedAt: string | null;
  ageLabel: string | null;
  state: FreshnessState;
};

export type RefreshStatusView = {
  providers: ProviderFreshness[];
  metricsCalculatedAt: string | null;
  latestRunStatus: string | null;
};

export function relativeAge(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function newest(...values: (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value as string)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

/**
 * Provider freshness uses each provider's own threshold (REFRESH_POLICY), not
 * a universal one. The refresh time is the newer of the last successful
 * automated refresh and the latest stored collection time, so manual
 * collector runs are reflected too.
 */
export function buildRefreshStatus(input: {
  lastSuccess: Partial<Record<RefreshStep, string>>;
  latestCollected: Partial<Record<ProviderStep, string>>;
  latestRunStatus: string | null;
  now: Date;
}): RefreshStatusView {
  const providers = PROVIDER_STEPS.map((id) => {
    const policy = REFRESH_POLICY[id];
    const refreshedAt = newest(input.lastSuccess[id], input.latestCollected[id]);
    const state: FreshnessState = !refreshedAt
      ? "unavailable"
      : input.now.getTime() - Date.parse(refreshedAt) > policy.staleAfterMs ? "stale" : "current";
    return { id, label: policy.label, refreshedAt, ageLabel: refreshedAt ? relativeAge(refreshedAt, input.now) : null, state };
  });
  return { providers, metricsCalculatedAt: input.lastSuccess.metrics ?? null, latestRunStatus: input.latestRunStatus };
}
