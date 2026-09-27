// Phase A candidate-universe types. See AGENTS.md for the full specification;
// this module is the shared vocabulary every Phase A module imports from.

/** Structural state of a candidate row, independent of eligibility (AGENTS.md #22). */
export type UniverseStatus = "candidate" | "canonical" | "duplicate" | "deprecated" | "migrated" | "needs_review";

/** Outcome of a single hard-requirement check (AGENTS.md #25: outages are never permanent failures). */
export type CheckStatus = "pass" | "fail" | "temporarily_unavailable";

export type SupplyStatus = "pass" | "needs_review" | "fail";

/** Final Phase A decision for a candidate (AGENTS.md #19-#20). Never a ranking. */
export type EligibilityStatus = "eligible" | "ineligible" | "needs_review" | "temporarily_unavailable";

export type IdentityStatus = "valid" | "collision" | "unresolved";

export type BinanceMarketType = "spot" | "futures_only" | "none";

export type BinanceResolutionMethod =
  | "direct_usdt"
  | "direct_usdc"
  | "approved_stable"
  | "btc_route"
  | "eth_route"
  | "unresolved";

export type LogoSource = "coingecko" | "binance" | "existing" | "unavailable";

/** Explicit, deterministic reason codes (AGENTS.md #19: never vague labels). */
export const REASON_CODES = [
  "COINGECKO_NOT_FOUND",
  "COINGECKO_UNAVAILABLE",
  "COINGECKO_METADATA_INCOMPLETE",
  "BINANCE_SPOT_NOT_FOUND",
  "BINANCE_NOT_TRADING",
  "BINANCE_FUTURES_ONLY",
  "BINANCE_UNAVAILABLE",
  "IDENTITY_UNRESOLVED",
  "IDENTITY_COLLISION",
  "DUPLICATE_ASSET",
  "DEPRECATED_ASSET",
  "MIGRATED_ASSET",
  "HISTORICAL_DATA_INSUFFICIENT",
  "HISTORICAL_DATA_UNAVAILABLE",
  "LOGO_UNAVAILABLE",
  "LOGO_UNVERIFIED",
  "SUPPLY_DATA_INSUFFICIENT",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** One row of `universe_candidates`, in application (camelCase) form. */
export type UniverseCandidate = {
  id: number | null;
  coingeckoId: string;
  symbol: string;
  name: string;
  chainId: string | null;
  contractAddress: string | null;
  isNative: boolean;
  tokenId: string | null;
  identityStatus: IdentityStatus;
  identityEvidence: Record<string, unknown>;

  universeStatus: UniverseStatus;
  duplicateOfId: number | null;
  migratedToCoingeckoId: string | null;
  statusReason: string | null;
  /**
   * Consecutive validation runs in which this candidate was confirmed absent
   * from CoinGecko's own `/coins/list` catalog (not merely outside this run's
   * ranked top-`poolSize` window). Reset to 0 the moment it reappears. A
   * single absence alone never marks a candidate deprecated (AGENTS.md #14,
   * #25) — see `duplicates.ts`.
   */
  absentFromSourceStreak: number;

  source: string;
  marketCapRank: number | null;
  discoveredAt: string;
  lastSeenInSourceAt: string | null;

  coingeckoStatus: CheckStatus | null;
  coingeckoCheckedAt: string | null;
  coingeckoFailureReason: string | null;
  coingeckoHasMarketData: boolean | null;
  coingeckoHasSupplyData: boolean | null;

  binanceStatus: CheckStatus | null;
  binanceSymbol: string | null;
  binanceBaseAsset: string | null;
  binanceQuoteAsset: string | null;
  binanceMarketStatus: string | null;
  binanceMarketType: BinanceMarketType | null;
  binanceResolutionMethod: BinanceResolutionMethod | null;
  binanceCheckedAt: string | null;
  binanceFailureReason: string | null;

  logoUrl: string | null;
  logoSource: LogoSource | null;
  logoVerified: boolean;
  logoStatus: CheckStatus | null;
  logoCheckedAt: string | null;
  logoFailureReason: string | null;

  historicalDataStatus: CheckStatus | null;
  historicalCoverageDays: number | null;
  historicalRequiredDays: number | null;
  historicalDataCheckedAt: string | null;
  historicalDataFailureReason: string | null;

  supplyStatus: SupplyStatus | null;
  hasCirculatingSupply: boolean | null;
  hasTotalSupply: boolean | null;
  hasMaxSupply: boolean | null;
  hasReportedFdv: boolean | null;
  supplyCheckedAt: string | null;
  supplyFailureReason: string | null;

  eligibilityStatus: EligibilityStatus | null;
  eligibilityReasonCodes: ReasonCode[];
  eligibilityCheckedAt: string | null;
  eligibilityConfigVersion: string | null;
};

/** A raw CoinGecko `/coins/markets` row, the seed for a new candidate. */
export type CoinGeckoMarketCandidate = {
  id: string;
  symbol: string;
  name: string;
  image?: string | null;
  market_cap_rank?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
  current_price?: number | null;
  market_cap?: number | null;
  fully_diluted_valuation?: number | null;
};

/** A raw CoinGecko `/coins/list?include_platform=true` row, used for chain/contract identity. */
export type CoinGeckoListEntry = {
  id: string;
  symbol: string;
  name: string;
  platforms?: Record<string, string | null>;
};

export function newCandidateFromMarket(market: CoinGeckoMarketCandidate, discoveredAt: string): UniverseCandidate {
  return {
    id: null,
    coingeckoId: market.id,
    symbol: market.symbol.toUpperCase(),
    name: market.name,
    chainId: null,
    contractAddress: null,
    isNative: false,
    tokenId: null,
    identityStatus: "unresolved",
    identityEvidence: {},

    universeStatus: "candidate",
    duplicateOfId: null,
    migratedToCoingeckoId: null,
    statusReason: null,
    absentFromSourceStreak: 0,

    source: "coingecko_markets",
    marketCapRank: market.market_cap_rank ?? null,
    discoveredAt,
    lastSeenInSourceAt: discoveredAt,

    coingeckoStatus: null,
    coingeckoCheckedAt: null,
    coingeckoFailureReason: null,
    coingeckoHasMarketData: null,
    coingeckoHasSupplyData: null,

    binanceStatus: null,
    binanceSymbol: null,
    binanceBaseAsset: null,
    binanceQuoteAsset: null,
    binanceMarketStatus: null,
    binanceMarketType: null,
    binanceResolutionMethod: null,
    binanceCheckedAt: null,
    binanceFailureReason: null,

    logoUrl: null,
    logoSource: null,
    logoVerified: false,
    logoStatus: null,
    logoCheckedAt: null,
    logoFailureReason: null,

    historicalDataStatus: null,
    historicalCoverageDays: null,
    historicalRequiredDays: null,
    historicalDataCheckedAt: null,
    historicalDataFailureReason: null,

    supplyStatus: null,
    hasCirculatingSupply: null,
    hasTotalSupply: null,
    hasMaxSupply: null,
    hasReportedFdv: null,
    supplyCheckedAt: null,
    supplyFailureReason: null,

    eligibilityStatus: null,
    eligibilityReasonCodes: [],
    eligibilityCheckedAt: null,
    eligibilityConfigVersion: null,
  };
}
