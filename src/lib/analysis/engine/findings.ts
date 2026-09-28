/**
 * Deep Analysis Engine — analytical layer. Reads the canonical profile payload (the same evidence
 * fields the page renders and the AI evidence contract cites) and produces structured Finding
 * objects: no prose here. The narrative composer (narrative.ts) turns findings into report text;
 * this module only decides WHAT is analytically worth saying and WHY (its evidence, period, and
 * severity), using the documented bands in thresholds.ts — never an undocumented magic number.
 *
 * A finding never states a number or period the cited field(s) do not themselves state: every
 * `evidenceIds` entry is a real field.id from the payload, and every number the narrative composer
 * will write for this finding comes from that field's own `raw`/`value`/`period` — the same
 * guarantee the (unchanged) evidence validator enforces for the old AI-generated reports, but here
 * true by construction rather than by policing an LLM's output.
 */

import type { PayloadField, ProfilePayload } from "../profile-payload.ts";
import {
  DIVERGENCE_MIN_POINTS,
  ELEVATED_VOLUME_TO_MCAP_RATIO,
  FDV_TO_MARKET_CAP_GAP_RATIO,
  LOW_CIRCULATING_SHARE_PCT,
  LOW_VOLUME_TO_MCAP_RATIO,
  MOMENTUM_BANDS,
  SHARP_DRAWDOWN_PCT,
  ACCELERATION_RATE_RATIO,
  DECELERATION_RATE_RATIO,
  momentumBand,
  volatilityBand,
  type MomentumBand,
  type MomentumPeriodKey,
} from "./thresholds.ts";

export type FindingCategory =
  | "marketPerformance" | "fundamentalPerformance" | "valuation"
  | "marketFundamentalRelationships" | "liquidityMarketStructure" | "tokenomics"
  | "risk" | "dataQuality";

export type FindingSeverity = "low" | "moderate" | "high";

/** One horizon's worth of a multi-horizon momentum comparison — never invented, always one field's own values. */
export type Horizon = { key: MomentumPeriodKey; days: number; raw: number; value: string; period: string | null; id: string };

/**
 * One structured analytical finding. `data` carries whatever the narrative composer needs to
 * phrase it (already-formatted display strings and raw numbers straight from the cited fields —
 * never a value not present on one of `evidenceIds`). `horizons` is populated only by the
 * multi-horizon momentum finding (see marketPerformanceFindings).
 */
export type Finding = {
  category: FindingCategory;
  findingType: string;
  severity: FindingSeverity;
  evidenceIds: string[];
  observationPeriods: (string | null)[];
  data: Record<string, string | number | null>;
  horizons?: Horizon[];
};

function byId(payload: ProfilePayload): Map<string, PayloadField> {
  return new Map(payload.fields.map((field) => [field.id, field]));
}

/** A field this token's profile actually shows a value for (never "not_reported"). */
function shown(fields: Map<string, PayloadField>, id: string): PayloadField | null {
  const field = fields.get(id);
  return field && field.status === "shown" && field.raw !== null ? field : null;
}

const severityForMomentum: Record<MomentumBand, FindingSeverity> = { strong: "high", moderate: "moderate", mild: "low", flat: "low" };

// ---- 6/11. Market performance: multi-horizon momentum ----

const HORIZON_DAYS: Record<MomentumPeriodKey, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

function horizonFrom(key: MomentumPeriodKey, field: PayloadField | null): Horizon | null {
  if (!field || field.raw === null) return null;
  return { key, days: HORIZON_DAYS[key], raw: field.raw, value: field.value, period: field.period, id: field.id };
}

/**
 * Gathers every price-change horizon this token's snapshot actually has (never inferring a horizon
 * that has no field, and never treating a single stored point as a trend — see 4g). Real data is
 * sparse in practice: a token may have only 24h/7d, or only a 90D history window, and the finding
 * below must work with whatever subset is genuinely available.
 */
function availableHorizons(fields: Map<string, PayloadField>): Horizon[] {
  const horizons = [
    horizonFrom("24h", shown(fields, "obs:change_24h")),
    horizonFrom("7d", shown(fields, "obs:change_7d")),
    horizonFrom("30d", shown(fields, "hist:price_30d")),
    horizonFrom("90d", shown(fields, "hist:price_90d")),
  ].filter((horizon): horizon is Horizon => horizon !== null);
  return horizons.sort((a, b) => a.days - b.days);
}

/** "flat" horizons (sub-1% moves) are excluded from directional-consistency judgments, not from the data itself. */
function directionOf(horizon: Horizon): "up" | "down" | "flat" {
  const band = momentumBand(horizon.raw);
  if (band === "flat") return "flat";
  return horizon.raw >= 0 ? "up" : "down";
}

/**
 * Classifies the relationship between the shortest and longest available horizons: whether the
 * recent per-day pace of change is running faster ("accelerating"), slower ("decelerating"), or
 * about the same ("steady") as the pace over the remainder of the longer window. This never
 * compares horizons whose signs disagree (that is a reversal, handled separately) and never invents
 * a rate for a horizon that was not actually stored.
 */
function paceClassification(shortest: Horizon, longest: Horizon): "accelerating" | "decelerating" | "steady" {
  if (shortest.key === longest.key) return "steady";
  const recentRate = shortest.raw / shortest.days;
  const priorSpanDays = longest.days - shortest.days;
  const priorRate = priorSpanDays > 0 ? (longest.raw - shortest.raw) / priorSpanDays : recentRate;
  if (priorRate === 0) return recentRate === 0 ? "steady" : "accelerating";
  const ratio = Math.abs(recentRate / priorRate);
  if (ratio >= ACCELERATION_RATE_RATIO) return "accelerating";
  if (ratio <= DECELERATION_RATE_RATIO) return "decelerating";
  return "steady";
}

export type MultiHorizonPattern =
  | "consistent_up_accelerating" | "consistent_up_decelerating" | "consistent_up_steady"
  | "consistent_down_accelerating" | "consistent_down_decelerating" | "consistent_down_steady"
  | "reversal_to_down" | "reversal_to_up" | "mixed" | "single_up" | "single_down" | "flat";

/**
 * The horizons that drive the *pattern* classification (consistency, acceleration/deceleration).
 * A 24-hour change is noisy day to day, so whenever a longer horizon (7D/30D/90D) is also
 * available, 24H is excluded from the pattern judgment and shown only as supplementary detail —
 * otherwise a single volatile day could flip "consistent positive momentum" to "mixed" on its own.
 * With only 24H available, it is of course the pattern.
 */
function patternHorizons(horizons: Horizon[]): Horizon[] {
  const longer = horizons.filter((horizon) => horizon.key !== "24h");
  // Only exclude 24H when at least two longer horizons remain to classify a pattern from — with
  // just one longer horizon, 24H is needed too or a genuinely consistent 2-point trend (e.g. 24H+7D
  // both up) would otherwise collapse to a "single horizon" finding and understate the evidence.
  return longer.length >= 2 ? longer : horizons;
}

/** One consolidated momentum finding covering every available horizon — never one finding per horizon. */
function multiHorizonMomentumFinding(fields: Map<string, PayloadField>): Finding | null {
  const horizons = availableHorizons(fields);
  if (horizons.length === 0) return null;
  const forPattern = patternHorizons(horizons);
  const shortest = forPattern[0];
  const longest = forPattern[forPattern.length - 1];
  const directions = forPattern.map(directionOf);
  const nonFlat = directions.filter((direction) => direction !== "flat");

  let pattern: MultiHorizonPattern;
  let severity: FindingSeverity;
  if (forPattern.length === 1) {
    const direction = directions[0];
    pattern = direction === "up" ? "single_up" : direction === "down" ? "single_down" : "flat";
    severity = severityForMomentum[momentumBand(shortest.raw)];
  } else if (nonFlat.length === 0) {
    pattern = "flat";
    severity = "low";
  } else if (nonFlat.every((direction) => direction === "up") && directions[0] !== "flat" && directions[directions.length - 1] !== "flat") {
    const pace = paceClassification(shortest, longest);
    pattern = pace === "accelerating" ? "consistent_up_accelerating" : pace === "decelerating" ? "consistent_up_decelerating" : "consistent_up_steady";
    severity = severityForMomentum[momentumBand(longest.raw)];
  } else if (nonFlat.every((direction) => direction === "down") && directions[0] !== "flat" && directions[directions.length - 1] !== "flat") {
    const pace = paceClassification(shortest, longest);
    pattern = pace === "accelerating" ? "consistent_down_accelerating" : pace === "decelerating" ? "consistent_down_decelerating" : "consistent_down_steady";
    severity = severityForMomentum[momentumBand(longest.raw)];
  } else if (directions[0] !== "flat" && directions[directions.length - 1] !== "flat" && directions[0] !== directions[directions.length - 1]) {
    // The most recent (pattern-eligible) horizon disagrees in direction with the longest
    // available horizon: a reversal within the observed history, named for where it now stands.
    pattern = directions[0] === "down" ? "reversal_to_down" : "reversal_to_up";
    severity = "moderate";
  } else {
    pattern = "mixed";
    severity = "low";
  }

  return {
    category: "marketPerformance", findingType: `multi_horizon_${pattern}`, severity,
    evidenceIds: horizons.map((horizon) => horizon.id), observationPeriods: horizons.map((horizon) => horizon.period),
    data: { patternShortestKey: shortest.key, patternLongestKey: longest.key },
    horizons,
  };
}

export function marketPerformanceFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  const momentum = multiHorizonMomentumFinding(fields);
  if (momentum) findings.push(momentum);

  // Volume level relative to market cap is a market-structure characteristic (see liquidityFindings
  // for the ratio itself); here we only note the price/volume behavioral pattern it produces.
  const volumeShare = shown(fields, "calc:volume_to_market_cap");
  const change24h = shown(fields, "obs:change_24h");
  const volume24h = shown(fields, "obs:volume_24h");
  if (change24h && volume24h && volumeShare && change24h.raw !== null && volumeShare.raw !== null) {
    if (change24h.raw < 0 && volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO) {
      findings.push({
        category: "marketPerformance", findingType: "elevated_volume_during_decline", severity: "moderate",
        evidenceIds: [change24h.id, volumeShare.id], observationPeriods: [change24h.period, volumeShare.period],
        data: { changeValue: change24h.value, volumeShareValue: volumeShare.value },
      });
    } else if (change24h.raw > 0 && volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO) {
      findings.push({
        category: "marketPerformance", findingType: "elevated_volume_during_advance", severity: "low",
        evidenceIds: [change24h.id, volumeShare.id], observationPeriods: [change24h.period, volumeShare.period],
        data: { changeValue: change24h.value, volumeShareValue: volumeShare.value },
      });
    }
  }
  return findings;
}

// ---- 7. Fundamental / protocol activity ----

const growthFinding = (key: "tvl" | "fees" | "revenue", field: PayloadField | null): Finding | null => {
  if (!field || field.raw === null) return null;
  const band = momentumBand(field.raw);
  if (band === "flat") return null;
  return {
    category: "fundamentalPerformance", findingType: `${key}_growth_${field.raw >= 0 ? "increase" : "decrease"}`,
    severity: severityForMomentum[band], evidenceIds: [field.id], observationPeriods: [field.period],
    data: { value: field.value, raw: field.raw, period: field.period },
  };
};

export function fundamentalFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];

  const tvlGrowth = growthFinding("tvl", shown(fields, "calc:tvl_change_30d") ?? shown(fields, "calc:tvl_growth_pct"));
  if (tvlGrowth) findings.push(tvlGrowth);
  const feesGrowth = growthFinding("fees", shown(fields, "calc:fees_growth_pct"));
  if (feesGrowth) findings.push(feesGrowth);
  const revenueGrowth = growthFinding("revenue", shown(fields, "calc:revenue_growth_pct"));
  if (revenueGrowth) findings.push(revenueGrowth);

  // Current levels, independent of whether a growth rate could also be computed — a report should
  // never omit that TVL/fees/revenue are simply *present* just because no trend was available.
  const tvl = shown(fields, "obs:tvl");
  if (tvl) findings.push({ category: "fundamentalPerformance", findingType: "tvl_level", severity: "low", evidenceIds: [tvl.id], observationPeriods: [tvl.period], data: { value: tvl.value } });
  const fees = shown(fields, "obs:fees_24h");
  const revenue = shown(fields, "obs:revenue_24h");
  if (fees && revenue && fees.raw !== null && revenue.raw !== null && fees.raw > 0) {
    findings.push({
      category: "fundamentalPerformance", findingType: "fee_revenue_relationship", severity: "low",
      evidenceIds: [fees.id, revenue.id], observationPeriods: [fees.period, revenue.period],
      data: { feesValue: fees.value, revenueValue: revenue.value },
    });
  }

  // Synthesis: when at least two independent growth signals are available, characterize the
  // overall direction of protocol activity — never inferred from a single metric alone.
  const growthSignals = [tvlGrowth, feesGrowth, revenueGrowth].filter((finding): finding is Finding => finding !== null);
  if (growthSignals.length >= 2) {
    const ups = growthSignals.filter((finding) => finding.findingType.endsWith("_increase")).length;
    const downs = growthSignals.filter((finding) => finding.findingType.endsWith("_decrease")).length;
    const synthesis = ups === growthSignals.length ? "fundamentals_improving" : downs === growthSignals.length ? "fundamentals_deteriorating" : "fundamentals_mixed";
    findings.push({
      category: "fundamentalPerformance", findingType: synthesis, severity: synthesis === "fundamentals_mixed" ? "low" : "moderate",
      evidenceIds: growthSignals.flatMap((finding) => finding.evidenceIds), observationPeriods: growthSignals.flatMap((finding) => finding.observationPeriods),
      data: {},
    });
  }
  return findings;
}

// ---- 8. Valuation: genuine valuation/activity multiples only ----

const VALUATION_RATIO_IDS = ["calc:market_cap_to_tvl", "calc:fdv_to_tvl", "calc:market_cap_to_revenue_24h", "calc:fdv_to_revenue_24h"] as const;

export function valuationFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const id of VALUATION_RATIO_IDS) {
    const field = shown(fields, id);
    if (!field) continue;
    findings.push({
      category: "valuation", findingType: `ratio_${id.replace("calc:", "")}`, severity: "low",
      evidenceIds: [field.id], observationPeriods: [field.period],
      data: { label: field.label, value: field.value, raw: field.raw },
    });
  }
  // FDV vs market cap: a large gap is a dilution-relevant valuation characteristic (also feeds risk).
  const fdv = shown(fields, "obs:fdv");
  const marketCap = shown(fields, "obs:market_cap");
  if (fdv && marketCap && fdv.raw !== null && marketCap.raw !== null && marketCap.raw > 0) {
    const ratio = fdv.raw / marketCap.raw;
    if (ratio >= FDV_TO_MARKET_CAP_GAP_RATIO) {
      findings.push({
        category: "valuation", findingType: "fdv_market_cap_gap", severity: ratio >= FDV_TO_MARKET_CAP_GAP_RATIO * 2 ? "high" : "moderate",
        evidenceIds: [fdv.id, marketCap.id], observationPeriods: [fdv.period, marketCap.period],
        data: { fdvValue: fdv.value, marketCapValue: marketCap.value, ratio },
      });
    }
  }
  return findings;
}

// ---- 9. Liquidity / market structure ----

const STRUCTURE_IDS = [
  "calc:dex_aggregate_liquidity_usd", "calc:dex_aggregate_volume_24h_usd", "calc:dex_liquidity_to_market_cap_pct",
  "calc:dex_aggregate_liquidity_to_market_cap_pct", "calc:dex_volume_to_liquidity", "calc:dex_buy_sell_ratio", "obs:transactions_24h",
] as const;

export function liquidityFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const id of STRUCTURE_IDS) {
    const field = shown(fields, id);
    if (!field) continue;
    findings.push({
      category: "liquidityMarketStructure", findingType: `structure_${id.replace(/^(calc|obs):/, "")}`, severity: "low",
      evidenceIds: [field.id], observationPeriods: [field.period],
      data: { label: field.label, value: field.value },
    });
  }
  // Trading-volume turnover relative to market cap belongs here, not in valuation (it measures
  // activity/turnover, not what the market pays for the asset relative to a fundamental).
  const volumeShare = shown(fields, "calc:volume_to_market_cap");
  if (volumeShare && volumeShare.raw !== null) {
    if (volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO || volumeShare.raw <= LOW_VOLUME_TO_MCAP_RATIO) {
      findings.push({
        category: "liquidityMarketStructure", findingType: volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO ? "elevated_turnover" : "low_turnover",
        severity: "moderate", evidenceIds: [volumeShare.id], observationPeriods: [volumeShare.period],
        data: { value: volumeShare.value, raw: volumeShare.raw },
      });
    } else {
      findings.push({
        category: "liquidityMarketStructure", findingType: "turnover_level", severity: "low",
        evidenceIds: [volumeShare.id], observationPeriods: [volumeShare.period], data: { value: volumeShare.value },
      });
    }
  }
  return findings;
}

// ---- 10. Tokenomics ----

/**
 * The field's own value already reads "41.0% circulating (4.1B of 10B SUI)" (see
 * profile-payload.ts's `composition` label) — a self-contained clause built for standalone display.
 * Appending "of maximum supply" after it verbatim (as the narrative used to) doubles up "circulating
 * ... of maximum supply." This pulls out just the parenthetical breakdown so the narrative composer
 * can build its own grammatical sentence around the finding's own `raw` percentage instead, without
 * fabricating any figure the field did not already report.
 */
function parenthetical(value: string): string | null {
  return /\(([^)]+)\)/.exec(value)?.[1] ?? null;
}

export function tokenomicsFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  const circulatingShare = shown(fields, "calc:circulating_of_max_supply");
  if (circulatingShare && circulatingShare.raw !== null && circulatingShare.raw <= LOW_CIRCULATING_SHARE_PCT) {
    findings.push({
      category: "tokenomics", findingType: "low_circulating_share", severity: "moderate",
      evidenceIds: [circulatingShare.id], observationPeriods: [circulatingShare.period],
      data: { value: circulatingShare.value, raw: circulatingShare.raw, breakdown: parenthetical(circulatingShare.value) },
    });
  }
  const mcapOfFdv = shown(fields, "calc:market_cap_of_fdv");
  if (mcapOfFdv) {
    findings.push({
      category: "tokenomics", findingType: "market_cap_of_fdv", severity: "low",
      evidenceIds: [mcapOfFdv.id], observationPeriods: [mcapOfFdv.period],
      data: { value: mcapOfFdv.value },
    });
  }
  const circulating = shown(fields, "obs:circulating_supply");
  const total = shown(fields, "obs:total_supply");
  let statedSupplyRelationship = false;
  if (circulating && total && circulating.raw !== null && total.raw !== null) {
    statedSupplyRelationship = true;
    // The raw numbers decide the fact (never rounded for that comparison), but a displayed compact
    // figure (e.g. "20.09M") can round two genuinely different raw values to the identical string.
    // Flag that collision so the narrative composer can fall back to full, still-evidence-grounded
    // precision instead of asserting "below" between two numbers that read as equal — see the
    // module comment on never writing a number the cited field's own raw value does not support.
    const displaysCollide = circulating.raw < total.raw && circulating.value === total.value;
    findings.push({
      category: "tokenomics", findingType: circulating.raw >= total.raw ? "circulating_equals_total" : "circulating_below_total",
      severity: "low", evidenceIds: [circulating.id, total.id], observationPeriods: [circulating.period, total.period],
      data: {
        circulatingValue: circulating.value, totalValue: total.value,
        circulatingRaw: circulating.raw, totalRaw: total.raw,
        displaysCollide: displaysCollide ? "yes" : "no",
      },
    });
  }
  const uncapped = fields.get("obs:maximum_supply");
  if ((circulating || total) && uncapped && uncapped.status === "not_reported") {
    findings.push({
      category: "tokenomics", findingType: "supply_uncapped", severity: "low",
      evidenceIds: [circulating ?? total!].map((field) => field!.id), observationPeriods: [(circulating ?? total)!.period],
      data: { value: (circulating ?? total)!.value },
    });
  }
  // Circulating/total, when both present, are already stated together by the relationship finding
  // above; restating them again individually here would be the "database dump" style this engine
  // avoids. Maximum supply is never covered by that relationship, so it is always stated on its own.
  const bareSupplyIds = statedSupplyRelationship ? (["obs:maximum_supply"] as const) : (["obs:circulating_supply", "obs:total_supply", "obs:maximum_supply"] as const);
  for (const id of bareSupplyIds) {
    const field = shown(fields, id);
    if (field) findings.push({ category: "tokenomics", findingType: `supply_${id.replace("obs:", "")}`, severity: "low", evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label, value: field.value } });
  }
  return findings;
}

// ---- 12. Divergence engine ----

/** The metrics engine's own boolean divergence flags (metrics/engine.ts, category "divergence"). */
const DIVERGENCE_FLAG_IDS = [
  "calc:divergence_price_up_tvl_down", "calc:divergence_price_down_tvl_up",
  "calc:divergence_market_cap_up_faster_tvl", "calc:divergence_tvl_up_faster_market_cap",
  "calc:divergence_revenue_up_market_cap_down", "calc:divergence_revenue_down_market_cap_up",
] as const;

const DIVERGENCE_POINTS_IDS = [
  "calc:price_change_vs_tvl_growth_pct_points", "calc:price_change_vs_revenue_growth_pct_points",
  "calc:market_cap_change_vs_tvl_growth_pct_points", "calc:market_cap_change_vs_revenue_growth_pct_points",
] as const;

export function divergenceFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const id of DIVERGENCE_FLAG_IDS) {
    const field = shown(fields, id);
    // A divergence metric is "available" once computed (Observed or Not observed); only the
    // TRUE case (raw === 1) is a reportable finding — "not observed" is the absence of a pattern,
    // not itself an analytical finding.
    if (!field || field.raw !== 1) continue;
    findings.push({
      category: "marketFundamentalRelationships", findingType: id.replace("calc:divergence_", "divergence_"), severity: "moderate",
      evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label, intervalHours: field.intervalHours },
    });
  }
  for (const id of DIVERGENCE_POINTS_IDS) {
    const field = shown(fields, id);
    if (!field || field.raw === null || Math.abs(field.raw) < DIVERGENCE_MIN_POINTS) continue;
    findings.push({
      category: "marketFundamentalRelationships", findingType: `points_${id.replace(/^calc:|_pct_points$/g, "")}`, severity: "low",
      evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label, value: field.value, raw: field.raw, intervalHours: field.intervalHours },
    });
  }
  return findings;
}

// ---- 11 / 13. Historical signals and risk ----

export function riskFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  const riskFieldsChecked: PayloadField[] = [];
  for (const period of ["7d", "30d", "90d"] as const) {
    const field = shown(fields, `hist:risk_${period}`);
    if (!field || field.raw === null) continue;
    riskFieldsChecked.push(field);
    // raw is volatility (%) when available, else drawdown (%, <= 0); the displayed value already
    // states both terms explicitly, so citing it is exact regardless of which populated raw.
    const band = field.raw >= 0 ? volatilityBand(field.raw) : "elevated";
    if (field.raw >= 0 && band !== "elevated") continue;
    if (field.raw < 0 && Math.abs(field.raw) < SHARP_DRAWDOWN_PCT) continue;
    findings.push({
      category: "risk", findingType: field.raw >= 0 ? "elevated_volatility" : "sharp_drawdown", severity: "high",
      evidenceIds: [field.id], observationPeriods: [field.period], data: { value: field.value, period: field.period, raw: field.raw },
    });
  }
  // A large FDV/market-cap gap (already surfaced in valuation) is also a risk-relevant dilution characteristic.
  const fdv = shown(fields, "obs:fdv");
  const marketCap = shown(fields, "obs:market_cap");
  const dilutionChecked = Boolean(fdv && marketCap);
  if (fdv && marketCap && fdv.raw !== null && marketCap.raw !== null && marketCap.raw > 0 && fdv.raw / marketCap.raw >= FDV_TO_MARKET_CAP_GAP_RATIO) {
    findings.push({
      category: "risk", findingType: "dilution_gap", severity: "moderate",
      evidenceIds: [fdv.id, marketCap.id], observationPeriods: [fdv.period, marketCap.period],
      data: { fdvValue: fdv.value, marketCapValue: marketCap.value },
    });
  }
  // A market/fundamental divergence is itself a risk-relevant characteristic worth flagging once.
  const divergenceChecked: PayloadField[] = [];
  for (const id of DIVERGENCE_FLAG_IDS) {
    const field = fields.get(id);
    if (field && field.status === "shown") divergenceChecked.push(field);
  }
  const negativeDivergence = fields.get("calc:divergence_price_up_tvl_down");
  if (negativeDivergence && negativeDivergence.raw === 1) {
    findings.push({
      category: "risk", findingType: "market_fundamental_divergence", severity: "moderate",
      evidenceIds: [negativeDivergence.id], observationPeriods: [negativeDivergence.period], data: {},
    });
  }
  const circulatingShare = shown(fields, "calc:circulating_of_max_supply");
  if (circulatingShare && circulatingShare.raw !== null && circulatingShare.raw <= LOW_CIRCULATING_SHARE_PCT) {
    findings.push({
      category: "risk", findingType: "low_circulating_supply_share", severity: "moderate",
      evidenceIds: [circulatingShare.id], observationPeriods: [circulatingShare.period], data: { value: circulatingShare.value },
    });
  }

  // When none of the above fired, name which risk dimensions were actually evaluated against this
  // token's real data (never claiming a dimension was checked when no field for it exists at all).
  if (findings.length === 0) {
    const checkedIds = [...riskFieldsChecked.map((field) => field.id), ...(dilutionChecked ? [fdv!.id, marketCap!.id] : []), ...divergenceChecked.map((field) => field.id)];
    if (checkedIds.length > 0) {
      findings.push({
        category: "risk", findingType: "no_elevated_risk_indicated", severity: "low",
        evidenceIds: [...new Set(checkedIds)], observationPeriods: [],
        data: {
          checkedVolatility: riskFieldsChecked.length > 0 ? "yes" : "no",
          checkedDilution: dilutionChecked ? "yes" : "no",
          checkedDivergence: divergenceChecked.length > 0 ? "yes" : "no",
        },
      });
    }
  }
  return findings;
}

// ---- 14. Data quality ----

/** Fields whose absence (not_reported) is itself worth naming as a coverage gap. */
const COVERAGE_FIELD_IDS = [
  ["obs:tvl", "TVL"], ["obs:fees_24h", "fees"], ["obs:revenue_24h", "revenue"],
  ["obs:maximum_supply", "maximum supply"], ["obs:market_cap", "market capitalization"],
] as const;

export function dataQualityFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const note of payload.scope) {
    if (note.mapped) continue;
    findings.push({
      category: "dataQuality", findingType: `unmapped_${note.provider.toLowerCase().replace(/\s+/g, "_")}`, severity: "low",
      evidenceIds: [note.id], observationPeriods: [null], data: { provider: note.provider, statement: note.statement },
    });
  }
  for (const [id, label] of COVERAGE_FIELD_IDS) {
    const field = fields.get(id);
    if (field && field.status === "not_reported") {
      findings.push({
        category: "dataQuality", findingType: `missing_${id.replace(/^obs:/, "")}`, severity: "low",
        evidenceIds: [field.id], observationPeriods: [null], data: { label },
      });
    }
  }
  // A hist: series present in name but with no usable trend (fewer than two stored points) is a
  // genuine data-quality gap, not a "flat" market-performance finding — see thresholds MIN_TREND_POINTS.
  for (const key of ["price", "volume", "market_cap", "tvl"] as const) {
    for (const period of ["24h", "7d", "30d", "90d"] as const) {
      const field = fields.get(`hist:${key}_${period}`);
      if (field && field.status === "shown" && field.raw === null) {
        findings.push({
          category: "dataQuality", findingType: `insufficient_history_${key}_${period}`, severity: "low",
          evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label },
        });
      }
    }
  }
  return findings;
}

/** Runs every category extractor over one payload. */
export function extractFindings(payload: ProfilePayload): Finding[] {
  return [
    ...marketPerformanceFindings(payload),
    ...fundamentalFindings(payload),
    ...valuationFindings(payload),
    ...liquidityFindings(payload),
    ...tokenomicsFindings(payload),
    ...divergenceFindings(payload),
    ...riskFindings(payload),
    ...dataQualityFindings(payload),
  ];
}

export { MOMENTUM_BANDS };
