/**
 * Per-provider health and cooldown. State is in memory per server instance: a
 * provider that just failed is not called again by this instance until its
 * cooldown ends; then one probe request is allowed, which restores it on
 * success or extends the cooldown (bounded exponential) on failure. Only
 * categories and timestamps are kept, never provider messages.
 */

import type { FailureCategory } from "./types.ts";

export type HealthStatus = "healthy" | "cooldown" | "free_quota_exhausted" | "configuration_error";

export type ProviderHealth = {
  status: HealthStatus;
  /** Epoch ms when the provider may be probed again (null while healthy). */
  until: number | null;
  consecutiveFailures: number;
  lastCategory: FailureCategory | null;
};

export const COOLDOWN_POLICY = {
  /** Transient failures: 60 s, doubling per consecutive failure, capped at 15 minutes. */
  transientBaseMs: 60_000,
  transientMaxMs: 15 * 60_000,
  /** Free quota exhausted: wait 6 hours before probing again (quotas reset daily or on expiry). */
  quotaMs: 6 * 60 * 60_000,
  /** Configuration errors do not fix themselves; probe again after 30 minutes. */
  configurationMs: 30 * 60_000,
} as const;

export type ProviderHealthStore = {
  get(providerId: string, now: number): ProviderHealth & { available: boolean; probing: boolean };
  recordSuccess(providerId: string): void;
  /** Only transient, quota, and configuration failures change health; output-quality failures leave it unchanged. */
  /** `minCooldownMs` (e.g. a provider's Retry-After) lengthens the cooldown, capped at the quota cooldown. */
  recordFailure(providerId: string, category: FailureCategory, now: number, minCooldownMs?: number | null): ProviderHealth;
  snapshot(): Record<string, ProviderHealth>;
  reset(): void;
};

const HEALTHY: ProviderHealth = { status: "healthy", until: null, consecutiveFailures: 0, lastCategory: null };

export function createProviderHealth(): ProviderHealthStore {
  const states = new Map<string, ProviderHealth>();
  return {
    get(providerId, now) {
      const state = states.get(providerId) ?? HEALTHY;
      const cooling = state.until !== null && state.until > now;
      return { ...state, available: !cooling, probing: state.status !== "healthy" && !cooling };
    },
    recordSuccess(providerId) {
      states.set(providerId, { ...HEALTHY });
    },
    recordFailure(providerId, category, now, minCooldownMs) {
      const previous = states.get(providerId) ?? HEALTHY;
      // The provider answered: output-quality failures are handled by fallback, not cooldown.
      if (category !== "transient" && category !== "quota" && category !== "configuration") return previous;
      const failures = previous.consecutiveFailures + 1;
      let status: HealthStatus = "cooldown";
      let durationMs: number;
      if (category === "quota") {
        status = "free_quota_exhausted";
        durationMs = COOLDOWN_POLICY.quotaMs;
      } else if (category === "configuration") {
        status = "configuration_error";
        durationMs = COOLDOWN_POLICY.configurationMs;
      } else {
        durationMs = Math.min(COOLDOWN_POLICY.transientMaxMs, COOLDOWN_POLICY.transientBaseMs * 2 ** (failures - 1));
      }
      if (minCooldownMs && minCooldownMs > durationMs) durationMs = Math.min(minCooldownMs, COOLDOWN_POLICY.quotaMs);
      const next: ProviderHealth = { status, until: now + durationMs, consecutiveFailures: failures, lastCategory: category };
      states.set(providerId, next);
      return next;
    },
    snapshot() {
      return Object.fromEntries(states);
    },
    reset() {
      states.clear();
    },
  };
}

/** Shared by all requests handled by this server instance. */
export const providerHealth = createProviderHealth();
