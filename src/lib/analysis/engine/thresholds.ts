/**
 * Centralized, documented thresholds for the Deep Analysis Engine. Every magnitude band a finding
 * extractor uses comes from here — never a bare number scattered in analysis code — so the rules
 * driving "strong" vs "mild" momentum (for example) are auditable in one place and can be tuned
 * without touching the extraction logic itself.
 *
 * All percentage thresholds are absolute-value bands on a percent change (already the unit stored
 * by the metrics engine, e.g. price_growth_pct). All are deliberately round, conservative numbers
 * chosen to separate "worth surfacing" from "noise," not calibrated against any backtest.
 */

export type MomentumBand = "strong" | "moderate" | "mild" | "flat";

/** Bands for a directional percent change (price, market cap, TVL, fees, revenue, volume growth). */
export const MOMENTUM_BANDS: { band: MomentumBand; minAbsPct: number }[] = [
  { band: "strong", minAbsPct: 20 },
  { band: "moderate", minAbsPct: 5 },
  { band: "mild", minAbsPct: 1 },
  { band: "flat", minAbsPct: 0 },
];

export function momentumBand(changePct: number): MomentumBand {
  const abs = Math.abs(changePct);
  return MOMENTUM_BANDS.find((entry) => abs >= entry.minAbsPct)?.band ?? "flat";
}

export type VolatilityBand = "elevated" | "moderate" | "low";

/** Bands for annualized daily-return volatility (%), as already computed by historical-series.ts. */
export const VOLATILITY_BANDS: { band: VolatilityBand; minPct: number }[] = [
  { band: "elevated", minPct: 80 },
  { band: "moderate", minPct: 40 },
  { band: "low", minPct: 0 },
];

export function volatilityBand(volatilityPct: number): VolatilityBand {
  return VOLATILITY_BANDS.find((entry) => volatilityPct >= entry.minPct)?.band ?? "low";
}

/** A drawdown at or beyond this magnitude (%, negative values) is a "sharp drawdown" risk finding. */
export const SHARP_DRAWDOWN_PCT = 25;

/**
 * Volume/market-cap ratio (calc:volume_to_market_cap's raw value, a plain fraction — 0.15 means
 * volume is 15% of market cap, matching how metrics/engine.ts's ratio() computes it and formatRatio()
 * displays it, e.g. "0.15×" — never a pre-multiplied percentage).
 */
export const ELEVATED_VOLUME_TO_MCAP_RATIO = 0.15;
/** At or below this level, trading activity is "low" relative to market capitalization. */
export const LOW_VOLUME_TO_MCAP_RATIO = 0.01;

/** A percentage-point gap between two growth rates at or above this is a reportable divergence magnitude. */
export const DIVERGENCE_MIN_POINTS = 3;

/** FDV at or above this multiple of market cap is a reportable dilution/valuation-gap risk. */
export const FDV_TO_MARKET_CAP_GAP_RATIO = 1.5;

/** Circulating supply at or below this share (%) of maximum supply is a reportable dilution risk. */
export const LOW_CIRCULATING_SHARE_PCT = 50;

/** Minimum stored history points before a historical trend is described as established (see 4g). */
export const MIN_TREND_POINTS = 2;

/** Findings are capped per section so the report stays a curated summary, not a data dump (Priority). */
export const MAX_FINDINGS_PER_SECTION = 6;
