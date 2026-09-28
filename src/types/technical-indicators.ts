/**
 * Technical indicators: deterministic calculations from stored historical
 * observations. The server sends only indicators whose inputs exist, cover
 * the minimum history, and calculate to finite values; the UI never decides
 * availability.
 */

export const INDICATOR_CATEGORIES = [
  "trend", "momentum", "volatility", "volume", "market_structure", "derivatives", "on_chain", "divergence",
] as const;
export type IndicatorCategory = (typeof INDICATOR_CATEGORIES)[number];

/** Normalized daily input series (one value per UTC day boundary). */
export type IndicatorInput = "price" | "volume" | "marketCap" | "tvl" | "circulatingSupply";

export type IndicatorReading = {
  label: string;
  value: number | string;
  /**
   * usd: price-level USD; usd_total: large USD totals (volume, TVL); percent: a level (volatility, share);
   * percent_change: a signed change; percent_per_day; index (0–100); ratio: unitless (R², %B, r);
   * multiple: one value over another (×); date (ISO); text.
   */
  unit: "usd" | "usd_total" | "percent" | "percent_change" | "percent_per_day" | "index" | "ratio" | "multiple" | "date" | "text";
  /** Day the value refers to (UTC boundary), for values tied to one sample such as a swing high. */
  at?: string;
};

export type IndicatorProvenance = {
  /** Provider IDs of every input series (backend provenance; not shown as names in the UI). */
  providers: string[];
  inputs: IndicatorInput[];
  /** Every stored observation the calculation read, `token_metric_observations.id`. */
  sourceObservationIds: number[];
  observationCount: number;
  /** First and last daily sample used (UTC day boundaries). */
  observationStart: string;
  observationEnd: string;
  calculatedAt: string;
};

/**
 * available: calculated from the freshest usable contiguous run.
 * stale: calculable, but the newest usable sample is older than the indicator's freshness
 *   allowance; shown anyway with its true (older) date rather than hidden.
 * unavailable: could not be calculated at all (see `reason`); no readings.
 */
export type IndicatorStatus = "available" | "stale" | "unavailable";

export type TechnicalIndicator = {
  id: string;
  name: string;
  category: IndicatorCategory;
  status: IndicatorStatus;
  /** Parameter values, e.g. { period: 20, deviations: 2 }. */
  parameters: Record<string, number | string>;
  /** Plain description of the window, e.g. "20 daily closes". */
  periodLabel: string;
  /** One short line shown on the card; the full description and method sit in the disclosure. */
  summary: string;
  description: string;
  formula: string;
  /** Populated only when status is "available" or "stale". */
  readings: IndicatorReading[];
  /** Neutral, rule-defined state (never a trading signal), e.g. "Higher high, higher low". */
  state: string | null;
  /** Set only when status is "unavailable". */
  reason?: "missing_input" | "insufficient_history" | "not_calculable" | "protocol_not_mapped";
  /** Human-readable reason, shown only when status is "unavailable". */
  detail?: string;
  /** null only when status is "unavailable" (nothing was calculated). */
  provenance: IndicatorProvenance | null;
};

export type TechnicalIndicatorGroup = { category: IndicatorCategory; label: string; indicators: TechnicalIndicator[] };

export type TechnicalIndicatorsView = {
  calculatedAt: string;
  /** Normalization rule shared by every indicator. */
  method: string;
  groups: TechnicalIndicatorGroup[];
};
