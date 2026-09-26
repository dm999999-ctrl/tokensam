/**
 * Phase 1B free-provider bake-off: isolated, single-attempt provider adapters.
 *
 * Not used by the application. Every adapter sends the same system
 * instruction, the same research-context user turn, the same Token Samurai
 * response schema through the provider's native JSON-schema mechanism, and the
 * same output-token cap. No temperature is set for any provider (production
 * sets none either), so each provider's default applies. No retries, no
 * output repair: the only normalization is parsing each provider's response
 * envelope. Keys are sent only in request headers and never returned.
 */

export type ProviderId = "gemini" | "mistral" | "groq" | "openrouter" | "qwen" | "deepseek" | "glm" | "kimi" | "minimax";

export type BenchmarkRequest = {
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  maxOutputTokens: number;
};

export type AdapterConfig = { apiKey: string; model: string; env?: Record<string, string | undefined> };

/** A provider response envelope reduced to what the benchmark measures. Never includes prompt or key. */
export type ParsedEnvelope = {
  content: string | null;
  finishReason: string | null;
  finishedNormally: boolean;
  servedModel: string | null;
  upstreamProvider: string | null;
  inputTokens: number | null;
  /** All generated tokens (visible + reasoning), as each provider bills/counts them. */
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Visible output tokens when the provider reports them separately from reasoning. */
  visibleOutputTokens: number | null;
  /** Provider-reported cost in USD, when the provider reports one. */
  costUsd: number | null;
  /** In-body provider error (HTTP 200 with an error object). */
  providerError: { code: number | string | null; status: string | null } | null;
};

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  keyEnv: string;
  /** Model selection: env override first, else the documented default below. */
  model(env: Record<string, string | undefined>): string;
  /** How the structured output is requested, for the report. */
  structuredOutput: string;
  buildRequest(config: AdapterConfig, request: BenchmarkRequest): { url: string; headers: Record<string, string>; body: string };
  parse(payload: unknown): ParsedEnvelope;
};

const SCHEMA_NAME = "token_samurai_deep_analysis";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

/** OpenAI-compatible chat completion envelope (Mistral, Groq, OpenRouter). */
function parseChatCompletion(payload: unknown): ParsedEnvelope {
  const body = isRecord(payload) ? payload : {};
  const choice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const usage = isRecord(body.usage) ? body.usage : {};
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const outputTokens = num(usage.completion_tokens);
  const reasoningTokens = num(details.reasoning_tokens);
  const finishReason = str(choice.finish_reason);
  const error = isRecord(body.error) ? body.error : null;
  return {
    content: typeof message.content === "string" ? message.content : null,
    finishReason,
    finishedNormally: finishReason === "stop",
    servedModel: str(body.model),
    upstreamProvider: str(body.provider),
    inputTokens: num(usage.prompt_tokens),
    outputTokens,
    reasoningTokens,
    visibleOutputTokens: outputTokens !== null && reasoningTokens !== null ? outputTokens - reasoningTokens : null,
    costUsd: num(usage.cost),
    providerError: error ? { code: typeof error.code === "number" || typeof error.code === "string" ? error.code : null, status: str(error.type) ?? str(error.status) } : null,
  };
}

/**
 * For providers whose official docs document only JSON mode (json_object, no
 * JSON Schema): the identical system instruction plus the identical schema
 * appended as text, because the provider cannot take it natively. Recorded as a
 * deviation in results; the schema itself is not changed.
 */
export const JSON_OBJECT_SCHEMA_PREFIX = "\n\nRESPONSE JSON SCHEMA (return one JSON object that matches it exactly):\n";

function jsonObjectBody(model: string, request: BenchmarkRequest, extra: Record<string, unknown>): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: `${request.systemInstruction}${JSON_OBJECT_SCHEMA_PREFIX}${JSON.stringify(request.responseSchema)}` },
      { role: "user", content: request.userText },
    ],
    response_format: { type: "json_object" },
    ...extra,
  });
}

/** An OpenAI-compatible adapter (Chinese providers all expose one). */
function openAiCompatible(spec: {
  id: ProviderId; label: string; keyEnv: string; baseUrl: (env: Record<string, string | undefined>) => string;
  model: (env: Record<string, string | undefined>) => string; mode: "json_schema" | "json_object";
}): ProviderAdapter & { baseUrl: (env: Record<string, string | undefined>) => string; mode: "json_schema" | "json_object" } {
  return {
    id: spec.id,
    label: spec.label,
    keyEnv: spec.keyEnv,
    model: spec.model,
    baseUrl: spec.baseUrl,
    mode: spec.mode,
    structuredOutput: spec.mode === "json_schema"
      ? "response_format json_schema, strict: true"
      : "response_format json_object only (no documented JSON Schema support); schema appended to the system message",
    buildRequest: (config, request) => ({
      url: `${spec.baseUrl(config.env ?? {}).replace(/\/+$/, "")}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: spec.mode === "json_schema"
        ? chatBody(config.model, request, { max_tokens: request.maxOutputTokens })
        : jsonObjectBody(config.model, request, { max_tokens: request.maxOutputTokens }),
    }),
    parse: parseChatCompletion,
  };
}

function chatBody(model: string, request: BenchmarkRequest, extra: Record<string, unknown>): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: request.systemInstruction },
      { role: "user", content: request.userText },
    ],
    response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, strict: true, schema: request.responseSchema } },
    ...extra,
  });
}

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    // The currently configured production model (GEMINI_MODEL), else the production default.
    model: (env) => env.BENCHMARK_GEMINI_MODEL?.trim() || env.GEMINI_MODEL?.trim() || "gemini-3.6-flash",
    structuredOutput: "generationConfig.responseMimeType=application/json + responseJsonSchema (same as production)",
    buildRequest: (config, request) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: request.userText }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: request.responseSchema, maxOutputTokens: request.maxOutputTokens },
      }),
    }),
    parse: (payload) => {
      const body = isRecord(payload) ? payload : {};
      const candidate = Array.isArray(body.candidates) && isRecord(body.candidates[0]) ? body.candidates[0] : {};
      const content = isRecord(candidate.content) ? candidate.content : {};
      const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
      const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
      const visible = num(usage.candidatesTokenCount);
      const thoughts = num(usage.thoughtsTokenCount);
      const finishReason = str(candidate.finishReason);
      const feedback = isRecord(body.promptFeedback) ? body.promptFeedback : {};
      const text = parts.filter((part) => part.thought !== true).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
      return {
        content: parts.length ? text : null,
        finishReason: finishReason ?? (str(feedback.blockReason) ? `BLOCKED:${str(feedback.blockReason)}` : null),
        finishedNormally: finishReason === "STOP",
        servedModel: str(body.modelVersion),
        upstreamProvider: null,
        inputTokens: num(usage.promptTokenCount),
        outputTokens: visible !== null || thoughts !== null ? (visible ?? 0) + (thoughts ?? 0) : null,
        reasoningTokens: thoughts,
        visibleOutputTokens: visible,
        costUsd: null,
        providerError: null,
      };
    },
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    keyEnv: "MISTRAL_API_KEY",
    // "-latest" alias documented for chat completions with custom structured output.
    model: (env) => env.BENCHMARK_MISTRAL_MODEL?.trim() || "mistral-medium-2604",
    structuredOutput: "response_format json_schema, strict: true",
    buildRequest: (config, request) => ({
      url: "https://api.mistral.ai/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: chatBody(config.model, request, { max_tokens: request.maxOutputTokens }),
    }),
    parse: parseChatCompletion,
  },
  groq: {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    // One of the models Groq documents for strict (constrained-decoding) structured outputs.
    model: (env) => env.BENCHMARK_GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
    structuredOutput: "response_format json_schema, strict: true (constrained decoding)",
    buildRequest: (config, request) => ({
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: chatBody(config.model, request, { max_completion_tokens: request.maxOutputTokens }),
    }),
    parse: parseChatCompletion,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    // The free router, not the production OPENROUTER_MODEL (the Phase 0 Nemotron baseline).
    model: (env) => env.BENCHMARK_OPENROUTER_MODEL?.trim() || "openrouter/free",
    structuredOutput: "response_format json_schema, strict: true; provider.require_parameters (same as production)",
    buildRequest: (config, request) => ({
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, "x-title": "Token Samurai benchmark" },
      body: chatBody(config.model, request, { provider: { require_parameters: true }, max_tokens: request.maxOutputTokens }),
    }),
    parse: parseChatCompletion,
  },
  // ---- Phase 1C: Chinese providers (all OpenAI-compatible) ----
  // Qwen: Model Studio new-user free quota is Singapore-region / International only; the
  // endpoint includes the account's workspace, so QWEN_BASE_URL must be set by the user.
  // JSON Schema mode is documented for the Qwen3.7/3.8 Plus, Flash, and Max series.
  qwen: openAiCompatible({
    id: "qwen", label: "Qwen (Alibaba Model Studio)", keyEnv: "DASHSCOPE_API_KEY", mode: "json_schema",
    baseUrl: (env) => env.QWEN_BASE_URL?.trim() || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: (env) => env.BENCHMARK_QWEN_MODEL?.trim() || "qwen3.7-plus",
  }),
  deepseek: openAiCompatible({
    id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", mode: "json_object",
    baseUrl: () => "https://api.deepseek.com",
    model: (env) => env.BENCHMARK_DEEPSEEK_MODEL?.trim() || "deepseek-flash",
  }),
  glm: openAiCompatible({
    id: "glm", label: "Zhipu / Z.AI GLM", keyEnv: "ZHIPU_API_KEY", mode: "json_object",
    baseUrl: () => "https://api.z.ai/api/paas/v4",
    // Listed as a free model on the official Z.AI pricing page.
    model: (env) => env.BENCHMARK_GLM_MODEL?.trim() || "glm-4.7-flash",
  }),
  kimi: openAiCompatible({
    id: "kimi", label: "Moonshot / Kimi", keyEnv: "MOONSHOT_API_KEY", mode: "json_object",
    baseUrl: () => "https://api.moonshot.ai/v1",
    model: (env) => env.BENCHMARK_KIMI_MODEL?.trim() || "kimi-k2.6",
  }),
  minimax: openAiCompatible({
    id: "minimax", label: "MiniMax", keyEnv: "MINIMAX_API_KEY", mode: "json_object",
    baseUrl: () => "https://api.minimax.io/v1",
    model: (env) => env.BENCHMARK_MINIMAX_MODEL?.trim() || "MiniMax-M2",
  }),
};
