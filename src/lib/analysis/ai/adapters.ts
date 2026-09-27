import "server-only";

/**
 * Provider adapters: API differences only. Gemini and OpenRouter reuse the
 * existing clients (one attempt, router-assigned deadline); every other
 * provider uses one OpenAI-compatible adapter with native JSON-schema output.
 * Keys are sent only in request headers. Error bodies are read only to detect
 * documented quota signals and are never returned or logged.
 */

import { attemptRecorder, byteLength, safeLabel, sanitizeUsage, type DiagnosticsOptions } from "../diagnostics.ts";
import { GeminiError, generateStructuredJson } from "../gemini.ts";
import { OpenRouterError, generateStructuredJsonOpenRouter } from "../openrouter.ts";
import type { GenerationOutcome, GenerateOptions, ReportRequest, Usage } from "./types.ts";

const SCHEMA_NAME = "token_samurai_deep_analysis";

/** Documented free-quota / billing signals in provider error bodies (matched, never stored). */
const QUOTA_SIGNALS = /FreeTierOnly|AllocationQuota|insufficient_quota|quota[_ ]exceeded|exceeded your current quota|free-models-per-day|Arrearage|insufficient balance|payment required/i;

function usageFrom(raw: Record<string, number> | null, map: { input: string; output: string; reasoning: string; visibleOutput?: string }): Usage {
  if (!raw) return { inputTokens: null, outputTokens: null, reasoningTokens: null };
  const reasoning = raw[map.reasoning] ?? null;
  // Gemini reports visible and thought tokens separately; others report completion tokens including reasoning.
  const output = map.visibleOutput
    ? (raw[map.visibleOutput] !== undefined || reasoning !== null ? (raw[map.visibleOutput] ?? 0) + (reasoning ?? 0) : null)
    : raw[map.output] ?? null;
  return { inputTokens: raw[map.input] ?? null, outputTokens: output, reasoningTokens: reasoning };
}

/** Retry-After as milliseconds (delta-seconds or HTTP date), or null when absent/invalid. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? at - now : null;
}

/** HTTP status → failure category (shared by every adapter). */
export function classifyHttpStatus(status: number, quotaSignal = false): Exclude<GenerationOutcome, { ok: true }>["category"] {
  if (status === 402 || quotaSignal) return "quota";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "configuration";
}

// ---- Gemini (existing client) ----

export async function generateWithGemini(config: { apiKey: string; model: string }, request: ReportRequest, options: GenerateOptions): Promise<GenerationOutcome> {
  try {
    const { json, modelVersion, usage } = await generateStructuredJson({
      config, systemInstruction: request.systemInstruction, userText: request.userText, responseSchema: request.responseSchema,
      fetchImpl: options.fetchImpl, diagnostics: options.diagnostics, maxAttempts: 1, timeoutMs: options.timeoutMs,
    });
    return { ok: true, json, servedModel: modelVersion, upstreamProvider: null, usage: usageFrom(usage, { input: "promptTokenCount", output: "candidatesTokenCount", reasoning: "thoughtsTokenCount", visibleOutput: "candidatesTokenCount" }) };
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    const reason = error.reasonCode;
    if (error.code === "http" && error.status !== null) return { ok: false, category: classifyHttpStatus(error.status), httpStatus: error.status, reason };
    if (error.code === "timeout" || error.code === "network") return { ok: false, category: "transient", httpStatus: null, reason };
    if (error.code === "incomplete") return { ok: false, category: "output_truncated", httpStatus: 200, reason };
    if (error.code === "blocked") return { ok: false, category: "blocked", httpStatus: 200, reason };
    if (error.code === "config") return { ok: false, category: "configuration", httpStatus: null, reason };
    return { ok: false, category: "structured_output", httpStatus: 200, reason };
  }
}

// ---- OpenRouter (existing client) ----

export async function generateWithOpenRouter(config: { apiKey: string; model: string }, request: ReportRequest, options: GenerateOptions): Promise<GenerationOutcome> {
  try {
    const { json, model, upstreamProvider, usage } = await generateStructuredJsonOpenRouter({
      config, systemInstruction: request.systemInstruction, userText: request.userText, responseSchema: request.responseSchema,
      fetchImpl: options.fetchImpl, diagnostics: options.diagnostics, timeoutMs: options.timeoutMs,
    });
    return { ok: true, json, servedModel: model, upstreamProvider, usage: usageFrom(usage, { input: "prompt_tokens", output: "completion_tokens", reasoning: "completion_tokens_details.reasoning_tokens" }) };
  } catch (error) {
    if (!(error instanceof OpenRouterError)) throw error;
    const reason = error.status !== null ? `openrouter_${error.status}` : `openrouter_${error.code}`;
    if (error.code === "http") {
      const status = typeof error.status === "number" ? error.status : 502;
      return { ok: false, category: classifyHttpStatus(status), httpStatus: status, reason };
    }
    if (error.code === "timeout" || error.code === "network") return { ok: false, category: "transient", httpStatus: null, reason };
    if (error.code === "incomplete") return { ok: false, category: "output_truncated", httpStatus: 200, reason };
    if (error.code === "config") return { ok: false, category: "configuration", httpStatus: null, reason };
    return { ok: false, category: "structured_output", httpStatus: 200, reason };
  }
}

// ---- OpenAI-compatible providers (Qwen, Hunyuan, GLM, Mistral, Groq, SiliconFlow) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON-object mode (for providers that document only `{"type":"json_object"}`): the provider does
 * NOT enforce the schema, so the identical schema is given as text after the unchanged system
 * instruction. The server's schema check and evidence validator apply exactly as for json_schema.
 */
export const JSON_OBJECT_SCHEMA_HEADER = "\n\nRESPONSE FORMAT: return JSON only: one JSON object that matches this JSON Schema exactly (field names, types, enums, required fields, no extra fields):\n";

export async function generateWithOpenAiCompatible(
  config: {
    providerId: string; apiKey: string; model: string; baseUrl: string; maxOutputTokens: number;
    outputTokenParam?: "max_tokens" | "max_completion_tokens";
    /** Defaults to json_schema (provider-enforced). json_object sends the schema as text (not enforced). */
    structuredMode?: "json_schema" | "json_object";
  },
  request: ReportRequest,
  options: GenerateOptions & { diagnostics?: DiagnosticsOptions },
): Promise<GenerationOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jsonObject = config.structuredMode === "json_object";
  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: jsonObject ? `${request.systemInstruction}${JSON_OBJECT_SCHEMA_HEADER}${JSON.stringify(request.responseSchema)}` : request.systemInstruction },
      { role: "user", content: request.userText },
    ],
    response_format: jsonObject
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: true, schema: request.responseSchema } },
    [config.outputTokenParam ?? "max_tokens"]: config.maxOutputTokens,
  });
  const reasonPrefix = `${config.providerId}_`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.clock ?? Date.now;
  // Budget-aware retry: a retry costs up to `backoffMs + options.timeoutMs` more wall-clock time
  // (the same timeoutMs is reused for the retried attempt), so it is only taken when that much is
  // available beyond what the router is holding in reserve for every later candidate provider —
  // otherwise one provider's retry could alone consume another provider's entire reserved share.
  // Without deadline info (a direct adapter call outside the router, e.g. a unit test), always
  // allow it, exactly as before this check existed.
  const canRetry = (backoffMs: number): boolean => {
    if (options.deadlineAt === undefined) return true;
    const remaining = options.deadlineAt - now();
    return remaining - (options.reservedForLaterMs ?? 0) >= backoffMs + options.timeoutMs;
  };
  // Bounded in-adapter retry (mirrors gemini.ts): only 429/5xx/timeout/network are retried, at
  // most once, with a short capped backoff. Quota, configuration, and success are never retried
  // here — the router's own fallback and per-provider cooldown handle those.
  const MAX_ATTEMPTS = 2;
  let response: Response;
  let text: string;
  let record: ReturnType<typeof attemptRecorder>;
  for (let attempt = 1; ; attempt += 1) {
    record = attemptRecorder({ options: options.diagnostics, provider: config.providerId, model: config.model, attempt, maxAttempts: MAX_ATTEMPTS, requestBytes: byteLength(body) });
    try {
      response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      record.finish(timedOut ? "timeout" : "network");
      const backoff = timedOut ? 2_000 : 1_000;
      if (attempt < MAX_ATTEMPTS && canRetry(backoff)) { await sleep(backoff); continue; }
      return { ok: false, category: "transient", httpStatus: null, reason: `${reasonPrefix}${timedOut ? "timeout" : "network"}` };
    }
    record.headers(response, !response.ok);

    try {
      text = await response.text();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      record.finish(timedOut ? "body_timeout" : "network");
      const backoff = timedOut ? 2_000 : 1_000;
      if (attempt < MAX_ATTEMPTS && canRetry(backoff)) { await sleep(backoff); continue; }
      return { ok: false, category: "transient", httpStatus: response.status, reason: `${reasonPrefix}${timedOut ? "timeout" : "network"}` };
    }
    if (!response.ok) {
      record.finish("http_error");
      const category = classifyHttpStatus(response.status, QUOTA_SIGNALS.test(text));
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      const backoff = retryAfter !== null ? Math.min(retryAfter, 10_000) : 2_000;
      if (category === "transient" && attempt < MAX_ATTEMPTS && canRetry(backoff)) {
        await sleep(backoff);
        continue;
      }
      return {
        ok: false, category, httpStatus: response.status,
        reason: category === "quota" ? `${reasonPrefix}free_quota_exhausted` : `${reasonPrefix}${response.status}`,
        // Honoured by the provider's cooldown (the router never retries in place).
        retryAfterMs: retryAfter,
      };
    }
    break;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    record.finish("malformed_json");
    return { ok: false, category: "structured_output", httpStatus: response.status, reason: `${reasonPrefix}malformed_envelope` };
  }
  const envelope = isRecord(payload) ? payload : {};
  const choice = Array.isArray(envelope.choices) && isRecord(envelope.choices[0]) ? envelope.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const rawUsage = sanitizeUsage(envelope.usage);
  const usage = usageFrom(rawUsage, { input: "prompt_tokens", output: "completion_tokens", reasoning: "completion_tokens_details.reasoning_tokens" });
  record.response({
    finishReason: safeLabel(choice.finish_reason), nativeFinishReason: null, servedModel: safeLabel(envelope.model),
    upstreamProvider: null, generationId: safeLabel(envelope.id), usage: rawUsage,
  });
  if (isRecord(envelope.error)) {
    record.finish("provider_error");
    const code = typeof envelope.error.code === "number" ? envelope.error.code : 502;
    const category = classifyHttpStatus(code, QUOTA_SIGNALS.test(text));
    return { ok: false, category, httpStatus: code, reason: category === "quota" ? `${reasonPrefix}free_quota_exhausted` : `${reasonPrefix}${code}`, usage };
  }
  if (choice.finish_reason === "length") {
    record.finish("incomplete");
    return { ok: false, category: "output_truncated", httpStatus: response.status, reason: `${reasonPrefix}length`, usage };
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim()) {
    record.finish("empty");
    return { ok: false, category: "structured_output", httpStatus: response.status, reason: `${reasonPrefix}empty`, usage };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    record.finish("malformed_json");
    return { ok: false, category: "structured_output", httpStatus: response.status, reason: `${reasonPrefix}malformed_json`, usage };
  }
  record.finish("success");
  return { ok: true, json, servedModel: safeLabel(envelope.model), upstreamProvider: null, usage };
}
