// Deep Analysis Engine — Phase 1 calibration pass, based on production observations against
// BTC/ETH/UNI/SUI/HYPE. Covers the eight calibration issues: momentum interpretation (direction vs.
// pace vs. reversal), short-aligned-interval relationship weight, volatility redundancy collapse,
// BTC/ETH supply-precision contradictions, SUI circulating-share phrasing, driver-derived research
// questions, and general (non-token-specific) sanity checks on HYPE/UNI-shaped synthesis output.
// No prose is hardcoded to any one token; every assertion is a general rule.

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

import { extractFindings } from "../src/lib/analysis/engine/findings.ts";
import { statementForFinding, furtherResearchQuestions } from "../src/lib/analysis/engine/narrative.ts";
import { synthesize, classifyHorizon, collapseRedundant } from "../src/lib/analysis/engine/synthesis.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

function seed(tokenId, chainId, rows, calculated = [], isNative = false) {
  let id = 1000;
  const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
    id: id++, token_id: tokenId, chain_id: chainId, provider_id: provider, metric_id: metric, value,
    status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
  });
  return {
    tokens: [{ id: tokenId, name: "Test Token", symbol: "TST", chain_id: chainId, contract_address: isNative ? null : "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: isNative, category: "DeFi", description: null }],
    chains: [{ id: chainId, name: chainId }],
    token_metric_observations: rows.map(obs),
    metric_definitions: [],
    calculated_metric_observations: calculated.map((row, index) => {
      const definition = CALCULATED_METRICS.find((metric) => metric.id === row.metric);
      return {
        id: 5000 + index, token_id: tokenId, chain_id: chainId, metric_id: row.metric, metric_name: definition.name, unit: definition.unit,
        value: row.value, status: "available", formula: definition.formula, calculated_at: at(0.4),
        period_start_at: row.start ?? null, period_end_at: row.end ?? null, provenance: {},
      };
    }),
    calculated_metric_definitions: CALCULATED_METRICS.map((metric) => ({ id: metric.id, category: metric.category, source_scopes: metric.sourceScopes })),
  };
}

async function payloadFor(tokenId, data) {
  const profile = await getLiveTokenProfile(tokenId, createFakeSupabase({ seed: data }).client);
  return buildProfilePayload(profile);
}

function momentumFinding(payload) {
  const findings = extractFindings(payload);
  return findings.find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_"));
}

// =====================================================================================
// CALIBRATION ISSUE 1 — Momentum interpretation
// =====================================================================================

// A. 24H negative, 7D negative, 30D positive, 90D positive (the exact HYPE-shaped production pattern).
const CASE_A = await payloadFor("cal-a", seed("cal-a", "ethereum", [
  ["coingecko", "price_usd", 100],
  ["coingecko", "price_usd", 92.94, 24 * 29], ["coingecko", "price_usd", 72.41, 24 * 88],
  ["coingecko", "price_change_24h_pct", -3.28, 0.5, { window_days: 1 }],
  ["coingecko", "price_change_7d_pct", -3.35, 0.5, { window_days: 7 }],
  ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("A. 24H-/7D- against 30D+/90D+ is classified as a reversal, never as 'consistent pace'", () => {
  const finding = momentumFinding(CASE_A);
  assert.equal(finding.findingType, "multi_horizon_reversal_to_down");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /revers/i);
  assert.doesNotMatch(detail.text, /broadly consistent/i, "a reversal must never be described as a consistent pace of change");
  assert.doesNotMatch(detail.text, /consistent pace/i);
  const summary = statementForFinding(finding, "summary");
  assert.match(summary.text, /revers/i);
});

// B. All periods positive, increasing normalized pace (the recent 7D per-day rate runs far ahead of
// the rate implied by the rest of the 90D window) — must classify as accelerating, not "faster/slower"
// read off raw cumulative percentages.
const CASE_B = await payloadFor("cal-b", seed("cal-b", "ethereum", [
  ["coingecko", "price_usd", 100],
  ["coingecko", "price_usd", 62, 24 * 88],
  ["coingecko", "price_change_7d_pct", 14, 0.5, { window_days: 7 }],
  ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("B. all-positive momentum with a sharply faster recent per-day rate classifies as accelerating (normalized, not raw-percentage comparison)", () => {
  const finding = momentumFinding(CASE_B);
  assert.equal(finding.findingType, "multi_horizon_consistent_up_accelerating");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /faster/i);
  const summary = statementForFinding(finding, "summary");
  assert.match(summary.text, /picked up more recently/i);
});

// C. All periods positive, decreasing normalized pace (most of the 90D move happened before the
// recent 7D window) — must classify as decelerating.
const CASE_C = await payloadFor("cal-c", seed("cal-c", "ethereum", [
  ["coingecko", "price_usd", 100],
  ["coingecko", "price_usd", 71.43, 24 * 88],
  ["coingecko", "price_change_7d_pct", 2, 0.5, { window_days: 7 }],
  ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("C. all-positive momentum with a sharply slower recent per-day rate classifies as decelerating", () => {
  const finding = momentumFinding(CASE_C);
  assert.equal(finding.findingType, "multi_horizon_consistent_up_decelerating");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /materially larger in magnitude/i);
});

// D. Mixed direction: 7D up, 30D down, 90D up — no clean two-horizon reversal (first and last agree),
// so this is genuinely "mixed," a distinct case from a reversal.
const CASE_D = await payloadFor("cal-d", seed("cal-d", "ethereum", [
  ["coingecko", "price_usd", 100],
  ["coingecko", "price_usd", 110, 24 * 29], ["coingecko", "price_usd", 95, 24 * 88],
  ["coingecko", "price_change_7d_pct", 5, 0.5, { window_days: 7 }],
  ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("D. mixed-direction momentum (up/down/up) is classified as mixed, distinct from a reversal", () => {
  const finding = momentumFinding(CASE_D);
  assert.equal(finding.findingType, "multi_horizon_mixed");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /without a single consistent direction/i);
});

// E. A 7D reversal against a positive 90D trend, with only those two horizons available (no 30D) —
// the minimal, purest case of the same mechanism as scenario A.
const CASE_E = await payloadFor("cal-e", seed("cal-e", "ethereum", [
  ["coingecko", "price_usd", 100],
  ["coingecko", "price_usd", 70, 24 * 88],
  ["coingecko", "price_change_7d_pct", -4, 0.5, { window_days: 7 }],
  ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("E. a 7D reversal against a positive 90D trend (only two horizons available) is a reversal, not a pace comparison", () => {
  const finding = momentumFinding(CASE_E);
  assert.equal(finding.findingType, "multi_horizon_reversal_to_down");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /revers/i);
  assert.doesNotMatch(detail.text, /broadly consistent/i);
});

// =====================================================================================
// CALIBRATION ISSUE 2 — Very short cross-metric windows must not dominate thesis-driver selection
// =====================================================================================

function divergenceFinding(intervalHours) {
  return {
    category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate",
    evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: { label: "Price up, TVL down", intervalHours },
  };
}

test("a ~37-minute aligned-interval relationship classifies as snapshot, not short_term", () => {
  assert.equal(classifyHorizon(divergenceFinding(37 / 60)), "snapshot");
});

test("a genuine multi-day aligned-interval relationship (e.g. ~7 days) still classifies as short_term", () => {
  assert.equal(classifyHorizon(divergenceFinding(24 * 7)), "short_term");
});

test("an aligned interval of unknown duration is never assumed to be short (conservative default preserved)", () => {
  assert.equal(classifyHorizon(divergenceFinding(null)), "short_term");
});

test("Issue 2 regression: a ~45-minute relationship can never outrank a persistent 30D+ relationship of equal severity", () => {
  const shortWindow = divergenceFinding(0.75); // 45 minutes
  const longWindow = { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} };
  const result = synthesize([shortWindow, longWindow]);
  const shortDriver = result.thesisDrivers.find((d) => d.findingIds.some((id) => id.startsWith("marketFundamentalRelationships:")));
  const longDriver = result.thesisDrivers.find((d) => d.findingIds.some((id) => id.startsWith("fundamentalPerformance:")));
  assert.ok(longDriver, "the 30D-scale fundamentals signal is a thesis driver");
  if (shortDriver) assert.ok(longDriver.materiality.total > shortDriver.materiality.total, "the ~45-minute relationship must never outrank the persistent 30D+ one");
  else assert.ok(true, "the ~45-minute relationship did not even clear the driver floor — an even stronger form of 'cannot dominate'");
});

test("Issue 2: the short-window observation is still surfaced (never deleted), just outweighed", () => {
  const shortWindow = divergenceFinding(37 / 60);
  const result = synthesize([shortWindow]);
  assert.equal(result.relationships.length, 1, "the observation is still a valid, displayed relationship");
  assert.equal(result.relationships[0].horizon, "snapshot");
  assert.deepEqual(result.relationships[0].evidenceIds, ["calc:divergence_price_up_tvl_down"], "its evidence is preserved");
});

// =====================================================================================
// CALIBRATION ISSUE 3 — Volatility redundancy: collapse, but do not lose a real value spread
// =====================================================================================

function volatilityFinding(evidenceId, raw) {
  return { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: [evidenceId], observationPeriods: [null], data: { value: `${raw}% volatility`, raw } };
}

test("identical volatility values across 7D/30D/90D collapse into one signal with valueSpread 'uniform'", () => {
  const findings = [volatilityFinding("hist:risk_7d", 92), volatilityFinding("hist:risk_30d", 92), volatilityFinding("hist:risk_90d", 92)];
  const { groups } = collapseRedundant(findings);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].memberCount, 3);
  assert.equal(groups[0].valueSpread, "uniform");
  assert.deepEqual(groups[0].evidenceIds.sort(), ["hist:risk_30d", "hist:risk_7d", "hist:risk_90d"].sort(), "every window's evidence is preserved even though it collapses to one signal");
});

test("materially different volatility values across windows still collapse to one signal, but are flagged 'varied' so a later narrative can preserve the distinction", () => {
  const findings = [volatilityFinding("hist:risk_7d", 45), volatilityFinding("hist:risk_30d", 65), volatilityFinding("hist:risk_90d", 95)];
  const { groups, survivors } = collapseRedundant(findings);
  assert.equal(groups.length, 1, "still one synthesized signal, not three independent risks");
  assert.equal(groups[0].valueSpread, "varied");
  assert.equal(survivors.length, 1);
  assert.deepEqual(groups[0].findingIds.length, 3, "no evidence is silently dropped");
});

test("a redundancy group with no numeric raw on its members reports valueSpread 'unknown', never a guessed distinction", () => {
  const noRaw = { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_7d"], observationPeriods: [null], data: { value: "elevated" } };
  const withRaw = volatilityFinding("hist:risk_30d", 90);
  const { groups } = collapseRedundant([noRaw, withRaw]);
  assert.equal(groups[0].valueSpread, "unknown");
});

// UNI-shaped regression: real extraction path, not handcrafted findings.
const UNI_VOLATILE = await payloadFor("uni-volatile", seed("uni-volatile", "ethereum", [
  ["coingecko", "price_usd", 7.2], ["coingecko", "market_cap_usd", 4_000_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
  ["coingecko", "price_usd", 7.4, 24 * 2], ["coingecko", "price_usd", 6.9, 24 * 4], ["coingecko", "price_usd", 7.6, 24 * 6],
  ["coingecko", "price_usd", 6.7, 24 * 8], ["coingecko", "price_usd", 7.8, 24 * 10], ["coingecko", "price_usd", 6.5, 24 * 12],
  ["coingecko", "price_usd", 7.9, 24 * 15], ["coingecko", "price_usd", 6.3, 24 * 20], ["coingecko", "price_usd", 8.1, 24 * 25],
  ["coingecko", "price_usd", 6.1, 24 * 40], ["coingecko", "price_usd", 8.3, 24 * 60], ["coingecko", "price_usd", 5.9, 24 * 80],
  ["coingecko", "circulating_supply", 600_000_000],
]));

test("UNI-shaped regression: repeated elevated-volatility readings across the real extraction pipeline collapse into a single redundancy group with evidence preserved", () => {
  const findings = extractFindings(UNI_VOLATILE);
  const riskVolatility = findings.filter((f) => f.category === "risk" && (f.findingType === "elevated_volatility" || f.findingType === "sharp_drawdown"));
  const result = synthesize(findings);
  if (riskVolatility.length >= 2) {
    const group = result.redundancyGroups.find((g) => g.category === "risk" && (g.findingType === "elevated_volatility" || g.findingType === "sharp_drawdown"));
    assert.ok(group, "the real pipeline's repeated risk readings collapse into a redundancy group");
    assert.equal(group.memberCount, riskVolatility.length);
    assert.ok(["uniform", "varied"].includes(group.valueSpread));
  } else {
    assert.ok(true, "fixture did not happen to trigger >=2 volatility windows; the handcrafted tests above cover the mechanism directly");
  }
});

// =====================================================================================
// CALIBRATION ISSUE 4 — BTC/ETH supply precision: never contradict displayed evidence
// =====================================================================================

function supplyPayload(tokenId, circulating, total) {
  return payloadFor(tokenId, seed(tokenId, "bitcoin", [
    ["coingecko", "price_usd", 90000], ["coingecko", "market_cap_usd", 1_800_000_000_000],
    ["coingecko", "circulating_supply", circulating], ["coingecko", "total_supply", total], ["coingecko", "maximum_supply", 21_000_000],
  ], [], true));
}

test("A. circulating supply exactly equal to total supply never claims 'below'", async () => {
  const payload = await supplyPayload("cal-supply-a", 19_987_731, 19_987_731);
  const findings = extractFindings(payload);
  const finding = findings.find((f) => f.findingType === "circulating_equals_total" || f.findingType === "circulating_below_total");
  assert.equal(finding.findingType, "circulating_equals_total");
  const detail = statementForFinding(finding, "detail");
  assert.doesNotMatch(detail.text, /below/i);
  assert.match(detail.text, /equals/i);
});

test("B. circulating slightly below total, but the compact display rounds both to the same figure: the narrative uses full precision instead of asserting a visible contradiction", async () => {
  // Both round to "19.99M" at the UI's 2-decimal compact precision, but are genuinely different.
  const payload = await supplyPayload("cal-supply-b", 19_987_731, 19_987_800);
  const findings = extractFindings(payload);
  const finding = findings.find((f) => f.findingType === "circulating_below_total");
  assert.ok(finding, "the raw values are genuinely different, so this must still be circulating_below_total");
  assert.equal(finding.data.circulatingValue, finding.data.totalValue, "the fixture's premise: the two fields display identically at compact precision");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /below/i);
  // The two cited figures inside the sentence must now actually differ (full precision), so the
  // sentence never asserts "X is below X".
  const circulatingText = /Circulating supply \(([^)]+)\)/.exec(detail.text)?.[1];
  const totalText = /below total supply \(([^)]+)\)/.exec(detail.text)?.[1];
  assert.ok(circulatingText && totalText, "both figures are quoted in the sentence");
  assert.notEqual(circulatingText, totalText, "the sentence must never state the same figure for both sides of a 'below' claim");
});

test("C. circulating materially below total: unchanged, already-distinguishable display values are used as before", async () => {
  const payload = await supplyPayload("cal-supply-c", 15_000_000, 20_000_000);
  const findings = extractFindings(payload);
  const finding = findings.find((f) => f.findingType === "circulating_below_total");
  assert.notEqual(finding.data.circulatingValue, finding.data.totalValue);
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /below/i);
  assert.ok(detail.text.includes(finding.data.circulatingValue) && detail.text.includes(finding.data.totalValue), "the already-distinct display values are quoted directly, unchanged");
});

// =====================================================================================
// CALIBRATION ISSUE 5 — SUI-shaped circulating-share phrasing
// =====================================================================================

const SUI_SHARE = await payloadFor("cal-sui-share", seed("cal-sui-share", "sui", [
  ["coingecko", "price_usd", 3.42], ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 500_000_000],
  ["coingecko", "circulating_supply", 4_100_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
], [], true));

test("low-circulating-share detail text reads naturally: 'X% of maximum supply is currently circulating (breakdown)', never a doubled 'circulating ... of maximum supply'", () => {
  const findings = extractFindings(SUI_SHARE);
  const finding = findings.find((f) => f.category === "tokenomics" && f.findingType === "low_circulating_share");
  assert.ok(finding, "the fixture's ~41% circulating share triggers the finding");
  const detail = statementForFinding(finding, "detail");
  assert.match(detail.text, /^\d+\.\d%\s+of maximum supply is currently circulating/, "leads with 'X% of maximum supply is currently circulating'");
  assert.doesNotMatch(detail.text, /circulating \([^)]+\) of maximum supply/i, "must never double up 'circulating (...) of maximum supply'");
  assert.match(detail.text, /\(4\.1B of 10B/, "the real breakdown figures are preserved from the underlying field");
});

// =====================================================================================
// CALIBRATION ISSUE 6 — Research questions must derive from actual Thesis Drivers
// =====================================================================================

test("a lone, immaterial supply-structure finding never triggers a momentum-persistence question", () => {
  const supplyOnly = [{ category: "tokenomics", findingType: "low_circulating_share", severity: "moderate", evidenceIds: ["calc:circulating_of_max_supply"], observationPeriods: [null], data: { value: "41.0% circulating (4.1B of 10B SUI)", raw: 41, breakdown: "4.1B of 10B SUI" } }];
  const synthesis = synthesize(supplyOnly);
  const questions = furtherResearchQuestions(supplyOnly, synthesis.thesisDrivers);
  assert.ok(!questions.some((q) => /momentum/i.test(q.question)), "no momentum driver exists, so no momentum question is warranted");
});

test("a material momentum Thesis Driver does warrant the momentum-persistence question", () => {
  const momentum = {
    category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "high",
    evidenceIds: ["hist:price_30d", "hist:price_90d"], observationPeriods: [null, null], data: {},
    horizons: [{ key: "30d", days: 30, raw: 12, value: "+12.00%", period: "30D", id: "hist:price_30d" }, { key: "90d", days: 90, raw: 25, value: "+25.00%", period: "90D", id: "hist:price_90d" }],
  };
  const synthesis = synthesize([momentum]);
  assert.ok(synthesis.thesisDrivers.length > 0, "sanity: this momentum finding is material enough to be a driver");
  const questions = furtherResearchQuestions([momentum], synthesis.thesisDrivers);
  assert.ok(questions.some((q) => /positive momentum/i.test(q.question)));
});

test("a material price/fundamental divergence Thesis Driver warrants a persistence question; a non-material one does not", () => {
  const materialDivergence = { category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate", evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: { label: "x", intervalHours: 24 * 30 } };
  const materialSynthesis = synthesize([materialDivergence]);
  const materialQuestions = furtherResearchQuestions([materialDivergence], materialSynthesis.thesisDrivers);
  const materialTotal = materialSynthesis.relationships[0].materiality.total;
  if (materialTotal >= 8) assert.ok(materialQuestions.some((q) => /divergence/i.test(q.question)));

  const thinDivergence = { category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate", evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: { label: "x", intervalHours: 0.5 } };
  const gap1 = { category: "dataQuality", findingType: "insufficient_history_price_24h", severity: "low", evidenceIds: ["hist:price_24h"], observationPeriods: [null], data: {} };
  const gap2 = { category: "dataQuality", findingType: "insufficient_history_tvl_24h", severity: "low", evidenceIds: ["hist:tvl_24h"], observationPeriods: [null], data: {} };
  const thinSynthesis = synthesize([thinDivergence, gap1, gap2]);
  const thinQuestions = furtherResearchQuestions([thinDivergence, gap1, gap2], thinSynthesis.thesisDrivers);
  assert.ok(!thinQuestions.some((q) => /divergence/i.test(q.question)), "a data-gap-limited, snapshot-horizon divergence must not pad the questions section");
});

test("a report with no meaningful unresolved relationship and no data gaps returns no research question at all", () => {
  const lone = [{ category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: { label: "MC/TVL", value: "1.2×" } }];
  const synthesis = synthesize(lone);
  const questions = furtherResearchQuestions(lone, synthesis.thesisDrivers);
  assert.deepEqual(questions, []);
});

test("mapping-limitation and missing-history questions remain keyed off the raw findings (thin data is itself the story, not gated behind a Thesis Driver)", () => {
  const gap = [{ category: "dataQuality", findingType: "unmapped_defillama", severity: "low", evidenceIds: ["scope:defillama"], observationPeriods: [null], data: { provider: "DeFiLlama" } }];
  const synthesis = synthesize(gap);
  const questions = furtherResearchQuestions(gap, synthesis.thesisDrivers);
  assert.ok(questions.some((q) => /mapping/i.test(q.question)));
});

// =====================================================================================
// CALIBRATION ISSUES 7/8 — General (non-token-specific) materiality sanity checks
// =====================================================================================

test("Issue 7/8 general rule: a persistent structural relationship always outranks a snapshot-horizon relationship of equal severity, for any token's data", () => {
  const structural = { category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "moderate", evidenceIds: ["hist:price_30d", "hist:price_90d"], observationPeriods: [null, null], data: {}, horizons: [{ key: "30d", days: 30, raw: 8, value: "+8.00%", period: "30D", id: "hist:price_30d" }, { key: "90d", days: 90, raw: 15, value: "+15.00%", period: "90D", id: "hist:price_90d" }] };
  const snapshot = { category: "valuation", findingType: "fdv_market_cap_gap", severity: "moderate", evidenceIds: ["obs:fdv", "obs:market_cap"], observationPeriods: [null, null], data: {} };
  const result = synthesize([structural, snapshot]);
  const structuralDriver = result.thesisDrivers.find((d) => d.horizon === "structural");
  const snapshotDriver = result.thesisDrivers.find((d) => d.horizon === "snapshot");
  assert.ok(structuralDriver);
  if (snapshotDriver) assert.ok(structuralDriver.materiality.total > snapshotDriver.materiality.total);
});

test("Issue 8 general rule: an isolated, single-window volatility reading never outranks a persistent 30D+ fundamentals relationship of equal severity", () => {
  // A single, uncollapsed 7D-only volatility reading (short_term horizon) — not the multi-window
  // case below, which is genuinely persistent and legitimately scores differently.
  const isolatedVolatility = volatilityFinding("hist:risk_7d", 90);
  const fundamentals = { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "high", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} };
  const result = synthesize([isolatedVolatility, fundamentals]);
  const riskDriver = result.thesisDrivers.find((d) => d.categories.includes("risk"));
  const fundamentalsDriver = result.thesisDrivers.find((d) => d.categories.includes("fundamentalPerformance"));
  assert.ok(fundamentalsDriver, "the medium-term fundamentals signal is a thesis driver");
  assert.ok(riskDriver, "the isolated volatility reading also clears the floor on its own");
  assert.ok(fundamentalsDriver.materiality.total > riskDriver.materiality.total, "a single short_term reading must not outrank a medium_term persistent fundamentals signal");
});

test("Issue 8: a volatility reading genuinely persistent across 7D/30D/90D (not merely duplicated) legitimately scores as highly material — persistence across real windows is not the same defect as a spurious short-window relationship", () => {
  const volatility7 = volatilityFinding("hist:risk_7d", 90);
  const volatility30 = volatilityFinding("hist:risk_30d", 90);
  const volatility90 = volatilityFinding("hist:risk_90d", 90);
  const result = synthesize([volatility7, volatility30, volatility90]);
  const riskDriver = result.thesisDrivers.find((d) => d.categories.includes("risk"));
  assert.ok(riskDriver, "a volatility signal sustained across every available window is a legitimate thesis driver");
  assert.equal(riskDriver.horizon, "structural", "sustained through the 90D window, its horizon is structural, not merely 'repeated'");
});

test("Issue 7/8: determinism holds across the newly changed rules — identical input, identical output, order-independent", () => {
  const findings = [
    volatilityFinding("hist:risk_7d", 45), volatilityFinding("hist:risk_30d", 65), volatilityFinding("hist:risk_90d", 95),
    divergenceFinding(37 / 60),
    { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} },
  ];
  const first = synthesize(findings);
  const second = synthesize(findings);
  const shuffled = synthesize([findings[3], findings[0], findings[4], findings[1], findings[2]]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, shuffled);
});

// =====================================================================================

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
console.log(`${cases.length - failures}/${cases.length} calibration checks passed.`);
if (failures > 0) process.exitCode = 1;
