"use server";

import { generateDeterministicAnalysis, type EngineGenerateResult } from "../../../lib/analysis/deterministic-service.ts";
import { isCanonicalTokenId } from "../../../lib/analysis/research-context.ts";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin.ts";

/**
 * Generate the "AI Report" for one token: the deterministic Deep Analysis Engine
 * (../../../lib/analysis/engine/*) run over the current Token Profile data snapshot. No AI
 * provider is called and no API key is required — the report is a fresh, reproducible analysis of
 * the data itself, not a cascade of provider attempts. Nothing is persisted: the result returned
 * here is the only copy, scoped to the browser that requested it.
 *
 * Server Functions are reachable by direct POST, so this validates its only input against the
 * canonical token universe. The browser never sees anything beyond the validated report.
 */
export async function requestTokenAnalysis(tokenId: unknown): Promise<EngineGenerateResult> {
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };
  try {
    return await generateDeterministicAnalysis(createSupabaseAdminClient(), tokenId);
  } catch (error) {
    console.error(`AI report generation failed for ${tokenId}:`, error);
    return { ok: false, reason: "error", message: "The AI report could not be generated. Please try again later." };
  }
}
