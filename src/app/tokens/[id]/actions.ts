"use server";

import { generateTokenAnalysis, type GenerateResult } from "../../../lib/analysis/service.ts";
import { isCanonicalTokenId } from "../../../lib/analysis/research-context.ts";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin.ts";

/**
 * Generate (or regenerate) the Deep AI Analysis for one token.
 *
 * Server Functions are reachable by direct POST, so this validates its only
 * input against the canonical token universe; the cooldown and hourly cap in
 * the service bound Gemini usage. The browser never sees the API key, the
 * prompt, or the research context, only the validated analysis.
 */
export async function requestTokenAnalysis(tokenId: unknown): Promise<GenerateResult> {
  if (!isCanonicalTokenId(tokenId)) return { ok: false, reason: "invalid_token", message: "Unknown token." };
  try {
    return await generateTokenAnalysis(createSupabaseAdminClient(), tokenId);
  } catch (error) {
    console.error(`Deep AI Analysis failed for ${tokenId}:`, error);
    return { ok: false, reason: "error", message: "The AI analysis could not be generated. Please try again later." };
  }
}
