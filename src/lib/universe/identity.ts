// Identity-collision protection (AGENTS.md #6, #12). A CoinGecko ID is already
// a strong, unique identity for a candidate row; what is genuinely ambiguous
// is mapping a *Binance* base-asset symbol back to the right candidate when
// several candidates in the pool share that ticker. This module resolves that,
// and only that. "Unresolved" is always preferred over a guessed match.

import { universeBinanceSymbolOverrides } from "../../data/universe-binance-symbol-overrides.ts";
import type { IdentityStatus, UniverseCandidate } from "./types.ts";

export type SymbolIndex = Map<string, UniverseCandidate[]>;

/** Group candidates by upper-case symbol so collisions can be detected in one pass. */
export function buildSymbolIndex(candidates: UniverseCandidate[]): SymbolIndex {
  const index: SymbolIndex = new Map();
  for (const candidate of candidates) {
    const key = candidate.symbol.toUpperCase();
    const group = index.get(key);
    if (group) group.push(candidate);
    else index.set(key, [candidate]);
  }
  return index;
}

export type IdentityResolution = {
  status: IdentityStatus;
  evidence: Record<string, unknown>;
};

/**
 * Resolve one candidate's identity strength for external (Binance) mapping.
 * - A symbol unique within the pool is confidently this candidate's own.
 * - A colliding symbol is resolved only via a hand-verified curated override.
 * - Anything else is left `unresolved`, never guessed.
 */
export function resolveCandidateIdentity(candidate: UniverseCandidate, symbolIndex: SymbolIndex): IdentityResolution {
  const symbol = candidate.symbol.toUpperCase();
  const siblings = symbolIndex.get(symbol) ?? [candidate];

  if (siblings.length <= 1) {
    return { status: "valid", evidence: { method: "unique_symbol_in_pool", symbol } };
  }

  const overrideCoingeckoId = universeBinanceSymbolOverrides[symbol];
  if (overrideCoingeckoId && overrideCoingeckoId === candidate.coingeckoId) {
    return { status: "valid", evidence: { method: "curated_override", symbol, overrideCoingeckoId } };
  }

  return {
    status: "collision",
    evidence: {
      method: "unresolved_symbol_collision",
      symbol,
      collidingCoingeckoIds: siblings.map((sibling) => sibling.coingeckoId).sort(),
    },
  };
}
