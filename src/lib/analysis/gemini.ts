import "server-only";

/**
 * Minimal server-side Gemini client using the REST `models.generateContent`
 * method (https://ai.google.dev/api/generate-content) with structured JSON
 * output. It follows the provider collectors' pattern: plain fetch with an
 * injectable fetchImpl, bounded retries, and errors that never include the key.
 * No tools are enabled, so the model cannot browse or call external URLs.
 * Each attempt reports sanitized, observational diagnostics (diagnostics.ts).
 */

import { attemptRecorder, byteLength, safeLabel, sanitizeUsage, type DiagnosticsOptions } from "./diagnostics.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Current stable general-purpose model at the time of writing; override with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_ATTEMPTS = 2;
// Two Gemini attempts plus one OpenRouter fallback attempt must fit the 300 s route budget.
const REQUEST_TIMEOUT_MS = 60_000;

export type GeminiConfig = { apiKey: string; model: string };

export class GeminiError extends Error {
  readonly code: "config" | "http" | "network" | "timeout" | "blocked" | "incomplete" | "empty" | "malformed_json";
  readonly status: number | null;
  constructor(code: GeminiError["code"], message: string, status: number | null = null) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
    this.status = status;
  }

  /**
   * Temporary provider-side failures (rate limit, overload, timeout, network).
   * Only these may trigger the OpenRouter fallback; configuration, auth,
   * request/schema, blocked, or truncated-output errors never do.
   */
  get retryable(): boolean {
    if (this.code === "timeout" || this.code === "network") return true;
    return this.code === "http" && this.status !== null && (this.status === 408 || this.status === 429 || this.status >= 500);
  }

  /** Stable, secret-free label for provenance, e.g. "gemini_503". */
  get reasonCode(): string {
    return this.code === "http" && this.status !== null ? `gemini_${this.status}` : `gemini_${this.code}`;
  }
}

/** Returns null when GEMINI_API_KEY is not configured; analysis is then unavailable, never faked. */
export function getGeminiConfig(env: Record<string, string | undefined> = process.env): GeminiConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new GeminiError("config", "GEMINI_MODEL is not a valid model code.");
  return { apiKey, model };
}

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: unknown;
};

export async function generateStructuredJson(options: {
  config: GeminiConfig;
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  diagnostics?: DiagnosticsOptions;
  /** Router overrides: a single attempt and the router-assigned deadline. Defaults keep the standalone behavior. */
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<{ json: unknown; modelVersion: string | null; usage: Record<string, number> | null }> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `${BASE_URL}/models/${encodeURIComponent(options.config.model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: options.userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: options.responseSchema,
      // Thinking tokens count toward this budget (observed on gemini-3.6-flash), so leave
      // room for reasoning plus the full JSON; still below the model's 65,536 output limit.
      maxOutputTokens: 32_768,
    },
  });

  const requestBytes = byteLength(body);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Observational only: records timings, status, sizes, and sanitized provider fields.
    const record = attemptRecorder({ options: options.diagnostics, provider: "gemini", model: options.config.model, attempt, maxAttempts, requestBytes });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": options.config.apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      record.finish(timedOut ? "timeout" : "network");
      if (attempt === maxAttempts) {
        throw new GeminiError(timedOut ? "timeout" : "network", timedOut ? "The Gemini request timed out." : "The Gemini request failed due to a network error.");
      }
      await sleep(1_000);
      continue;
    }
    record.headers(response, !response.ok);

    if (!response.ok) {
      record.finish("http_error");
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 2_000);
        continue;
      }
      // Response bodies and URLs are not included in errors or logs.
      throw new GeminiError("http", `Gemini returned HTTP ${response.status}.`, response.status);
    }

    let payload: GenerateContentResponse;
    try {
      payload = (await response.json()) as GenerateContentResponse;
    } catch (error) {
      // The request deadline also covers reading the body; an abort here is a timeout, not bad JSON.
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        record.finish("body_timeout");
        throw new GeminiError("timeout", "The Gemini request timed out while receiving the response.");
      }
      record.finish("malformed_json");
      throw new GeminiError("malformed_json", "Gemini returned a response that was not valid JSON.");
    }
    record.response({
      finishReason: safeLabel(payload.candidates?.[0]?.finishReason),
      nativeFinishReason: null,
      servedModel: safeLabel(payload.modelVersion),
      upstreamProvider: null,
      generationId: null,
      usage: sanitizeUsage(payload.usageMetadata),
    });
    if (payload.promptFeedback?.blockReason) {
      record.finish("blocked");
      throw new GeminiError("blocked", `Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
    }
    const candidate = payload.candidates?.[0];
    if (!candidate) {
      record.finish("empty");
      throw new GeminiError("empty", "Gemini returned no candidates.");
    }
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      record.finish("incomplete");
      throw new GeminiError("incomplete", `Gemini did not finish normally (${candidate.finishReason}).`);
    }
    const textOut = (candidate.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    if (!textOut.trim()) {
      record.finish("empty");
      throw new GeminiError("empty", "Gemini returned an empty response.");
    }
    try {
      const json = JSON.parse(textOut);
      record.finish("success");
      return { json, modelVersion: payload.modelVersion ?? null, usage: sanitizeUsage(payload.usageMetadata) };
    } catch {
      record.finish("malformed_json");
      throw new GeminiError("malformed_json", "Gemini's structured output was not valid JSON.");
    }
  }
  throw new GeminiError("network", "The Gemini request exhausted its retry limit.");
}
