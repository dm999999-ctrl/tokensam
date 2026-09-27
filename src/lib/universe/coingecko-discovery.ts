// Candidate discovery from CoinGecko's own listed universe (AGENTS.md #5),
// expanding the pool well beyond the curated 238-token Dashboard set without
// hand-entering token names. `/coins/markets` is paginated (up to 250/page,
// CoinGecko's own maximum) rather than requested per-token, and `/coins/list`
// is fetched once to establish chain/contract identity. This never writes to
// `src/data/canonical-tokens.ts` or the tables the Dashboard reads; it only
// reads the canonical chain-ID catalog from it (via coingecko-chain-map.ts)
// so a candidate's `chain_id` can never violate the `chains` foreign key.

import { getCoinGeckoConfig } from "../providers/coingecko.ts";
import { resolveCanonicalChainId } from "./coingecko-chain-map.ts";
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
    const [platformKey, contractAddress] = entries[0];
    // `platforms` (the raw evidence, including this platform key) is always
    // returned either way, so an unmapped platform is never lost — only its
    // use as `chain_id`/`contract_address` (a `chains` foreign key pair) is
    // withheld until a confident canonical mapping exists (AGENTS.md #6, #12;
    // `universe_candidates_chain_id_fkey` must never see a raw CoinGecko
    // platform key, e.g. "binance-smart-chain" is not the chain ID "bnb-chain").
    const chainId = resolveCanonicalChainId(platformKey);
    if (chainId) return { chainId, contractAddress: contractAddress.toLowerCase(), isNative: false, platforms };
    return { chainId: null, contractAddress: null, isNative: false, platforms };
  }
  return { chainId: null, contractAddress: null, isNative: entries.length === 0, platforms };
}

export type DiscoveryResult = {
  candidates: UniverseCandidate[];
  /** IDs actually re-validated this run (the ranked top-`poolSize` window). Falling out of this window is NOT deprecation evidence. */
  discoveredIds: Set<string>;
  /**
   * Every ID CoinGecko's near-complete `/coins/list` catalog currently
   * returns. This, not `discoveredIds`, is the only fetch this module uses as
   * possible evidence that an asset no longer exists on CoinGecko at all
   * (AGENTS.md #14) — a token can easily rank outside the top `poolSize` on a
   * volatile day without being delisted.
   */
  listedCoingeckoIds: Set<string>;
  /** Set when `/coins/list` itself could not be fetched this run: absence-based deprecation must not be evaluated (AGENTS.md #25). */
  listOutage: string | null;
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
    if (error instanceof ProviderOutageError) {
      return { candidates: [], discoveredIds: new Set(), listedCoingeckoIds: new Set(), listOutage: null, marketsById: new Map(), outage: error.message };
    }
    throw error;
  }

  const trimmed = markets.slice(0, options.poolSize);

  let listById = new Map<string, CoinGeckoListEntry>();
  let listOutage: string | null = null;
  try {
    await options.sleep(MIN_REQUEST_INTERVAL_MS);
    const list = await fetchCoinsList(options.config, options);
    listById = new Map(list.map((entry) => [entry.id, entry]));
  } catch (error) {
    if (!(error instanceof ProviderOutageError)) throw error;
    // Identity chain/contract enrichment is best-effort; a list outage does not
    // block candidate discovery itself, it only leaves chain identity unresolved.
    // It DOES, however, disqualify this run from being used as absence
    // evidence for deprecation (duplicates.ts): we record that here so the
    // orchestrator never confuses "the catalog fetch failed" with "the
    // catalog confirms this ID is gone".
    listOutage = error.message;
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
    listedCoingeckoIds: new Set(listById.keys()),
    listOutage,
    marketsById: new Map(trimmed.map((market) => [market.id, market])),
    outage: null,
  };
}
