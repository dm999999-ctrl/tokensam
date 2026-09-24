import type {
  HistoricalMetric,
  HistoricalPeriod,
  HistoricalPeriodCoverage,
  HistoricalPoint,
  HistoricalSeries,
} from "../../types/historical-data.ts";

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
