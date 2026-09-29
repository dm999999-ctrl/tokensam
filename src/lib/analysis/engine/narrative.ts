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
import { findingId, type HorizonClass, type Relationship, type RelationshipType, type SynthesisResult, type ThesisDriver } from "./synthesis.ts";
import { magnitudeWord, type MomentumPeriodKey } from "./thresholds.ts";
import type { EngineParagraph } from "./report-schema.ts";
import { formatCount } from "../../ui/format.ts";

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
  return finding.findingType.replace("multi_horizon_", "") as MultiHorizonPattern;
}

/** The concrete figures a momentum finding cites, e.g. "+5.64% over 7D and +38.11% over 90D". */
function momentumFigures(finding: Finding): string {
  const horizons = finding.horizons ?? [];
  return joinList(horizons.map((horizon) => `${pct(horizon.raw)} over ${HORIZON_LABEL[horizon.key]}`));
}

/** One flowing sentence describing a multi-horizon momentum finding's pattern — direction, magnitude, pace, and reversal are each named only where the pattern actually establishes them. */
function momentumClause(finding: Finding): string {
  const horizons = finding.horizons ?? [];
  const pattern = momentumPattern(finding);
  const shortest = horizons[0], longest = horizons[horizons.length - 1];
  const figures = momentumFigures(finding);
  if (pattern === "single_up" || pattern === "single_down") {
    const horizon = horizons[0];
    return `Price recorded ${magnitudePhrase(horizon.key, horizon.raw, directionWord(horizon.raw))} of ${pct(horizon.raw)} over the ${HORIZON_WORD[horizon.key]} window, the only horizon currently available.`;
  }
  if (pattern === "flat") return `Price has been essentially unchanged across the available observation windows (${figures}).`;
  if (pattern === "mixed") return `Price moved ${figures}, without a single consistent direction across the available windows — a mixed short- and long-term picture rather than a clear regime.`;
  if (pattern === "reversal_to_down" || pattern === "reversal_to_up") {
    const turn = pattern === "reversal_to_down" ? "turned negative" : "turned positive";
    return `Price moved ${figures}. The longer-term ${HORIZON_WORD[longest.key]} trend has been ${pattern === "reversal_to_down" ? "positive" : "negative"}, but the most recent ${HORIZON_WORD[shortest.key]} movement has ${turn}, marking a reversal within the observed history rather than a continuation of the longer-term regime.`;
  }
  const paceClause = shortest.key === longest.key ? "" : pattern.endsWith("decelerating")
    ? ` The ${HORIZON_WORD[longest.key]} figure is materially larger than the ${HORIZON_WORD[shortest.key]} figure, indicating a substantial share of the cumulative move occurred before the most recent window — a deceleration in pace, not a change in direction.`
    : pattern.endsWith("accelerating")
      ? ` The recent ${HORIZON_WORD[shortest.key]} pace of change is running faster than the pace implied by the remainder of the ${HORIZON_WORD[longest.key]} window, indicating the pace of change has picked up more recently.`
      : ` The pace of change has remained broadly consistent between the ${HORIZON_WORD[shortest.key]} and ${HORIZON_WORD[longest.key]} windows.`;
  return `Price moved ${figures}, a persistent ${pattern.includes("_up_") ? "positive" : "negative"} regime across every available horizon.${paceClause}`;
}

// ---- 1. Executive Investment Assessment ----

const REGIME_WORD: Record<HorizonClass, string> = { structural: "structural horizon", medium_term: "medium-term horizon", short_term: "short-term horizon", snapshot: "current-snapshot" };

function domainWord(categories: FindingCategory[]): string {
  const labels: Partial<Record<FindingCategory, string>> = {
    marketPerformance: "market performance", technical: "technical configuration", fundamentalPerformance: "fundamental activity",
    valuation: "valuation", marketFundamentalRelationships: "the price/fundamental relationship",
    liquidityMarketStructure: "trading structure", tokenomics: "supply structure", risk: "risk",
  };
  return joinList([...new Set(categories.map((category) => labels[category] ?? category))]);
}

function executiveAssessment(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const drivers = synthesis.thesisDrivers;
  if (drivers.length === 0) {
    return [para("The currently available data snapshot does not support a substantive analytical thesis for this token beyond individual data points; see Data Quality & Analytical Limitations for what is missing.", ["token"])];
  }
  const [top, ...rest] = drivers;
  const paragraphs: EngineParagraph[] = [];
  const domainsCovered = new Set(drivers.flatMap((driver) => driver.categories));
  // A driver/domain count is not itself a value any cited finding reports, so it is described
  // qualitatively (breadth/depth words) rather than as a literal digit — the same pattern the
  // engine's earlier executive-overview composer used, never an invented or ungrounded number.
  const breadth = domainsCovered.size >= 5 ? "broad" : domainsCovered.size >= 3 ? "moderate" : "limited";
  const depth = drivers.length >= 4 ? "an extensive" : drivers.length >= 2 ? "a moderate" : "a single";
  paragraphs.push(para(
    `This assessment draws on ${depth} set of material analytical drivers across ${breadth} coverage of the token's market, technical, fundamental, and structural data. The most material of these concerns ${domainWord(top.categories)}, a ${REGIME_WORD[top.horizon]} signal; the analysis below sets it against the rest of the available evidence.`,
    drivers,
  ));
  const conflicting = drivers.filter((driver) => driver.persistence === "conflicting");
  const corroborated = drivers.filter((driver) => driver.materiality.corroboration > 0);
  if (corroborated.length > 0) {
    const strongest = corroborated[0];
    paragraphs.push(para(
      `The strongest supporting evidence is the relationship spanning ${domainWord(strongest.categories)}, where multiple independent data categories agree — the kind of cross-domain corroboration that carries more analytical weight than any single-category reading.`,
      strongest,
    ));
  }
  if (conflicting.length > 0) {
    const contradiction = conflicting[0];
    paragraphs.push(para(
      `The strongest contradictory evidence is a conflicting signal in ${domainWord(contradiction.categories)}, where the available horizons do not agree with one another — a limitation on how far the central thesis can be extended.`,
      contradiction,
    ));
  } else if (rest.length > 0 && rest.some((driver) => !driver.categories.some((category) => top.categories.includes(category)))) {
    const distinct = rest.find((driver) => !driver.categories.some((category) => top.categories.includes(category)))!;
    paragraphs.push(para(
      `A separate material signal in ${domainWord(distinct.categories)} should be weighed alongside the dominant driver rather than read in isolation — see Cross-Domain Analysis for how the two interact.`,
      distinct,
    ));
  }
  const risks = byCategory(findings, "risk").filter((finding) => finding.findingType !== "no_elevated_risk_indicated");
  const gaps = byCategory(findings, "dataQuality");
  const riskClause = risks.length > 0
    ? para(`The principal risk currently supported by the evidence is ${str(risks[0].data.label ?? risks[0].findingType.replace(/_/g, " "))}; see Key Investment Risks for the full evidence-supported set.`, risks[0])
    : para("No elevated risk indicator crossed this analysis's thresholds in the currently available data.", ["token"]);
  paragraphs.push(riskClause);
  if (gaps.length > 0) {
    paragraphs.push(para(`The principal uncertainty is data coverage: one or more gaps in the currently available evidence bound how far this assessment can be extended; see Data Quality & Analytical Limitations.`, gaps));
  }
  return paragraphs;
}

// ---- 2. Market Performance & Regime ----

function marketPerformanceSection(findings: Finding[]): EngineParagraph[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_"));
  const turnover = byType(findings, "elevated_volume_during_decline") ?? byType(findings, "elevated_volume_during_advance");
  const volatility = byCategory(findings, "risk").filter((finding) => finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown");
  const paragraphs: EngineParagraph[] = [];
  if (momentum) {
    paragraphs.push(para(momentumClause(momentum), momentum));
  } else {
    paragraphs.push(para("No price-change observation window currently has enough stored history to establish a momentum pattern.", ["token"]));
  }
  if (turnover) {
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
      clauses.push(`the MACD line sits ${state} its signal line (histogram ${str(macd.data.raw)})`);
    }
    paragraphs.push(para(`Trend structure: ${joinList(clauses)}.`, trendMembers));
  }

  const rsi = byType(technical, "rsi_at_or_above_70") ?? byType(technical, "rsi_at_or_below_30");
  if (rsi) {
    const level = rsi.findingType === "rsi_at_or_above_70" ? "at or above the 70 level" : "at or below the 30 level";
    paragraphs.push(para(`Momentum: the 14-day RSI reads ${str(rsi.data.raw)}, ${level} — a momentum extreme by this indicator's own threshold, considered alongside the price pattern above rather than in isolation.`, rsi));
  }

  const bollinger = byType(technical, "price_above_upper_band") ?? byType(technical, "price_below_lower_band");
  if (bollinger) {
    const position = bollinger.findingType === "price_above_upper_band" ? "above the upper" : "below the lower";
    paragraphs.push(para(`Volatility structure: the latest close sits ${position} Bollinger band (20, 2), a statistically extended position relative to the 20-day average.`, bollinger));
  }

  const swing = byTypePrefix(technical, "swing_structure_")[0];
  const range = byType(technical, "closing_range_upper_third") ?? byType(technical, "closing_range_lower_third");
  if (swing || range) {
    const clauses: string[] = [];
    const structureMembers: Finding[] = [];
    if (swing) {
      structureMembers.push(swing);
      clauses.push(`the last two confirmed swing points form a ${swing.findingType.replace("swing_structure_", "").replace(/_/g, " ")} pattern`);
    }
    if (range) {
      structureMembers.push(range);
      const third = range.findingType === "closing_range_upper_third" ? "upper" : "lower";
      clauses.push(`the latest close sits in the ${third} third of its 30-day closing range (${str(range.data.raw)}%)`);
    }
    paragraphs.push(para(`Market structure: ${joinList(clauses)} — support/resistance context derived from closing prices only.`, structureMembers));
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
      return `${GROWTH_LABEL[key]} recorded ${magnitudePhrase("30d", raw, directionWord(raw))} of ${pct(raw)}`;
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
    paragraphs.push(para(`The available protocol activity metrics moved in ${word} direction${word === "different" ? "s" : ""} over their respective observed periods, ${word === "different" ? "a mixed fundamental picture" : `indicating broadly ${synthesisFinding.findingType === "fundamentals_improving" ? "improving" : "deteriorating"} fundamental activity`}.`, synthesisFinding));
  }
  return paragraphs;
}

// ---- 5. Valuation Analysis ----

function valuationAnalysisSection(findings: Finding[]): EngineParagraph[] {
  const valuation = byCategory(findings, "valuation");
  if (valuation.length === 0) return [para("No valuation multiple can be calculated from the currently available data.", ["token"])];
  const paragraphs: EngineParagraph[] = [];
  const ratios = byTypePrefix(valuation, "ratio_");
  if (ratios.length > 0) {
    const parts = ratios.map((finding) => `${str(finding.data.label)} stood at ${str(finding.data.value)}`);
    paragraphs.push(para(`${joinList(parts)} — measures of how the market values this token relative to its underlying fundamental activity, without an inherent high/low reading.`, ratios));
  }
  const fdvGap = byType(valuation, "fdv_market_cap_gap");
  if (fdvGap) {
    paragraphs.push(para(`Fully diluted valuation (${str(fdvGap.data.fdvValue)}) exceeds market capitalization (${str(fdvGap.data.marketCapValue)}); this gap reflects supply not yet in circulation rather than a claim about intrinsic value, and is considered further in Tokenomics & Supply.`, fdvGap));
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
    const level = turnover.findingType === "elevated_turnover" ? "elevated" : turnover.findingType === "low_turnover" ? "low" : "moderate";
    paragraphs.push(para(`Trading volume represented ${str(turnover.data.value)} of market capitalization, a ${level} level of turnover relative to size. This reflects trading activity, not necessarily executable liquidity — volume alone does not establish depth or slippage.`, turnover));
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
    paragraphs.push(para(`Circulating supply (${circulatingText}) is below total supply (${totalText}), indicating a portion of already-issued tokens is not yet in circulation.`, below));
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

const RELATIONSHIP_FRAME: Record<RelationshipType, (members: Finding[]) => string> = {
  price_fundamental_divergence: () => "Price and tracked fundamental activity diverged over the same aligned interval — a market/fundamental relationship, not a causal claim.",
  valuation_activity_relationship: () => "Market capitalization, TVL, and their relative growth rates are read together: how valuation and underlying activity have moved relative to one another over the available window.",
  market_momentum_valuation: () => "Price momentum is read alongside a valuation multiple: whether the market's price behavior is or is not accompanied by a shift in how the market prices the token relative to its fundamentals.",
  supply_valuation_exposure: () => "A low circulating share and a material FDV/market-cap gap are two expressions of the same dilution-exposure characteristic, not two independent facts.",
  trading_liquidity_conditions: () => "DEX liquidity, volume, and transaction activity are read together as one current trading-conditions picture, not as independent metrics.",
  fundamental_activity_trajectory: () => "TVL, fees, and revenue and their respective changes are read together as one fundamental-activity trajectory.",
  technical_price_confluence: () => "Price momentum is read alongside its technical configuration (moving averages, MACD, RSI, Bollinger position) for confluence or divergence.",
  technical_fundamental_relationship: () => "A 30-day technical price/TVL or valuation-trend reading is read alongside the fundamental-activity findings it relates to — technical and fundamental evidence considered together.",
  technical_liquidity_conditions: () => "A 30-day technical price/volume or turnover-trend reading is read alongside current on-chain trading-structure findings.",
};

function crossDomainAnalysis(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  if (synthesis.relationships.length === 0) {
    return [para("No cross-domain relationship could be established from the currently available data — the individual sections above are the extent of what this snapshot supports.", ["token"])];
  }
  return synthesis.relationships.map((relationship) => {
    const members = membersOf(relationship, findings);
    const frame = RELATIONSHIP_FRAME[relationship.type](members);
    const persistenceClause = relationship.persistence === "persistent"
      ? " The relationship holds consistently across the horizons it draws on, not merely at a single point."
      : relationship.persistence === "conflicting"
        ? " The horizons it draws on do not agree with one another, which limits how much weight this relationship can carry on its own."
        : "";
    const completenessClause = relationship.completeness === "limited"
      ? " This reading is based on partial data — a relevant metric is currently unavailable, which does not itself indicate a weaker underlying condition, only reduced confidence in this specific comparison."
      : relationship.completeness === "partial"
        ? " One relevant data point is currently unavailable, which modestly limits confidence in this comparison."
        : "";
    return para(`${frame}${persistenceClause}${completenessClause}`, relationship);
  });
}

// ---- 9. Key Investment Risks ----

function keyInvestmentRisks(findings: Finding[]): EngineParagraph[] {
  const risks = byCategory(findings, "risk");
  const substantive = risks.filter((finding) => finding.findingType !== "no_elevated_risk_indicated");
  if (substantive.length === 0) {
    const fallback = risks.find((finding) => finding.findingType === "no_elevated_risk_indicated");
    return [fallback
      ? para(`Of the risk dimensions evaluated from the currently available data, none crossed the thresholds this analysis treats as elevated. This does not evaluate dimensions for which no data is currently available (see Data Quality & Analytical Limitations).`, fallback)
      : para("No risk dimension could be evaluated from the currently available data.", ["token"])];
  }
  return substantive.map((finding) => {
    if (finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown") {
      return para(`${finding.findingType === "elevated_volatility" ? "Elevated realized volatility" : "A sharp drawdown"}: the stored daily price history recorded ${str(finding.data.value)} over the ${finding.data.period ?? "available"} window — a technical-risk characteristic of the price series itself.`, finding);
    }
    if (finding.findingType === "dilution_gap") {
      return para(`Dilution exposure: fully diluted valuation (${str(finding.data.fdvValue)}) is materially above market capitalization (${str(finding.data.marketCapValue)}), so continued dilution as supply circulates is a valuation-relevant factor to weigh.`, finding);
    }
    if (finding.findingType === "market_fundamental_divergence") {
      return para("Market/fundamental divergence: price appreciation was observed while tracked protocol TVL decreased over the same aligned interval — a risk-relevant divergence between market performance and underlying activity.", finding);
    }
    if (finding.findingType === "low_circulating_supply_share") {
      return para(`Supply-structure risk: circulating supply represents ${str(finding.data.value)} of maximum supply; the remaining supply entering circulation over time is a factor to weigh alongside current valuation.`, finding);
    }
    return para(`${str(finding.data.label ?? finding.findingType.replace(/_/g, " "))} was observed.`, finding);
  });
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
  return paragraphs;
}

// ---- 11. Final Analytical Conclusion ----

function finalConclusion(findings: Finding[], synthesis: SynthesisResult): EngineParagraph[] {
  const drivers = synthesis.thesisDrivers;
  if (drivers.length === 0) {
    return [para("The currently available evidence does not support a central analytical thesis beyond the individual observations above; a materially richer data snapshot would be needed before one could be formed.", ["token"])];
  }
  const paragraphs: EngineParagraph[] = [];
  const top = drivers[0];
  paragraphs.push(para(`The central assessment rests most heavily on ${domainWord(top.categories)}, the most material driver identified in the currently available evidence.`, top));
  const conflicting = drivers.filter((driver) => driver.persistence === "conflicting");
  const corroborated = drivers.filter((driver) => driver.materiality.corroboration > 0);
  if (corroborated.length > 0 || conflicting.length > 0) {
    const clauses: string[] = [];
    if (corroborated.length > 0) clauses.push(`corroborating evidence in ${domainWord(corroborated[0].categories)}`);
    if (conflicting.length > 0) clauses.push(`a conflicting signal in ${domainWord(conflicting[0].categories)}`);
    paragraphs.push(para(`This is weighed against ${joinList(clauses)}.`, [...corroborated.slice(0, 1), ...conflicting.slice(0, 1)]));
  }
  const technicalDriver = drivers.find((driver) => driver.relationshipType?.startsWith("technical_"));
  if (technicalDriver) paragraphs.push(para("The available technical indicators contribute confirmation or divergence context alongside the price pattern itself — see Technical Analysis and Cross-Domain Analysis for the specific reading.", technicalDriver));
  const fundamentalsDriver = drivers.find((driver) => driver.categories.includes("fundamentalPerformance"));
  if (fundamentalsDriver) paragraphs.push(para("Fundamental activity contributes independent corroboration or contradiction of the market-performance regime described above, distinct from price action alone.", fundamentalsDriver));
  const gaps = byCategory(findings, "dataQuality");
  if (gaps.length > 0) {
    paragraphs.push(para(`What remains uncertain is bounded by data coverage: one or more identified gaps in the currently available evidence (see Data Quality & Analytical Limitations). Materially closing those gaps — a curated protocol or market mapping, or a longer stored history — is the evidence most likely to change this assessment.`, gaps));
  }
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
