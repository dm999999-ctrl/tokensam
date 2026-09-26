import "server-only";

/**
 * Server-side OpenRouter client (OpenAI-compatible Chat Completions,
 * https://openrouter.ai/api/v1), used only as the fallback when Gemini is
 * temporarily unavailable. Structured output uses `response_format` with a
 * strict JSON schema, and `provider.require_parameters` restricts routing to
 * endpoints that support it (OpenRouter structured-outputs docs). One attempt
 * only: the fallback never retries. The attempt reports sanitized,
 * observational diagnostics (diagnostics.ts), including whether headers
 * arrived before the body stalled.
 */

import { attemptRecorder, byteLength, safeLabel, sanitizeProviderError, sanitizeUsage, type DiagnosticsOptions } from "./diagnostics.ts";

const BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._/:-]{0,127}$/i;
const REQUEST_TIMEOUT_MS = 100_000;

export type OpenRouterConfig = { apiKey: string; model: string };

export class OpenRouterError extends Error {
  readonly code: "config" | "http" | "network" | "timeout" | "incomplete" | "empty" | "malformed_json";
  readonly status: number | null;
  constructor(code: OpenRouterError["code"], message: string, status: number | null = null) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = status;
  }
}

/** Returns null when OPENROUTER_API_KEY is not configured; the fallback is then skipped. */
export function getOpenRouterConfig(env: Record<string, string | undefined> = process.env): OpenRouterConfig | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new OpenRouterError("config", "OPENROUTER_MODEL is not a valid model identifier.");
  return { apiKey, model };
}

type ChatCompletionResponse = {
  id?: string;
  model?: string;
  provider?: string;
  choices?: { finish_reason?: string | null; native_finish_reason?: string | null; message?: { content?: string | null } }[];
  error?: { code?: number; message?: string };
  usage?: unknown;
};

/** Some routed models wrap JSON in a Markdown fence despite the schema; strip only that wrapper. */
function unfence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

export async function generateStructuredJsonOpenRouter(options: {
  config: OpenRouterConfig;
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  fetchImpl?: typeof fetch;
  diagnostics?: DiagnosticsOptions;
  /** Router override: the router-assigned deadline. Defaults to the standalone 100 s. */
  timeoutMs?: number;
}): Promise<{ json: unknown; model: string; upstreamProvider: string | null; usage: Record<string, number> | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model: options.config.model,
    messages: [
      { role: "system", content: options.systemInstruction },
      { role: "user", content: options.userText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "token_samurai_deep_analysis", strict: true, schema: options.responseSchema },
    },
    // Only route to endpoints that honor response_format (structured outputs).
    provider: { require_parameters: true },
    max_tokens: 16_384,
  });
  // Observational only: records timings, status, sizes, body arrival, and sanitized provider fields.
  const record = attemptRecorder({ options: options.diagnostics, provider: "openrouter", model: options.config.model, attempt: 1, maxAttempts: 1, requestBytes: byteLength(body) });
  let response: Response;
  try {
    response = await fetchImpl(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.config.apiKey}`,
        "content-type": "application/json",
        "x-title": "Token Samurai",
      },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    record.finish(timedOut ? "timeout" : "network");
    throw new OpenRouterError(timedOut ? "timeout" : "network", timedOut ? "The OpenRouter request timed out." : "The OpenRouter request failed due to a network error.");
  }
  record.headers(response, !response.ok);

  if (!response.ok) {
    record.finish("http_error");
    // Bodies, URLs, and keys are never included in errors or logs.
    throw new OpenRouterError("http", `OpenRouter returned HTTP ${response.status}.`, response.status);
  }
  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    // The request deadline also covers reading the body; an abort here is a timeout, not bad JSON.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      record.finish("body_timeout");
      throw new OpenRouterError("timeout", "The OpenRouter request timed out while receiving the response.");
    }
    record.finish("malformed_json");
    throw new OpenRouterError("malformed_json", "OpenRouter returned a response that was not valid JSON.");
  }
  record.response({
    finishReason: safeLabel(payload.choices?.[0]?.finish_reason),
    nativeFinishReason: safeLabel(payload.choices?.[0]?.native_finish_reason),
    servedModel: safeLabel(payload.model),
    upstreamProvider: safeLabel(payload.provider),
    generationId: safeLabel(payload.id),
    usage: sanitizeUsage(payload.usage),
  });
  if (payload.error) {
    record.finish("provider_error", { error: sanitizeProviderError(JSON.stringify({ error: payload.error }), null) });
    throw new OpenRouterError("http", `OpenRouter returned an error (${payload.error.code ?? "unknown"}).`, payload.error.code ?? null);
  }
  const choice = payload.choices?.[0];
  if (!choice) {
    record.finish("empty");
    throw new OpenRouterError("empty", "OpenRouter returned no choices.");
  }
  if (choice.finish_reason && choice.finish_reason !== "stop") {
    record.finish("incomplete");
    throw new OpenRouterError("incomplete", `OpenRouter did not finish normally (${choice.finish_reason}).`);
  }
  const content = choice.message?.content ?? "";
  if (!content.trim()) {
    record.finish("empty");
    throw new OpenRouterError("empty", "OpenRouter returned an empty response.");
  }
  let json: unknown;
  try {
    json = JSON.parse(unfence(content));
  } catch {
    record.finish("malformed_json");
    throw new OpenRouterError("malformed_json", "OpenRouter's structured output was not valid JSON.");
  }
  record.finish("success");
  // The router reports the model that actually served the request.
  return { json, model: payload.model?.trim() || options.config.model, upstreamProvider: payload.provider ?? null, usage: sanitizeUsage(payload.usage) };
}
