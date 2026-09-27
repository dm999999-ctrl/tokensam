// Candidate discovery from CoinGecko's own listed universe (AGENTS.md #5),
// expanding the pool well beyond the curated 238-token Dashboard set without
// hand-entering token names. `/coins/markets` is paginated (up to 250/page,
// CoinGecko's own maximum) rather than requested per-token, and `/coins/list`
// is fetched once to establish chain/contract identity. This never touches
// `src/data/canonical-tokens.ts` or the tables the Dashboard reads.

import { getCoinGeckoConfig } from "../providers/coingecko.ts";
import { fetchJsonWithRetry, ProviderOutageError, type Sleep } from "./http.ts";
import { newCandidateFromMarket, type CoinGeckoListEntry, type CoinGeckoMarketCandidate, type UniverseCandidate } from "./types.ts";

const MARKETS_PAGE_SIZE = 250;
export const MIN_REQUEST_INTERVAL_MS = 2_100;

export type CoinGeckoConfig = ReturnType<typeof getCoinGeckoConfig>;

export type DiscoveryOptions = {
  poolSize: number;
  config: CoinGeckoConfig;
  fetchImpl: typeof fetch;
  sleep: Sleep;
  now?: () => Date;
};

async function fetchMarketsPage(page: number, config: CoinGeckoConfig, options: { fetchImpl: typeof fetch; sleep: Sleep }): Promise<CoinGeckoMarketCandidate[]> {
  const url = new URL(`${config.baseUrl}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(MARKETS_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("include_rehypothecated", "true");
  return fetchJsonWithRetry<CoinGeckoMarketCandidate[]>(
    url,
    { method: "GET", headers: { [config.keyHeader]: config.apiKey, accept: "application/json" } },
    { ...options, label: "CoinGecko /coins/markets" },
  );
}

async function fetchCoinsList(config: CoinGeckoConfig, options: { fetchImpl: typeof fetch; sleep: Sleep }): Promise<CoinGeckoListEntry[]> {
  const url = new URL(`${config.baseUrl}/coins/list`);
  url.searchParams.set("include_platform", "true");
  return fetchJsonWithRetry<CoinGeckoListEntry[]>(
    url,
    { method: "GET", headers: { [config.keyHeader]: config.apiKey, accept: "application/json" } },
    { ...options, label: "CoinGecko /coins/list" },
  );
}

/**
 * A CoinGecko `platforms` map identifies a confident chain/contract identity
 * only when exactly one platform carries a non-empty address; a multi-chain
 * token (e.g. USDT) or an empty map is left chain-unresolved rather than
 * guessing which deployment is "the" canonical one (AGENTS.md #6, #12).
 */
export function resolvePlatformIdentity(entry: CoinGeckoListEntry | undefined): { chainId: string | null; contractAddress: string | null; isNative: boolean; platforms: Record<string, string> } {
  const platforms = Object.fromEntries(
    Object.entries(entry?.platforms ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim() !== ""),
  );
  const entries = Object.entries(platforms);
  if (entries.length === 1) {
    const [chainId, contractAddress] = entries[0];
    return { chainId, contractAddress: contractAddress.toLowerCase(), isNative: false, platforms };
  }
  return { chainId: null, contractAddress: null, isNative: entries.length === 0, platforms };
}

export type DiscoveryResult = {
  candidates: UniverseCandidate[];
  discoveredIds: Set<string>;
  marketsById: Map<string, CoinGeckoMarketCandidate>;
  outage: string | null;
};

/** Discover up to `poolSize` candidates, largest market cap first, with resolved chain/contract identity where confident. */
export async function discoverCandidates(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const now = options.now ?? (() => new Date());
  const discoveredAt = now().toISOString();
  const pageCount = Math.ceil(options.poolSize / MARKETS_PAGE_SIZE);
  const markets: CoinGeckoMarketCandidate[] = [];

  try {
    for (let page = 1; page <= pageCount; page += 1) {
      if (page > 1) await options.sleep(MIN_REQUEST_INTERVAL_MS);
      const items = await fetchMarketsPage(page, options.config, options);
      markets.push(...items);
      if (items.length < MARKETS_PAGE_SIZE) break;
    }
  } catch (error) {
    if (error instanceof ProviderOutageError) return { candidates: [], discoveredIds: new Set(), marketsById: new Map(), outage: error.message };
    throw error;
  }

  const trimmed = markets.slice(0, options.poolSize);

  let listById = new Map<string, CoinGeckoListEntry>();
  try {
    await options.sleep(MIN_REQUEST_INTERVAL_MS);
    const list = await fetchCoinsList(options.config, options);
    listById = new Map(list.map((entry) => [entry.id, entry]));
  } catch (error) {
    if (!(error instanceof ProviderOutageError)) throw error;
    // Identity chain/contract enrichment is best-effort; a list outage does not
    // block candidate discovery itself, it only leaves chain identity unresolved.
  }

  const candidates = trimmed.map((market) => {
    const candidate = newCandidateFromMarket(market, discoveredAt);
    const identity = resolvePlatformIdentity(listById.get(market.id));
    return {
      ...candidate,
      chainId: identity.chainId,
      contractAddress: identity.contractAddress,
      isNative: identity.isNative,
      identityEvidence: { platforms: identity.platforms },
    };
  });

  return {
    candidates,
    discoveredIds: new Set(candidates.map((candidate) => candidate.coingeckoId)),
    marketsById: new Map(trimmed.map((market) => [market.id, market])),
    outage: null,
  };
}
