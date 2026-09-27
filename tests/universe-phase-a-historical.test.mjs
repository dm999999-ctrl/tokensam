import assert from "node:assert/strict";

import { checkHistoricalData, coverageDays, evaluateHistoricalCoverage } from "../src/lib/universe/historical.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const CHECKED_AT = "2026-09-29T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function pricesSpanningDays(days) {
  const now = Date.parse(CHECKED_AT);
  return [[now - days * DAY_MS, 1], [now, 1.1]];
}

test("sufficient history (>= 90% of the required window) passes", () => {
  const result = evaluateHistoricalCoverage(pricesSpanningDays(30), 30, CHECKED_AT);
  assert.equal(result.historicalDataStatus, "pass");
  assert.equal(result.historicalRequiredDays, 30);
});

test("insufficient history (well under the required window) fails with the insufficient reason", () => {
  const result = evaluateHistoricalCoverage(pricesSpanningDays(5), 30, CHECKED_AT);
  assert.equal(result.historicalDataStatus, "fail");
  assert.equal(result.historicalDataFailureReason, "HISTORICAL_DATA_INSUFFICIENT");
});

test("missing history (no points at all) fails with the unavailable reason, distinct from insufficient", () => {
  const result = evaluateHistoricalCoverage([], 30, CHECKED_AT);
  assert.equal(result.historicalDataStatus, "fail");
  assert.equal(result.historicalDataFailureReason, "HISTORICAL_DATA_UNAVAILABLE");
  assert.equal(result.historicalCoverageDays, 0);
});

test("coverageDays measures the span between the earliest and latest point", () => {
  const now = Date.parse(CHECKED_AT);
  assert.equal(coverageDays([[now - 10 * DAY_MS, 1], [now - 5 * DAY_MS, 1], [now, 1]]), 10);
  assert.equal(coverageDays([[now, 1]]), 0);
  assert.equal(coverageDays(undefined), 0);
});

test("a provider-wide outage during the historical fetch is temporarily_unavailable, never a hard fail", async () => {
  const result = await checkHistoricalData(
    "bitcoin",
    30,
    { apiKey: "k", baseUrl: "https://api.coingecko.com/api/v3", keyHeader: "x-cg-demo-api-key" },
    { fetchImpl: async () => new Response("", { status: 500 }), sleep: async () => {}, now: () => new Date(CHECKED_AT) },
  );
  assert.equal(result.historicalDataStatus, "temporarily_unavailable");
  assert.ok(result.historicalDataFailureReason.startsWith("COINGECKO_UNAVAILABLE"));
  assert.equal("historicalCoverageDays" in result, false, "an outage must not report/overwrite a coverage value; the caller preserves whatever was measured before");
});

test("checkHistoricalData evaluates a real successful response end to end", async () => {
  const now = Date.parse(CHECKED_AT);
  const prices = Array.from({ length: 31 }, (_, i) => [now - (30 - i) * DAY_MS, 100 + i]);
  const result = await checkHistoricalData(
    "bitcoin",
    30,
    { apiKey: "k", baseUrl: "https://api.coingecko.com/api/v3", keyHeader: "x-cg-demo-api-key" },
    { fetchImpl: async () => new Response(JSON.stringify({ prices }), { status: 200 }), sleep: async () => {}, now: () => new Date(CHECKED_AT) },
  );
  assert.equal(result.historicalDataStatus, "pass");
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
console.log(`${cases.length - failures}/${cases.length} Phase A historical-data checks passed.`);
if (failures > 0) process.exitCode = 1;
