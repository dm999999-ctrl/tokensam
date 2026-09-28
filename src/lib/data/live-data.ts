import "server-only";

import { createSupabaseAdminClient } from "../supabase/admin.ts";
import { OBSERVATION_COLUMNS, latestPerMetric, mergeById, readLatestObservations, readObservationWindow } from "./observation-reads.ts";
import { selectMovers, type Movers } from "../ui/movers.ts";
import { buildTechnicalIndicators, INDICATOR_METHOD, withExtraIndicators } from "../indicators/build.ts";
import { buildConcentrationIndicators } from "../indicators/onchain-concentration.ts";
import type { TechnicalIndicatorsView } from "../../types/technical-indicators.ts";
import { PROVIDER_STEPS, type ProviderStep, type RefreshStep } from "../refresh/config.ts";
import { buildDatasetFreshness, buildRefreshStatus, type RefreshStatusView } from "../refresh/freshness.ts";
import { buildHistoricalSeries } from "./historical-series.ts";
import { sevenDayVolume, sevenDayVolumeBands, type VolumePoint } from "./seven-day-volume.ts";
import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { tokenCoverage } from "../../data/provider-coverage.ts";
import { SupabaseRefreshStore } from "../refresh/store.ts";
import { COINGECKO_MARKETS_ENDPOINT, logosFromRecords, reportedFdvFromRecords, type LogoRecord, type MarketFieldRecord } from "./token-logos.ts";
import type { HistoricalMetric, TokenHistoricalData } from "../../types/historical-data.ts";
import {
  DASHBOARD_CALCULATED_METRICS,
  type CalculatedMetricView,
  type DashboardCalculatedKey,
  type DashboardMetricKey,
  type DashboardToken,
  type LiveTokenProfileData,
  type MetricSource,
  type OnchainMarketsData,
} from "../../types/token.ts";

const OBSERVED_METRICS = [
  "price_usd", "price_change_24h_pct", "price_change_7d_pct", "market_cap_usd", "volume_24h_usd",
  "tvl_usd", "fees_24h_usd", "revenue_24h_usd", "circulating_supply", "total_supply", "maximum_supply",
  // DEX Screener exact-address transaction counts (market scope), shown in Market Structure.
  "transactions_24h_count", "buys_24h_count", "sells_24h_count",
];
/** Dashboard calculated metrics that need an associated protocol / a DEX mapping to be meaningful. */
const PROTOCOL_DEPENDENT: DashboardCalculatedKey[] = ["market_cap_to_tvl", "market_cap_to_revenue_24h"];
const DEX_DEPENDENT: DashboardCalculatedKey[] = [
  "dex_aggregate_liquidity_usd", "dex_aggregate_volume_24h_usd", "dex_aggregate_liquidity_to_market_cap_pct",
  "dex_volume_to_liquidity", "dex_buy_sell_ratio",
];
/** Rows of the newest metrics run are read within this span of its newest calculated_at. */
const CALCULATION_RUN_SPAN_MS = 2 * 60 * 60 * 1000;
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
  provider_id: "coingecko" | "defillama" | "dexscreener" | "defillama_coins" | "geckoterminal";
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
      fdvUsd: null,
      circulatingSupply: valueFor("circulating_supply", "coingecko", "circulatingSupply"),
      maximumSupply: valueFor("maximum_supply", "coingecko", "maximumSupply"),
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
    { key: "marketCapUsd", metricId: "market_cap_usd", providerId: "coingecko", scope: "token" },
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
  })) as Pick<TokenHistoricalData, "priceUsd" | "tvlUsd" | "volumeUsd" | "marketCapUsd">;
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
  { providerId: "coingecko", metricId: "market_cap_usd" },
];
/** Extra history read only for technical indicators (price, volume, market cap and TVL come from HISTORY_SERIES). */
const INDICATOR_EXTRA_SERIES = [{ providerId: "coingecko", metricId: "circulating_supply" }];
/**
 * GeckoTerminal's own normalized aggregates (market scope, exact-address only):
 * liquidity_usd is its most liquid pool's reserve, volume_24h_usd is summed
 * across every matched pool, mirroring the DEX Screener normalizer's semantics
 * but from GeckoTerminal's own pool coverage and snapshot time.
 */
const GECKO_TERMINAL_SERIES = [
  { providerId: "geckoterminal", metricId: "liquidity_usd" },
  { providerId: "geckoterminal", metricId: "volume_24h_usd" },
  { providerId: "geckoterminal", metricId: "price_change_24h_pct" },
  { providerId: "geckoterminal", metricId: "fdv_usd" },
  { providerId: "geckoterminal", metricId: "market_cap_usd" },
];

type DbCalculatedValue = {
  id: number;
  token_id: string;
  metric_id: string;
  value: number | string | null;
  status: CalculatedMetricView["status"];
  calculated_at: string;
};

/** Latest stored value per token for each dashboard calculated metric; unavailable/invalid stay null. */
export function latestCalculatedValues(rows: DbCalculatedValue[]): Map<string, Partial<Record<DashboardCalculatedKey, number | null>>> {
  const known = new Set<string>(DASHBOARD_CALCULATED_METRICS);
  const seen = new Set<string>();
  const byToken = new Map<string, Partial<Record<DashboardCalculatedKey, number | null>>>();
  for (const row of [...rows].sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    const key = `${row.token_id}|${row.metric_id}`;
    if (!known.has(row.metric_id) || seen.has(key)) continue;
    seen.add(key);
    const values = byToken.get(row.token_id) ?? {};
    values[row.metric_id as DashboardCalculatedKey] = row.status === "available" ? numberValue(row.value) : null;
    byToken.set(row.token_id, values);
  }
  return byToken;
}

/**
 * Presentation extras for dashboard rows: logo, stored calculated values, and
 * coverage. Protocol- and DEX-dependent values are kept only when the curated
 * mapping exists, so no unmapped (e.g. wrapped-proxy) value can surface.
 */
export function attachDashboardExtras(
  tokens: DashboardToken[],
  extras: {
    logos: Record<string, string>;
    calculated: Map<string, Partial<Record<DashboardCalculatedKey, number | null>>>;
    fdv?: Record<string, { value: number; collectedAt: string }>;
    /** 7D volume (sum of seven non-overlapping 24-hour observations); absent = unavailable. */
    volume7d?: Record<string, number>;
  },
): DashboardToken[] {
  return tokens.map((token) => {
    const canonical = canonicalTokens.find((candidate) => candidate.id === token.id);
    const coverage = canonical ? tokenCoverage(canonical) : [];
    const protocolMapped = coverage.some((item) => item.provider === "defillama" && item.status === "mapped");
    const dexMapped = coverage.some((item) => item.provider === "dexscreener" && item.status === "mapped");
    const stored = extras.calculated.get(token.id) ?? {};
    const calculated: Partial<Record<DashboardCalculatedKey, number | null>> = {};
    for (const key of DASHBOARD_CALCULATED_METRICS) {
      const allowed = (!PROTOCOL_DEPENDENT.includes(key) || protocolMapped) && (!DEX_DEPENDENT.includes(key) || dexMapped);
      calculated[key] = allowed ? stored[key] ?? null : null;
    }
    const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);
    const fdv = extras.fdv?.[token.id] ?? null;
    return {
      ...token,
      fdvUsd: fdv?.value ?? null,
      volume7dUsd: extras.volume7d?.[token.id] ?? null,
      metricSources: fdv
        ? { ...token.metricSources, fdvUsd: { providerId: "coingecko", collectedAt: fdv.collectedAt, note: "Token-level FDV as reported in the stored market-data record." } }
        : token.metricSources,
      logoUrl: extras.logos[token.id] ?? null,
      calculated,
      coverage: {
        isNative: canonical?.isNative ?? false,
        protocolMapped,
        dexMapped,
        hasProtocolData: protocolMapped && [token.tvlUsd, token.fees24hUsd, token.revenue24hUsd].some(valid),
        hasDexData: dexMapped && DEX_DEPENDENT.some((key) => valid(calculated[key])),
      },
    };
  });
}

/**
 * 7D volume per token from stored CoinGecko 24-hour volume observations (see
 * seven-day-volume.ts). Reads only the seven narrow bands around each token's
 * latest volume observation; optional, so a failed read leaves 7D volume
 * unavailable rather than failing the dashboard.
 */
async function readSevenDayVolumes(client: SupabaseAdminClient, latest: DbObservation[]): Promise<Record<string, number>> {
  try {
    const anchors = latest
      .filter((row) => row.provider_id === "coingecko" && row.metric_id === "volume_24h_usd")
      .map((row) => ({ tokenId: row.token_id, observedAt: row.observed_at }));
    const bandRows = await Promise.all(sevenDayVolumeBands(anchors).map(async (band) => {
      const rows: (VolumePoint & { id: number; token_id: string })[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await client.from("token_metric_observations")
          .select("id,token_id,value,status,observed_at")
          .eq("provider_id", "coingecko").eq("metric_id", "volume_24h_usd").in("token_id", band.tokenIds)
          .is("excluded_reason", null).gte("observed_at", band.from).lte("observed_at", band.to)
          .order("id", { ascending: true }).range(offset, offset + 999);
        if (error) throw error;
        rows.push(...((data ?? []) as (VolumePoint & { id: number; token_id: string })[]));
        if ((data ?? []).length < 1000) return rows;
      }
    }));
    const byToken = new Map<string, VolumePoint[]>();
    for (const row of mergeById(...bandRows)) byToken.set(row.token_id, [...(byToken.get(row.token_id) ?? []), row]);
    const result: Record<string, number> = {};
    for (const [tokenId, points] of byToken) {
      const volume = sevenDayVolume(points);
      if (volume) result[tokenId] = volume.valueUsd;
    }
    return result;
  } catch (error) {
    console.error("7D volume read failed (shown as unavailable):", error);
    return {};
  }
}

/** Token-level FDV from the latest stored /coins/markets payloads; optional, so a failed read leaves FDV unavailable. */
async function readReportedFdv(client: SupabaseAdminClient, tokenIds: string[]): Promise<Record<string, { value: number; collectedAt: string }>> {
  try {
    const { data, error } = await client.from("latest_raw_provider_records")
      .select("token_id,collected_at,endpoint_label,payload_id:payload->>id,fdv:payload->fully_diluted_valuation")
      .eq("provider_id", "coingecko").in("token_id", tokenIds);
    if (error) throw error;
    return reportedFdvFromRecords((data ?? []) as unknown as MarketFieldRecord[]);
  } catch (error) {
    console.error("Reported FDV read failed (FDV shown as unavailable):", error);
    return {};
  }
}

/** Logos from stored CoinGecko /coins/markets payloads; cosmetic, so failures yield no logos. */
async function readTokenLogos(client: SupabaseAdminClient, tokenIds: string[]): Promise<Record<string, string>> {
  const columns = "token_id,collected_at,endpoint_label,image:payload->>image,payload_id:payload->>id";
  const logos: Record<string, string> = {};

  // The latest-raw view is an optimization, not the source of truth for logos:
  // its newest record can be a history/backfill record without an image. A
  // failure here must not discard logos that are already present in raw history.
  try {
    const latest = await client.from("latest_raw_provider_records").select(columns)
      .eq("provider_id", "coingecko").in("token_id", tokenIds);
    if (latest.error) {
      console.error("Latest CoinGecko logo read failed; falling back to raw logo history:", latest.error);
    } else {
      Object.assign(logos, logosFromRecords((latest.data ?? []) as unknown as LogoRecord[]));
    }
  } catch (error) {
    console.error("Latest CoinGecko logo read threw; falling back to raw logo history:", error);
  }

  // Logos are persistent metadata, not a freshness-sensitive metric. If the
  // newest raw record has no image, recover the newest valid /coins/markets
  // logo from raw history regardless of age. Batch the lookup so a large
  // token universe cannot create one oversized PostgREST IN query.
  const missing = tokenIds.filter((id) => !logos[id]);
  if (missing.length > 0) {
    const TOKEN_BATCH_SIZE = 50;
    const batches = Array.from(
      { length: Math.ceil(missing.length / TOKEN_BATCH_SIZE) },
      (_, index) => missing.slice(index * TOKEN_BATCH_SIZE, (index + 1) * TOKEN_BATCH_SIZE),
    );

    const results = await Promise.allSettled(batches.map(async (batch) => {
      const older = await client.from("raw_provider_records").select(columns)
        .eq("provider_id", "coingecko").eq("endpoint_label", COINGECKO_MARKETS_ENDPOINT)
        .in("token_id", batch).is("excluded_reason", null)
        .order("collected_at", { ascending: false })
        .limit(5000);
      if (older.error) throw older.error;
      return logosFromRecords((older.data ?? []) as unknown as LogoRecord[]);
    }));

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        Object.assign(logos, result.value);
      } else {
        console.error(
          "CoinGecko logo history batch " + (index + 1) + "/" + batches.length + " failed:",
          result.reason,
        );
      }
    }
  }

  return logos;
}

type GeckoTerminalRawPool = {
  attributes?: {
    address?: string;
    pool_created_at?: string | null;
    reserve_in_usd?: string | number | null;
    volume_usd?: { h24?: string | number | null };
    token_price_usd?: string | number | null;
  };
};

/**
 * GeckoTerminal on-chain pools for this token's exact network/address identity.
 * `provider_pairs` holds the indexed pool identity (address, DEX, creation
 * time); per-pool liquidity/volume are not separate columns (avoiding
 * duplicate metric storage), so they are read back from the same raw payload
 * already preserved in `raw_provider_records` and matched by pool address.
 * Optional: a failed read leaves pools empty rather than failing the profile.
 */
async function readGeckoTerminalPools(
  client: SupabaseAdminClient,
  tokenId: string,
): Promise<{ dexes: string[]; pools: OnchainMarketsData["pools"]; collectedAt: string | null }> {
  try {
    const [pairsResult, rawResult] = await Promise.all([
      client.from("provider_pairs")
        .select("pair_address,dex_id,pair_created_at")
        .eq("provider_id", "geckoterminal").eq("token_id", tokenId),
      client.from("latest_raw_provider_records")
        .select("collected_at,payload")
        .eq("provider_id", "geckoterminal").eq("token_id", tokenId).maybeSingle(),
    ]);
    if (pairsResult.error) throw pairsResult.error;
    if (rawResult.error) throw rawResult.error;
    const pairRows = (pairsResult.data ?? []) as { pair_address: string; dex_id: string | null; pair_created_at: string | null }[];
    const rawRecord = rawResult.data as { collected_at?: string; payload?: { providerPools?: GeckoTerminalRawPool[] } } | null;
    const rawPools = rawRecord?.payload?.providerPools ?? [];
    const poolByAddress = new Map(rawPools
      .filter((pool) => pool.attributes?.address)
      .map((pool) => [pool.attributes!.address!.toLowerCase(), pool]));
    const pools = pairRows.map((row) => {
      const raw = poolByAddress.get(row.pair_address.toLowerCase());
      return {
        pairAddress: row.pair_address,
        dexId: row.dex_id,
        createdAt: row.pair_created_at,
        liquidityUsd: numberValue(raw?.attributes?.reserve_in_usd),
        volume24hUsd: numberValue(raw?.attributes?.volume_usd?.h24),
        priceUsd: numberValue(raw?.attributes?.token_price_usd),
      };
    });
    return {
      pools,
      dexes: [...new Set(pools.map((pool) => pool.dexId).filter((id): id is string => Boolean(id)))],
      collectedAt: rawRecord?.collected_at ?? null,
    };
  } catch (error) {
    console.error(`GeckoTerminal pool read failed for ${tokenId} (shown as unavailable):`, error);
    return { pools: [], dexes: [], collectedAt: null };
  }
}

/** Latest rows of the newest metrics run for the dashboard's calculated metrics (read-only). */
async function readDashboardCalculated(client: SupabaseAdminClient, tokenIds: string[]): Promise<DbCalculatedValue[]> {
  const metricIds = [...DASHBOARD_CALCULATED_METRICS];
  const newest = await client.from("calculated_metric_observations").select("calculated_at")
    .in("metric_id", metricIds).order("calculated_at", { ascending: false }).limit(1);
  if (newest.error) throw newest.error;
  const newestAt = (newest.data?.[0] as { calculated_at?: string } | undefined)?.calculated_at;
  if (!newestAt) return [];
  const since = new Date(Date.parse(newestAt) - CALCULATION_RUN_SPAN_MS).toISOString();
  const rows: DbCalculatedValue[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await client.from("calculated_metric_observations")
      .select("id,token_id,metric_id,value,status,calculated_at")
      .in("metric_id", metricIds).in("token_id", tokenIds).gte("calculated_at", since)
      .order("id", { ascending: true }).range(offset, offset + 999);
    if (page.error) throw page.error;
    rows.push(...((page.data ?? []) as DbCalculatedValue[]));
    if ((page.data ?? []).length < 1000) return rows;
  }
}

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
    const latestRead = readLatest(client, tokenIds);
    const [latest, tvlHistory, logos, fdv, calculatedRows, volume7d] = await Promise.all([
      latestRead,
      readObservationWindow<DbObservation>(client, tokenIds, [{ providerId: "defillama", metricId: "tvl_usd" }], tvlSince).catch((error) => {
        console.error("Dashboard TVL history read failed (30D TVL change shown as unavailable):", error);
        return [] as DbObservation[];
      }),
      readTokenLogos(client, tokenIds),
      readReportedFdv(client, tokenIds),
      // Calculated columns are optional context: a failed read hides them instead of failing the page.
      readDashboardCalculated(client, tokenIds).catch((error) => {
        console.error("Dashboard calculated-metric read failed:", error);
        return [] as DbCalculatedValue[];
      }),
      latestRead.then((rows) => readSevenDayVolumes(client, rows)),
    ]);
    const refreshStatus = await readRefreshStatus(client, latest);
    const baseTokens = buildDashboardTokens(tokens, (chainResult.data ?? []) as DbChain[], mergeById(latest, tvlHistory));
    return {
      tokens: attachDashboardExtras(baseTokens, { logos, calculated: latestCalculatedValues(calculatedRows), fdv, volume7d }),
      error: null,
      refreshStatus,
    };
  } catch (error) {
    console.error("Live dashboard data load failed:", error);
    return { tokens: [], error: "Live data is temporarily unavailable. No demo data is being shown.", refreshStatus: null };
  }
}

/** `client` is injectable so the AI analysis reads the same profile data through the caller's client. */
export async function getLiveTokenProfile(tokenId: string, client: SupabaseAdminClient = createSupabaseAdminClient()): Promise<LiveTokenProfileData | null> {
  const { data: tokenData, error: tokenError } = await client.from("tokens")
    .select("id,name,symbol,chain_id,contract_address,is_native,category,description")
    .eq("id", tokenId).maybeSingle();
  if (tokenError) throw tokenError;
  if (!tokenData) return null;
  const tokenRow = tokenData as DbToken;
  const [chainResult, observations, calculatedResult, definitionResult, mappingResult, logos, supplyHistory, reportedFdv, gtPools] = await Promise.all([
    client.from("chains").select("id,name").eq("id", tokenRow.chain_id).maybeSingle(),
    readLatest(client, [tokenId]).then(async (latest) => mergeById(
      latest,
      await readObservationWindow<DbObservation>(client, [tokenId], HISTORY_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS)),
      // GeckoTerminal's own aggregates (market scope); a separate provider, read the same way as history series.
      await readObservationWindow<DbObservation>(client, [tokenId], GECKO_TERMINAL_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS)),
    )),
    client.from("calculated_metric_observations")
      .select("id,token_id,chain_id,metric_id,metric_name,unit,value,status,formula,calculated_at,period_start_at,period_end_at,unavailable_reason:provenance->>unavailable_reason")
      .eq("token_id", tokenId).order("calculated_at", { ascending: false }).order("id", { ascending: false }).range(0, 999),
    client.from("calculated_metric_definitions").select("id,category,source_scopes"),
    client.from("provider_token_mappings").select("provider_id,chain_id,external_asset_id,external_contract_address").eq("token_id", tokenId),
    readTokenLogos(client, [tokenId]),
    // Supply history is read only for technical indicators; a failed read just omits them.
    readObservationWindow<DbObservation>(client, [tokenId], INDICATOR_EXTRA_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS))
      .catch((error) => { console.error(`Indicator supply history read failed for ${tokenId}:`, error); return [] as DbObservation[]; }),
    // Token-level FDV from the stored market-data record (Tokenomics); failures leave it unavailable.
    readReportedFdv(client, [tokenId]),
    // GeckoTerminal pool identity (DEX, address, creation time); optional, so a failed read leaves it empty.
    readGeckoTerminalPools(client, tokenId),
  ]);
  if (chainResult.error) throw chainResult.error;
  if (calculatedResult.error) throw calculatedResult.error;
  if (definitionResult.error) throw definitionResult.error;
  if (mappingResult.error) throw mappingResult.error;
  const chain = chainResult.data as DbChain | null;
  const baseToken = buildDashboardTokens([tokenRow], chain ? [chain] : [], observations)[0];
  const fdv = reportedFdv[tokenId] ?? null;
  const token = fdv
    ? { ...baseToken, fdvUsd: fdv.value, metricSources: { ...baseToken.metricSources, fdvUsd: { providerId: "coingecko" as const, collectedAt: fdv.collectedAt, note: "Token-level FDV as reported in the stored market-data record." } } }
    : baseToken;
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
  const mappings = (mappingResult.data ?? []) as { provider_id: string; chain_id: string; external_asset_id: string; external_contract_address: string | null }[];
  const calc = buildCalculatedMetrics(
    (calculatedResult.data ?? []) as DbCalculatedMetric[],
    (definitionResult.data ?? []) as DbCalculatedMetricDefinition[],
  );
  // Freshness comes from the latest row per metric; backfilled history is collected later but is older data.
  const latestCollection = latestPerMetric(observations).map((row) => row.collected_at).sort().at(-1);
  if (latestCollection) metricSources.snapshot = { providerId: "calculated", collectedAt: latestCollection };
  // Per-token freshness uses the latest row per metric only: history-window rows (e.g. a backfill) are
  // collected later but hold older data, and a global refresh time would overstate this token's freshness.
  const latestTokenRows = latestPerMetric(observations.filter((row) => row.token_id === tokenId));
  const canonicalToken = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const coverage = canonicalToken ? tokenCoverage(canonicalToken) : [];
  const tokenLevelPriceRow = observationFor(observations, tokenId, "defillama_coins", "price_usd");
  const protocolMapping = defillamaProtocolMappings.find((mapping) => mapping.tokenId === tokenId);
  const dexMapped = coverage.some((item) => item.provider === "dexscreener" && item.status === "mapped");
  // Market-scope counts only for a curated exact-address mapping; never from a wrapped proxy.
  const dexCount = (metricId: string) => dexMapped ? observationValue(observationFor(observations, tokenId, "dexscreener", metricId)) : null;
  const protocolMapped = coverage.some((item) => item.provider === "defillama" && item.status === "mapped");
  // GeckoTerminal identity: network + exact contract address, from its own curated mapping (never a
  // wrapped or ticker-matched substitute). The chain name reuses this token's own chain lookup, since the
  // canonical chain the mapping is keyed to is always this token's own chain in the current mapping data.
  const gtMapping = mappings.find((mapping) => mapping.provider_id === "geckoterminal");
  const onchainMarkets: OnchainMarketsData | null = gtMapping
    ? {
      network: gtMapping.chain_id === tokenRow.chain_id ? (chain?.name ?? gtMapping.chain_id) : gtMapping.chain_id,
      contractAddress: gtMapping.external_contract_address,
      liquidityUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "liquidity_usd")),
      volume24hUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "volume_24h_usd")),
      priceChange24hPct: observationValue(observationFor(observations, tokenId, "geckoterminal", "price_change_24h_pct")),
      fdvUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "fdv_usd")),
      marketCapUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "market_cap_usd")),
      dexes: gtPools.dexes,
      pools: gtPools.pools,
    }
    : null;
  let technicalIndicators: TechnicalIndicatorsView | null = null;
  const nowIso = new Date().toISOString();
  try {
    technicalIndicators = buildTechnicalIndicators(mergeById(observations, supplyHistory), { asOf: new Date(), protocolMapped });
  } catch (error) {
    // Indicators are optional context: a calculation failure hides the section, never the profile.
    console.error(`Technical indicator calculation failed for ${tokenId}:`, error);
  }
  // On-chain concentration (Pool/DEX HHI): cross-sectional, from the latest GeckoTerminal
  // snapshot only. Merged in even if the daily-series indicators above found nothing.
  const concentrationIndicators = onchainMarkets
    ? buildConcentrationIndicators(onchainMarkets.pools, { collectedAt: gtPools.collectedAt, calculatedAt: nowIso })
    : [];
  if (concentrationIndicators.length > 0) {
    technicalIndicators = withExtraIndicators(technicalIndicators ?? { calculatedAt: nowIso, method: INDICATOR_METHOD, groups: [] }, concentrationIndicators);
  }
  return {
    token,
    technicalIndicators,
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
    datasetFreshness: buildDatasetFreshness({
      rows: latestTokenRows,
      // Only datasets this token's profile actually shows; unmapped DEX/protocol rows never count.
      relevant: ["coingecko", "defillama_coins", ...(dexMapped ? ["dexscreener" as const] : []), ...(protocolMapped && protocolMapping ? ["defillama" as const] : [])],
      calculatedAt: calc.map((item) => item.calculatedAt).sort().at(-1) ?? null,
      now: new Date(),
    }),
    coverage,
    tokenLevelPrice: tokenLevelPriceRow && tokenLevelPriceRow.status === "available" && numberValue(tokenLevelPriceRow.value) !== null
      ? { value: numberValue(tokenLevelPriceRow.value) as number, observedAt: tokenLevelPriceRow.observed_at, identifier: (tokenLevelPriceRow as { provider_asset_id?: string | null }).provider_asset_id ?? null, note: tokenLevelPriceRow.note }
      : null,
    logoUrl: logos[tokenId] ?? null,
    protocol: protocolMapping
      ? { name: protocolMapping.protocolName.replace(/\s*\(parent record\)\s*$/i, ""), aggregatesVersions: protocolMapping.recordKind === "parent" }
      : null,
    dexActivity: {
      transactions24h: dexCount("transactions_24h_count"),
      buys24h: dexCount("buys_24h_count"),
      sells24h: dexCount("sells_24h_count"),
    },
    onchainMarkets,
  };
}

/**
 * Sidebar 24H Movers for pages without dashboard rows. Reads only stored data:
 * the latest CoinGecko 24h change per tracked token and stored logos. The
 * sidebar is optional, so any failure hides it instead of failing the page.
 */
export async function getSidebarMovers(): Promise<Movers | null> {
  try {
    const client = createSupabaseAdminClient();
    const tokenResult = await client.from("tokens").select("id,name,symbol,chain_id,contract_address,is_native,category,description");
    if (tokenResult.error) throw tokenResult.error;
    const tokens = (tokenResult.data ?? []) as DbToken[];
    const tokenIds = tokens.map((token) => token.id);
    const [changeResult, logos] = await Promise.all([
      client.from("latest_token_metric_observations").select(OBSERVATION_COLUMNS)
        .eq("provider_id", "coingecko").in("metric_id", ["price_change_24h_pct", "volume_24h_usd"]).in("token_id", tokenIds),
      readTokenLogos(client, tokenIds),
    ]);
    if (changeResult.error) throw changeResult.error;
    const rows = buildDashboardTokens(tokens, [], (changeResult.data ?? []) as unknown as DbObservation[]);
    return selectMovers(rows.map((token) => ({ ...token, logoUrl: logos[token.id] ?? null })));
  } catch (error) {
    console.error("Sidebar movers read failed (section hidden):", error);
    return null;
  }
}

export function latestDashboardUpdate(tokens: DashboardToken[]): string | null {
  return tokens.flatMap((token) => Object.values(token.metricSources ?? {}).map((source) => source?.collectedAt ?? ""))
    .filter(Boolean).sort().at(-1) ?? null;
}
