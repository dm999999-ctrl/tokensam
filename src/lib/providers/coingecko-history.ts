import { CoinGeckoApiError, retryAfterMs } from "./coingecko.ts";
import type { NormalizedObservation, ProviderAsset, ProviderSnapshot } from "./types.ts";

/**
 * CoinGecko historical market chart (GET /coins/{id}/market_chart).
 *
 * This manual backfill is intentionally limited to the current rolling 30-day
 * granular window. Existing 30-90 day daily observations are not fetched,
 * modified, or regenerated.
 *
 * No timestamps are generated, retimed, interpolated, or synthesized.
 */
export const BACKFILL_ENDPOINT_LABEL = "GET /coins/{id}/market_chart (days=30, actual provider timestamps)";
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

function dailyPairs(value: unknown): [number, number][] {
  const points = pairs(value);
  const byDay = new Map<string, [number, number]>();
  for (const point of points) {
    const dayStart = new Date(point[0]);
    dayStart.setUTCHours(0, 0, 0, 0);
    const day = dayStart.toISOString().slice(0, 10);
    const previous = byDay.get(day);
    if (!previous || Math.abs(point[0] - dayStart.getTime()) < Math.abs(previous[0] - dayStart.getTime())) {
      byDay.set(day, point);
    }
  }
  return [...byDay.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Convert market chart payloads into historical observations for one asset.
 *
 * - Only numeric points become observations; missing or non-numeric points are
 *   skipped (never zero-filled). A numeric 0 is kept, as in the live collector.
 * - Provider timestamps are kept as observed_at; collection time is separate.
 * - Points at or after `notAfter` (the newest stored observation for that
 *   metric) are excluded, so backfill never supersedes live refresh data.
 * - Points whose timestamp is already stored (`existing`) are excluded.
 */
export function normalizeMarketChartHistory(input: {
  asset: ProviderAsset;
  daily: MarketChartPayload;
  collectedAt: string;
  notAfter: Partial<Record<string, string>>;
  existing: Set<string>;
  nowMs?: number;
}): ProviderSnapshot | null {
  const observations: NormalizedObservation[] = [];
  const nowMs = input.nowMs ?? Date.parse(input.collectedAt);
  const granularCutoff = nowMs - 30 * 24 * 60 * 60 * 1000;

  for (const { field, metricId } of SERIES) {
    const cutoff = input.notAfter[metricId] ? Date.parse(input.notAfter[metricId]!) : Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    const points = pairs(input.daily[field]).sort((a, b) => a[0] - b[0]);

    const selected = points.filter(([timeMs]) => timeMs >= granularCutoff && timeMs <= nowMs);

    for (const [timeMs, value] of selected) {
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
        note: "CoinGecko historical market_chart observation stored at the exact provider timestamp for the rolling 30-day granular window.",
      });
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
      request: { days: 30, sampling: "actual provider timestamps only" },
      daily: {
        prices: granularForPayload(input.daily.prices, granularCutoff, nowMs),
        market_caps: granularForPayload(input.daily.market_caps, granularCutoff, nowMs),
        total_volumes: granularForPayload(input.daily.total_volumes, granularCutoff, nowMs),
      },
      retentionNote: "This backfill only stores genuine CoinGecko observations in the rolling 30-day granular window. Existing 30-90 day daily observations are untouched. No values or timestamps were interpolated, synthesized, or retimed.",
    },
    observations,
  };
}

function olderForPayload(value: unknown, cutoffMs: number): [number, number][] {
  return pairs(value).filter(([timeMs]) => timeMs < cutoffMs);
}

function granularForPayload(value: unknown, cutoffMs: number, nowMs: number): [number, number][] {
  return pairs(value).filter(([timeMs]) => timeMs >= cutoffMs && timeMs <= nowMs);
}
