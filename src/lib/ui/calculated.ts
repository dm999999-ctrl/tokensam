import type { CalculatedMetricView } from "../../types/token.ts";
import { formatChange, formatCount, formatPoints, formatRatio, formatShare, formatUsd, intervalBetween, isValidNumber, type Interval, type Tone } from "./format.ts";

/**
 * Presentation of stored calculated metrics. Values are displayed, never
 * recalculated. The display kind follows the unit AND the category: a
 * "percent" growth metric is a directional change, whereas a "percent"
 * market-structure metric is a share and gets neutral styling.
 */

export type MetricKind = "usd" | "ratio" | "share" | "change" | "points" | "count" | "flag";

export type MetricDisplay = {
  id: string;
  label: string;
  value: string;
  kind: MetricKind;
  tone: Tone;
  interval: Interval | null;
  /** Human-readable formula for the methodology view / hover title. */
  formula: string;
};

/** Short user-facing labels. Section headers state the scope once, so labels omit it. */
const LABELS: Record<string, string> = {
  volume_to_market_cap: "Volume / market cap",
  price_growth_pct: "Price change",
  market_cap_growth_pct: "Market cap change",
  market_cap_to_tvl: "Market cap / TVL",
  market_cap_to_revenue_24h: "Market cap / 24h revenue",
  fdv_to_tvl: "DEX-reported FDV / TVL",
  fdv_to_revenue_24h: "DEX-reported FDV / 24h revenue",
  tvl_growth_pct: "TVL change · 24h",
  fees_growth_pct: "Fees change · 24h",
  revenue_growth_pct: "Revenue change · 24h",
  price_change_vs_tvl_growth_pct_points: "Price vs TVL change",
  price_change_vs_revenue_growth_pct_points: "Price vs revenue change",
  market_cap_change_vs_tvl_growth_pct_points: "Market cap vs TVL change",
  market_cap_change_vs_revenue_growth_pct_points: "Market cap vs revenue change",
  divergence_price_up_tvl_down: "Price up, TVL down",
  divergence_price_down_tvl_up: "Price down, TVL up",
  divergence_market_cap_up_faster_tvl: "Market cap outpaced TVL",
  divergence_tvl_up_faster_market_cap: "TVL outpaced market cap",
  divergence_revenue_up_market_cap_down: "Revenue up, market cap down",
  divergence_revenue_down_market_cap_up: "Revenue down, market cap up",
  dex_aggregate_liquidity_usd: "DEX liquidity",
  dex_aggregate_volume_24h_usd: "DEX volume · 24h",
  dex_primary_pair_liquidity_usd: "Primary pair liquidity",
  dex_primary_pair_volume_24h_usd: "Primary pair volume · 24h",
  dex_aggregate_liquidity_to_market_cap_pct: "DEX liquidity / market cap",
  dex_liquidity_to_market_cap_pct: "Primary pair liquidity / market cap",
  dex_volume_to_liquidity: "DEX volume / liquidity",
  dex_buy_sell_ratio: "Buy / sell ratio",
};

export function metricLabel(metric: Pick<CalculatedMetricView, "id" | "name">): string {
  return LABELS[metric.id] ?? metric.name;
}

export function metricKind(metric: Pick<CalculatedMetricView, "unit" | "category">): MetricKind {
  if (metric.unit === "USD") return "usd";
  if (metric.unit === "ratio") return "ratio";
  if (metric.unit === "count") return "count";
  if (metric.unit === "boolean") return "flag";
  if (metric.unit === "percentage_points") return "points";
  return metric.category === "growth" ? "change" : "share";
}

/** Null when the metric has no valid stored value (so the card is hidden). */
export function presentMetric(metric: CalculatedMetricView): MetricDisplay | null {
  if (metric.status !== "available" || !isValidNumber(metric.value)) return null;
  const kind = metricKind(metric);
  const interval = intervalBetween(metric.periodStartAt, metric.periodEndAt);
  let value: string | null = null;
  let tone: Tone = "neutral";
  if (kind === "usd") value = formatUsd(metric.value, true);
  else if (kind === "ratio") value = formatRatio(metric.value);
  else if (kind === "share") value = formatShare(metric.value);
  else if (kind === "points") value = formatPoints(metric.value);
  else if (kind === "count") value = formatCount(metric.value);
  else if (kind === "flag") value = metric.value === 1 ? "Observed" : "Not observed";
  else {
    const change = formatChange(metric.value);
    value = change?.text ?? null;
    // A snapshot-to-snapshot change is not a trend: keep it neutral.
    tone = change && interval && !interval.isShort ? change.tone : "neutral";
  }
  if (value === null) return null;
  return { id: metric.id, label: metricLabel(metric), value, kind, tone, interval, formula: metric.formula };
}

/** Which data scopes a metric draws on, from its stored source_scopes ("token/protocol"). */
export function metricScopes(metric: Pick<CalculatedMetricView, "sourceScopes" | "category">): Set<string> {
  return new Set((metric.sourceScopes ?? "").split("/").map((scope) => scope.trim()).filter(Boolean));
}

/** Profile section a calculated metric belongs to; scopes are never mixed into the wrong section. */
export function metricSection(metric: Pick<CalculatedMetricView, "id" | "sourceScopes" | "category">): "market" | "fundamentals" | "marketStructure" {
  const scopes = metricScopes(metric);
  // Without stored scopes (older catalog), fall back to the metric's protocol inputs.
  if (scopes.size === 0 && /tvl|revenue|fees|divergence/.test(metric.id)) return "fundamentals";
  if (scopes.has("protocol")) return "fundamentals";
  if (scopes.has("market") || metric.category === "market_structure") return "marketStructure";
  return "market";
}
