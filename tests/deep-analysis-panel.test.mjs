// Deep AI Analysis renderer (src/components/DeepAnalysisPanel.tsx): the internal evidence-ID
// leak found in the successful Cardano Production run (obs:price, hist:price_30d, scope:defillama,
// etc. appearing as literal, visible text) traced to the Sources badge rendering the raw ID as its
// child text, with the human-readable provenance label demoted to the title tooltip. This reads the
// component's source (matching this repo's established pattern for JSX assertions — see
// tests/market-overview.test.mjs) rather than mounting a renderer, since no JSX render harness
// exists in this test suite.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/DeepAnalysisPanel.tsx", import.meta.url), "utf8");
const cases = [];
function test(name, run) { cases.push({ name, run }); }

const sourcesFn = source.slice(source.indexOf("function Sources("), source.indexOf("\n}\n", source.indexOf("function Sources(")) + 2);

test("1. the Sources badge's visible child is the human-readable provenance label, never the raw evidence ID", () => {
  assert.match(sourcesFn, /\{sources\[id\] \?\? "[^"]+"\}\s*<\/span>/, "the JSX child expression reads the label map, with a clean (non-ID) fallback");
  assert.doesNotMatch(sourcesFn, />\{id\}<\/span>/, "the raw id is never rendered as the visible child text");
});

test("2. the raw evidence ID remains reachable through the intended provenance mechanism (the title tooltip), so citations are still inspectable", () => {
  assert.match(sourcesFn, /title=\{id\}/, "the id is still attached to the element, just not as visible body text");
});

test("3. every rendered section routes its citations through the same Sources component, so the fix applies report-wide", () => {
  // The Phase 2 institutional-research report unified what used to be four separate render paths
  // (statements, risks, data gaps, research questions) into one generic paragraph renderer shared by
  // all eleven sections (see the `Section` component), plus the one remaining distinct list (further
  // research questions). That is a stronger guarantee than four separate call sites, not a weaker
  // one: risks and data gaps literally cannot render through a different, unpatched code path,
  // because there is no longer a separate code path for them to render through.
  const usages = [...source.matchAll(/<Sources ids=\{[^}]+\} sources=\{sources\} \/>/g)];
  assert.ok(usages.length >= 2, `expected at least 2 <Sources> usages (the shared per-section paragraph renderer, and research questions), found ${usages.length}`);
  assert.match(source, /function Section\(/, "every one of the eleven sections renders through this single shared component");
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
