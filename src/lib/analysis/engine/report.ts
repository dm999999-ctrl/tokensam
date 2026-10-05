/**
 * Deep Analysis Engine — report assembly (Phase 2: institutional-research report structure). Runs
 * the finding extractors (findings.ts), the deterministic synthesis layer (synthesis.ts), and the
 * paragraph-composition narrative engine (narrative.ts), then assembles the result into exactly the
 * shape report-schema.ts's evidence validator accepts. The assembled report is then run through that
 * validator as a safety net: grounding here is true by construction (every number/period a composer
 * writes is copied from the same finding/relationship it cites), but re-validating means a bug in
 * this module fails loudly instead of silently shipping an ungrounded report.
 */

import type { ProfilePayload } from "../profile-payload.ts";
import { buildProfileEvidenceIndex, profileSourceLabels } from "../profile-evidence-index.ts";
import type { Finding } from "./findings.ts";
import { extractFindings } from "./findings.ts";
import { buildNarrative } from "./narrative.ts";
import { ENGINE_SECTION_KEYS, validateEngineAnalysis, type AnalyticalType, type Confidence, type EngineAnalysis, type EngineSectionKey } from "./report-schema.ts";
import { synthesize, type SynthesisResult, type ThesisDriver } from "./synthesis.ts";

/** Bumped whenever the analytical rules (findings.ts/thresholds.ts) change in a way that could change output. */
export const ENGINE_VERSION = "4";
/** Bumped whenever the report structure/narrative composition (narrative.ts/report.ts) changes. */
export const ANALYSIS_VERSION = "5";

/**
 * The report's single most prominent price pattern, read directly off the same multi-horizon
 * momentum finding Market Performance and Executive Assessment already cite (findings.ts's
 * "multi_horizon_*" findingType) — never a separate judgment, just a short label for the header.
 * "insufficient" when no price-change window has enough history to classify one.
 */
export type MarketRegime = "positive" | "negative" | "mixed" | "flat" | "insufficient";

function classifyRegime(findings: Finding[]): MarketRegime {
  const momentum = findings.find((finding) => finding.category === "marketPerformance" && finding.findingType.startsWith("multi_horizon_"));
  if (!momentum) return "insufficient";
  const pattern = momentum.findingType.replace("multi_horizon_", "");
  if (pattern === "flat") return "flat";
  if (pattern.includes("_up") || pattern === "single_up" || pattern === "reversal_to_up") return "positive";
  if (pattern.includes("_down") || pattern === "single_down" || pattern === "reversal_to_down") return "negative";
  return "mixed"; // "mixed" itself
}

/**
 * Confidence for a thesis driver, from the same persistence/completeness/materiality numbers
 * synthesis.ts already computed for it — never a separate score. "low" when its horizons actively
 * disagree or a relevant data gap limits it; "high" only when the signal is both persistent and
 * complete and clears a real materiality bar; "moderate" otherwise (the common case: a single,
 * unconflicted, reasonably-evidenced signal).
 */
function driverConfidence(driver: ThesisDriver | undefined): Confidence {
  if (!driver) return "moderate";
  if (driver.persistence === "conflicting" || driver.completeness === "limited") return "low";
  if (driver.persistence === "persistent" && driver.completeness === "complete" && driver.materiality.total >= 10) return "high";
  return "moderate";
}

/** Sections whose paragraphs synthesize across categories/findings rather than stating one metric directly. */
const INTERPRETIVE_SECTIONS = new Set<EngineSectionKey>(["executiveAssessment", "crossDomainAnalysis", "keyRisks", "finalConclusion"]);

function isPlaceholder(paragraph: { sourceIds: string[] }): boolean {
  return paragraph.sourceIds.length === 1 && paragraph.sourceIds[0] === "token";
}

/**
 * Attaches `confidence`/`analyticalType` to every paragraph after validation, purely from
 * already-computed structural facts (which section composed it, whether it carries real evidence
 * or is the section's own "not enough data" fallback, and the top thesis driver's own confidence
 * for the interpretive sections) — never from the paragraph's own wording, and never a new
 * calculation. dataQualityLimitations is special-cased: a data gap is itself a directly observed,
 * high-confidence fact, not an uncertain one, even though its paragraph's own evidence is often the
 * "token" placeholder when there is nothing to report.
 */
function classifyParagraphs(analysis: EngineAnalysis, topDriverConfidence: Confidence): EngineAnalysis {
  const next = { ...analysis };
  for (const key of ENGINE_SECTION_KEYS) {
    const isDataQuality = key === "dataQualityLimitations";
    const sectionType: AnalyticalType = isDataQuality ? "limitation" : INTERPRETIVE_SECTIONS.has(key) ? "interpretation" : "observation";
    next[key] = {
      paragraphs: next[key].paragraphs.map((paragraph) => ({
        ...paragraph,
        analyticalType: !isDataQuality && isPlaceholder(paragraph) ? "limitation" : sectionType,
        confidence: isDataQuality ? "high" : isPlaceholder(paragraph) ? "low" : INTERPRETIVE_SECTIONS.has(key) ? topDriverConfidence : "moderate",
      })),
    };
  }
  return next;
}

export type EngineReport = {
  analysis: EngineAnalysis;
  findingCount: number;
  dataSnapshotAt: string | null;
  sources: Record<string, string>;
  counters: { droppedSourceIds: number; untraceableFactualStatements: number };
  warnings: string[];
  /** The deterministic relationship/materiality/thesis-driver analysis that the narrative above was composed from. Exposed for independent testing/inspection. */
  synthesis: SynthesisResult;
  regime: MarketRegime;
  regimeConfidence: Confidence;
};

/**
 * Build and validate a full Deep Analysis Engine report from a profile payload. Pure and
 * deterministic: the same payload always yields the same report; a different payload (a later
 * snapshot, a different token) yields different findings and therefore different text. Throws
 * AnalysisValidationError if the assembled report somehow fails the evidence contract — that would
 * be a bug in this module, since every fact here is grounded by construction. Every narrative
 * composer call is routed through a non-throwing fallback (see narrative.ts's per-section
 * fallback paragraphs), so an unrecognized finding shape can never surface as a generation failure.
 */
export function buildEngineReport(payload: ProfilePayload): EngineReport {
  const findings = extractFindings(payload);
  const synthesis = synthesize(findings);
  const fundamentalsMapped = payload.scope.find((note) => note.id === "scope:defillama")?.mapped ?? false;
  const narrative = buildNarrative(findings, synthesis, fundamentalsMapped);

  const raw: Record<string, unknown> = { furtherResearchQuestions: narrative.furtherResearchQuestions };
  for (const key of ENGINE_SECTION_KEYS) raw[key] = { paragraphs: narrative[key] };

  const evidence = buildProfileEvidenceIndex(payload);
  const { analysis: validated, counters, warnings } = validateEngineAnalysis(raw, evidence);
  const regimeConfidence = driverConfidence(synthesis.thesisDrivers[0]);
  const analysis = classifyParagraphs(validated, regimeConfidence);
  const sources = profileSourceLabels(payload, analysis);
  return { analysis, findingCount: findings.length, dataSnapshotAt: payload.dataAsOf, sources, counters, warnings, synthesis, regime: classifyRegime(findings), regimeConfidence };
}
