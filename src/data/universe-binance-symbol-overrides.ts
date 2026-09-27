/**
 * Curated resolution for Binance base-asset symbols that collide across more
 * than one CoinGecko candidate in the pool (AGENTS.md #12).
 *
 * A symbol collision is resolved automatically only when a human has verified,
 * against Binance's own exchange metadata and CoinGecko's coin identity, which
 * candidate the Binance market actually represents. Everything else stays
 * `needs_review` rather than guessing — "a false match is worse than an
 * unresolved token" (AGENTS.md #12). Keys are upper-case Binance base assets.
 *
 * Empty by default: no collision in the current candidate pool has been
 * manually verified yet. Add entries only after checking both providers.
 */
export const universeBinanceSymbolOverrides: Record<string, string> = {};
