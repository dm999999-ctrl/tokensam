import { CoinGeckoApiError, retryAfterMs } from "./coingecko.ts";
import type { NormalizedObservation, ProviderAsset, ProviderSnapshot } from "./types.ts";

/**
 * CoinGecko historical market chart (GET /coins/{id}/market_chart).
 *
 * Per the official reference: with `days` 2-90 the API auto-selects hourly points;
 * `interval=daily` is documented as Enterprise-plan only, and Demo-tier requests
 * using it were observed failing intermittently with 401 (not tied to a specific
 * token), so it is never passed here -- granularity is left to auto-selection. The
 * arrays are [unix_ms, value] for prices, market_caps, and total_volumes (the
 * rolling 24-hour volume at that time). Used only by the manual, bounded backfill.
 */

export const BACKFILL_ENDPOINT_LABEL = "GET /coins/{id}/market_chart (days=90 auto-hourly; days=7 hourly)";
const MAX_ATTEMPTS = 3;
const SERIES: { field: "prices" | "market_caps" | "total_volumes"; metricId: string }[] = [
  { field: "prices", metricId: "price_usd" },
  { field: "market_caps", metricId: "market_cap_usd" },
  { field: "total_volumes", metricId: "volume_24h_usd" },
];

export type MarketChartPayload = {
  prices?: unknown;
  market_caps?: unknown;
  total_volumes?: unknown;
};

export async function fetchMarketChart(
  coinId: string,
  query: { days: number; interval?: "daily" },
  options: { apiKey: string; baseUrl: string; keyHeader: string; fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void> },
): Promise<MarketChartPayload> {
  const url = new URL(`${options.baseUrl}/coins/${encodeURIComponent(coinId)}/market_chart`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(query.days));
  if (query.interval) url.searchParams.set("interval", query.interval);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { [options.keyHeader]: options.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new CoinGeckoApiError("CoinGecko history request failed due to a network error.", null);
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CoinGeckoApiError("CoinGecko returned an unexpected market chart response.", response.status);
      }
      return payload as MarketChartPayload;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new CoinGeckoApiError(`CoinGecko market chart returned HTTP ${response.status}.`, response.status);
    }
    const fallbackMs = 500 * 2 ** (attempt - 1);
    await options.sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), fallbackMs) : fallbackMs);
  }
  throw new CoinGeckoApiError("CoinGecko market chart request exhausted its retry limit.", null);
}

function pairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length >= 2
    && typeof pair[0] === "number" && Number.isFinite(pair[0]) && typeof pair[1] === "number" && Number.isFinite(pair[1]));
}

/**
 * Convert market chart payloads into historical observations for one asset.
 *
 * - Only numeric points become observations; missing or non-numeric points are
 *   skipped (never zero-filled). A numeric 0 is kept, as in the live collector.
 * - Provider timestamps are kept as observed_at; collection time is separate.
 * - Points at or after `notAfter` (the newest stored observation for that
 *   metric) are excluded, so backfill never supersedes live refresh data.
 * - Points whose timestamp is already stored (`existing`) are excluded, and a
 *   timestamp appearing in both the daily and hourly responses is kept once.
 */
export function normalizeMarketChartHistory(input: {
  asset: ProviderAsset;
  daily: MarketChartPayload;
  hourly: MarketChartPayload;
  collectedAt: string;
  notAfter: Partial<Record<string, string>>;
  existing: Set<string>;
}): ProviderSnapshot | null {
  const observations: NormalizedObservation[] = [];
  for (const { field, metricId } of SERIES) {
    const cutoff = input.notAfter[metricId] ? Date.parse(input.notAfter[metricId]!) : Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    for (const [source, granularity] of [[input.daily, "daily"], [input.hourly, "hourly"]] as const) {
      for (const [timeMs, value] of pairs(source[field])) {
        const observedAt = new Date(timeMs).toISOString();
        const key = `${metricId}|${observedAt}`;
        if (timeMs >= cutoff || seen.has(key) || input.existing.has(key)) continue;
        seen.add(key);
        observations.push({
          tokenId: input.asset.tokenId,
          chainId: input.asset.chainId,
          metricId,
          value,
          status: "available",
          observedAt,
          collectedAt: input.collectedAt,
          windowDays: null,
          scope: "token",
          sourceField: `market_chart.${field}`,
          note: `CoinGecko historical market_chart point (${granularity} granularity), backfilled with the provider timestamp.`,
        });
      }
    }
  }
  if (observations.length === 0) return null;
  const observedTimes = observations.map((observation) => observation.observedAt).sort();
  return {
    providerId: "coingecko",
    endpointLabel: BACKFILL_ENDPOINT_LABEL,
    asset: input.asset,
    observedAt: observedTimes.at(-1)!,
    collectedAt: input.collectedAt,
    rawPayload: {
      request: { daily: { days: 90 }, hourly: { days: 7 } },
      daily: { prices: pairs(input.daily.prices), market_caps: pairs(input.daily.market_caps), total_volumes: pairs(input.daily.total_volumes) },
      hourly: { prices: pairs(input.hourly.prices), market_caps: pairs(input.hourly.market_caps), total_volumes: pairs(input.hourly.total_volumes) },
      retentionNote: "CoinGecko market_chart arrays as returned for this backfill (numeric pairs only).",
    },
    observations,
  };
}
