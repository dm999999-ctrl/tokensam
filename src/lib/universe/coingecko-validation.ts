// CoinGecko identity/market/supply validation (AGENTS.md #7). Every candidate
// already carries its seed `/coins/markets` row from discovery, so validating
// it costs no extra request; this module only interprets fields already
// fetched. Distinguishes "not found" from "provider unavailable" (AGENTS.md
// #25) and never treats a symbol match alone as a valid identity.

import type { CheckStatus, CoinGeckoMarketCandidate, UniverseCandidate } from "./types.ts";

export type CoinGeckoValidationResult = Pick<
  UniverseCandidate,
  "coingeckoStatus" | "coingeckoCheckedAt" | "coingeckoFailureReason" | "coingeckoHasMarketData" | "coingeckoHasSupplyData" | "marketCapRank"
>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate one candidate's already-fetched `/coins/markets` record. */
export function validateCoinGeckoCandidate(market: CoinGeckoMarketCandidate, checkedAt: string): CoinGeckoValidationResult {
  if (!market.id || !market.symbol || !market.name) {
    return {
      coingeckoStatus: "fail",
      coingeckoCheckedAt: checkedAt,
      coingeckoFailureReason: "COINGECKO_METADATA_INCOMPLETE",
      coingeckoHasMarketData: false,
      coingeckoHasSupplyData: false,
      marketCapRank: market.market_cap_rank ?? null,
    };
  }

  const hasMarketData = isFiniteNumber(market.current_price) && isFiniteNumber(market.market_cap) && market.market_cap! > 0;
  const hasSupplyData = isFiniteNumber(market.circulating_supply) && market.circulating_supply! > 0;

  return {
    coingeckoStatus: hasMarketData ? "pass" : "fail",
    coingeckoCheckedAt: checkedAt,
    coingeckoFailureReason: hasMarketData ? null : "COINGECKO_METADATA_INCOMPLETE",
    coingeckoHasMarketData: hasMarketData,
    coingeckoHasSupplyData: hasSupplyData,
    marketCapRank: market.market_cap_rank ?? null,
  };
}

/** A candidate whose CoinGecko ID no longer resolves at all (distinct from incomplete metadata). */
export function coinGeckoNotFound(checkedAt: string): CoinGeckoValidationResult {
  return {
    coingeckoStatus: "fail",
    coingeckoCheckedAt: checkedAt,
    coingeckoFailureReason: "COINGECKO_NOT_FOUND",
    coingeckoHasMarketData: false,
    coingeckoHasSupplyData: false,
    marketCapRank: null,
  };
}

/** A provider-wide outage (network error, 429, 5xx): never a permanent failure (AGENTS.md #25). */
export function coinGeckoUnavailable(checkedAt: string, detail: string): CoinGeckoValidationResult {
  return {
    coingeckoStatus: "temporarily_unavailable" as CheckStatus,
    coingeckoCheckedAt: checkedAt,
    coingeckoFailureReason: `COINGECKO_UNAVAILABLE: ${detail}`,
    coingeckoHasMarketData: null,
    coingeckoHasSupplyData: null,
    marketCapRank: null,
  };
}
