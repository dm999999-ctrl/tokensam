import type {
  HistoricalMetric,
  HistoricalPeriod,
  HistoricalPeriodCoverage,
  HistoricalPoint,
  HistoricalSeries,
} from "../../types/historical-data.ts";
import { DAY_MS, SERIES_RULES, dailySamples, type ObservationRow } from "../indicators/series.ts";

export const HISTORICAL_PERIODS: HistoricalPeriod[] = ["24H", "7D", "30D", "90D"];
export const PERIOD_HOURS: Record<HistoricalPeriod, number> = { "24H": 24, "7D": 7 * 24, "30D": 30 * 24, "90D": 90 * 24 };
const HOUR_MS = 60 * 60 * 1000;
const FULL_COVERAGE_RATIO = 0.9;

export function formatSpan(hours: number): string {
  const unit = (value: number, singular: string) => `${value} ${value === 1 ? singular : `${singular}s`}`;
  if (hours < 1) return unit(Math.round(hours * 60), "minute");
  if (hours < 48) return unit(Math.round(hours * 10) / 10, "hour");
  return unit(Math.round((hours / 24) * 10) / 10, "day");
}

/**
 * Coverage of one requested window, (asOf - period, asOf] inclusive of both
 * ends, using only the stored points inside it. Two or more points are needed
 * to show a trend; the window's name is never treated as achieved coverage.
 */
export function pointsInPeriod(points: HistoricalPoint[], period: HistoricalPeriod, asOf: Date): HistoricalPoint[] {
  const windowEndMs = asOf.getTime();
  const windowStartMs = windowEndMs - PERIOD_HOURS[period] * HOUR_MS;
  return points.filter((point) => {
    const time = Date.parse(point.timestamp);
    return time >= windowStartMs && time <= windowEndMs;
  });
}

export function periodCoverage(points: HistoricalPoint[], period: HistoricalPeriod, asOf: Date, seriesUnavailableReason: string | null = null): HistoricalPeriodCoverage {
  const windowEndMs = asOf.getTime();
  const windowStartMs = windowEndMs - PERIOD_HOURS[period] * HOUR_MS;
  const inWindow = pointsInPeriod(points, period, asOf);
  const first = inWindow[0];
  const last = inWindow.at(-1);
  const coverageHours = first && last ? Math.round(((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / HOUR_MS) * 100) / 100 : null;
  const count = inWindow.length;
  const status: HistoricalPeriodCoverage["status"] = count >= 2 ? "available" : count === 1 ? "insufficient_history" : "unavailable";
  const unavailableReason = status === "available"
    ? null
    : seriesUnavailableReason
      ?? (count === 1
        ? `Only one stored observation (${first!.timestamp}) falls in the requested ${period} window; at least two are needed to show a trend.`
        : `No stored observations fall in the requested ${period} window.`);
  return {
    requestedPeriod: period,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    status,
    observationCount: count,
    coverageStart: first?.timestamp ?? null,
    coverageEnd: last?.timestamp ?? null,
    coverageHours,
    fullCoverage: coverageHours !== null && coverageHours >= PERIOD_HOURS[period] * FULL_COVERAGE_RATIO,
    coverageLabel: count === 0
      ? "No stored observations"
      : count === 1
        ? "1 observation"
        : `${count} observations spanning ${formatSpan(coverageHours!)}`,
    unavailableReason,
  };
}

/** Build a chart series from stored observations: points sorted, deduplicated by row, never synthesized. */
export function buildHistoricalSeries(input: {
  metric: HistoricalMetric;
  providerId: HistoricalSeries["providerId"];
  scope: HistoricalSeries["scope"];
  points: HistoricalPoint[];
  asOf: Date;
  unavailableReason?: string | null;
}): HistoricalSeries {
  const points = [...new Map(input.points.map((point) => [point.sourceId, point])).values()]
    .filter((point) => Number.isFinite(point.valueUsd) && Number.isFinite(Date.parse(point.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sourceId.localeCompare(b.sourceId));
  const reason = input.unavailableReason ?? null;
  const periods = Object.fromEntries(HISTORICAL_PERIODS.map((period) => [
    period, periodCoverage(points, period, input.asOf, points.length === 0 ? reason : null),
  ])) as Record<HistoricalPeriod, HistoricalPeriodCoverage>;
  return { metric: input.metric, providerId: input.providerId, scope: input.scope, points, periods, unavailableReason: points.length === 0 ? reason : null };
}

/** Change between the first and last stored points of a window; null without two points or a zero base. */
export function coverageChangePct(points: HistoricalPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].valueUsd;
  const last = points[points.length - 1].valueUsd;
  return first === 0 ? null : ((last - first) / first) * 100;
}

// ---- Risk profile (Market History): volatility and drawdown from stored prices ----
//
// Both series are calculated at page load from the price observations already in
// `priceUsd`; nothing is stored, fetched or interpolated.
//
// Daily closes: stored price history mixes daily points (00:00 UTC) with hourly
// and irregular snapshots, and returns over unequal intervals are not comparable.
// Both series therefore use one sample per UTC midnight, chosen by the same rule
// as the technical indicators (the observation nearest 00:00 UTC within 30
// minutes; missing, zero, negative or non-finite prices are never samples).

export const RISK_VOLATILITY_WINDOW_DAYS = 7;

/** One price sample per UTC midnight (the technical-indicator daily-close rule), chronological. */
export function dailyCloses(points: HistoricalPoint[], asOf: Date): HistoricalPoint[] {
  const rows: ObservationRow[] = points.map((point, index) => ({
    id: Number(point.sourceId.replace(/^obs:/, "")) || -(index + 1),
    metric_id: SERIES_RULES.price.metricId,
    provider_id: SERIES_RULES.price.providerId,
    value: point.valueUsd,
    status: "available",
    observed_at: point.timestamp,
  }));
  return dailySamples(rows, SERIES_RULES.price, asOf.getTime())
    .map((sample) => ({ timestamp: new Date(sample.time).toISOString(), valueUsd: sample.value, sourceId: `obs:${sample.obsId}` }));
}

/**
 * Rolling volatility, in percent, at each daily close t that has
 * RISK_VOLATILITY_WINDOW_DAYS + 1 consecutive daily closes ending at t:
 *
 *   r_i = ln(close_i / close_{i−1})          (7 daily log returns)
 *   σ   = sample standard deviation of r     (n − 1 denominator)
 *   volatility_t = σ × √365 × 100            (annualized; crypto trades every day)
 *
 * A missing day inside the lookback yields no value for that t (gaps are never
 * bridged). The lookback may start before a chart window; the chart shows only
 * values whose date t falls inside the selected window.
 */
export function rollingVolatility(daily: HistoricalPoint[], windowDays = RISK_VOLATILITY_WINDOW_DAYS): HistoricalPoint[] {
  const out: HistoricalPoint[] = [];
  const times = daily.map((point) => Date.parse(point.timestamp));
  for (let t = windowDays; t < daily.length; t += 1) {
    let consecutive = true;
    for (let i = t - windowDays + 1; i <= t; i += 1) if (times[i] - times[i - 1] !== DAY_MS) consecutive = false;
    if (!consecutive) continue;
    const returns = daily.slice(t - windowDays, t + 1).slice(1).map((point, i) => Math.log(point.valueUsd / daily[t - windowDays + i].valueUsd));
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const value = Math.sqrt(variance) * Math.sqrt(365) * 100;
    if (Number.isFinite(value)) out.push({ timestamp: daily[t].timestamp, valueUsd: value, sourceId: daily[t].sourceId });
  }
  return out;
}

/**
 * Drawdown, in percent, for daily closes already restricted to a chart window,
 * in chronological order: drawdown_t = (close_t / max(close_first..close_t) − 1) × 100.
 * The running peak starts at the window's first close, so values are 0 at a new
 * peak and negative below it; they are never positive.
 */
export function drawdownSeries(dailyInWindow: HistoricalPoint[]): HistoricalPoint[] {
  const sorted = [...dailyInWindow].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let peak = -Infinity;
  const out: HistoricalPoint[] = [];
  for (const point of sorted) {
    if (!Number.isFinite(point.valueUsd) || point.valueUsd <= 0) continue;
    peak = Math.max(peak, point.valueUsd);
    const value = Math.min(0, (point.valueUsd / peak - 1) * 100);
    out.push({ timestamp: point.timestamp, valueUsd: value === 0 ? 0 : value, sourceId: point.sourceId });
  }
  return out;
}

/** Risk profile for one requested window: volatility and drawdown share the window's daily-close timestamps. */
export function riskProfile(pricePoints: HistoricalPoint[], period: HistoricalPeriod, asOf: Date): {
  daily: HistoricalPoint[]; volatility: HistoricalPoint[]; drawdown: HistoricalPoint[];
} {
  const allDaily = dailyCloses(pricePoints, asOf);
  const daily = pointsInPeriod(allDaily, period, asOf);
  return { daily, volatility: pointsInPeriod(rollingVolatility(allDaily), period, asOf), drawdown: drawdownSeries(daily) };
}
