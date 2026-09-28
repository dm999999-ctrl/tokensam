/**
 * Token Samurai AI provider layer: the contract every provider adapter
 * implements. Adapters handle only API differences; every provider receives the
 * same system instruction, research-context user turn, and report schema, and
 * every result goes through the same schema check and evidence validator.
 */

import type { DiagnosticsOptions } from "../diagnostics.ts";

/** Free-access classification from each provider's official documentation. */
export type FreeTierStatus = "FREE" | "FREE_TRIAL" | "PAID_ONLY" | "NOT_VERIFIED";

export type FreeTierInfo = {
  status: FreeTierStatus;
  quotaType: string;
  quota: string | null;
  resetOrExpiry: string | null;
  paymentMethodRequired: boolean | null;
  /** A provider-side setting that prevents paid usage, if one exists. */
  freeOnlyMode: string | null;
  /** Official documentation used for the classification. */
  docs: string[];
  verifiedOn: string;
  notes?: string;
};

export type StructuredOutputSupport = "json_schema" | "json_object" | "unverified";

export type ProviderCapabilities = {
  structuredOutput: StructuredOutputSupport;
  /** Documented context window; null when not documented for the configured model (not enforced). */
  maxContextTokens: number | null;
  /** Documented tokens-per-minute cap on the free tier, which bounds a single request; null when none applies. */
  maxRequestTokens: number | null;
  /** Output-token cap the adapter requests. */
  maxOutputTokens: number;
  supportsReasoningControl: boolean;
  supportsStreaming: boolean;
  supportsUsageMetadata: boolean;
};

export type ProviderType = "primary_free" | "secondary_free" | "backup";

export type ReportRequest = {
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  /** Estimated from the request size, to match capabilities before any call. */
  estimatedInputTokens: number;
};

export type Usage = { inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null };

/**
 * transient: 408/429/5xx, timeout, network → cooldown, next provider.
 * quota: free quota exhausted / payment required → FREE_QUOTA_EXHAUSTED, next provider.
 * configuration: 400/401/403/404/422, missing key, invalid model → marked unavailable, next provider.
 * structured_output: malformed JSON, empty, schema mismatch → at most one same-provider retry, else next.
 * output_truncated: output hit the token cap → next provider (a retry would truncate again).
 * blocked: the provider refused the content → next provider, no cooldown.
 * validation: evidence contract violated → not stored; next provider if budget allows.
 */
export type FailureCategory = "transient" | "quota" | "configuration" | "structured_output" | "output_truncated" | "blocked" | "validation";

export type GenerationOutcome =
  | { ok: true; json: unknown; servedModel: string | null; upstreamProvider: string | null; usage: Usage }
  | { ok: false; category: Exclude<FailureCategory, "validation">; httpStatus: number | null; reason: string; usage?: Usage; retryAfterMs?: number | null };

export type GenerateOptions = {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  diagnostics?: DiagnosticsOptions;
  /** Injectable for tests; defaults to a real timer. Used only for a bounded in-adapter retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Global deadline and the router's reservation for every later candidate provider, given only so
   * a bounded in-adapter retry can check it would not eat into that reservation before attempting
   * it (see adapters.ts `generateWithOpenAiCompatible`). Omitted outside the router (e.g. a direct
   * adapter test): a retry is then always allowed, exactly as before this budget-aware check existed.
   */
  deadlineAt?: number;
  reservedForLaterMs?: number;
  /** Injectable for tests; defaults to Date.now. Only used together with deadlineAt above. */
  clock?: () => number;
};

export interface AIProvider {
  id: string;
  displayName: string;
  providerType: ProviderType;
  /** The model this provider is configured to use (the only model the router requests from it). */
  model: string;
  models: string[];
  freeTier: FreeTierInfo;
  capabilities: ProviderCapabilities;
  /** Key (and any required endpoint setting) present on the server. */
  configured: boolean;
  /** Longest single attempt the router gives this provider (bounded again by the remaining deadline). */
  attemptTimeoutMs: number;
  generateStructuredReport(request: ReportRequest, options: GenerateOptions): Promise<GenerationOutcome>;
}
