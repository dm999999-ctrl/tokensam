/**
 * Deep Analysis Engine — narrative composer. Turns structured Finding objects (findings.ts) into
 * the exact JSON shapes the (unchanged) evidence validator (../schema.ts) accepts: statements for
 * the seven report sections, risks, data gaps, and further-research questions.
 *
 * The grounding guarantee is structural, not policed: every number a template writes is either
 * copied verbatim from `finding.data`, or freshly formatted from the same field's own `raw` number
 * (see `pct()` below) — the evidence validator's grounding rule matches on numeric value, not exact
 * string, so a freshly formatted percentage of the same underlying number is exactly as grounded as
 * the field's own display string, and reads far better in prose. Never format a number that is not
 * one of `finding.evidenceIds`' own `raw` values, and never write a period that is not one of the
 * finding's own cited fields' periods (`primaryPeriod`/`HORIZON_WORD`, both keyed off real field data).
 *
 * A finding is composed differently depending on where it renders (`Placement`): the executive
 * summary states the analytical *pattern and relationship* a finding represents, in qualitative
 * terms; the section-specific composer states the concrete figures and a shorter, complementary
 * analytical follow-up. The same evidence supports both, but neither repeats the other's sentence.
 *
 * Variation is controlled, not random: wording branches only on a finding's own severity/pattern/
 * magnitude band, so the same finding always produces the same sentence and different data always
 * produces different wording (deterministic, reproducible, still not repetitive across tokens).
 */

import type { Finding, Horizon, MultiHorizonPattern } from "./findings.ts";
import { magnitudeWord, type MomentumPeriodKey } from "./thresholds.ts";

export type RawStatement = { kind: "observed" | "calculated"; text: string; sourceIds: string[]; period: string | null };
export type RawRisk = { title: string; basis: "evidence" | "data_limitation"; detail: string; sourceIds: string[] };
export type RawDataGap = { category: string; detail: string; sourceIds: string[] };
export type RawQuestion = { question: string; rationale: string; sourceIds: string[] };

/** Where a statement renders: the executive summary states the pattern; a section states the figures. */
export type Placement = "summary" | "detail";

// ---- Shared text helpers ----

/** "calculated" when any cited source is a calc: metric, else "observed" (obs:/hist:). */
function statementKind(finding: Finding): RawStatement["kind"] {
  return finding.evidenceIds.some((id) => id.startsWith("calc:")) ? "calculated" : "observed";
}

/** The first non-null observation period among a finding's cited fields (schema-valid: it is one of them). */
function primaryPeriod(finding: Finding): string | null {
  return finding.observationPeriods.find((period) => period !== null) ?? null;
}

function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** A freshly formatted signed percentage of a cited field's own `raw` number — see module comment. */
function pct(raw: number): string {
  return `${raw >= 0 ? "+" : ""}${raw.toFixed(2)}%`;
}

/** "a" or "an", chosen from the word that will actually follow it — never a hardcoded "a". */
function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** "a notable increase" / "an substantial decrease" (article always recomputed, never assumed). */
function magnitudePhrase(period: MomentumPeriodKey, raw: number, noun: "increase" | "decrease"): string {
  const word = magnitudeWord(period, raw);
  return `${article(word)} ${word} ${noun}`;
}

const HORIZON_LABEL: Record<MomentumPeriodKey, string> = { "24h": "24H", "7d": "7D", "30d": "30D", "90d": "90D" };
/** Prose forms of each horizon; each is independently grounded by the horizon's own field (see module comment). */
const HORIZON_WORD: Record<MomentumPeriodKey, string> = { "24h": "24-hour", "7d": "seven-day", "30d": "30-day", "90d": "90-day" };

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function directionWord(raw: number): "increase" | "decrease" {
  return raw >= 0 ? "increase" : "decrease";
}

// ---- Market performance: multi-horizon momentum ----

function patternOf(finding: Finding): MultiHorizonPattern {
  return finding.findingType.replace("multi_horizon_", "") as MultiHorizonPattern;
}

/** The qualitative relationship clause between the shortest and longest horizon (shared logic; wording differs by placement). */
function paceClause(pattern: MultiHorizonPattern, shortest: Horizon, longest: Horizon, placement: Placement): string {
  if (shortest.key === longest.key) return "";
  const longWord = HORIZON_WORD[longest.key];
  const shortWord = HORIZON_WORD[shortest.key];
  const noun = pattern.includes("_up_") ? "increase" : pattern.includes("_down_") ? "decrease" : "move";
  if (pattern.endsWith("decelerating")) {
    return placement === "summary"
      ? ` The ${longWord} ${noun} is materially larger than the recent ${shortWord} movement, indicating that a substantial portion of the observed change occurred earlier in the historical window.`
      : ` The ${longWord} figure is materially larger in magnitude than the ${shortWord} figure, so a substantial share of the cumulative move happened before the most recent ${shortWord} window.`;
  }
  if (pattern.endsWith("accelerating")) {
    return placement === "summary"
      ? ` The recent ${shortWord} movement is running at a faster pace than the earlier part of the ${longWord} window, indicating the pace of change has picked up more recently.`
      : ` The recent ${shortWord} pace of change is faster than the average pace implied by the full ${longWord} window.`;
  }
  return placement === "summary"
    ? ` The pace of change has remained broadly consistent between the ${shortWord} and ${longWord} windows.`
    : ` The ${shortWord} and ${longWord} figures reflect a broadly consistent pace of change.`;
}

/** The Horizon objects the pattern classification actually used (see findings.ts's patternHorizons). */
function patternShortestLongest(finding: Finding): { shortest: Horizon; longest: Horizon } {
  const horizons = finding.horizons!;
  const shortest = horizons.find((horizon) => horizon.key === finding.data.patternShortestKey) ?? horizons[0];
  const longest = horizons.find((horizon) => horizon.key === finding.data.patternLongestKey) ?? horizons[horizons.length - 1];
  return { shortest, longest };
}

function summaryMultiHorizonStatement(finding: Finding): RawStatement {
  const horizons = finding.horizons!;
  const pattern = patternOf(finding);
  const { shortest, longest } = patternShortestLongest(finding);
  const labels = joinList(horizons.map((horizon) => HORIZON_LABEL[horizon.key]));
  let text: string;
  if (pattern === "single_up" || pattern === "single_down") {
    text = `The asset has shown ${pattern === "single_up" ? "positive" : "negative"} momentum over the available ${HORIZON_LABEL[shortest.key]} observation window.`;
  } else if (pattern === "flat" && shortest.key === longest.key) {
    text = `Price has been essentially flat over the available ${HORIZON_LABEL[shortest.key]} observation window.`;
  } else if (pattern.startsWith("consistent_up")) {
    text = `The asset has maintained positive momentum across the available ${labels} observation windows.${paceClause(pattern, shortest, longest, "summary")}`;
  } else if (pattern.startsWith("consistent_down")) {
    text = `The asset has maintained negative momentum across the available ${labels} observation windows.${paceClause(pattern, shortest, longest, "summary")}`;
  } else if (pattern === "reversal_to_down") {
    text = `The longer-term ${HORIZON_WORD[longest.key]} trend has been positive, but the most recent ${HORIZON_WORD[shortest.key]} movement has turned negative, marking a reversal within the observed history.`;
  } else if (pattern === "reversal_to_up") {
    text = `The longer-term ${HORIZON_WORD[longest.key]} trend has been negative, but the most recent ${HORIZON_WORD[shortest.key]} movement has turned positive, marking a reversal within the observed history.`;
  } else if (pattern === "mixed") {
    text = `Momentum across the available ${labels} observation windows is mixed, with no single consistent direction.`;
  } else {
    text = `Price has been essentially flat across the available ${labels} observation windows.`;
  }
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

function detailMultiHorizonStatement(finding: Finding): RawStatement {
  const horizons = finding.horizons!;
  const pattern = patternOf(finding);
  const { shortest, longest } = patternShortestLongest(finding);
  const parts = horizons.map((horizon) => `${pct(horizon.raw)} over ${HORIZON_LABEL[horizon.key]}`);
  let text: string;
  if (pattern === "single_up" || pattern === "single_down") {
    const horizon = horizons.find((item) => item.key === shortest.key) ?? shortest;
    text = `The asset recorded ${magnitudePhrase(horizon.key, horizon.raw, directionWord(horizon.raw))} of ${pct(horizon.raw)} over the ${HORIZON_WORD[horizon.key]} window.`;
  } else if (pattern === "flat" && shortest.key === longest.key) {
    text = `The asset's price was essentially unchanged over the available ${HORIZON_WORD[shortest.key]} observation window.`;
  } else if (pattern === "flat") {
    text = `Price was essentially unchanged across the available observation windows (${joinList(horizons.map((horizon) => HORIZON_LABEL[horizon.key]))}).`;
  } else if (pattern === "mixed") {
    text = `Price moved ${joinList(parts)}, without a single consistent direction across the available windows.`;
  } else {
    text = `Price moved ${joinList(parts)}.${paceClause(pattern, shortest, longest, "detail")}`;
  }
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

const TURNOVER_PHRASES: Record<"elevated_volume_during_decline" | "elevated_volume_during_advance", string> = {
  elevated_volume_during_decline: "A price decrease was observed alongside trading volume elevated relative to market capitalization over the same window.",
  elevated_volume_during_advance: "A price increase was observed alongside trading volume elevated relative to market capitalization over the same window.",
};

export function marketPerformanceStatement(finding: Finding, placement: Placement): RawStatement {
  if (finding.findingType.startsWith("multi_horizon_")) {
    return placement === "summary" ? summaryMultiHorizonStatement(finding) : detailMultiHorizonStatement(finding);
  }
  if (finding.findingType === "elevated_volume_during_decline" || finding.findingType === "elevated_volume_during_advance") {
    const text = placement === "summary"
      ? TURNOVER_PHRASES[finding.findingType]
      : `${TURNOVER_PHRASES[finding.findingType]} (price change ${str(finding.data.changeValue)}; volume/market-cap turnover ${str(finding.data.volumeShareValue)}.)`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

// ---- Fundamental / protocol activity ----

const GROWTH_LABEL: Record<"tvl" | "fees" | "revenue", string> = { tvl: "Total value locked (TVL)", fees: "Protocol fees", revenue: "Protocol revenue" };

function growthDetailStatement(finding: Finding, key: "tvl" | "fees" | "revenue", placement: Placement): RawStatement {
  const raw = finding.data.raw as number;
  const word = directionWord(raw);
  // Fundamentals growth periods are not one of the four fixed price-momentum windows; "30d" is used
  // as the closest configured magnitude-word bucket for a period-comparable metric of this kind.
  const text = placement === "summary"
    ? `${GROWTH_LABEL[key]} shows ${magnitudePhrase("30d", raw, word)}, a fundamental-activity signal distinct from price action.`
    : `${GROWTH_LABEL[key]} recorded ${magnitudePhrase("30d", raw, word)} of ${pct(raw)}.`;
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

const SYNTHESIS_TEXT: Record<"fundamentals_improving" | "fundamentals_deteriorating" | "fundamentals_mixed", { summary: string; detail: string }> = {
  fundamentals_improving: {
    summary: "The available protocol activity metrics (TVL, fees, and/or revenue) have moved together in the same, positive direction, indicating broadly improving fundamental activity.",
    detail: "The available protocol activity metrics moved together in the same, positive direction over their respective observed periods.",
  },
  fundamentals_deteriorating: {
    summary: "The available protocol activity metrics (TVL, fees, and/or revenue) have moved together in the same, negative direction, indicating broadly deteriorating fundamental activity.",
    detail: "The available protocol activity metrics moved together in the same, negative direction over their respective observed periods.",
  },
  fundamentals_mixed: {
    summary: "The available protocol activity metrics do not move consistently in one direction, indicating mixed fundamental signals.",
    detail: "The available protocol activity metrics do not move consistently in one direction over their respective observed periods.",
  },
};

export function fundamentalStatement(finding: Finding, placement: Placement): RawStatement {
  if (finding.findingType.startsWith("tvl_growth_")) return growthDetailStatement(finding, "tvl", placement);
  if (finding.findingType.startsWith("fees_growth_")) return growthDetailStatement(finding, "fees", placement);
  if (finding.findingType.startsWith("revenue_growth_")) return growthDetailStatement(finding, "revenue", placement);
  if (finding.findingType === "tvl_level") {
    return { kind: statementKind(finding), text: `Total value locked (TVL) for the associated protocol currently stands at ${str(finding.data.value)}.`, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "fee_revenue_relationship") {
    const text = placement === "summary"
      ? "The associated protocol's fees and revenue were both reported for the same period, reflecting the share of collected fees retained as protocol revenue."
      : `The associated protocol reported fees of ${str(finding.data.feesValue)} against revenue of ${str(finding.data.revenueValue)} for the same period, reflecting the share of collected fees retained as protocol revenue.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "fundamentals_improving" || finding.findingType === "fundamentals_deteriorating" || finding.findingType === "fundamentals_mixed") {
    const text = placement === "summary" ? SYNTHESIS_TEXT[finding.findingType].summary : SYNTHESIS_TEXT[finding.findingType].detail;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

// ---- Valuation: genuine valuation/activity multiples only ----

export function valuationStatement(finding: Finding, placement: Placement): RawStatement {
  if (finding.findingType.startsWith("ratio_")) {
    const text = placement === "summary"
      ? `${str(finding.data.label)} is one available measure of how the market values this token relative to its underlying fundamental activity.`
      : `${str(finding.data.label)} stood at ${str(finding.data.value)}, one measure of how the market values this token relative to its underlying fundamental activity.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "fdv_market_cap_gap") {
    const text = placement === "summary"
      ? `Fully diluted valuation (${str(finding.data.fdvValue)}) is materially above market capitalization (${str(finding.data.marketCapValue)}), indicating a meaningful share of total supply has yet to circulate.`
      : `Fully diluted valuation (${str(finding.data.fdvValue)}) exceeded market capitalization (${str(finding.data.marketCapValue)}); this gap reflects supply not yet in circulation, not a claim about intrinsic value.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

// ---- Liquidity / market structure ----

export function liquidityStatement(finding: Finding, placement: Placement): RawStatement {
  if (finding.findingType.startsWith("structure_")) {
    const text = `${str(finding.data.label)} was ${str(finding.data.value)}.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "elevated_turnover" || finding.findingType === "low_turnover" || finding.findingType === "turnover_level") {
    const level = finding.findingType === "elevated_turnover" ? "elevated" : finding.findingType === "low_turnover" ? "low" : "moderate";
    const text = placement === "summary"
      ? `Trading volume relative to market capitalization is ${level}, a turnover characteristic rather than a measure of executable liquidity.`
      : `Trading volume represented ${str(finding.data.value)} of market capitalization, a measure of turnover relative to size (${level}). This reflects trading activity, not necessarily executable liquidity — volume alone does not establish depth or slippage.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

// ---- Tokenomics ----

export function tokenomicsStatement(finding: Finding, placement: Placement): RawStatement {
  if (finding.findingType === "low_circulating_share") {
    const text = placement === "summary"
      ? "A majority of this token's eventual total supply has yet to enter circulation."
      : `Circulating supply represents ${str(finding.data.value)} of maximum supply, so a majority of eventual total supply has yet to enter circulation.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "market_cap_of_fdv") {
    const text = placement === "summary"
      ? "Market capitalization represents only a portion of fully diluted valuation, reflecting the share of total supply value the market currently prices in."
      : `Market capitalization represents ${str(finding.data.value)} of fully diluted valuation, reflecting the share of total supply value the market currently prices in.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "circulating_equals_total") {
    const text = placement === "summary"
      ? "All already-issued supply is currently in circulation for this token."
      : `Circulating supply (${str(finding.data.circulatingValue)}) equals total supply (${str(finding.data.totalValue)}), so no already-issued tokens remain outside circulation.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "circulating_below_total") {
    const text = placement === "summary"
      ? "A portion of this token's already-issued supply is not yet in circulation."
      : `Circulating supply (${str(finding.data.circulatingValue)}) is below total supply (${str(finding.data.totalValue)}), indicating a portion of already-issued tokens is not yet in circulation.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "supply_uncapped") {
    const text = placement === "summary"
      ? "This token has no defined maximum supply, so its eventual dilution ceiling cannot be established from the currently available data."
      : `No maximum supply is defined for this token, so the share of an eventual maximum supply currently circulating cannot be calculated; only the currently reported circulating figure (${str(finding.data.value)}) is available.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType.startsWith("supply_")) {
    const text = `${str(finding.data.label)} was reported at ${str(finding.data.value)}.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

// ---- Market / fundamental relationships (divergence) ----

const DIVERGENCE_SENTENCES: Record<string, { summary: string; detail: string }> = {
  divergence_price_up_tvl_down: {
    summary: "Market performance and tracked fundamental activity have diverged: price appreciation coincided with a decrease in the associated protocol's TVL over the same aligned interval.",
    detail: "Price appreciation was observed alongside a decrease in the associated protocol's TVL over the same aligned interval — a market/fundamental divergence, not a causal claim.",
  },
  divergence_price_down_tvl_up: {
    summary: "Market performance and tracked fundamental activity have diverged: a price decrease coincided with an increase in the associated protocol's TVL over the same aligned interval.",
    detail: "A price decrease was observed alongside an increase in the associated protocol's TVL over the same aligned interval — a market/fundamental divergence, not a causal claim.",
  },
  divergence_market_cap_up_faster_tvl: {
    summary: "Market capitalization has expanded faster than the associated protocol's TVL over the same aligned interval, a valuation/activity divergence.",
    detail: "Market capitalization grew faster than the associated protocol's TVL over the same aligned interval.",
  },
  divergence_tvl_up_faster_market_cap: {
    summary: "The associated protocol's TVL has expanded faster than market capitalization over the same aligned interval.",
    detail: "The associated protocol's TVL grew faster than market capitalization over the same aligned interval.",
  },
  divergence_revenue_up_market_cap_down: {
    summary: "Market performance and tracked fundamental activity have diverged: an increase in protocol revenue coincided with a decrease in market capitalization over the same aligned interval.",
    detail: "An increase in the associated protocol's revenue was observed alongside a decrease in market capitalization over the same aligned interval — a divergent movement, not a causal claim.",
  },
  divergence_revenue_down_market_cap_up: {
    summary: "Market performance and tracked fundamental activity have diverged: a decrease in protocol revenue coincided with an increase in market capitalization over the same aligned interval.",
    detail: "A decrease in the associated protocol's revenue was observed alongside an increase in market capitalization over the same aligned interval — a divergent movement, not a causal claim.",
  },
};

export function relationshipStatement(finding: Finding, placement: Placement): RawStatement {
  const sentence = DIVERGENCE_SENTENCES[finding.findingType];
  if (sentence) return { kind: statementKind(finding), text: sentence[placement === "summary" ? "summary" : "detail"], sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  if (finding.findingType.startsWith("points_")) {
    const text = placement === "summary"
      ? `${str(finding.data.label)} shows a percentage-point gap over the aligned interval, without asserting a cause.`
      : `${str(finding.data.label)} was ${str(finding.data.value)} over the aligned interval, a percentage-point comparison, not a claim of causation.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  return genericStatement(finding);
}

const SECTION_STATEMENT_BUILDERS: Record<string, (finding: Finding, placement: Placement) => RawStatement> = {
  marketPerformance: marketPerformanceStatement,
  fundamentalPerformance: fundamentalStatement,
  valuation: valuationStatement,
  liquidityMarketStructure: (finding, placement) => liquidityStatement(finding, placement),
  tokenomics: (finding, placement) => tokenomicsStatement(finding, placement),
  marketFundamentalRelationships: relationshipStatement,
};

/**
 * Last-resort, still fully grounded fallback: restates the finding's own label/value pair plainly.
 * Reached only if a category gains a findingType this module has not yet special-cased — never
 * throws, so a narrative-composer gap can never surface as "the AI report could not be generated."
 */
function genericStatement(finding: Finding): RawStatement {
  const label = finding.data.label ?? finding.findingType.replace(/_/g, " ");
  const value = finding.data.value;
  const text = value !== null && value !== undefined ? `${str(label)} was ${str(value)}.` : `${str(label)} was observed.`;
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

/** Build the AnalysisStatement for any finding whose category maps to a report section. */
export function statementForFinding(finding: Finding, placement: Placement = "detail"): RawStatement {
  const builder = SECTION_STATEMENT_BUILDERS[finding.category];
  if (!builder) return genericStatement(finding);
  return builder(finding, placement);
}

// ---- Risk assessment ----

export function riskItem(finding: Finding): RawRisk {
  if (finding.findingType === "elevated_volatility") {
    return { title: "Elevated volatility", basis: "evidence", detail: `The stored daily price history recorded ${str(finding.data.value)}.`, sourceIds: finding.evidenceIds };
  }
  if (finding.findingType === "sharp_drawdown") {
    return { title: "Sharp drawdown", basis: "evidence", detail: `The stored daily price history recorded ${str(finding.data.value)}.`, sourceIds: finding.evidenceIds };
  }
  if (finding.findingType === "dilution_gap") {
    return {
      title: "Fully diluted valuation exceeds market capitalization", basis: "evidence",
      detail: `Fully diluted valuation (${str(finding.data.fdvValue)}) is materially above market capitalization (${str(finding.data.marketCapValue)}), so continued dilution as supply circulates is a factor to weigh.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "market_fundamental_divergence") {
    return {
      title: "Price and protocol TVL diverged", basis: "evidence",
      detail: "Price appreciation was observed while the associated protocol's TVL decreased over the same aligned interval.",
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "low_circulating_supply_share") {
    return {
      title: "Large share of supply not yet circulating", basis: "evidence",
      detail: `Circulating supply represents ${str(finding.data.value)} of maximum supply; the remaining supply entering circulation over time is a supply-structure factor to weigh.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "no_elevated_risk_indicated") {
    const checked = [
      finding.data.checkedVolatility === "yes" ? "price volatility/drawdown" : null,
      finding.data.checkedDilution === "yes" ? "the FDV/market-cap relationship" : null,
      finding.data.checkedDivergence === "yes" ? "market/fundamental divergence" : null,
    ].filter((item): item is string => item !== null);
    return {
      title: "No elevated risk indicators identified",
      basis: "data_limitation",
      detail: `Of the dimensions evaluated from the currently available data (${checked.join(", ")}), none crossed the thresholds this analysis treats as elevated. This does not evaluate dimensions for which no data is currently available (see Data Gaps).`,
      sourceIds: finding.evidenceIds,
    };
  }
  const label = finding.data.label ?? finding.findingType.replace(/_/g, " ");
  return { title: str(label), basis: "evidence", detail: `${str(label)} was observed.`, sourceIds: finding.evidenceIds };
}

// ---- Data gaps and limitations ----

const DATA_GAP_CATEGORY: Record<string, string> = {
  unmapped: "mapping_limitation", missing: "unavailable_metric", insufficient_history: "insufficient_observations",
};

/** Series name parsed straight from the finding type, never from a field's own composed label (a
 * label like "Volume history · 7D" would reintroduce the exact "period is data, not prose"
 * failure this engine exists to avoid — see the module comment). */
const SERIES_NAME: Record<string, string> = { price: "Price", volume: "Volume", market_cap: "Market cap", tvl: "TVL" };

export function dataGapItem(finding: Finding): RawDataGap {
  if (finding.findingType.startsWith("unmapped_")) {
    // Composed fresh, never the raw scope-note statement: that statement is written for on-page
    // display and may legitimately use phrasing (e.g. "not attributed to") that reads as causal
    // language out of context, which the evidence contract's language rules would otherwise reject.
    return {
      category: DATA_GAP_CATEGORY.unmapped,
      detail: `${str(finding.data.provider)} does not have a curated mapping for this token, so the data it would supply is not covered by this analysis.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType.startsWith("missing_")) {
    return {
      category: DATA_GAP_CATEGORY.missing,
      detail: `${str(finding.data.label)} is not available for this token from the mapped data providers, so it is not covered by this analysis.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType.startsWith("insufficient_history_")) {
    const match = /^insufficient_history_(price|volume|market_cap|tvl)_(24h|7d|30d|90d)$/.exec(finding.findingType);
    const series = match ? SERIES_NAME[match[1]] : "This series";
    return {
      category: DATA_GAP_CATEGORY.insufficient_history,
      detail: `${series} does not have enough stored observations to establish a trend over that window.`,
      sourceIds: finding.evidenceIds,
    };
  }
  return { category: "unavailable_metric", detail: `${str(finding.data.label ?? finding.findingType)} is not available for this analysis.`, sourceIds: finding.evidenceIds };
}

// ---- Overviews (short, numberless, period-free syntheses) ----

const SECTION_INTRO: Record<string, string> = {
  marketPerformance: "The figures below summarize this token's price behavior across the available observation windows.",
  fundamentalPerformance: "The figures below summarize the associated protocol's tracked on-chain activity.",
  valuation: "The ratios below relate market pricing to the token's fundamental activity, without asserting whether either side is high or low.",
  marketFundamentalRelationships: "The findings below compare market performance against tracked fundamental activity over aligned intervals; none establish causation.",
  liquidityMarketStructure: "The findings below describe on-chain trading structure; volume alone does not establish executable liquidity.",
  tokenomics: "The findings below describe this token's supply structure.",
};

/** Category-specific one-sentence fallbacks when a section genuinely has nothing to report,
 *  distinguishing "no protocol mapping at all" from "mapped but nothing crossed a threshold" —
 *  never the same generic sentence regardless of why the section is empty. */
export function sectionOverview(sectionKey: string, findings: Finding[], context: { fundamentalsMapped?: boolean }): string {
  if (findings.length > 0) return SECTION_INTRO[sectionKey] ?? "The findings below summarize this section for the current data snapshot.";
  if (sectionKey === "fundamentalPerformance" && context.fundamentalsMapped === false) {
    return "No associated protocol is mapped for this token, so fundamental activity (TVL, fees, revenue) cannot be analyzed from the currently available data.";
  }
  if (sectionKey === "valuation") {
    return "No valuation multiple can be calculated from the currently available data.";
  }
  if (sectionKey === "marketFundamentalRelationships") {
    return "No market/fundamental relationship could be evaluated: this requires both market data and protocol fundamentals over an aligned interval, which the currently available data does not provide together.";
  }
  if (sectionKey === "liquidityMarketStructure") {
    return "No on-chain DEX market-structure data is currently mapped for this token.";
  }
  return "No notable findings were identified for this section from the current data snapshot.";
}

export function executiveOverview(topFindings: Finding[], totalFindings: number, categoriesCovered: number): string {
  if (topFindings.length === 0) {
    return "The currently available data snapshot does not support a substantive analytical synthesis for this token; see Data Gaps and Limitations for what is missing.";
  }
  const breadth = categoriesCovered >= 5 ? "broad" : categoriesCovered >= 3 ? "moderate" : "limited";
  const depth = totalFindings >= 10 ? "an extensive" : totalFindings >= 4 ? "a moderate" : "a limited";
  return `This assessment draws on ${depth} set of analytical findings across ${breadth} coverage of the token's market, fundamental, and structural data; the findings below are the most significant of those identified.`;
}

// ---- Further research questions (the report's closing, forward-looking section) ----

const RESEARCH_QUESTIONS: { when: (categories: Set<string>) => boolean; question: string; rationale: string }[] = [
  {
    when: (c) => c.has("positive_momentum"),
    question: "Does the positive momentum persist over subsequent observation periods?",
    rationale: "A consistent positive-momentum pattern was identified across the currently available observation windows.",
  },
  {
    when: (c) => c.has("negative_momentum"),
    question: "Does the negative momentum persist over subsequent observation periods, or does it represent a shorter-term move within a longer-term trend?",
    rationale: "A consistent negative-momentum pattern was identified across the currently available observation windows.",
  },
  {
    when: (c) => c.has("missing_history"),
    question: "Would a longer stored price or TVL history change the trend picture presented here?",
    rationale: "One or more series in this snapshot lack enough stored points to establish a trend over their full window.",
  },
  {
    when: (c) => c.has("mapping_limitation"),
    question: "Would additional protocol or market mapping materially expand the available fundamental evidence?",
    rationale: "One or more data providers do not have a curated mapping for this token, so some sections are not available.",
  },
  {
    when: (c) => c.has("divergence"),
    question: "Does the divergence between market performance and tracked fundamental activity persist over a longer aligned window?",
    rationale: "A divergence between price or market capitalization and protocol fundamentals was observed over the currently aligned interval only.",
  },
  {
    when: (c) => c.has("valuation_expansion"),
    question: "Does the valuation/activity relationship continue to widen, or does it revert as fundamentals catch up?",
    rationale: "A materially elevated valuation or dilution-relevant ratio was identified in the currently available data.",
  },
];

export function furtherResearchQuestions(findings: Finding[]): RawQuestion[] {
  const categories = new Set<string>();
  for (const finding of findings) {
    if (finding.findingType.startsWith("multi_horizon_consistent_up")) categories.add("positive_momentum");
    if (finding.findingType.startsWith("multi_horizon_consistent_down")) categories.add("negative_momentum");
    if (finding.findingType.startsWith("insufficient_history_")) categories.add("missing_history");
    if (finding.findingType.startsWith("unmapped_")) categories.add("mapping_limitation");
    if (finding.category === "marketFundamentalRelationships" && finding.findingType.startsWith("divergence_")) categories.add("divergence");
    if (finding.findingType === "dilution_gap" || finding.findingType === "fdv_market_cap_gap" || finding.findingType.startsWith("ratio_")) categories.add("valuation_expansion");
  }
  return RESEARCH_QUESTIONS.filter((entry) => entry.when(categories)).map((entry) => ({ question: entry.question, rationale: entry.rationale, sourceIds: [] }));
}
