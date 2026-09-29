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
import { extractFindings } from "./findings.ts";
import { buildNarrative } from "./narrative.ts";
import { ENGINE_SECTION_KEYS, validateEngineAnalysis, type EngineAnalysis } from "./report-schema.ts";
import { synthesize, type SynthesisResult } from "./synthesis.ts";

/** Bumped whenever the analytical rules (findings.ts/thresholds.ts) change in a way that could change output. */
export const ENGINE_VERSION = "4";
/** Bumped whenever the report structure/narrative composition (narrative.ts/report.ts) changes. */
export const ANALYSIS_VERSION = "4";

export type EngineReport = {
  analysis: EngineAnalysis;
  findingCount: number;
  dataSnapshotAt: string | null;
  sources: Record<string, string>;
  counters: { droppedSourceIds: number; untraceableFactualStatements: number };
  warnings: string[];
  /** The deterministic relationship/materiality/thesis-driver analysis that the narrative above was composed from. Exposed for independent testing/inspection. */
  synthesis: SynthesisResult;
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
  const { analysis, counters, warnings } = validateEngineAnalysis(raw, evidence);
  const sources = profileSourceLabels(payload, analysis);
  return { analysis, findingCount: findings.length, dataSnapshotAt: payload.dataAsOf, sources, counters, warnings, synthesis };
}
