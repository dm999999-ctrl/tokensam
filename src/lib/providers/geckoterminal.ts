import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderPairMapping,
  ProviderSnapshot,
} from "./types.ts";
import { geckoTerminalTokenMappings } from "../../data/geckoterminal-token-mappings.ts";

const PROVIDER_ID = "geckoterminal";
// The standalone GeckoTerminal Public API, never CoinGecko's /onchain endpoints.
const BASE_URL = "https://api.geckoterminal.com/api/v2";
const MAX_ADDRESSES_PER_MULTI_REQUEST = 30;
const MAX_ATTEMPTS = 3;
// The public API's rate limit is not published as a stable numeric guarantee.
// Treated conservatively as ~10 requests/minute (60_000 / 10 = 6_000 ms); the
// extra margin keeps bursts (retries, concurrent pacing) from crossing it.
const MIN_REQUEST_INTERVAL_MS = 6_500;
// In-process response cache so repeated lookups within one collection run (or
// one provider instance's lifetime) never re-issue an identical request.
const CACHE_TTL_MS = 5 * 60 * 1000;

export const GECKOTERMINAL_METRIC_NOTE = "GeckoTerminal is a separate, independent on-chain DEX data source from the standalone GeckoTerminal Public API (api.geckoterminal.com), not CoinGecko's /onchain endpoints. It is not consumed by, and does not affect, the CoinGecko collector or its API quota.";

export class GeckoTerminalApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GeckoTerminalApiError";
    this.status = status;
  }
}

export type GeckoTerminalAsset = ProviderAsset & {
  gtNetwork: string;
  tokenAddress: string;
  identityNote: string;
};

// ---- GeckoTerminal v2 JSON:API response shapes (the fields this adapter reads) ----

type GtTokenAttributes = {
  address?: string | null;
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  total_supply?: string | null;
  price_usd?: string | null;
  fdv_usd?: string | null;
  market_cap_usd?: string | null;
  total_reserve_in_usd?: string | null;
  volume_usd?: { h24?: string | null } | null;
};

type GtTokenResource = { id: string; type: string; attributes?: GtTokenAttributes };
export type GtMultiTokensResponse = { data?: GtTokenResource[] };

type GtPoolAttributes = {
  address?: string | null;
  name?: string | null;
  pool_created_at?: string | null;
  reserve_in_usd?: string | null;
  volume_usd?: { h24?: string | null } | null;
};

type GtPoolRelationships = {
  dex?: { data?: { id?: string; type?: string } | null } | null;
  base_token?: { data?: { id?: string; type?: string } | null } | null;
  quote_token?: { data?: { id?: string; type?: string } | null } | null;
};

type GtPoolResource = { id: string; type: string; attributes?: GtPoolAttributes; relationships?: GtPoolRelationships };
type GtIncludedResource = { id: string; type: string; attributes?: { name?: string | null } };
export type GtTokenPoolsResponse = { data?: GtPoolResource[]; included?: GtIncludedResource[] };

type GtDexResource = { id: string; type: string; attributes?: { name?: string | null } };
export type GtDexesResponse = { data?: GtDexResource[] };

export type GeckoTerminalPool = {
  poolAddress: string;
  dexId: string | null;
  dexName: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  poolCreatedAt: string | null;
  baseTokenId: string | null;
  quoteTokenId: string | null;
};

export type GeckoTerminalDex = { id: string; name: string | null };

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryAfterMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallback;
}

function poolIdToAddress(poolId: string): string {
  // GeckoTerminal pool IDs are "{network}_{poolAddress}"; the network prefix is redundant here.
  const separator = poolId.indexOf("_");
  return separator === -1 ? poolId : poolId.slice(separator + 1);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

/** Parses pools + included dex resources into GeckoTerminal pool records (the "DEX pairs" data type). */
export function parseTokenPools(payload: GtTokenPoolsResponse): GeckoTerminalPool[] {
  const dexNameById = new Map((payload.included ?? []).filter((item) => item.type === "dex").map((item) => [item.id, item.attributes?.name ?? null]));
  return (payload.data ?? []).flatMap((pool) => {
    if (!pool.attributes?.address) return [];
    const dexId = pool.relationships?.dex?.data?.id ?? null;
    return [{
      poolAddress: pool.attributes.address,
      dexId,
      dexName: dexId ? dexNameById.get(dexId) ?? null : null,
      liquidityUsd: finiteNumber(pool.attributes.reserve_in_usd),
      volume24hUsd: finiteNumber(pool.attributes.volume_usd?.h24),
      poolCreatedAt: pool.attributes.pool_created_at ?? null,
      baseTokenId: pool.relationships?.base_token?.data?.id ? poolIdToAddress(pool.relationships.base_token.data.id) : null,
      quoteTokenId: pool.relationships?.quote_token?.data?.id ? poolIdToAddress(pool.relationships.quote_token.data.id) : null,
    }];
  });
}

/** Parses a network's DEX catalog (the "DEX list" data type). */
export function parseNetworkDexes(payload: GtDexesResponse): GeckoTerminalDex[] {
  return (payload.data ?? []).flatMap((dex) => (dex.id ? [{ id: dex.id, name: dex.attributes?.name ?? null }] : []));
}

function observation(
  asset: GeckoTerminalAsset,
  metricId: string,
  value: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
): NormalizedObservation {
  const normalized = finiteNumber(value);
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: normalized,
    status: normalized === null ? "unavailable" : "available",
    observedAt,
    collectedAt,
    windowDays: metricId === "volume_24h_usd" ? 1 : null,
    // Exact chain + contract-address on-chain DEX data, same scope as DEX Screener.
    scope: "market",
    sourceField,
    note: normalized === null ? `${GECKOTERMINAL_METRIC_NOTE} Provider field was absent or non-numeric.` : GECKOTERMINAL_METRIC_NOTE,
  };
}

function pairMapping(asset: GeckoTerminalAsset, pool: GeckoTerminalPool, collectedAt: string): ProviderPairMapping {
  return {
    tokenId: asset.tokenId,
    providerChainId: asset.gtNetwork,
    chainId: asset.chainId,
    tokenAddress: asset.tokenAddress,
    pairAddress: pool.poolAddress,
    dexId: pool.dexId,
    pairUrl: null,
    baseTokenAddress: pool.baseTokenId,
    quoteTokenAddress: pool.quoteTokenId,
    pairCreatedAt: pool.poolCreatedAt,
    lastSeenAt: collectedAt,
  };
}

/**
 * Normalizes one token's GeckoTerminal data. Only `liquidity_usd` and
 * `volume_24h_usd` are populated (the metrics this initial integration is
 * scoped to); both reuse the existing metric catalog rather than introducing
 * GeckoTerminal-specific metric IDs, so this complements DEX Screener's
 * market-scope observations instead of duplicating the metric definitions.
 */
export function normalizeGeckoTerminalToken(
  asset: GeckoTerminalAsset,
  tokenAttributes: GtTokenAttributes | null,
  pools: GeckoTerminalPool[],
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const observedAt = collectedAt;
  const observations = [
    observation(asset, "liquidity_usd", tokenAttributes?.total_reserve_in_usd, "token.total_reserve_in_usd", observedAt, collectedAt),
    observation(asset, "volume_24h_usd", tokenAttributes?.volume_usd?.h24, "token.volume_usd.h24", observedAt, collectedAt),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: "GET /networks/{network}/tokens/multi/{addresses}, GET /networks/{network}/tokens/{address}/pools",
    asset,
    observedAt,
    collectedAt,
    rawPayload: {
      requestedNetwork: asset.gtNetwork,
      requestedTokenAddress: asset.tokenAddress,
      identityNote: asset.identityNote,
      token: tokenAttributes,
      pools,
    },
    observations,
    providerPairs: pools.map((pool) => pairMapping(asset, pool, collectedAt)),
  };
}

export function configuredGeckoTerminalAssets(): GeckoTerminalAsset[] {
  return geckoTerminalTokenMappings.flatMap((mapping) =>
    mapping.gtNetwork && mapping.tokenAddress
      ? [{
          tokenId: mapping.tokenId,
          chainId: mapping.canonicalChainId,
          externalAssetId: `${mapping.gtNetwork}:${mapping.tokenAddress}`,
          gtNetwork: mapping.gtNetwork,
          tokenAddress: mapping.tokenAddress,
          identityNote: mapping.identityNote,
        }]
      : [],
  );
}

export function getUnmappedGeckoTerminalTokens() {
  return geckoTerminalTokenMappings
    .filter((mapping) => !mapping.gtNetwork || !mapping.tokenAddress)
    .map(({ tokenId, unmappedReason }) => ({ tokenId, reason: unmappedReason ?? "No explicit GeckoTerminal network/address mapping." }));
}

export class GeckoTerminalMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private lastRequestAt = 0;
  private readonly cache = new Map<string, { expiresAt: number; payload: unknown }>();

  private readonly options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date };

  constructor(options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}) {
    this.options = options;
  }

  /** Paced, cached, retrying GET against the standalone GeckoTerminal Public API. Never CoinGecko. */
  private async get(path: string, fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;

    const url = new URL(path, BASE_URL);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const waitMs = MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
      if (this.lastRequestAt > 0 && waitMs > 0) await sleep(waitMs);
      this.lastRequestAt = Date.now();

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json;version=20230302" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS) throw new GeckoTerminalApiError("GeckoTerminal request failed due to a network error.", null);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        const payload: unknown = await response.json();
        this.cache.set(path, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
        return payload;
      }
      if (response.status === 404) {
        // A 404 means the network/address/pools resource does not exist; not retryable, and not a failure of the run.
        const empty = {};
        this.cache.set(path, { expiresAt: Date.now() + CACHE_TTL_MS, payload: empty });
        return empty;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new GeckoTerminalApiError(`GeckoTerminal returned HTTP ${response.status}.`, response.status);
      }
      const fallback = 1_000 * 2 ** (attempt - 1);
      await sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), fallback) : fallback);
    }
    throw new GeckoTerminalApiError("GeckoTerminal request exhausted its retry limit.", null);
  }

  /** GET /networks/{network}/dexes — the network's DEX catalog ("DEX list"). Cached per network. */
  async fetchNetworkDexes(network: string): Promise<{ dexes: GeckoTerminalDex[]; raw: unknown }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const raw = (await this.get(`/networks/${encodeURIComponent(network)}/dexes`, fetchImpl, sleep)) as GtDexesResponse;
    return { dexes: parseNetworkDexes(raw), raw };
  }

  async fetchSnapshots(assets: ProviderAsset[] = configuredGeckoTerminalAssets()): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = this.options.now ?? (() => new Date());
    const configuredByToken = new Map(configuredGeckoTerminalAssets().map((asset) => [asset.tokenId, asset]));
    const requested = assets.map((asset) => {
      const configured = configuredByToken.get(asset.tokenId);
      if (!configured || configured.chainId !== asset.chainId || configured.externalAssetId !== asset.externalAssetId) {
        throw new Error(`No exact GeckoTerminal network/address mapping exists for canonical token ${asset.tokenId}.`);
      }
      return configured;
    });

    const groups = new Map<string, GeckoTerminalAsset[]>();
    for (const asset of requested) groups.set(asset.gtNetwork, [...(groups.get(asset.gtNetwork) ?? []), asset]);

    const tokenAttributesByAsset = new Map<string, GtTokenAttributes | null>();
    const poolsByAsset = new Map<string, GeckoTerminalPool[]>();

    for (const [network, networkAssets] of groups) {
      // Contract/address + liquidity + volume data is batched: up to 30 addresses per request.
      for (const batch of chunk(networkAssets, MAX_ADDRESSES_PER_MULTI_REQUEST)) {
        const addresses = batch.map((asset) => encodeURIComponent(asset.tokenAddress)).join(",");
        const payload = (await this.get(`/networks/${encodeURIComponent(network)}/tokens/multi/${addresses}`, fetchImpl, sleep)) as GtMultiTokensResponse;
        const byId = new Map((payload.data ?? []).map((resource) => [resource.id.toLowerCase(), resource.attributes ?? null]));
        for (const asset of batch) {
          tokenAttributesByAsset.set(asset.tokenId, byId.get(`${network}_${asset.tokenAddress}`.toLowerCase()) ?? null);
        }
      }
      // DEX pairs/pools are not batchable; one request per token, same pacing and cache as everything else.
      for (const asset of networkAssets) {
        const payload = (await this.get(`/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(asset.tokenAddress)}/pools`, fetchImpl, sleep)) as GtTokenPoolsResponse;
        poolsByAsset.set(asset.tokenId, parseTokenPools(payload));
      }
    }

    return requested.map((asset) =>
      normalizeGeckoTerminalToken(asset, tokenAttributesByAsset.get(asset.tokenId) ?? null, poolsByAsset.get(asset.tokenId) ?? [], now().toISOString()),
    );
  }
}
