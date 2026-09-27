/**
 * Deep Analysis Engine — narrative composer. Turns structured Finding objects (findings.ts) into
 * the exact JSON shapes the (unchanged) evidence validator (../schema.ts) accepts: statements for
 * the seven report sections, risks, data gaps, and further-research questions.
 *
 * The grounding guarantee is structural, not policed: every number or period a template writes is
 * copied verbatim from `finding.data` (which findings.ts populated straight from a payload field's
 * own `value`/`label`/`period`), so the same string that appears in the generated text also appears
 * in that field's own JSON — the evidence validator's number/period grounding rules always find it.
 * Never format a new number here, and never write a period that isn't `primaryPeriod(finding)`.
 *
 * Variation is controlled, not random: wording branches only on a finding's own severity/band/
 * direction, so the same finding always produces the same sentence and different data always
 * produces different wording (deterministic, reproducible, still not repetitive across tokens).
 */

import type { Finding, FindingSeverity } from "./findings.ts";

export type RawStatement = { kind: "observed" | "calculated"; text: string; sourceIds: string[]; period: string | null };
export type RawRisk = { title: string; basis: "evidence" | "data_limitation"; detail: string; sourceIds: string[] };
export type RawDataGap = { category: string; detail: string; sourceIds: string[] };
export type RawQuestion = { question: string; rationale: string; sourceIds: string[] };

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

/** Deterministic phrasing bucket from severity, used only to pick among pre-written variants. */
function variant(severity: FindingSeverity): 0 | 1 | 2 {
  return severity === "high" ? 0 : severity === "moderate" ? 1 : 2;
}

// ---- Market performance ----

// The exact observation period is carried on the statement's own `period` field (rendered by the
// UI alongside the sentence) and never restated in the prose itself — a period is data, not prose,
// and inlining a provider's rolling-window label as free text is exactly the ungrounded-period
// failure mode the evidence contract exists to prevent.
const MOMENTUM_PHRASES: Record<string, [string, string, string]> = {
  price_24h: ["recorded a sharp {word} of {value}", "recorded a {word} of {value}", "recorded a modest {word} of {value}"],
  price_7d: ["recorded a sharp {word} of {value}", "recorded a {word} of {value}", "recorded a modest {word} of {value}"],
  tvl_30d: ["recorded a sharp TVL {word} of {value}", "recorded a TVL {word} of {value}", "recorded a modest TVL {word} of {value}"],
};

function momentumStatement(finding: Finding, base: string, subject: string): RawStatement {
  const up = finding.findingType.endsWith("_increase");
  const word = up ? "increase" : "decrease";
  const template = MOMENTUM_PHRASES[base][variant(finding.severity)];
  const text = `${subject} ${template.replace("{word}", word).replace("{value}", str(finding.data.value))}.`;
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

const HISTORICAL_WINDOW_PHRASES: [string, string, string] = [
  "The stored price history shows a sharp {word} over the stored window: {value}.",
  "The stored price history shows a {word} over the stored window: {value}.",
  "The stored price history shows a modest {word} over the stored window: {value}.",
];

function historicalWindowStatement(finding: Finding): RawStatement {
  const up = finding.findingType.endsWith("_increase");
  const word = up ? "increase" : "decrease";
  const template = HISTORICAL_WINDOW_PHRASES[variant(finding.severity)];
  const text = template.replace("{word}", word).replace("{value}", str(finding.data.value));
  return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
}

export function marketPerformanceStatement(finding: Finding): RawStatement {
  if (finding.findingType.startsWith("price_24h") || finding.findingType.startsWith("price_7d")) {
    return momentumStatement(finding, finding.findingType.startsWith("price_24h") ? "price_24h" : "price_7d", "The price");
  }
  if (finding.findingType.startsWith("historical_price_30d") || finding.findingType.startsWith("historical_price_90d")) return historicalWindowStatement(finding);
  if (finding.findingType === "elevated_trading_activity" || finding.findingType === "low_trading_activity") {
    const high = finding.findingType === "elevated_trading_activity";
    const text = high
      ? `Trading volume was elevated relative to market capitalization, at ${str(finding.data.value)} of market cap.`
      : `Trading volume was low relative to market capitalization, at ${str(finding.data.value)} of market cap.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "elevated_volume_during_decline") {
    const text = `A price decrease of ${str(finding.data.changeValue)} was observed alongside trading volume elevated to ${str(finding.data.volumeShareValue)} of market capitalization over the same window.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled marketPerformance finding type: ${finding.findingType}`);
}

// ---- Fundamental / protocol activity ----

export function fundamentalStatement(finding: Finding): RawStatement {
  if (finding.findingType.startsWith("tvl_30d")) return momentumStatement(finding, "tvl_30d", "The associated protocol");
  if (finding.findingType === "fee_revenue_relationship") {
    const text = `The associated protocol reported fees of ${str(finding.data.feesValue)} and revenue of ${str(finding.data.revenueValue)} for the same period.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled fundamentalPerformance finding type: ${finding.findingType}`);
}

// ---- Valuation ----

export function valuationStatement(finding: Finding): RawStatement {
  if (finding.findingType.startsWith("ratio_")) {
    const text = `${str(finding.data.label)} stood at ${str(finding.data.value)}.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "fdv_market_cap_gap") {
    const text = `Fully diluted valuation (${str(finding.data.fdvValue)}) exceeded market capitalization (${str(finding.data.marketCapValue)}), indicating a material share of supply is not yet circulating.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled valuation finding type: ${finding.findingType}`);
}

// ---- Liquidity / market structure ----

export function liquidityStatement(finding: Finding): RawStatement {
  if (finding.findingType.startsWith("structure_")) {
    const text = `${str(finding.data.label)} was ${str(finding.data.value)}.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled liquidityMarketStructure finding type: ${finding.findingType}`);
}

// ---- Tokenomics ----

export function tokenomicsStatement(finding: Finding): RawStatement {
  if (finding.findingType === "low_circulating_share") {
    const text = `Circulating supply represented ${str(finding.data.value)} of maximum supply, leaving a majority of total supply yet to circulate.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType === "market_cap_of_fdv") {
    const text = `Market capitalization represented ${str(finding.data.value)} of fully diluted valuation.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  if (finding.findingType.startsWith("supply_")) {
    const text = `${str(finding.data.label)} was reported at ${str(finding.data.value)}.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled tokenomics finding type: ${finding.findingType}`);
}

// ---- Market / fundamental relationships (divergence) ----

const DIVERGENCE_SENTENCES: Record<string, string> = {
  divergence_price_up_tvl_down: "Price appreciation was observed alongside a decrease in the associated protocol's TVL over the same aligned interval.",
  divergence_price_down_tvl_up: "A price decrease was observed alongside an increase in the associated protocol's TVL over the same aligned interval.",
  divergence_market_cap_up_faster_tvl: "Market capitalization grew faster than the associated protocol's TVL over the same aligned interval.",
  divergence_tvl_up_faster_market_cap: "The associated protocol's TVL grew faster than market capitalization over the same aligned interval.",
  divergence_revenue_up_market_cap_down: "An increase in the associated protocol's revenue was observed alongside a decrease in market capitalization over the same aligned interval.",
  divergence_revenue_down_market_cap_up: "A decrease in the associated protocol's revenue was observed alongside an increase in market capitalization over the same aligned interval.",
};

export function relationshipStatement(finding: Finding): RawStatement {
  const sentence = DIVERGENCE_SENTENCES[finding.findingType];
  if (sentence) return { kind: statementKind(finding), text: sentence, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  if (finding.findingType.startsWith("points_")) {
    const text = `${str(finding.data.label)} was ${str(finding.data.value)} over the aligned interval.`;
    return { kind: statementKind(finding), text, sourceIds: finding.evidenceIds, period: primaryPeriod(finding) };
  }
  throw new Error(`Unhandled marketFundamentalRelationships finding type: ${finding.findingType}`);
}

const SECTION_STATEMENT_BUILDERS: Record<string, (finding: Finding) => RawStatement> = {
  marketPerformance: marketPerformanceStatement,
  fundamentalPerformance: fundamentalStatement,
  valuation: valuationStatement,
  liquidityMarketStructure: liquidityStatement,
  tokenomics: tokenomicsStatement,
  marketFundamentalRelationships: relationshipStatement,
};

/** Build the AnalysisStatement for any finding whose category maps to a report section. */
export function statementForFinding(finding: Finding): RawStatement {
  const builder = SECTION_STATEMENT_BUILDERS[finding.category];
  if (!builder) throw new Error(`No statement builder for category: ${finding.category}`);
  return builder(finding);
}

// ---- Risk assessment ----

export function riskItem(finding: Finding): RawRisk {
  if (finding.findingType === "elevated_volatility") {
    return {
      title: "Elevated volatility",
      basis: "evidence",
      detail: `The stored daily price history recorded ${str(finding.data.value)}.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "sharp_drawdown") {
    return {
      title: "Sharp drawdown",
      basis: "evidence",
      detail: `The stored daily price history recorded ${str(finding.data.value)}.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "dilution_gap") {
    return {
      title: "Fully diluted valuation exceeds market capitalization",
      basis: "evidence",
      detail: `Fully diluted valuation (${str(finding.data.fdvValue)}) is materially above market capitalization (${str(finding.data.marketCapValue)}), so continued token issuance is a factor to weigh alongside the currently circulating supply.`,
      sourceIds: finding.evidenceIds,
    };
  }
  if (finding.findingType === "market_fundamental_divergence") {
    return {
      title: "Price and protocol TVL diverged",
      basis: "evidence",
      detail: "Price appreciation was observed while the associated protocol's TVL decreased over the same aligned interval.",
      sourceIds: finding.evidenceIds,
    };
  }
  throw new Error(`Unhandled risk finding type: ${finding.findingType}`);
}

// ---- Data gaps and limitations ----

const DATA_GAP_CATEGORY: Record<string, string> = { unmapped: "mapping_limitation", missing: "unavailable_metric", insufficient_history: "missing_history" };

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
      detail: `${series} does not have enough stored history to establish a trend over the stored window.`,
      sourceIds: finding.evidenceIds,
    };
  }
  throw new Error(`Unhandled dataQuality finding type: ${finding.findingType}`);
}

// ---- Overviews (short, numberless, period-free syntheses) ----

/** Deterministic, qualitative synthesis of which finding types populate a section — never a number or named period. */
export function sectionOverview(label: string, findings: Finding[]): string {
  if (findings.length === 0) return `No notable findings were identified for ${label} from the current data snapshot.`;
  const coverage = findings.length >= 4 ? "several observations" : findings.length >= 2 ? "a small number of observations" : "a single observation";
  return `This section reports ${coverage} for ${label} drawn from the current data snapshot.`;
}

export function executiveOverview(totalFindings: number, categoriesCovered: number): string {
  const breadth = categoriesCovered >= 5 ? "broad" : categoriesCovered >= 3 ? "moderate" : "limited";
  const depth = totalFindings >= 10 ? "an extensive set of" : totalFindings >= 4 ? "a moderate set of" : "a limited set of";
  return `The current data snapshot supports ${depth} analytical findings across ${breadth} coverage of this token's market, fundamental, and structural data.`;
}

// ---- Further research questions (the report's closing, forward-looking section) ----

const RESEARCH_QUESTIONS: { when: (categories: Set<string>) => boolean; question: string; rationale: string }[] = [
  {
    when: (c) => c.has("missing_history"),
    question: "Would a longer stored price or TVL history change the trend picture presented here?",
    rationale: "One or more series in this snapshot lack enough stored points to establish a trend over their full window.",
  },
  {
    when: (c) => c.has("mapping_limitation"),
    question: "Would mapping this token to its associated protocol or DEX pairs change the fundamental or market-structure picture?",
    rationale: "One or more data providers do not have a curated mapping for this token, so some sections are not available.",
  },
  {
    when: (c) => c.has("divergence"),
    question: "Does the observed divergence between market and fundamental series persist over a longer aligned window?",
    rationale: "A divergence between price or market capitalization and protocol fundamentals was observed over the currently aligned interval only.",
  },
  {
    when: (c) => c.has("dilution"),
    question: "How is the gap between fully diluted valuation and market capitalization expected to close as supply circulates further?",
    rationale: "Fully diluted valuation is materially above market capitalization in this snapshot.",
  },
];

export function furtherResearchQuestions(findings: Finding[]): RawQuestion[] {
  const categories = new Set<string>();
  const bySourceIds = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.findingType.startsWith("insufficient_history_")) { categories.add("missing_history"); bySourceIds.set("missing_history", finding.evidenceIds); }
    if (finding.findingType.startsWith("unmapped_")) { categories.add("mapping_limitation"); bySourceIds.set("mapping_limitation", finding.evidenceIds); }
    if (finding.category === "marketFundamentalRelationships" && finding.findingType.startsWith("divergence_")) { categories.add("divergence"); bySourceIds.set("divergence", finding.evidenceIds); }
    if (finding.findingType === "dilution_gap" || finding.findingType === "fdv_market_cap_gap") { categories.add("dilution"); bySourceIds.set("dilution", finding.evidenceIds); }
  }
  return RESEARCH_QUESTIONS.filter((entry) => entry.when(categories)).map((entry) => ({
    question: entry.question,
    rationale: entry.rationale,
    sourceIds: [],
  }));
}
