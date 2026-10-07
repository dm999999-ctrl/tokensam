import "server-only";

/**
 * "Generate AI Report" — the live implementation. Builds the same canonical Token Profile payload
 * the page and "Copy data" use, runs it through the deterministic Deep Analysis Engine
 * (analysis/engine/*), and stores the result in the same `token_ai_analyses` table the earlier
 * AI-provider-generated reports used. No AI provider is called, no API key is required, and there
 * is no fallback cascade: this path either succeeds from the current data snapshot or fails
 * because that snapshot itself is unavailable (unknown token / storage not migrated).
 *
 * The AI-provider cascade this replaces (./service.ts and everything under ./ai/) is left fully
 * intact and fully tested on disk for a possible future optional AI narrative-enhancement feature;
 * this module has no import of it at all (its own `EngineAnalysisState`/`EngineGenerateResult`
 * types and report-schema.ts's own contract are fully independent of it), so nothing here can reach
 * a provider.
 */

import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { getLiveTokenProfileForAnalysis } from "../data/live-data.ts";
import type { LiveTokenProfileData } from "../../types/token.ts";
import { ANALYSIS_VERSION, ENGINE_VERSION, buildEngineReport } from "./engine/report.ts";
import { parseStoredEngineAnalysis, type EngineTokenAnalysis } from "./engine/report-schema.ts";
import { buildProfilePayload } from "./profile-payload.ts";
import { profilePayloadHash } from "./profile-evidence.ts";
import { isCanonicalTokenId } from "./research-context.ts";
import { AnalysisValidationError } from "./schema.ts";

/** v3: institutional-research report contract (report-schema.ts), distinct from the legacy ../schema.ts's ANALYSIS_SCHEMA_VERSION. */
export const ENGINE_SCHEMA_VERSION = "3";

export type EngineAnalysisState =
  | { status: "storage_unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; model: string; latest: EngineTokenAnalysis | null; nextAllowedAt: string | null };

export type EngineGenerateResult =
  | { ok: true; analysis: EngineTokenAnalysis; nextAllowedAt: string }
  | { ok: false; reason: "invalid_token" | "storage_unavailable" | "cooldown" | "rate_limited" | "error"; message: string; nextAllowedAt?: string | null };

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** Shown in place of a provider/model name: this path has neither. */
export const DETERMINISTIC_ENGINE_NAME = "Token Samurai Deep Analysis Engine";
/**
 * Regeneration here is a local computation over already-fetched data (no external call, no
 * provider credit), so this cooldown only bounds repeated DB writes from a public page — it is
 * not rationing an expensive resource the way the old AI cascade's cooldown was.
 */
export const DETERMINISTIC_COOLDOWN_MS = 60 * 1000;
export const DETERMINISTIC_HOURLY_LIMIT = 120;

const STORAGE_MESSAGE = "The AI report is unavailable: its storage table has not been set up. Apply supabase/migrations/20260926090000_token_ai_analyses.sql.";

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
  return new Date(Date.parse(generatedAt) + DETERMINISTIC_COOLDOWN_MS).toISOString();
}

/** Only an active cooldown is reported, so the UI need not compare clocks while rendering. */
function activeCooldown(generatedAt: string | null | undefined, now: Date): string | null {
  const allowedAt = nextAllowed(generatedAt);
  return allowedAt && Date.parse(allowedAt) > now.getTime() ? allowedAt : null;
}

/**
 * Page-load state: reads the stored report only, never runs the engine. Unlike the old AI
 * cascade's state function, this is never "unconfigured" — the engine needs no provider, no API
 * key, and no environment variable, so it is "ready" whenever the storage table itself is reachable.
 */
export async function getDeterministicAnalysisState(client: SupabaseAdminClient, tokenId: string, now = new Date()): Promise<EngineAnalysisState> {
  if (!isCanonicalTokenId(tokenId)) return { status: "ready", model: DETERMINISTIC_ENGINE_NAME, latest: null, nextAllowedAt: null };
  try {
    const row = await readLatestRow(client, tokenId);
    return { status: "ready", model: DETERMINISTIC_ENGINE_NAME, latest: row ? parseStoredEngineAnalysis(row.analysis) : null, nextAllowedAt: activeCooldown(row?.generated_at, now) };
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { status: "storage_unavailable", message: STORAGE_MESSAGE };
    throw error;
  }
}

export async function generateDeterministicAnalysis(
  client: SupabaseAdminClient,
  tokenId: unknown,
  options: {
    now?: () => Date;
    /** Loads the Token Profile data (defaults to the page's own loader through `client`). */
    loadProfile?: (tokenId: string) => Promise<LiveTokenProfileData | null>;
  } = {},
): Promise<EngineGenerateResult> {
  const now = options.now ?? (() => new Date());
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };

  // Cooldown and hourly cap are enforced from stored generations, exactly like the old path, so
  // this new path cannot be used to write to the table faster than the old one could.
  let latestGeneratedAt: string | null;
  try {
    latestGeneratedAt = (await readLatestRow(client, tokenId))?.generated_at ?? null;
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { ok: false, reason: "storage_unavailable", message: STORAGE_MESSAGE };
    throw error;
  }
  const allowedAt = nextAllowed(latestGeneratedAt);
  if (allowedAt && Date.parse(allowedAt) > now().getTime()) {
    return { ok: false, reason: "cooldown", message: "A report for this token was generated recently. Regeneration will be available shortly.", nextAllowedAt: allowedAt };
  }
  const { count, error: countError } = await client.from("token_ai_analyses")
    .select("id", { count: "exact", head: true })
    .gte("generated_at", new Date(now().getTime() - 60 * 60 * 1000).toISOString());
  if (countError) throw new Error(`Supabase count recent analyses failed: ${countError.message}`);
  if ((count ?? 0) >= DETERMINISTIC_HOURLY_LIMIT) {
    return { ok: false, reason: "rate_limited", message: "The hourly report limit has been reached. Please try again later." };
  }

  // The engine's input is the data the Token Profile page shows: the same loader and the same
  // display functions produce one canonical payload (also used by the page's "Copy data").
  // getLiveTokenProfileForAnalysis, not getLiveTokenProfile: this engine is
  // deterministic and must never make an external network call of any kind, and must
  // not share the page-render cache either (see that function's doc comment).
  const profile = await (options.loadProfile ?? ((id: string) => getLiveTokenProfileForAnalysis(id, client)))(tokenId);
  if (!profile) return { ok: false, reason: "invalid_token", message: "Unknown token." };
  const payload = buildProfilePayload(profile);

  let built: ReturnType<typeof buildEngineReport>;
  try {
    built = buildEngineReport(payload);
  } catch (error) {
    if (error instanceof AnalysisValidationError) {
      // Every fact the engine writes is grounded by construction, so this indicates a bug in the
      // engine itself, not bad input data — still handled without throwing through the server action.
      console.error(`Deep Analysis Engine produced an invalid report for ${tokenId}: ${error.message}`);
      return { ok: false, reason: "error", message: "The AI report could not be generated. Please try again later." };
    }
    throw error;
  }

  const generatedAt = now().toISOString();
  const promptVersion = `engine-${ANALYSIS_VERSION}`;
  const analysis: EngineTokenAnalysis = {
    ...built.analysis,
    metadata: {
      tokenId,
      provider: DETERMINISTIC_ENGINE_NAME,
      model: DETERMINISTIC_ENGINE_NAME,
      promptVersion,
      schemaVersion: ENGINE_SCHEMA_VERSION,
      contextVersion: payload.version,
      generatedAt,
      contextAsOf: payload.dataAsOf,
      contextHash: profilePayloadHash(payload),
      sources: built.sources,
      validation: built.counters,
      validationWarnings: built.warnings.length ? built.warnings.slice(0, 20) : undefined,
      engineVersion: ENGINE_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      dataSnapshotAt: built.dataSnapshotAt,
      regime: built.regime,
      regimeConfidence: built.regimeConfidence,
    },
  };

  const { error: insertError } = await client.from("token_ai_analyses").insert({
    token_id: tokenId,
    chain_id: canonicalTokens.find((token) => token.id === tokenId)!.chainId,
    model: analysis.metadata.model,
    prompt_version: promptVersion,
    schema_version: ENGINE_SCHEMA_VERSION,
    generated_at: generatedAt,
    context_as_of: payload.dataAsOf,
    context_hash: analysis.metadata.contextHash,
    analysis,
    validation: built.counters,
  });
  if (insertError) throw new Error(`Supabase store analysis failed: ${insertError.message}`);

  return { ok: true, analysis, nextAllowedAt: nextAllowed(generatedAt)! };
}
