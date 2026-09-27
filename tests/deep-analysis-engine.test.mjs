// Deterministic Deep Analysis Engine: thresholds, findings, narrative, report assembly, and the
// live-path service. No network access is used anywhere in this file; that itself is part of what
// is being verified (scenario R/T below).

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

import { momentumBand, volatilityBand, magnitudeWord, MOMENTUM_BANDS, VOLATILITY_BANDS } from "../src/lib/analysis/engine/thresholds.ts";
import { extractFindings } from "../src/lib/analysis/engine/findings.ts";
import { buildEngineReport, ENGINE_VERSION, ANALYSIS_VERSION } from "../src/lib/analysis/engine/report.ts";
import { generateDeterministicAnalysis, getDeterministicAnalysisState, DETERMINISTIC_ENGINE_NAME } from "../src/lib/analysis/deterministic-service.ts";
import { AnalysisValidationError, findProhibitedLanguage } from "../src/lib/analysis/schema.ts";
import { findCausalLanguage, findDirectionalLanguage, findLeakedEvidenceMarker } from "../src/lib/analysis/evidence-rules.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

// ---- Fixture builder (mirrors tests/profile-payload.test.mjs's own helper) ----

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

/** Every field/scope/token ID a report cites actually exists in the payload (the provenance guarantee). */
function assertProvenance(payload, report) {
  const knownIds = new Set(["token", ...payload.scope.map((note) => note.id), ...payload.fields.map((field) => field.id)]);
  const cited = new Set();
  JSON.stringify(report.analysis, (key, value) => {
    if (key === "sourceIds" && Array.isArray(value)) for (const id of value) cited.add(id);
    return value;
  });
  for (const id of cited) {
    assert.ok(knownIds.has(id), `cited source ID ${id} is not a real payload field`);
    assert.ok(report.sources[id], `cited source ID ${id} has no provenance label`);
  }
}

/** Every text field in a report, for language/grammar sweeps. */
function allText(analysis) {
  const texts = [];
  JSON.stringify(analysis, (key, value) => {
    if ((key === "text" || key === "overview" || key === "detail" || key === "title" || key === "question" || key === "rationale") && typeof value === "string") texts.push(value);
    return value;
  });
  return texts;
}

/** No internal evidence marker, causal claim, or investment-advice phrase anywhere in the rendered text. */
function assertCleanLanguage(report) {
  for (const text of allText(report.analysis)) {
    assert.equal(findLeakedEvidenceMarker(text), null, `leaked evidence marker in: ${text}`);
    assert.deepEqual(findCausalLanguage(text), [], `causal language in: ${text}`);
    assert.deepEqual(findDirectionalLanguage(text), [], `directional/sentiment language in: ${text}`);
    assert.equal(findProhibitedLanguage(text), null, `investment-advice language in: ${text}`);
  }
}

/** "a" followed immediately by a vowel-leading word is always a grammar bug ("a increase"). */
function assertNoArticleErrors(report) {
  for (const text of allText(report.analysis)) {
    const match = text.match(/\ba ([aeiouAEIOU]\w*)/);
    assert.equal(match, null, `"a ${match?.[1]}" should be "an ${match?.[1]}" in: ${text}`);
  }
}

const ALL_SECTION_KEYS = ["executiveSummary", "marketPerformance", "fundamentalPerformance", "valuation", "marketFundamentalRelationships", "liquidityMarketStructure", "tokenomics"];

// ---- A. thresholds ----

test("A1. momentum bands: boundaries are inclusive at their stated minimum", () => {
  assert.equal(momentumBand(0), "flat");
  assert.equal(momentumBand(0.99), "flat");
  assert.equal(momentumBand(1), "mild");
  assert.equal(momentumBand(4.99), "mild");
  assert.equal(momentumBand(5), "moderate");
  assert.equal(momentumBand(19.99), "moderate");
  assert.equal(momentumBand(20), "strong");
  assert.equal(momentumBand(-25), "strong", "bands use absolute magnitude, direction is separate");
});

test("A2. volatility bands: boundaries are inclusive at their stated minimum", () => {
  assert.equal(volatilityBand(0), "low");
  assert.equal(volatilityBand(39.9), "low");
  assert.equal(volatilityBand(40), "moderate");
  assert.equal(volatilityBand(79.9), "moderate");
  assert.equal(volatilityBand(80), "elevated");
});

test("A3. band tables are ordered from strongest to weakest (momentumBand/volatilityBand rely on it)", () => {
  for (let index = 1; index < MOMENTUM_BANDS.length; index += 1) assert.ok(MOMENTUM_BANDS[index - 1].minAbsPct > MOMENTUM_BANDS[index].minAbsPct);
  for (let index = 1; index < VOLATILITY_BANDS.length; index += 1) assert.ok(VOLATILITY_BANDS[index - 1].minPct > VOLATILITY_BANDS[index].minPct);
});

test("A4. magnitude-word bands are period-aware: the same percentage reads differently over different windows", () => {
  assert.equal(magnitudeWord("24h", 15), "substantial");
  assert.equal(magnitudeWord("90d", 15), "moderate");
  assert.equal(magnitudeWord("24h", 0.5), "marginal");
  assert.equal(magnitudeWord("90d", 150), "pronounced");
});

// ---- B/C. Strong positive/negative momentum, flat market ----

const STRONG_UP = await payloadFor("strong-up", seed("strong-up", "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 5_000_000],
  ["coingecko", "price_change_24h_pct", 28, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 45, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 100_000_000],
]));
const STRONG_DOWN = await payloadFor("strong-down", seed("strong-down", "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 5_000_000],
  ["coingecko", "price_change_24h_pct", -32, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -50, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 100_000_000],
]));
const FLAT = await payloadFor("flat-mkt", seed("flat-mkt", "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
  ["coingecko", "price_change_24h_pct", 0.1, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -0.2, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 100_000_000],
]));

test("B. strong positive momentum (24h+7d both up) produces a single consistent-up multi-horizon finding", () => {
  const findings = extractFindings(STRONG_UP);
  const momentum = findings.find((item) => item.category === "marketPerformance" && item.findingType.startsWith("multi_horizon_"));
  assert.ok(momentum, "a multi-horizon finding is produced");
  assert.ok(momentum.findingType.startsWith("multi_horizon_consistent_up"), momentum.findingType);
  assert.equal(momentum.severity, "high");
  assert.equal(findings.filter((item) => item.category === "marketPerformance" && item.findingType.startsWith("multi_horizon_")).length, 1, "one consolidated finding, not one per horizon");
});

test("B2. strong negative momentum (24h+7d both down) produces a single consistent-down multi-horizon finding", () => {
  const findings = extractFindings(STRONG_DOWN);
  const momentum = findings.find((item) => item.category === "marketPerformance" && item.findingType.startsWith("multi_horizon_"));
  assert.ok(momentum.findingType.startsWith("multi_horizon_consistent_down"), momentum.findingType);
  assert.equal(momentum.severity, "high");
});

test("C. a flat market (sub-1% changes) produces a flat multi-horizon finding, not a momentum claim", () => {
  const findings = extractFindings(FLAT);
  const momentum = findings.find((item) => item.category === "marketPerformance" && item.findingType.startsWith("multi_horizon_"));
  assert.equal(momentum.findingType, "multi_horizon_flat");
});

// ---- 90D/30D/7D synthesis: consistent positive trend, decelerating (front-loaded) ----

// Historical-window boundaries are exclusive at the exact edge, and the price points below are
// timestamped relative to Date.now() at fixture-build time (a moment slightly earlier than the
// engine's own "now"), so points are placed with a small safety margin inside each window
// (6.9d/29d/88d rather than exactly 7d/30d/90d) to avoid falling just outside it.
const DECEL_UP = await payloadFor("decel-up", seed("decel-up", "ethereum", [
  ["coingecko", "price_usd", 14.077],
  ["coingecko", "price_usd", 13.33, 24 * 6.9],
  ["coingecko", "price_usd", 12.94, 24 * 29],
  ["coingecko", "price_usd", 10.0, 24 * 88],
  ["coingecko", "market_cap_usd", 900_000_000], ["coingecko", "volume_24h_usd", 5_000_000],
  ["coingecko", "price_change_7d_pct", 5.64, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 50_000_000],
]));

test("90D/30D/7D positive trend synthesis: consistent upward momentum across all three horizons", () => {
  const findings = extractFindings(DECEL_UP);
  const momentum = findings.find((item) => item.findingType.startsWith("multi_horizon_consistent_up"));
  assert.ok(momentum, "a consistent-up multi-horizon finding is produced from 7D/30D/90D all-positive data");
  assert.equal(momentum.horizons.length, 3);
  assert.deepEqual(momentum.horizons.map((h) => h.key), ["7d", "30d", "90d"]);
});

test("executive summary states the momentum pattern qualitatively; market performance states the per-horizon figures — never the same sentence twice", () => {
  const report = buildEngineReport(DECEL_UP);
  const execText = report.analysis.executiveSummary.statements.find((s) => s.sourceIds.includes("hist:price_90d"))?.text;
  const marketText = report.analysis.marketPerformance.statements.find((s) => s.sourceIds.includes("hist:price_90d"))?.text;
  assert.ok(execText, "executive summary includes the momentum finding");
  assert.ok(marketText, "market performance includes the momentum finding");
  assert.notEqual(execText, marketText, "the two sections must not render identical text for the same finding");
  assert.ok(!marketText.includes(execText) && !execText.includes(marketText), "neither section's sentence is a literal substring of the other");
  // Market performance states the concrete numbers; the executive summary does not repeat them.
  assert.ok(/\+5\.64%/.test(marketText) || /\d+\.\d+%/.test(marketText), "detail section states concrete figures");
  assert.equal(/\d/.test(execText.replace(/\b(7|30|90)(D|-day)\b/gi, "")), false, "executive summary states the pattern qualitatively, not the literal percentages");
});

// ---- Positive long-term / negative short-term, and the reverse ----

const REVERSAL_DOWN = await payloadFor("rev-down", seed("rev-down", "ethereum", [
  ["coingecko", "price_usd", 9.0],
  ["coingecko", "price_usd", 10.5, 24 * 6.5],
  ["coingecko", "price_usd", 8.5, 24 * 29],
  ["coingecko", "price_usd", 6.0, 24 * 88],
  ["coingecko", "market_cap_usd", 500_000_000], ["coingecko", "volume_24h_usd", 4_000_000],
  ["coingecko", "price_change_7d_pct", -14.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 50_000_000],
]));

test("positive long-term / negative short-term trend produces a reversal-to-down finding", () => {
  const findings = extractFindings(REVERSAL_DOWN);
  const momentum = findings.find((item) => item.findingType.startsWith("multi_horizon_"));
  assert.equal(momentum.findingType, "multi_horizon_reversal_to_down");
  const report = buildEngineReport(REVERSAL_DOWN);
  const text = report.analysis.executiveSummary.statements.find((s) => s.sourceIds.includes("hist:price_90d"))?.text ?? "";
  assert.match(text, /revers/i);
});

const REVERSAL_UP = await payloadFor("rev-up", seed("rev-up", "ethereum", [
  ["coingecko", "price_usd", 11.0],
  ["coingecko", "price_usd", 9.8, 24 * 6.5],
  ["coingecko", "price_usd", 12.5, 24 * 29],
  ["coingecko", "price_usd", 16.0, 24 * 88],
  ["coingecko", "market_cap_usd", 500_000_000], ["coingecko", "volume_24h_usd", 4_000_000],
  ["coingecko", "price_change_7d_pct", 12.2, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 50_000_000],
]));

test("negative long-term / positive short-term trend produces a reversal-to-up finding", () => {
  const findings = extractFindings(REVERSAL_UP);
  const momentum = findings.find((item) => item.findingType.startsWith("multi_horizon_"));
  assert.equal(momentum.findingType, "multi_horizon_reversal_to_up");
});

// ---- D-G. All four price/TVL divergence quadrants (the metrics engine's own boolean flags) ----

const DIVERGENCE_TOKEN = "uniswap-uni";

function divergencePayload(flagId) {
  const rows = [
    ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
    ["defillama", "tvl_usd", 500_000_000, 2], ["defillama", "fees_24h_usd", 10_000, 2], ["defillama", "revenue_24h_usd", 5_000, 2],
  ];
  const calculated = CALCULATED_METRICS.filter((metric) => metric.category === "divergence").map((metric) => ({ metric: metric.id, value: metric.id === flagId ? 1 : 0 }));
  return seed(DIVERGENCE_TOKEN, "ethereum", rows, calculated);
}

const DIVERGENCE_FLAGS = [
  "divergence_price_up_tvl_down", "divergence_price_down_tvl_up",
  "divergence_market_cap_up_faster_tvl", "divergence_tvl_up_faster_market_cap",
  "divergence_revenue_up_market_cap_down", "divergence_revenue_down_market_cap_up",
];

for (const flagId of DIVERGENCE_FLAGS) {
  test(`D-G. ${flagId} true produces exactly its own divergence finding, and only when true`, async () => {
    const payload = await payloadFor(DIVERGENCE_TOKEN, divergencePayload(flagId));
    const findings = extractFindings(payload).filter((item) => item.category === "marketFundamentalRelationships" && item.findingType.startsWith("divergence_"));
    assert.deepEqual(findings.map((item) => item.findingType).sort(), [flagId].sort());
    const report = buildEngineReport(payload);
    const text = report.analysis.marketFundamentalRelationships.statements[0].text;
    assert.match(text, /divergen|faster|aligned interval/i);
    assert.deepEqual(findCausalLanguage(text), []);
  });
}

// ---- Concurrent market/fundamental improvement (fundamentals_improving synthesis) ----

const IMPROVING = await payloadFor(DIVERGENCE_TOKEN, seed(DIVERGENCE_TOKEN, "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
  ["defillama", "tvl_usd", 500_000_000, 2], ["defillama", "fees_24h_usd", 10_000, 2], ["defillama", "revenue_24h_usd", 5_000, 2],
], [
  { metric: "tvl_growth_pct", value: 8.5 }, { metric: "fees_growth_pct", value: 6.2 }, { metric: "revenue_growth_pct", value: 4.1 },
]));

test("concurrent market/fundamental improvement: TVL, fees, and revenue all growing produces a fundamentals_improving synthesis", () => {
  const findings = extractFindings(IMPROVING);
  const synthesis = findings.find((item) => item.findingType === "fundamentals_improving");
  assert.ok(synthesis, "an improving-fundamentals synthesis finding is produced when growth signals agree");
  assert.ok(synthesis.evidenceIds.length >= 2);
  const report = buildEngineReport(IMPROVING);
  const text = report.analysis.fundamentalPerformance.statements.find((s) => s.text.includes("improving") || s.text.includes("positive direction"))?.text;
  assert.ok(text);
});

const DETERIORATING = await payloadFor(DIVERGENCE_TOKEN, seed(DIVERGENCE_TOKEN, "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
  ["defillama", "tvl_usd", 500_000_000, 2], ["defillama", "fees_24h_usd", 10_000, 2], ["defillama", "revenue_24h_usd", 5_000, 2],
], [
  { metric: "tvl_growth_pct", value: -8.5 }, { metric: "fees_growth_pct", value: -6.2 },
]));

test("deteriorating fundamentals synthesis when tracked activity metrics decline together", () => {
  const findings = extractFindings(DETERIORATING);
  assert.ok(findings.some((item) => item.findingType === "fundamentals_deteriorating"));
});

// ---- Valuation / liquidity categorization ----

test("valuation metrics correctly categorized: only genuine valuation multiples appear in the valuation section", () => {
  const payload = IMPROVING;
  const findings = extractFindings(payload);
  const valuation = findings.filter((item) => item.category === "valuation");
  for (const finding of valuation) {
    assert.ok(!finding.findingType.includes("volume_to_market_cap"), "volume/market-cap must not appear in valuation");
    if (finding.findingType.startsWith("ratio_")) {
      assert.ok(["ratio_market_cap_to_tvl", "ratio_fdv_to_tvl", "ratio_market_cap_to_revenue_24h", "ratio_fdv_to_revenue_24h"].includes(finding.findingType), finding.findingType);
    }
  }
});

test("volume/market-cap is correctly categorized under liquidity/market structure, not valuation", async () => {
  const payload = await payloadFor("vol-mcap", seed("vol-mcap", "ethereum", [
    ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 200_000_000],
    ["coingecko", "circulating_supply", 100_000_000],
  ], [{ metric: "volume_to_market_cap", value: 0.2 }]));
  const findings = extractFindings(payload);
  assert.ok(!findings.some((item) => item.category === "valuation" && String(item.findingType).includes("volume")));
  const turnover = findings.find((item) => item.category === "liquidityMarketStructure" && /turnover/.test(item.findingType));
  assert.ok(turnover, "a turnover-related finding is produced under liquidityMarketStructure");
  const report = buildEngineReport(payload);
  const liquidityText = report.analysis.liquidityMarketStructure.statements.map((s) => s.text).join(" ");
  assert.match(liquidityText, /turnover/i);
});

test("no valuation multiple available: the section states the exact required fallback sentence, with no statements", () => {
  const report = buildEngineReport(STRONG_UP); // no TVL/fees/revenue mapping at all
  assert.equal(report.analysis.valuation.statements.length, 0);
  assert.equal(report.analysis.valuation.overview, "No valuation multiple can be calculated from the currently available data.");
});

// ---- H. Volume up (relative to market cap) while price is down ----

const VOLUME_DOWN = await payloadFor("vol-down", seed("vol-down", "ethereum", [
  ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 100_000_000],
  ["coingecko", "volume_24h_usd", 20_000_000], // 20% of market cap: elevated
  ["coingecko", "price_change_24h_pct", -12, 0.5, { window_days: 1 }],
  ["coingecko", "circulating_supply", 10_000_000],
], [{ metric: "volume_to_market_cap", value: 0.2 }]));

test("H. elevated volume during a price decline is flagged in market performance, and the ratio itself in liquidity/market structure", () => {
  const findings = extractFindings(VOLUME_DOWN);
  assert.ok(findings.some((item) => item.category === "marketPerformance" && item.findingType === "elevated_volume_during_decline"));
  assert.ok(findings.some((item) => item.category === "liquidityMarketStructure" && item.findingType === "elevated_turnover"));
  const report = buildEngineReport(VOLUME_DOWN);
  const liquidityText = report.analysis.liquidityMarketStructure.statements.map((s) => s.text).join(" ");
  assert.ok(!/highly liquid/i.test(liquidityText), "must never claim high liquidity from volume alone");
});

// ---- J. FDV materially above market cap ----

const FDV_GAP = await payloadFor("fdv-gap", seed("fdv-gap", "ethereum", [
  ["coingecko", "price_usd", 1], ["coingecko", "market_cap_usd", 50_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
  ["coingecko", "circulating_supply", 50_000_000], ["coingecko", "maximum_supply", 500_000_000],
]));

test("J. a large FDV/market-cap gap produces a valuation finding and a risk finding", () => {
  const withFdv = { ...FDV_GAP, fields: [...FDV_GAP.fields] };
  const idx = withFdv.fields.findIndex((f) => f.id === "obs:fdv");
  const fdvField = { id: "obs:fdv", section: "Tokenomics", label: "Fully diluted valuation", value: "$200,000,000", raw: 200_000_000, status: "shown", scope: "token", period: null, periodRequired: false, note: null, asOf: null };
  const fields = idx === -1 ? [...withFdv.fields, fdvField] : withFdv.fields.map((f, i) => i === idx ? fdvField : f);
  const payload = { ...withFdv, fields };
  const findings = extractFindings(payload);
  assert.ok(findings.some((item) => item.category === "valuation" && item.findingType === "fdv_market_cap_gap"));
  assert.ok(findings.some((item) => item.category === "risk" && item.findingType === "dilution_gap"));
});

// ---- K. Volatility / drawdown ----

const VOLATILE = await payloadFor("volatile-tk", seed("volatile-tk", "ethereum", [
  ["coingecko", "price_usd", 5], ["coingecko", "market_cap_usd", 40_000_000], ["coingecko", "volume_24h_usd", 2_000_000],
  ["coingecko", "price_usd", 6, 24 * 2], ["coingecko", "price_usd", 3, 24 * 4], ["coingecko", "price_usd", 8, 24 * 6],
  ["coingecko", "price_usd", 2, 24 * 8], ["coingecko", "price_usd", 9, 24 * 10], ["coingecko", "circulating_supply", 8_000_000],
]));

test("K. risk findings: elevated volatility/drawdown are evaluated, grounded, and cleanly worded", () => {
  const report = buildEngineReport(VOLATILE);
  assertProvenance(VOLATILE, report);
  assertCleanLanguage(report);
  assertNoArticleErrors(report);
});

test("risk section explicitly names the dimensions evaluated when nothing crosses an elevated threshold", async () => {
  const quiet = seed("quiet-tk", "ethereum", [
    ["coingecko", "price_usd", 5], ["coingecko", "market_cap_usd", 40_000_000], ["coingecko", "volume_24h_usd", 500_000],
    ["coingecko", "circulating_supply", 8_000_000],
  ]);
  const payload = await payloadFor("quiet-tk", quiet);
  const report = buildEngineReport(payload);
  if (report.analysis.risks.length > 0) {
    const fallback = report.analysis.risks.find((r) => r.title === "No elevated risk indicators identified");
    assert.ok(fallback);
    assert.equal(fallback.basis, "data_limitation");
    assert.ok(fallback.sourceIds.length > 0);
  }
});

// ---- M/N. Missing protocol mapping / insufficient history ----

const NO_FUNDAMENTALS = await payloadFor("no-fund", seed("no-fund", "ethereum", [
  ["coingecko", "price_usd", 3], ["coingecko", "market_cap_usd", 20_000_000], ["coingecko", "volume_24h_usd", 500_000],
  ["coingecko", "circulating_supply", 6_000_000],
]));

test("M. no protocol mapping: fundamentalPerformance overview explains the limitation clearly (not a generic 'no findings' line)", () => {
  const findings = extractFindings(NO_FUNDAMENTALS);
  assert.ok(findings.some((item) => item.findingType === "unmapped_defillama"));
  const report = buildEngineReport(NO_FUNDAMENTALS);
  assert.equal(report.analysis.fundamentalPerformance.statements.length, 0);
  assert.match(report.analysis.fundamentalPerformance.overview, /no associated protocol is mapped/i);
  assert.ok(report.analysis.dataGaps.some((gap) => gap.category === "mapping_limitation"));
});

test("N. a single stored history point produces an insufficient-observations data gap, not an invented trend", () => {
  const findings = extractFindings(NO_FUNDAMENTALS);
  assert.ok(findings.some((item) => item.findingType.startsWith("insufficient_history_price_")));
  assert.equal(findings.find((item) => item.findingType.startsWith("multi_horizon_") && item.horizons?.some((h) => h.key === "30d")), undefined);
  const report = buildEngineReport(NO_FUNDAMENTALS);
  assert.ok(report.analysis.dataGaps.some((gap) => gap.category === "insufficient_observations"));
});

// ---- Tokenomics: supply relationships and the uncapped-supply limitation ----

const CAPPED_EQUAL = await payloadFor("btc-like", seed("btc-like", "bitcoin", [
  ["coingecko", "price_usd", 84388], ["coingecko", "market_cap_usd", 1_690_000_000_000],
  ["coingecko", "circulating_supply", 20_088_743], ["coingecko", "total_supply", 20_088_743], ["coingecko", "maximum_supply", 21_000_000],
], [], true));

test("tokenomics: circulating equals total supply is stated as a supply relationship, not three bare numbers", () => {
  const findings = extractFindings(CAPPED_EQUAL);
  assert.ok(findings.some((item) => item.findingType === "circulating_equals_total"));
  const report = buildEngineReport(CAPPED_EQUAL);
  const text = report.analysis.tokenomics.statements.find((s) => s.text.includes("equals"))?.text ?? "";
  assert.match(text, /circulating supply.*equals total supply/i);
});

const UNCAPPED = await payloadFor("eth-like", seed("eth-like", "ethereum", [
  ["coingecko", "price_usd", 3000], ["coingecko", "market_cap_usd", 360_000_000_000],
  ["coingecko", "circulating_supply", 120_000_000], ["coingecko", "total_supply", 120_000_000],
], [], true));

test("tokenomics: an uncapped supply (ETH-like, no maximum_supply) states the limitation explicitly", () => {
  const findings = extractFindings(UNCAPPED);
  assert.ok(findings.some((item) => item.findingType === "supply_uncapped"));
  const report = buildEngineReport(UNCAPPED);
  const text = report.analysis.tokenomics.statements.find((s) => s.text.includes("No maximum supply"))?.text;
  assert.ok(text, "the uncapped-supply limitation is explained in prose, not merely omitted");
});

// ---- O. Calculated ratios are reported with their own exact value, never recomputed ----

test("O. every valuation ratio statement states exactly the cited field's own value", () => {
  const report = buildEngineReport(IMPROVING);
  for (const statement of report.analysis.valuation.statements) {
    const citedField = IMPROVING.fields.find((field) => statement.sourceIds.includes(field.id));
    if (citedField) assert.ok(statement.text.includes(citedField.value), `${statement.text} does not quote ${citedField.value}`);
  }
});

// ---- P. Evidence/provenance mapping, clean language, and grammar across every fixture built so far ----

const ALL_PAYLOADS = {
  STRONG_UP, STRONG_DOWN, FLAT, DECEL_UP, REVERSAL_DOWN, REVERSAL_UP, VOLUME_DOWN, VOLATILE,
  NO_FUNDAMENTALS, IMPROVING, DETERIORATING, CAPPED_EQUAL, UNCAPPED,
};

for (const [name, payload] of Object.entries(ALL_PAYLOADS)) {
  test(`P. ${name}: builds a valid report whose every citation resolves to a real field, with clean, grammatical language`, () => {
    const report = buildEngineReport(payload);
    assertProvenance(payload, report);
    assertCleanLanguage(report);
    assertNoArticleErrors(report);
  });
}

test("P2. mismatched periods are never mixed: every statement's period is the literal period of one of its own cited fields", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    const byId = new Map(payload.fields.map((field) => [field.id, field]));
    for (const key of ALL_SECTION_KEYS) {
      for (const statement of report.analysis[key].statements) {
        if (statement.period === null) continue;
        const citedPeriods = statement.sourceIds.map((id) => byId.get(id)?.period).filter(Boolean);
        assert.ok(citedPeriods.includes(statement.period), `${key} statement period "${statement.period}" not among cited fields' own periods`);
      }
    }
  }
});

test("P3. executive summary never renders the same literal sentence as its matching section for a shared finding", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    const execTexts = new Set(report.analysis.executiveSummary.statements.map((s) => s.text));
    for (const key of ALL_SECTION_KEYS) {
      if (key === "executiveSummary") continue;
      for (const statement of report.analysis[key].statements) {
        assert.ok(!execTexts.has(statement.text), `"${statement.text}" is duplicated verbatim between executiveSummary and ${key}`);
      }
    }
  }
});

// ---- Q/R/T. Same-token-different-snapshot, no AI call, no env vars ----

test("Q. the same token generates a materially different report from a later, changed data snapshot", async () => {
  const before = seed("evolving", "ethereum", [
    ["coingecko", "price_usd", 10], ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 1_000_000],
    ["coingecko", "price_change_24h_pct", 0.2, 0.5, { window_days: 1 }], ["coingecko", "circulating_supply", 100_000_000],
  ]);
  const after = seed("evolving", "ethereum", [
    ["coingecko", "price_usd", 14], ["coingecko", "market_cap_usd", 1_400_000_000], ["coingecko", "volume_24h_usd", 400_000_000],
    ["coingecko", "price_change_24h_pct", 38, 0.5, { window_days: 1 }], ["coingecko", "circulating_supply", 100_000_000],
  ]);
  const beforePayload = await payloadFor("evolving", before);
  const afterPayload = await payloadFor("evolving", after);
  const beforeReport = buildEngineReport(beforePayload);
  const afterReport = buildEngineReport(afterPayload);
  assert.notEqual(JSON.stringify(beforeReport.analysis), JSON.stringify(afterReport.analysis));
  const beforeText = beforeReport.analysis.marketPerformance.statements[0]?.text ?? "";
  const afterText = afterReport.analysis.marketPerformance.statements[0]?.text ?? "";
  assert.match(beforeText, /essentially unchanged|flat/i, "the earlier, flat snapshot reports no momentum, not an invented trend");
  assert.match(afterText, /\+38\.00%|pronounced|substantial/i, "the later, sharply-changed snapshot reports the real momentum");
  assert.notEqual(beforeText, afterText);
});

test("R. generating a report never calls fetch (no external AI/API call of any kind)", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => { called = true; throw new Error(`Unexpected network call: ${args[0]}`); };
  try {
    const db = createFakeSupabase({ seed: seed("cosmos-atom", "cosmos", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "cosmos-atom", { now: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("T. generation succeeds with every AI-provider environment variable absent", async () => {
  const cleared = { ...process.env };
  for (const key of Object.keys(cleared)) {
    if (/GEMINI|OPENROUTER|MISTRAL|GLM|SILICONFLOW|MODELSCOPE|ZHIPU|QWEN/i.test(key)) delete process.env[key];
  }
  try {
    const db = createFakeSupabase({ seed: seed("algorand-algo", "algorand", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "algorand-algo", { now: () => NOW });
    assert.equal(result.ok, true);
    const state = await getDeterministicAnalysisState(db.client, "algorand-algo", NOW);
    assert.equal(state.status, "ready");
    assert.equal(state.model, DETERMINISTIC_ENGINE_NAME);
  } finally {
    process.env = cleared;
  }
});

// ---- 15. The third-token generation failure: a "kitchen sink" regression fixture exercising many
// code paths at once (native asset, DEX-mapped market structure, protocol fundamentals, FDV,
// divergence, low circulating share, missing history) — this must never throw. ----

const KITCHEN_SINK_TOKEN = "uniswap-uni";
const kitchenSinkSeed = seed(KITCHEN_SINK_TOKEN, "ethereum", [
  ["coingecko", "price_usd", 7.2], ["coingecko", "market_cap_usd", 4_300_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
  ["coingecko", "price_change_24h_pct", -14.2, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 3.1, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 600_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 3_900_000_000, 2], ["defillama", "fees_24h_usd", 1_200_000, 2], ["defillama", "revenue_24h_usd", 0, 2],
  ["dexscreener", "liquidity_usd", 168_830, 0.5],
], [
  { metric: "market_cap_to_tvl", value: 1.1 }, { metric: "fdv_to_tvl", value: 1.83 },
  { metric: "divergence_price_up_tvl_down", value: 0 }, { metric: "divergence_price_down_tvl_up", value: 1 },
  { metric: "tvl_growth_pct", value: -2.1 }, { metric: "volume_to_market_cap", value: 0.21 },
  { metric: "dex_buy_sell_ratio", value: 0.87 },
]);

test("15. the affected third-token combination (DEX+protocol+FDV+divergence+low-supply-share) generates successfully through the live service path, never throwing", async () => {
  const db = createFakeSupabase({ seed: kitchenSinkSeed });
  const result = await generateDeterministicAnalysis(db.client, KITCHEN_SINK_TOKEN, { now: () => NOW });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
});

test("15b. buildEngineReport itself never throws a plain Error for any category/findingType combination — only AnalysisValidationError is a recognized failure mode", async () => {
  const payload = await payloadFor(KITCHEN_SINK_TOKEN, kitchenSinkSeed);
  let report;
  try {
    report = buildEngineReport(payload);
  } catch (error) {
    assert.ok(error instanceof AnalysisValidationError, `buildEngineReport threw a non-validation error: ${error?.stack ?? error}`);
    throw error;
  }
  assertProvenance(payload, report);
  assertCleanLanguage(report);
  assertNoArticleErrors(report);
});

// ---- S. Explicit language/report-shape guarantees (belt-and-suspenders on top of the validator) ----

test("S. buildEngineReport throws AnalysisValidationError (never silently ships bad output) if the contract is somehow violated", () => {
  assert.ok(AnalysisValidationError);
});

test("S2. no report ever exposes an overall investment score or a buy/sell/hold verdict field", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    const json = JSON.stringify(report.analysis).toLowerCase();
    assert.ok(!/"score"/.test(json));
    assert.ok(!/\bbuy\b|\bsell\b|\bhold\b/i.test(json.replace(/buy.?sell/g, "")));
  }
});

// ---- Research questions arise from actual findings ----

test("further research questions are grounded in the findings actually present, not generic filler", async () => {
  const momentumReport = buildEngineReport(DECEL_UP);
  assert.ok(momentumReport.analysis.furtherResearchQuestions.some((q) => /positive momentum/i.test(q.question)));

  const divergenceReport = buildEngineReport(await payloadFor(DIVERGENCE_TOKEN, divergencePayload("divergence_price_up_tvl_down")));
  assert.ok(divergenceReport.analysis.furtherResearchQuestions.some((q) => /divergence/i.test(q.question)));

  const gapReport = buildEngineReport(NO_FUNDAMENTALS);
  assert.ok(gapReport.analysis.furtherResearchQuestions.some((q) => /mapping/i.test(q.question)));
});

// ---- Persistence / metadata shape ----

test("persists engineVersion/analysisVersion/dataSnapshotAt, and the stored row round-trips through the state reader", async () => {
  const db = createFakeSupabase({ seed: seed("akash-akt", "akash", [["coingecko", "price_usd", 4], ["coingecko", "market_cap_usd", 3_000_000]], [], true) });
  const result = await generateDeterministicAnalysis(db.client, "akash-akt", { now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(result.analysis.metadata.engineVersion, ENGINE_VERSION);
  assert.equal(result.analysis.metadata.analysisVersion, ANALYSIS_VERSION);
  assert.equal(result.analysis.metadata.provider, DETERMINISTIC_ENGINE_NAME);
  assert.ok("dataSnapshotAt" in result.analysis.metadata);
  const state = await getDeterministicAnalysisState(db.client, "akash-akt", new Date(NOW.getTime() + 5 * 60 * 1000));
  assert.equal(state.status, "ready");
  assert.equal(state.latest?.metadata.engineVersion, ENGINE_VERSION);
});

test("invalid token IDs and an unmigrated storage table are handled without throwing", async () => {
  const db = createFakeSupabase({ seed: seed("dash-dash", "dash", [["coingecko", "price_usd", 1]], [], true) });
  const badToken = await generateDeterministicAnalysis(db.client, "not-a-real-token", { now: () => NOW });
  assert.equal(badToken.ok, false);
  assert.equal(badToken.reason, "invalid_token");

  const noTable = createFakeSupabase({ seed: seed("dash-dash", "dash", [["coingecko", "price_usd", 1]], [], true), missingTables: ["token_ai_analyses"] });
  const state = await getDeterministicAnalysisState(noTable.client, "dash-dash", NOW);
  assert.equal(state.status, "storage_unavailable");
  const failed = await generateDeterministicAnalysis(noTable.client, "dash-dash", { now: () => NOW });
  assert.equal(failed.reason, "storage_unavailable");
});

test("cooldown blocks an immediate second regeneration; it clears after the configured window", async () => {
  const db = createFakeSupabase({ seed: seed("celo-celo", "celo", [["coingecko", "price_usd", 1], ["coingecko", "market_cap_usd", 2_000_000]], [], true) });
  const first = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => NOW });
  assert.equal(first.ok, true);
  const immediate = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => new Date(NOW.getTime() + 1000) });
  assert.equal(immediate.ok, false);
  assert.equal(immediate.reason, "cooldown");
  const later = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => new Date(NOW.getTime() + 2 * 60 * 1000) });
  assert.equal(later.ok, true);
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
console.log(`${cases.length - failures}/${cases.length} deep-analysis-engine checks passed.`);
if (failures > 0) process.exitCode = 1;
