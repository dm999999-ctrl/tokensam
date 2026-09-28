// Canonical CoinGecko-platform -> Token Samurai chain-ID resolver.
//
// `public.chains.id` is a foreign key target; `universe_candidates.chain_id`
// references it. CoinGecko's `/coins/list?include_platform=true` platform
// keys (e.g. "binance-smart-chain", "polygon-pos") are a *different*
// identifier space from Token Samurai's own canonical chain IDs (e.g.
// "bnb-chain", "polygon") and must never be inserted directly — that is
// exactly the bug this module fixes (a CoinGecko platform key is not
// guaranteed to equal, or even resemble, the canonical chain ID).
//
// The valid target set is derived directly from `canonicalTokens`, so this
// resolver can never hand back a chain ID outside Token Samurai's own
// canonical model. That alone is *not* sufficient to satisfy the live
// `chains` foreign key, though: `public.chains` rows are only ever created by
// `run-coingecko-collection.ts`'s Dashboard collector, which may not have run
// against every chain in the current (Phase 16, 104-chain) canonical set on
// a given Supabase instance yet — a canonically-valid, code-verified chain ID
// can still be a foreign key that doesn't exist as a row *yet*. `persist.ts`
// closes that gap by upserting the chain rows a candidate batch actually
// needs (id + canonical name, from `CHAIN_ID_TO_NAME` below — never a raw
// CoinGecko platform key) before writing `universe_candidates`, the same
// pattern `run-coingecko-collection.ts` already uses.
//
// A mapping is included only when the CoinGecko platform slug is well-known
// and stable (used consistently across DeFiLlama, DEX Screener and other
// public tooling for years) — never guessed to fill out the table. A
// CoinGecko platform with no entry here resolves to `null`; the resolver
// never fails candidate discovery, and never invents a `chains` row.

import { canonicalTokens } from "../../data/canonical-tokens.ts";

/** Every chain ID Token Samurai's canonical model recognizes (the same set `run-coingecko-collection.ts` derives `chains` rows from). */
export const CANONICAL_CHAIN_IDS: ReadonlySet<string> = new Set(canonicalTokens.map((token) => token.chainId));

/** Canonical chain ID -> its display name, for upserting `public.chains` rows Phase A discovers a need for. Never sourced from raw CoinGecko/provider data. */
export const CHAIN_ID_TO_NAME: ReadonlyMap<string, string> = new Map(canonicalTokens.map((token) => [token.chainId, token.chainName]));

/**
 * CoinGecko platform key -> canonical Token Samurai chain ID.
 * Verified against `CANONICAL_CHAIN_IDS` (see the exhaustive test in
 * `tests/universe-phase-a-chain-map.test.mjs`, which fails the build if any
 * value here ever falls out of sync with the real chain catalog).
 */
export const COINGECKO_PLATFORM_TO_CHAIN_ID: Readonly<Record<string, string>> = {
  // ---- Direct matches (CoinGecko's platform key already equals our chain ID) ----
  ethereum: "ethereum",
  "polygon-pos": "polygon",
  solana: "solana",
  tron: "tron",
  fantom: "fantom",
  base: "base",
  avalanche: "avalanche",
  celo: "celo",
  cronos: "cronos",
  kava: "kava",
  osmosis: "osmosis",
  injective: "injective",
  polkadot: "polkadot",
  cosmos: "cosmos",
  kusama: "kusama",
  algorand: "algorand",
  stellar: "stellar",
  tezos: "tezos",
  sui: "sui",
  aptos: "aptos",
  filecoin: "filecoin",
  monero: "monero",
  litecoin: "litecoin",
  dogecoin: "dogecoin",
  cardano: "cardano",
  blast: "blast",
  metis: "metis",
  boba: "boba",
  celestia: "celestia",

  // ---- Known naming differences (CoinGecko platform key != our chain ID) ----
  "binance-smart-chain": "bnb-chain",
  "optimistic-ethereum": "optimism",
  "zksync-era": "zksync",
  "the-open-network": "ton",
  "arbitrum-one": "arbitrum",
  "near-protocol": "near",
  "harmony-shard-0": "harmony",
  "hedera-hashgraph": "hedera",
  "sei-network": "sei",
  "internet-computer": "internet-computer",
} as const;

/**
 * Resolve one CoinGecko platform key to a canonical chain ID, or `null` when
 * no confident, verified mapping exists — never a guess, never a fabricated
 * `chains` row (AGENTS.md #6, #12).
 */
export function resolveCanonicalChainId(platformKey: string): string | null {
  const chainId = COINGECKO_PLATFORM_TO_CHAIN_ID[platformKey];
  if (!chainId) return null;
  // Defensive: even a typo'd mapping table entry can never produce an
  // invalid `chains` foreign key. See CANONICAL_CHAIN_IDS above.
  return CANONICAL_CHAIN_IDS.has(chainId) ? chainId : null;
}
