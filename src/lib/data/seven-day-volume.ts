/**
 * 7D volume from stored CoinGecko 24-hour volume observations.
 *
 * Each CoinGecko volume value (live `total_volume` or history
 * `market_chart.total_volumes`) is a rolling 24-hour total at its timestamp,
 * so summing every stored point would count the same trading many times. 7D
 * volume is instead the sum of seven non-overlapping 24-hour windows ending at
 * the latest valid observation T: the observation nearest to T - k * 24 h for
 * k = 0..6, each within ±60 minutes. If any window has no valid observation
 * the value is unavailable; nothing is interpolated, zero-filled, or derived
 * from 24H volume x 7.
 */

export const SEVEN_DAY_WINDOWS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_TOLERANCE_MS = 60 * 60 * 1000;

export type VolumePoint = { observed_at: string; value: number | string | null; status: string };
export type SevenDayVolume = { valueUsd: number; anchorAt: string; windowStartAt: string };

function validPoints(points: VolumePoint[]): { t: number; v: number }[] {
  return points
    .filter((point) => point.status === "available" && point.value !== null && point.value !== "")
    .map((point) => ({ t: Date.parse(point.observed_at), v: Number(point.value) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v >= 0);
}

/** Sum of seven non-overlapping 24-hour volume observations ending at the latest valid one; null when any window is missing. */
export function sevenDayVolume(points: VolumePoint[]): SevenDayVolume | null {
  const valid = validPoints(points);
  if (valid.length === 0) return null;
  const anchor = Math.max(...valid.map((point) => point.t));
  let total = 0;
  for (let k = 0; k < SEVEN_DAY_WINDOWS; k += 1) {
    const target = anchor - k * DAY_MS;
    let best: { t: number; v: number } | null = null;
    for (const point of valid) {
      const distance = Math.abs(point.t - target);
      if (distance <= WINDOW_TOLERANCE_MS && (!best || distance < Math.abs(best.t - target))) best = point;
    }
    if (!best) return null;
    total += best.v;
  }
  return {
    valueUsd: total,
    anchorAt: new Date(anchor).toISOString(),
    windowStartAt: new Date(anchor - SEVEN_DAY_WINDOWS * DAY_MS).toISOString(),
  };
}

/**
 * The narrow time bands to read for a set of anchors (latest volume
 * observation times), so the dashboard reads ~7 small slices instead of a
 * week of hourly history. Anchors are grouped by UTC hour; each group gets one
 * band per window, padded by the tolerance on both sides.
 */
export function sevenDayVolumeBands(anchors: { tokenId: string; observedAt: string }[]): { tokenIds: string[]; from: string; to: string }[] {
  const groups = new Map<number, { tokenIds: string[]; min: number; max: number }>();
  for (const { tokenId, observedAt } of anchors) {
    const t = Date.parse(observedAt);
    if (!Number.isFinite(t)) continue;
    const hour = Math.floor(t / (60 * 60 * 1000));
    const group = groups.get(hour) ?? { tokenIds: [], min: t, max: t };
    group.tokenIds.push(tokenId);
    group.min = Math.min(group.min, t);
    group.max = Math.max(group.max, t);
    groups.set(hour, group);
  }
  const bands: { tokenIds: string[]; from: string; to: string }[] = [];
  for (const group of groups.values()) {
    for (let k = 0; k < SEVEN_DAY_WINDOWS; k += 1) {
      bands.push({
        tokenIds: group.tokenIds,
        from: new Date(group.min - k * DAY_MS - WINDOW_TOLERANCE_MS).toISOString(),
        to: new Date(group.max - k * DAY_MS + WINDOW_TOLERANCE_MS).toISOString(),
      });
    }
  }
  return bands;
}
