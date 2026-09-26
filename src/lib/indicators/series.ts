/**
 * Normalization for technical indicators: raw stored observations become one
 * sample per UTC midnight ("daily close"). Nothing is interpolated or filled:
 * a boundary with no observation close enough is a gap, and indicators use
 * only the contiguous run of days that ends at the most recent sample.
 */

export type ObservationRow = {
  id: number;
  metric_id: string;
  provider_id: string;
  value: number | string | null;
  status: string;
  observed_at: string;
};

export type DailyPoint = { time: number; value: number; obsId: number };

export const DAY_MS = 24 * 60 * 60 * 1000;

export type SeriesRule = {
  providerId: string;
  metricId: string;
  /** Max distance between a stored observation and the UTC midnight it stands for. */
  toleranceMs: number;
  /** Values must be strictly positive (prices, market cap, TVL) or non-negative (volume). */
  positive: boolean;
};

/** Market series are stored daily at 00:00 UTC (and hourly for recent days); 30 minutes picks those exact points. */
export const SERIES_RULES = {
  price: { providerId: "coingecko", metricId: "price_usd", toleranceMs: 30 * 60 * 1000, positive: true },
  volume: { providerId: "coingecko", metricId: "volume_24h_usd", toleranceMs: 30 * 60 * 1000, positive: false },
  marketCap: { providerId: "coingecko", metricId: "market_cap_usd", toleranceMs: 30 * 60 * 1000, positive: true },
  tvl: { providerId: "defillama", metricId: "tvl_usd", toleranceMs: 30 * 60 * 1000, positive: true },
  // Supply is snapshotted by the refresh, not at midnight, and changes slowly.
  circulatingSupply: { providerId: "coingecko", metricId: "circulating_supply", toleranceMs: 6 * 60 * 60 * 1000, positive: true },
} as const satisfies Record<string, SeriesRule>;

/**
 * Historical-series freshness, separate from the current-market freshness policy: an indicator
 * stays valid while at least half of its window lies within the last `windowDays` days, i.e. the
 * newest daily sample it uses is at most floor(windowDays / 2) days old. Nothing is extended to
 * "now"; the indicator is shown as of that newest sample.
 */
export function maxHistoryAgeDays(windowDays: number): number {
  return Math.floor(windowDays / 2);
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * All UTC-midnight samples for one provider metric: for each boundary, the
 * nearest valid observation within the tolerance (ties go to the later ID).
 */
export function dailySamples(rows: ObservationRow[], rule: SeriesRule, asOf: number): DailyPoint[] {
  const candidates = rows
    .filter((row) => row.provider_id === rule.providerId && row.metric_id === rule.metricId && row.status === "available")
    .map((row) => ({ time: Date.parse(row.observed_at), value: numeric(row.value), obsId: row.id }))
    .filter((row): row is DailyPoint => row.value !== null && Number.isFinite(row.time) && row.time <= asOf
      && (rule.positive ? row.value > 0 : row.value >= 0));
  const byBoundary = new Map<number, { point: DailyPoint; distance: number }>();
  for (const point of candidates) {
    const boundary = Math.round(point.time / DAY_MS) * DAY_MS;
    const distance = Math.abs(point.time - boundary);
    if (distance > rule.toleranceMs || boundary > asOf) continue;
    const current = byBoundary.get(boundary);
    if (!current || distance < current.distance || (distance === current.distance && point.obsId > current.point.obsId)) {
      byBoundary.set(boundary, { point, distance });
    }
  }
  return [...byBoundary.entries()].sort((a, b) => a[0] - b[0]).map(([time, { point }]) => ({ time, value: point.value, obsId: point.obsId }));
}

/** The run of consecutive days ending at the newest sample (its age is judged per indicator, not here). */
export function contiguousTail(points: DailyPoint[]): DailyPoint[] {
  if (points.length === 0) return [];
  let start = points.length - 1;
  while (start > 0 && points[start].time - points[start - 1].time === DAY_MS) start -= 1;
  return points.slice(start);
}

/** Days present in every series, as the contiguous run ending at the newest shared day. */
export function alignSeries(series: DailyPoint[][]): DailyPoint[][] {
  if (series.length === 0 || series.some((points) => points.length === 0)) return series.map(() => []);
  const shared = series.map((points) => new Map(points.map((point) => [point.time, point])));
  const days = [...shared[0].keys()].filter((time) => shared.every((map) => map.has(time))).sort((a, b) => a - b);
  const tail = contiguousTail(days.map((time) => ({ time, value: 0, obsId: 0 })));
  return shared.map((map) => tail.map(({ time }) => map.get(time)!));
}
