import "server-only";

/**
 * Provider catalogue. Data only: free-tier classifications (from official
 * documentation, verified 2026-09-25), capabilities, env configuration, and
 * the adapter each provider uses. Routing logic lives in router.ts.
 *
 * Environment (all server-side; never NEXT_PUBLIC_):
 *   AI_PROVIDER_PRIORITY   comma-separated order (default below)
 *   AI_ALLOWED_FREE_TIERS  which classifications may be called (default "FREE";
 *                          add FREE_TRIAL to opt in to promotional quotas)
 *   <PROVIDER>_API_KEY / <PROVIDER>_MODEL / <PROVIDER>_BASE_URL  per provider
 */

import { DEFAULT_GEMINI_MODEL, getGeminiConfig } from "../gemini.ts";
import { DEFAULT_OPENROUTER_MODEL, getOpenRouterConfig } from "../openrouter.ts";
import { generateWithGemini, generateWithOpenAiCompatible, generateWithOpenRouter } from "./adapters.ts";
import type { AIProvider, FreeTierInfo, FreeTierStatus, ProviderCapabilities, ProviderType } from "./types.ts";

type Env = Record<string, string | undefined>;

export const DEFAULT_PROVIDER_PRIORITY = ["qwen", "hunyuan", "glm", "mistral", "groq", "siliconflow", "gemini", "openrouter"] as const;
const VERIFIED_ON = "2026-09-25";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

const openAiCaps = (overrides: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  structuredOutput: "json_schema", maxContextTokens: null, maxRequestTokens: null, maxOutputTokens: 16_384,
  supportsReasoningControl: false, supportsStreaming: true, supportsUsageMetadata: true, ...overrides,
});

type OpenAiSpec = {
  id: string;
  displayName: string;
  providerType: ProviderType;
  keyEnv: string;
  modelEnv: string;
  baseUrlEnv: string;
  defaultBaseUrl: string;
  defaultModel: string | null;
  freeTier: FreeTierInfo;
  capabilities: ProviderCapabilities;
  outputTokenParam?: "max_tokens" | "max_completion_tokens";
};

/**
 * OpenAI-compatible providers. Eligibility (ai/router.ts `ineligibility()`) requires
 * structuredOutput "json_schema" (API-enforced) or "json_object" (schema sent as text; the
 * server's schema check and evidence validator apply exactly the same either way). A provider
 * whose structured-output support is genuinely undocumented is "unverified" and stays registered
 * but never eligible, rather than guessing.
 */
export const OPENAI_COMPATIBLE_SPECS: OpenAiSpec[] = [
  {
    id: "qwen", displayName: "Qwen (Alibaba Cloud Model Studio)", providerType: "primary_free",
    keyEnv: "DASHSCOPE_API_KEY", modelEnv: "QWEN_MODEL", baseUrlEnv: "QWEN_BASE_URL",
    // The docs give the Singapore endpoint as https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1.
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.7-plus",
    freeTier: {
      status: "FREE_TRIAL", quotaType: "New-user free quota per model",
      quota: "Typically 1,000,000 tokens per model; input and output share one pool",
      resetOrExpiry: "90 days from Model Studio activation / model release / approval (whichever is later)",
      paymentMethodRequired: null,
      freeOnlyMode: "Model Studio \"Free quota only\": requests fail with AllocationQuota.FreeTierOnly when the quota is exhausted. Must be enabled in the console.",
      docs: ["https://www.alibabacloud.com/help/en/model-studio/new-free-quota", "https://www.alibabacloud.com/help/en/model-studio/json-mode"],
      verifiedOn: VERIFIED_ON,
      notes: "Singapore region, International deployment scope only. JSON Schema mode only for the Qwen3.7/3.8 Plus, Flash, and Max series. Account information must be completed before activation.",
    },
    capabilities: openAiCaps({}),
  },
  {
    id: "hunyuan", displayName: "Hunyuan (Tencent Cloud TokenHub)", providerType: "primary_free",
    keyEnv: "HUNYUAN_API_KEY", modelEnv: "HUNYUAN_MODEL", baseUrlEnv: "HUNYUAN_BASE_URL",
    defaultBaseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1", defaultModel: null,
    freeTier: {
      status: "FREE_TRIAL", quotaType: "Promotional trial credits (TokenHub)", quota: "Claimable once per model per main account",
      resetOrExpiry: "Promotion runs until 2026-12-31", paymentMethodRequired: null, freeOnlyMode: null,
      docs: ["https://www.tencentcloud.com/act/pro/tokenhub"], verifiedOn: VERIFIED_ON,
      notes: "OpenAI-compatible; JSON Schema structured output not documented for Hunyuan models.",
    },
    capabilities: openAiCaps({ structuredOutput: "unverified" }),
  },
  {
    id: "glm", displayName: "GLM (Z.AI / Zhipu)", providerType: "primary_free",
    // The configured variable is ZHIPU_API_KEY; the key is accepted by both api.z.ai and open.bigmodel.cn.
    keyEnv: "ZHIPU_API_KEY", modelEnv: "GLM_MODEL", baseUrlEnv: "GLM_BASE_URL",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-4.7-flash",
    freeTier: {
      status: "FREE", quotaType: "Free model (no per-token price)", quota: "GLM-4.7-Flash and GLM-4.5-Flash listed as free",
      resetOrExpiry: null, paymentMethodRequired: null, freeOnlyMode: "Free by model choice (the Flash models)",
      docs: ["https://docs.z.ai/guides/overview/pricing", "https://docs.z.ai/guides/capabilities/struct-output"], verifiedOn: VERIFIED_ON,
      notes: "Structured output documented as json_object only (no JSON Schema); rate limits not documented.",
    },
    capabilities: openAiCaps({ structuredOutput: "json_object" }),
  },
  {
    id: "mistral", displayName: "Mistral", providerType: "secondary_free",
    keyEnv: "MISTRAL_API_KEY", modelEnv: "MISTRAL_MODEL", baseUrlEnv: "MISTRAL_BASE_URL",
    // Mistral Medium 3.5 (GA, 256K context, structured outputs): the pinned ID from the current models page.
    defaultBaseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-medium-2604",
    freeTier: {
      status: "FREE", quotaType: "Free mode: included monthly usage", quota: "Shown on the account's Limits page (not published)",
      resetOrExpiry: "Monthly", paymentMethodRequired: null, freeOnlyMode: "Free mode (keep pay-as-you-go disabled on the Subscriptions page)",
      docs: ["https://docs.mistral.ai/admin/user-management-finops/tier", "https://docs.mistral.ai/api", "https://docs.mistral.ai/models", "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"], verifiedOn: VERIFIED_ON,
    },
    capabilities: openAiCaps({ maxContextTokens: 256_000 }),
  },
  {
    id: "groq", displayName: "Groq", providerType: "secondary_free",
    keyEnv: "GROQ_API_KEY", modelEnv: "GROQ_MODEL", baseUrlEnv: "GROQ_BASE_URL",
    defaultBaseUrl: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-120b", outputTokenParam: "max_completion_tokens",
    freeTier: {
      status: "FREE", quotaType: "Free plan rate limits", quota: "gpt-oss-120b: 30 RPM, 1K RPD, 8K TPM, 200K TPD",
      resetOrExpiry: "Per minute / per day", paymentMethodRequired: false, freeOnlyMode: "Free plan (Developer plan is a separate upgrade)",
      docs: ["https://console.groq.com/docs/rate-limits", "https://console.groq.com/docs/structured-outputs"], verifiedOn: VERIFIED_ON,
      notes: "Strict JSON Schema on gpt-oss-20b/120b and qwen3.8-27b. The 8K TPM cap is below the ~22-29K-token research prompt.",
    },
    capabilities: openAiCaps({ maxRequestTokens: 8_000 }),
  },
  {
    // Not in DEFAULT_PROVIDER_PRIORITY: opt in by adding "cerebras" to AI_PROVIDER_PRIORITY and FREE_TRIAL to AI_ALLOWED_FREE_TIERS.
    id: "cerebras", displayName: "Cerebras Inference", providerType: "secondary_free",
    keyEnv: "CEREBRAS_API_KEY", modelEnv: "CEREBRAS_MODEL", baseUrlEnv: "CEREBRAS_BASE_URL",
    defaultBaseUrl: "https://api.cerebras.ai/v1", defaultModel: "gpt-oss-120b", outputTokenParam: "max_completion_tokens",
    freeTier: {
      status: "FREE_TRIAL", quotaType: "Free Trial credits", quota: "$5 in credits; Free Trial limits 5 RPM, 30K uncached TPM, 90K total TPM, 1M TPH, 1M TPD",
      resetOrExpiry: "Credits expire 30 days after being granted", paymentMethodRequired: true,
      freeOnlyMode: "No charge until additional credits are purchased (per the rate-limits page)",
      docs: ["https://inference-docs.cerebras.ai/support/rate-limits", "https://inference-docs.cerebras.ai/capabilities/structured-outputs", "https://inference-docs.cerebras.ai/models/overview"],
      verifiedOn: "2026-09-26",
      notes: "Strict JSON Schema via constrained decoding (schema text 976/5,000 chars, depth 6/10: within limits). Free-trial context 65K for gpt-oss-120b. Max output not documented. The 30K uncached TPM cap is treated as bounding input plus output.",
    },
    capabilities: openAiCaps({ maxContextTokens: 65_000, maxRequestTokens: 30_000 }),
  },
  {
    id: "siliconflow", displayName: "SiliconFlow", providerType: "secondary_free",
    keyEnv: "SILICONFLOW_API_KEY", modelEnv: "SILICONFLOW_MODEL", baseUrlEnv: "SILICONFLOW_BASE_URL",
    defaultBaseUrl: "https://api.siliconflow.com/v1", defaultModel: null,
    freeTier: {
      status: "FREE", quotaType: "Free models with fixed rate limits", quota: "Per model (e.g. 100 requests/day)",
      resetOrExpiry: "Daily", paymentMethodRequired: null, freeOnlyMode: "Free by model choice",
      docs: ["https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation", "https://docs.siliconflow.cn/cn/userguide/guides/json-mode"], verifiedOn: "2026-09-26",
      notes: "JSON mode (response_format {\"type\":\"json_object\"}) is documented platform-wide (\"currently the platform's large language models support this parameter\"); JSON Schema (strict) support is not documented per free model, so json_object is used. No default model chosen.",
    },
    capabilities: openAiCaps({ structuredOutput: "json_object" }),
  },
  {
    // OpenAI-compatible API-Inference service (https://www.modelscope.cn/docs/model-service/API-Inference/intro).
    // json_schema is documented but reported broken (returns HTTP 200 with null choices, no error:
    // github.com/modelscope/modelscope/issues/1801), so json_object is used instead, like GLM/SiliconFlow.
    // No default model: MODELSCOPE_MODEL must be set.
    id: "modelscope", displayName: "ModelScope (Alibaba)", providerType: "secondary_free",
    keyEnv: "MODELSCOPE_API_TOKEN", modelEnv: "MODELSCOPE_MODEL", baseUrlEnv: "MODELSCOPE_BASE_URL",
    defaultBaseUrl: "https://api-inference.modelscope.cn/v1", defaultModel: null,
    freeTier: {
      status: "FREE", quotaType: "Free API-Inference access (per-model daily call limits)", quota: "Documented per model on its ModelScope page",
      resetOrExpiry: "Daily", paymentMethodRequired: null, freeOnlyMode: "Free by model choice",
      docs: ["https://www.modelscope.cn/docs/model-service/API-Inference/intro", "https://github.com/modelscope/modelscope/issues/1801"], verifiedOn: "2026-09-26",
      notes: "response_format {\"type\":\"json_object\"} works; {\"type\":\"json_schema\"} is a documented open bug (HTTP 200, null choices, no error), so json_schema must not be used until that is fixed. No default model chosen.",
    },
    capabilities: openAiCaps({ structuredOutput: "json_object" }),
  },
];

export const GEMINI_FREE_TIER: FreeTierInfo = {
  status: "FREE", quotaType: "Gemini API Free tier (per-project rate limits)", quota: "Shown in Google AI Studio (not published per model)",
  resetOrExpiry: "Per minute / per day", paymentMethodRequired: false, freeOnlyMode: "Free tier applies to projects without billing enabled",
  docs: ["https://ai.google.dev/gemini-api/docs/rate-limits", "https://ai.google.dev/gemini-api/docs/models"], verifiedOn: VERIFIED_ON,
  notes: "Whether the configured key's project is on the free tier is not visible through the API.",
};

/** OpenRouter is free only for ":free" models and the free router; any other model is treated as paid. */
export function openRouterFreeTier(model: string): FreeTierInfo {
  const free = model === "openrouter/free" || model.endsWith(":free");
  return {
    status: free ? "FREE" : "PAID_ONLY", quotaType: "Free models (reported cost 0)", quota: "Free-model request limits apply",
    resetOrExpiry: "Daily", paymentMethodRequired: false, freeOnlyMode: free ? "Model restricted to :free / openrouter/free" : null,
    docs: ["https://openrouter.ai/docs/guides/routing/routers/free-router"], verifiedOn: VERIFIED_ON,
  };
}

function openAiProvider(spec: OpenAiSpec, env: Env): AIProvider {
  const apiKey = env[spec.keyEnv]?.trim() ?? "";
  const modelSetting = env[spec.modelEnv]?.trim() || spec.defaultModel || "";
  const model = MODEL_PATTERN.test(modelSetting) ? modelSetting : "";
  const baseUrl = env[spec.baseUrlEnv]?.trim() || spec.defaultBaseUrl;
  return {
    id: spec.id, displayName: spec.displayName, providerType: spec.providerType,
    model, models: model ? [model] : [], freeTier: spec.freeTier, capabilities: spec.capabilities,
    configured: Boolean(apiKey && model && /^https:\/\//.test(baseUrl)),
    attemptTimeoutMs: 120_000,
    generateStructuredReport: (request, options) => generateWithOpenAiCompatible(
      {
        providerId: spec.id, apiKey, model, baseUrl, maxOutputTokens: spec.capabilities.maxOutputTokens, outputTokenParam: spec.outputTokenParam,
        // A provider documenting only JSON mode gets JSON mode (the schema is then sent as text, not enforced).
        structuredMode: spec.capabilities.structuredOutput === "json_object" ? "json_object" : "json_schema",
      },
      request, options,
    ),
  };
}

function geminiProvider(env: Env): AIProvider {
  let config: { apiKey: string; model: string } | null = null;
  try { config = getGeminiConfig(env); } catch { config = null; }
  const model = config?.model ?? (env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  return {
    id: "gemini", displayName: "Google Gemini", providerType: "backup", model, models: [model], freeTier: GEMINI_FREE_TIER,
    capabilities: { structuredOutput: "json_schema", maxContextTokens: null, maxRequestTokens: null, maxOutputTokens: 32_768, supportsReasoningControl: true, supportsStreaming: true, supportsUsageMetadata: true },
    configured: Boolean(config),
    attemptTimeoutMs: 90_000,
    generateStructuredReport: (request, options) => generateWithGemini(config!, request, options),
  };
}

function openRouterProvider(env: Env): AIProvider {
  let config: { apiKey: string; model: string } | null = null;
  try { config = getOpenRouterConfig(env); } catch { config = null; }
  const model = config?.model ?? (env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL);
  return {
    id: "openrouter", displayName: "OpenRouter", providerType: "backup", model, models: [model], freeTier: openRouterFreeTier(model),
    capabilities: { structuredOutput: "json_schema", maxContextTokens: null, maxRequestTokens: null, maxOutputTokens: 16_384, supportsReasoningControl: false, supportsStreaming: true, supportsUsageMetadata: true },
    configured: Boolean(config),
    attemptTimeoutMs: 150_000,
    generateStructuredReport: (request, options) => generateWithOpenRouter(config!, request, options),
  };
}

/** Every registered provider, keyed by ID, configured from env. */
export function buildProviders(env: Env = process.env): Map<string, AIProvider> {
  const providers = new Map<string, AIProvider>();
  for (const spec of OPENAI_COMPATIBLE_SPECS) providers.set(spec.id, openAiProvider(spec, env));
  providers.set("gemini", geminiProvider(env));
  providers.set("openrouter", openRouterProvider(env));
  return providers;
}

export function providerPriority(env: Env = process.env): string[] {
  const configured = env.AI_PROVIDER_PRIORITY?.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
  return configured?.length ? [...new Set(configured)] : [...DEFAULT_PROVIDER_PRIORITY];
}

export function allowedFreeTiers(env: Env = process.env): Set<FreeTierStatus> {
  const allowed = new Set<FreeTierStatus>();
  for (const value of (env.AI_ALLOWED_FREE_TIERS ?? "FREE").split(",")) {
    const status = value.trim().toUpperCase();
    // PAID_ONLY and NOT_VERIFIED can never be allowed: this phase is free-API only.
    if (status === "FREE" || status === "FREE_TRIAL") allowed.add(status);
  }
  return allowed.size ? allowed : new Set<FreeTierStatus>(["FREE"]);
}
