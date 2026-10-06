// Deep AI Analysis renderer (src/components/DeepAnalysisPanel.tsx). Originally this covered the
// Sources-chip component (raw evidence IDs must never leak as visible text, must stay reachable via
// a title tooltip, and every section must route through one shared renderer). The research-report
// redesign replaced inline per-paragraph evidence chips with automatic numbered footnotes (see
// src/lib/analysis/footnotes.ts): citations now render as small superscript numbers linking to a
// Footnotes section, with the full evidence (including raw IDs, intentionally) available in the
// separate, collapsed Evidence & Methodology section. These tests cover the same underlying
// guarantee -- no raw internal evidence ID ever leaks into the primary report body as visible text,
// and citation rendering is still a single shared code path applied report-wide -- against the new
// footnote architecture. This reads the component's source (matching this repo's established
// pattern for JSX assertions — see tests/market-overview.test.mjs) rather than mounting a renderer,
// since no JSX render harness exists in this test suite.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/DeepAnalysisPanel.tsx", import.meta.url), "utf8");
const cases = [];
function test(name, run) { cases.push({ name, run }); }

const footnoteMarksFn = source.slice(source.indexOf("function FootnoteMarks("), source.indexOf("\n}\n", source.indexOf("function FootnoteMarks(")) + 2);
const footnotesFn = source.slice(source.indexOf("function Footnotes("), source.indexOf("\n}\n", source.indexOf("function Footnotes(")) + 2);

test("1. a paragraph's citation marks render only footnote numbers, never a raw evidence ID or human label as visible text", () => {
  assert.match(footnoteMarksFn, /\{number\}/, "the visible child of each citation link is the resolved footnote number");
  assert.doesNotMatch(footnoteMarksFn, />\{sourceIds/, "raw sourceIds are never rendered as visible child text");
});

test("2. the Footnotes section renders the human-readable provenance label (footnote.text), not the raw evidence ID, as its visible body text", () => {
  assert.match(footnotesFn, /\{footnote\.text\}/, "each footnote list item shows the resolved label text");
  assert.doesNotMatch(footnotesFn, /\{footnote\.evidenceId\}<\/li>/, "the raw evidence ID is never the footnote's own visible text");
});

test("3. the raw evidence ID remains reachable, but only inside the clearly separate, collapsed Evidence & Methodology section — never inline in the report body", () => {
  const evidenceFn = source.slice(source.indexOf("function EvidenceMethodology("), source.indexOf("\nfunction AnalysisBody", source.indexOf("function EvidenceMethodology(")));
  assert.match(evidenceFn, /<code>\{id\}<\/code>/, "the raw ID is shown, deliberately, inside Evidence & Methodology");
  assert.match(source, /<details className="evidence-methodology">/, "Evidence & Methodology is a collapsed <details> panel, not inline report content");
});

test("4. every rendered section and the research-questions list route citations through the same FootnoteMarks component, so numbering and the no-leak guarantee apply report-wide", () => {
  const usages = [...source.matchAll(/<FootnoteMarks sourceIds=\{[^}]+\} index=\{footnoteIndex\} \/>/g)];
  assert.ok(usages.length >= 2, `expected at least 2 <FootnoteMarks> usages (the shared per-paragraph renderer, and research questions), found ${usages.length}`);
  assert.match(source, /function Section\(/, "every one of the eleven sections renders through this single shared component");
});

test("5. footnote numbering is resolved once per report, from a single shared index, not recomputed ad hoc per section", () => {
  assert.match(source, /const footnoteIndex = buildFootnoteIndex\(analysis\);/, "AnalysisBody builds exactly one footnote index for the whole report and threads it down");
  assert.doesNotMatch(source, /buildFootnoteIndex\(analysis\)[\s\S]*buildFootnoteIndex\(analysis\)/, "buildFootnoteIndex is called at most once per render");
});

test("6. a section can only be hidden when it is empty of real evidence (every paragraph cites only the bare 'token' placeholder) -- never based on a hardcoded token/section name", () => {
  const isEmptySectionFn = source.slice(source.indexOf("export function isEmptySection("), source.indexOf("\n}\n", source.indexOf("export function isEmptySection(")) + 2);
  assert.match(isEmptySectionFn, /sourceIds\.length === 1 && paragraph\.sourceIds\[0\] === "token"/, "emptiness is derived from the evidence placeholder signal, not a fixed rule");
  assert.doesNotMatch(isEmptySectionFn, /===\s*"BTC"|===\s*"ORCA"|===\s*"ILV"|===\s*"VIRTUAL"/i, "no token-name conditional in the visibility check");
});

test("7. Fundamental Analysis, Valuation Analysis, Market Structure & Liquidity, Tokenomics & Supply, Technical Analysis, and Data Quality & Analytical Limitations are all hidden when empty -- Market Performance, Cross-Domain Analysis, Key Investment Risks, and Executive Assessment always render", () => {
  const hidableSet = source.slice(source.indexOf("const HIDABLE_WHEN_EMPTY"), source.indexOf("]);", source.indexOf("const HIDABLE_WHEN_EMPTY")) + 3);
  for (const key of ["fundamentalAnalysis", "valuationAnalysis", "marketStructureLiquidity", "tokenomicsSupply", "technicalAnalysis", "dataQualityLimitations"]) {
    assert.match(hidableSet, new RegExp(`"${key}"`), `${key} must be hidable when it has no evidence`);
  }
  for (const key of ["marketPerformance", "crossDomainAnalysis", "keyRisks", "executiveAssessment"]) {
    assert.doesNotMatch(hidableSet, new RegExp(`"${key}"`), `${key} must always render`);
  }
  assert.match(source, /key === "executiveAssessment" \|\| !HIDABLE_WHEN_EMPTY\.has\(key\)/, "executiveAssessment is explicitly always visible regardless of the hidable set");
});

test("8. section numbering is sequential over only the sections that actually render, so hiding an empty section never leaves a gap in the visible numbering", () => {
  assert.match(source, /const numberedKeys[^=]*=\s*visibleKeys\.filter/, "numbering is derived from the same visible-keys list used to decide what renders, not the full static section list");
  assert.doesNotMatch(source, /ENGINE_SECTION_KEYS\.map\(\(key\) => \(\s*<Section/, "AnalysisBody must map over the dynamically visible keys, not the full static ENGINE_SECTION_KEYS list");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} Deep AI Analysis renderer checks passed.`);
if (failures > 0) process.exitCode = 1;
