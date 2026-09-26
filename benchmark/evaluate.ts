/**
 * Benchmark evaluation of one model response: JSON-schema conformance, the
 * EXISTING Token Samurai evidence validator (unchanged), violation categories,
 * and section presence. Factual pass/fail and counts only; no scores.
 */

import { buildEvidenceIndex } from "../src/lib/analysis/evidence-rules.ts";
import type { ResearchContext } from "../src/lib/analysis/research-context.ts";
import { AnalysisValidationError, SECTION_KEYS, validateModelAnalysis } from "../src/lib/analysis/schema.ts";

import { schemaErrors, type JsonSchema } from "../src/lib/analysis/ai/json-schema.ts";

export { schemaErrors };

/** Validator messages grouped by rule. The current validator has no dedicated token/protocol scope rule. */
export const VIOLATION_CATEGORIES: { category: string; pattern: RegExp }[] = [
  { category: "advice_prediction", pattern: /investment-advice or prediction language/ },
  { category: "period", pattern: /\bperiod\b|names a period/ },
  { category: "number_grounding", pattern: /do not match any value|contains numbers or dates/ },
  { category: "missing_citation", pattern: /must cite|unknown source ID|without citing their sources/ },
  { category: "unmapped_reason", pattern: /context's reason|explains unavailable/ },
  { category: "external_concept", pattern: /introduces "/ },
  { category: "asset_substitution", pattern: /distinct asset/ },
  { category: "sentiment", pattern: /directional\/sentiment language/ },
  { category: "overview_length", pattern: /longer than \d+ sentences|one-sentence note/ },
  { category: "structure", pattern: /must be (?:a|an|one of)|must not be empty|exceeds \d+ characters|must be a JSON object/ },
];

export function categorize(violation: string): string {
  return VIOLATION_CATEGORIES.find(({ pattern }) => pattern.test(violation))?.category ?? "other";
}

const LIST_SECTIONS = ["risks", "dataGaps", "furtherResearchQuestions"] as const;

/** Sections A–J that are present with the expected shape. */
export function sectionsPresent(value: unknown): { present: number; total: number; missing: string[] } {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const missing: string[] = [];
  for (const key of SECTION_KEYS) {
    const section = record[key];
    const ok = typeof section === "object" && section !== null && typeof (section as Record<string, unknown>).overview === "string" && Array.isArray((section as Record<string, unknown>).statements);
    if (!ok) missing.push(key);
  }
  for (const key of LIST_SECTIONS) if (!Array.isArray(record[key])) missing.push(key);
  const total = SECTION_KEYS.length + LIST_SECTIONS.length;
  return { present: total - missing.length, total, missing };
}

export type Evaluation = {
  jsonParsed: boolean;
  structuredOutputValid: boolean;
  schemaErrors: string[];
  validationPassed: boolean;
  validationViolationCount: number | null;
  validationViolationTypes: Record<string, number>;
  sectionsPresent: string;
  missingSections: string[];
  statementCount: number | null;
};

/** Evaluate raw model text. No repair: fenced or otherwise wrapped JSON counts as unparsed. */
export function evaluateOutput(content: string, context: ResearchContext, responseSchema: unknown): Evaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { jsonParsed: false, structuredOutputValid: false, schemaErrors: ["response is not valid JSON"], validationPassed: false, validationViolationCount: null, validationViolationTypes: {}, sectionsPresent: "0/10", missingSections: [], statementCount: null };
  }
  const errors = schemaErrors(parsed, responseSchema as JsonSchema);
  const sections = sectionsPresent(parsed);
  const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, { statements?: unknown }> : {};
  const statementCount = SECTION_KEYS.reduce((sum, key) => sum + (Array.isArray(record[key]?.statements) ? (record[key].statements as unknown[]).length : 0), 0);
  let violations: string[] = [];
  try {
    validateModelAnalysis(parsed, buildEvidenceIndex(context));
  } catch (error) {
    if (!(error instanceof AnalysisValidationError)) throw error;
    violations = error.violations;
  }
  const types: Record<string, number> = {};
  for (const violation of violations) {
    const category = categorize(violation);
    types[category] = (types[category] ?? 0) + 1;
  }
  return {
    jsonParsed: true,
    structuredOutputValid: errors.length === 0,
    schemaErrors: errors,
    validationPassed: violations.length === 0,
    validationViolationCount: violations.length,
    validationViolationTypes: types,
    sectionsPresent: `${sections.present}/${sections.total}`,
    missingSections: sections.missing,
    statementCount,
  };
}
