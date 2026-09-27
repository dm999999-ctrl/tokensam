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
import { MAX_FINDINGS_PER_SECTION } from "./thresholds.ts";

/** Bumped whenever the analytical rules (findings.ts/thresholds.ts) change in a way that could change output. */
export const ENGINE_VERSION = "1";
/** Bumped whenever the report structure/narrative composition (narrative.ts/report.ts) changes. */
export const ANALYSIS_VERSION = "1";

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

const SECTION_LABEL: Record<SectionKey, string> = {
  executiveSummary: "an overall snapshot",
  marketPerformance: "market performance",
  fundamentalPerformance: "fundamental and protocol activity",
  valuation: "valuation",
  marketFundamentalRelationships: "market and fundamental relationships",
  liquidityMarketStructure: "liquidity and market structure",
  tokenomics: "tokenomics",
};

type RawSection = { overview: string; statements: ReturnType<typeof statementForFinding>[] };
type RawReport = Record<SectionKey, RawSection> & {
  risks: ReturnType<typeof riskItem>[];
  dataGaps: ReturnType<typeof dataGapItem>[];
  furtherResearchQuestions: ReturnType<typeof furtherResearchQuestions>;
};

/** Deterministically build the raw (pre-validation) report from a set of extracted findings. */
function buildRawReport(payload: ProfilePayload, findings: Finding[]): RawReport {
  const byCategory = new Map<FindingCategory, Finding[]>();
  for (const finding of findings) byCategory.set(finding.category, [...(byCategory.get(finding.category) ?? []), finding]);

  const sections = {} as Record<SectionKey, RawSection>;
  for (const [category, sectionKey] of Object.entries(CATEGORY_TO_SECTION) as [FindingCategory, SectionKey][]) {
    const capped = topFindings(byCategory.get(category) ?? [], MAX_FINDINGS_PER_SECTION);
    sections[sectionKey] = { overview: sectionOverview(SECTION_LABEL[sectionKey], capped), statements: capped.map(statementForFinding) };
  }

  // Executive summary: the highest-priority findings across every analytical category (never
  // dataQuality — data gaps have their own section), restated with the same statement builders.
  const analytical = findings.filter((finding) => finding.category !== "dataQuality" && finding.category !== "risk");
  const headline = topFindings(analytical, 4);
  const categoriesCovered = new Set(analytical.map((finding) => finding.category)).size;
  sections.executiveSummary = {
    overview: executiveOverview(analytical.length, categoriesCovered),
    statements: headline.map(statementForFinding),
  };

  const risks = topFindings(byCategory.get("risk") ?? [], MAX_FINDINGS_PER_SECTION).map(riskItem);
  const dataGaps = topFindings(byCategory.get("dataQuality") ?? [], MAX_FINDINGS_PER_SECTION * 2).map(dataGapItem);

  return { ...sections, risks, dataGaps, furtherResearchQuestions: furtherResearchQuestions(findings) };
}

export type EngineReport = {
  analysis: ModelAnalysis;
  findingCount: number;
  dataSnapshotAt: string | null;
  sources: Record<string, string>;
  counters: { droppedSourceIds: number; untraceableFactualStatements: number };
  warnings: string[];
};

/**
 * Build and validate a full Deep Analysis Engine report from a profile payload. Pure and
 * deterministic: the same payload always yields the same report; a different payload (a later
 * snapshot, a different token) yields different findings and therefore different text. Throws
 * AnalysisValidationError if the assembled report somehow fails the evidence contract — that would
 * be a bug in this module, since every fact here is grounded by construction.
 */
export function buildEngineReport(payload: ProfilePayload): EngineReport {
  const findings = extractFindings(payload);
  const raw = buildRawReport(payload, findings);
  const evidence = buildProfileEvidenceIndex(payload);
  const { analysis, counters, warnings } = validateModelAnalysis(raw, evidence);
  const sources = profileSourceLabels(payload, analysis);
  return { analysis, findingCount: findings.length, dataSnapshotAt: payload.dataAsOf, sources, counters, warnings };
}
