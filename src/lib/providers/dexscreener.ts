import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderPairMapping,
  ProviderSnapshot,
} from "./types.ts";
import { DEX_SCREENER_METRIC_NOTE, dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";

const PROVIDER_ID = "dexscreener";
const BASE_URL = "https://api.dexscreener.com";
const MAX_ADDRESSES_PER_REQUEST = 30;
const MAX_ATTEMPTS = 3;
// The official endpoint limit is 300 requests/minute. 300 ms leaves margin.
const MIN_REQUEST_INTERVAL_MS = 300;
const EVM_CHAINS = new Set(["ethereum", "base", "bsc", "avalanche", "arbitrum", "optimism", "zksync"]);

export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string | null; name?: string | null; symbol?: string | null };
  priceUsd?: string | number | null;
  txns?: Record<string, { buys?: number | null; sells?: number | null } | undefined>;
  volume?: Record<string, number | null | undefined>;
  priceChange?: Record<string, number | null | undefined> | null;
  liquidity?: { usd?: number | null; base?: number | null; quote?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
};

export class DexScreenerApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DexScreenerApiError";
    this.status = status;
  }
}

export type DexScreenerAsset = ProviderAsset & {
  dexChainId: string;
  tokenAddress: string;
  identityNote: string;
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Exact token-address identity on a DEX Screener chain. EVM addresses are
 * case-insensitive (checksummed mixed case is common); other chains' addresses
 * (Solana mints, Move coin types, ICP canisters) are compared exactly.
 * Shared with the metrics engine so both apply the same rule.
 */
export function addressEquals(chainId: string, left: string | undefined | null, right: string | undefined | null): boolean {
  if (!left || !right) return false;
  return EVM_CHAINS.has(chainId) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function numberOrNull(value: unknown): number | null {
  return finiteNumber(value);
}

function pairVolume(pair: DexScreenerPair): number | null {
  return numberOrNull(pair.volume?.h24);
}

function pairLiquidity(pair: DexScreenerPair): number | null {
  return numberOrNull(pair.liquidity?.usd);
}

function pairTransactions(pair: DexScreenerPair, field: "buys" | "sells"): number | null {
  return numberOrNull(pair.txns?.h24?.[field]);
}

function aggregate(pairs: DexScreenerPair[], read: (pair: DexScreenerPair) => number | null): number | null {
  const values = pairs.map(read).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function comparePairs(a: DexScreenerPair, b: DexScreenerPair): number {
  const aLiquidity = pairLiquidity(a) ?? -1;
  const bLiquidity = pairLiquidity(b) ?? -1;
  if (aLiquidity !== bLiquidity) return bLiquidity - aLiquidity;
  const aVolume = pairVolume(a) ?? -1;
  const bVolume = pairVolume(b) ?? -1;
  if (aVolume !== bVolume) return bVolume - aVolume;
  return (a.pairAddress ?? "").localeCompare(b.pairAddress ?? "");
}

function uniqueMatchedPairs(asset: DexScreenerAsset, pairs: DexScreenerPair[]): DexScreenerPair[] {
  const seen = new Set<string>();
  return pairs.filter((pair) => {
    if (pair.chainId !== asset.dexChainId || !pair.pairAddress) return false;
    const tokenMatches =
      addressEquals(asset.dexChainId, pair.baseToken?.address, asset.tokenAddress) ||
      addressEquals(asset.dexChainId, pair.quoteToken?.address, asset.tokenAddress);
    if (!tokenMatches || seen.has(pair.pairAddress)) return false;
    seen.add(pair.pairAddress);
    return true;
  });
}

function observation(
  asset: DexScreenerAsset,
  metricId: string,
  value: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  windowDays: number | null = null,
  note = DEX_SCREENER_METRIC_NOTE,
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
    windowDays,
    // DEX pair/market data for an exact token address.
    scope: "market",
    sourceField,
    note: normalized === null ? `${note} Provider field was absent or non-numeric.` : note,
  };
}

function pairMapping(asset: DexScreenerAsset, pair: DexScreenerPair, collectedAt: string): ProviderPairMapping {
  const created = numberOrNull(pair.pairCreatedAt);
  const pairCreatedAt = created === null || created <= 0
    ? null
    : new Date(created > 10_000_000_000 ? created : created * 1000).toISOString();
  return {
    tokenId: asset.tokenId,
    providerChainId: asset.dexChainId,
    chainId: asset.chainId,
    tokenAddress: asset.tokenAddress,
    pairAddress: pair.pairAddress ?? "",
    dexId: pair.dexId ?? null,
    pairUrl: pair.url ?? null,
    baseTokenAddress: pair.baseToken?.address ?? null,
    quoteTokenAddress: pair.quoteToken?.address ?? null,
    pairCreatedAt,
    lastSeenAt: collectedAt,
  };
}

/** Choose an exact token-base pair by liquidity, then volume, then stable address order. */
export function selectPrimaryPair(asset: DexScreenerAsset, pairs: DexScreenerPair[]): DexScreenerPair | null {
  const matched = uniqueMatchedPairs(asset, pairs);
  const basePairs = matched.filter((pair) => addressEquals(asset.dexChainId, pair.baseToken?.address, asset.tokenAddress));
  return [...(basePairs.length > 0 ? basePairs : matched)].sort(comparePairs)[0] ?? null;
}

export function normalizeDexScreenerToken(
  asset: DexScreenerAsset,
  providerPairs: DexScreenerPair[],
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const matchedPairs = uniqueMatchedPairs(asset, providerPairs);
  const basePairs = matchedPairs.filter((pair) => addressEquals(asset.dexChainId, pair.baseToken?.address, asset.tokenAddress));
  const primaryPair = selectPrimaryPair(asset, matchedPairs);
  const primaryBasePair = primaryPair && addressEquals(asset.dexChainId, primaryPair.baseToken?.address, asset.tokenAddress)
    ? primaryPair
    : basePairs[0] ?? null;
  const observedAt = collectedAt;
  const aggregateNote = matchedPairs.length > 0
    ? `${DEX_SCREENER_METRIC_NOTE} Volume and transaction counts aggregate numeric values from ${matchedPairs.length} exact-address pair(s); absent pair fields are excluded. Primary pair is selected by highest USD liquidity, then 24-hour volume, then pair address.`
    : DEX_SCREENER_METRIC_NOTE;
  const buyCount = aggregate(matchedPairs, (pair) => pairTransactions(pair, "buys"));
  const sellCount = aggregate(matchedPairs, (pair) => pairTransactions(pair, "sells"));
  const totalTxCount = buyCount === null || sellCount === null ? null : buyCount + sellCount;
  const observations = [
    observation(asset, "price_usd", primaryBasePair?.priceUsd, "primaryPair.priceUsd", observedAt, collectedAt, null, primaryBasePair ? aggregateNote : `${aggregateNote} No exact-address base-token pair was available; pair price is not inverted.`),
    observation(asset, "volume_24h_usd", aggregate(matchedPairs, pairVolume), "pairs[].volume.h24", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "liquidity_usd", primaryPair?.liquidity?.usd, "primaryPair.liquidity.usd", observedAt, collectedAt, null, aggregateNote),
    observation(asset, "price_change_24h_pct", primaryBasePair?.priceChange?.h24, "primaryPair.priceChange.h24", observedAt, collectedAt, 1, primaryBasePair ? aggregateNote : `${aggregateNote} No exact-address base-token pair was available.`),
    observation(asset, "transactions_24h_count", totalTxCount, "sum(pairs[].txns.h24.buys+sells)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "buys_24h_count", buyCount, "sum(pairs[].txns.h24.buys)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "sells_24h_count", sellCount, "sum(pairs[].txns.h24.sells)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "fdv_usd", primaryBasePair?.fdv, "primaryPair.fdv", observedAt, collectedAt, null, aggregateNote),
    observation(asset, "market_cap_usd", primaryBasePair?.marketCap, "primaryPair.marketCap", observedAt, collectedAt, null, aggregateNote),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: "GET /tokens/v1/{chainId}/{tokenAddresses}",
    asset,
    observedAt,
    collectedAt,
    rawPayload: {
      requestedChainId: asset.dexChainId,
      requestedTokenAddress: asset.tokenAddress,
      identityNote: asset.identityNote,
      selection: "All exact chain/address pair matches retained; primary base-token pair selected by USD liquidity descending, 24-hour volume descending, then pairAddress ascending.",
      providerPairs: matchedPairs,
    },
    observations,
    providerPairs: matchedPairs.map((pair) => pairMapping(asset, pair, collectedAt)),
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function retryAfterMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallback;
}

async function getPairs(
  chainId: string,
  addresses: string[],
  options: { fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void> },
): Promise<DexScreenerPair[]> {
  const encodedAddresses = addresses.map(encodeURIComponent).join(",");
  const url = new URL(`/tokens/v1/${encodeURIComponent(chainId)}/${encodedAddresses}`, BASE_URL);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new DexScreenerApiError("DEX Screener request failed due to a network error.", null);
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new DexScreenerApiError("DEX Screener returned an unexpected pair response.", response.status);
      return payload as DexScreenerPair[];
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new DexScreenerApiError(`DEX Screener returned HTTP ${response.status}.`, response.status);
    }
    const fallback = 500 * 2 ** (attempt - 1);
    await options.sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), fallback) : fallback);
  }
  throw new DexScreenerApiError("DEX Screener request exhausted its retry limit.", null);
}

export function configuredDexScreenerAssets(): DexScreenerAsset[] {
  return dexScreenerTokenMappings.flatMap((mapping) =>
    mapping.dexChainId && mapping.tokenAddress
      ? [{
          tokenId: mapping.tokenId,
          chainId: mapping.canonicalChainId,
          externalAssetId: `${mapping.dexChainId}:${mapping.tokenAddress}`,
          dexChainId: mapping.dexChainId,
          tokenAddress: mapping.tokenAddress,
          identityNote: mapping.identityNote,
        }]
      : [],
  );
}

export class DexScreenerMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private readonly options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  };

  constructor(options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}) {
    this.options = options;
  }

  async fetchSnapshots(assets: ProviderAsset[] = configuredDexScreenerAssets()): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = this.options.now ?? (() => new Date());
    const configuredByToken = new Map(configuredDexScreenerAssets().map((asset) => [asset.tokenId, asset]));
    const requested = assets.map((asset) => {
      const configured = configuredByToken.get(asset.tokenId);
      if (!configured || configured.chainId !== asset.chainId || configured.externalAssetId !== asset.externalAssetId) {
        throw new Error(`No exact DEX Screener address mapping exists for canonical token ${asset.tokenId}.`);
      }
      return configured;
    });
    const groups = new Map<string, DexScreenerAsset[]>();
    for (const asset of requested) groups.set(asset.dexChainId, [...(groups.get(asset.dexChainId) ?? []), asset]);

    const results = new Map<string, DexScreenerPair[]>();
    let requestCount = 0;
    for (const [chainId, chainAssets] of groups) {
      for (const batch of chunk(chainAssets, MAX_ADDRESSES_PER_REQUEST)) {
        if (requestCount > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
        requestCount += 1;
        const pairs = await getPairs(chainId, batch.map((asset) => asset.tokenAddress), { fetchImpl, sleep });
        for (const asset of batch) results.set(asset.tokenId, pairs);
      }
    }

    return requested.map((asset) => normalizeDexScreenerToken(asset, results.get(asset.tokenId) ?? [], now().toISOString()));
  }
}

export function getUnmappedDexScreenerTokens() {
  return dexScreenerTokenMappings
    .filter((mapping) => !mapping.dexChainId || !mapping.tokenAddress)
    .map(({ tokenId, unmappedReason }) => ({ tokenId, reason: unmappedReason ?? "No explicit address mapping." }));
}
