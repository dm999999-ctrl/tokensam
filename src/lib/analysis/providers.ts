import "server-only";

import { GeminiError, generateStructuredJson, type GeminiConfig } from "./gemini.ts";
import { OpenRouterError, generateStructuredJsonOpenRouter, type OpenRouterConfig } from "./openrouter.ts";

/**
 * Deep AI Analysis providers. Both receive the identical request (same system
 * instruction, same research-context user text, same response schema) and
 * return raw JSON that the caller validates against the one authoritative
 * Token Samurai schema. Neither provider can change what is validated.
 */

export type ProviderName = "Google Gemini" | "OpenRouter";

export type AnalysisRequest = { systemInstruction: string; userText: string; responseSchema: unknown };

export type ProviderResult = {
  json: unknown;
  provider: ProviderName;
  /** The model that actually produced the output (for OpenRouter, the routed model). */
  model: string;
  requestedModel: string;
  upstreamProvider: string | null;
};

export type FallbackInfo = { used: boolean; reason: string | null };

export class AnalysisProviderError extends Error {
  readonly attempts: { provider: ProviderName; reason: string }[];
  constructor(message: string, attempts: { provider: ProviderName; reason: string }[]) {
    super(message);
    this.name = "AnalysisProviderError";
    this.attempts = attempts;
  }
}

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/**
 * Gemini first (its client already makes at most one bounded retry on 429/5xx).
 * Only a temporary Gemini failure falls back, and only to one OpenRouter
 * attempt. Permanent Gemini errors (auth, bad request/schema, unsupported
 * model, blocked or truncated output) surface as-is. No loops.
 */
export async function generateWithFallback(
  request: AnalysisRequest,
  configs: { gemini: GeminiConfig; openRouter: OpenRouterConfig | null },
  deps: Deps = {},
): Promise<{ result: ProviderResult; fallback: FallbackInfo }> {
  try {
    const { json, modelVersion } = await generateStructuredJson({ config: configs.gemini, ...request, ...deps });
    return {
      result: { json, provider: "Google Gemini", model: modelVersion ?? configs.gemini.model, requestedModel: configs.gemini.model, upstreamProvider: null },
      fallback: { used: false, reason: null },
    };
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    const geminiAttempt = { provider: "Google Gemini" as const, reason: error.reasonCode };
    if (!error.retryable) throw new AnalysisProviderError(error.message, [geminiAttempt]);
    if (!configs.openRouter) {
      throw new AnalysisProviderError(`${error.message} The OpenRouter fallback is not configured.`, [geminiAttempt]);
    }
    try {
      const { json, model, upstreamProvider } = await generateStructuredJsonOpenRouter({ config: configs.openRouter, ...request, fetchImpl: deps.fetchImpl });
      return {
        result: { json, provider: "OpenRouter", model, requestedModel: configs.openRouter.model, upstreamProvider },
        fallback: { used: true, reason: error.reasonCode },
      };
    } catch (fallbackError) {
      if (!(fallbackError instanceof OpenRouterError)) throw fallbackError;
      const openRouterReason = fallbackError.status !== null ? `openrouter_${fallbackError.status}` : `openrouter_${fallbackError.code}`;
      throw new AnalysisProviderError(`${error.message} Fallback: ${fallbackError.message}`, [geminiAttempt, { provider: "OpenRouter", reason: openRouterReason }]);
    }
  }
}
