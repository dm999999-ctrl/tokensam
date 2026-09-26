/**
 * AIProviderRouter: walks the configured priority list and, for each
 * provider, decides without any request whether it is eligible (configured,
 * allowed free tier, capable, not cooling down, enough deadline left). An
 * eligible provider gets one attempt bounded by its own attemptTimeoutMs, the
 * remaining overall deadline, AND an equal share of that remaining deadline
 * split across itself and every other provider still eligible to be tried
 * (`remainingCandidates`) — so one slow provider can never leave nothing for
 * the rest of the priority list. Its result must pass the schema check and
 * the evidence validator (via `validate`). Failures are classified, recorded
 * in provider health, and the router moves on. Structured-output failures
 * may be retried once on the same provider if the budget allows; nothing
 * else is retried.
 */

import { emitDiagnostic, type DiagnosticsOptions } from "../diagnostics.ts";
import type { ProviderHealthStore } from "./health.ts";
import type { AIProvider, FailureCategory, FreeTierStatus, ReportRequest, Usage } from "./types.ts";

export const ROUTER_DEFAULTS = {
  /** Do not start an attempt with less than this much of the deadline left. */
  minAttemptMs: 20_000,
  /** Minimum output a provider must be able to produce for a full report. */
  minOutputTokens: 8_192,
} as const;

export type RouterValidation<T> =
  | { ok: true; value: T; violations: 0 }
  | { ok: false; category: "structured_output" | "validation"; violations: number; reason: string };

export type RouteAttempt = {
  providerId: string;
  displayName: string;
  model: string;
  action: "attempted" | "skipped";
  skipReason: string | null;
  retry: boolean;
  latencyMs: number | null;
  timeoutMs: number | null;
  httpStatus: number | null;
  category: FailureCategory | null;
  reason: string | null;
  usage: Usage | null;
  servedModel: string | null;
  upstreamProvider: string | null;
  validationPassed: boolean | null;
  validationViolations: number | null;
};

export class NoProviderSucceededError extends Error {
  readonly attempts: RouteAttempt[];
  /** True when at least one provider answered but its report failed the schema or evidence contract. */
  readonly invalidOutput: boolean;
  constructor(attempts: RouteAttempt[]) {
    const tried = attempts.filter((attempt) => attempt.action === "attempted");
    super(tried.length === 0
      ? "No AI provider is currently available (none configured, allowed, capable, and out of cooldown)."
      : tried.map((attempt) => `${attempt.displayName}: ${describe(attempt)}`).join("; "));
    this.name = "NoProviderSucceededError";
    this.attempts = attempts;
    this.invalidOutput = tried.some((attempt) => attempt.category === "validation" || attempt.category === "structured_output");
  }
}

/** A secret-free, user-safe description of one failed attempt. */
function describe(attempt: RouteAttempt): string {
  switch (attempt.category) {
    case "transient": return attempt.httpStatus ? `temporarily unavailable (HTTP ${attempt.httpStatus})` : "timed out or unreachable";
    case "quota": return "free quota exhausted";
    case "configuration": return attempt.httpStatus ? `configuration error (HTTP ${attempt.httpStatus})` : "configuration error";
    case "structured_output": return "returned output that did not match the report schema";
    case "output_truncated": return "output was cut off at the token limit";
    case "blocked": return "declined the request";
    case "validation": return `report failed the evidence contract (${attempt.validationViolations ?? 0} issue(s))`;
    default: return "failed";
  }
}

/** Why a provider cannot be used for this request, decided before any call (null = eligible). */
export function ineligibility(provider: AIProvider | undefined, request: ReportRequest, allowedTiers: Set<FreeTierStatus>, health: ProviderHealthStore, now: number, minOutputTokens: number = ROUTER_DEFAULTS.minOutputTokens): string | null {
  if (!provider) return "unknown_provider";
  if (!provider.configured) return "not_configured";
  if (!allowedTiers.has(provider.freeTier.status)) return `free_tier_${provider.freeTier.status.toLowerCase()}`;
  const caps = provider.capabilities;
  // json_schema (API-enforced) and json_object (schema sent as text) both reach the identical
  // schema check and evidence validator in `validate`; only an unverified structured-output mode
  // is excluded, since neither this router nor the API gives any shape guarantee for it.
  if (caps.structuredOutput === "unverified") return "structured_output_unverified";
  if (caps.maxOutputTokens < minOutputTokens) return "output_capacity";
  const needed = request.estimatedInputTokens + minOutputTokens;
  if (caps.maxContextTokens !== null && caps.maxContextTokens < needed) return "context_window";
  if (caps.maxRequestTokens !== null && caps.maxRequestTokens < needed) return "request_token_limit";
  const state = health.get(provider.id, now);
  if (!state.available) return state.status;
  return null;
}

/**
 * How many entries from `fromIndex` onward (inclusive) would actually be attempted given enough
 * time — i.e. `ineligibility()` for reasons other than the deadline itself (that check is what
 * this count feeds into, so it is deliberately left out here). Used to divide the remaining
 * deadline fairly, so one slow provider can never consume the whole budget: see `routeReport`.
 */
function remainingCandidates(priority: string[], fromIndex: number, providers: Map<string, AIProvider>, request: ReportRequest, allowedTiers: Set<FreeTierStatus>, health: ProviderHealthStore, now: number, minOutputTokens: number | undefined): number {
  let count = 0;
  for (let i = fromIndex; i < priority.length; i++) {
    if (!ineligibility(providers.get(priority[i]), request, allowedTiers, health, now, minOutputTokens)) count++;
  }
  return count;
}

export async function routeReport<T>(input: {
  request: ReportRequest;
  providers: Map<string, AIProvider>;
  priority: string[];
  allowedTiers: Set<FreeTierStatus>;
  /** Epoch ms by which every provider attempt must have finished. */
  deadlineAt: number;
  validate: (json: unknown) => RouterValidation<T>;
  health: ProviderHealthStore;
  clock?: () => number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; forwarded to each provider's bounded in-adapter retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  diagnostics?: DiagnosticsOptions;
  minAttemptMs?: number;
  minOutputTokens?: number;
}): Promise<{ value: T; provider: AIProvider; attempt: RouteAttempt; attempts: RouteAttempt[] }> {
  const clock = input.clock ?? Date.now;
  const minAttemptMs = input.minAttemptMs ?? ROUTER_DEFAULTS.minAttemptMs;
  const attempts: RouteAttempt[] = [];
  let fallbackReason: string | null = null;
  let attemptNumber = 0;

  const log = (attempt: RouteAttempt) => {
    attempts.push(attempt);
    emitDiagnostic(input.diagnostics, {
      type: "ai.router_attempt", runId: input.diagnostics?.runId ?? null, provider: attempt.providerId, model: attempt.model,
      attempt: attempt.action === "attempted" ? attemptNumber : 0, action: attempt.action, skipReason: attempt.skipReason,
      latencyMs: attempt.latencyMs, timeoutMs: attempt.timeoutMs, httpStatus: attempt.httpStatus, failureCategory: attempt.category,
      inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null, reasoningTokens: attempt.usage?.reasoningTokens ?? null,
      validationPassed: attempt.validationPassed, validationViolations: attempt.validationViolations, fallbackReason,
    });
  };
  const base = (provider: AIProvider | undefined, id: string): RouteAttempt => ({
    providerId: id, displayName: provider?.displayName ?? id, model: provider?.model ?? "", action: "skipped", skipReason: null, retry: false,
    latencyMs: null, timeoutMs: null, httpStatus: null, category: null, reason: null, usage: null, servedModel: null, upstreamProvider: null,
    validationPassed: null, validationViolations: null,
  });

  for (let priorityIndex = 0; priorityIndex < input.priority.length; priorityIndex++) {
    const id = input.priority[priorityIndex];
    const provider = input.providers.get(id);
    const skip = ineligibility(provider, input.request, input.allowedTiers, input.health, clock(), input.minOutputTokens);
    if (skip) {
      log({ ...base(provider, id), skipReason: skip });
      continue;
    }
    // Eligible: at most one attempt, plus one retry after a structured-output failure.
    for (let retry = false; ; retry = true) {
      const remaining = input.deadlineAt - clock();
      if (remaining < minAttemptMs) {
        log({ ...base(provider, id), skipReason: "deadline", retry });
        break;
      }
      // Bounded budget by reservation, not equal division: reserve minAttemptMs for every later
      // provider that would still be attempted, and let this one use whatever is left of the
      // deadline, up to its own attemptTimeoutMs. Unlike an equal split, this gives a provider a
      // realistic, close-to-its-own-cap budget whenever earlier providers failed fast (the
      // common case), while still guaranteeing every later provider at least minAttemptMs even in
      // the worst case (every provider fully consuming its own budget, every time — see the
      // "worst case" test): reserving minAttemptMs per later provider, deducted before this one's
      // own budget is computed, can never be exceeded by construction. With no later provider
      // left, this reduces to the previous behavior (min(cap, remaining)).
      const laterCandidates = remainingCandidates(input.priority, priorityIndex + 1, input.providers, input.request, input.allowedTiers, input.health, clock(), input.minOutputTokens);
      const reservedForLaterMs = laterCandidates * minAttemptMs;
      const timeoutMs = Math.min(provider!.attemptTimeoutMs, Math.max(minAttemptMs, remaining - reservedForLaterMs));
      attemptNumber += 1;
      const started = clock();
      const outcome = await provider!.generateStructuredReport(input.request, { timeoutMs, fetchImpl: input.fetchImpl, diagnostics: input.diagnostics, sleep: input.sleep });
      const record: RouteAttempt = { ...base(provider, id), action: "attempted", retry, latencyMs: clock() - started, timeoutMs };
      if (!outcome.ok) {
        input.health.recordFailure(id, outcome.category, clock(), outcome.retryAfterMs);
        log({ ...record, httpStatus: outcome.httpStatus, category: outcome.category, reason: outcome.reason, usage: outcome.usage ?? null });
        fallbackReason = outcome.reason;
        if (outcome.category === "structured_output" && !retry) continue;
        break;
      }
      const validation = input.validate(outcome.json);
      const answered = { ...record, httpStatus: 200, usage: outcome.usage, servedModel: outcome.servedModel, upstreamProvider: outcome.upstreamProvider };
      if (!validation.ok) {
        input.health.recordFailure(id, validation.category, clock());
        log({ ...answered, category: validation.category, reason: `${id}_${validation.reason}`, validationPassed: false, validationViolations: validation.violations });
        fallbackReason = `${id}_${validation.reason}`;
        if (validation.category === "structured_output" && !retry) continue;
        break;
      }
      input.health.recordSuccess(id);
      const success = { ...answered, validationPassed: true, validationViolations: 0 };
      log(success);
      return { value: validation.value, provider: provider!, attempt: success, attempts };
    }
  }
  throw new NoProviderSucceededError(attempts);
}
