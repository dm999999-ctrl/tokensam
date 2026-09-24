import { retryAfterMs } from "./coingecko.ts";
import type { NormalizedObservation, ProviderAsset, ProviderSnapshot } from "./types.ts";

/**
 * DeFiLlama coins API (free, no key): GET https://coins.llama.fi/prices/current/{coins}.
 * Keys are `chain:address` or `coingecko:<id>`; each result carries price,
 * symbol, provider timestamp, and a confidence score. This is TOKEN-level data,
 * kept separate from DeFiLlama protocol records (provider id "defillama_coins").
 */

export const DEFILLAMA_COINS_PROVIDER_ID = "defillama_coins";
const BASE_URL = "https://coins.llama.fi";
const ENDPOINT_LABEL = "GET /prices/current/{coins}";
const MAX_KEYS_PER_REQUEST = 25;
const MAX_ATTEMPTS = 3;
// No numeric public limit is documented; pace like the protocol collector.
const MIN_REQUEST_INTERVAL_MS = 1_100;

export type CoinsPrice = { price?: unknown; symbol?: unknown; timestamp?: unknown; confidence?: unknown; decimals?: unknown };

export class DefiLlamaCoinsError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DefiLlamaCoinsError";
    this.status = status;
  }
}

async function fetchPrices(keys: string[], fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<Record<string, CoinsPrice>> {
  const url = `${BASE_URL}/prices/current/${keys.map(encodeURIComponent).join(",")}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new DefiLlamaCoinsError("DeFiLlama coins request failed due to a network error.", null);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      const body = (await response.json()) as { coins?: Record<string, CoinsPrice> };
      if (!body || typeof body.coins !== "object" || body.coins === null) throw new DefiLlamaCoinsError("DeFiLlama coins API returned an unexpected response.", response.status);
      return body.coins;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw new DefiLlamaCoinsError(`DeFiLlama coins API returned HTTP ${response.status}.`, response.status);
    const fallbackMs = 500 * 2 ** (attempt - 1);
    await sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), fallbackMs) : fallbackMs);
  }
  throw new DefiLlamaCoinsError("DeFiLlama coins request exhausted its retry limit.", null);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One token-level snapshot per asset; a missing key is recorded as unavailable, never zero. */
export function normalizeCoinsPrice(asset: ProviderAsset, entry: CoinsPrice | undefined, collectedAt: string): ProviderSnapshot {
  const price = finite(entry?.price);
  const seconds = finite(entry?.timestamp);
  const observedAt = seconds !== null && seconds > 0 ? new Date(seconds * 1000).toISOString() : collectedAt;
  const confidence = finite(entry?.confidence);
  const observation: NormalizedObservation = {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId: "price_usd",
    value: price,
    status: price === null ? "unavailable" : "available",
    observedAt,
    collectedAt,
    windowDays: null,
    scope: "token",
    sourceField: `coins["${asset.externalAssetId}"].price`,
    note: price === null
      ? `DeFiLlama coins API returned no price for ${asset.externalAssetId}.`
      : `DeFiLlama coins API token price for ${asset.externalAssetId}${confidence === null ? "" : ` (DeFiLlama confidence ${confidence})`}.`
        + (asset.externalAssetId.startsWith("coingecko:") ? " Keyed by CoinGecko ID; DeFiLlama may source this price from CoinGecko." : ""),
  };
  return {
    providerId: DEFILLAMA_COINS_PROVIDER_ID,
    endpointLabel: ENDPOINT_LABEL,
    asset,
    observedAt,
    collectedAt,
    rawPayload: { key: asset.externalAssetId, response: entry ?? null },
    observations: [observation],
  };
}

export async function fetchCoinsSnapshots(
  assets: ProviderAsset[],
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<ProviderSnapshot[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const snapshots: ProviderSnapshot[] = [];
  for (let index = 0; index < assets.length; index += MAX_KEYS_PER_REQUEST) {
    if (index > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    const batch = assets.slice(index, index + MAX_KEYS_PER_REQUEST);
    const coins = await fetchPrices(batch.map((asset) => asset.externalAssetId), fetchImpl, sleep);
    const collectedAt = now().toISOString();
    for (const asset of batch) snapshots.push(normalizeCoinsPrice(asset, coins[asset.externalAssetId], collectedAt));
  }
  return snapshots;
}
