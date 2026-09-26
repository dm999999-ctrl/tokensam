/**
 * Pure numeric helpers for technical indicators. Every function returns null
 * (or an empty array) when the input is too short or the result is not finite,
 * so callers can never display a partial or fabricated value.
 */

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const guard = (value: number): number | null => (Number.isFinite(value) ? value : null);

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : guard(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Population standard deviation (the Bollinger Bands convention). */
export function stdev(values: number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  return guard(Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length));
}

/** Sample standard deviation (n − 1), used for historical volatility. */
export function sampleStdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return guard(Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)));
}

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): number | null {
  return values.length < period ? null : mean(values.slice(-period));
}

/**
 * EMA series with multiplier 2 / (period + 1), seeded with the SMA of the first
 * `period` values. Element i corresponds to values[period − 1 + i].
 */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [mean(values.slice(0, period))!];
  for (let i = period; i < values.length; i += 1) out.push(values[i] * k + out.at(-1)! * (1 - k));
  return out.every(Number.isFinite) ? out : [];
}

/** Wilder RSI: average gain / loss seeded with a simple mean, then smoothed with 1/period. */
export function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;
  const changes = values.slice(1).map((value, i) => value - values[i]);
  let gain = mean(changes.slice(0, period).map((change) => Math.max(change, 0)))!;
  let loss = mean(changes.slice(0, period).map((change) => Math.max(-change, 0)))!;
  for (const change of changes.slice(period)) {
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (gain === 0 && loss === 0) return null; // no movement at all: RSI is undefined
  return guard(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
}

/** Ordinary least-squares slope of values against their index, with R². */
export function linearRegression(values: number[]): { slope: number; intercept: number; r2: number } | null {
  const n = values.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = mean(values)!;
  let sxy = 0, sxx = 0, syy = 0;
  values.forEach((y, x) => { sxy += (x - xMean) * (y - yMean); sxx += (x - xMean) ** 2; syy += (y - yMean) ** 2; });
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return [slope, r2].every(finite) ? { slope, intercept: yMean - slope * xMean, r2 } : null;
}

/** Pearson correlation; null when either side has no variation. */
export function correlation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const am = mean(a)!, bm = mean(b)!;
  let cov = 0, va = 0, vb = 0;
  a.forEach((value, i) => { cov += (value - am) * (b[i] - bm); va += (value - am) ** 2; vb += (b[i] - bm) ** 2; });
  if (va === 0 || vb === 0) return null;
  return guard(cov / Math.sqrt(va * vb));
}

/** Natural-log returns between consecutive values (all values must be positive). */
export function logReturns(values: number[]): number[] {
  return values.slice(1).map((value, i) => Math.log(value / values[i]));
}

export function pctChange(from: number, to: number): number | null {
  return from > 0 ? guard((to / from - 1) * 100) : null;
}
