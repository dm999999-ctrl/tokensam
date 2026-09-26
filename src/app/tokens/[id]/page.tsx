import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TokenProfile } from "@/components/TokenProfile";
import { LiveDataUnavailable } from "@/components/LiveDataUnavailable";
import { AppShell } from "@/components/AppShell";
import { canonicalTokens } from "@/data/canonical-tokens";
import { getLiveTokenProfile, getSidebarMovers } from "@/lib/data/live-data";
import { getAnalysisState, type AnalysisState } from "@/lib/analysis/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Applies to the Deep AI Analysis Server Action invoked from this page: context build, up to two
// Gemini attempts (60 s each), and at most one OpenRouter fallback attempt (100 s).
export const maxDuration = 300;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const token = canonicalTokens.find((candidate) => candidate.id === id);
  return token ? { title: `${token.name} (${token.symbol})`, description: `${token.name} market data, fundamentals, and market structure on Token Samurai.` } : { title: "Page not found" };
}

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
  // Sidebar movers never throw (null hides the section), so they load alongside the profile.
  const moversRead = getSidebarMovers();
  let data;
  try {
    data = await getLiveTokenProfile(id);
  } catch (error) {
    console.error(`Live token profile load failed for ${id}:`, error);
    return <AppShell active="none" movers={await moversRead}><LiveDataUnavailable /></AppShell>;
  }
  if (!data) notFound();
  const [analysisState, movers] = await Promise.all([loadAnalysisState(id), moversRead]);
  const current = { id: data.token.id, name: data.token.name, symbol: data.token.symbol, logoUrl: data.logoUrl };
  return (
    <AppShell active="token" current={current} movers={movers}>
      <TokenProfile data={data} analysisState={analysisState} />
    </AppShell>
  );
}
