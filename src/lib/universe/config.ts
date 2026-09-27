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
  /**
   * Consecutive validation runs a previously-tracked candidate must be
   * confirmed absent from CoinGecko's own `/coins/list` catalog (never merely
   * outside this run's ranked pool window) before it is marked `deprecated`.
   * A single absence is `needs_review`, not a permanent exclusion (AGENTS.md
   * #14, #25) — a false "delisted" claim is as harmful as a false match.
   */
  absenceConfirmationThreshold: number;
};

export const CONFIG_VERSION = "phase-a-v2";

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
  // AGENTS.md #17 asks what the *existing* app already considers sufficient
  // for "historical price charts, volume charts, risk calculations, and
  // technical analysis" — not a newly-invented number. The binding constraint
  // turns out to be Technical Analysis, not the chart periods: every
  // indicator in src/lib/indicators/catalog.ts declares its own daily-close
  // requirement (`minPoints`), and MACD (12, 26, 9) needs the most, 61
  // ("2 x 26 + 9 = 61 closes" — see its `formula`). A candidate with fewer
  // than that cannot run the full existing TA suite the Dashboard already
  // ships, so 61 days is the floor here, not 30 (which was this constant's
  // first, too-lenient value before a live-validation review of the actual TA
  // catalog corrected it). It is configurable here, not re-derived elsewhere.
  historicalRequiredDays: 61,
  // Direct stablecoin pairs are preferred over intermediary routes (AGENTS.md #8).
  binanceQuotePriority: ["USDT", "USDC", "FDUSD", "TUSD", "USDP"],
  binanceRouteQuotes: { btc: "BTC", eth: "ETH" },
  candidatePoolSize: 2500,
  absenceConfirmationThreshold: 3,
};

/** Binance base assets that resolve the BTC/ETH conversion routes; excluded from being treated as ordinary candidates' routes. */
export const BINANCE_ROUTE_CONVERSION_PAIRS = ["BTCUSDT", "ETHUSDT"];

/** Bounded concurrency for provider calls that are one-request-per-candidate (AGENTS.md #33). */
export const HISTORICAL_CHECK_CONCURRENCY = 5;
export const HISTORICAL_CHECK_MIN_INTERVAL_MS = 1_100;
export const LOGO_VERIFY_CONCURRENCY = 8;
