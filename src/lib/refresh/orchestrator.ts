import { getDefiLlamaConfig } from "../providers/defillama.ts";
import { runCoinGeckoCollection } from "../providers/run-coingecko-collection.ts";
import { runDefiLlamaCollection } from "../providers/run-defillama-collection.ts";
import { runDexScreenerCollection } from "../providers/run-dexscreener-collection.ts";
import { runDefiLlamaCoinsCollection } from "../providers/run-defillama-coins-collection.ts";
import { runMetricsCalculation } from "../metrics/run-calculation.ts";
import {
  DUE_TOLERANCE_MS,
  METRICS_TIMEOUT_MS,
  PROVIDER_STEPS,
  RATE_LIMIT_COOLDOWN_POLICY,
  REFRESH_POLICY,
  RUN_LEASE_MS,
  computeRateLimitCooldownMs,
  type ProviderStep,
  type RefreshStep,
} from "./config.ts";
import { classifyProviderError } from "./provider-errors.ts";
import type { ProviderCooldownState, RefreshStore, RefreshTrigger, RunStatus, StepRecord } from "./store.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;
type Sleep = (durationMs: number) => Promise<void>;

export type CollectorOptions = { fetchImpl: typeof fetch; sleep: Sleep };
export type CollectorDefinition = {
  /** Returns a reason to skip (for example, an unmet permission gate), or null to run. */
  skipReason?: () => string | null;
  collect: (client: SupabaseAdminClient, options: CollectorOptions) => Promise<Record<string, unknown>>;
};

export const defaultCollectors: Record<ProviderStep, CollectorDefinition> = {
  coingecko: { collect: (client, options) => runCoinGeckoCollection(client, options) },
  dexscreener: { collect: (client, options) => runDexScreenerCollection(client, options) },
  defillama: {
    // The written-permission gate is enforced, never bypassed: without it the step is skipped.
    skipReason: () => {
      try {
        getDefiLlamaConfig();
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    collect: (client, options) => runDefiLlamaCollection(client, options),
  },
  defillama_coins: {
    // Token-level DeFiLlama prices use the same written-permission gate.
    skipReason: () => {
      try {
        getDefiLlamaConfig();
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    collect: (client, options) => runDefiLlamaCoinsCollection(client, options),
  },
};

export class RefreshTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${Math.round(timeoutMs / 1000)} s refresh budget.`);
    this.name = "RefreshTimeoutError";
  }
}

export type RefreshOptions = {
  trigger: RefreshTrigger;
  /** Collect providers even if they are not yet due. */
  force?: boolean;
  /** Restrict the run to these providers. */
  only?: ProviderStep[];
  now?: () => Date;
  collectors?: Partial<Record<ProviderStep, CollectorDefinition>>;
  calculateMetrics?: (client: SupabaseAdminClient) => Promise<Record<string, unknown>>;
  timeouts?: Partial<Record<RefreshStep, number>>;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
};

export type RefreshResult = {
  status: RunStatus | "busy";
  runId: number | null;
  due: ProviderStep[];
  steps: StepRecord[];
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error.";
  // Collector errors are already sanitized (no URLs or keys); bound their size.
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

/** Wrap fetch so every request also aborts when the step deadline passes. */
export function deadlineFetch(deadline: AbortSignal, base: typeof fetch = fetch): typeof fetch {
  return (input, init = {}) => base(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

/** Wrap sleep so retry/pacing waits stop (and throw) once the step deadline passes. */
export function deadlineSleep(deadline: AbortSignal, base: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Sleep {
  return async (durationMs) => {
    if (deadline.aborted) throw deadline.reason;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(deadline.reason);
      deadline.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([base(durationMs), aborted]);
    } finally {
      deadline.removeEventListener("abort", onAbort!);
    }
  };
}

/** Hard ceiling for work that cannot be aborted (for example, database writes). */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RefreshTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep step detail small: arrays (missing IDs, unavailable metrics) are stored as counts. */
function summarize(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]));
}

export function isProviderDue(step: ProviderStep, lastSuccessAt: string | undefined, now: Date): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - Date.parse(lastSuccessAt) >= REFRESH_POLICY[step].intervalMs - DUE_TOLERANCE_MS;
}

/** True while a recorded cooldown is still in the future; false once it has expired or was never set. */
export function isProviderInCooldown(cooldownUntil: string | null | undefined, now: Date): boolean {
  return Boolean(cooldownUntil) && Date.parse(cooldownUntil as string) > now.getTime();
}

export function overallStatus(steps: StepRecord[]): Exclude<RunStatus, "running"> {
  const providers = steps.filter((step) => step.step !== "metrics");
  const attempted = providers.filter((step) => step.status !== "skipped");
  const succeeded = attempted.filter((step) => step.status === "succeeded");
  const metrics = steps.find((step) => step.step === "metrics");
  if (attempted.length === 0) return "skipped";
  if (succeeded.length === 0) return "failed";
  if (succeeded.length === attempted.length && metrics?.status === "succeeded") return "succeeded";
  return "partial";
}

/**
 * Refresh every due provider, then recalculate metrics, recording each step.
 *
 * Providers are isolated: each runs with its own deadline, and a failure or
 * timeout leaves that provider's previously stored observations untouched
 * (collectors fetch and validate before writing, and history is append-only).
 */
export async function runDataRefresh(client: SupabaseAdminClient, store: RefreshStore, options: RefreshOptions): Promise<RefreshResult> {
  const now = options.now ?? (() => new Date());
  const collectors = { ...defaultCollectors, ...options.collectors };
  const calculateMetrics = options.calculateMetrics ?? ((db: SupabaseAdminClient) => runMetricsCalculation(db));
  const timeoutFor = (step: RefreshStep) => options.timeouts?.[step]
    ?? (step === "metrics" ? METRICS_TIMEOUT_MS : REFRESH_POLICY[step].timeoutMs);

  const runId = await store.acquireRun(options.trigger, now(), RUN_LEASE_MS);
  if (runId === null) return { status: "busy", runId: null, due: [], steps: [] };

  const steps: StepRecord[] = [];
  const record = async (step: StepRecord) => {
    steps.push(step);
    await store.recordStep(runId, step);
  };

  try {
    const lastSuccess = await store.lastSuccessfulSteps();
    const candidates = PROVIDER_STEPS.filter((step) => !options.only || options.only.includes(step));

    // Only providers with a rate-limit cooldown policy (see RATE_LIMIT_COOLDOWN_POLICY)
    // need a cooldown lookup; every other provider runs on its normal due schedule.
    const cooldownStates = new Map<ProviderStep, ProviderCooldownState | null>();
    await Promise.all(candidates.filter((step) => RATE_LIMIT_COOLDOWN_POLICY[step]).map(async (step) => {
      cooldownStates.set(step, await store.getProviderCooldown(step));
    }));

    // A provider in cooldown is skipped outright: force bypasses the normal due/freshness
    // check, but never an active rate-limit cooldown, so force cannot re-hammer a limited
    // provider the moment after it failed.
    const inCooldownNow = (step: ProviderStep) => isProviderInCooldown(cooldownStates.get(step)?.cooldownUntil, now());
    const due = candidates.filter((step) => {
      if (inCooldownNow(step)) return false;
      const willRun = options.force || isProviderDue(step, lastSuccess[step], now());
      const cooldown = cooldownStates.get(step);
      if (willRun && cooldown?.cooldownUntil) {
        console.log(`${REFRESH_POLICY[step].label} cooldown expired; attempting refresh`);
      }
      return willRun;
    });

    for (const step of candidates) {
      if (due.includes(step) || !inCooldownNow(step)) continue;
      const until = cooldownStates.get(step)!.cooldownUntil as string;
      console.log(`Skipping ${REFRESH_POLICY[step].label} because provider cooldown is active until ${until}`);
      const startedAt = now().toISOString();
      await record({
        step, status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {},
        error: `Provider cooldown active until ${until}.`,
      });
    }

    // Different providers have independent rate limits, so they run concurrently;
    // each collector still serializes and paces its own requests.
    await Promise.all(due.map(async (step) => {
      const startedAt = now().toISOString();
      const definition = collectors[step];
      const skipReason = definition.skipReason?.() ?? null;
      if (skipReason) {
        await record({ step, status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {}, error: skipReason });
        return;
      }
      const timeoutMs = timeoutFor(step);
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new RefreshTimeoutError(REFRESH_POLICY[step].label, timeoutMs)), timeoutMs);
      try {
        const result = await withTimeout(
          definition.collect(client, {
            fetchImpl: deadlineFetch(deadline.signal, options.fetchImpl),
            sleep: deadlineSleep(deadline.signal, options.sleep),
          }),
          // Small grace period so an in-flight abort surfaces as the collector's own error first.
          timeoutMs + 5_000,
          REFRESH_POLICY[step].label,
        );
        await record({ step, status: "succeeded", startedAt, finishedAt: now().toISOString(), detail: summarize(result), error: null });
        // A successful refresh clears any prior rate-limit history, whether or not
        // this provider has a cooldown policy (the upsert is a cheap no-op otherwise).
        if (RATE_LIMIT_COOLDOWN_POLICY[step]) {
          await store.clearProviderCooldown(step, now());
        }
      } catch (error) {
        const timedOut = deadline.signal.aborted || error instanceof RefreshTimeoutError;
        if (!timedOut && RATE_LIMIT_COOLDOWN_POLICY[step]) {
          const failure = classifyProviderError(error);
          if (failure.kind === "rate_limited") {
            const previous = cooldownStates.get(step);
            const consecutiveFailures = (previous?.consecutiveRateLimitFailures ?? 0) + 1;
            const backoffMs = computeRateLimitCooldownMs(step, consecutiveFailures) ?? 0;
            // Never a shorter cooldown than a meaningful Retry-After from the provider.
            const cooldownMs = Math.max(backoffMs, failure.retryAfterMs ?? 0);
            const cooldownUntil = new Date(now().getTime() + cooldownMs);
            await store.recordProviderRateLimitFailure(step, now(), cooldownUntil, consecutiveFailures, errorMessage(error));
            console.log(`${REFRESH_POLICY[step].label} rate limited; entering cooldown until ${cooldownUntil.toISOString()}`);
          }
        }
        await record({
          step,
          status: timedOut ? "timed_out" : "failed",
          startedAt,
          finishedAt: now().toISOString(),
          detail: {},
          error: timedOut ? new RefreshTimeoutError(REFRESH_POLICY[step].label, timeoutMs).message : errorMessage(error),
        });
      } finally {
        clearTimeout(timer);
      }
    }));

    const refreshed = steps.filter((step) => step.status === "succeeded").map((step) => step.step);
    if (due.length > 0) {
      const startedAt = now().toISOString();
      if (refreshed.length === 0) {
        await record({
          step: "metrics", status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {},
          error: "No provider refreshed successfully; previously calculated metrics are unchanged.",
        });
      } else {
        // Metrics read whatever is stored, so a failed provider contributes its last
        // successful observations and missing inputs stay unavailable, never zero.
        try {
          const result = await withTimeout(calculateMetrics(client), timeoutFor("metrics"), "Metrics calculation");
          await record({ step: "metrics", status: "succeeded", startedAt, finishedAt: now().toISOString(), detail: summarize(result), error: null });
        } catch (error) {
          await record({
            step: "metrics",
            status: error instanceof RefreshTimeoutError ? "timed_out" : "failed",
            startedAt,
            finishedAt: now().toISOString(),
            detail: {},
            error: errorMessage(error),
          });
        }
      }
    }

    const status = overallStatus(steps);
    const summary = {
      due,
      steps: Object.fromEntries(steps.map((step) => [step.step, step.status])),
    };
    await store.finishRun(runId, status, now(), summary, null);
    return { status, runId, due, steps };
  } catch (error) {
    // Status bookkeeping failed; release the lock and surface the error.
    await store.finishRun(runId, "failed", now(), { steps: Object.fromEntries(steps.map((step) => [step.step, step.status])) }, errorMessage(error))
      .catch(() => undefined);
    throw error;
  }
}
