import "server-only";

import { createSupabaseAdminClient } from "../supabase/admin.ts";
import { latestPerMetric, mergeById, readLatestObservations, readObservationWindow } from "./observation-reads.ts";
import { PROVIDER_STEPS, type ProviderStep, type RefreshStep } from "../refresh/config.ts";
import { buildRefreshStatus, type RefreshStatusView } from "../refresh/freshness.ts";
import { buildHistoricalSeries } from "./historical-series.ts";
import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { tokenCoverage } from "../../data/provider-coverage.ts";
import { SupabaseRefreshStore } from "../refresh/store.ts";
import type { HistoricalMetric, TokenHistoricalData } from "../../types/historical-data.ts";
import type {
  CalculatedMetricView,
  DashboardMetricKey,
  DashboardToken,
  LiveTokenProfileData,
  MetricSource,
} from "../../types/token.ts";

const OBSERVED_METRICS = [
  "price_usd", "price_change_24h_pct", "price_change_7d_pct", "market_cap_usd", "volume_24h_usd",
  "tvl_usd", "fees_24h_usd", "revenue_24h_usd", "circulating_supply", "total_supply", "maximum_supply",
];
const HISTORY_DAYS = 90;
const TVL_CHANGE_DAYS = 30;
const TVL_BASELINE_TOLERANCE_DAYS = 3;

type DbToken = {
  id: string;
  name: string;
  symbol: string;
  chain_id: string;
  contract_address: string | null;
  is_native: boolean;
  category: string;
  description: string | null;
};
type DbChain = { id: string; name: string };
type DbObservation = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: "coingecko" | "defillama" | "dexscreener" | "defillama_coins";
  value: number | string | null;
  status: string;
  observed_at: string;
  collected_at: string;
  source_field: string | null;
  note: string | null;
};
type DbCalculatedMetric = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  metric_name: string;
  unit: CalculatedMetricView["unit"];
  value: number | string | null;
  status: CalculatedMetricView["status"];
  formula: string;
  calculated_at: string;
  period_start_at: string | null;
  period_end_at: string | null;
  unavailable_reason?: string | null;
};
type DbCalculatedMetricDefinition = { id: string; category: CalculatedMetricView["category"]; source_scopes?: string | null };

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestFirst<T extends { observed_at: string; collected_at: string; id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at) || b.id - a.id);
}

function observationFor(
  rows: DbObservation[],
  tokenId: string,
  providerId: DbObservation["provider_id"],
  metricId: string,
): DbObservation | undefined {
  return latestFirst(rows.filter((row) => row.token_id === tokenId && row.provider_id === providerId && row.metric_id === metricId))[0];
}

function sourceFor(row: DbObservation | undefined): MetricSource | undefined {
  return row ? { providerId: row.provider_id, collectedAt: row.collected_at, note: row.note } : undefined;
}

function observationValue(row: DbObservation | undefined): number | null {
  if (!row || row.status !== "available") return null;
  return numberValue(row.value);
}

function thirtyDayTvlChange(rows: DbObservation[], tokenId: string): number | null {
  const allTvl = latestFirst(rows.filter((row) => row.token_id === tokenId
    && row.provider_id === "defillama" && row.metric_id === "tvl_usd"));
  if (allTvl[0]?.status !== "available") return null;
  const series = latestFirst(allTvl.filter((row) => row.status === "available"))
    .map((row) => ({ row, value: numberValue(row.value), time: Date.parse(row.observed_at) }))
    .filter((point): point is { row: DbObservation; value: number; time: number } => point.value !== null)
    .sort((a, b) => a.time - b.time);
  if (series.length < 2) return null;
  const latest = series.at(-1)!;
  const target = latest.time - TVL_CHANGE_DAYS * 24 * 60 * 60 * 1000;
  const tolerance = TVL_BASELINE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;
  const baseline = series
    .filter((point) => point.time <= target && target - point.time <= tolerance)
    .at(-1);
  if (!baseline || baseline.value <= 0) return null;
  const change = ((latest.value / baseline.value) - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

export function buildDashboardTokens(tokens: DbToken[], chains: DbChain[], observations: DbObservation[]): DashboardToken[] {
  const chainNames = new Map(chains.map((chain) => [chain.id, chain.name]));
  return tokens.map((token) => {
    const metricSources: Partial<Record<DashboardMetricKey, MetricSource>> = {};
    const valueFor = (metricId: string, providerId: DbObservation["provider_id"], key: DashboardMetricKey) => {
      const row = observationFor(observations, token.id, providerId, metricId);
      const source = sourceFor(row);
      if (source) metricSources[key] = source;
      return observationValue(row);
    };
    const tvlChange30dPct = thirtyDayTvlChange(observations, token.id);
    const latestTvl = observationFor(observations, token.id, "defillama", "tvl_usd");
    if (latestTvl) metricSources.tvlChange30dPct = {
      providerId: "calculated",
      collectedAt: latestTvl.collected_at,
      note: "Calculated server-side from DeFiLlama TVL observations approximately 30 days apart.",
    };
    const tokenRows = observations.filter((row) => row.token_id === token.id);
    const observedAt = tokenRows.map((row) => row.collected_at).sort().at(-1) ?? "";
    return {
      id: token.id,
      name: token.name,
      symbol: token.symbol,
      chain: chainNames.get(token.chain_id) ?? token.chain_id,
      category: token.category,
      priceUsd: valueFor("price_usd", "coingecko", "priceUsd"),
      change24hPct: valueFor("price_change_24h_pct", "coingecko", "change24hPct"),
      change7dPct: valueFor("price_change_7d_pct", "coingecko", "change7dPct"),
      marketCapUsd: valueFor("market_cap_usd", "coingecko", "marketCapUsd"),
      volume24hUsd: valueFor("volume_24h_usd", "coingecko", "volume24hUsd"),
      tvlUsd: valueFor("tvl_usd", "defillama", "tvlUsd"),
      tvlChange30dPct,
      fees24hUsd: valueFor("fees_24h_usd", "defillama", "fees24hUsd"),
      revenue24hUsd: valueFor("revenue_24h_usd", "defillama", "revenue24hUsd"),
      observedAt,
      metricSources,
    };
  });
}

/**
 * Chart series from actual stored observations only. Each series carries
 * per-period coverage (24H/7D/30D/90D windows ending at `now`), so the UI
 * reports what exists instead of implying a full period. Nothing is
 * interpolated, zero-filled, or synthesized.
 */
export function buildTokenHistory(
  tokenId: string,
  observations: DbObservation[],
  now = new Date(),
  options: { defiLlamaMapped?: boolean } = {},
): TokenHistoricalData {
  const cutoff = now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const definitions: { key: HistoricalMetric; metricId: string; providerId: "coingecko" | "defillama"; scope: "token" | "protocol"; unmappedReason?: string }[] = [
    { key: "priceUsd", metricId: "price_usd", providerId: "coingecko", scope: "token" },
    {
      key: "tvlUsd", metricId: "tvl_usd", providerId: "defillama", scope: "protocol",
      unmappedReason: "No curated DeFiLlama protocol mapping exists for this token, so protocol TVL is unavailable by design.",
    },
    { key: "volumeUsd", metricId: "volume_24h_usd", providerId: "coingecko", scope: "token" },
  ];
  const sources: TokenHistoricalData["sources"] = {};
  const series = Object.fromEntries(definitions.map(({ key, metricId, providerId, scope, unmappedReason }) => {
    const rows = observations.filter((row) => row.token_id === tokenId && row.metric_id === metricId
      && row.provider_id === providerId && row.status === "available" && Date.parse(row.observed_at) >= cutoff)
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id);
    const source = sourceFor(rows.at(-1));
    if (source) sources[key] = source;
    const points = rows.map((row) => ({ timestamp: new Date(row.observed_at).toISOString(), valueUsd: numberValue(row.value), sourceId: `obs:${row.id}` }))
      .filter((point): point is { timestamp: string; valueUsd: number; sourceId: string } => point.valueUsd !== null);
    const reason = providerId === "defillama" && options.defiLlamaMapped === false && unmappedReason
      ? unmappedReason
      : `No stored ${providerId === "coingecko" ? "CoinGecko" : "DeFiLlama"} observations in the last ${HISTORY_DAYS} days.`;
    return [key, buildHistoricalSeries({ metric: key, providerId, scope, points, asOf: now, unavailableReason: reason })];
  })) as Pick<TokenHistoricalData, "priceUsd" | "tvlUsd" | "volumeUsd">;
  const observedAt = observations.filter((row) => row.token_id === tokenId)
    .map((row) => row.observed_at).sort().at(-1) ?? now.toISOString();
  return { tokenId, asOf: now.toISOString(), observedAt, sources, ...series };
}

export function buildCalculatedMetrics(rows: DbCalculatedMetric[], definitions: DbCalculatedMetricDefinition[]): CalculatedMetricView[] {
  const scopes = new Map(definitions.map((definition) => [definition.id, definition.source_scopes ?? null]));
  const categories = new Map(definitions.map((definition) => [definition.id, definition.category]));
  const latest = new Map<string, DbCalculatedMetric>();
  for (const row of [...rows].sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    if (!latest.has(row.metric_id)) latest.set(row.metric_id, row);
  }
  const categoryOrder = ["valuation", "growth", "market_structure", "divergence"];
  return [...latest.values()]
    .filter((row) => categories.has(row.metric_id))
    .map((row) => ({ row, category: categories.get(row.metric_id)! }))
    .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.row.metric_name.localeCompare(b.row.metric_name))
    .map(({ row, category }) => ({
      id: row.metric_id,
      name: row.metric_name,
      category,
      unit: row.unit,
      value: row.status === "available" ? numberValue(row.value) : null,
      status: row.status,
      formula: row.formula,
      calculatedAt: row.calculated_at,
      periodStartAt: row.period_start_at,
      periodEndAt: row.period_end_at,
      unavailableReason: row.status === "available" ? null : row.unavailable_reason ?? null,
      sourceScopes: scopes.get(row.metric_id) ?? null,
    }));
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_SERIES = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "coingecko", metricId: "volume_24h_usd" },
];

/** Latest value per displayed metric; history only where a view needs it. */
async function readLatest(client: SupabaseAdminClient, tokenIds: string[]): Promise<DbObservation[]> {
  const rows = await readLatestObservations<DbObservation>(client, tokenIds);
  return rows.filter((row) => OBSERVED_METRICS.includes(row.metric_id));
}

async function readRefreshStatus(client: SupabaseAdminClient, latestRows: DbObservation[], now = new Date()): Promise<RefreshStatusView> {
  const latestCollected: Partial<Record<ProviderStep, string>> = {};
  for (const row of latestRows) {
    const provider = row.provider_id as ProviderStep;
    if (PROVIDER_STEPS.includes(provider) && (!latestCollected[provider] || row.collected_at > latestCollected[provider]!)) {
      latestCollected[provider] = row.collected_at;
    }
  }
  let lastSuccess: Partial<Record<RefreshStep, string>> = {};
  let latestRunStatus: string | null = null;
  try {
    const store = new SupabaseRefreshStore(client);
    const [steps, run] = await Promise.all([store.lastSuccessfulSteps(), store.latestRun()]);
    lastSuccess = steps;
    latestRunStatus = run?.status ?? null;
  } catch {
    // Refresh-status tables arrive with the Phase 11B migration; until then,
    // freshness falls back to stored collection times.
  }
  return buildRefreshStatus({ lastSuccess, latestCollected, latestRunStatus, now });
}

export async function getLiveDashboardData(): Promise<{ tokens: DashboardToken[]; error: string | null; refreshStatus: RefreshStatusView | null }> {
  try {
    const client = createSupabaseAdminClient();
    const [tokenResult, chainResult] = await Promise.all([
      client.from("tokens").select("id,name,symbol,chain_id,contract_address,is_native,category,description").order("name"),
      client.from("chains").select("id,name"),
    ]);
    if (tokenResult.error) throw tokenResult.error;
    if (chainResult.error) throw chainResult.error;
    const tokens = (tokenResult.data ?? []) as DbToken[];
    if (tokens.length === 0) throw new Error("Canonical token registry is empty.");
    const tokenIds = tokens.map((token) => token.id);
    // 30-day TVL change needs DeFiLlama TVL around 30 days ago (plus baseline tolerance).
    const tvlSince = new Date(Date.now() - (TVL_CHANGE_DAYS + TVL_BASELINE_TOLERANCE_DAYS + 1) * DAY_MS);
    const [latest, tvlHistory] = await Promise.all([
      readLatest(client, tokenIds),
      readObservationWindow<DbObservation>(client, tokenIds, [{ providerId: "defillama", metricId: "tvl_usd" }], tvlSince),
    ]);
    const refreshStatus = await readRefreshStatus(client, latest);
    return {
      tokens: buildDashboardTokens(tokens, (chainResult.data ?? []) as DbChain[], mergeById(latest, tvlHistory)),
      error: null,
      refreshStatus,
    };
  } catch (error) {
    console.error("Live dashboard data load failed:", error);
    return { tokens: [], error: "Live data is temporarily unavailable. No demo data is being shown.", refreshStatus: null };
  }
}

export async function getLiveTokenProfile(tokenId: string): Promise<LiveTokenProfileData | null> {
  const client = createSupabaseAdminClient();
  const { data: tokenData, error: tokenError } = await client.from("tokens")
    .select("id,name,symbol,chain_id,contract_address,is_native,category,description")
    .eq("id", tokenId).maybeSingle();
  if (tokenError) throw tokenError;
  if (!tokenData) return null;
  const tokenRow = tokenData as DbToken;
  const [chainResult, observations, calculatedResult, definitionResult, mappingResult] = await Promise.all([
    client.from("chains").select("id,name").eq("id", tokenRow.chain_id).maybeSingle(),
    readLatest(client, [tokenId]).then(async (latest) => mergeById(latest,
      await readObservationWindow<DbObservation>(client, [tokenId], HISTORY_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS)))),
    client.from("calculated_metric_observations")
      .select("id,token_id,chain_id,metric_id,metric_name,unit,value,status,formula,calculated_at,period_start_at,period_end_at,unavailable_reason:provenance->>unavailable_reason")
      .eq("token_id", tokenId).order("calculated_at", { ascending: false }).order("id", { ascending: false }).range(0, 999),
    client.from("calculated_metric_definitions").select("id,category,source_scopes"),
    client.from("provider_token_mappings").select("provider_id").eq("token_id", tokenId),
  ]);
  if (chainResult.error) throw chainResult.error;
  if (calculatedResult.error) throw calculatedResult.error;
  if (definitionResult.error) throw definitionResult.error;
  if (mappingResult.error) throw mappingResult.error;
  const chain = chainResult.data as DbChain | null;
  const token = buildDashboardTokens([tokenRow], chain ? [chain] : [], observations)[0];
  const metricSources: Record<string, MetricSource> = {};
  const sourceMetric = (metricId: string, provider: DbObservation["provider_id"]) => {
    const source = sourceFor(observationFor(observations, tokenId, provider, metricId));
    if (source) metricSources[metricId] = source;
    return observationValue(observationFor(observations, tokenId, provider, metricId));
  };
  const notes = [...new Set(observations
    .filter((row) => row.token_id === tokenId && row.note)
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at))
    .slice(0, 8)
    .map((row) => row.note as string))];
  const mappings = (mappingResult.data ?? []) as { provider_id: string }[];
  const calc = buildCalculatedMetrics(
    (calculatedResult.data ?? []) as DbCalculatedMetric[],
    (definitionResult.data ?? []) as DbCalculatedMetricDefinition[],
  );
  // Freshness comes from the latest row per metric; backfilled history is collected later but is older data.
  const latestCollection = latestPerMetric(observations).map((row) => row.collected_at).sort().at(-1);
  if (latestCollection) metricSources.snapshot = { providerId: "calculated", collectedAt: latestCollection };
  const refreshStatus = await readRefreshStatus(client, observations);
  const canonicalToken = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const tokenLevelPriceRow = observationFor(observations, tokenId, "defillama_coins", "price_usd");
  return {
    token,
    description: tokenRow.description,
    contractAddress: tokenRow.contract_address,
    isNative: tokenRow.is_native,
    circulatingSupply: sourceMetric("circulating_supply", "coingecko"),
    totalSupply: sourceMetric("total_supply", "coingecko"),
    maximumSupply: sourceMetric("maximum_supply", "coingecko"),
    metricSources,
    calculatedMetrics: calc,
    history: buildTokenHistory(tokenId, observations, new Date(), { defiLlamaMapped: mappings.some((mapping) => mapping.provider_id === "defillama") }),
    dataNotes: notes,
    dexMapped: mappings.some((mapping) => mapping.provider_id === "dexscreener"),
    defiLlamaMapped: mappings.some((mapping) => mapping.provider_id === "defillama"),
    refreshStatus,
    coverage: canonicalToken ? tokenCoverage(canonicalToken) : [],
    tokenLevelPrice: tokenLevelPriceRow && tokenLevelPriceRow.status === "available" && numberValue(tokenLevelPriceRow.value) !== null
      ? { value: numberValue(tokenLevelPriceRow.value) as number, observedAt: tokenLevelPriceRow.observed_at, identifier: (tokenLevelPriceRow as { provider_asset_id?: string | null }).provider_asset_id ?? null, note: tokenLevelPriceRow.note }
      : null,
  };
}

export function latestDashboardUpdate(tokens: DashboardToken[]): string | null {
  return tokens.flatMap((token) => Object.values(token.metricSources ?? {}).map((source) => source?.collectedAt ?? ""))
    .filter(Boolean).sort().at(-1) ?? null;
}
