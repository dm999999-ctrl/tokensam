import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { median, universeSummary } from "../src/lib/ui/dashboard-model.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const token = (id, change24hPct, marketCapUsd, volume24hUsd) => ({ id, name: id, symbol: id, chain: "Ethereum", category: "DeFi", change24hPct, marketCapUsd, volume24hUsd });

test("median: odd, even, empty", () => {
  assert.equal(median([3, -1, 2]), 2);
  assert.equal(median([4, -2, 1, 3]), 2);
  assert.equal(median([]), null);
});

test("market cap and volume sum only valid values; missing values are skipped, never zero", () => {
  const s = universeSummary([token("a", 1, 100, 10), token("b", -2, null, 5), token("c", null, 50, Number.NaN), token("d", 0, 25, null)]);
  assert.equal(s.marketCapUsd, 175);
  assert.equal(s.marketCapCount, 3);
  assert.equal(s.volume24hUsd, 15);
  assert.equal(s.volumeCount, 2);
  const none = universeSummary([token("a", null, null, null)]);
  assert.equal(none.marketCapUsd, null, "no data → unavailable, not $0");
  assert.equal(none.volume24hUsd, null);
  assert.equal(none.medianChange24hPct, null);
});

test("breadth counts reconcile with tokens that have a valid 24H change; unavailable ones are not classified", () => {
  const s = universeSummary([token("a", 5, 1, 1), token("b", -1, 1, 1), token("c", -3, 1, 1), token("d", 0, 1, 1), token("e", null, 1, 1), token("f", Number.NaN, 1, 1)]);
  assert.deepEqual([s.up, s.down, s.flat, s.withChange, s.assets], [1, 2, 1, 4, 6]);
  assert.equal(s.up + s.down + s.flat, s.withChange);
});

test("momentum is the median (not the mean) of valid 24H changes", () => {
  const s = universeSummary([token("a", 10, 1, 1), token("b", 1, 1, 1), token("c", -1, 1, 1), token("d", null, 1, 1)]);
  assert.equal(s.medianChange24hPct, 1);
  assert.notEqual(s.medianChange24hPct, 10 / 3);
});

test("strip shows the four market metrics in order and no coverage or universe-size cells", () => {
  const source = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
  const strip = source.slice(source.indexOf('<section className="summary-strip"'), source.indexOf("</section>", source.indexOf('<section className="summary-strip"')));
  const labels = [...strip.matchAll(/<span className="stat-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Tracked market cap", "24H trading volume", "24H market breadth", "24H market momentum"]);
  for (const note of ["Combined market cap", "Across tracked assets", "of tracked assets", "Median 24H change"]) assert.ok(strip.includes(note), note);
  assert.doesNotMatch(strip, /Protocol fundamentals|DEX market data|summary\.assets\} <small>assets|% advancing|% declining/);
  assert.match(strip, /breadth-bar/, "the proportional bar stays");
  assert.match(strip, /summary\.(marketCapUsd|volume24hUsd|up|down|medianChange24hPct)/, "values come from the live summary");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} market-overview checks passed.`);
if (failures > 0) process.exitCode = 1;
