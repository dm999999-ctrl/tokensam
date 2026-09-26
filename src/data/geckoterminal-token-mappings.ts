import { dexScreenerTokenMappings } from "./dexscreener-token-mappings.ts";

export type GeckoTerminalTokenMapping = {
  tokenId: string;
  canonicalChainId: string;
  /** GeckoTerminal's own network slug (distinct from DEX Screener's chain IDs and CoinGecko asset platform IDs). */
  gtNetwork: string | null;
  tokenAddress: string | null;
  identityNote: string;
  unmappedReason?: string;
};

/**
 * Canonical chain -> GeckoTerminal network slug. GeckoTerminal's public API
 * (https://api.geckoterminal.com/api/v2) has no `/coins/list`-style catalog
 * to programmatically verify slugs against, and this environment's network
 * policy blocks live calls to api.geckoterminal.com, so only network slugs
 * that are long-standing, widely documented GeckoTerminal identifiers are
 * included here. A chain not listed here stays unmapped rather than guessing
 * an unverified slug; identity is never inferred from a ticker or name.
 */
const GT_NETWORK_BY_CANONICAL_CHAIN: Record<string, string> = {
  ethereum: "eth",
  "bnb-chain": "bsc",
  avalanche: "avax",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  solana: "solana",
  polygon: "polygon_pos",
};

/**
 * GeckoTerminal indexes on-chain DEX activity by exact chain + contract
 * address, the same identity DEX Screener uses. Rather than re-deriving and
 * re-verifying contract addresses, this reuses the already-verified DEX
 * Screener contract mapping (see dexscreener-token-mappings.ts) and adds only
 * the GeckoTerminal network-slug translation. A token with no DEX Screener
 * address (native asset, or unmapped) has no GeckoTerminal mapping either,
 * for the same reason: GeckoTerminal has no token-contract identity for it.
 */
export const geckoTerminalTokenMappings: GeckoTerminalTokenMapping[] = dexScreenerTokenMappings.map((mapping) => {
  const gtNetwork = GT_NETWORK_BY_CANONICAL_CHAIN[mapping.canonicalChainId] ?? null;
  if (!mapping.tokenAddress) {
    return {
      tokenId: mapping.tokenId,
      canonicalChainId: mapping.canonicalChainId,
      gtNetwork: null,
      tokenAddress: null,
      identityNote: "",
      unmappedReason: mapping.unmappedReason ?? "No exact contract address is configured for this token; GeckoTerminal only indexes on-chain contract addresses.",
    };
  }
  if (!gtNetwork) {
    return {
      tokenId: mapping.tokenId,
      canonicalChainId: mapping.canonicalChainId,
      gtNetwork: null,
      tokenAddress: null,
      identityNote: "",
      unmappedReason: `GeckoTerminal's network slug for canonical chain "${mapping.canonicalChainId}" has not been verified (live API verification is blocked in this environment); an unverified slug is not guessed.`,
    };
  }
  return {
    tokenId: mapping.tokenId,
    canonicalChainId: mapping.canonicalChainId,
    gtNetwork,
    tokenAddress: mapping.tokenAddress,
    identityNote: `${mapping.identityNote} GeckoTerminal network "${gtNetwork}" mapped from canonical chain "${mapping.canonicalChainId}"; contract address reused unchanged from the verified DEX Screener mapping (same on-chain identity, different provider network slug).`,
  };
});
