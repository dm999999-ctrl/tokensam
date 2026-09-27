"use server";

import { generateDeterministicAnalysis } from "../../../lib/analysis/deterministic-service.ts";
import type { GenerateResult } from "../../../lib/analysis/service.ts";
import { isCanonicalTokenId } from "../../../lib/analysis/research-context.ts";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin.ts";

/**
 * Generate (or regenerate) the "AI Report" for one token: the deterministic Deep Analysis Engine
 * (../../../lib/analysis/engine/*) run over the current Token Profile data snapshot. No AI
 * provider is called and no API key is required — the report is a fresh, reproducible analysis of
 * the data itself, not a cascade of provider attempts.
 *
 * Server Functions are reachable by direct POST, so this validates its only input against the
 * canonical token universe; the cooldown and hourly cap in the service bound repeated DB writes
 * from a public page. The browser never sees anything beyond the validated report.
 */
export async function requestTokenAnalysis(tokenId: unknown): Promise<GenerateResult> {
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };
  try {
    return await generateDeterministicAnalysis(createSupabaseAdminClient(), tokenId);
  } catch (error) {
    console.error(`AI report generation failed for ${tokenId}:`, error);
    return { ok: false, reason: "error", message: "The AI report could not be generated. Please try again later." };
  }
}
