export type TokenCategory = string;

export type MetricSource = {
  providerId: "coingecko" | "defillama" | "dexscreener" | "defillama_coins" | "calculated";
  collectedAt: string;
  note?: string | null;
};

export type DashboardMetricKey =
  | "priceUsd"
  | "change24hPct"
  | "change7dPct"
  | "marketCapUsd"
  | "volume24hUsd"
  | "fdvUsd"
  | "circulatingSupply"
  | "maximumSupply"
  | "tvlUsd"
  | "tvlChange30dPct"
  | "fees24hUsd"
  | "revenue24hUsd";

/**
 * A normalized dashboard record. Numeric metrics are nullable so missing
 * source data remains distinguishable from a real zero value.
 */
export type DashboardToken = {
  id: string;
  name: string;
  symbol: string;
  chain: string;
  category: TokenCategory;
  priceUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  /** Token-level FDV as reported in the stored market-data record (never a DEX-reported FDV). Absent = unavailable. */
  fdvUsd?: number | null;
  /** Sum of seven non-overlapping stored 24-hour volume observations covering the latest 7 days. Absent/null = unavailable. */
  volume7dUsd?: number | null;
  circulatingSupply?: number | null;
  maximumSupply?: number | null;
  tvlUsd: number | null;
  tvlChange30dPct: number | null;
  fees24hUsd: number | null;
  revenue24hUsd: number | null;
  observedAt: string;
  metricSources?: Partial<Record<DashboardMetricKey, MetricSource>>;
  /** CoinGecko image URL from stored metadata; presentation only, never identity. */
  logoUrl?: string | null;
  /** Latest stored calculated metrics shown on the dashboard (null = unavailable). */
  calculated?: Partial<Record<DashboardCalculatedKey, number | null>>;
  coverage?: DashboardCoverage;
};

/** Existing calculated metrics read (not recalculated) for the dashboard views. */
export const DASHBOARD_CALCULATED_METRICS = [
  "volume_to_market_cap",
  "market_cap_to_tvl",
  "market_cap_to_revenue_24h",
  "dex_aggregate_liquidity_usd",
  "dex_aggregate_volume_24h_usd",
  "dex_aggregate_liquidity_to_market_cap_pct",
  "dex_volume_to_liquidity",
  "dex_buy_sell_ratio",
] as const;
export type DashboardCalculatedKey = (typeof DASHBOARD_CALCULATED_METRICS)[number];

/** Mapping status (curated coverage) plus whether valid data is actually stored. */
export type DashboardCoverage = {
  isNative: boolean;
  protocolMapped: boolean;
  dexMapped: boolean;
  hasProtocolData: boolean;
  hasDexData: boolean;
};

export type CalculatedMetricView = {
  id: string;
  name: string;
  category: "valuation" | "growth" | "market_structure" | "divergence";
  unit: "USD" | "ratio" | "percent" | "percentage_points" | "count" | "boolean";
  value: number | null;
  status: "available" | "unavailable" | "invalid";
  formula: string;
  calculatedAt: string;
  periodStartAt: string | null;
  periodEndAt: string | null;
  /** Why the metric is unavailable/invalid, from its stored provenance. */
  unavailableReason?: string | null;
  /** Economic scopes of the inputs, e.g. "token/protocol". */
  sourceScopes?: string | null;
};

export type LiveTokenProfileData = {
  token: DashboardToken;
  /** Only indicators whose inputs and history exist, grouped by category; null when not calculated. */
  technicalIndicators?: import("@/types/technical-indicators").TechnicalIndicatorsView | null;
  description: string | null;
  contractAddress: string | null;
  isNative: boolean;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maximumSupply: number | null;
  metricSources: Partial<Record<string, MetricSource>>;
  calculatedMetrics: CalculatedMetricView[];
  history: import("@/types/historical-data").TokenHistoricalData;
  dataNotes: string[];
  dexMapped: boolean;
  defiLlamaMapped: boolean;
  /** This token's own latest collection per displayed dataset, plus its latest calculation time. */
  datasetFreshness: import("@/lib/refresh/freshness").DatasetFreshness[];
  /** Per-provider identity, scope, and explicit unavailability reasons. */
  coverage: import("@/data/provider-coverage").ProviderCoverage[];
  /** Latest DeFiLlama coins-API price for this exact token (token scope), if collected. */
  tokenLevelPrice: { value: number; observedAt: string; identifier: string | null; note: string | null } | null;
  /** CoinGecko image URL from stored metadata; presentation only, never identity. */
  logoUrl: string | null;
  /** Curated associated protocol (protocol scope), when one is mapped. */
  protocol: { name: string; aggregatesVersions: boolean } | null;
  /** Latest exact-address DEX transaction counts (market scope); null when not stored. */
  dexActivity: { transactions24h: number | null; buys24h: number | null; sells24h: number | null };
};
