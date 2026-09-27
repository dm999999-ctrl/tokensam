// Supply / reference-data sufficiency (AGENTS.md #18). Uses only fields
// already present on the candidate's `/coins/markets` record (no invented
// values, no redesign of the existing FDV methodology in
// src/lib/data/token-logos.ts, which trusts CoinGecko's own reported FDV
// rather than computing one). Circulating supply is what the existing
// Dashboard actually displays (`DashboardToken.circulatingSupply`); market cap
// and reported FDV are the fallback size references it can otherwise show.

import type { SupplyStatus, UniverseCandidate } from "./types.ts";

export type SupplyCheckInput = {
  hasMarketCap: boolean;
  circulatingSupply: number | null | undefined;
  totalSupply: number | null | undefined;
  maxSupply: number | null | undefined;
  reportedFdv: number | null | undefined;
};

export type SupplyCheckResult = Pick<
  UniverseCandidate,
  "supplyStatus" | "hasCirculatingSupply" | "hasTotalSupply" | "hasMaxSupply" | "hasReportedFdv" | "supplyCheckedAt" | "supplyFailureReason"
>;

function isPositiveFinite(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function evaluateSupplyData(input: SupplyCheckInput, checkedAt: string): SupplyCheckResult {
  const hasCirculatingSupply = isPositiveFinite(input.circulatingSupply);
  const hasTotalSupply = isPositiveFinite(input.totalSupply);
  const hasMaxSupply = isPositiveFinite(input.maxSupply);
  const hasReportedFdv = typeof input.reportedFdv === "number" && Number.isFinite(input.reportedFdv) && input.reportedFdv >= 0;

  let status: SupplyStatus;
  if (hasCirculatingSupply) {
    status = "pass";
  } else if (input.hasMarketCap || hasReportedFdv) {
    // A size reference exists (market cap or reported FDV), but the Dashboard's
    // own circulating-supply figure would be unavailable for this candidate.
    status = "needs_review";
  } else {
    status = "fail";
  }

  return {
    supplyStatus: status,
    hasCirculatingSupply,
    hasTotalSupply,
    hasMaxSupply,
    hasReportedFdv,
    supplyCheckedAt: checkedAt,
    supplyFailureReason: status === "pass" ? null : "SUPPLY_DATA_INSUFFICIENT",
  };
}
