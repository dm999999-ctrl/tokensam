import { getDefiLlamaConfig } from "../providers/defillama.ts";
import { runCoinGeckoCollection } from "../providers/run-coingecko-collection.ts";
import { runDefiLlamaCollection } from "../providers/run-defillama-collection.ts";
import { runDexScreenerCollection } from "../providers/run-dexscreener-collection.ts";
import { runDefiLlamaCoinsCollection } from "../providers/run-defillama-coins-collection.ts";
import { runCoinGeckoDailyHistory } from "../providers/run-coingecko-daily-history.ts";
import { runDefiLlamaDailyHistory } from "../providers/run-defillama-daily-history.ts";
import { runMetricsCalculation } from "../metrics/run-calculation.ts";
import {
  DAILY_HISTORY_POLICY,
  DAILY_HISTORY_STEPS,
  DUE_TOLERANCE_MS,
  METRICS_TIMEOUT_MS,
  PROVIDER_STEPS,
  REFRESH_POLICY,
  RUN_LEASE_MS,
  type DailyHistoryStep,
  type ProviderStep,
  type RefreshStep,
} from "./config.ts";
import type { RefreshStore, RefreshTrigger, RunStatus, StepRecord } from "./store.ts";

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

export const defaultDailyHistoryCollectors: Record<DailyHistoryStep, CollectorDefinition> = {
  coingecko_daily: { collect: (client, options) => runCoinGeckoDailyHistory(client, options) },
  defillama_daily: {
    // Same written-permission gate as the routine and explicit-backfill DeFiLlama paths.
    skipReason: () => {
      try {
        getDefiLlamaConfig();
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    collect: (client, options) => runDefiLlamaDailyHistory(client, options),
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
  /**
   * Also run the scheduled daily-history steps (coingecko_daily,
   * defillama_daily) when due. Off by default so every existing caller (and
   * test) keeps its exact current behavior; the cron route turns it on. When
   * on, `force` also bypasses the safe-hour/once-per-UTC-day gating.
   */
  includeDailyHistory?: boolean;
  dailyHistoryCollectors?: Partial<Record<DailyHistoryStep, CollectorDefinition>>;
  calculateMetrics?: (client: SupabaseAdminClient) => Promise<Record<string, unknown>>;
  timeouts?: Partial<Record<RefreshStep, number>>;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
};

export type RefreshResult = {
  status: RunStatus | "busy";
  runId: number | null;
  due: ProviderStep[];
  /** Daily-history steps that were due and attempted this run; empty unless includeDailyHistory is set. */
  dailyHistoryDue: DailyHistoryStep[];
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

/**
 * A daily-history step is due at most once per UTC calendar day, only from its
 * safe hour onward (so it does not run at 00:00 UTC and find nothing, before
 * the provider has published the newly completed day), and — if an earlier
 * attempt today already found nothing new ("not yet available") — no more
 * often than its retryIntervalMs. See DAILY_HISTORY_POLICY (config.ts).
 */
export function isDailyHistoryDue(
  step: DailyHistoryStep,
  lastSuccessAt: string | undefined,
  lastAttemptAt: string | undefined,
  now: Date,
): boolean {
  const policy = DAILY_HISTORY_POLICY[step];
  if (now.getUTCHours() < policy.safeHourUtc) return false;
  const today = now.toISOString().slice(0, 10);
  if (lastSuccessAt && lastSuccessAt.slice(0, 10) === today) return false;
  if (lastAttemptAt && now.getTime() - Date.parse(lastAttemptAt) < policy.retryIntervalMs) return false;
  return true;
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
  const timeoutFor = (step: ProviderStep | "metrics") => options.timeouts?.[step]
    ?? (step === "metrics" ? METRICS_TIMEOUT_MS : REFRESH_POLICY[step].timeoutMs);

  const runId = await store.acquireRun(options.trigger, now(), RUN_LEASE_MS);
  if (runId === null) return { status: "busy", runId: null, due: [], dailyHistoryDue: [], steps: [] };

  const steps: StepRecord[] = [];
  const record = async (step: StepRecord) => {
    steps.push(step);
    await store.recordStep(runId, step);
  };

  /**
   * Run one step with its own deadline, recording the outcome. `classify`
   * turns a successful result into "succeeded" or "skipped" (for example, a
   * daily-history step that ran fine but found no new completed day yet is
   * "skipped", not "succeeded", so it stays due for a later retry today).
   */
  const runStep = async (
    step: RefreshStep,
    definition: CollectorDefinition,
    timeoutMs: number,
    label: string,
    classify: (result: Record<string, unknown>) => { status: "succeeded" | "skipped"; error: string | null } = () => ({ status: "succeeded", error: null }),
  ) => {
    const startedAt = now().toISOString();
    const skipReason = definition.skipReason?.() ?? null;
    if (skipReason) {
      await record({ step, status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {}, error: skipReason });
      return;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new RefreshTimeoutError(label, timeoutMs)), timeoutMs);
    try {
      const result = await withTimeout(
        definition.collect(client, {
          fetchImpl: deadlineFetch(deadline.signal, options.fetchImpl),
          sleep: deadlineSleep(deadline.signal, options.sleep),
        }),
        // Small grace period so an in-flight abort surfaces as the collector's own error first.
        timeoutMs + 5_000,
        label,
      );
      const classified = classify(result);
      await record({ step, status: classified.status, startedAt, finishedAt: now().toISOString(), detail: summarize(result), error: classified.error });
    } catch (error) {
      const timedOut = deadline.signal.aborted || error instanceof RefreshTimeoutError;
      await record({
        step,
        status: timedOut ? "timed_out" : "failed",
        startedAt,
        finishedAt: now().toISOString(),
        detail: {},
        error: timedOut ? new RefreshTimeoutError(label, timeoutMs).message : errorMessage(error),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const lastSuccess = await store.lastSuccessfulSteps();
    const candidates = PROVIDER_STEPS.filter((step) => !options.only || options.only.includes(step));
    const due = candidates.filter((step) => options.force || isProviderDue(step, lastSuccess[step], now()));

    // Different providers have independent rate limits, so they run concurrently;
    // each collector still serializes and paces its own requests.
    await Promise.all(due.map((step) => runStep(step, collectors[step], timeoutFor(step), REFRESH_POLICY[step].label)));

    let dailyHistoryDue: DailyHistoryStep[] = [];
    if (options.includeDailyHistory) {
      const dailyHistoryCollectors = { ...defaultDailyHistoryCollectors, ...options.dailyHistoryCollectors };
      const lastAttempts = await store.latestAttempts();
      dailyHistoryDue = DAILY_HISTORY_STEPS.filter((step) => options.force || isDailyHistoryDue(step, lastSuccess[step], lastAttempts[step]?.finishedAt, now()));

      // Independent of the current-data providers above: a genuine failure or
      // "not yet available" result here never touches the other provider's
      // already-persisted observations (each step, like the ones above, fetches
      // and validates before writing anything).
      await Promise.all(dailyHistoryDue.map((step) => runStep(
        step,
        dailyHistoryCollectors[step],
        options.timeouts?.[step] ?? DAILY_HISTORY_POLICY[step].timeoutMs,
        DAILY_HISTORY_POLICY[step].label,
        (result) => (result.notYetAvailable
          ? { status: "skipped" as const, error: String(result.notYetAvailable) }
          : { status: "succeeded" as const, error: null }),
      )));
    }

    const refreshed = steps.filter((step) => step.status === "succeeded").map((step) => step.step);
    if (due.length > 0 || dailyHistoryDue.length > 0) {
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
      dailyHistoryDue,
      steps: Object.fromEntries(steps.map((step) => [step.step, step.status])),
    };
    await store.finishRun(runId, status, now(), summary, null);
    return { status, runId, due, dailyHistoryDue, steps };
  } catch (error) {
    // Status bookkeeping failed; release the lock and surface the error.
    await store.finishRun(runId, "failed", now(), { steps: Object.fromEntries(steps.map((step) => [step.step, step.status])) }, errorMessage(error))
      .catch(() => undefined);
    throw error;
  }
}
