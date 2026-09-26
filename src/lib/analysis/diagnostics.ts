/**
 * Phase 0 AI pipeline diagnostics: observational only.
 *
 * Provider clients report one sanitized event per HTTP attempt, and the
 * service reports one summary per generation. Events carry timings, sizes,
 * status codes, allow-listed provider status tokens, and token counts. They
 * never carry keys, headers, prompts, model output, or raw provider error text:
 * error bodies are parsed only to extract enum-like fields, and messages are
 * reduced to a fixed category.
 *
 * Nothing here can change a request's outcome or timing. Response bodies are
 * observed through a clone that the request path never awaits, and a failing
 * sink is ignored.
 */

import type { ResearchContext } from "./research-context.ts";

/** Provider ID (gemini, openrouter, qwen, ...). */
export type DiagnosticProvider = string;

export type AttemptOutcome =
  | "success" | "http_error" | "timeout" | "network" | "body_timeout"
  | "malformed_json" | "blocked" | "incomplete" | "empty" | "provider_error";

/** How the response body arrived, from a clone read alongside the real one. */
export type BodyObservation = {
  bytes: number;
  /** Bytes before the first non-whitespace byte (keep-alive padding shows up here). */
  leadingWhitespaceBytes: number;
  /** Milliseconds from request start to the first body byte / first non-whitespace byte / last byte. */
  firstByteMs: number | null;
  firstContentByteMs: number | null;
  lastByteMs: number | null;
  /** "complete" = the body ended; "aborted" = the read was cut off (deadline or network). */
  state: "complete" | "aborted" | "unavailable";
};

export type ProviderErrorSummary = {
  /** Numeric code from the error body, when present. */
  code: number | null;
  /** Google RPC status (e.g. UNAVAILABLE, RESOURCE_EXHAUSTED), allow-listed shape only. */
  status: string | null;
  /** The message reduced to a fixed category; the message text itself is never kept. */
  category: "overloaded" | "high_demand" | "quota" | "rate_limit" | "deadline" | "internal" | "unavailable" | "invalid_request" | "auth" | "unclassified" | null;
  /** ErrorInfo reasons (Gemini) or the upstream provider name (OpenRouter metadata). */
  reasons: string[];
  /** Gemini QuotaFailure quota IDs / metrics (names of quotas, not values of secrets). */
  quotaIds: string[];
  /** Gemini RetryInfo delay, e.g. "7s". */
  retryDelay: string | null;
};

export type ProviderAttemptDiagnostic = {
  type: "ai.provider_attempt";
  runId: string | null;
  provider: DiagnosticProvider;
  model: string;
  attempt: number;
  maxAttempts: number;
  isRetry: boolean;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  /** Milliseconds until response headers arrived; null when they never did. */
  headersMs: number | null;
  headersReceived: boolean;
  httpStatus: number | null;
  outcome: AttemptOutcome;
  timedOut: boolean;
  requestBytes: number;
  body: BodyObservation | null;
  /** Numeric Retry-After header, when sent. */
  retryAfterSeconds: number | null;
  error: ProviderErrorSummary | null;
  /** Gemini: finishReason, modelVersion, usageMetadata. OpenRouter: finish reasons, routed model/provider, generation ID, usage. */
  response: {
    finishReason: string | null;
    nativeFinishReason: string | null;
    servedModel: string | null;
    upstreamProvider: string | null;
    generationId: string | null;
    usage: Record<string, number> | null;
  } | null;
};

export type ContextSizeDiagnostic = {
  contextVersion: string;
  contextBytes: number;
  componentBytes: Record<string, number>;
  largestComponent: string;
  counts: { observations: number; calculatedMetrics: number; historySeries: number; historyPoints: number; unavailable: number; citableIds: number };
  systemInstructionBytes: number;
  userContentBytes: number;
  responseSchemaBytes: number;
  /** System instruction + user turn + response schema: what every provider request carries. */
  promptBytes: number;
};

export type GenerationDiagnostic = {
  type: "ai.generation";
  runId: string;
  tokenId: string;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  contextBuildMs: number | null;
  providerMs: number | null;
  context: ContextSizeDiagnostic | null;
  outcome: "ok" | "provider_failed" | "invalid_output" | "error";
  provider: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  providerAttempts: { provider: string; reason: string }[];
  /** Every provider the router considered, in order, with what happened. */
  providerSequence?: string[];
  validationViolations: number | null;
};

/** One router decision per provider: an attempt (with its failure category and validation result) or a skip. */
export type RouterAttemptDiagnostic = {
  type: "ai.router_attempt";
  runId: string | null;
  provider: string;
  model: string;
  attempt: number;
  action: "attempted" | "skipped";
  skipReason: string | null;
  latencyMs: number | null;
  timeoutMs: number | null;
  httpStatus: number | null;
  failureCategory: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  validationPassed: boolean | null;
  validationViolations: number | null;
  /** Why the router moved on to the next provider, when it did. */
  fallbackReason: string | null;
};

export type AiDiagnosticEvent = ProviderAttemptDiagnostic | GenerationDiagnostic | RouterAttemptDiagnostic;
export type DiagnosticSink = (event: AiDiagnosticEvent) => void;
export type DiagnosticsOptions = { sink?: DiagnosticSink; runId?: string | null };

export const DIAGNOSTIC_LOG_PREFIX = "[ai-diagnostics]";

/** Default sink: one JSON line per event in the server log. */
export const logDiagnostic: DiagnosticSink = (event) => {
  console.info(`${DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(event)}`);
};

/** Diagnostics must never affect the pipeline: sink failures are swallowed. */
export function emitDiagnostic(options: DiagnosticsOptions | undefined, event: AiDiagnosticEvent): void {
  try {
    (options?.sink ?? logDiagnostic)(event);
  } catch {
    // Observational only.
  }
}

export function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const encoder = new TextEncoder();
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

// ---- Sanitizers ----

const STATUS_TOKEN = /^[A-Z][A-Z_]{1,40}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 _.:/@()-]{0,119}$/;

function safeToken(value: unknown, pattern = SAFE_TOKEN): string | null {
  return typeof value === "string" && pattern.test(value.trim()) ? value.trim() : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function messageCategory(message: unknown, status: string | null, code: number | null): ProviderErrorSummary["category"] {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (/overload/.test(text)) return "overloaded";
  if (/high demand/.test(text)) return "high_demand";
  if (/quota/.test(text) || status === "RESOURCE_EXHAUSTED") return "quota";
  if (/rate[- ]?limit/.test(text) || code === 429) return "rate_limit";
  if (/deadline|timed? ?out/.test(text) || status === "DEADLINE_EXCEEDED") return "deadline";
  if (/internal/.test(text) || status === "INTERNAL") return "internal";
  if (/unavailable/.test(text) || status === "UNAVAILABLE" || code === 503) return "unavailable";
  if (code === 400 || status === "INVALID_ARGUMENT") return "invalid_request";
  if (code === 401 || code === 403 || status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED") return "auth";
  return text || status || code !== null ? "unclassified" : null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reduce a provider error body (Google RPC or OpenRouter shape) to allow-listed fields. */
export function sanitizeProviderError(bodyText: string | null, httpStatus: number | null): ProviderErrorSummary | null {
  const parsed = parseJson(bodyText);
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : Array.isArray(parsed) && isRecord(parsed[0]) && isRecord(parsed[0].error) ? parsed[0].error : null;
  if (!error) return httpStatus !== null && httpStatus >= 400 ? { code: null, status: null, category: messageCategory(null, null, httpStatus), reasons: [], quotaIds: [], retryDelay: null } : null;
  const code = safeNumber(error.code);
  const status = safeToken(error.status, STATUS_TOKEN);
  const reasons: string[] = [];
  const quotaIds: string[] = [];
  let retryDelay: string | null = null;
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    if (!isRecord(detail)) continue;
    const reason = safeToken(detail.reason, STATUS_TOKEN);
    if (reason) reasons.push(reason);
    for (const violation of Array.isArray(detail.violations) ? detail.violations : []) {
      if (!isRecord(violation)) continue;
      for (const field of [violation.quotaId, violation.quotaMetric]) {
        const id = safeToken(field);
        if (id && !quotaIds.includes(id)) quotaIds.push(id);
      }
    }
    const delay = safeToken(detail.retryDelay, /^\d{1,5}(\.\d{1,9})?s$/);
    if (delay) retryDelay = delay;
  }
  // OpenRouter reports the upstream provider in error.metadata.provider_name.
  const upstream = isRecord(error.metadata) ? safeToken(error.metadata.provider_name) : null;
  if (upstream) reasons.push(`provider:${upstream}`);
  return { code: code ?? httpStatus, status, category: messageCategory(error.message, status, code ?? httpStatus), reasons, quotaIds, retryDelay };
}

/** Keep only finite numeric token counts (nested one level, e.g. completion_tokens_details). */
export function sanitizeUsage(usage: unknown): Record<string, number> | null {
  if (!isRecord(usage)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (!/^[A-Za-z_]{1,60}$/.test(key)) continue;
    const number = safeNumber(value);
    if (number !== null) out[key] = number;
    else if (isRecord(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        const innerNumber = safeNumber(innerValue);
        if (innerNumber !== null && /^[A-Za-z_]{1,60}$/.test(inner)) out[`${key}.${inner}`] = innerNumber;
      }
    }
    // Arrays such as promptTokensDetails[{modality, tokenCount}] are summarized by modality.
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const modality = safeToken(entry.modality, STATUS_TOKEN);
        const count = safeNumber(entry.tokenCount);
        if (modality && count !== null) out[`${key}.${modality}`] = count;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

export function safeLabel(value: unknown): string | null {
  return safeToken(value);
}

// ---- Body observation ----

const MAX_CAPTURED_ERROR_BYTES = 16 * 1024;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * Read a clone of the response to time the body and count its bytes. The
 * request path keeps reading the original response exactly as before and never
 * awaits this. For error responses (captureText), up to 16 KB of the clone is
 * kept in memory only so sanitizeProviderError can extract allow-listed fields.
 */
export function observeBody(response: Response, startedAt: number, clock: () => number, captureText = false): Promise<{ body: BodyObservation; text: string | null }> {
  let clone: Response;
  try {
    if (typeof response.clone !== "function" || !response.body) throw new Error("no body");
    clone = response.clone();
  } catch {
    return Promise.resolve({ body: { bytes: 0, leadingWhitespaceBytes: 0, firstByteMs: null, firstContentByteMs: null, lastByteMs: null, state: "unavailable" }, text: null });
  }
  const body: BodyObservation = { bytes: 0, leadingWhitespaceBytes: 0, firstByteMs: null, firstContentByteMs: null, lastByteMs: null, state: "complete" };
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  const read = async () => {
    const reader = clone.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const elapsed = clock() - startedAt;
      if (body.firstByteMs === null) body.firstByteMs = elapsed;
      body.lastByteMs = elapsed;
      if (body.firstContentByteMs === null) {
        let index = 0;
        while (index < value.length && WHITESPACE.has(value[index])) index += 1;
        body.leadingWhitespaceBytes += index;
        if (index < value.length) body.firstContentByteMs = elapsed;
      }
      body.bytes += value.length;
      if (captureText && capturedBytes < MAX_CAPTURED_ERROR_BYTES) {
        const slice = value.subarray(0, MAX_CAPTURED_ERROR_BYTES - capturedBytes);
        captured.push(slice);
        capturedBytes += slice.length;
      }
    }
  };
  return read().then(
    () => ({ body, text: captureText ? new TextDecoder().decode(concat(captured, capturedBytes)) : null }),
    () => ({ body: { ...body, state: "aborted" as const }, text: null }),
  );
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---- Per-attempt recorder ----

/**
 * Collects one attempt's facts on the request path (cheap assignments only)
 * and emits the event once the body observation settles, without blocking.
 */
export function attemptRecorder(init: {
  options: DiagnosticsOptions | undefined;
  provider: DiagnosticProvider;
  model: string;
  attempt: number;
  maxAttempts: number;
  requestBytes: number;
  clock?: () => number;
}) {
  const clock = init.clock ?? (() => performance.now());
  const wallStart = Date.now();
  const start = clock();
  let headersMs: number | null = null;
  let httpStatus: number | null = null;
  let retryAfterSeconds: number | null = null;
  let observation: Promise<{ body: BodyObservation; text: string | null }> | null = null;
  let response: ProviderAttemptDiagnostic["response"] = null;
  let finished = false;

  return {
    headers(received: Response, captureErrorBody: boolean) {
      try {
        headersMs = clock() - start;
        httpStatus = received.status;
        const retryAfter = Number(received.headers?.get?.("retry-after"));
        retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
        observation = observeBody(received, start, clock, captureErrorBody);
      } catch {
        // Observational only.
      }
    },
    response(details: NonNullable<ProviderAttemptDiagnostic["response"]>) {
      response = details;
    },
    finish(outcome: AttemptOutcome, extra: { error?: ProviderErrorSummary | null } = {}) {
      if (finished) return;
      finished = true;
      try {
        const latencyMs = clock() - start;
        const base = {
          type: "ai.provider_attempt" as const,
          runId: init.options?.runId ?? null,
          provider: init.provider,
          model: init.model,
          attempt: init.attempt,
          maxAttempts: init.maxAttempts,
          isRetry: init.attempt > 1,
          startedAt: new Date(wallStart).toISOString(),
          endedAt: new Date(wallStart + latencyMs).toISOString(),
          latencyMs: Math.round(latencyMs),
          headersMs: headersMs === null ? null : Math.round(headersMs),
          headersReceived: headersMs !== null,
          httpStatus,
          outcome,
          timedOut: outcome === "timeout" || outcome === "body_timeout",
          requestBytes: init.requestBytes,
          retryAfterSeconds,
          response,
        };
        const round = (body: BodyObservation): BodyObservation => ({
          ...body,
          firstByteMs: body.firstByteMs === null ? null : Math.round(body.firstByteMs),
          firstContentByteMs: body.firstContentByteMs === null ? null : Math.round(body.firstContentByteMs),
          lastByteMs: body.lastByteMs === null ? null : Math.round(body.lastByteMs),
        });
        if (!observation) {
          emitDiagnostic(init.options, { ...base, body: null, error: extra.error ?? null });
          return;
        }
        void observation.then(({ body, text }) => {
          const error = extra.error ?? (httpStatus !== null && httpStatus >= 400 ? sanitizeProviderError(text, httpStatus) : null);
          emitDiagnostic(init.options, { ...base, body: round(body), error });
        }, () => emitDiagnostic(init.options, { ...base, body: null, error: extra.error ?? null }));
      } catch {
        // Observational only.
      }
    },
  };
}

// ---- Context size ----

export function measureResearchContext(context: ResearchContext, prompt: { systemInstruction: string; userContent: string; responseSchema: unknown }): ContextSizeDiagnostic {
  const componentBytes: Record<string, number> = {};
  for (const [key, value] of Object.entries(context)) componentBytes[key] = byteLength(JSON.stringify(value) ?? "");
  const largestComponent = Object.entries(componentBytes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const historyPoints = context.history.reduce((sum, series) => sum + series.points.length, 0);
  const citableIds = 1 + context.scope.length + context.providerFreshness.length + context.observations.length
    + context.calculatedMetrics.length + context.history.length + new Set(context.history.flatMap((series) => series.points.map((point) => point.sourceId))).size;
  const systemInstructionBytes = byteLength(prompt.systemInstruction);
  const userContentBytes = byteLength(prompt.userContent);
  const responseSchemaBytes = byteLength(JSON.stringify(prompt.responseSchema));
  return {
    contextVersion: context.contextVersion,
    contextBytes: byteLength(JSON.stringify(context)),
    componentBytes,
    largestComponent,
    counts: {
      observations: context.observations.length,
      calculatedMetrics: context.calculatedMetrics.length,
      historySeries: context.history.length,
      historyPoints,
      unavailable: context.unavailable.length,
      citableIds,
    },
    systemInstructionBytes,
    userContentBytes,
    responseSchemaBytes,
    promptBytes: systemInstructionBytes + userContentBytes + responseSchemaBytes,
  };
}
