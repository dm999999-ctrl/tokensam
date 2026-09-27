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
  momentumBand,
  volatilityBand,
  type MomentumBand,
} from "./thresholds.ts";

export type FindingCategory =
  | "marketPerformance" | "fundamentalPerformance" | "valuation"
  | "marketFundamentalRelationships" | "liquidityMarketStructure" | "tokenomics"
  | "risk" | "dataQuality";

export type FindingSeverity = "low" | "moderate" | "high";

/**
 * One structured analytical finding. `data` carries whatever the narrative composer needs to
 * phrase it (already-formatted display strings and raw numbers straight from the cited fields —
 * never a value not present on one of `evidenceIds`).
 */
export type Finding = {
  category: FindingCategory;
  findingType: string;
  severity: FindingSeverity;
  evidenceIds: string[];
  observationPeriods: (string | null)[];
  data: Record<string, string | number | null>;
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

/** One momentum finding for a directional change field, if it has a real value. */
function momentumFinding(category: FindingCategory, findingType: string, field: PayloadField | null): Finding | null {
  if (!field || field.raw === null) return null;
  const band = momentumBand(field.raw);
  if (band === "flat") return null; // Flat is noise, not a finding worth surfacing on its own.
  return {
    category, findingType: `${findingType}_${field.raw >= 0 ? "increase" : "decrease"}`, severity: severityForMomentum[band],
    evidenceIds: [field.id], observationPeriods: [field.period],
    data: { band, value: field.value, raw: field.raw, period: field.period, label: field.label },
  };
}

// ---- 6. Market performance ----

export function marketPerformanceFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const id of ["obs:change_24h", "obs:change_7d"] as const) {
    const finding = momentumFinding("marketPerformance", `price_${id === "obs:change_24h" ? "24h" : "7d"}`, shown(fields, id));
    if (finding) findings.push(finding);
  }
  // Historical price windows (30D/90D and beyond) come from hist:price_* fields, and only when a
  // real trend exists (>=2 stored points — see 4g: a single-point series states no change).
  for (const period of ["30d", "90d"] as const) {
    const field = shown(fields, `hist:price_${period}`);
    if (!field) continue;
    const band = momentumBand(field.raw!);
    if (band === "flat") continue;
    findings.push({
      category: "marketPerformance", findingType: `historical_price_${period}_${field.raw! >= 0 ? "increase" : "decrease"}`,
      severity: severityForMomentum[band], evidenceIds: [field.id], observationPeriods: [field.period],
      data: { band, value: field.value, raw: field.raw, period: field.period, label: field.label },
    });
  }
  // Volume level relative to market cap (a snapshot ratio, not a trend).
  const volumeShare = shown(fields, "calc:volume_to_market_cap");
  if (volumeShare && volumeShare.raw !== null) {
    if (volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO || volumeShare.raw <= LOW_VOLUME_TO_MCAP_RATIO) {
      findings.push({
        category: "marketPerformance", findingType: volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO ? "elevated_trading_activity" : "low_trading_activity",
        severity: "moderate", evidenceIds: [volumeShare.id], observationPeriods: [volumeShare.period],
        data: { value: volumeShare.value, raw: volumeShare.raw },
      });
    }
  }
  // Price/volume relationship over the same 24h window, when both are grounded together.
  const change24h = shown(fields, "obs:change_24h");
  const volume24h = shown(fields, "obs:volume_24h");
  if (change24h && volume24h && change24h.raw !== null && volumeShare?.raw !== undefined && volumeShare.raw !== null) {
    if (change24h.raw < 0 && volumeShare.raw >= ELEVATED_VOLUME_TO_MCAP_RATIO) {
      findings.push({
        category: "marketPerformance", findingType: "elevated_volume_during_decline", severity: "moderate",
        evidenceIds: [change24h.id, volumeShare.id], observationPeriods: [change24h.period, volumeShare.period],
        data: { changeValue: change24h.value, volumeShareValue: volumeShare.value },
      });
    }
  }
  return findings;
}

// ---- 7. Fundamental / protocol activity ----

export function fundamentalFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  const tvlChange = shown(fields, "calc:tvl_change_30d");
  const tvlFinding = momentumFinding("fundamentalPerformance", "tvl_30d", tvlChange);
  if (tvlFinding) findings.push(tvlFinding);
  // Fees/revenue are 24h snapshots (no stored prior period to compare against here), so they are
  // reported as levels, not as growth findings — see the narrative composer for the wording.
  const fees = shown(fields, "obs:fees_24h");
  const revenue = shown(fields, "obs:revenue_24h");
  if (fees && revenue && fees.raw !== null && revenue.raw !== null && fees.raw > 0) {
    findings.push({
      category: "fundamentalPerformance", findingType: "fee_revenue_relationship", severity: "low",
      evidenceIds: [fees.id, revenue.id], observationPeriods: [fees.period, revenue.period],
      data: { feesValue: fees.value, revenueValue: revenue.value },
    });
  }
  return findings;
}

// ---- 8. Valuation ----

const VALUATION_RATIO_IDS = [
  "calc:market_cap_to_tvl", "calc:fdv_to_tvl", "calc:market_cap_to_revenue_24h", "calc:fdv_to_revenue_24h",
  "calc:volume_to_market_cap", "calc:dex_volume_to_liquidity",
] as const;

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

export function liquidityFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const id of ["calc:dex_aggregate_liquidity_usd", "calc:dex_aggregate_volume_24h_usd", "calc:dex_liquidity_to_market_cap_pct", "calc:dex_aggregate_liquidity_to_market_cap_pct", "calc:dex_buy_sell_ratio", "obs:transactions_24h"] as const) {
    const field = shown(fields, id);
    if (!field) continue;
    findings.push({
      category: "liquidityMarketStructure", findingType: `structure_${id.replace(/^(calc|obs):/, "")}`, severity: "low",
      evidenceIds: [field.id], observationPeriods: [field.period],
      data: { label: field.label, value: field.value },
    });
  }
  return findings;
}

// ---- 10. Tokenomics ----

export function tokenomicsFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  const circulatingShare = shown(fields, "calc:circulating_of_max_supply");
  if (circulatingShare && circulatingShare.raw !== null && circulatingShare.raw <= LOW_CIRCULATING_SHARE_PCT) {
    findings.push({
      category: "tokenomics", findingType: "low_circulating_share", severity: "moderate",
      evidenceIds: [circulatingShare.id], observationPeriods: [circulatingShare.period],
      data: { value: circulatingShare.value, raw: circulatingShare.raw },
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
  for (const id of ["obs:circulating_supply", "obs:total_supply", "obs:maximum_supply"] as const) {
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
      evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label },
    });
  }
  for (const id of DIVERGENCE_POINTS_IDS) {
    const field = shown(fields, id);
    if (!field || field.raw === null || Math.abs(field.raw) < DIVERGENCE_MIN_POINTS) continue;
    findings.push({
      category: "marketFundamentalRelationships", findingType: `points_${id.replace(/^calc:|_pct_points$/g, "")}`, severity: "low",
      evidenceIds: [field.id], observationPeriods: [field.period], data: { label: field.label, value: field.value, raw: field.raw },
    });
  }
  return findings;
}

// ---- 11 / 13. Historical signals and risk ----

export function riskFindings(payload: ProfilePayload): Finding[] {
  const fields = byId(payload);
  const findings: Finding[] = [];
  for (const period of ["7d", "30d", "90d"] as const) {
    const field = shown(fields, `hist:risk_${period}`);
    if (!field || field.raw === null) continue;
    // raw is volatility (%) when available, else drawdown (%, <= 0); the displayed value already
    // states both terms explicitly, so citing it is exact regardless of which populated raw.
    const band = field.raw >= 0 ? volatilityBand(field.raw) : "elevated";
    if (field.raw >= 0 && band !== "elevated") continue;
    if (field.raw < 0 && Math.abs(field.raw) < SHARP_DRAWDOWN_PCT) continue;
    findings.push({
      category: "risk", findingType: field.raw >= 0 ? "elevated_volatility" : "sharp_drawdown", severity: "high",
      evidenceIds: [field.id], observationPeriods: [field.period], data: { value: field.value, period: field.period },
    });
  }
  // A large FDV/market-cap gap (already surfaced in valuation) is also a risk-relevant dilution characteristic.
  const fdv = shown(fields, "obs:fdv");
  const marketCap = shown(fields, "obs:market_cap");
  if (fdv && marketCap && fdv.raw !== null && marketCap.raw !== null && marketCap.raw > 0 && fdv.raw / marketCap.raw >= FDV_TO_MARKET_CAP_GAP_RATIO) {
    findings.push({
      category: "risk", findingType: "dilution_gap", severity: "moderate",
      evidenceIds: [fdv.id, marketCap.id], observationPeriods: [fdv.period, marketCap.period],
      data: { fdvValue: fdv.value, marketCapValue: marketCap.value },
    });
  }
  // A market/fundamental divergence is itself a risk-relevant characteristic worth flagging once.
  const negativeDivergence = fields.get("calc:divergence_price_up_tvl_down");
  if (negativeDivergence && negativeDivergence.raw === 1) {
    findings.push({
      category: "risk", findingType: "market_fundamental_divergence", severity: "moderate",
      evidenceIds: [negativeDivergence.id], observationPeriods: [negativeDivergence.period], data: {},
    });
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
