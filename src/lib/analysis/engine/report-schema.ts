/**
 * Deep Analysis Engine — the institutional-research report shape (Phase 2 of the research-report
 * redesign). This is a separate, purpose-built contract for the deterministic engine's own output —
 * it does NOT reuse ../schema.ts's `SECTION_KEYS`/`ModelAnalysis`/`ANALYSIS_RESPONSE_SCHEMA`, which
 * remain exactly as they were for the legacy (now unused-in-production, still-tested) AI-provider
 * path. Reusing that fixed seven-section, one-fact-per-statement shape would have forced either
 * breaking ~150 legacy-path tests for a schema the live app no longer calls, or bending the new
 * eleven-section flowing-paragraph report into a shape it was never designed for. Instead this
 * module defines its own section set and reuses only the underlying, shape-independent evidence
 * primitives from evidence-rules.ts (grounding, language rules) — evidence discipline is identical
 * or stricter than the legacy contract, never weaker.
 *
 * A paragraph here is not "one finding, one sentence" (the old narrative.ts's unit) but a synthetic,
 * multi-finding analytical statement — the report's whole point is combining evidence across
 * domains, so a paragraph's `sourceIds` typically span several findings' evidence at once. Every
 * number and every named period (24h/7d/30d/90d/etc.) the text states must still be grounded in one
 * of those cited sources — the same rule the old per-finding statements followed, just applied to
 * richer text.
 */

import { AnalysisValidationError, findProhibitedLanguage, type AnalysisMetadata } from "../schema.ts";
import {
  findAnalyticalLanguage, findCausalLanguage, findDirectionalLanguage, findExternalConcept,
  findLeakedEvidenceMarker, findOtherAsset, findUnsupportedNamedPeriod, storedEvidence, ungroundedNumbers,
  type EvidenceIndex, type EvidenceItem,
} from "../evidence-rules.ts";

export const ENGINE_SECTION_KEYS = [
  "executiveAssessment", "marketPerformance", "technicalAnalysis", "fundamentalAnalysis",
  "valuationAnalysis", "marketStructureLiquidity", "tokenomicsSupply", "crossDomainAnalysis",
  "keyRisks", "dataQualityLimitations", "finalConclusion",
] as const;
export type EngineSectionKey = (typeof ENGINE_SECTION_KEYS)[number];

export const ENGINE_SECTION_TITLES: Record<EngineSectionKey, string> = {
  executiveAssessment: "Executive Investment Assessment",
  marketPerformance: "Market Performance & Regime",
  technicalAnalysis: "Technical Analysis",
  fundamentalAnalysis: "Fundamental Analysis",
  valuationAnalysis: "Valuation Analysis",
  marketStructureLiquidity: "Market Structure & Liquidity",
  tokenomicsSupply: "Tokenomics & Supply",
  crossDomainAnalysis: "Cross-Domain Analysis",
  keyRisks: "Key Investment Risks",
  dataQualityLimitations: "Data Quality & Analytical Limitations",
  finalConclusion: "Final Analytical Conclusion",
};

/**
 * How much analytical weight a paragraph's own conclusion should carry — derived in report.ts from
 * the same already-computed synthesis.ts materiality/persistence/completeness signals (or, for the
 * data-quality section, from the fact that a data gap is itself a directly observed condition, not
 * an uncertain one). Never hand-set per paragraph inside narrative.ts and never invented: see
 * `classifyParagraphs` in report.ts for the exact, fully deterministic derivation.
 */
export type Confidence = "high" | "moderate" | "low";

/**
 * What kind of analytical statement a paragraph is making, per the research-report redesign brief's
 * requirement to distinguish observation / interpretation / inference / limitation. Derived
 * structurally in report.ts from which section composed the paragraph (e.g. Cross-Domain Analysis
 * paragraphs synthesize across categories and are "interpretation"; a plain Market Performance
 * figure is "observation") — not inferred from the paragraph's own wording, which would be fragile
 * and could silently drift from what narrative.ts actually writes.
 */
export type AnalyticalType = "observation" | "interpretation" | "inference" | "limitation";

export type EngineParagraph = { text: string; sourceIds: string[]; confidence?: Confidence; analyticalType?: AnalyticalType };
export type EngineSection = { paragraphs: EngineParagraph[] };
export type ResearchQuestion = { question: string; rationale: string; sourceIds: string[] };

export type EngineAnalysis = Record<EngineSectionKey, EngineSection> & {
  furtherResearchQuestions: ResearchQuestion[];
};
export type EngineTokenAnalysis = EngineAnalysis & { metadata: AnalysisMetadata };

const MAX_TEXT = 2000;
const MAX_PARAGRAPHS_PER_SECTION = 6;
const MAX_SOURCE_IDS = 20;
const MAX_QUESTIONS = 6;

type Counters = { droppedSourceIds: number; untraceableFactualStatements: number };
type Check = { evidence: EvidenceIndex; violations: string[]; warnings: string[]; counters: Counters };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new AnalysisValidationError(`${path} must be an array.`);
  return value.slice(0, max);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new AnalysisValidationError(`${path} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AnalysisValidationError(`${path} must not be empty.`);
  if (trimmed.length > MAX_TEXT) throw new AnalysisValidationError(`${path} exceeds ${MAX_TEXT} characters.`);
  const prohibited = findProhibitedLanguage(trimmed);
  if (prohibited) throw new AnalysisValidationError(`${path} contains investment-advice or prediction language ("${prohibited}").`);
  return trimmed;
}

function citedItems(ids: string[], check: Check): EvidenceItem[] {
  const items = check.evidence.context?.items;
  return items ? ids.map((id) => items.get(id)).filter((item): item is EvidenceItem => Boolean(item)) : [];
}

function sourceIds(value: unknown, path: string, check: Check): string[] {
  const ids = list(value, path, MAX_SOURCE_IDS);
  const kept: string[] = [];
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && check.evidence.ids.has(trimmed)) {
      if (!kept.includes(trimmed)) kept.push(trimmed);
    } else {
      check.counters.droppedSourceIds += 1;
      check.violations.push(`${path}: unknown source ID ${JSON.stringify(id)}.`);
    }
  }
  return kept;
}

/** Same language/grounding discipline the legacy contract enforces — see ../schema.ts's `languageRules`/`groundingRules`. */
function checkParagraphText(value: string, path: string, ids: string[], check: Check): void {
  const marker = findLeakedEvidenceMarker(value);
  if (marker) check.violations.push(`${path}: contains the internal evidence marker "${marker}"; cite it in sourceIds instead of writing it in the text.`);
  for (const directional of findDirectionalLanguage(value)) check.violations.push(`${path}: directional/sentiment language ("${directional}"); describe observed conditions neutrally.`);
  for (const causal of findCausalLanguage(value)) check.violations.push(`${path}: causal language ("${causal}"); the evidence is observational and never establishes that one factor caused another.`);
  for (const analytical of findAnalyticalLanguage(value)) check.warnings.push(`${path}: analytical language ("${analytical}") — only a warning while the underlying claim is otherwise grounded.`);

  const context = check.evidence.context;
  const cited = citedItems(ids, check);
  if (context) {
    const concept = findExternalConcept(value, context.text);
    if (concept) check.violations.push(`${path}: introduces "${concept}", which the research context does not contain.`);
    const asset = findOtherAsset(value, context.text, context.tokenSymbol);
    if (asset) check.violations.push(`${path}: refers to ${asset}, a distinct asset the research context does not establish for this token.`);

    const ungrounded = ungroundedNumbers(value, cited);
    if (ungrounded.length) check.violations.push(`${path}: number(s) ${ungrounded.join(", ")} do not match any value in the cited sources.`);
    const period = findUnsupportedNamedPeriod(value, cited);
    if (period) check.violations.push(`${path}: "${period}" is not a period established by the cited sources.`);
  }
}

const VALID_CONFIDENCE = new Set<Confidence>(["high", "moderate", "low"]);
const VALID_ANALYTICAL_TYPE = new Set<AnalyticalType>(["observation", "interpretation", "inference", "limitation"]);

function paragraph(value: unknown, path: string, check: Check): EngineParagraph {
  if (!isRecord(value)) throw new AnalysisValidationError(`${path} must be an object.`);
  const paragraphText = text(value.text, `${path}.text`);
  const ids = sourceIds(value.sourceIds, `${path}.sourceIds`, check);
  if (ids.length === 0) {
    check.counters.untraceableFactualStatements += 1;
    check.violations.push(`${path}: must cite at least one source.`);
  }
  checkParagraphText(paragraphText, `${path}.text`, ids, check);
  // confidence/analyticalType are server-derived classification labels (see report.ts's
  // classifyParagraphs), never free text from narrative.ts -- passed through as-is (when present
  // and one of the fixed enum values) so re-validating a stored report (parseStoredEngineAnalysis)
  // doesn't silently drop them. Absent on reports generated before this field existed.
  const confidence = typeof value.confidence === "string" && VALID_CONFIDENCE.has(value.confidence as Confidence) ? (value.confidence as Confidence) : undefined;
  const analyticalType = typeof value.analyticalType === "string" && VALID_ANALYTICAL_TYPE.has(value.analyticalType as AnalyticalType) ? (value.analyticalType as AnalyticalType) : undefined;
  return { text: paragraphText, sourceIds: ids, ...(confidence ? { confidence } : {}), ...(analyticalType ? { analyticalType } : {}) };
}

function section(value: unknown, path: string, check: Check): EngineSection {
  if (!isRecord(value)) throw new AnalysisValidationError(`${path} must be an object.`);
  const paragraphs = list(value.paragraphs, `${path}.paragraphs`, MAX_PARAGRAPHS_PER_SECTION).map((item, index) => paragraph(item, `${path}.paragraphs[${index}]`, check));
  return { paragraphs };
}

/**
 * Validate a raw engine-built report against the evidence index. Throws AnalysisValidationError
 * listing every violation — grounding here is true by construction (every paragraph is composed
 * from findings whose own evidence IDs are used), so a thrown violation indicates a bug in the
 * narrative composer, not bad input data.
 */
export function validateEngineAnalysis(raw: unknown, evidence: EvidenceIndex): { analysis: EngineAnalysis; counters: Counters; warnings: string[] } {
  if (!isRecord(raw)) throw new AnalysisValidationError("The response must be a JSON object.");
  const check: Check = { evidence, violations: [], warnings: [], counters: { droppedSourceIds: 0, untraceableFactualStatements: 0 } };
  const sections = Object.fromEntries(ENGINE_SECTION_KEYS.map((key) => [key, section(raw[key], key, check)])) as Record<EngineSectionKey, EngineSection>;

  const furtherResearchQuestions = list(raw.furtherResearchQuestions, "furtherResearchQuestions", MAX_QUESTIONS).map((item, index) => {
    const path = `furtherResearchQuestions[${index}]`;
    if (!isRecord(item)) throw new AnalysisValidationError(`${path} must be an object.`);
    const question = { question: text(item.question, `${path}.question`), rationale: text(item.rationale, `${path}.rationale`), sourceIds: sourceIds(item.sourceIds, `${path}.sourceIds`, check) };
    for (const [field, value] of [["question", question.question], ["rationale", question.rationale]] as const) checkParagraphText(value, `${path}.${field}`, question.sourceIds, check);
    return question;
  });

  if (check.violations.length > 0) {
    const error = new AnalysisValidationError(`The report violates the evidence contract (${check.violations.length} issue(s)): ${check.violations.slice(0, 6).join(" ")}`, check.violations);
    error.warnings = check.warnings;
    throw error;
  }
  return { analysis: { ...sections, furtherResearchQuestions }, counters: check.counters, warnings: check.warnings };
}

/** Re-validate a stored engine report before rendering it (stored JSON is still untrusted). */
export function parseStoredEngineAnalysis(raw: unknown): EngineTokenAnalysis | null {
  if (!isRecord(raw) || !isRecord(raw.metadata) || !isRecord(raw.metadata.sources)) return null;
  const metadata = raw.metadata as unknown as AnalysisMetadata;
  try {
    const { analysis } = validateEngineAnalysis(raw, storedEvidence(Object.keys(metadata.sources)));
    return { ...analysis, metadata };
  } catch {
    return null;
  }
}
