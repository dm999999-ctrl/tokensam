// Historical-data eligibility (AGENTS.md #17). Reuses the CoinGecko
// market-chart endpoint the way the existing backfill script does
// (docs/historical-data.md); the required minimum is centralized config
// (config.ts), not invented here. This is the one Phase A check that costs a
// network request per candidate (CoinGecko has no batch history endpoint), so
// the orchestrator only runs it for candidates that already passed the
// cheaper CoinGecko/identity checks (AGENTS.md #33).

import type { CoinGeckoConfig } from "./coingecko-discovery.ts";
import { fetchJsonWithRetry, ProviderOutageError, type Sleep } from "./http.ts";
import type { CheckStatus, UniverseCandidate } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_COVERAGE_RATIO = 0.9;

export type MarketChartResponse = { prices?: [number, number][] };

export async function fetchMarketChart(
  coingeckoId: string,
  requiredDays: number,
  config: CoinGeckoConfig,
  options: { fetchImpl: typeof fetch; sleep: Sleep },
): Promise<MarketChartResponse> {
  const url = new URL(`${config.baseUrl}/coins/${encodeURIComponent(coingeckoId)}/market_chart`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(Math.max(requiredDays, 90)));
  url.searchParams.set("interval", "daily");
  return fetchJsonWithRetry<MarketChartResponse>(
    url,
    { method: "GET", headers: { [config.keyHeader]: config.apiKey, accept: "application/json" } },
    { ...options, label: "CoinGecko /coins/{id}/market_chart" },
  );
}

export type HistoricalCheckResult = Pick<
  UniverseCandidate,
  "historicalDataStatus" | "historicalCoverageDays" | "historicalRequiredDays" | "historicalDataCheckedAt" | "historicalDataFailureReason"
>;

/** Coverage span in days between the earliest and latest stored/returned price point. */
export function coverageDays(prices: [number, number][] | undefined): number {
  if (!prices || prices.length < 2) return 0;
  const timestamps = prices.map(([timestamp]) => timestamp);
  return (Math.max(...timestamps) - Math.min(...timestamps)) / DAY_MS;
}

export function evaluateHistoricalCoverage(prices: [number, number][] | undefined, requiredDays: number, checkedAt: string): HistoricalCheckResult {
  const days = coverageDays(prices);
  if (!prices || prices.length === 0) {
    return {
      historicalDataStatus: "fail",
      historicalCoverageDays: 0,
      historicalRequiredDays: requiredDays,
      historicalDataCheckedAt: checkedAt,
      historicalDataFailureReason: "HISTORICAL_DATA_UNAVAILABLE",
    };
  }
  const sufficient = days >= requiredDays * FULL_COVERAGE_RATIO;
  return {
    historicalDataStatus: sufficient ? "pass" : "fail",
    historicalCoverageDays: Math.round(days * 100) / 100,
    historicalRequiredDays: requiredDays,
    historicalDataCheckedAt: checkedAt,
    historicalDataFailureReason: sufficient ? null : "HISTORICAL_DATA_INSUFFICIENT",
  };
}

export function historicalUnavailable(requiredDays: number, checkedAt: string, detail: string): HistoricalCheckResult {
  return {
    historicalDataStatus: "temporarily_unavailable" as CheckStatus,
    historicalCoverageDays: null,
    historicalRequiredDays: requiredDays,
    historicalDataCheckedAt: checkedAt,
    historicalDataFailureReason: `COINGECKO_UNAVAILABLE: ${detail}`,
  };
}

/** Fetch + evaluate one candidate's historical coverage, translating an outage into `temporarily_unavailable`. */
export async function checkHistoricalData(
  coingeckoId: string,
  requiredDays: number,
  config: CoinGeckoConfig,
  options: { fetchImpl: typeof fetch; sleep: Sleep; now?: () => Date },
): Promise<HistoricalCheckResult> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    const chart = await fetchMarketChart(coingeckoId, requiredDays, config, options);
    return evaluateHistoricalCoverage(chart.prices, requiredDays, checkedAt);
  } catch (error) {
    if (error instanceof ProviderOutageError) return historicalUnavailable(requiredDays, checkedAt, error.message);
    throw error;
  }
}
