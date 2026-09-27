// The deterministic Phase A eligibility engine (AGENTS.md #19-#21, #25).
// Evaluates every configured hard requirement independently and combines them
// with a fixed, documented priority so the same inputs always produce the
// same output: a genuine hard failure always wins (`ineligible`); absent that,
// any provider outage keeps the candidate `temporarily_unavailable` rather
// than destroying it; absent that, an unresolved identity or a
// needs-review-grade check keeps it `needs_review`; only then is a candidate
// `eligible`. No market-quality, liquidity, or popularity signal appears here
// (AGENTS.md #20) — those belong to Phase B/C/D.

import { CONFIG_VERSION, type UniverseEligibilityConfig } from "./config.ts";
import type { EligibilityStatus, ReasonCode, UniverseCandidate } from "./types.ts";

export type EligibilityResult = Pick<UniverseCandidate, "eligibilityStatus" | "eligibilityReasonCodes" | "eligibilityCheckedAt" | "eligibilityConfigVersion">;

export function evaluateEligibility(
  candidate: UniverseCandidate,
  config: UniverseEligibilityConfig,
  checkedAt: string,
): EligibilityResult {
  const reasons: ReasonCode[] = [];
  let hardFail = false;
  let temporary = false;
  let needsReview = false;

  // ---- Universe status: duplicate / deprecated / migrated ----
  if (config.requireNotDuplicate && candidate.universeStatus === "duplicate") {
    reasons.push("DUPLICATE_ASSET");
    hardFail = true;
  }
  if (config.requireNotDeprecated && candidate.universeStatus === "deprecated") {
    reasons.push("DEPRECATED_ASSET");
    hardFail = true;
  }
  if (config.requireNotDeprecated && candidate.universeStatus === "migrated") {
    reasons.push("MIGRATED_ASSET");
    hardFail = true;
  }

  // ---- Identity: a collision or unresolved symbol is never guessed past (AGENTS.md #12) ----
  if (config.requireIdentityResolved && candidate.identityStatus !== "valid") {
    reasons.push(candidate.identityStatus === "collision" ? "IDENTITY_COLLISION" : "IDENTITY_UNRESOLVED");
    needsReview = true;
  }

  // ---- CoinGecko (AGENTS.md #7) ----
  if (config.requireCoinGecko) {
    if (candidate.coingeckoStatus === "fail") {
      reasons.push((candidate.coingeckoFailureReason as ReasonCode | null) ?? "COINGECKO_NOT_FOUND");
      hardFail = true;
    } else if (candidate.coingeckoStatus === "temporarily_unavailable") {
      reasons.push("COINGECKO_UNAVAILABLE");
      temporary = true;
    } else if (candidate.coingeckoStatus === null) {
      reasons.push("COINGECKO_NOT_FOUND");
      hardFail = true;
    }
  }

  // ---- Binance Spot (AGENTS.md #8, #11); only meaningful once identity resolved ----
  if (config.requireBinanceSpot && candidate.identityStatus === "valid") {
    if (candidate.binanceStatus === "fail") {
      const reason = candidate.binanceFailureReason;
      if (reason === "BINANCE_NOT_TRADING" && !config.requireTradingStatus) {
        reasons.push("BINANCE_NOT_TRADING" as ReasonCode);
        needsReview = true;
      } else {
        reasons.push((reason as ReasonCode | null) ?? "BINANCE_SPOT_NOT_FOUND");
        hardFail = true;
      }
    } else if (candidate.binanceStatus === "temporarily_unavailable") {
      reasons.push("BINANCE_UNAVAILABLE");
      temporary = true;
    }
  }

  // ---- Logo (AGENTS.md #15-#16) ----
  if (config.requireLogo && candidate.logoStatus !== null) {
    if (candidate.logoStatus === "fail") {
      reasons.push("LOGO_UNAVAILABLE");
      hardFail = true;
    } else if (candidate.logoStatus === "temporarily_unavailable") {
      reasons.push("LOGO_UNVERIFIED");
      temporary = true;
    }
  }

  // ---- Historical data (AGENTS.md #17) ----
  if (config.requireHistoricalData && candidate.historicalDataStatus !== null) {
    if (candidate.historicalDataStatus === "fail") {
      reasons.push((candidate.historicalDataFailureReason as ReasonCode | null) ?? "HISTORICAL_DATA_INSUFFICIENT");
      hardFail = true;
    } else if (candidate.historicalDataStatus === "temporarily_unavailable") {
      reasons.push("COINGECKO_UNAVAILABLE");
      temporary = true;
    }
  }

  // ---- Supply / reference data (AGENTS.md #18) ----
  if (config.requireSupplyData && candidate.supplyStatus !== null) {
    if (candidate.supplyStatus === "fail") {
      reasons.push("SUPPLY_DATA_INSUFFICIENT");
      hardFail = true;
    } else if (candidate.supplyStatus === "needs_review") {
      reasons.push("SUPPLY_DATA_INSUFFICIENT");
      needsReview = true;
    }
  }

  const status: EligibilityStatus = hardFail ? "ineligible" : temporary ? "temporarily_unavailable" : needsReview ? "needs_review" : "eligible";

  return {
    eligibilityStatus: status,
    eligibilityReasonCodes: [...new Set(reasons)],
    eligibilityCheckedAt: checkedAt,
    eligibilityConfigVersion: CONFIG_VERSION,
  };
}
