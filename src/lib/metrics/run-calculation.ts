import { CALCULATED_METRICS, calculateAllMetrics, type ObservationInput, type RawRecordInput, type TokenInput } from "./engine.ts";
import { mergeById, readLatestObservations, readLatestRawRecords, readObservationWindow } from "../data/observation-reads.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const PAGE_SIZE = 1000;
// The engine compares these series over time (latest vs previous / aligned
// windows); every other input only needs its latest observation. Observation
// history is append-only and grows with each automated refresh, so reads are
// bounded: latest row per metric plus a recent window for the series below.
export const SERIES_INPUTS = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "coingecko", metricId: "market_cap_usd" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "defillama", metricId: "revenue_24h_usd" },
  { providerId: "defillama", metricId: "fees_24h_usd" },
];
export const SERIES_LOOKBACK_DAYS = 14;

function throwOnError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

async function readTokens(client: SupabaseAdminClient): Promise<TokenInput[]> {
  const all: TokenInput[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("tokens").select("id,chain_id,name,symbol").order("id").range(offset, offset + PAGE_SIZE - 1);
    throwOnError(error, "read tokens");
    const page = (data ?? []) as TokenInput[];
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function readObservations(client: SupabaseAdminClient, tokenIds: string[], now: Date): Promise<ObservationInput[]> {
  const since = new Date(now.getTime() - SERIES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const [latest, history] = await Promise.all([
    readLatestObservations<ObservationInput>(client, tokenIds),
    readObservationWindow<ObservationInput>(client, tokenIds, SERIES_INPUTS, since),
  ]);
  return mergeById(latest, history).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id);
}

export async function runMetricsCalculation(client: SupabaseAdminClient, now = new Date()) {
  const { data: schemaProbe, error: schemaError } = await client
    .from("calculated_metric_observations")
    .select("metric_id")
    .limit(0);
  if (schemaError || schemaProbe === null) {
    throw new Error("Apply supabase/migrations/20260924100000_metrics_engine.sql in the Supabase SQL Editor before calculating metrics.");
  }

  const { data: definitions, error: definitionsError } = await client
    .from("calculated_metric_definitions")
    .select("id");
  throwOnError(definitionsError, "read calculated metric definitions");
  const known = new Set((definitions ?? []).map((row: { id: string }) => row.id));
  const missing = CALCULATED_METRICS.filter((metric) => !known.has(metric.id)).map((metric) => metric.id);
  if (missing.length) throw new Error("The calculated-metric catalog is incomplete; reapply the Phase 9 migration.");

  const tokens = await readTokens(client);
  const tokenIds = tokens.map((token) => token.id);
  const observations = await readObservations(client, tokenIds, now);
  const latestDexRaw = await readLatestRawRecords<RawRecordInput>(client, "dexscreener", "id,provider_id,token_id,chain_id,collected_at,endpoint_label,payload");

  const calculatedAt = now.toISOString();
  const rows = calculateAllMetrics(tokens, observations, latestDexRaw, calculatedAt);
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await client
      .from("calculated_metric_observations")
      .upsert(rows.slice(offset, offset + 500), { onConflict: "token_id,chain_id,metric_id,input_fingerprint" });
    throwOnError(error, "upsert calculated metric observations");
  }

  return {
    tokens: tokens.length,
    providerObservationsRead: observations.length,
    latestDexPairRecords: latestDexRaw.length,
    calculatedMetrics: rows.length,
    available: rows.filter((row) => row.status === "available").length,
    unavailable: rows.filter((row) => row.status === "unavailable").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
  };
}
