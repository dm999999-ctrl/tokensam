import assert from "node:assert/strict";

import { DEFAULT_ELIGIBILITY_CONFIG } from "../src/lib/universe/config.ts";
import { evaluateEligibility } from "../src/lib/universe/eligibility.ts";
import { evaluateSupplyData } from "../src/lib/universe/supply.ts";
import { newCandidateFromMarket } from "../src/lib/universe/types.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const CHECKED_AT = "2026-09-29T00:00:00.000Z";
const config = DEFAULT_ELIGIBILITY_CONFIG;

function passingCandidate(overrides = {}) {
  const base = newCandidateFromMarket({ id: "example", symbol: "EX", name: "Example" }, CHECKED_AT);
  return {
    ...base,
    identityStatus: "valid",
    coingeckoStatus: "pass",
    binanceStatus: "pass",
    binanceFailureReason: null,
    logoStatus: "pass",
    historicalDataStatus: "pass",
    supplyStatus: "pass",
    ...overrides,
  };
}

test("every hard requirement passing yields ELIGIBLE with no reason codes", () => {
  const result = evaluateEligibility(passingCandidate(), config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "eligible");
  assert.deepEqual(result.eligibilityReasonCodes, []);
  assert.equal(result.eligibilityConfigVersion, "phase-a-v2");
});

test("CoinGecko not found makes the candidate INELIGIBLE with that exact reason", () => {
  const candidate = passingCandidate({ coingeckoStatus: "fail", coingeckoFailureReason: "COINGECKO_NOT_FOUND" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
  assert.deepEqual(result.eligibilityReasonCodes, ["COINGECKO_NOT_FOUND"]);
});

test("Binance Futures-only makes the candidate INELIGIBLE, never substituted for Spot", () => {
  const candidate = passingCandidate({ binanceStatus: "fail", binanceFailureReason: "BINANCE_FUTURES_ONLY" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
  assert.deepEqual(result.eligibilityReasonCodes, ["BINANCE_FUTURES_ONLY"]);
});

test("a non-trading Binance Spot market is ineligible by default, but downgrades to NEEDS_REVIEW when requireTradingStatus is off", () => {
  const candidate = passingCandidate({ binanceStatus: "fail", binanceFailureReason: "BINANCE_NOT_TRADING" });
  const strict = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(strict.eligibilityStatus, "ineligible");

  const lenient = evaluateEligibility(candidate, { ...config, requireTradingStatus: false }, CHECKED_AT);
  assert.equal(lenient.eligibilityStatus, "needs_review");
});

test("an unresolved symbol collision is NEEDS_REVIEW, never falsely qualified as eligible or wrongly excluded as ineligible", () => {
  const candidate = passingCandidate({ identityStatus: "collision", binanceStatus: null });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "needs_review");
  assert.ok(result.eligibilityReasonCodes.includes("IDENTITY_COLLISION"));
});

test("a duplicate asset is INELIGIBLE for the Active universe but keeps its data (status alone reflects this)", () => {
  const candidate = passingCandidate({ universeStatus: "duplicate" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
  assert.deepEqual(result.eligibilityReasonCodes, ["DUPLICATE_ASSET"]);
});

test("a deprecated asset is INELIGIBLE", () => {
  const candidate = passingCandidate({ universeStatus: "deprecated" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.deepEqual(result.eligibilityReasonCodes, ["DEPRECATED_ASSET"]);
});

test("a migrated asset is INELIGIBLE under its own reason, distinct from deprecated", () => {
  const candidate = passingCandidate({ universeStatus: "migrated" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.deepEqual(result.eligibilityReasonCodes, ["MIGRATED_ASSET"]);
});

test("a provider outage (TEMPORARY) never destroys previously-valid status: no hard failure means TEMPORARILY_UNAVAILABLE, not ineligible", () => {
  const candidate = passingCandidate({ coingeckoStatus: "temporarily_unavailable", coingeckoFailureReason: null });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "temporarily_unavailable");
  assert.deepEqual(result.eligibilityReasonCodes, ["COINGECKO_UNAVAILABLE"]);
});

test("a hard failure always outranks a simultaneous temporary outage on another check", () => {
  const candidate = passingCandidate({
    coingeckoStatus: "fail",
    coingeckoFailureReason: "COINGECKO_METADATA_INCOMPLETE",
    binanceStatus: "temporarily_unavailable",
    binanceFailureReason: null,
  });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
  assert.ok(result.eligibilityReasonCodes.includes("COINGECKO_METADATA_INCOMPLETE"));
  assert.ok(result.eligibilityReasonCodes.includes("BINANCE_UNAVAILABLE"));
});

test("logo unavailable makes the candidate INELIGIBLE when logo is required", () => {
  const candidate = passingCandidate({ logoStatus: "fail" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
  assert.deepEqual(result.eligibilityReasonCodes, ["LOGO_UNAVAILABLE"]);
});

test("logo temporarily unavailable is TEMPORARILY_UNAVAILABLE, not a permanent rejection", () => {
  const candidate = passingCandidate({ logoStatus: "temporarily_unavailable" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "temporarily_unavailable");
});

test("insufficient historical data makes the candidate INELIGIBLE with the exact reason", () => {
  const candidate = passingCandidate({ historicalDataStatus: "fail", historicalDataFailureReason: "HISTORICAL_DATA_INSUFFICIENT" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.deepEqual(result.eligibilityReasonCodes, ["HISTORICAL_DATA_INSUFFICIENT"]);
});

test("supply data marked needs_review yields NEEDS_REVIEW overall (not a hard failure)", () => {
  const candidate = passingCandidate({ supplyStatus: "needs_review" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "needs_review");
});

test("supply data marked fail (no size reference at all) yields INELIGIBLE", () => {
  const candidate = passingCandidate({ supplyStatus: "fail" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "ineligible");
});

test("checks not yet run (still null) are skipped rather than fabricating a failure reason", () => {
  const candidate = passingCandidate({ logoStatus: null, historicalDataStatus: null, supplyStatus: null, coingeckoStatus: "fail", coingeckoFailureReason: "COINGECKO_NOT_FOUND" });
  const result = evaluateEligibility(candidate, config, CHECKED_AT);
  assert.deepEqual(result.eligibilityReasonCodes, ["COINGECKO_NOT_FOUND"]);
});

test("disabling a requirement in config removes it from consideration entirely", () => {
  const candidate = passingCandidate({ logoStatus: "fail" });
  const result = evaluateEligibility(candidate, { ...config, requireLogo: false }, CHECKED_AT);
  assert.equal(result.eligibilityStatus, "eligible");
});

// ---- Supply/reference data sufficiency (feeds the eligibility engine above) ----

test("supply: circulating supply present passes outright", () => {
  const result = evaluateSupplyData({ hasMarketCap: true, circulatingSupply: 1000, totalSupply: 1000, maxSupply: null, reportedFdv: null }, CHECKED_AT);
  assert.equal(result.supplyStatus, "pass");
  assert.equal(result.hasCirculatingSupply, true);
});

test("supply: missing circulating supply but market cap present is needs_review, not a hard failure", () => {
  const result = evaluateSupplyData({ hasMarketCap: true, circulatingSupply: null, totalSupply: null, maxSupply: null, reportedFdv: null }, CHECKED_AT);
  assert.equal(result.supplyStatus, "needs_review");
});

test("supply: nothing at all (no circulating supply, no market cap, no FDV) fails", () => {
  const result = evaluateSupplyData({ hasMarketCap: false, circulatingSupply: null, totalSupply: null, maxSupply: null, reportedFdv: null }, CHECKED_AT);
  assert.equal(result.supplyStatus, "fail");
  assert.equal(result.supplyFailureReason, "SUPPLY_DATA_INSUFFICIENT");
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
console.log(`${cases.length - failures}/${cases.length} Phase A eligibility checks passed.`);
if (failures > 0) process.exitCode = 1;
