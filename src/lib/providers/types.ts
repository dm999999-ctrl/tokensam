export type NormalizedMetricStatus = "available" | "unavailable";

/**
 * Economic scope of an observation. A protocol- or chain-level value must never
 * populate a token-level metric; market scope covers DEX pair/market data.
 */
export type ObservationScope = "token" | "protocol" | "chain" | "market";

/** Provider-neutral observation shape shared by future market data adapters. */
export type NormalizedObservation = {
  tokenId: string;
  chainId: string;
  metricId: string;
  value: number | null;
  status: NormalizedMetricStatus;
  observedAt: string;
  collectedAt: string;
  windowDays: number | null;
  scope: ObservationScope;
  sourceField: string;
  note: string | null;
};

export type ProviderAsset = {
  tokenId: string;
  chainId: string;
  externalAssetId: string;
};

export type ProviderSnapshot = {
  providerId: string;
  endpointLabel: string;
  asset: ProviderAsset;
  observedAt: string;
  collectedAt: string;
  rawPayload: unknown;
  observations: NormalizedObservation[];
  providerPairs?: ProviderPairMapping[];
};

/** Pair-level links make a provider's market structure queryable independently of token metrics. */
export type ProviderPairMapping = {
  tokenId: string;
  providerChainId: string;
  chainId: string;
  tokenAddress: string;
  pairAddress: string;
  dexId: string | null;
  pairUrl: string | null;
  baseTokenAddress: string | null;
  quoteTokenAddress: string | null;
  pairCreatedAt: string | null;
  lastSeenAt: string;
};

/** A provider adapter converts provider responses to normalized snapshots. */
export interface MarketDataProvider {
  readonly providerId: string;
  fetchSnapshots(assets: ProviderAsset[]): Promise<ProviderSnapshot[]>;
}
