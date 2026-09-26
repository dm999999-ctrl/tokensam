import { canonicalTokens } from "../../data/canonical-tokens.ts";
import type { ResearchContext } from "./research-context.ts";

/**
 * Deterministic evidence rules for Deep AI Analysis output.
 *
 * These are deliberately practical, not a natural-language fact checker: they
 * make the statement structure the only place evidence-derived claims can live
 * (numbers must match cited values; periods must be copied from cited items)
 * and reject language that introduces premises the research context does not
 * contain (sentiment labels, external crypto concepts, other assets, invented
 * explanations for unmapped providers).
 */

export type EvidenceItem = {
  id: string;
  type: "token" | "scope" | "fresh" | "obs" | "calc" | "hist" | "point";
  numbers: number[];
  text: string;
  periodLabels: string[];
  requiresPeriod: boolean;
};

export type EvidenceIndex = {
  ids: Set<string>;
  /** Present only when validating against a full research context. */
  context: {
    items: Map<string, EvidenceItem>;
    text: string;
    tokenSymbol: string;
    unmappedProviders: { provider: "DeFiLlama" | "DEX Screener"; scopeId: string }[];
  } | null;
};

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") for (const token of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) out.push(Number(token.replace(/,/g, "")));
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectNumbers(item, out));
}

function item(id: string, type: EvidenceItem["type"], source: unknown, periodLabels: string[] = [], requiresPeriod = false): EvidenceItem {
  const numbers: number[] = [];
  collectNumbers(source, numbers);
  return { id, type, numbers, text: JSON.stringify(source).toLowerCase(), periodLabels, requiresPeriod };
}

/** The item constructor, shared with other evidence sources (the profile payload) so numbers and text are indexed identically. */
export { item as evidenceItem };

/** Build the evidence index for one research context. */
export function buildEvidenceIndex(context: ResearchContext): EvidenceIndex {
  const items = new Map<string, EvidenceItem>();
  items.set("token", item("token", "token", context.token));
  for (const scope of context.scope) items.set(scope.id, item(scope.id, "scope", scope));
  for (const fresh of context.providerFreshness) items.set(fresh.id, item(fresh.id, "fresh", fresh));
  for (const obs of context.observations) {
    items.set(obs.id, item(obs.id, "obs", obs, [obs.window.label], obs.status === "available" && obs.window.kind === "provider_rolling_window"));
  }
  for (const calc of context.calculatedMetrics) {
    const timeBased = calc.period.kind === "interval_between_latest_observations" || calc.period.kind === "aligned_interval";
    items.set(calc.id, item(calc.id, "calc", calc, [calc.period.label], calc.status === "available" && timeBased));
  }
  for (const series of context.history) {
    const labels = [series.summary?.label, ...Object.values(series.coverage).map((coverage) => coverage.coverageLabel)].filter((label): label is string => Boolean(label));
    items.set(series.id, item(series.id, "hist", series, labels, series.points.length >= 2));
    for (const point of series.points) {
      if (!items.has(point.sourceId)) items.set(point.sourceId, item(point.sourceId, "point", { ...point, provider: series.provider, metric: series.metric }));
    }
  }
  const unmappedProviders = context.scope
    .filter((scope) => !scope.mapped && (scope.provider === "DeFiLlama" || scope.provider === "DEX Screener"))
    .map((scope) => ({ provider: scope.provider as "DeFiLlama" | "DEX Screener", scopeId: scope.id }));
  return { ids: new Set(items.keys()), context: { items, text: JSON.stringify(context), tokenSymbol: context.token.symbol, unmappedProviders } };
}

/** Evidence for re-validating a stored analysis: only its cited IDs are known. */
export function storedEvidence(ids: Iterable<string>): EvidenceIndex {
  return { ids: new Set(ids), context: null };
}

// ---- Text rules ----

/** Market-sentiment and trend-prediction language; neutral wording ("increased") is unaffected. */
const DIRECTIONAL_PATTERNS: RegExp[] = [
  /\b(bullish|bearish)\b/i,
  /\bmomentum\b/i,
  /\b(up|down)trend\b/i,
  /\b(rally|rallies|rallied|sell-?off|breakout|overbought|oversold)\b/i,
  /\blikely to (rise|fall|increase|decrease|recover|decline|continue|rebound)\b/i,
  /\b(poised|set) (to|for) (rise|fall|gains?|losses|growth|decline)\b/i,
  /\b(positive|negative|bullish|bearish) (outlook|sentiment|signal)\b/i,
];

/** Every sentiment/trend term in the text (all are reported, not just the first). */
export function findDirectionalLanguage(text: string): string[] {
  return DIRECTIONAL_PATTERNS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

/**
 * External crypto concepts. A concept is rejected only when the research
 * context itself never mentions it (for example, "governance" is allowed for a
 * token whose DeFiLlama relationship names it as a governance token).
 */
const EXTERNAL_CONCEPTS: RegExp[] = [
  /\bblock (subsidy|subsidies|rewards?)\b/i,
  /\bhalving\b/i,
  /\bissuance\b/i,
  /\bemissions?\b/i,
  /\b(mining|miners?)\b/i,
  /\bhash ?rate\b/i,
  /\bproof[- ]of[- ](work|stake)\b/i,
  /\bstaking\b/i,
  /\bvalidators?\b/i,
  /\b(token )?burn(s|ed|ing)?\b/i,
  /\b(unlocks?|vesting)\b/i,
  /\bairdrops?\b/i,
  /\bgovernance\b/i,
  /\btreasury\b/i,
  /\bETFs?\b/,
  /\bregulat(ion|ory|ors?)\b/i,
  /\binstitutional\b/i,
  /\badoption\b/i,
  /\bwhales?\b/i,
  /\bactive addresses\b/i,
  /\bdeveloper activity\b/i,
  /\b(network upgrade|hard fork|mainnet)\b/i,
  /\b(inflation(ary)?|deflation(ary)?)\b/i,
  /\b(store of value|digital gold)\b/i,
  /\b(macro(economic)?|interest rates?)\b/i,
  /\blayer[- ]?2\b/i,
];

export function findExternalConcept(text: string, contextText: string): string | null {
  for (const pattern of EXTERNAL_CONCEPTS) {
    const match = text.match(pattern);
    if (match && !pattern.test(contextText)) return match[0];
  }
  return null;
}

const WRAPPED_ALIASES: RegExp[] = [/\bWETH\b/, /\bstETH\b/i, /\bwstETH\b/i, /\bcbBTC\b/i, /\btBTC\b/, /\bwrapped (bitcoin|btc|ether|eth)\b/i];

/** Another asset named in the text that the context does not name (e.g. WBTC in a Bitcoin report). */
export function findOtherAsset(text: string, contextText: string, tokenSymbol: string): string | null {
  for (const token of canonicalTokens) {
    if (token.symbol === tokenSymbol || token.symbol.length < 3) continue;
    const pattern = new RegExp(`\\b${token.symbol}\\b`);
    if (pattern.test(text) && !pattern.test(contextText)) return token.symbol;
  }
  for (const pattern of WRAPPED_ALIASES) {
    const match = text.match(pattern);
    if (match && !pattern.test(contextText)) return match[0];
  }
  return null;
}

const PROVIDER_TERMS: Record<"DeFiLlama" | "DEX Screener", RegExp> = {
  "DeFiLlama": /\b(defillama|tvl|total value locked|protocol (fees|revenue)|fees|revenue)\b/i,
  "DEX Screener": /\b(dex screener|dex|liquidity|trading pairs?|pairs?)\b/i,
};
const MAPPING_REASON = /\b(mapp(ing|ed)|by design|configured|no (curated|verified))\b/i;
const OTHER_REASON = /\b((with)?in the (last|past)|aligned observations|insufficient (history|observations)|stale|not (been )?refreshed|timed? out|refresh (failed|failure))\b/i;

/** For an unmapped provider, explanations must use the context's reason (no mapping), not an invented one. */
export function findUnmappedExplanationIssue(text: string, unmapped: { provider: "DeFiLlama" | "DEX Screener" }[]): string | null {
  for (const { provider } of unmapped) {
    if (!PROVIDER_TERMS[provider].test(text)) continue;
    const invented = text.match(OTHER_REASON);
    if (invented) return `explains unavailable ${provider} data as "${invented[0]}", but the context's reason is that ${provider} has no mapping for this token`;
    if (!MAPPING_REASON.test(text)) return `refers to ${provider} data without stating the context's reason (no ${provider} mapping for this token)`;
  }
  return null;
}

// ---- Numbers and periods ----

function decimals(token: string): number {
  const dot = token.indexOf(".");
  return dot === -1 ? 0 : token.length - dot - 1;
}

/** Numbers in the text that do not match (within rounding/scale) any value of the cited evidence. */
export function ungroundedNumbers(text: string, cited: EvidenceItem[]): string[] {
  const candidates = cited.flatMap((evidence) => evidence.numbers);
  const scales = [1, 100, 0.01, 1e-3, 1e-6, 1e-9, 1e-12];
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).filter((token) => {
    const value = Number(token.replace(/,/g, ""));
    const tolerance = 0.5 * 10 ** -decimals(token);
    // Text states magnitudes ("decreased by 0.41%"), so compare against absolute values.
    return !candidates.some((candidate) => scales.some((scale) => {
      const scaled = Math.abs(candidate) * scale;
      return Math.abs(value - scaled) <= Math.max(tolerance, Math.abs(scaled) * 0.006);
    }));
  });
}

const NAMED_PERIODS: { pattern: RegExp; evidence: RegExp }[] = [
  { pattern: /\b(24[- ]?hours?|24h|twenty-four[- ]hours?|past day)\b/i, evidence: /24-hour|24 hours|24h/i },
  { pattern: /\b(7[- ]?days?|7d|seven[- ]days?)\b/i, evidence: /7-day|7 days/i },
  { pattern: /\b(30[- ]?days?|30d|thirty[- ]days?)\b/i, evidence: /30-day|30 days|30d/i },
  { pattern: /\b(90[- ]?days?|90d|ninety[- ]days?)\b/i, evidence: /90-day|90 days|90d/i },
  { pattern: /\bweekly\b/i, evidence: /weekly/i },
  { pattern: /\bmonthly\b/i, evidence: /monthly/i },
  { pattern: /\b(yearly|annual(ly|ized)?|year-over-year)\b/i, evidence: /yearly|annual/i },
];

/** A named period in the text that none of the cited items' own labels/windows establish. */
export function findUnsupportedNamedPeriod(text: string, cited: EvidenceItem[]): string | null {
  // Period labels carry a disclaimer naming 24-hour/7-day/30-day periods they are NOT; it must not count as support.
  const citedText = cited.map((evidence) => evidence.text).join(" ").replace(/it is not a fixed [^.]*\./g, "");
  for (const { pattern, evidence } of NAMED_PERIODS) {
    const match = text.match(pattern);
    if (match && !evidence.test(citedText)) return match[0];
  }
  return null;
}

export function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0).length;
}
