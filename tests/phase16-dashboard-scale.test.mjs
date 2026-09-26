// Phase 16 (100 -> 238 tokens): the Research Universe dashboard has no server
// pagination -- it filters/sorts a client-side array (Dashboard.tsx ->
// dashboard-model.ts). This proves that pipeline stays correct and fast at
// the expanded scale, using all 238 real canonical tokens with synthetic
// market values (no live data, no network).

import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { EMPTY_FILTERS, filterRows, researchColumns, sortRows, toRow, universeSummary } from "../src/lib/ui/dashboard-model.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

// Deterministic synthetic market data (not live) so the pipeline has something to filter/sort on.
const tokens = canonicalTokens.map((token, index) => ({
  id: token.id, name: token.name, symbol: token.symbol, chain: token.chainName, category: token.category,
  priceUsd: index % 7 === 0 ? null : 1 + (index % 50), // some tokens unavailable, never fabricated as 0
  change24hPct: index % 11 === 0 ? null : (index % 20) - 10,
  change7dPct: index % 13 === 0 ? null : (index % 30) - 15,
  marketCapUsd: index % 5 === 0 ? null : 1_000_000 * (index + 1),
  volume24hUsd: index % 9 === 0 ? null : 10_000 * (index + 1),
  fdvUsd: null, volume7dUsd: null, circulatingSupply: null, maximumSupply: null,
  tvlUsd: null, tvlChange30dPct: null, fees24hUsd: null, revenue24hUsd: null,
  observedAt: "2026-09-26T00:00:00.000Z", logoUrl: null,
  coverage: { isNative: token.isNative, protocolMapped: false, dexMapped: index % 4 === 0, hasProtocolData: false, hasDexData: index % 4 === 0 },
}));

test("1. the full 238-token universe filters, sorts, and summarizes correctly with no server pagination", () => {
  assert.equal(tokens.length, 238);
  const rows = tokens.map(toRow);
  assert.equal(rows.length, 238);

  const filtered = filterRows(rows, { ...EMPTY_FILTERS, query: "eth" });
  assert.ok(filtered.length > 0 && filtered.length < 238, "search narrows the set");
  assert.ok(filtered.every((row) => `${row.token.name} ${row.token.symbol} ${row.token.chain} ${row.token.category}`.toLowerCase().includes("eth")));

  const byChain = filterRows(rows, { ...EMPTY_FILTERS, chain: "Ethereum" });
  assert.ok(byChain.every((row) => row.token.chain === "Ethereum"));
  assert.ok(byChain.length >= 60, "Ethereum is well represented after the expansion");

  const dexOnly = filterRows(rows, { ...EMPTY_FILTERS, coverage: "dex" });
  assert.ok(dexOnly.length > 0 && dexOnly.every((row) => row.token.coverage.hasDexData));

  const sorted = sortRows(rows, "marketCapUsd", "desc");
  assert.equal(sorted.length, 238);
  const withCap = sorted.filter((row) => row.marketCapUsd !== null);
  for (let i = 1; i < withCap.length; i += 1) assert.ok(withCap[i - 1].marketCapUsd >= withCap[i].marketCapUsd, "descending order holds");
  assert.ok(sorted.slice(-Math.ceil(238 / 5)).every((row) => row.marketCapUsd === null), "rows without market cap sort last, never as zero");

  const { visible, hidden } = researchColumns(rows);
  assert.ok(visible.length > 0);
  assert.equal(visible.length + hidden.length, 8);

  const summary = universeSummary(tokens);
  assert.equal(summary.assets, 238);
  assert.ok(summary.chains >= 100, "chain diversity reaches the dashboard summary");
  assert.equal(summary.up + summary.down + summary.flat, summary.withChange);
});

test("2. the client-side filter/sort/summary pipeline stays fast (sub-second) at 238 rows", () => {
  const rows = tokens.map(toRow);
  const started = performance.now();
  for (let i = 0; i < 50; i += 1) {
    const filtered = filterRows(rows, { ...EMPTY_FILTERS, query: i % 2 === 0 ? "a" : "" });
    sortRows(filtered, "marketCapUsd", "desc");
    researchColumns(filtered);
  }
  universeSummary(tokens);
  const elapsedMs = performance.now() - started;
  // 50 full filter+sort+column passes over 238 rows; a generous ceiling for CI variance.
  assert.ok(elapsedMs < 500, `50 passes over 238 rows took ${elapsedMs.toFixed(1)} ms, expected well under 500 ms`);
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
console.log(`${cases.length - failures}/${cases.length} Phase 16 dashboard-scale checks passed.`);
if (failures > 0) process.exitCode = 1;
