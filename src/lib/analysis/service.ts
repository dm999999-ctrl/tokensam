import "server-only";

import { getGeminiConfig } from "./gemini.ts";
import { getOpenRouterConfig } from "./openrouter.ts";
import { AnalysisProviderError, generateWithFallback, type FallbackInfo, type ProviderResult } from "./providers.ts";
import { PROMPT_VERSION, SYSTEM_INSTRUCTION, buildUserContent } from "./prompt.ts";
import { CONTEXT_VERSION, contextHash, isCanonicalTokenId, loadResearchContext, type ResearchContext } from "./research-context.ts";
import { buildEvidenceIndex } from "./evidence-rules.ts";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SCHEMA_VERSION,
  AnalysisValidationError,
  parseStoredAnalysis,
  validateModelAnalysis,
  type TokenAnalysis,
} from "./schema.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** Minimum time between generations for the same token (bounds credit use from a public page). */
export const ANALYSIS_COOLDOWN_MS = 10 * 60 * 1000;
/** Maximum generations across all tokens per rolling hour. */
export const ANALYSIS_HOURLY_LIMIT = 20;

export type AnalysisState =
  | { status: "unconfigured"; message: string }
  | { status: "storage_unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; model: string; latest: TokenAnalysis | null; nextAllowedAt: string | null };

export type GenerateResult =
  | { ok: true; analysis: TokenAnalysis; nextAllowedAt: string }
  | {
    ok: false;
    reason: "invalid_token" | "unconfigured" | "storage_unavailable" | "cooldown" | "rate_limited" | "gemini_failed" | "invalid_output" | "error";
    message: string;
    nextAllowedAt?: string | null;
  };

const UNCONFIGURED_MESSAGE = "AI analysis is unavailable: Gemini is not configured on the server (GEMINI_API_KEY is not set). No AI analysis has been generated.";
const STORAGE_MESSAGE = "AI analysis is unavailable: its storage table has not been set up. Apply supabase/migrations/20260926090000_token_ai_analyses.sql.";

function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

class StorageUnavailableError extends Error {}

async function readLatestRow(client: SupabaseAdminClient, tokenId: string): Promise<{ analysis: unknown; generated_at: string } | null> {
  const { data, error } = await client.from("token_ai_analyses")
    .select("analysis,generated_at").eq("token_id", tokenId)
    .order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (isMissingRelation(error)) throw new StorageUnavailableError();
  if (error) throw new Error(`Supabase read stored analysis failed: ${error.message}`);
  return data as { analysis: unknown; generated_at: string } | null;
}

function nextAllowed(generatedAt: string | null | undefined): string | null {
  if (!generatedAt) return null;
  return new Date(Date.parse(generatedAt) + ANALYSIS_COOLDOWN_MS).toISOString();
}

/** Only an active cooldown is reported, so the UI need not compare clocks while rendering. */
function activeCooldown(generatedAt: string | null | undefined, now: Date): string | null {
  const allowedAt = nextAllowed(generatedAt);
  return allowedAt && Date.parse(allowedAt) > now.getTime() ? allowedAt : null;
}

/** Page-load state: reads the stored analysis only. Never calls Gemini. */
export async function getAnalysisState(client: SupabaseAdminClient, tokenId: string, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<AnalysisState> {
  let config;
  try {
    config = getGeminiConfig(env);
  } catch {
    return { status: "unconfigured", message: "AI analysis is unavailable: GEMINI_MODEL is not a valid model code." };
  }
  if (!config) return { status: "unconfigured", message: UNCONFIGURED_MESSAGE };
  if (!isCanonicalTokenId(tokenId)) return { status: "ready", model: config.model, latest: null, nextAllowedAt: null };
  try {
    const row = await readLatestRow(client, tokenId);
    return { status: "ready", model: config.model, latest: row ? parseStoredAnalysis(row.analysis) : null, nextAllowedAt: activeCooldown(row?.generated_at, now) };
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { status: "storage_unavailable", message: STORAGE_MESSAGE };
    throw error;
  }
}

/** Labels for the IDs an analysis cites, so the UI can show where each statement comes from. */
function sourceLabels(context: ResearchContext, analysis: object): Record<string, string> {
  const labels = new Map<string, string>([["token", `${context.token.name} (${context.token.symbol}) on ${context.token.chain}`]]);
  for (const item of context.scope) labels.set(item.id, `${item.provider} scope: ${item.statement}`);
  for (const item of context.providerFreshness) labels.set(item.id, `${item.provider} freshness: ${item.note}`);
  for (const item of context.observations) labels.set(item.id, `${item.provider} · ${item.name}${item.value === null ? " (unavailable)" : ""} · observed ${item.observedAt}`);
  for (const item of context.calculatedMetrics) labels.set(item.id, `Calculated · ${item.name} · ${item.period.label}`);
  for (const series of context.history) {
    labels.set(series.id, `${series.provider} · ${series.metric} daily history (${series.points.length} points)`);
    for (const point of series.points) labels.set(point.sourceId, `${series.provider} · ${series.metric} · observed ${point.at}`);
  }
  const cited = new Set<string>();
  JSON.stringify(analysis, (key, value) => {
    if (key === "sourceIds" && Array.isArray(value)) for (const id of value) cited.add(id);
    return value;
  });
  return Object.fromEntries([...cited].filter((id) => labels.has(id)).map((id) => [id, labels.get(id)!]));
}

export async function generateTokenAnalysis(
  client: SupabaseAdminClient,
  tokenId: unknown,
  options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<GenerateResult> {
  const now = options.now ?? (() => new Date());
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };

  let config;
  try {
    config = getGeminiConfig(options.env);
  } catch (error) {
    return { ok: false, reason: "unconfigured", message: error instanceof Error ? error.message : UNCONFIGURED_MESSAGE };
  }
  if (!config) return { ok: false, reason: "unconfigured", message: UNCONFIGURED_MESSAGE };

  // Cooldown and hourly cap are enforced from stored generations before any Gemini call.
  let latestGeneratedAt: string | null;
  try {
    latestGeneratedAt = (await readLatestRow(client, tokenId))?.generated_at ?? null;
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { ok: false, reason: "storage_unavailable", message: STORAGE_MESSAGE };
    throw error;
  }
  const allowedAt = nextAllowed(latestGeneratedAt);
  if (allowedAt && Date.parse(allowedAt) > now().getTime()) {
    return { ok: false, reason: "cooldown", message: "An analysis for this token was generated recently. Regeneration will be available shortly.", nextAllowedAt: allowedAt };
  }
  const { count, error: countError } = await client.from("token_ai_analyses")
    .select("id", { count: "exact", head: true })
    .gte("generated_at", new Date(now().getTime() - 60 * 60 * 1000).toISOString());
  if (countError) throw new Error(`Supabase count recent analyses failed: ${countError.message}`);
  if ((count ?? 0) >= ANALYSIS_HOURLY_LIMIT) {
    return { ok: false, reason: "rate_limited", message: "The hourly AI analysis limit has been reached. Please try again later." };
  }

  const context = await loadResearchContext(client, tokenId, now());
  if (!context) return { ok: false, reason: "invalid_token", message: "Unknown token." };

  // An invalid OPENROUTER_MODEL only disables the fallback; it never blocks the Gemini primary.
  let openRouter;
  try {
    openRouter = getOpenRouterConfig(options.env);
  } catch {
    openRouter = null;
  }

  let result: ProviderResult;
  let fallback: FallbackInfo;
  try {
    // Both providers receive the identical controlled request and the same schema.
    ({ result, fallback } = await generateWithFallback(
      { systemInstruction: SYSTEM_INSTRUCTION, userText: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA },
      { gemini: config, openRouter },
      { fetchImpl: options.fetchImpl, sleep: options.sleep },
    ));
  } catch (error) {
    if (error instanceof AnalysisProviderError) {
      console.error(`AI analysis for ${tokenId} failed: ${error.attempts.map((attempt) => `${attempt.provider}=${attempt.reason}`).join(", ")}`);
      return { ok: false, reason: "gemini_failed", message: `The AI analysis could not be generated: ${error.message}` };
    }
    throw error;
  }
  const { json } = result;
  if (fallback.used) console.info(`AI analysis for ${tokenId} used the OpenRouter fallback (${fallback.reason}); model ${result.model}.`);

  let validated;
  try {
    validated = validateModelAnalysis(json, buildEvidenceIndex(context));
  } catch (error) {
    if (error instanceof AnalysisValidationError) {
      console.error(`${result.provider} analysis for ${tokenId} failed validation: ${error.message}`);
      return { ok: false, reason: "invalid_output", message: "The AI response did not pass validation, so nothing is shown. Please try again later." };
    }
    throw error;
  }

  const generatedAt = now().toISOString();
  const analysis: TokenAnalysis = {
    ...validated.analysis,
    metadata: {
      tokenId,
      provider: result.provider,
      model: result.model,
      requestedModel: result.requestedModel,
      upstreamProvider: result.upstreamProvider,
      fallback,
      promptVersion: PROMPT_VERSION,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      contextVersion: CONTEXT_VERSION,
      generatedAt,
      contextAsOf: context.contextAsOf,
      contextHash: contextHash(context),
      sources: sourceLabels(context, validated.analysis),
      validation: validated.counters,
    },
  };

  const { error: insertError } = await client.from("token_ai_analyses").insert({
    token_id: tokenId,
    chain_id: context.token.chainId,
    model: analysis.metadata.model,
    prompt_version: PROMPT_VERSION,
    schema_version: ANALYSIS_SCHEMA_VERSION,
    generated_at: generatedAt,
    context_as_of: context.contextAsOf,
    context_hash: analysis.metadata.contextHash,
    analysis,
    validation: validated.counters,
  });
  if (insertError) throw new Error(`Supabase store analysis failed: ${insertError.message}`);

  return { ok: true, analysis, nextAllowedAt: nextAllowed(generatedAt)! };
}
