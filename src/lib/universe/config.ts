// Centralized Phase A configuration (AGENTS.md #21). Every eligibility rule,
// threshold and provider preference lives here; no module hard-codes its own
// copy. Market-quality thresholds (volume, spread, depth) belong to Phase B
// and are deliberately absent.

/** Toggle which hard requirements the eligibility engine enforces. */
export type UniverseEligibilityConfig = {
  requireCoinGecko: boolean;
  requireBinanceSpot: boolean;
  requireTradingStatus: boolean;
  requireIdentityResolved: boolean;
  requireNotDuplicate: boolean;
  requireNotDeprecated: boolean;
  requireLogo: boolean;
  requireHistoricalData: boolean;
  requireSupplyData: boolean;
  /** Minimum days of stored/available historical price coverage (AGENTS.md #17). */
  historicalRequiredDays: number;
  /** Binance quote assets, in preferred order, tried before the BTC/ETH routes (AGENTS.md #8). */
  binanceQuotePriority: string[];
  /** Binance base assets whose USDT/USDC market is itself the BTC/ETH conversion leg. */
  binanceRouteQuotes: { btc: string; eth: string };
  /** Target size of the candidate pool Phase A builds (AGENTS.md #4). Configurable, never fixed at 1,000. */
  candidatePoolSize: number;
};

export const CONFIG_VERSION = "phase-a-v1";

export const DEFAULT_ELIGIBILITY_CONFIG: UniverseEligibilityConfig = {
  requireCoinGecko: true,
  requireBinanceSpot: true,
  requireTradingStatus: true,
  requireIdentityResolved: true,
  requireNotDuplicate: true,
  requireNotDeprecated: true,
  requireLogo: true,
  requireHistoricalData: true,
  requireSupplyData: true,
  // The dashboard's longest chart period is 90D (docs/historical-data.md), but its
  // shortest metric baseline that already gates a displayed number is "TVL - 30d",
  // which needs an observation 30-33 days old. 30 days is therefore the minimum a
  // candidate needs before any existing Dashboard metric can treat it as covered;
  // it is configurable here, not re-derived elsewhere.
  historicalRequiredDays: 30,
  // Direct stablecoin pairs are preferred over intermediary routes (AGENTS.md #8).
  binanceQuotePriority: ["USDT", "USDC", "FDUSD", "TUSD", "USDP"],
  binanceRouteQuotes: { btc: "BTC", eth: "ETH" },
  candidatePoolSize: 2500,
};

/** Binance base assets that resolve the BTC/ETH conversion routes; excluded from being treated as ordinary candidates' routes. */
export const BINANCE_ROUTE_CONVERSION_PAIRS = ["BTCUSDT", "ETHUSDT"];

/** Bounded concurrency for provider calls that are one-request-per-candidate (AGENTS.md #33). */
export const HISTORICAL_CHECK_CONCURRENCY = 5;
export const HISTORICAL_CHECK_MIN_INTERVAL_MS = 1_100;
export const LOGO_VERIFY_CONCURRENCY = 8;
