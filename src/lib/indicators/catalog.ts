import type { IndicatorCategory, IndicatorInput, IndicatorReading } from "../../types/technical-indicators.ts";
import { correlation, emaSeries, linearRegression, logReturns, mean, pctChange, rsi, sampleStdev, sma, stdev } from "./math.ts";
import { DAY_MS, type DailyPoint } from "./series.ts";

/**
 * Technical indicator definitions. Each declares its inputs, the minimum
 * number of consecutive daily samples it needs, and a deterministic
 * calculation over those samples. `compute` returns null when the values do
 * not support a result (e.g. zero variance), and the indicator is then omitted.
 *
 * Inputs are daily UTC-midnight samples of stored observations only. No input
 * has intraday high/low/open data, so indicators that need it (ATR, ADX,
 * Stochastic, Williams %R, CCI, Ichimoku, Parabolic SAR, Supertrend, Keltner,
 * Donchian, MFI, CMF, A/D) are deliberately not defined.
 */

export type Computed = { readings: IndicatorReading[]; state: string | null; used: DailyPoint[][] };

export type IndicatorDefinition = {
  id: string;
  name: string;
  category: IndicatorCategory;
  inputs: IndicatorInput[];
  /** Minimum consecutive daily samples (aligned across inputs). */
  minPoints: number;
  /**
   * Days the value describes (e.g. 14 for RSI(14), 30 for a 30D comparison). It sets the historical
   * freshness rule: the newest input sample may be at most floor(windowDays / 2) days old.
   */
  windowDays: number;
  parameters: Record<string, number | string>;
  periodLabel: string;
  /** One short line shown on the card; the full description and method sit in the disclosure. */
  summary: string;
  description: string;
  formula: string;
  compute: (series: DailyPoint[][]) => Computed | null;
};

const values = (points: DailyPoint[]) => points.map((point) => point.value);
const iso = (time: number) => new Date(time).toISOString();
const finite = (...numbers: (number | null)[]): boolean => numbers.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * A fixed-horizon label ("7D", "30D") is only honest when the calculation's endpoints are exactly
 * that many days apart and every input uses the same timestamps (no stretched or shifted interval).
 */
export function spansExactly(days: number, ...pairs: [DailyPoint, DailyPoint][]): boolean {
  const [first] = pairs;
  return first !== undefined && first[1].time - first[0].time === days * DAY_MS
    && pairs.every(([start, end]) => start.time === first[0].time && end.time === first[1].time);
}

/** Direction of a percentage change: moves within ±1% count as "little changed". */
export const DIRECTION_THRESHOLD_PCT = 1;
type Direction = "up" | "down" | "flat";
export function direction(changePct: number): Direction {
  return changePct >= DIRECTION_THRESHOLD_PCT ? "up" : changePct <= -DIRECTION_THRESHOLD_PCT ? "down" : "flat";
}
const ARROW: Record<Direction, string> = { up: "↑", down: "↓", flat: "little changed" };

/** Neutral description of how two changes relate; never a bullish/bearish label. */
export function relationState(aName: string, aChange: number, bName: string, bChange: number): string {
  const a = direction(aChange), b = direction(bChange);
  if (a !== "flat" && b !== "flat" && a !== b) return `Divergence detected: ${aName} ${ARROW[a]}, ${bName} ${ARROW[b]}`;
  if (a !== "flat" && a === b) return `Same direction: ${aName} and ${bName} both ${ARROW[a]}`;
  return `${aName} ${ARROW[a]}, ${bName} ${ARROW[b]}`;
}

/** Correlation bands: |r| < 0.3 is reported as no clear linear relationship. */
export function relationshipLabel(r: number): string {
  return r >= 0.3 ? "Positive relationship" : r <= -0.3 ? "Negative relationship" : "No clear linear relationship";
}

/** Expansion/contraction of a ratio between two dates (±1% threshold). */
function ratioState(changePct: number): string {
  const d = direction(changePct);
  return d === "up" ? "Expansion" : d === "down" ? "Contraction" : "Little changed";
}

function closeVs(label: string, average: number | null, points: DailyPoint[]): Computed | null {
  const close = points.at(-1)!.value;
  const gap = average === null ? null : pctChange(average, close);
  if (!finite(average, gap)) return null;
  return { readings: [{ label, value: average!, unit: "usd" }, { label: "Latest close vs average", value: gap!, unit: "percent_change" }], state: null, used: [points] };
}

/** Swing points on closes: a close strictly above (below) the `k` closes on each side. */
export function swingPoints(points: DailyPoint[], k = 3): { highs: DailyPoint[]; lows: DailyPoint[] } {
  const highs: DailyPoint[] = [], lows: DailyPoint[] = [];
  for (let i = k; i < points.length - k; i += 1) {
    const around = [...points.slice(i - k, i), ...points.slice(i + 1, i + k + 1)].map((point) => point.value);
    if (points[i].value > Math.max(...around)) highs.push(points[i]);
    if (points[i].value < Math.min(...around)) lows.push(points[i]);
  }
  return { highs, lows };
}

function macd(closes: number[]): { line: number; signal: number; histogram: number } | null {
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  if (slow.length === 0) return null;
  // slow[i] is at close index 25 + i; fast[j] is at close index 11 + j.
  const line = slow.map((value, i) => fast[i + 14] - value);
  const signal = emaSeries(line, 9);
  if (signal.length === 0) return null;
  const result = { line: line.at(-1)!, signal: signal.at(-1)! };
  return finite(result.line, result.signal) ? { ...result, histogram: result.line - result.signal } : null;
}

export const INDICATOR_DEFINITIONS: IndicatorDefinition[] = [
  // ---- Trend ----
  {
    id: "sma_20", name: "SMA (20)", category: "trend", inputs: ["price"], minPoints: 20, windowDays: 20,
    parameters: { period: 20 }, periodLabel: "Last 20 daily closes",
    summary: "Average of the last 20 daily closes.",
    description: "Average daily close over 20 days; smooths short-term moves to show the prevailing level.",
    formula: "SMA = mean(close[t−19..t]); gap = (close[t] / SMA − 1) × 100",
    compute: ([price]) => closeVs("SMA", sma(values(price), 20), price.slice(-20)),
  },
  {
    id: "sma_50", name: "SMA (50)", category: "trend", inputs: ["price"], minPoints: 50, windowDays: 50,
    parameters: { period: 50 }, periodLabel: "Last 50 daily closes",
    summary: "Average of the last 50 daily closes.",
    description: "Average daily close over 50 days, a slower trend reference than the 20-day average.",
    formula: "SMA = mean(close[t−49..t]); gap = (close[t] / SMA − 1) × 100",
    compute: ([price]) => closeVs("SMA", sma(values(price), 50), price.slice(-50)),
  },
  {
    id: "ema_20", name: "EMA (20)", category: "trend", inputs: ["price"], minPoints: 40, windowDays: 20,
    parameters: { period: 20, smoothing: "2/(n+1)" }, periodLabel: "All consecutive daily closes (≥ 40 for warm-up)",
    summary: "20-day exponential average of daily closes.",
    description: "Exponentially weighted average of daily closes; reacts faster than the SMA to recent moves.",
    formula: "EMA seeded with SMA(20) of the first 20 closes, then EMA[t] = close[t] × k + EMA[t−1] × (1 − k), k = 2/21. Needs 40 closes (seed + 20-day warm-up).",
    compute: ([price]) => closeVs("EMA", emaSeries(values(price), 20).at(-1) ?? null, price),
  },
  {
    id: "macd", name: "MACD (12, 26, 9)", category: "trend", inputs: ["price"], minPoints: 61, windowDays: 26,
    parameters: { fast: 12, slow: 26, signal: 9 }, periodLabel: "All consecutive daily closes (≥ 61 for warm-up)",
    summary: "12- vs 26-day EMA spread, with a 9-day signal line.",
    description: "Difference between the 12- and 26-day EMAs, with a 9-day EMA of that difference as the signal line.",
    formula: "MACD = EMA12(close) − EMA26(close); signal = EMA9(MACD); histogram = MACD − signal. Needs 2 × 26 + 9 = 61 closes.",
    compute: ([price]) => {
      const result = macd(values(price));
      if (!result) return null;
      return {
        readings: [
          { label: "MACD line", value: result.line, unit: "usd" },
          { label: "Signal line", value: result.signal, unit: "usd" },
          { label: "Histogram", value: result.histogram, unit: "usd" },
        ],
        state: result.histogram > 0 ? "MACD line above signal line" : result.histogram < 0 ? "MACD line below signal line" : "MACD line equals signal line",
        used: [price],
      };
    },
  },
  {
    id: "linreg_slope_20", name: "Linear regression slope (20)", category: "trend", inputs: ["price"], minPoints: 20, windowDays: 20,
    parameters: { period: 20 }, periodLabel: "Last 20 daily closes",
    summary: "Straight-line trend fitted to 20 daily closes.",
    description: "Slope of a straight line fitted to 20 daily closes, as % of their average per day; R² shows how well a line fits.",
    formula: "OLS of close on day index over 20 closes; slope % = slope / mean(close) × 100 per day; R² = explained variance share",
    compute: ([price]) => {
      const window = price.slice(-20);
      const fit = linearRegression(values(window));
      const average = mean(values(window));
      if (!fit || !average) return null;
      const slopePct = (fit.slope / average) * 100;
      if (!finite(slopePct)) return null;
      return { readings: [{ label: "Slope", value: slopePct, unit: "percent_per_day" }, { label: "R²", value: fit.r2, unit: "ratio" }], state: null, used: [window] };
    },
  },
  {
    id: "vwma_20", name: "VWMA (20)", category: "trend", inputs: ["price", "volume"], minPoints: 20, windowDays: 20,
    parameters: { period: 20 }, periodLabel: "Last 20 daily closes and 24h volumes",
    summary: "20-day average close, weighted by daily volume.",
    description: "Average daily close weighted by each day's trading volume, so high-volume days count more.",
    formula: "VWMA = Σ(close × volume24h) / Σ volume24h over 20 days; volume24h is the rolling 24-hour volume at each daily close",
    compute: ([price, volume]) => {
      const p = price.slice(-20), v = volume.slice(-20);
      const total = v.reduce((sum, point) => sum + point.value, 0);
      if (total <= 0) return null;
      const vwma = p.reduce((sum, point, i) => sum + point.value * v[i].value, 0) / total;
      const result = closeVs("VWMA", vwma, p);
      return result ? { ...result, used: [p, v] } : null;
    },
  },

  // ---- Momentum ----
  {
    id: "rsi_14", name: "RSI (14)", category: "momentum", inputs: ["price"], minPoints: 43, windowDays: 14,
    parameters: { period: 14, smoothing: "Wilder" }, periodLabel: "All consecutive daily closes (≥ 43 for warm-up)",
    summary: "Momentum on a 0–100 scale over 14 days.",
    description: "Measures recent price momentum on a 0–100 scale from the balance of average gains and losses.",
    formula: "RSI = 100 − 100 / (1 + avgGain / avgLoss), Wilder smoothing (1/14) seeded with the first 14 changes. Needs 3 × 14 + 1 = 43 closes.",
    compute: ([price]) => {
      const value = rsi(values(price), 14);
      if (value === null) return null;
      const state = value >= 70 ? "At or above the 70 level" : value <= 30 ? "At or below the 30 level" : "Between the 30 and 70 levels";
      return { readings: [{ label: "RSI", value, unit: "index" }], state, used: [price] };
    },
  },
  {
    id: "roc_14", name: "Rate of change (14)", category: "momentum", inputs: ["price"], minPoints: 15, windowDays: 14,
    parameters: { period: 14 }, periodLabel: "Close today vs 14 daily closes earlier",
    summary: "Change in close over 14 days.",
    description: "Percentage change between the latest daily close and the close 14 days earlier.",
    formula: "ROC = (close[t] / close[t−14] − 1) × 100",
    compute: ([price]) => {
      const window = price.slice(-15);
      const value = pctChange(window[0].value, window.at(-1)!.value);
      return value === null ? null : { readings: [{ label: "ROC", value, unit: "percent_change" }], state: null, used: [window] };
    },
  },

  // ---- Volatility ----
  {
    id: "bollinger_20_2", name: "Bollinger Bands (20, 2)", category: "volatility", inputs: ["price"], minPoints: 20, windowDays: 20,
    parameters: { period: 20, deviations: 2 }, periodLabel: "Last 20 daily closes",
    summary: "20-day average ± 2 standard deviations.",
    description: "A 20-day average with bands two standard deviations above and below; %B places the latest close within the bands.",
    formula: "middle = SMA(20); upper/lower = middle ± 2 × σ (population σ of 20 closes); %B = (close − lower) / (upper − lower); width = (upper − lower) / middle × 100",
    compute: ([price]) => {
      const window = price.slice(-20);
      const middle = mean(values(window)), sd = stdev(values(window));
      if (!middle || !sd) return null; // zero variance: bands collapse and %B is undefined
      const upper = middle + 2 * sd, lower = middle - 2 * sd;
      const percentB = (window.at(-1)!.value - lower) / (upper - lower);
      const width = ((upper - lower) / middle) * 100;
      if (!finite(percentB, width)) return null;
      return {
        readings: [
          { label: "Upper", value: upper, unit: "usd" },
          { label: "Middle", value: middle, unit: "usd" },
          { label: "Lower", value: lower, unit: "usd" },
          { label: "%B", value: percentB, unit: "ratio" },
          { label: "Band width", value: width, unit: "percent" },
        ],
        state: null,
        used: [window],
      };
    },
  },
  {
    id: "historical_volatility_30", name: "Historical volatility (30)", category: "volatility", inputs: ["price"], minPoints: 31, windowDays: 30,
    parameters: { period: 30, annualization: 365 }, periodLabel: "30 daily log returns (31 closes)",
    summary: "Annualized volatility of 30 daily returns.",
    description: "Annualized standard deviation of daily returns over 30 days; crypto trades every day, so it scales by √365.",
    formula: "σ = sample stdev of ln(close[i] / close[i−1]) over 30 returns; annualized = σ × √365 × 100",
    compute: ([price]) => {
      const window = price.slice(-31);
      const sd = sampleStdev(logReturns(values(window)));
      if (sd === null) return null;
      return {
        readings: [{ label: "Annualized", value: sd * Math.sqrt(365) * 100, unit: "percent" }, { label: "Daily σ", value: sd * 100, unit: "percent" }],
        state: null,
        used: [window],
      };
    },
  },
  {
    id: "ulcer_index_14", name: "Ulcer Index (14)", category: "volatility", inputs: ["price"], minPoints: 27, windowDays: 14,
    parameters: { period: 14 }, periodLabel: "Last 27 daily closes (14 drawdowns, each vs a 14-day high)",
    summary: "Depth of drawdowns from 14-day closing highs.",
    description: "Downside-only volatility: the root-mean-square drawdown of each close from its 14-day closing high.",
    formula: "D[i] = (close[i] / max(close[i−13..i]) − 1) × 100 for the last 14 days; UI = √(mean(D²))",
    compute: ([price]) => {
      const window = price.slice(-27);
      const closes = values(window);
      const drawdowns = closes.slice(13).map((close, j) => (close / Math.max(...closes.slice(j, j + 14)) - 1) * 100);
      const value = Math.sqrt(mean(drawdowns.map((d) => d * d)) ?? Number.NaN);
      return finite(value) ? { readings: [{ label: "Ulcer Index", value, unit: "percent" }], state: null, used: [window] } : null;
    },
  },

  // ---- Volume ----
  {
    id: "volume_sma_20", name: "Volume moving average (20)", category: "volume", inputs: ["volume"], minPoints: 20, windowDays: 20,
    parameters: { period: 20 }, periodLabel: "Last 20 daily 24h volumes",
    summary: "Latest daily volume vs its 20-day average.",
    description: "Average 24-hour trading volume over 20 days, and how the latest day compares with it.",
    formula: "VMA = mean(volume24h[t−19..t]); latest vs VMA = (volume24h[t] / VMA − 1) × 100",
    compute: ([volume]) => {
      const window = volume.slice(-20);
      const average = mean(values(window));
      const gap = average ? pctChange(average, window.at(-1)!.value) : null;
      if (!average || gap === null) return null;
      return { readings: [{ label: "20-day average", value: average, unit: "usd_total" }, { label: "Latest vs average", value: gap, unit: "percent_change" }], state: null, used: [window] };
    },
  },
  {
    id: "obv_20", name: "On-balance volume · 20-day net", category: "volume", inputs: ["price", "volume"], minPoints: 21, windowDays: 20,
    parameters: { period: 20 }, periodLabel: "Last 21 daily closes and 24h volumes",
    summary: "Up-day minus down-day volume over 20 days.",
    description: "Volume on up-close days minus volume on down-close days over 20 days, and its share of total volume.",
    formula: "net = Σ sign(close[i] − close[i−1]) × volume24h[i] over 20 days (OBV[t] − OBV[t−20]); share = net / Σ volume24h × 100",
    compute: ([price, volume]) => {
      const p = price.slice(-21), v = volume.slice(-21);
      let net = 0, total = 0;
      for (let i = 1; i < p.length; i += 1) {
        net += Math.sign(p[i].value - p[i - 1].value) * v[i].value;
        total += v[i].value;
      }
      if (total <= 0) return null;
      return { readings: [{ label: "Net signed volume", value: net, unit: "usd_total" }, { label: "Share of 20-day volume", value: (net / total) * 100, unit: "percent_change" }], state: null, used: [p, v] };
    },
  },

  // ---- Market structure (closing basis) ----
  {
    id: "swing_structure", name: "Swing structure", category: "market_structure", inputs: ["price"], minPoints: 30, windowDays: 30,
    parameters: { confirmation: 3 }, periodLabel: "All consecutive daily closes (≥ 30)",
    summary: "Last two confirmed swing highs and lows of daily closes.",
    description: "Compares the last two swing highs and swing lows of daily closes. A swing is confirmed only after 3 later closes.",
    formula: "Swing high: a close strictly above the 3 closes before and after it (swing low: strictly below). Structure compares the latest two of each.",
    compute: ([price]) => {
      const { highs, lows } = swingPoints(price, 3);
      if (highs.length < 2 || lows.length < 2) return null;
      const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
      const highWord = h2.value > h1.value ? "Higher high" : h2.value < h1.value ? "Lower high" : "Equal high";
      const lowWord = l2.value > l1.value ? "higher low" : l2.value < l1.value ? "lower low" : "equal low";
      const close = price.at(-1)!.value;
      const position = close > h2.value ? "Above last swing high" : close < l2.value ? "Below last swing low" : "Between last swing low and high";
      return {
        readings: [
          { label: "Last swing high", value: h2.value, unit: "usd", at: iso(h2.time) },
          { label: "Previous swing high", value: h1.value, unit: "usd", at: iso(h1.time) },
          { label: "Last swing low", value: l2.value, unit: "usd", at: iso(l2.time) },
          { label: "Previous swing low", value: l1.value, unit: "usd", at: iso(l1.time) },
          { label: "Latest close", value: position, unit: "text" },
        ],
        state: `${highWord}, ${lowWord}`,
        used: [price],
      };
    },
  },
  {
    id: "closing_range_30", name: "30-day closing range", category: "market_structure", inputs: ["price"], minPoints: 30, windowDays: 30,
    parameters: { period: 30 }, periodLabel: "Last 30 daily closes",
    summary: "Highest and lowest daily close of the last 30 days.",
    description: "Highest and lowest daily close of the last 30 days and where the latest close sits between them (closes only; no intraday highs or lows).",
    formula: "high = max(close[t−29..t]); low = min(close[t−29..t]); position = (close[t] − low) / (high − low) × 100",
    compute: ([price]) => {
      const window = price.slice(-30);
      const high = window.reduce((best, point) => (point.value > best.value ? point : best));
      const low = window.reduce((best, point) => (point.value < best.value ? point : best));
      if (high.value === low.value) return null;
      const position = ((window.at(-1)!.value - low.value) / (high.value - low.value)) * 100;
      return {
        readings: [
          { label: "Closing high", value: high.value, unit: "usd", at: iso(high.time) },
          { label: "Closing low", value: low.value, unit: "usd", at: iso(low.time) },
          { label: "Position in range", value: position, unit: "percent" },
        ],
        state: null,
        used: [window],
      };
    },
  },

  // ---- On-chain (associated protocol / token supply) ----
  {
    // 7D only: current TVL and its 30-day change are shown once, in Fundamentals.
    id: "tvl_change_7d", name: "Associated protocol TVL change · 7D", category: "on_chain", inputs: ["tvl"], minPoints: 8, windowDays: 7,
    parameters: { period: 7 }, periodLabel: "Last 8 daily TVL values",
    summary: "Associated protocol TVL over 7 days (protocol scope).",
    description: "Change in the associated protocol's total value locked over the last 7 daily samples. Protocol scope, not the token.",
    formula: "change = (TVL[t] / TVL[t−7] − 1) × 100",
    compute: ([tvl]) => {
      const window = tvl.slice(-8);
      if (!spansExactly(7, [window[0], window.at(-1)!])) return null;
      const value = pctChange(window[0].value, window.at(-1)!.value);
      return value === null ? null : { readings: [{ label: "7D", value, unit: "percent_change" }], state: null, used: [window] };
    },
  },
  {
    id: "circulating_supply_change_7d", name: "Circulating supply change · 7D", category: "on_chain", inputs: ["circulatingSupply"], minPoints: 8, windowDays: 7,
    parameters: { period: 7 }, periodLabel: "8 consecutive daily supply samples",
    summary: "Change in circulating supply over 7 days.",
    description: "Change in reported circulating supply over 7 days.",
    formula: "change = (supply[t] / supply[t−7] − 1) × 100",
    compute: ([supply]) => {
      const window = supply.slice(-8);
      if (!spansExactly(7, [window[0], window.at(-1)!])) return null;
      const value = pctChange(window[0].value, window.at(-1)!.value);
      return value === null ? null : { readings: [{ label: "7D", value, unit: "percent_change" }], state: null, used: [window] };
    },
  },

  // ---- Cross-metric divergence ----
  {
    id: "price_vs_tvl_30d", name: "Price vs associated protocol TVL · 30D", category: "divergence", inputs: ["price", "tvl"], minPoints: 31, windowDays: 30,
    parameters: { period: 30, directionThresholdPct: DIRECTION_THRESHOLD_PCT }, periodLabel: "Last 31 aligned daily values",
    summary: "30-day price change vs associated protocol TVL change.",
    description: "Compares the token's 30-day price change with its associated protocol's TVL change, and how their daily changes co-move.",
    formula: "changes = (x[t] / x[t−30] − 1) × 100; moves within ±1% count as little changed; correlation = Pearson r of daily log changes (|r| < 0.3: no clear linear relationship)",
    compute: ([price, tvl]) => pairChange("Price", price, "TVL", tvl),
  },
  {
    id: "market_cap_vs_tvl_30d", name: "Market cap / TVL · 30D", category: "divergence", inputs: ["marketCap", "tvl"], minPoints: 31, windowDays: 30,
    parameters: { period: 30, directionThresholdPct: DIRECTION_THRESHOLD_PCT }, periodLabel: "Last 31 aligned daily values",
    summary: "Market cap relative to protocol TVL, now vs 30 days ago.",
    description: "Token market cap relative to the associated protocol's TVL, now and 30 days earlier.",
    formula: "ratio = marketCap / TVL at t and t−30; change = (ratio[t] / ratio[t−30] − 1) × 100; ±1% counts as little changed",
    compute: ([marketCap, tvl]) => {
      const m = marketCap.slice(-31), v = tvl.slice(-31);
      if (!spansExactly(30, [m[0], m.at(-1)!], [v[0], v.at(-1)!])) return null;
      const now = m.at(-1)!.value / v.at(-1)!.value, before = m[0].value / v[0].value;
      const change = pctChange(before, now);
      if (!finite(now, before, change)) return null;
      return {
        readings: [{ label: "Now", value: now, unit: "multiple" }, { label: "30 days earlier", value: before, unit: "multiple" }, { label: "Change", value: change!, unit: "percent_change" }],
        state: `${ratioState(change!)} of market cap relative to TVL`,
        used: [[m[0], m.at(-1)!], [v[0], v.at(-1)!]],
      };
    },
  },
  {
    id: "price_vs_volume_30d", name: "Price vs volume · 30D", category: "divergence", inputs: ["price", "volume"], minPoints: 37, windowDays: 30,
    parameters: { period: 30, volumeAverage: 7, directionThresholdPct: DIRECTION_THRESHOLD_PCT }, periodLabel: "Last 37 aligned daily values",
    summary: "30-day comparison using 7-day average volume.",
    description: "Compares the 30-day price change with the change in average daily volume (7-day averages ending now and 30 days earlier).",
    formula: "price change = (close[t] / close[t−30] − 1) × 100; volume change = (mean(vol[t−6..t]) / mean(vol[t−36..t−30]) − 1) × 100; ±1% counts as little changed",
    compute: ([price, volume]) => {
      const p = price.slice(-37), v = volume.slice(-37);
      // Volume averages end at t−30 and t, the same days as the price endpoints.
      if (!spansExactly(30, [p[6], p.at(-1)!], [v[6], v.at(-1)!])) return null;
      const priceChange = pctChange(p[6].value, p.at(-1)!.value);
      const volumeNow = mean(values(v.slice(-7))), volumeBefore = mean(values(v.slice(0, 7)));
      const volumeChange = volumeNow !== null && volumeBefore ? pctChange(volumeBefore, volumeNow) : null;
      if (priceChange === null || volumeChange === null) return null;
      return {
        readings: [{ label: "Price change", value: priceChange, unit: "percent_change" }, { label: "Avg volume change", value: volumeChange, unit: "percent_change" }],
        state: relationState("price", priceChange, "volume", volumeChange),
        used: [[p[6], p.at(-1)!], [...v.slice(0, 7), ...v.slice(-7)]],
      };
    },
  },
  {
    id: "volume_to_market_cap_30d", name: "Volume / market cap · 30D", category: "divergence", inputs: ["volume", "marketCap"], minPoints: 37, windowDays: 30,
    parameters: { period: 30, volumeAverage: 7, directionThresholdPct: DIRECTION_THRESHOLD_PCT }, periodLabel: "Last 37 aligned daily values",
    summary: "Turnover (7-day average volume / market cap), now vs 30 days ago.",
    description: "Turnover: average daily volume as a share of market cap, now and 30 days earlier.",
    formula: "turnover = mean(vol, 7 days) / marketCap × 100 at t and t−30; change = (now / earlier − 1) × 100; ±1% counts as little changed",
    compute: ([volume, marketCap]) => {
      const v = volume.slice(-37), m = marketCap.slice(-37);
      if (!spansExactly(30, [v[6], v.at(-1)!], [m[6], m.at(-1)!])) return null;
      const volumeNow = mean(values(v.slice(-7))), volumeBefore = mean(values(v.slice(0, 7)));
      if (volumeNow === null || volumeBefore === null) return null;
      const now = (volumeNow / m.at(-1)!.value) * 100, before = (volumeBefore / m[6].value) * 100;
      const change = pctChange(before, now);
      if (!finite(now, before, change)) return null;
      return {
        readings: [{ label: "Now", value: now, unit: "percent" }, { label: "30 days earlier", value: before, unit: "percent" }, { label: "Change", value: change!, unit: "percent_change" }],
        state: `${ratioState(change!)} of turnover`,
        used: [[...v.slice(0, 7), ...v.slice(-7)], [m[6], m.at(-1)!]],
      };
    },
  },
];

function pairChange(aName: string, a: DailyPoint[], bName: string, b: DailyPoint[]): Computed | null {
  const x = a.slice(-31), y = b.slice(-31);
  if (!spansExactly(30, [x[0], x.at(-1)!], [y[0], y.at(-1)!])) return null;
  const aChange = pctChange(x[0].value, x.at(-1)!.value), bChange = pctChange(y[0].value, y.at(-1)!.value);
  const r = correlation(logReturns(values(x)), logReturns(values(y)));
  if (aChange === null || bChange === null || r === null) return null;
  return {
    readings: [
      { label: `${aName} change`, value: aChange, unit: "percent_change" },
      { label: `${bName} change`, value: bChange, unit: "percent_change" },
      { label: "Daily-change correlation", value: r, unit: "ratio" },
      { label: "Relationship", value: relationshipLabel(r), unit: "text" },
    ],
    state: relationState(aName.toLowerCase(), aChange, bName, bChange),
    used: [x, y],
  };
}
