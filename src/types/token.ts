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
  tvlUsd: number | null;
  tvlChange30dPct: number | null;
  fees24hUsd: number | null;
  revenue24hUsd: number | null;
  observedAt: string;
  metricSources?: Partial<Record<DashboardMetricKey, MetricSource>>;
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
  refreshStatus: import("@/lib/refresh/freshness").RefreshStatusView;
  /** Per-provider identity, scope, and explicit unavailability reasons. */
  coverage: import("@/data/provider-coverage").ProviderCoverage[];
  /** Latest DeFiLlama coins-API price for this exact token (token scope), if collected. */
  tokenLevelPrice: { value: number; observedAt: string; identifier: string | null; note: string | null } | null;
};
