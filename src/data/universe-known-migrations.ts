/**
 * Curated migration/deprecation overrides for Phase A (AGENTS.md #14).
 *
 * CoinGecko sometimes keeps a superseded coin's own ID listed (with its own
 * market data) even after a rebrand/migration, so the "no longer present in
 * the latest catalog" heuristic in duplicates.ts cannot detect it. These are
 * exceptions that must be verified by hand against CoinGecko's own catalog
 * before being added; nothing here is inferred from a symbol match.
 *
 * A migrated candidate keeps its stored data (AGENTS.md #30) and is simply
 * given universeStatus "migrated" pointing at the replacement CoinGecko ID.
 */
export const universeKnownMigrations: Record<string, { migratedToCoingeckoId: string; reason: string }> = {
  "matic-network": {
    migratedToCoingeckoId: "polygon-ecosystem-token",
    reason: "MATIC migrated to POL (Polygon Ecosystem Token) in the 2024 Polygon token migration.",
  },
  "terra-luna": {
    migratedToCoingeckoId: "terra-luna-2",
    reason: "Original Terra LUNA was superseded by Terra 2.0 (LUNA) after the May 2022 depeg/fork; CoinGecko lists the original chain's asset separately (renamed LUNC).",
  },
};

/**
 * Assets that are no longer viable Active-universe candidates even though
 * CoinGecko may still list them, verified by hand (never inferred from price
 * or volume alone; see AGENTS.md #28 on not using market-quality signals here).
 */
export const universeKnownDeprecations: Record<string, string> = {
  "ftx-token": "FTX exchange ceased operations in November 2022; FTT is not a viable Spot-market candidate.",
};
