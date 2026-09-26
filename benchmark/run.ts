/**
 * Phase 1B bake-off runner: one attempt per provider per token, sequential,
 * with the free-tier safety rules applied (stop a provider after a billable
 * signal or after it fails for every token so far). Results are normalized;
 * nothing sensitive (keys, prompts, model output) is ever included.
 */

import { sanitizeProviderError } from "../src/lib/analysis/diagnostics.ts";
import { SYSTEM_INSTRUCTION, buildUserContent } from "../src/lib/analysis/prompt.ts";
import { contextHash, type ResearchContext } from "../src/lib/analysis/research-context.ts";
import { ANALYSIS_RESPONSE_SCHEMA } from "../src/lib/analysis/schema.ts";
import { ADAPTERS, type BenchmarkRequest, type ProviderId } from "./adapters.ts";
import { evaluateOutput } from "./evaluate.ts";

/** Same cap for every provider (reasoning tokens count toward it wherever providers count them). */
export const BENCHMARK_MAX_OUTPUT_TOKENS = 16_384;
/** One generous deadline per request, identical for every provider. */
export const BENCHMARK_TIMEOUT_MS = 180_000;
/** OpenRouter's Phase 0 baseline (Nemotron 3 Super free, Bitcoin). */
export const PHASE0_BASELINE = { outputTokens: 8160, reasoningTokens: 3411, latencyMs: 94_956 };

export type Cost = "FREE" | "PAID" | "UNVERIFIED" | "NONE";

export type BenchmarkResult = {
  provider: string;
  providerId: ProviderId;
  model: string;
  servedModel: string | null;
  upstreamProvider: string | null;
  token: string;
  contextHash: string | null;
  success: boolean;
  latencyMs: number | null;
  headersMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
  responseBytes: number | null;
  finishReason: string | null;
  structuredOutputValid: boolean;
  schemaErrors: string[];
  validationPassed: boolean;
  validationViolationCount: number | null;
  validationViolationTypes: Record<string, number>;
  sectionsPresent: string | null;
  statementCount: number | null;
  errorCategory: "not_configured" | "skipped" | "http_error" | "provider_error" | "timeout" | "network" | "incomplete" | "empty" | "malformed_json" | null;
  errorStatus: string | null;
  cost: Cost;
  costUsd: number | null;
  notes: string[];
};

export type BenchmarkToken = { tokenId: string; context: ResearchContext };

type Deps = {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  /** Called after each result (e.g. to print progress). */
  onResult?: (result: BenchmarkResult) => void;
};

function empty(providerId: ProviderId, model: string, token: string, patch: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    provider: ADAPTERS[providerId].label, providerId, model, servedModel: null, upstreamProvider: null, token, contextHash: null,
    success: false, latencyMs: null, headersMs: null, inputTokens: null, outputTokens: null, reasoningTokens: null, visibleOutputTokens: null,
    responseBytes: null, finishReason: null, structuredOutputValid: false, schemaErrors: [], validationPassed: false,
    validationViolationCount: null, validationViolationTypes: {}, sectionsPresent: null, statementCount: null,
    errorCategory: null, errorStatus: null, cost: "NONE", costUsd: null, notes: [], ...patch,
  };
}

/** Only a provider-reported cost is evidence; OpenRouter reports one, the others give no billing signal in the response. */
function costOf(costUsd: number | null): Cost {
  if (costUsd === null) return "UNVERIFIED";
  return costUsd > 0 ? "PAID" : "FREE";
}

/** One generation attempt for one provider and token. Never retries. */
export async function runOne(providerId: ProviderId, token: BenchmarkToken, deps: Deps): Promise<BenchmarkResult> {
  const adapter = ADAPTERS[providerId];
  const model = adapter.model(deps.env);
  const apiKey = deps.env[adapter.keyEnv]?.trim();
  if (!apiKey) return empty(providerId, model, token.tokenId, { errorCategory: "not_configured", notes: [`${adapter.keyEnv} is not set; NOT CONFIGURED.`] });

  const request: BenchmarkRequest = {
    systemInstruction: SYSTEM_INSTRUCTION,
    userText: buildUserContent(token.context),
    responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
  };
  const built = adapter.buildRequest({ apiKey, model, env: deps.env }, request);
  const clock = deps.clock ?? (() => performance.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = { contextHash: contextHash(token.context) };
  const start = clock();
  let headersMs: number | null = null;
  let status: number | null = null;
  let raw: string;
  try {
    const response = await fetchImpl(built.url, { method: "POST", headers: built.headers, body: built.body, signal: AbortSignal.timeout(deps.timeoutMs ?? BENCHMARK_TIMEOUT_MS) });
    headersMs = Math.round(clock() - start);
    status = response.status;
    raw = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return empty(providerId, model, token.tokenId, {
      ...base, latencyMs: Math.round(clock() - start), headersMs, errorCategory: timedOut ? "timeout" : "network",
      errorStatus: status !== null ? String(status) : null,
      notes: timedOut ? [`No complete response within ${Math.round((deps.timeoutMs ?? BENCHMARK_TIMEOUT_MS) / 1000)} s${headersMs !== null ? " (headers had arrived)" : ""}.`] : [],
    });
  }
  const latencyMs = Math.round(clock() - start);
  const responseBytes = new TextEncoder().encode(raw).length;

  if (status === null || status < 200 || status >= 300) {
    const error = sanitizeProviderError(raw, status);
    return empty(providerId, model, token.tokenId, {
      ...base, latencyMs, headersMs, responseBytes, errorCategory: "http_error",
      errorStatus: [status, error?.status, error?.category].filter(Boolean).join(" "),
      notes: error?.reasons.length ? [`reasons: ${error.reasons.join(", ")}`] : [],
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return empty(providerId, model, token.tokenId, { ...base, latencyMs, headersMs, responseBytes, errorCategory: "malformed_json", errorStatus: String(status), notes: ["The provider envelope was not JSON."] });
  }
  const envelope = adapter.parse(payload);
  const cost = costOf(envelope.costUsd);
  const measured = {
    ...base, latencyMs, headersMs, responseBytes,
    servedModel: envelope.servedModel, upstreamProvider: envelope.upstreamProvider, finishReason: envelope.finishReason,
    inputTokens: envelope.inputTokens, outputTokens: envelope.outputTokens, reasoningTokens: envelope.reasoningTokens,
    visibleOutputTokens: envelope.visibleOutputTokens, cost, costUsd: envelope.costUsd,
  };
  if (envelope.providerError) {
    const detail = sanitizeProviderError(JSON.stringify({ error: { code: envelope.providerError.code, status: envelope.providerError.status } }), null);
    return empty(providerId, model, token.tokenId, { ...measured, errorCategory: "provider_error", errorStatus: [envelope.providerError.code, detail?.category].filter(Boolean).join(" ") });
  }
  if (!envelope.content || !envelope.content.trim()) {
    return empty(providerId, model, token.tokenId, { ...measured, errorCategory: "empty", errorStatus: envelope.finishReason });
  }
  const evaluation = evaluateOutput(envelope.content, token.context, ANALYSIS_RESPONSE_SCHEMA);
  const notes: string[] = [];
  if (adapter.structuredOutput.startsWith("response_format json_object")) notes.push("JSON mode only: the schema was supplied in the system message, not enforced by the provider.");
  if (!evaluation.jsonParsed && /^\s*```/.test(envelope.content)) notes.push("Output was wrapped in a Markdown code fence; counted as invalid JSON (no repair).");
  if (!envelope.finishedNormally) notes.push(`Finish reason ${envelope.finishReason ?? "unknown"}.`);
  return empty(providerId, model, token.tokenId, {
    ...measured,
    success: envelope.finishedNormally && evaluation.jsonParsed,
    errorCategory: !envelope.finishedNormally ? "incomplete" : evaluation.jsonParsed ? null : "malformed_json",
    errorStatus: !envelope.finishedNormally ? envelope.finishReason : null,
    structuredOutputValid: evaluation.structuredOutputValid,
    schemaErrors: evaluation.schemaErrors.slice(0, 5),
    validationPassed: evaluation.validationPassed,
    validationViolationCount: evaluation.validationViolationCount,
    validationViolationTypes: evaluation.validationViolationTypes,
    sectionsPresent: evaluation.sectionsPresent,
    statementCount: evaluation.statementCount,
    notes,
  });
}

/**
 * Providers run in order; tokens run in order within a provider. A provider
 * stops after a billable (PAID) signal, and after failing for every token
 * tested so far once at least two have failed (one attempt each, no retries).
 */
export async function runBenchmark(providers: ProviderId[], tokens: BenchmarkToken[], deps: Deps): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const providerId of providers) {
    let stopped: string | null = null;
    const providerResults: BenchmarkResult[] = [];
    for (const token of tokens) {
      const result = stopped
        ? empty(providerId, ADAPTERS[providerId].model(deps.env), token.tokenId, { errorCategory: "skipped", notes: [stopped] })
        : await runOne(providerId, token, deps);
      providerResults.push(result);
      results.push(result);
      deps.onResult?.(result);
      if (!stopped && result.cost === "PAID") stopped = "Stopped: the provider reported a billable request.";
      const attempted = providerResults.filter((item) => item.errorCategory !== "not_configured" && item.errorCategory !== "skipped");
      if (!stopped && attempted.length >= 2 && attempted.every((item) => !item.success)) stopped = "Stopped: the provider failed for every token tested.";
    }
  }
  return results;
}
