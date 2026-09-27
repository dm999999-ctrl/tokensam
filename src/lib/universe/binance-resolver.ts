// Binance Spot resolution (AGENTS.md #8, #11). Applies the preferred quote
// hierarchy, hard-separates Spot from Futures, and never assigns a market to
// a candidate whose symbol identity is not already confidently resolved
// (identity.ts) — a false match is worse than an unresolved token.

import type { BinanceMarketSnapshot, BinanceSpotSymbol } from "./binance-client.ts";
import { isSpotTradable } from "./binance-client.ts";
import type { UniverseEligibilityConfig } from "./config.ts";
import type { BinanceResolutionMethod, IdentityStatus, UniverseCandidate } from "./types.ts";

export type BinanceResolutionResult = Pick<
  UniverseCandidate,
  "binanceStatus" | "binanceSymbol" | "binanceBaseAsset" | "binanceQuoteAsset" | "binanceMarketStatus" | "binanceMarketType" | "binanceResolutionMethod" | "binanceCheckedAt" | "binanceFailureReason"
>;

/** Only the fields an outage actually changes; a previously-resolved mapping is never overwritten by a temporary failure (AGENTS.md #10, #25). */
export type BinanceOutageResult = Pick<UniverseCandidate, "binanceStatus" | "binanceCheckedAt" | "binanceFailureReason">;

function resolutionMethodForQuote(quote: string, priority: string[]): BinanceResolutionMethod {
  if (quote === "USDT") return "direct_usdt";
  if (quote === "USDC") return "direct_usdc";
  if (priority.includes(quote)) return "approved_stable";
  return "unresolved";
}

/**
 * Resolve one candidate's Binance Spot market. Requires the caller to have
 * already resolved symbol identity (identity.ts); pass its status in so a
 * collision never silently becomes a confident Binance mapping.
 */
export function resolveBinanceSpot(
  candidate: Pick<UniverseCandidate, "symbol">,
  identityStatus: IdentityStatus,
  snapshot: BinanceMarketSnapshot,
  config: UniverseEligibilityConfig,
  checkedAt: string,
): BinanceResolutionResult | null {
  if (identityStatus !== "valid") return null;

  const symbol = candidate.symbol.toUpperCase();
  const matches = snapshot.spotByBaseAsset.get(symbol) ?? [];
  const tradableMatches = matches.filter(isSpotTradable);

  for (const quote of config.binanceQuotePriority) {
    const match = tradableMatches.find((entry) => entry.quoteAsset === quote);
    if (match) return pass(match, resolutionMethodForQuote(quote, config.binanceQuotePriority), checkedAt);
  }

  const btcMatch = tradableMatches.find((entry) => entry.quoteAsset === config.binanceRouteQuotes.btc);
  if (btcMatch && snapshot.btcUsdtTradable) return pass(btcMatch, "btc_route", checkedAt);

  const ethMatch = tradableMatches.find((entry) => entry.quoteAsset === config.binanceRouteQuotes.eth);
  if (ethMatch && snapshot.ethUsdtTradable) return pass(ethMatch, "eth_route", checkedAt);

  if (matches.length > 0) {
    // A Spot symbol exists for this base asset, but none of its markets are
    // currently tradable through an approved route.
    const reference = matches[0];
    return {
      binanceStatus: "fail",
      binanceSymbol: reference.symbol,
      binanceBaseAsset: reference.baseAsset,
      binanceQuoteAsset: reference.quoteAsset,
      binanceMarketStatus: reference.status,
      binanceMarketType: "spot",
      binanceResolutionMethod: "unresolved",
      binanceCheckedAt: checkedAt,
      binanceFailureReason: "BINANCE_NOT_TRADING",
    };
  }

  if (snapshot.futuresBaseAssets.has(symbol)) {
    return {
      binanceStatus: "fail",
      binanceSymbol: null,
      binanceBaseAsset: symbol,
      binanceQuoteAsset: null,
      binanceMarketStatus: null,
      binanceMarketType: "futures_only",
      binanceResolutionMethod: "unresolved",
      binanceCheckedAt: checkedAt,
      binanceFailureReason: "BINANCE_FUTURES_ONLY",
    };
  }

  return {
    binanceStatus: "fail",
    binanceSymbol: null,
    binanceBaseAsset: null,
    binanceQuoteAsset: null,
    binanceMarketStatus: null,
    binanceMarketType: "none",
    binanceResolutionMethod: "unresolved",
    binanceCheckedAt: checkedAt,
    binanceFailureReason: "BINANCE_SPOT_NOT_FOUND",
  };
}

function pass(match: BinanceSpotSymbol, method: BinanceResolutionMethod, checkedAt: string): BinanceResolutionResult {
  return {
    binanceStatus: "pass",
    binanceSymbol: match.symbol,
    binanceBaseAsset: match.baseAsset,
    binanceQuoteAsset: match.quoteAsset,
    binanceMarketStatus: match.status,
    binanceMarketType: "spot",
    binanceResolutionMethod: method,
    binanceCheckedAt: checkedAt,
    binanceFailureReason: null,
  };
}

/**
 * A provider-wide Binance outage: temporarily_unavailable, never a hard
 * failure (AGENTS.md #25). Deliberately touches only status/timestamp/reason
 * — a candidate's previously-resolved Spot mapping (symbol, base/quote asset,
 * resolution method) is Phase E's mapping infrastructure (AGENTS.md #10) and
 * must survive a transient outage untouched, not be nulled out.
 */
export function binanceUnavailable(checkedAt: string, detail: string): BinanceOutageResult {
  return {
    binanceStatus: "temporarily_unavailable",
    binanceCheckedAt: checkedAt,
    binanceFailureReason: `BINANCE_UNAVAILABLE: ${detail}`,
  };
}
