import "server-only";

/**
 * "Generate AI Report" — the live implementation. Builds the same canonical Token Profile payload
 * the page and "Copy data" use, and runs it through the deterministic Deep Analysis Engine
 * (analysis/engine/*). No AI provider is called, no API key is required, and there is no fallback
 * cascade: this path either succeeds from the current data snapshot or fails because that snapshot
 * itself is unavailable (unknown token).
 *
 * Deliberately stateless: nothing is written to any table. Each call recomputes the report fresh
 * from the current live data and returns it straight to the requesting browser, so the report is
 * private to whoever generated it (never shown to another visitor of the same token page), is never
 * persisted (a page refresh clears it, and generating it again produces a fresh computation, not a
 * cached one), and needs no cooldown or storage-availability handling — the computation itself has
 * no external cost to ration.
 *
 * The AI-provider cascade this replaces (./service.ts and everything under ./ai/) is left fully
 * intact and fully tested on disk for a possible future optional AI narrative-enhancement feature;
 * this module has no import of it at all (its own `EngineGenerateResult` type and report-schema.ts's
 * own contract are fully independent of it), so nothing here can reach a provider.
 */

import { getLiveTokenProfileForAnalysis } from "../data/live-data.ts";
import type { LiveTokenProfileData } from "../../types/token.ts";
import { ANALYSIS_VERSION, ENGINE_VERSION, buildEngineReport } from "./engine/report.ts";
import type { EngineTokenAnalysis } from "./engine/report-schema.ts";
import { buildProfilePayload } from "./profile-payload.ts";
import { profilePayloadHash } from "./profile-evidence.ts";
import { isCanonicalTokenId } from "./research-context.ts";
import { AnalysisValidationError } from "./schema.ts";

/** v3: institutional-research report contract (report-schema.ts), distinct from the legacy ../schema.ts's ANALYSIS_SCHEMA_VERSION. */
export const ENGINE_SCHEMA_VERSION = "3";

export type EngineGenerateResult =
  | { ok: true; analysis: EngineTokenAnalysis }
  | { ok: false; reason: "invalid_token" | "error"; message: string };

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** Shown in place of a provider/model name: this path has neither. */
export const DETERMINISTIC_ENGINE_NAME = "Token Samurai Deep Analysis Engine";

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

  const analysis: EngineTokenAnalysis = {
    ...built.analysis,
    metadata: {
      tokenId,
      provider: DETERMINISTIC_ENGINE_NAME,
      model: DETERMINISTIC_ENGINE_NAME,
      promptVersion: `engine-${ANALYSIS_VERSION}`,
      schemaVersion: ENGINE_SCHEMA_VERSION,
      contextVersion: payload.version,
      generatedAt: now().toISOString(),
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

  return { ok: true, analysis };
}
