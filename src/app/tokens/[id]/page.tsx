import { notFound } from "next/navigation";
import { TokenProfile } from "@/components/TokenProfile";
import { LiveDataUnavailable } from "@/components/LiveDataUnavailable";
import { getLiveTokenProfile } from "@/lib/data/live-data";
import { getAnalysisState, type AnalysisState } from "@/lib/analysis/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Applies to the Deep AI Analysis Server Action invoked from this page: context build, up to two
// Gemini attempts (60 s each), and at most one OpenRouter fallback attempt (100 s).
export const maxDuration = 300;

async function loadAnalysisState(id: string): Promise<AnalysisState> {
  try {
    return await getAnalysisState(createSupabaseAdminClient(), id);
  } catch (error) {
    // The analysis panel must never break the profile.
    console.error(`Deep AI Analysis state load failed for ${id}:`, error);
    return { status: "error", message: "The stored AI analysis could not be loaded." };
  }
}

export default async function TokenProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data;
  try {
    data = await getLiveTokenProfile(id);
  } catch (error) {
    console.error(`Live token profile load failed for ${id}:`, error);
    return <LiveDataUnavailable />;
  }
  if (!data) notFound();
  const analysisState = await loadAnalysisState(id);
  return <TokenProfile data={data} analysisState={analysisState} />;
}
