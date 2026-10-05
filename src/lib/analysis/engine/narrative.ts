/**
 * Deep Analysis Engine — narrative composer (Phase 2 of the research-report redesign). Turns
 * structured Findings (findings.ts) and the synthesis layer's Relationships/ThesisDrivers
 * (synthesis.ts) into the eleven-section institutional-research paragraphs report-schema.ts accepts.
 *
 * Unlike the engine's earlier one-finding-one-sentence composer, a paragraph here routinely combines
 * several findings — often from different categories — into one flowing, evidence-grounded sentence
 * or two, because that combination (does fundamentals corroborate price action? does a technical
 * indicator confirm or contradict momentum?) is the actual analytical content a research report is
 * for. The grounding guarantee is unchanged: every number is freshly formatted from one of the
 * paragraph's own cited findings' raw evidence values (never a value not present on one of its
 * evidenceIds), and every named period (24h/7d/30d/90d) is one a cited source's own period label
 * establishes — report-schema.ts's validator enforces both mechanically.
 *
 * Language discipline (see evidence-rules.ts): never a directional/sentiment word (bullish, bearish,
 * overbought, oversold, breakout, rally, uptrend...) or a causal claim (caused by, drove, driven
 * by...) — both are fatal. Analytical/descriptive words about already-observed behavior (momentum,
 * trend, strength, weakness, improving, deteriorating, consistent) are allowed. Hedged relational
 * language ("is consistent with", "coincides with", "is corroborated by", "diverges from", "remains
 * unconfirmed by") is used throughout instead of asserting cause.
 */

import type { Finding, FindingCategory } from "./findings.ts";
import { findingId, type Relationship, type RelationshipType, type SynthesisResult, type ThesisDriver } from "./synthesis.ts";
import { magnitudeWord, momentumBand, type MomentumPeriodKey } from "./thresholds.ts";
import type { EngineParagraph } from "./report-schema.ts";
import { formatCount, formatDuration, formatUsd } from "../../ui/format.ts";

// ---- Shared text helpers ----

function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** A freshly formatted signed percentage of a cited field's own `raw` number. */
function pct(raw: number): string {
  return `${raw >= 0 ? "+" : ""}${raw.toFixed(2)}%`;
}

function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function magnitudePhrase(period: MomentumPeriodKey, raw: number, noun: "increase" | "decrease"): string {
  const word = magnitudeWord(period, raw);
  return `${article(word)} ${word} ${noun}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function directionWord(raw: number): "increase" | "decrease" {
  return raw >= 0 ? "increase" : "decrease";
}

/**
 * Reformats a supply figure at full, comma-grouped precision from its own cited raw number, reusing
 * the unit/symbol already present in the field's own compact display string (e.g. "20.09M BTC" →
 * "BTC"). Used only when the compact display of two distinct raw values collides (see
 * `circulating_below_total`); never invents a unit or a digit the raw number does not itself have.
 */
function preciseSupply(raw: number, compactDisplay: string): string {
  const symbol = compactDisplay.trim().split(/\s+/).pop();
  const count = formatCount(raw) ?? String(raw);
  return symbol ? `${count} ${symbol}` : count;
}

const HORIZON_WORD: Record<MomentumPeriodKey, string> = { "24h": "24-hour", "7d": "seven-day", "30d": "30-day", "90d": "90-day" };
const HORIZON_LABEL: Record<MomentumPeriodKey, string> = { "24h": "24H", "7d": "7D", "30d": "30D", "90d": "90D" };

const BOLLINGER_PHRASE: Record<string, (pct: string) => string> = {
  price_above_upper_band: () => "the latest close sits above the upper Bollinger band (20, 2), a statistically extended position relative to the 20-day average",
  price_below_lower_band: () => "the latest close sits below the lower Bollinger band (20, 2), a statistically extended position relative to the 20-day average",
  price_upper_half_of_bands: (pct) => `Bollinger %B reads ${pct}, placing the latest close in the upper portion of its recent volatility envelope without reaching the upper band itself`,
  price_lower_half_of_bands: (pct) => `Bollinger %B reads ${pct}, placing the latest close in the lower portion of its recent volatility envelope without reaching the lower band itself`,
};

/** The 30-day closing-range position's own number drives the wording, never a flat "upper/lower third" label regardless of how close to the edge the figure actually is. */
function rangePositionPhrase(raw: number): string {
  if (raw >= 99.5) return "is at the highest closing level of the 30-day window";
  if (raw >= 90) return "is extremely close to the highest closing level of the 30-day window";
  if (raw >= 200 / 3) return "sits in the upper third of its 30-day closing range";
  if (raw <= 0.5) return "is at the lowest closing level of the 30-day window";
  if (raw <= 10) return "is extremely close to the lowest closing level of the 30-day window";
  return "sits in the lower third of its 30-day closing range";
}

type EvidenceGroup = Finding | Relationship | ThesisDriver | Finding[] | Relationship[] | ThesisDriver[] | string[];

function evidence(...groups: EvidenceGroup[]): string[] {
  const ids = new Set<string>();
  for (const group of groups) {
    if (Array.isArray(group)) {
      for (const item of group) {
        if (typeof item === "string") ids.add(item);
        else for (const id of item.evidenceIds) ids.add(id);
      }
    } else {
      for (const id of group.evidenceIds) ids.add(id);
    }
  }
  return [...ids].sort();
}

function para(text: string, ...groups: EvidenceGroup[]): EngineParagraph {
  return { text, sourceIds: evidence(...groups) };
}

function byCategory(findings: Finding[], category: FindingCategory): Finding[] {
  return findings.filter((finding) => finding.category === category);
}
function byType(findings: Finding[], findingType: string): Finding | undefined {
  return findings.find((finding) => finding.findingType === findingType);
}
function byTypePrefix(findings: Finding[], prefix: string): Finding[] {
  return findings.filter((finding) => finding.findingType.startsWith(prefix));
}
function byId(findings: Finding[], id: string): Finding | undefined {
  return findings.find((finding) => findingId(finding) === id);
}

/** A relationship's own member findings, resolved back from its findingIds against the full finding set. */
function membersOf(relationship: Relationship, findings: Finding[]): Finding[] {
  return relationship.findingIds.map((id) => byId(findings, id)).filter((finding): finding is Finding => finding !== undefined);
}

function relationshipsOfType(synthesis: SynthesisResult, type: RelationshipType): Relationship[] {
  return synthesis.relationships.filter((relationship) => relationship.type === type);
}

// ---- Momentum pattern clause (shared by Market Performance and Executive Assessment) ----

type MultiHorizonPattern =
  | "consistent_up_accelerating" | "consistent_up_decelerating" | "consistent_up_steady"
  | "consistent_down_accelerating" | "consistent_down_decelerating" | "consistent_down_steady"
  | "reversal_to_down" | "reversal_to_up" | "mixed" | "single_up" | "single_down" | "flat";

function momentumPattern(finding: Finding): MultiHorizonPattern {
  return finding.findingType.replace("volume_multi_horizon_", "").replace("multi_horizon_", "") as MultiHorizonPattern;
}

/** The concrete figures a momentum finding cites, e.g. "+5.64% over 7D and +38.11% over 90D". */
function momentumFigures(finding: Finding): string {
  const horizons = finding.horizons ?? [];
  return joinList(horizons.map((horizon) => `${pct(horizon.raw)} over ${HORIZON_LABEL[horizon.key]}`));
}

/**
 * The coarse up/down/mixed/flat direction a multi-horizon pattern establishes -- shared by price and
 * volume findings so the narrative can compare them directly (see report.ts's classifyRegime, which
 * applies the same mapping to the price finding for the report header's regime field).
 */
function patternDirection(pattern: MultiHorizonPattern): "up" | "down" | "mixed" | "flat" {
  if (pattern === "flat") return "flat";
  if (pattern.includes("_up") || pattern === "single_up" || pattern === "reversal_to_up") return "up";
  if (pattern.includes("_down") || pattern === "single_down" || pattern === "reversal_to_down") return "down";
  return "mixed";
}

/**
 * The trailing "this confirms/diverges from price" clause for a volume multi-horizon finding --
 * shared by Market Performance, the Executive Assessment, and the Final Conclusion so the same
 * guard lives in one place. Only a genuinely "consistent_up"/"consistent_down" volume pattern
 * supports a clean confirmation-or-divergence claim; patternDirection alone is not enough, because
 * it also reads "reversal_to_up" as plain "up", which would falsely claim confirmation for a volume
 * series that is itself a reversal (its own horizons disagree). Any other pattern (reversal, mixed,
 * single-horizon, flat) returns "" -- momentumClause's own text already states that nuance
 * accurately, so no additional confirm/diverge claim is layered on top of it.
 */
function volumeRelationClause(priceDirection: "up" | "down" | "mixed" | "flat", volumeMomentum: Finding): string {
  const volumePattern = momentumPattern(volumeMomentum);
  if (!volumePattern.startsWith("consistent_") || (priceDirection !== "up" && priceDirection !== "down")) return "";
  const volDirection = patternDirection(volumePattern);
  return volDirection === priceDirection
    ? " This is directionally consistent with the price regime, providing some confirmation from trading activity rather than price movement alone."
    : " This diverges from the price regime: trading activity has not moved in the same direction as price across these horizons, which qualifies rather than confirms the price move.";
}

/**
 * How the dominant multi-horizon price pattern should be characterized at the regime level --
 * shared by Executive Assessment and Final Conclusion so both state the identical characterization
 * (never two separate judgments of the same pattern). "constructive"/"negative" is used only for a
 * genuinely consistent pattern; a reversal is named explicitly as a reversal/divergence between
 * short- and longer-term direction rather than forced into a flat constructive/negative label --
 * the same distinction report.ts's classifyRegime applies for the report header's regime field.
 */
function regimeDescriptor(pattern: MultiHorizonPattern, momentumDirection: "up" | "down"): { label: string; closingLabel: string; isReversal: boolean } {
  if (pattern === "reversal_to_up" || pattern === "reversal_to_down") {
    return {
      label: "a reversal between its short- and longer-term price direction rather than a single consistent market regime",
      closingLabel: "reflects a reversal between short- and longer-term price direction rather than a single consistent market and technical assessment",
      isReversal: true,
    };
  }
  const regimeWord = momentumDirection === "up" ? "constructive" : "negative";
  return { label: `a ${regimeWord} market regime`, closingLabel: `supports a ${regimeWord} market and technical assessment`, isReversal: false };
}

/** One flowing sentence describing a multi-horizon momentum finding's pattern — direction, magnitude, pace, and reversal are each named only where the pattern actually establishes them. `subject` lets the identical pattern logic describe price or volume without a second, divergent implementation. */
function momentumClause(finding: Finding, subject: "Price" | "Trading volume" = "Price"): string {
  const horizons = finding.horizons ?? [];
  const pattern = momentumPattern(finding);
  const figures = momentumFigures(finding);
  const verb = subject === "Price" ? "moved" : "changed";
  if (pattern === "single_up" || pattern === "single_down") {
    const horizon = horizons[0];
    return `${subject} recorded ${magnitudePhrase(horizon.key, horizon.raw, directionWord(horizon.raw))} of ${pct(horizon.raw)} over the ${HORIZON_WORD[horizon.key]} window, the only horizon currently available.`;
  }
  if (pattern === "flat") return `${subject} has been essentially unchanged across the available observation windows (${figures}).`;
  if (pattern === "mixed") return `${subject} ${verb} ${figures}, without a single consistent direction across the available windows — a mixed short- and long-term picture rather than a clear regime.`;
  // The shortest/longest horizons that actually drove the pattern classification (see
  // classifyMultiHorizonPattern in findings.ts) -- never the raw first/last of the full horizons
  // array, which can include a shorter horizon the pattern itself excluded (e.g. 24H excluded from
  // a 7D/30D consistent-pattern judgment). Falls back to the full array only if that data is absent
  // (e.g. a stored row from before this field existed).
  const patternShortest = horizons.find((horizon) => horizon.key === finding.data.patternShortestKey) ?? horizons[0];
  const patternLongest = horizons.find((horizon) => horizon.key === finding.data.patternLongestKey) ?? horizons[horizons.length - 1];
  if (pattern === "reversal_to_down" || pattern === "reversal_to_up") {
    const turn = pattern === "reversal_to_down" ? "turned negative" : "turned positive";
    return `${subject} ${verb} ${figures}. The longer-term ${HORIZON_WORD[patternLongest.key]} trend has been ${pattern === "reversal_to_down" ? "positive" : "negative"}, but the most recent ${HORIZON_WORD[patternShortest.key]} movement has ${turn}, marking a reversal within the observed history rather than a continuation of the longer-term regime.`;
  }
  const paceClause = patternShortest.key === patternLongest.key ? "" : pattern.endsWith("decelerating")
    ? ` The ${HORIZON_WORD[patternLongest.key]} figure is materially larger than the ${HORIZON_WORD[patternShortest.key]} figure, indicating a substantial share of the cumulative move occurred before the most recent window — a deceleration in pace, not a change in direction.`
    : pattern.endsWith("accelerating")
      ? ` The recent ${HORIZON_WORD[patternShortest.key]} pace of change is running faster than the pace implied by the remainder of the ${HORIZON_WORD[patternLongest.key]} window, indicating the pace of change has picked up more recently.`
      : ` The pace of change has remained broadly consistent between the ${HORIZON_WORD[patternShortest.key]} and ${HORIZON_WORD[patternLongest.key]} windows.`;
  // A "consistent" pattern is classified from the pattern-eligible horizons only (patternShortest/
  // patternLongest above); a shorter horizon outside that set can still disagree in sign (e.g. a
  // 24H pullback within a positive 7D/30D regime) -- when it does, the pattern genuinely does NOT
  // hold "across every available horizon", so that claim is never made in this case.
  const excludedKey = finding.data.excludedDisagreementKey as MomentumPeriodKey | null | undefined;
  const excluded = excludedKey ? horizons.find((horizon) => horizon.key === excludedKey) : undefined;
  if (excluded) {
    const patternWord = pattern.includes("_up_") ? "positive" : "negative";
    const pullbackWord = patternWord === "positive" ? "pullback" : "rebound";
    return `${subject} ${verb} ${figures}, a ${patternWord} regime across the ${HORIZON_WORD[patternShortest.key]} and ${HORIZON_WORD[patternLongest.key]} horizons, with a short-term ${pullbackWord} over the ${HORIZON_WORD[excluded.key]} window (${pct(excluded.raw)}) rather than a continuation of that regime at every available horizon.${paceClause}`;
  }
  return `${subject} ${verb} ${figures}, a persistent ${pattern.includes("_up_") ? "positive" : "negative"} regime across every available horizon.${paceClause}`;
}

// ---- 1. Executive Investment Assessment ----

function domainWord(categories: FindingCategory[]): string {
  const labels: Partial<Record<FindingCategory, string>> = {
    marketPerformance: "market performance", technical: "technical configuration", fundamentalPerformance: "fundamental activity",
    valuation: "valuation", marketFundamentalRelationships: "the price/fundamental relationship",
    liquidityMarketStructure: "trading structure", tokenomics: "supply structure", risk: "risk",
  };
  return joinList([...new Set(categories.map((category) => labels[category] ?? category))]);
}

/**
 * A short, token-specific qualification clause combining whichever of (a) the 30-day closing-range
 * position and (b) elevated realized volatility actually apply to the current momentum direction --
 * shared by the Executive Assessment and Final Conclusion so the same underlying evidence produces
 * one derivation, worded differently in each place. Returns null when neither qualification applies.
 */
function momentumQualification(findings: Finding[], direction: "up" | "down"): { text: string; evidence: Finding[] } | null {
  const range = byType(findings, "closing_range_upper_third") ?? byType(findings, "closing_range_lower_third");
  const atEdge = range && ((direction === "up" && range.findingType === "closing_range_upper_third") || (direction === "down" && range.findingType === "closing_range_lower_third"));
  const volatility = byCategory(findings, "risk").find((finding) => finding.findingType === "elevated_volatility");
  const clauses: string[] = [];
  const evidence: Finding[] = [];
  if (atEdge && range) {
    clauses.push(`the latest close ${rangePositionPhrase(range.data.raw as number)} (${(range.data.raw as number).toFixed(2)}%)`);
    evidence.push(range);
  }
  if (volatility) {
    clauses.push(`realized volatility remains elevated (${str(volatility.data.value)} over ${volatility.data.period ?? "the available window"})`);
    evidence.push(volatility);
  }
  if (clauses.length === 0) return null;
  return { text: joinList(clauses), evidence };
}

/**
 * Domain-synthesis clauses: one function per evidence domain (fundamentals, valuation, market
 * structure/liquidity, risk), each returning a short, already-grounded paragraph when that domain
 * has material evidence, or null when it genuinely does not -- never a new calculation, only a
 * condensed reading of findings the dedicated section for that domain already cites in full.
 * Shared by the Executive Assessment and Final Conclusion (see below) so neither section silently
 * drops an available domain just because the market/technical thesis has already been stated, and
 * neither invents a second, divergent description of the same evidence -- the full detail stays in
 * each domain's own section; these are the pointer-plus-qualification a top-level synthesis needs.
 */
function fundamentalsSynthesisClause(findings: Finding[]): EngineParagraph | null {
  const fundamentals = byCategory(findings, "fundamentalPerformance");
  if (fundamentals.length === 0) return null;
  const synthesisFinding = byType(fundamentals, "fundamentals_improving") ?? byType(fundamentals, "fundamentals_deteriorating") ?? byType(fundamentals, "fundamentals_mixed");
  const directionWord = synthesisFinding?.findingType === "fundamentals_improving" ? "broadly improving"
    : synthesisFinding?.findingType === "fundamentals_deteriorating" ? "broadly deteriorating"
      : synthesisFinding ? "mixed across the available measures"
        : "directionally positive or negative depending on the specific measure";
  const pace = fundamentalPaceDirection(findings);
  const paceEvidence = (["tvl", "revenue"] as const).map((key) => byType(findings, `points_price_change_vs_${key}_growth`)).filter((finding): finding is Finding => finding !== undefined);
  const paceClause = pace === "outpacing"
    ? " Market repricing has outpaced the measured change in tracked fundamental activity over the same aligned interval, so this supports the direction of the move more strongly than its magnitude."
    : pace === "mixed"
      ? " The available cross-metric evidence is itself mixed across measures, so fundamental activity does not uniformly confirm the pace of the market move (see Cross-Domain Analysis)."
      : pace === "trailing"
        ? " The available cross-metric evidence does not indicate the market has outpaced tracked fundamental activity over the same aligned interval."
        : "";
  const members = [...(synthesisFinding ? [synthesisFinding] : fundamentals.slice(0, 1)), ...paceEvidence];
  return para(`Tracked protocol activity is also part of the available evidence and is ${directionWord} over the available observation periods (see Fundamental Analysis for the specific measures and their periods).${paceClause}`, members);
}

function valuationSynthesisClause(findings: Finding[]): EngineParagraph | null {
  const ratios = byTypePrefix(byCategory(findings, "valuation"), "ratio_");
  const fdvGap = byType(findings, "fdv_market_cap_gap");
  const members = [...ratios, ...(fdvGap ? [fdvGap] : [])];
  if (members.length === 0) return null;
  return para("Valuation multiples are also observable from the available evidence (see Valuation Analysis for the specific ratios), but attractiveness cannot be established without an appropriate comparative benchmark, which is not present in the currently available evidence.", members);
}

function liquiditySynthesisClause(findings: Finding[]): EngineParagraph | null {
  const liquidity = byCategory(findings, "liquidityMarketStructure");
  if (liquidity.length === 0) return null;
  return para("Market-structure and trading-activity evidence is also available (see Market Structure & Liquidity), though trading volume relative to market capitalization does not by itself establish executable liquidity, market depth, or expected slippage.", liquidity);
}

function riskSynthesisClause(findings: Finding[]): EngineParagraph | null {
  const risks = byCategory(findings, "risk");
  const substantive = risks.filter((finding) => finding.findingType !== "no_elevated_risk_indicated");
  if (substantive.length > 0) {
    return para("Material risk evidence is also present in the available data (see Key Investment Risks) and qualifies this assessment; a constructive market and technical regime does not by itself indicate low risk.", substantive);
  }
  const fallback = risks.find((finding) => finding.findingType === "no_elevated_risk_indicated");
  if (fallback) {
    return para("No available risk metric crossed this analysis's defined elevated-risk threshold. This should not be interpreted as an absence of risk -- only as the limit of what the currently available data supports.", fallback);
  }
  return null;
}

function executiveAssessment(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  const direction = momentum ? patternDirection(momentumPattern(momentum)) : null;
  if (!momentum || direction === null || direction === "mixed" || direction === "flat") {
    const drivers = synthesis.thesisDrivers;
    if (drivers.length === 0) {
      return [para("The currently available data snapshot does not support a substantive analytical thesis for this token beyond individual data points; see Data Quality & Analytical Limitations for what is missing.", ["token"])];
    }
    // A momentum-driven thesis cannot be stated (no clear price direction), but other material
    // drivers exist -- name the strongest one plainly rather than defaulting to momentum language.
    const top = drivers[0];
    return [para(`The currently available evidence does not establish a single, consistent price direction across the measured horizons, so no momentum-based thesis is stated here. The most material signal currently available concerns ${domainWord(top.categories)}; see Cross-Domain Analysis for how it relates to the rest of the available evidence.`, top)];
  }
  const momentumDirection: "up" | "down" = direction;

  const paragraphs: EngineParagraph[] = [];
  const pattern = momentumPattern(momentum);
  const regime = regimeDescriptor(pattern, momentumDirection);
  const confluence = technicalConfluenceMembers(findings, synthesis);

  // 1. What is happening, stated immediately -- derived from the actual dominant pattern, never a
  // fixed opening sentence. A reversal is never folded into the constructive/negative confluence
  // clause below, since "that direction" would be ambiguous when the short- and longer-term
  // horizons themselves disagree -- momentumClause's own text already states the reversal plainly.
  const confluenceClause = regime.isReversal
    ? ""
    : confluence && confluence.agreeing.length > 0 && confluence.conflicting.length === 0
      ? " with technical measures independently reinforcing that direction"
      : confluence && confluence.conflicting.length > 0 && confluence.agreeing.length === 0
        ? ", although the available technical indicators do not confirm it"
        : "";
  paragraphs.push(para(`This token is in ${regime.label}${confluenceClause}: ${momentumClause(momentum)}`, confluence ? [momentum, ...confluence.agreeing, ...confluence.conflicting] : momentum));

  // 2. Why -- the specific technical measures, named.
  if (confluence && confluence.agreeing.length > 0) {
    const clause = joinList(confluence.agreeing.map(technicalIndicatorClause));
    paragraphs.push(para(`${clause.charAt(0).toUpperCase()}${clause.slice(1)}. These measures reinforce the price trend rather than providing an isolated signal.`, confluence.agreeing));
  }

  // 3. Qualification.
  const qualification = momentumQualification(findings, momentumDirection);
  if (qualification) {
    paragraphs.push(para(`The principal qualification is that ${qualification.text}. The current strength should be read alongside this qualification rather than in isolation.`, qualification.evidence));
  }
  const volumeMomentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("volume_multi_horizon_"));
  if (volumeMomentum) {
    paragraphs.push(para(`${momentumClause(volumeMomentum, "Trading volume")}${volumeRelationClause(momentumDirection, volumeMomentum)}`, volumeMomentum));
  }

  // 3.5. Every other materially available evidence domain -- never omitted merely because the
  // market/technical thesis above has already been established. Each clause is null (and skipped)
  // when that domain genuinely has no evidence; see fundamentalsSynthesisClause and siblings above.
  for (const clause of [fundamentalsSynthesisClause(findings), valuationSynthesisClause(findings), liquiditySynthesisClause(findings), riskSynthesisClause(findings)]) {
    if (clause) paragraphs.push(clause);
  }

  // 4. What cannot currently be assessed.
  const unavailable: string[] = [];
  const unavailableEvidence: Finding[] = [];
  if (byCategory(findings, "fundamentalPerformance").length === 0) unavailable.push("protocol-level fundamentals");
  if (byCategory(findings, "valuation").length === 0) unavailable.push("a comparative valuation benchmark");
  if (byCategory(findings, "liquidityMarketStructure").length === 0) unavailable.push("DEX market-structure data");
  const unmapped = byTypePrefix(byCategory(findings, "dataQuality"), "unmapped_");
  if (unmapped.length > 0) unavailableEvidence.push(...unmapped);
  if (unavailable.length > 0) {
    paragraphs.push(para(`${joinList(unavailable).replace(/^./, (character) => character.toUpperCase())} cannot currently be assessed because the relevant provider mapping or benchmark is unavailable. These are data-coverage limitations rather than negative evidence.`, unavailableEvidence.length > 0 ? unavailableEvidence : ["token"]));
  }

  // 5. Confidence, derived from the same materiality/persistence/completeness signals report.ts uses for the header's regime confidence -- never a separate judgment.
  const topDriver = synthesis.thesisDrivers[0];
  const confidenceWord = topDriver && topDriver.persistence === "persistent" && topDriver.completeness === "complete" && topDriver.materiality.total >= 10
    ? "higher"
    : topDriver && (topDriver.persistence === "conflicting" || topDriver.completeness === "limited")
      ? "lower"
      : "moderate";
  paragraphs.push(para(`Taken together, the evidence ${regime.closingLabel} with ${confidenceWord} confidence, rather than a single unqualified directional conclusion.`, momentum));
  return paragraphs;
}

// ---- 2. Market Performance & Regime ----

function marketPerformanceSection(findings: Finding[]): EngineParagraph[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_"));
  const volumeMomentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("volume_multi_horizon_"));
  const turnover = byType(findings, "elevated_volume_during_decline") ?? byType(findings, "elevated_volume_during_advance");
  const volatility = byCategory(findings, "risk").filter((finding) => finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown");
  const paragraphs: EngineParagraph[] = [];
  if (momentum) {
    paragraphs.push(para(momentumClause(momentum), momentum));
  } else {
    paragraphs.push(para("No price-change observation window currently has enough stored history to establish a momentum pattern.", ["token"]));
  }
  // The multi-horizon volume pattern (hist:volume_24h/7d/30d) is read against the price pattern
  // above: whether trading activity moved the same direction across the same horizons, or whether
  // it diverges -- never silently confirmed or ignored, since volume alone never confirms direction.
  if (volumeMomentum) {
    const volumeClause = momentumClause(volumeMomentum, "Trading volume");
    const priceDirection = momentum ? patternDirection(momentumPattern(momentum)) : "mixed";
    const relation = volumeRelationClause(priceDirection, volumeMomentum);
    paragraphs.push(para(`${volumeClause}${relation}`, volumeMomentum));
  } else if (turnover) {
    const direction = turnover.findingType === "elevated_volume_during_decline" ? "a price decrease" : "a price increase";
    paragraphs.push(para(`This move coincided with trading volume elevated relative to market capitalization (${str(turnover.data.volumeShareValue)}) alongside ${direction} of ${str(turnover.data.changeValue)} over the same 24-hour window — elevated turnover accompanying the move, not confirmation of its direction on its own.`, turnover));
  }
  if (volatility.length > 0) {
    const parts = volatility.map((finding) => `${str(finding.data.value)} over ${finding.data.period ?? "the available window"}`);
    paragraphs.push(para(`Realized price variability over the available windows: ${joinList(parts)}.`, volatility));
  }
  return paragraphs;
}

// ---- 3. Technical Analysis ----

function technicalAnalysisSection(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const technical = byCategory(findings, "technical");
  if (technical.length === 0) return [para("No technical indicator currently has enough stored daily-close history to compute from the available data.", ["token"])];
  const paragraphs: EngineParagraph[] = [];

  const ma = byType(technical, "price_above_moving_averages") ?? byType(technical, "price_below_moving_averages") ?? byType(technical, "price_mixed_vs_moving_averages");
  const macd = byType(technical, "macd_above_signal") ?? byType(technical, "macd_below_signal") ?? byType(technical, "macd_at_signal");
  if (ma || macd) {
    const clauses: string[] = [];
    const trendMembers: Finding[] = [];
    if (ma) {
      trendMembers.push(ma);
      const position = ma.findingType === "price_above_moving_averages" ? "above" : ma.findingType === "price_below_moving_averages" ? "below" : "mixed relative to";
      clauses.push(`price sits ${position} its available moving averages`);
    }
    if (macd) {
      trendMembers.push(macd);
      const state = macd.findingType === "macd_above_signal" ? "above" : macd.findingType === "macd_below_signal" ? "below" : "at";
      // Histogram is USD-denominated (catalog.ts), so the same currency formatter the rest of the
      // report uses for price levels keeps it at a sensible, non-machine-precision display.
      const histogram = macd.data.raw as number | null;
      clauses.push(`the MACD line sits ${state} its signal line (histogram ${typeof histogram === "number" ? formatUsd(histogram) : str(macd.data.raw)})`);
    }
    paragraphs.push(para(`Trend structure: ${joinList(clauses)}.`, trendMembers));
  }

  const rsi = byType(technical, "rsi_at_or_above_70") ?? byType(technical, "rsi_at_or_below_30");
  if (rsi) {
    const level = rsi.findingType === "rsi_at_or_above_70" ? "at or above the 70 level" : "at or below the 30 level";
    // RSI's own unit is "index" (catalog.ts), one decimal place -- the same precision the page's
    // own indicator display already uses for this unit, never the raw unrounded float.
    const rsiRaw = rsi.data.raw as number | null;
    paragraphs.push(para(`Momentum: the 14-day RSI reads ${typeof rsiRaw === "number" ? rsiRaw.toFixed(1) : str(rsi.data.raw)}, ${level} — a momentum extreme by this indicator's own threshold, considered alongside the price pattern above rather than in isolation.`, rsi));
  }

  const bollinger = byType(technical, "price_above_upper_band") ?? byType(technical, "price_below_lower_band")
    ?? byType(technical, "price_upper_half_of_bands") ?? byType(technical, "price_lower_half_of_bands");
  const swing = byTypePrefix(technical, "swing_structure_")[0];
  const range = byType(technical, "closing_range_upper_third") ?? byType(technical, "closing_range_lower_third");
  if (bollinger) {
    const pct = (bollinger.data.raw as number).toFixed(2);
    const rangeClause = range ? ` The latest close ${rangePositionPhrase(range.data.raw as number)} (${(range.data.raw as number).toFixed(2)}%), so this volatility reading should be read together with that range position rather than on its own.` : "";
    paragraphs.push(para(`Volatility structure: ${BOLLINGER_PHRASE[bollinger.findingType](pct)}.${rangeClause}`, range ? [bollinger, range] : bollinger));
  }

  if (swing || (range && !bollinger)) {
    const clauses: string[] = [];
    const structureMembers: Finding[] = [];
    if (swing) {
      structureMembers.push(swing);
      clauses.push(`the last two confirmed swing points form a ${swing.findingType.replace("swing_structure_", "").replace(/_/g, " ")} pattern`);
    }
    if (range && !bollinger) {
      // Only stated here when it wasn't already cross-referenced in the Bollinger clause above,
      // so the same range-position fact is never stated twice in the same section.
      structureMembers.push(range);
      clauses.push(`the latest close ${rangePositionPhrase(range.data.raw as number)} (${(range.data.raw as number).toFixed(2)}%)`);
    }
    paragraphs.push(para(`Market structure: ${joinList(clauses)} — support/resistance context derived from closing prices only.`, structureMembers));

    // The swing finding's own numeric readings (last swing high/low) and the most recent price
    // observation, read together, establish whether the latest close has since moved beyond the
    // swing-point structure above — e.g. a prior lower-high pattern's downward implication is
    // weakened once price moves back above that last swing high. Only stated when the data
    // actually establishes it; never implied from the pattern label alone. Never the banned
    // sentiment words themselves (bullish/bearish) — see evidence-rules.ts's DIRECTIONAL_PATTERNS.
    if (swing && swing.data.beyondLastSwing) {
      const direction = swing.data.beyondLastSwing === "above_high" ? "above" : "below";
      const level = swing.data.beyondLastSwing === "above_high" ? swing.data.lastHigh : swing.data.lastLow;
      const levelText = typeof level === "number" ? formatUsd(level) : null;
      const lowerHighPattern = swing.findingType.includes("lower_high");
      const higherLowPattern = swing.findingType.includes("higher_low") && swing.data.beyondLastSwing === "below_low";
      const implicationClause = swing.data.beyondLastSwing === "above_high" && lowerHighPattern
        ? " The current price therefore weakens the downward implication that would otherwise be associated with the prior lower-high configuration, though it has not yet re-established a higher closing high relative to the full pattern."
        : higherLowPattern
          ? " The current price therefore weakens the upward implication that would otherwise be associated with the prior higher-low configuration."
          : "";
      if (levelText) paragraphs.push(para(`The latest close has since moved ${direction} the last swing ${swing.data.beyondLastSwing === "above_high" ? "high" : "low"} of ${levelText}.${implicationClause}`, [swing]));
    }
  }

  const confluence = relationshipsOfType(synthesis, "technical_price_confluence")[0];
  if (confluence) {
    const members = membersOf(confluence, findings);
    const momentum = members.find((finding) => finding.findingType.startsWith("multi_horizon_"));
    const others = members.filter((finding) => finding !== momentum);
    if (momentum && others.length > 0) {
      const pattern = momentumPattern(momentum);
      const priceUp = pattern.includes("_up") || pattern === "single_up";
      const priceDown = pattern.includes("_down") || pattern === "single_down";
      const agreeing = others.filter((finding) => {
        if (priceUp) return finding.findingType.includes("above") || finding.findingType === "rsi_at_or_above_70";
        if (priceDown) return finding.findingType.includes("below") || finding.findingType === "rsi_at_or_below_30";
        return false;
      });
      const conflicting = others.filter((finding) => !agreeing.includes(finding));
      if (agreeing.length > 0 && conflicting.length === 0) {
        paragraphs.push(para(`The available technical indicators are consistent with the observed price direction, providing technical confluence rather than a contradiction with the momentum pattern above.`, confluence));
      } else if (conflicting.length > 0 && agreeing.length === 0) {
        paragraphs.push(para(`One or more technical indicators are not consistent with the observed price direction, a divergence between the price pattern and its technical configuration worth weighing against the momentum read above.`, confluence));
      } else {
        paragraphs.push(para(`The available technical indicators are mixed relative to the observed price direction — some consistent with it, some not — short of a clear confluence either way.`, confluence));
      }
    }
  }
  return paragraphs;
}

// ---- 4. Fundamental Analysis ----

const GROWTH_LABEL: Record<"tvl" | "fees" | "revenue", string> = { tvl: "total value locked (TVL)", fees: "protocol fees", revenue: "protocol revenue" };

function fundamentalAnalysisSection(findings: Finding[], mapped: boolean): EngineParagraph[] {
  const fundamentals = byCategory(findings, "fundamentalPerformance");
  if (fundamentals.length === 0) {
    return [para(mapped
      ? "No fundamental-activity metric currently has a usable stored value for this token's associated protocol."
      : "No associated protocol is mapped for this token, so fundamental activity (TVL, fees, revenue) cannot be analyzed from the currently available data.", ["token"])];
  }
  const paragraphs: EngineParagraph[] = [];
  const growth = (["tvl", "fees", "revenue"] as const).map((key) => byType(fundamentals, `${key}_growth_increase`) ?? byType(fundamentals, `${key}_growth_decrease`)).filter((finding): finding is Finding => finding !== undefined);
  if (growth.length > 0) {
    const parts = growth.map((finding) => {
      const key = finding.findingType.startsWith("tvl") ? "tvl" : finding.findingType.startsWith("fees") ? "fees" : "revenue";
      const raw = finding.data.raw as number;
      const intervalHours = finding.data.intervalHours as number | null;
      const windowClause = typeof intervalHours === "number" ? ` over approximately ${formatDuration(intervalHours)}` : "";
      return `${GROWTH_LABEL[key]} recorded ${magnitudePhrase("30d", raw, directionWord(raw))} of ${pct(raw)}${windowClause}`;
    });
    paragraphs.push(para(`${joinList(parts)}.`, growth));
  }
  const level = byType(fundamentals, "tvl_level");
  const feeRevenue = byType(fundamentals, "fee_revenue_relationship");
  if (level || feeRevenue) {
    const clauses: string[] = [];
    const members: Finding[] = [];
    if (level) { members.push(level); clauses.push(`total value locked currently stands at ${str(level.data.value)}`); }
    if (feeRevenue) { members.push(feeRevenue); clauses.push(`reported fees of ${str(feeRevenue.data.feesValue)} against revenue of ${str(feeRevenue.data.revenueValue)} for the same period, reflecting the share of collected fees retained as protocol revenue`); }
    paragraphs.push(para(`${joinList(clauses).replace(/^./, (c) => c.toUpperCase())}.`, members));
  }
  const synthesisFinding = byType(fundamentals, "fundamentals_improving") ?? byType(fundamentals, "fundamentals_deteriorating") ?? byType(fundamentals, "fundamentals_mixed");
  if (synthesisFinding) {
    const word = synthesisFinding.findingType === "fundamentals_improving" ? "the same, positive" : synthesisFinding.findingType === "fundamentals_deteriorating" ? "the same, negative" : "different";
    // The individual growth measures above are each over their own observed interval (TVL is
    // typically compared ~30 days apart; fees/revenue are frequently compared over a much shorter
    // window since DeFiLlama reports them more often) -- when those intervals differ materially,
    // the direction-of-change conclusion is stated, but it is NOT presented as a single aligned
    // comparison, and no claim is made about whether fundamentals have "kept pace" with price.
    const intervals = growth.map((finding) => finding.data.intervalHours as number | null).filter((hours): hours is number => typeof hours === "number");
    const mismatchedWindows = intervals.length >= 2 && Math.max(...intervals) / Math.min(...intervals) >= 3;
    const windowCaveat = mismatchedWindows
      ? " These measures were observed over materially different windows (see the figures above), so this is a statement about the direction of each metric individually, not a single aligned comparison across one common period."
      : "";
    paragraphs.push(para(`The available protocol activity metrics moved in ${word} direction${word === "different" ? "s" : ""} over their respective observed periods, ${word === "different" ? "a mixed fundamental picture" : `indicating broadly ${synthesisFinding.findingType === "fundamentals_improving" ? "improving" : "deteriorating"} fundamental activity`}.${windowCaveat}`, synthesisFinding));
  }
  const pace = fundamentalPaceClause(findings);
  if (pace) paragraphs.push(pace);
  return paragraphs;
}

/**
 * The metrics engine's own timestamp-aligned price-vs-fundamental spread (points_price_change_vs_*,
 * see divergenceFindings in findings.ts -- already period-matched, unlike the raw growth figures
 * above, and already filtered to a materially significant gap by DIVERGENCE_MIN_POINTS). States
 * whether the market's repricing has outpaced or trailed the measured fundamental change, so
 * "fundamentals positive" is never read as "fundamentals confirm the size of the price move."
 * Shared by Fundamental Analysis and Cross-Domain Analysis (via fundamentalPaceDirection below) --
 * one derivation, not two.
 */
function fundamentalPaceClause(findings: Finding[]): EngineParagraph | null {
  const paceFindings = (["tvl", "revenue"] as const)
    .map((key) => byType(findings, `points_price_change_vs_${key}_growth`))
    .filter((finding): finding is Finding => finding !== undefined);
  if (paceFindings.length === 0) return null;
  const parts = paceFindings.map((finding) => {
    const key = finding.findingType.includes("_tvl_") ? "TVL" : "revenue";
    const raw = finding.data.raw as number;
    return `price growth has ${raw > 0 ? "outpaced" : "trailed"} ${key} growth by ${Math.abs(raw).toFixed(1)} percentage points over the same aligned interval`;
  });
  return para(`${parts[0].charAt(0).toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `; ${parts.slice(1).join("; ")}` : ""}. This evidence bears on the direction of fundamental activity described above; it does not establish that the magnitude of the recent market move is justified by the measured fundamental change.`, paceFindings);
}

/** Whether the available price-vs-fundamental spread findings show price/market-cap materially outpacing the fundamental, for Cross-Domain Analysis's confirmation-vs-qualification branch. null when no such evidence exists. */
function fundamentalPaceDirection(findings: Finding[]): "outpacing" | "trailing" | "mixed" | null {
  const paceFindings = (["tvl", "revenue"] as const)
    .map((key) => byType(findings, `points_price_change_vs_${key}_growth`))
    .filter((finding): finding is Finding => finding !== undefined);
  if (paceFindings.length === 0) return null;
  const outpacing = paceFindings.filter((finding) => (finding.data.raw as number) > 0);
  const trailing = paceFindings.filter((finding) => (finding.data.raw as number) < 0);
  if (outpacing.length > 0 && trailing.length === 0) return "outpacing";
  if (trailing.length > 0 && outpacing.length === 0) return "trailing";
  return "mixed"; // e.g. outpacing TVL growth while trailing revenue growth -- a genuinely mixed signal, stated as such rather than collapsed into one direction
}

// ---- 5. Valuation Analysis ----

const VALUATION_RATIO_RELATION: Record<string, string> = {
  ratio_market_cap_to_tvl: "relates current market value to the associated protocol's total value locked",
  ratio_fdv_to_tvl: "relates the implied valuation based on reported fully diluted supply to the associated protocol's total value locked",
  ratio_market_cap_to_revenue_24h: "relates current market value to reported protocol revenue",
  ratio_fdv_to_revenue_24h: "relates the implied valuation based on reported fully diluted supply to reported protocol revenue",
};

function valuationAnalysisSection(findings: Finding[]): EngineParagraph[] {
  const valuation = byCategory(findings, "valuation");
  if (valuation.length === 0) return [para("No valuation multiple can be calculated from the currently available data.", ["token"])];
  const paragraphs: EngineParagraph[] = [];
  const ratios = byTypePrefix(valuation, "ratio_");
  if (ratios.length > 0) {
    const parts = ratios.map((finding) => `${str(finding.data.label)} stood at ${str(finding.data.value)}, which ${VALUATION_RATIO_RELATION[finding.findingType] ?? "relates market value to a fundamental measure"}`);
    // "Cheap"/"expensive"/"undervalued"/"overvalued" are never used without a real comparative
    // benchmark in the evidence -- none is currently part of this engine's evidence set, so
    // attractiveness is explicitly left unestablished rather than implied by the multiple alone.
    paragraphs.push(para(`${joinList(parts)}. Attractiveness cannot be established from these multiples alone without an appropriate comparative benchmark, which is not present in the currently available evidence.`, ratios));
  }
  const fdvGap = byType(valuation, "fdv_market_cap_gap");
  if (fdvGap) {
    paragraphs.push(para(`Fully diluted valuation (${str(fdvGap.data.fdvValue)}) exceeds market capitalization (${str(fdvGap.data.marketCapValue)}) according to the reported supply figures; this gap reflects the difference between current and fully diluted supply as reported, not a claim about intrinsic value, and is considered further in Tokenomics & Supply.`, fdvGap));
  }
  return paragraphs;
}

// ---- 6. Market Structure & Liquidity ----

function marketStructureSection(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const liquidity = byCategory(findings, "liquidityMarketStructure");
  if (liquidity.length === 0) return [para("No on-chain DEX market-structure data is currently mapped for this token.", ["token"])];
  const paragraphs: EngineParagraph[] = [];
  const structure = byTypePrefix(liquidity, "structure_");
  if (structure.length > 0) {
    const parts = structure.map((finding) => `${str(finding.data.label)} was ${str(finding.data.value)}`);
    paragraphs.push(para(`${joinList(parts)}.`, structure));
  }
  const turnover = byType(liquidity, "elevated_turnover") ?? byType(liquidity, "low_turnover") ?? byType(liquidity, "turnover_level");
  if (turnover) {
    // The engine's volume/market-cap bands (ELEVATED_VOLUME_TO_MCAP_RATIO/LOW_VOLUME_TO_MCAP_RATIO
    // in thresholds.ts) are internal classification cutoffs, not a documented, benchmarked turnover
    // methodology -- so "elevated"/"low"/"moderate"/"crossing a threshold" are never stated as
    // classifications here, for any of the three finding types. The ratio itself is still cited.
    paragraphs.push(para(`Trading volume represented ${str(turnover.data.value)} of market capitalization. This measures turnover relative to reported market value, but it does not establish executable liquidity, market depth, bid/ask spreads, or expected slippage.`, turnover));
  }
  const technicalLiquidity = relationshipsOfType(synthesis, "technical_liquidity_conditions")[0];
  if (technicalLiquidity) {
    const members = membersOf(technicalLiquidity, findings);
    const trend = members.find((finding) => finding.findingType.startsWith("technical_price_volume_") || finding.findingType.startsWith("technical_turnover_"));
    if (trend) {
      const clause = trend.findingType === "technical_price_volume_divergence" ? "price movement and trading-volume change have diverged over the trailing 30-day window"
        : trend.findingType === "technical_price_volume_same_direction" ? "price movement and trading-volume change have moved in the same direction over the trailing 30-day window"
        : trend.findingType === "technical_turnover_expansion" ? "turnover (volume relative to market cap) has expanded over the trailing 30-day window"
        : "turnover (volume relative to market cap) has contracted over the trailing 30-day window";
      paragraphs.push(para(`Over a longer window, ${clause} — a trend reading that complements the current-snapshot structure above rather than restating it.`, technicalLiquidity));
    }
  }
  return paragraphs;
}

// ---- 7. Tokenomics & Supply ----

function tokenomicsSupplySection(findings: Finding[]): EngineParagraph[] {
  const tokenomics = byCategory(findings, "tokenomics");
  if (tokenomics.length === 0) return [para("No supply data is currently available for this token.", ["token"])];
  const paragraphs: EngineParagraph[] = [];
  const equal = byType(tokenomics, "circulating_equals_total");
  const below = byType(tokenomics, "circulating_below_total");
  if (equal) paragraphs.push(para(`Circulating supply (${str(equal.data.circulatingValue)}) equals total supply (${str(equal.data.totalValue)}), so no already-issued tokens remain outside circulation.`, equal));
  if (below) {
    // The raw values are genuinely different, but a compact display figure can round both to the
    // same string (e.g. "20.09M" for two values a few hundred tokens apart). Asserting "below"
    // between two textually identical numbers would contradict the evidence as displayed, so fall
    // back to full, comma-grouped precision from the same cited raw numbers in that case only.
    const collide = below.data.displaysCollide === "yes";
    const circulatingText = collide ? preciseSupply(below.data.circulatingRaw as number, str(below.data.circulatingValue)) : str(below.data.circulatingValue);
    const totalText = collide ? preciseSupply(below.data.totalRaw as number, str(below.data.totalValue)) : str(below.data.totalValue);
    // Reported neutrally, as the two cited figures themselves -- "not yet in circulation" implies a
    // specific issuance mechanism (tokens held back, pending unlock) the provider's two supply
    // figures alone do not establish.
    paragraphs.push(para(`Circulating supply (${circulatingText}) is below total supply (${totalText}), according to the reported supply figures.`, below));
  }
  const uncapped = byType(tokenomics, "supply_uncapped");
  const maxSupply = byType(tokenomics, "supply_maximum_supply");
  if (uncapped) paragraphs.push(para(`No maximum supply is defined for this token, so the share of an eventual maximum supply currently circulating cannot be calculated; only the currently reported circulating figure (${str(uncapped.data.value)}) is available.`, uncapped));
  else if (maxSupply) paragraphs.push(para(`Maximum supply was reported at ${str(maxSupply.data.value)}.`, maxSupply));

  const lowShare = byType(tokenomics, "low_circulating_share");
  const mcOfFdv = byType(tokenomics, "market_cap_of_fdv");
  const clauses: string[] = [];
  const members: Finding[] = [];
  if (lowShare) { members.push(lowShare); clauses.push(`${(lowShare.data.raw as number).toFixed(1)}% of maximum supply is currently circulating (${str(lowShare.data.breakdown)}), so a majority of eventual total supply has yet to enter circulation`); }
  if (mcOfFdv) { members.push(mcOfFdv); clauses.push(`market capitalization represents ${str(mcOfFdv.data.value)} of fully diluted valuation, the share of total-supply value the market currently prices in`); }
  if (clauses.length > 0) paragraphs.push(para(`${joinList(clauses).replace(/^./, (character) => character.toUpperCase())}.`, members));

  const supplyChange = byType(tokenomics, "circulating_supply_increase_7d") ?? byType(tokenomics, "circulating_supply_decrease_7d");
  if (supplyChange) {
    const raw = supplyChange.data.raw as number;
    paragraphs.push(para(`Circulating supply recorded ${magnitudePhrase("7d", raw, directionWord(raw))} of ${pct(raw)} over the trailing seven days, a dilution-relevant supply-structure change distinct from any current-snapshot ratio above.`, supplyChange));
  }
  return paragraphs;
}

// ---- 8. Cross-Domain Analysis ----
//
// Each helper below answers one of the six cross-domain questions (reinforcement, divergence,
// strongest support, strongest qualification, unavailable domains, implication) for one domain
// pair, built directly from the same findings every other section already cites -- never a second
// calculation, and never emitted unless the specific evidence pair it describes actually exists.

/** A directional technical finding's own clause, naming the indicator and what it shows -- not a generic "technical indicators" reference. */
function technicalIndicatorClause(finding: Finding): string {
  switch (finding.findingType) {
    case "price_above_moving_averages": return "price sits above its available moving averages";
    case "price_below_moving_averages": return "price sits below its available moving averages";
    case "macd_above_signal": return "the MACD line sits above its signal line";
    case "macd_below_signal": return "the MACD line sits below its signal line";
    case "rsi_at_or_above_70": return "the 14-day RSI is at or above 70";
    case "rsi_at_or_below_30": return "the 14-day RSI is at or below 30";
    case "price_above_upper_band": return "the latest close sits above the upper Bollinger band";
    case "price_below_lower_band": return "the latest close sits below the lower Bollinger band";
    default: return finding.findingType.replace(/_/g, " ");
  }
}

type ConfluenceMembers = { momentum: Finding; direction: "up" | "down"; agreeing: Finding[]; conflicting: Finding[] };

/**
 * Which technical indicators agree or disagree with price direction -- the single shared
 * derivation Cross-Domain Analysis, the Executive Assessment, and the Final Conclusion all read
 * from, so "does the technical configuration confirm price" is computed once, never three times.
 * Reuses synthesis.ts's own technical_price_confluence relationship for membership.
 */
function technicalConfluenceMembers(findings: Finding[], synthesis: SynthesisResult): ConfluenceMembers | null {
  const relationship = relationshipsOfType(synthesis, "technical_price_confluence")[0];
  if (!relationship) return null;
  const members = membersOf(relationship, findings);
  const momentum = members.find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  const others = members.filter((finding) => finding !== momentum);
  if (!momentum || others.length === 0) return null;
  const direction = patternDirection(momentumPattern(momentum));
  if (direction === "mixed" || direction === "flat") return null;
  const agreeing = others.filter((finding) => direction === "up" ? finding.findingType.includes("above") || finding.findingType === "rsi_at_or_above_70" : finding.findingType.includes("below") || finding.findingType === "rsi_at_or_below_30");
  const conflicting = others.filter((finding) => !agreeing.includes(finding));
  return { momentum, direction, agreeing, conflicting };
}

/** Price momentum read against its technical configuration: which indicators reinforce the price direction, which (if any) do not. */
function technicalConfluenceParagraph(findings: Finding[], synthesis: SynthesisResult): EngineParagraph | null {
  const confluence = technicalConfluenceMembers(findings, synthesis);
  if (!confluence) return null;
  const { momentum, direction, agreeing, conflicting } = confluence;
  const regimeWord = direction === "up" ? "appreciation" : "decline";
  if (agreeing.length > 0 && conflicting.length === 0) {
    return para(`Price ${regimeWord} is reinforced by the technical configuration: ${joinList(agreeing.map(technicalIndicatorClause))}. These independent technical measures therefore support rather than contradict the prevailing price regime.`, [momentum, ...agreeing]);
  }
  if (conflicting.length > 0 && agreeing.length === 0) {
    return para(`Price ${regimeWord} is not confirmed by the technical configuration: ${joinList(conflicting.map(technicalIndicatorClause))}, which diverges from the price direction rather than reinforcing it.`, [momentum, ...conflicting]);
  }
  return para(`The technical configuration is mixed relative to price ${regimeWord}: ${joinList(agreeing.map(technicalIndicatorClause))} reinforce the direction, while ${joinList(conflicting.map(technicalIndicatorClause))} do not — partial rather than full technical confirmation.`, [momentum, ...agreeing, ...conflicting]);
}

/** Price momentum read against the volume multi-horizon pattern over the same horizons -- confirmation, divergence, or (if volume data is absent) nothing emitted. */
function volumeConfirmationParagraph(findings: Finding[]): EngineParagraph | null {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  const volumeMomentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("volume_multi_horizon_"));
  if (!momentum || !volumeMomentum) return null;
  const priceDirection = patternDirection(momentumPattern(momentum));
  if (priceDirection === "mixed" || priceDirection === "flat") return null;
  const regimeWord = priceDirection === "up" ? "constructive" : "negative";
  const volumePattern = momentumPattern(volumeMomentum);
  // "consistent_up"/"consistent_down" is the only volume pattern that genuinely agrees or disagrees
  // with price as a single, clean directional comparison. Any other volume pattern (reversal, mixed,
  // single-horizon, flat) means volume itself does not move the same way across its own horizons --
  // collapsing that to a coarse up/down (patternDirection also reads "reversal_to_up" as "up") would
  // claim confirmation or divergence the evidence does not actually establish; state the per-horizon
  // picture instead, using the same figures momentumClause already cites.
  if (volumePattern.startsWith("consistent_")) {
    const volDirection = patternDirection(volumePattern);
    if (volDirection === priceDirection) {
      return para(`The ${regimeWord} price regime is accompanied by trading volume moving in the same direction across the same horizons, providing some confirmation from market participation rather than price movement alone.`, [momentum, volumeMomentum]);
    }
    return para(`Price performance is ${regimeWord}, but the volume evidence does not move in the same direction across the same horizons, providing only partial confirmation of the price regime rather than evidence of sustained broad-based participation.`, [momentum, volumeMomentum]);
  }
  const horizons = volumeMomentum.horizons ?? [];
  const perHorizon = horizons.map((horizon) => {
    const volHorizonDirection = horizonDirectionWord(horizon.raw);
    const agrees = (volHorizonDirection === "up" && priceDirection === "up") || (volHorizonDirection === "down" && priceDirection === "down");
    return `${HORIZON_LABEL[horizon.key]} volume ${pct(horizon.raw)} ${agrees ? "moves with" : volHorizonDirection === "flat" ? "is little changed relative to" : "diverges from"} the price direction`;
  });
  return para(`Volume evidence across horizons is mixed rather than uniform: ${joinList(perHorizon)}. This does not establish a single, consistent confirmation or divergence between trading activity and the price regime; each horizon should be read on its own terms rather than collapsed into one directional statement.`, [momentum, volumeMomentum]);
}

function horizonDirectionWord(raw: number): "up" | "down" | "flat" {
  if (momentumBand(raw) === "flat") return "flat";
  return raw >= 0 ? "up" : "down";
}

/** Price momentum read against realized volatility and/or the Bollinger position -- strong performance is never equated with low risk. */
function volatilityQualificationParagraph(findings: Finding[]): EngineParagraph | null {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  if (!momentum) return null;
  const direction = patternDirection(momentumPattern(momentum));
  if (direction === "mixed" || direction === "flat") return null;
  const volatility = byCategory(findings, "risk").filter((finding) => finding.findingType === "elevated_volatility");
  const bollingerExtended = byType(findings, "price_above_upper_band") ?? byType(findings, "price_below_lower_band");
  if (volatility.length === 0 && !bollingerExtended) return null;
  const regimeWord = direction === "up" ? "constructive" : "negative";
  const members = [momentum, ...volatility, ...(bollingerExtended ? [bollingerExtended] : [])];
  const volatilityClause = volatility.length > 0 ? joinList(volatility.map((finding) => `${str(finding.data.value)} over ${finding.data.period ?? "the available window"}`)) : "a statistically extended Bollinger position relative to the 20-day average";
  return para(`The ${regimeWord} price regime is accompanied by elevated realized volatility (${volatilityClause}). The volatility evidence does not invalidate the direction of the current regime, but it materially qualifies the risk associated with it — the absence of a large reported drawdown does not by itself indicate a low-risk environment.`, members);
}

/** Price momentum read against the 30-day closing-range position -- near-range-edge strength carries more reversal risk than the direction alone conveys. */
function rangePositionQualificationParagraph(findings: Finding[]): EngineParagraph | null {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  if (!momentum) return null;
  const direction = patternDirection(momentumPattern(momentum));
  if (direction === "mixed" || direction === "flat") return null;
  const range = byType(findings, "closing_range_upper_third") ?? byType(findings, "closing_range_lower_third");
  if (!range) return null;
  const atEdge = (direction === "up" && range.findingType === "closing_range_upper_third") || (direction === "down" && range.findingType === "closing_range_lower_third");
  if (!atEdge) return null;
  const edgeWord = direction === "up" ? "upper" : "lower";
  return para(`The latest close ${rangePositionPhrase(range.data.raw as number)} (${(range.data.raw as number).toFixed(2)}%), reinforcing the strength of the current move while also increasing the importance of reversal risk if the ${direction === "up" ? "advance" : "decline"} does not persist near this ${edgeWord} boundary.`, [momentum, range]);
}

const FUNDAMENTAL_GROWTH_LABEL: Record<"tvl" | "fees" | "revenue", string> = { tvl: "TVL", fees: "fees", revenue: "revenue" };
function fundamentalGrowthLabel(finding: Finding): string {
  const key = finding.findingType.startsWith("tvl") ? "tvl" : finding.findingType.startsWith("fees") ? "fees" : "revenue";
  return FUNDAMENTAL_GROWTH_LABEL[key];
}

/** Price momentum read against tracked fundamental activity (TVL/fees/revenue): reinforcement, divergence, or an explicit statement that no protocol-level comparison can currently be made. */
function fundamentalsRelationshipParagraph(findings: Finding[]): EngineParagraph | null {
  const priceTvlDivergence = byType(findings, "divergence_price_up_tvl_down") ?? byType(findings, "divergence_price_down_tvl_up");
  if (priceTvlDivergence) {
    return para(`Price performance is occurring despite tracked protocol TVL moving in the opposite direction over the same aligned interval, creating a divergence between market performance and the underlying activity measure that qualifies the strength of the market signal.`, priceTvlDivergence);
  }
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  const growth = (["tvl", "fees", "revenue"] as const).map((key) => byType(findings, `${key}_growth_increase`) ?? byType(findings, `${key}_growth_decrease`)).filter((finding): finding is Finding => finding !== undefined);
  if (momentum && growth.length > 0) {
    const priceDirection = patternDirection(momentumPattern(momentum));
    if (priceDirection !== "mixed" && priceDirection !== "flat") {
      const sameDirection = growth.filter((finding) => (finding.findingType.endsWith("_increase") ? "up" : "down") === priceDirection);
      const opposite = growth.filter((finding) => !sameDirection.includes(finding));
      if (sameDirection.length > 0 && opposite.length === 0) {
        // Same-direction growth alone only establishes directional agreement; whether the market's
        // repricing is actually proportionate to that fundamental change is a separate question the
        // metrics engine's own aligned price-vs-fundamental spread (points_price_change_vs_*)
        // answers, when available -- "fundamentals positive" is never read as "fundamentals confirm
        // the size of the price move" without checking it.
        const pace = fundamentalPaceDirection(findings);
        const paceEvidence = (["tvl", "revenue"] as const).map((key) => byType(findings, `points_price_change_vs_${key}_growth`)).filter((finding): finding is Finding => finding !== undefined);
        if (pace === "outpacing" && priceDirection === "up") {
          return para(`Market appreciation is directionally supported by ${joinList(sameDirection.map(fundamentalGrowthLabel))} moving in the same direction, but the available cross-metric evidence indicates that market repricing has outpaced the measured change in tracked fundamental activity over the same aligned interval. The evidence therefore supports the direction of the move more strongly than its magnitude.`, [momentum, ...sameDirection, ...paceEvidence]);
        }
        if (pace === "mixed" && priceDirection === "up") {
          return para(`Market appreciation is directionally supported by ${joinList(sameDirection.map(fundamentalGrowthLabel))} moving in the same direction, but the available cross-metric evidence is itself mixed: market repricing has outpaced some tracked fundamental measures while trailing others over their respective aligned intervals (see Fundamental Analysis). The evidence therefore supports the direction of the move without establishing that its magnitude is uniformly confirmed by fundamental activity.`, [momentum, ...sameDirection, ...paceEvidence]);
        }
        return para(`Market ${priceDirection === "up" ? "appreciation" : "decline"} is accompanied by ${joinList(sameDirection.map(fundamentalGrowthLabel))} moving in the same direction, providing cross-domain confirmation that market performance is occurring alongside a comparable move in tracked fundamental activity.`, [momentum, ...sameDirection]);
      }
      if (opposite.length > 0) {
        return para(`Price ${priceDirection === "up" ? "appreciation" : "decline"} is occurring despite ${joinList(opposite.map(fundamentalGrowthLabel))} moving in the opposite direction, a divergence that qualifies the strength of the market signal rather than confirming it.`, [momentum, ...opposite]);
      }
    }
  }
  // No fundamental-performance findings of any kind -- state the coverage limitation explicitly rather than treating it as negative evidence.
  if (byCategory(findings, "fundamentalPerformance").length === 0) {
    return para("No protocol-level comparison between market performance and fundamental activity can currently be made for this token; this is a data-coverage limitation rather than negative fundamental evidence.", ["token"]);
  }
  return null;
}

/** Observable valuation multiples, explicitly without an attractiveness judgment, or an explicit statement that none exists. */
function valuationCrossDomainParagraph(findings: Finding[]): EngineParagraph | null {
  const ratios = byTypePrefix(byCategory(findings, "valuation"), "ratio_");
  if (ratios.length > 0) {
    const parts = ratios.map((finding) => str(finding.data.label));
    return para(`${joinList(parts)} ${ratios.length === 1 ? "is" : "are"} observable from the current data, but attractiveness cannot be established without an appropriate comparative benchmark, which is not present in the available evidence.`, ratios);
  }
  if (byCategory(findings, "valuation").length === 0) {
    return para("No valuation multiple can currently be compared against the market or technical regime described above.", ["token"]);
  }
  return null;
}

/** Supply maturity only when it is materially connected to the valuation/dilution picture (a low circulating share or a market-cap/FDV gap) -- not for every token's plain supply figures, which already belong in Tokenomics & Supply. */
function tokenomicsCrossDomainParagraph(findings: Finding[]): EngineParagraph | null {
  const lowShare = byType(findings, "low_circulating_share");
  const mcOfFdv = byType(findings, "market_cap_of_fdv");
  if (!lowShare && !mcOfFdv) return null;
  if (lowShare) {
    return para(`The reported supply position (${(lowShare.data.raw as number).toFixed(1)}% of maximum supply currently circulating) indicates a majority of eventual total supply has yet to enter circulation, context relevant to the market-cap/fully-diluted-valuation relationship above, although the available figures do not themselves establish the timing or market impact of future issuance.`, lowShare);
  }
  return para(`The reported supply position (market capitalization at ${str(mcOfFdv!.data.value)} of fully diluted valuation) indicates relatively mature circulation, providing context for how much of the token's fully diluted value the market currently prices in, although this does not by itself establish future dilution or valuation attractiveness.`, mcOfFdv!);
}

function crossDomainAnalysis(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const paragraphs = [
    technicalConfluenceParagraph(findings, synthesis),
    volumeConfirmationParagraph(findings),
    volatilityQualificationParagraph(findings),
    rangePositionQualificationParagraph(findings),
    fundamentalsRelationshipParagraph(findings),
    valuationCrossDomainParagraph(findings),
    tokenomicsCrossDomainParagraph(findings),
  ].filter((paragraph): paragraph is EngineParagraph => paragraph !== null);
  if (paragraphs.length === 0) {
    return [para("No cross-domain relationship could be established from the currently available data — the individual sections above are the extent of what this snapshot supports.", ["token"])];
  }
  return paragraphs;
}

// ---- 9. Key Investment Risks ----

function keyInvestmentRisks(findings: Finding[]): EngineParagraph[] {
  const risks = byCategory(findings, "risk");
  const substantive = risks.filter((finding) => finding.findingType !== "no_elevated_risk_indicated");
  if (substantive.length === 0) {
    const fallback = risks.find((finding) => finding.findingType === "no_elevated_risk_indicated");
    return [fallback
      // A threshold not being crossed is a fact about the engine's defined bands, never itself a
      // "low risk" conclusion -- the assessment is bounded by whichever risk dimensions and
      // thresholds the available data actually supports, stated explicitly rather than implied.
      ? para(`No available risk metric crossed this analysis's defined elevated-risk threshold. This should not be interpreted as an absence of risk: the assessment is limited to the risk dimensions and thresholds the currently available data supports (see Data Quality & Analytical Limitations for what could not be evaluated).`, fallback)
      : para("No risk dimension could be evaluated from the currently available data.", ["token"])];
  }
  const paragraphs: EngineParagraph[] = [];
  // Volatility/drawdown findings are per-observation-window (7D/30D/90D can each independently
  // cross the threshold) but describe the same underlying risk characteristic -- synthesized into
  // one paragraph rather than one near-duplicate "elevated realized volatility" statement per window.
  const volatilityRisks = substantive.filter((finding) => finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown");
  if (volatilityRisks.length > 0) {
    const elevatedVol = volatilityRisks.filter((finding) => finding.findingType === "elevated_volatility");
    const drawdowns = volatilityRisks.filter((finding) => finding.findingType === "sharp_drawdown");
    const clauses: string[] = [];
    if (elevatedVol.length > 0) clauses.push(`realized volatility is elevated by this analysis's defined threshold over ${joinList(elevatedVol.map((finding) => `${str(finding.data.value)} (${finding.data.period ?? "available window"})`))}`);
    if (drawdowns.length > 0) clauses.push(`a sharp drawdown by this analysis's defined threshold is recorded over ${joinList(drawdowns.map((finding) => `${str(finding.data.value)} (${finding.data.period ?? "available window"})`))}`);
    paragraphs.push(para(`${joinList(clauses).replace(/^./, (character) => character.toUpperCase())} — a technical-risk characteristic of the price series itself, distinct from whether the current direction of price is positive or negative.`, volatilityRisks));
  }
  for (const finding of substantive) {
    if (finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown") continue; // already synthesized above
    if (finding.findingType === "dilution_gap") {
      paragraphs.push(para(`Dilution exposure: fully diluted valuation (${str(finding.data.fdvValue)}) is materially above market capitalization (${str(finding.data.marketCapValue)}), so continued dilution as supply circulates is a valuation-relevant factor to weigh.`, finding));
    } else if (finding.findingType === "market_fundamental_divergence") {
      paragraphs.push(para("Market/fundamental divergence: price appreciation was observed while tracked protocol TVL decreased over the same aligned interval — a risk-relevant divergence between market performance and underlying activity.", finding));
    } else if (finding.findingType === "low_circulating_supply_share") {
      paragraphs.push(para(`Supply-structure risk: circulating supply represents ${str(finding.data.value)} of maximum supply; the remaining supply entering circulation over time is a factor to weigh alongside current valuation.`, finding));
    } else {
      paragraphs.push(para(`${str(finding.data.label ?? finding.findingType.replace(/_/g, " "))} was observed.`, finding));
    }
  }
  return paragraphs;
}

// ---- 10. Data Quality & Analytical Limitations ----

function dataQualityLimitations(findings: Finding[]): EngineParagraph[] {
  const gaps = byCategory(findings, "dataQuality");
  if (gaps.length === 0) return [para("No data gap was identified for this token's currently available evidence.", ["token"])];
  const paragraphs: EngineParagraph[] = [];
  const unmapped = byTypePrefix(gaps, "unmapped_");
  if (unmapped.length > 0) {
    const parts = unmapped.map((finding) => `${str(finding.data.provider)} does not have a curated mapping for this token`);
    paragraphs.push(para(`${joinList(parts)}, so the data ${unmapped.length === 1 ? "it" : "they"} would supply is not covered by this analysis. Missing data is not itself negative evidence about this token's underlying condition — it means the relevant comparison cannot currently be made.`, unmapped));
  }
  const insufficient = byTypePrefix(gaps, "insufficient_history_");
  if (insufficient.length > 0) {
    paragraphs.push(para(`One or more stored series currently have fewer than two observations in at least one requested window, so a trend cannot be established there without inventing one.`, insufficient));
  }
  const missing = byTypePrefix(gaps, "missing_");
  if (missing.length > 0) {
    const parts = missing.map((finding) => str(finding.data.label));
    paragraphs.push(para(`${joinList(parts)} ${missing.length === 1 ? "is" : "are"} not available for this token from the mapped data providers.`, missing));
  }
  const noTechnical = byType(gaps, "no_technical_indicators");
  if (noTechnical) {
    paragraphs.push(para("No technical indicator currently has enough stored daily-close history to compute, so Technical Analysis is omitted from this report rather than rendered without content.", noTechnical));
  }
  return paragraphs;
}

// ---- 11. Final Analytical Conclusion ----

/**
 * The final weighing of the evidence -- deliberately NOT the same prose as the Executive Assessment
 * (which states the current thesis). This section states what the TOTALITY of the evidence supports
 * after weighing support against qualification against what remains unknown, in the five-paragraph
 * structure (supports / strongest support / strongest qualification / limitations / confidence) an
 * institutional conclusion follows. Reuses the identical momentum/confluence/qualification/coverage
 * derivations the Executive Assessment and Cross-Domain Analysis already compute -- never a new
 * calculation -- but composes them into a distinct final-weighing sentence shape each time.
 */
function finalConclusion(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && !finding.findingType.startsWith("volume_multi_horizon_"));
  const direction = momentum ? patternDirection(momentumPattern(momentum)) : null;
  if (!momentum || direction === null || direction === "mixed" || direction === "flat") {
    const drivers = synthesis.thesisDrivers;
    if (drivers.length === 0) {
      return [para("The currently available evidence does not support a central analytical conclusion beyond the individual observations above; a materially richer data snapshot would be needed before one could be formed.", ["token"])];
    }
    const top = drivers[0];
    return [para(`Without a single, consistent price direction across the measured horizons, the available evidence does not support a central market-regime conclusion. The most material signal available instead concerns ${domainWord(top.categories)}; see Cross-Domain Analysis and the section above for how it is supported and qualified.`, top)];
  }
  const momentumDirection: "up" | "down" = direction;

  const paragraphs: EngineParagraph[] = [];
  const pattern = momentumPattern(momentum);
  const regime = regimeDescriptor(pattern, momentumDirection);
  const confluence = technicalConfluenceMembers(findings, synthesis);

  // 1. What the totality of evidence supports -- derived from the actual dominant pattern, not a
  // fixed opening sentence forced into constructive/negative wording (see regimeDescriptor).
  paragraphs.push(para(`The available evidence ${regime.closingLabel}: ${momentumClause(momentum)}`, momentum));

  // 2. Strongest supporting evidence. Confluence/volume are only read as reinforcing "that
  // direction" when the price pattern itself is a genuinely consistent one -- during a reversal,
  // the short- and longer-term horizons disagree, so there is no single direction for another
  // signal to reinforce.
  const supportParts: string[] = [];
  const supportEvidence: Finding[] = [momentum];
  if (!regime.isReversal && confluence && confluence.agreeing.length > 0) {
    supportParts.push(`the technical configuration independently reinforces that direction (${joinList(confluence.agreeing.map(technicalIndicatorClause))})`);
    supportEvidence.push(...confluence.agreeing);
  }
  const volumeMomentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("volume_multi_horizon_"));
  if (!regime.isReversal && volumeMomentum && momentumPattern(volumeMomentum).startsWith("consistent_") && patternDirection(momentumPattern(volumeMomentum)) === momentumDirection) {
    supportParts.push("trading volume moves in the same direction across the same horizons");
    supportEvidence.push(volumeMomentum);
  }
  if (supportParts.length > 0) {
    paragraphs.push(para(`The strongest support for this reading is that ${joinList(supportParts)}, reinforcing rather than merely coinciding with the price pattern.`, supportEvidence));
  }

  // 3. Strongest qualification or contradiction.
  const qualification = momentumQualification(findings, momentumDirection);
  const conflictingSupport = confluence && confluence.conflicting.length > 0 && confluence.agreeing.length === 0;
  if (qualification && conflictingSupport && confluence) {
    paragraphs.push(para(`The principal qualification is twofold: ${qualification.text}, and the available technical indicators do not confirm the price direction (${joinList(confluence.conflicting.map(technicalIndicatorClause))}). Together these mean the current reading should not be treated as unconditional.`, [...qualification.evidence, ...confluence.conflicting]));
  } else if (qualification) {
    paragraphs.push(para(`The principal qualification is that ${qualification.text}. This does not invalidate the direction of the current regime, but it materially qualifies the risk and confidence associated with it.`, qualification.evidence));
  } else if (conflictingSupport && confluence) {
    paragraphs.push(para(`The principal qualification is that the available technical indicators do not confirm the price direction (${joinList(confluence.conflicting.map(technicalIndicatorClause))}), which limits how far this reading can be extended.`, confluence.conflicting));
  }

  // 3.5. Every other materially available evidence domain, reconciled into the final weighing --
  // never omitted merely because the market/technical conclusion is already established. Reuses the
  // exact same domain clauses as the Executive Assessment (one derivation per domain, not two).
  for (const clause of [fundamentalsSynthesisClause(findings), valuationSynthesisClause(findings), liquiditySynthesisClause(findings), riskSynthesisClause(findings)]) {
    if (clause) paragraphs.push(clause);
  }

  // 4. What cannot currently be established, and how that bounds confidence.
  const unavailable: string[] = [];
  const unavailableEvidence: Finding[] = [];
  if (byCategory(findings, "fundamentalPerformance").length === 0) unavailable.push("whether market performance is accompanied by corresponding protocol-level activity");
  if (byCategory(findings, "valuation").length === 0) unavailable.push("whether the current market pricing is attractive relative to any comparative benchmark");
  if (byCategory(findings, "liquidityMarketStructure").length === 0) unavailable.push("whether DEX-level trading and liquidity conditions corroborate the market and technical regime");
  const unmapped = byTypePrefix(byCategory(findings, "dataQuality"), "unmapped_");
  unavailableEvidence.push(...unmapped);
  if (unavailable.length > 0) {
    paragraphs.push(para(`${joinList(unavailable).replace(/^./, (character) => character.toUpperCase())} cannot currently be established because the relevant provider mapping is unavailable. This bounds confidence in the conclusion below without itself being negative evidence.`, unavailableEvidence.length > 0 ? unavailableEvidence : ["token"]));
  }

  // 5. Final assessment and confidence.
  const topDriver = synthesis.thesisDrivers[0];
  const confidenceWord = topDriver && topDriver.persistence === "persistent" && topDriver.completeness === "complete" && topDriver.materiality.total >= 10
    ? "higher"
    : topDriver && (topDriver.persistence === "conflicting" || topDriver.completeness === "limited")
      ? "lower"
      : "moderate";
  // The closing sentence must never claim a category is unavailable when the corresponding
  // evidence already exists -- paragraph 4 above already determined exactly which categories (if
  // any) are actually missing; reuse that same determination rather than a static claim.
  const futureEvidenceClause = unavailable.length > 0
    ? ` whether subsequent observations confirm the current regime, and ${joinList(unavailable)} becomes establishable as further evidence is collected`
    : " whether subsequent observations confirm the current regime";
  paragraphs.push(para(`Overall, the evidence ${regime.closingLabel} with ${confidenceWord} confidence. This conclusion would strengthen or weaken depending on${futureEvidenceClause}.`, momentum));
  return paragraphs;
}

// ---- Further research questions (driver-gated — see synthesis.ts's ThesisDriver) ----

const RESEARCH_QUESTIONS: { when: (categories: Set<string>) => boolean; question: string; rationale: string }[] = [
  { when: (c) => c.has("positive_momentum"), question: "Does the positive momentum persist over subsequent observation periods?", rationale: "A material positive-momentum driver was identified across the currently available observation windows." },
  { when: (c) => c.has("negative_momentum"), question: "Does the negative momentum persist over subsequent observation periods, or does it represent a shorter-term move within a longer-term trend?", rationale: "A material negative-momentum driver was identified across the currently available observation windows." },
  { when: (c) => c.has("missing_history"), question: "Would a longer stored price, TVL, or technical-indicator history change the picture presented here?", rationale: "One or more series in this snapshot lack enough stored points to establish a trend over their full window." },
  { when: (c) => c.has("mapping_limitation"), question: "Would additional protocol or market mapping materially expand the available fundamental or technical evidence?", rationale: "One or more data providers do not have a curated mapping for this token, so some sections are not available." },
  { when: (c) => c.has("divergence"), question: "Does the observed divergence between market performance and tracked fundamental or technical activity persist over a longer window?", rationale: "A material divergence between price and tracked activity was identified in the currently available data." },
  { when: (c) => c.has("valuation_expansion"), question: "Does the valuation/activity relationship continue to widen, or does it revert as fundamentals catch up?", rationale: "A material valuation or dilution-relevant relationship was identified in the currently available data." },
];

export function furtherResearchQuestions(findings: Finding[], thesisDrivers: ThesisDriver[]): { question: string; rationale: string; sourceIds: string[] }[] {
  const categories = new Set<string>();
  for (const finding of findings) {
    if (finding.findingType.startsWith("insufficient_history_")) categories.add("missing_history");
    if (finding.findingType.startsWith("unmapped_")) categories.add("mapping_limitation");
  }
  const hasDriver = (test: (driver: ThesisDriver) => boolean) => thesisDrivers.some(test);
  if (hasDriver((driver) => driver.findingIds.some((id) => id.includes(":multi_horizon_consistent_up")))) categories.add("positive_momentum");
  if (hasDriver((driver) => driver.findingIds.some((id) => id.includes(":multi_horizon_consistent_down")))) categories.add("negative_momentum");
  if (hasDriver((driver) => driver.relationshipType === "price_fundamental_divergence" || driver.findingIds.some((id) => id.includes(":technical_price_tvl_divergence:") || id.includes(":technical_price_volume_divergence:")))) categories.add("divergence");
  if (hasDriver((driver) =>
    driver.relationshipType === "valuation_activity_relationship" || driver.relationshipType === "market_momentum_valuation" || driver.relationshipType === "supply_valuation_exposure"
    || driver.findingIds.some((id) => id.includes(":fdv_market_cap_gap:") || id.includes(":dilution_gap:") || id.includes(":ratio_")),
  )) categories.add("valuation_expansion");
  return RESEARCH_QUESTIONS.filter((entry) => entry.when(categories)).map((entry) => ({ question: entry.question, rationale: entry.rationale, sourceIds: [] }));
}

// ---- Entry point ----

export type EngineNarrative = {
  executiveAssessment: EngineParagraph[];
  marketPerformance: EngineParagraph[];
  technicalAnalysis: EngineParagraph[];
  fundamentalAnalysis: EngineParagraph[];
  valuationAnalysis: EngineParagraph[];
  marketStructureLiquidity: EngineParagraph[];
  tokenomicsSupply: EngineParagraph[];
  crossDomainAnalysis: EngineParagraph[];
  keyRisks: EngineParagraph[];
  dataQualityLimitations: EngineParagraph[];
  finalConclusion: EngineParagraph[];
  furtherResearchQuestions: { question: string; rationale: string; sourceIds: string[] }[];
};

export function buildNarrative(findings: Finding[], synthesis: SynthesisResult, fundamentalsMapped: boolean): EngineNarrative {
  return {
    executiveAssessment: executiveAssessment(findings, synthesis),
    marketPerformance: marketPerformanceSection(findings),
    technicalAnalysis: technicalAnalysisSection(findings, synthesis),
    fundamentalAnalysis: fundamentalAnalysisSection(findings, fundamentalsMapped),
    valuationAnalysis: valuationAnalysisSection(findings),
    marketStructureLiquidity: marketStructureSection(findings, synthesis),
    tokenomicsSupply: tokenomicsSupplySection(findings),
    crossDomainAnalysis: crossDomainAnalysis(findings, synthesis),
    keyRisks: keyInvestmentRisks(findings),
    dataQualityLimitations: dataQualityLimitations(findings),
    finalConclusion: finalConclusion(findings, synthesis),
    furtherResearchQuestions: furtherResearchQuestions(findings, synthesis.thesisDrivers),
  };
}
