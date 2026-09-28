/**
 * Deep Analysis Engine — report assembly. Runs the finding extractors (findings.ts), prioritizes
 * and caps findings per section, composes narrative text (narrative.ts), and assembles the result
 * into exactly the shape the existing evidence validator (../schema.ts) accepts — the same
 * `ModelAnalysis` shape previously produced by an AI provider. The assembled report is then run
 * through that unmodified validator as a safety net: grounding here is true by construction (every
 * number/period a template writes is copied from the same field it cites), but re-validating means
 * a bug in this module fails loudly instead of silently shipping an ungrounded report.
 */

import type { ProfilePayload } from "../profile-payload.ts";
import { buildProfileEvidenceIndex, profileSourceLabels } from "../profile-evidence-index.ts";
import { validateModelAnalysis, type ModelAnalysis, type SectionKey } from "../schema.ts";
import { extractFindings, type Finding, type FindingCategory } from "./findings.ts";
import {
  dataGapItem, executiveOverview, furtherResearchQuestions, riskItem, sectionOverview, statementForFinding,
} from "./narrative.ts";
import { synthesize, type SynthesisResult } from "./synthesis.ts";
import { MAX_FINDINGS_PER_SECTION } from "./thresholds.ts";

/** Bumped whenever the analytical rules (findings.ts/thresholds.ts) change in a way that could change output. */
export const ENGINE_VERSION = "3";
/** Bumped whenever the report structure/narrative composition (narrative.ts/report.ts) changes. */
export const ANALYSIS_VERSION = "3";

const SEVERITY_WEIGHT = { high: 3, moderate: 2, low: 1 } as const;

/**
 * Deterministic finding priority: severity first, then magnitude (when the finding carries a raw
 * number), then how many observations support it. Never randomized, never an overall "score"
 * exposed to the user — only used to order and cap findings within a section.
 */
function priority(finding: Finding): number {
  let score = SEVERITY_WEIGHT[finding.severity] * 1000;
  const raw = finding.data.raw;
  if (typeof raw === "number" && Number.isFinite(raw)) score += Math.min(Math.abs(raw), 500);
  if (finding.horizons) score += Math.min(finding.horizons.length * 25, 100); // multi-horizon findings synthesize more evidence
  score += finding.evidenceIds.length;
  return score;
}

function topFindings(findings: Finding[], max: number): Finding[] {
  return [...findings].sort((a, b) => priority(b) - priority(a)).slice(0, max);
}

const CATEGORY_TO_SECTION: Partial<Record<FindingCategory, SectionKey>> = {
  marketPerformance: "marketPerformance",
  fundamentalPerformance: "fundamentalPerformance",
  valuation: "valuation",
  marketFundamentalRelationships: "marketFundamentalRelationships",
  liquidityMarketStructure: "liquidityMarketStructure",
  tokenomics: "tokenomics",
};

type RawSection = { overview: string; statements: ReturnType<typeof statementForFinding>[] };
type RawReport = Record<SectionKey, RawSection> & {
  risks: ReturnType<typeof riskItem>[];
  dataGaps: ReturnType<typeof dataGapItem>[];
  furtherResearchQuestions: ReturnType<typeof furtherResearchQuestions>;
};

/** Deterministically build the raw (pre-validation) report from a set of extracted findings. */
function buildRawReport(payload: ProfilePayload, findings: Finding[], synthesis: SynthesisResult): RawReport {
  const byCategory = new Map<FindingCategory, Finding[]>();
  for (const finding of findings) byCategory.set(finding.category, [...(byCategory.get(finding.category) ?? []), finding]);

  const fundamentalsMapped = payload.scope.find((note) => note.id === "scope:defillama")?.mapped ?? false;

  const sections = {} as Record<SectionKey, RawSection>;
  for (const [category, sectionKey] of Object.entries(CATEGORY_TO_SECTION) as [FindingCategory, SectionKey][]) {
    const capped = topFindings(byCategory.get(category) ?? [], MAX_FINDINGS_PER_SECTION);
    const overview = capped.length > 0 ? sectionOverview(sectionKey, capped, {}) : sectionOverview(sectionKey, capped, { fundamentalsMapped });
    sections[sectionKey] = { overview, statements: capped.map((finding) => statementForFinding(finding, "detail")) };
  }

  // Executive summary: the highest-priority findings across every analytical category (never
  // dataQuality/risk — those have their own sections), restated through the *summary* composer so
  // the same evidence produces a different, higher-level sentence than its section detail. Bare
  // fact restatements (a single supply figure, a single ratio quote) are excluded from headline
  // eligibility — they belong in their section, not in "the most significant findings" synthesis —
  // unless nothing more substantive is available, in which case they are the best evidence there is.
  const analytical = findings.filter((finding) => finding.category !== "dataQuality" && finding.category !== "risk");
  const isBareFact = (finding: Finding) => /^supply_(circulating_supply|total_supply|maximum_supply)$/.test(finding.findingType) || finding.findingType.startsWith("structure_");
  const substantive = analytical.filter((finding) => !isBareFact(finding));
  const headline = topFindings(substantive.length > 0 ? substantive : analytical, 4);
  const categoriesCovered = new Set(analytical.map((finding) => finding.category)).size;
  sections.executiveSummary = {
    overview: executiveOverview(headline, analytical.length, categoriesCovered),
    statements: headline.map((finding) => statementForFinding(finding, "summary")),
  };

  const risks = topFindings(byCategory.get("risk") ?? [], MAX_FINDINGS_PER_SECTION).map(riskItem);
  const dataGaps = topFindings(byCategory.get("dataQuality") ?? [], MAX_FINDINGS_PER_SECTION * 2).map(dataGapItem);

  return { ...sections, risks, dataGaps, furtherResearchQuestions: furtherResearchQuestions(findings, synthesis.thesisDrivers) };
}

export type EngineReport = {
  analysis: ModelAnalysis;
  findingCount: number;
  dataSnapshotAt: string | null;
  sources: Record<string, string>;
  counters: { droppedSourceIds: number; untraceableFactualStatements: number };
  warnings: string[];
  /**
   * Phase 1 of the research-report redesign (see engine/synthesis.ts): the deterministic
   * relationship/materiality/thesis-driver analysis computed from this same finding set. As of the
   * Phase 1 calibration pass, `buildRawReport` consumes only `synthesis.thesisDrivers` — and only to
   * decide which Further Research Questions are warranted (see narrative.ts's
   * `furtherResearchQuestions`), never to rewrite Executive Assessment/section prose. The full
   * narrative rewrite driven by relationships/materiality is still Phase 2. Exposed here in full so
   * the synthesis layer remains independently testable/inspectable beyond that one integration point.
   */
  synthesis: SynthesisResult;
};

/**
 * Build and validate a full Deep Analysis Engine report from a profile payload. Pure and
 * deterministic: the same payload always yields the same report; a different payload (a later
 * snapshot, a different token) yields different findings and therefore different text. Throws
 * AnalysisValidationError if the assembled report somehow fails the evidence contract — that would
 * be a bug in this module, since every fact here is grounded by construction. Every narrative
 * composer call is routed through a non-throwing fallback (see narrative.ts's `genericStatement`),
 * so an unrecognized finding type can never surface as a generation failure.
 */
export function buildEngineReport(payload: ProfilePayload): EngineReport {
  const findings = extractFindings(payload);
  const synthesis = synthesize(findings);
  const raw = buildRawReport(payload, findings, synthesis);
  const evidence = buildProfileEvidenceIndex(payload);
  const { analysis, counters, warnings } = validateModelAnalysis(raw, evidence);
  const sources = profileSourceLabels(payload, analysis);
  return { analysis, findingCount: findings.length, dataSnapshotAt: payload.dataAsOf, sources, counters, warnings, synthesis };
}
