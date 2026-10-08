import "server-only";

import { providerHealth, type ProviderHealthStore } from "./ai/health.ts";
import { schemaErrors, type JsonSchema } from "./ai/json-schema.ts";
import { allowedFreeTiers, buildProviders, providerPriority } from "./ai/registry.ts";
import { NoProviderSucceededError, routeReport, type RouteAttempt, type RouterValidation } from "./ai/router.ts";
import type { AIProvider } from "./ai/types.ts";
import { PROFILE_PROMPT_VERSION, PROFILE_SYSTEM_INSTRUCTION, buildProfileUserContent } from "./prompt.ts";
import { isCanonicalTokenId } from "./research-context.ts";
import { buildProfilePayload } from "./profile-payload.ts";
import { attachEvidencePeriods, buildProfileResponseSchema, buildProfileValidationSchema } from "./profile-contract.ts";
import { buildProfileEvidenceIndex, measureProfilePayload, profilePayloadHash, profileSourceLabels } from "./profile-evidence.ts";
import { emitDiagnostic, newRunId, type ContextSizeDiagnostic, type DiagnosticSink, type GenerationDiagnostic } from "./diagnostics.ts";
import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { getLiveTokenProfileForAnalysis } from "../data/live-data.ts";
import type { LiveTokenProfileData } from "../../types/token.ts";
import {
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
/**
 * One overall deadline for all provider attempts, measured from the start of generation. The
 * Token Profile Server Action has maxDuration 300 s; the remaining 60 s cover context loading,
 * validation, storage, and the response.
 */
export const ANALYSIS_DEADLINE_MS = 240_000;

export type AnalysisState =
  | { status: "unconfigured"; message: string }
  | { status: "storage_unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; model: string; latest: TokenAnalysis | null; nextAllowedAt: string | null };

export type GenerateResult =
  | { ok: true; analysis: TokenAnalysis; nextAllowedAt: string }
  | {
    ok: false;
    reason: "invalid_token" | "unconfigured" | "storage_unavailable" | "cooldown" | "rate_limited" | "provider_failed" | "invalid_output" | "error";
    message: string;
    nextAllowedAt?: string | null;
  };

const UNCONFIGURED_MESSAGE = "AI analysis is unavailable: no allowed AI provider is configured on the server (for example, GEMINI_API_KEY is not set). No AI analysis has been generated.";
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

/** Configured providers the free-tier policy allows, in priority order (no requests are made). */
function usableProviders(env: Record<string, string | undefined>): { providers: Map<string, AIProvider>; usable: AIProvider[] } {
  const providers = buildProviders(env);
  const allowed = allowedFreeTiers(env);
  const usable = providerPriority(env)
    .map((id) => providers.get(id))
    .filter((provider): provider is AIProvider => Boolean(provider?.configured && allowed.has(provider.freeTier.status)));
  return { providers, usable };
}

/** Estimated input tokens (~3.5 bytes per token, measured on real Token Samurai prompts in Phase 0). */
function estimateTokens(systemInstruction: string, userText: string, schema: unknown): number {
  const bytes = new TextEncoder().encode(systemInstruction + userText + JSON.stringify(schema)).length;
  return Math.ceil(bytes / 3.5);
}

/** Compact, secret-free route summary, e.g. "qwen:skipped:not_configured", "gemini:transient", "openrouter:ok". */
function sequence(attempts: RouteAttempt[]): string[] {
  return attempts.map((item) => `${item.providerId}:${item.action === "skipped" ? `skipped:${item.skipReason}` : item.validationPassed ? "ok" : item.category ?? "failed"}`);
}

/** Page-load state: reads the stored analysis only. Never calls a provider. */
export async function getAnalysisState(client: SupabaseAdminClient, tokenId: string, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<AnalysisState> {
  const { usable } = usableProviders(env);
  if (usable.length === 0) return { status: "unconfigured", message: UNCONFIGURED_MESSAGE };
  const model = usable[0].model;
  if (!isCanonicalTokenId(tokenId)) return { status: "ready", model, latest: null, nextAllowedAt: null };
  try {
    const row = await readLatestRow(client, tokenId);
    return { status: "ready", model, latest: row ? parseStoredAnalysis(row.analysis) : null, nextAllowedAt: activeCooldown(row?.generated_at, now) };
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { status: "storage_unavailable", message: STORAGE_MESSAGE };
    throw error;
  }
}

export async function generateTokenAnalysis(
  client: SupabaseAdminClient,
  tokenId: unknown,
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    /** Injectable for tests; forwarded to each provider's bounded in-adapter retry backoff. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    diagnosticsSink?: DiagnosticSink;
    /** Provider health/cooldown state; defaults to this server instance's shared store. */
    providerHealth?: ProviderHealthStore;
    /** Epoch-ms clock for the overall deadline (tests). */
    clock?: () => number;
    deadlineMs?: number;
    /** Loads the Token Profile data (defaults to the page's own loader through `client`). */
    loadProfile?: (tokenId: string) => Promise<LiveTokenProfileData | null>;
  } = {},
): Promise<GenerateResult> {
  const now = options.now ?? (() => new Date());
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };

  const env = options.env ?? process.env;
  const { providers, usable } = usableProviders(env);
  if (usable.length === 0) return { ok: false, reason: "unconfigured", message: UNCONFIGURED_MESSAGE };

  // Cooldown and hourly cap are enforced from stored generations before any provider call.
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

  // Phase 0 diagnostics (observational only): one sanitized summary per generation, plus
  // per-attempt provider events correlated by runId. Nothing here changes the outcome.
  const diagnostics = { sink: options.diagnosticsSink, runId: newRunId() };
  const startedAt = Date.now();
  const startedClock = performance.now();
  let contextBuildMs: number | null = null;
  let providerMs: number | null = null;
  let contextSize: ContextSizeDiagnostic | null = null;
  const summarize = (outcome: GenerationDiagnostic["outcome"], details: Partial<Pick<GenerationDiagnostic, "provider" | "fallbackUsed" | "fallbackReason" | "providerAttempts" | "providerSequence" | "validationViolations">> = {}) => {
    const latencyMs = performance.now() - startedClock;
    emitDiagnostic(diagnostics, {
      type: "ai.generation", runId: diagnostics.runId, tokenId,
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt + latencyMs).toISOString(), latencyMs: Math.round(latencyMs),
      contextBuildMs, providerMs, context: contextSize, outcome,
      provider: details.provider ?? null, fallbackUsed: details.fallbackUsed ?? false, fallbackReason: details.fallbackReason ?? null,
      providerAttempts: details.providerAttempts ?? [], providerSequence: details.providerSequence, validationViolations: details.validationViolations ?? null,
    });
  };

  // The AI input is the data the Token Profile page shows: the same loader and the same
  // display functions produce one canonical payload (also used by the page's "Copy data").
  // getLiveTokenProfileForAnalysis, not getLiveTokenProfile: the AI's evidence should
  // be stable, stored data, not an ephemeral live tick, and must not share the
  // page-render cache either (see that function's doc comment).
  const profile = await (options.loadProfile ?? ((id: string) => getLiveTokenProfileForAnalysis(id, client)))(tokenId);
  if (!profile) return { ok: false, reason: "invalid_token", message: "Unknown token." };
  const payload = buildProfilePayload(profile);
  contextBuildMs = Math.round(performance.now() - startedClock);
  const userText = buildProfileUserContent(payload);
  // Structural contract, derived from this token's payload at runtime: sourceIds may only be IDs
  // present in the payload, and statements carry no model-written period (see profile-contract.ts).
  const responseSchema = buildProfileResponseSchema(payload);
  const validationSchema = buildProfileValidationSchema(payload);
  try {
    contextSize = measureProfilePayload(payload, { systemInstruction: PROFILE_SYSTEM_INSTRUCTION, userContent: userText, responseSchema });
  } catch {
    contextSize = null;
  }

  // Every provider receives the identical request; every result must pass the schema check
  // and the (unchanged) evidence validator inside the router, so an invalid report from one
  // provider can fall through to the next while the deadline allows.
  const evidence = buildProfileEvidenceIndex(payload);
  const validate = (json: unknown): RouterValidation<ReturnType<typeof validateModelAnalysis>> => {
    // Periods come from the cited fields, never from the model; then the constrained schema, then the validator.
    const report = attachEvidencePeriods(json, payload);
    const shape = schemaErrors(report, validationSchema as JsonSchema);
    if (shape.length > 0) return { ok: false, category: "structured_output", violations: shape.length, reason: "schema_mismatch" };
    try {
      return { ok: true, value: validateModelAnalysis(report, evidence), violations: 0 };
    } catch (error) {
      if (!(error instanceof AnalysisValidationError)) throw error;
      console.error(`AI analysis for ${tokenId} failed evidence validation: ${error.message}`);
      return { ok: false, category: "validation", violations: error.violations.length, reason: "evidence_contract" };
    }
  };

  const clock = options.clock ?? Date.now;
  const providerStart = performance.now();
  let routed: Awaited<ReturnType<typeof routeReport<ReturnType<typeof validateModelAnalysis>>>>;
  try {
    routed = await routeReport({
      request: { systemInstruction: PROFILE_SYSTEM_INSTRUCTION, userText, responseSchema, estimatedInputTokens: estimateTokens(PROFILE_SYSTEM_INSTRUCTION, userText, responseSchema) },
      providers,
      priority: providerPriority(env),
      allowedTiers: allowedFreeTiers(env),
      deadlineAt: startedAt + (options.deadlineMs ?? ANALYSIS_DEADLINE_MS),
      validate,
      health: options.providerHealth ?? providerHealth,
      clock,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      diagnostics,
    });
  } catch (error) {
    providerMs = Math.round(performance.now() - providerStart);
    if (error instanceof NoProviderSucceededError) {
      const tried = error.attempts.filter((attempt) => attempt.action === "attempted");
      const summary = { providerAttempts: tried.map((attempt) => ({ provider: attempt.providerId, reason: attempt.reason ?? "failed" })), providerSequence: sequence(error.attempts) };
      console.error(`AI analysis for ${tokenId} failed: ${summary.providerSequence.join(", ")}`);
      if (error.invalidOutput && tried.every((attempt) => attempt.category === "validation" || attempt.category === "structured_output")) {
        summarize("invalid_output", { ...summary, validationViolations: tried.at(-1)?.validationViolations ?? null });
        return { ok: false, reason: "invalid_output", message: "The AI response did not pass validation, so nothing is shown. Please try again later." };
      }
      summarize("provider_failed", summary);
      return { ok: false, reason: "provider_failed", message: `The AI analysis could not be generated: ${error.message}` };
    }
    summarize("error");
    throw error;
  }
  providerMs = Math.round(performance.now() - providerStart);
  const { provider, attempt, attempts } = routed;
  const validated = routed.value;
  const failedBefore = attempts.filter((item) => item.action === "attempted" && item !== attempt);
  const fallbackReason = failedBefore[0]?.reason ?? null;
  // The panel's existing fallback line reads "Gemini unavailable (…); generated by OpenRouter", so it is
  // set only for exactly that case; every other route is described in metadata.routing.
  const geminiFailure = failedBefore.find((item) => item.providerId === "gemini");
  const fallback = { used: provider.id === "openrouter" && Boolean(geminiFailure), reason: provider.id === "openrouter" ? geminiFailure?.reason ?? null : null };
  const providerDetails = { provider: provider.displayName, fallbackUsed: failedBefore.length > 0, fallbackReason, providerSequence: sequence(attempts), providerAttempts: failedBefore.map((item) => ({ provider: item.providerId, reason: item.reason ?? "failed" })) };
  if (failedBefore.length > 0) console.info(`AI analysis for ${tokenId} was generated by ${provider.id} after: ${sequence(attempts).join(", ")}.`);

  const generatedAt = now().toISOString();
  const analysis: TokenAnalysis = {
    ...validated.analysis,
    metadata: {
      tokenId,
      provider: provider.displayName,
      model: attempt.servedModel ?? provider.model,
      requestedModel: provider.model,
      upstreamProvider: attempt.upstreamProvider,
      fallback,
      promptVersion: PROFILE_PROMPT_VERSION,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      contextVersion: payload.version,
      generatedAt,
      contextAsOf: payload.dataAsOf,
      contextHash: profilePayloadHash(payload),
      sources: profileSourceLabels(payload, validated.analysis),
      validation: validated.counters,
      validationWarnings: validated.warnings.length ? validated.warnings.slice(0, 20) : undefined,
      routing: {
        runId: diagnostics.runId,
        providerId: provider.id,
        freeTier: provider.freeTier.status,
        fallbackReason,
        attempts: attempts.map((item) => ({
          provider: item.providerId, model: item.model, action: item.action, skipReason: item.skipReason, category: item.category,
          httpStatus: item.httpStatus, latencyMs: item.latencyMs === null ? null : Math.round(item.latencyMs),
          inputTokens: item.usage?.inputTokens ?? null, outputTokens: item.usage?.outputTokens ?? null, reasoningTokens: item.usage?.reasoningTokens ?? null,
          validationPassed: item.validationPassed, validationViolations: item.validationViolations,
        })),
      },
    },
  };

  const { error: insertError } = await client.from("token_ai_analyses").insert({
    token_id: tokenId,
    chain_id: canonicalTokens.find((token) => token.id === tokenId)!.chainId,
    model: analysis.metadata.model,
    prompt_version: PROFILE_PROMPT_VERSION,
    schema_version: ANALYSIS_SCHEMA_VERSION,
    generated_at: generatedAt,
    context_as_of: payload.dataAsOf,
    context_hash: analysis.metadata.contextHash,
    analysis,
    validation: validated.counters,
  });
  if (insertError) {
    summarize("error", providerDetails);
    throw new Error(`Supabase store analysis failed: ${insertError.message}`);
  }

  summarize("ok", { ...providerDetails, validationViolations: 0 });
  return { ok: true, analysis, nextAllowedAt: nextAllowed(generatedAt)! };
}
