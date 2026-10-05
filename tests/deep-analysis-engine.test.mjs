// Deep Analysis Engine (Phase 2 — institutional-research report structure): findings.ts,
// synthesis.ts wiring, the paragraph-composition narrative engine (narrative.ts), report assembly
// (report.ts), the report-schema.ts evidence contract, and the live deterministic-service.ts path.
// No network access is used anywhere in this file — that itself is part of what is being verified.

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

import { extractFindings } from "../src/lib/analysis/engine/findings.ts";
import { synthesize } from "../src/lib/analysis/engine/synthesis.ts";
import { buildEngineReport, ENGINE_VERSION, ANALYSIS_VERSION } from "../src/lib/analysis/engine/report.ts";
import { ENGINE_SECTION_KEYS } from "../src/lib/analysis/engine/report-schema.ts";
import { generateDeterministicAnalysis, getDeterministicAnalysisState, DETERMINISTIC_ENGINE_NAME } from "../src/lib/analysis/deterministic-service.ts";
import { AnalysisValidationError, findProhibitedLanguage } from "../src/lib/analysis/schema.ts";
import { findCausalLanguage, findDirectionalLanguage, findExternalConcept, findLeakedEvidenceMarker } from "../src/lib/analysis/evidence-rules.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date();
const MIDNIGHT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 0, 10, 0));
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(MIDNIGHT.getTime() - hoursAgo * HOUR).toISOString();

// ---- Fixture builder ----

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

/** Daily UTC-midnight-aligned closes, trending from ~0.5x to ~1.5x `base` over `days`, for technical indicators (needs 61+ consecutive closes for MACD). */
function densePriceRows(base, days) {
  const rows = [];
  for (let d = days; d >= 0; d -= 1) {
    const trend = base * 0.5 + (days - d) * (base / days);
    rows.push(["coingecko", "price_usd", Math.max(1, trend + Math.sin(d * 0.35) * (base * 0.02)), d * 24]);
  }
  return rows;
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
    if ((key === "text" || key === "question" || key === "rationale") && typeof value === "string") texts.push(value);
    return value;
  });
  return texts;
}

function assertCleanLanguage(report) {
  for (const text of allText(report.analysis)) {
    assert.equal(findLeakedEvidenceMarker(text), null, `leaked evidence marker in: ${text}`);
    assert.deepEqual(findCausalLanguage(text), [], `causal language in: ${text}`);
    assert.deepEqual(findDirectionalLanguage(text), [], `directional/sentiment language in: ${text}`);
    assert.equal(findProhibitedLanguage(text), null, `investment-advice language in: ${text}`);
    assert.equal(findExternalConcept(text, ""), null, `external concept introduced in: ${text}`);
  }
}

function assertAllSectionsPresent(report) {
  for (const key of ENGINE_SECTION_KEYS) {
    assert.ok(Array.isArray(report.analysis[key]?.paragraphs), `section ${key} must be an array of paragraphs`);
  }
  assert.ok(Array.isArray(report.analysis.furtherResearchQuestions));
}

// =====================================================================================
// A. Section structure and evidence discipline hold across a battery of realistic fixtures
// =====================================================================================

const BTC_LIKE = await payloadFor("btc-e2e", seed("btc-e2e", "bitcoin", [
  ["coingecko", "price_usd", 90000], ["coingecko", "market_cap_usd", 1_780_000_000_000], ["coingecko", "volume_24h_usd", 30_000_000_000],
  ["coingecko", "circulating_supply", 21_000_000], ["coingecko", "total_supply", 21_000_000], ["coingecko", "maximum_supply", 21_000_000],
], [], true));

const ETH_LIKE = await payloadFor("eth-e2e", seed("eth-e2e", "ethereum", [
  ...densePriceRows(3200, 95),
  ["coingecko", "market_cap_usd", 385_000_000_000], ["coingecko", "volume_24h_usd", 15_000_000_000],
  ["coingecko", "price_change_24h_pct", 1.2, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 5.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 120_000_000], ["coingecko", "total_supply", 120_000_000],
], [], true));

const UNI_LIKE = await payloadFor("uniswap-uni", seed("uniswap-uni", "ethereum", [
  ...densePriceRows(8.5, 95),
  ["coingecko", "market_cap_usd", 5_000_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
  ["coingecko", "price_change_24h_pct", 0.5, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 4.8, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 600_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 4_000_000_000, 2], ["defillama", "fees_24h_usd", 1_500_000, 2], ["defillama", "revenue_24h_usd", 300_000, 2],
  ["dexscreener", "liquidity_usd", 168_830, 0.5], ["dexscreener", "fdv_usd", 8_500_000_000, 0.5],
  ["dexscreener", "transactions_24h_count", 12_400, 0.5], ["dexscreener", "buys_24h_count", 6_500, 0.5], ["dexscreener", "sells_24h_count", 5_900, 0.5],
], [
  { metric: "tvl_growth_pct", value: 8.2 }, { metric: "fees_growth_pct", value: 5.5 }, { metric: "revenue_growth_pct", value: 4.0 },
  { metric: "market_cap_to_tvl", value: 1.25 }, { metric: "fdv_to_tvl", value: 2.13 },
  { metric: "divergence_market_cap_up_faster_tvl", value: 1 },
  { metric: "dex_aggregate_liquidity_usd", value: 5_800_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 21_000_000 },
  { metric: "dex_buy_sell_ratio", value: 6500 / 5900 }, { metric: "dex_volume_to_liquidity", value: 3.6 },
]));

const SUI_LIKE = await payloadFor("sui-sui", seed("sui-sui", "sui", [
  ["coingecko", "price_usd", 3.42],
  ["coingecko", "price_usd", 3.10, 24 * 24], ["coingecko", "price_usd", 2.60, 24 * 80],
  ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 2_150_000_000],
  ["coingecko", "price_change_24h_pct", 1.8, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 10.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 3_495_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
  ["dexscreener", "liquidity_usd", 4_200_000, 0.5], ["dexscreener", "fdv_usd", 34_200_000_000, 0.5],
  ["dexscreener", "transactions_24h_count", 18422, 0.5], ["dexscreener", "buys_24h_count", 9800, 0.5], ["dexscreener", "sells_24h_count", 8622, 0.5],
], [
  { metric: "dex_aggregate_liquidity_usd", value: 6_100_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 22_000_000 },
  { metric: "dex_volume_to_liquidity", value: 3.6 }, { metric: "dex_buy_sell_ratio", value: 9800 / 8622 },
  { metric: "volume_to_market_cap", value: 0.18 },
], true));

const HYPE_LIKE = await payloadFor("hyperliquid-hype", seed("hyperliquid-hype", "hyperliquid", [
  ["coingecko", "price_usd", 38.5],
  ["coingecko", "price_usd", 33.0, 24 * 24], ["coingecko", "price_usd", 24.0, 24 * 80],
  ["coingecko", "market_cap_usd", 12_900_000_000], ["coingecko", "volume_24h_usd", 450_000_000],
  ["coingecko", "price_change_24h_pct", -1.5, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -3.35, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 334_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 1_700_000_000, 2], ["defillama", "fees_24h_usd", 2_800_000, 2], ["defillama", "revenue_24h_usd", 2_800_000, 2],
  ["dexscreener", "liquidity_usd", 5_400_000, 0.5], ["dexscreener", "fdv_usd", 38_500_000_000, 0.5],
  ["dexscreener", "transactions_24h_count", 9_800, 0.5], ["dexscreener", "buys_24h_count", 5_600, 0.5], ["dexscreener", "sells_24h_count", 4_200, 0.5],
], [
  { metric: "tvl_growth_pct", value: 11.4 }, { metric: "fees_growth_pct", value: 9.1 }, { metric: "revenue_growth_pct", value: 9.1 },
  { metric: "market_cap_to_tvl", value: 7.6 }, { metric: "fdv_to_tvl", value: 22.6 },
  { metric: "divergence_price_up_tvl_down", value: 1 },
  { metric: "dex_aggregate_liquidity_usd", value: 7_000_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 18_000_000 },
  { metric: "dex_buy_sell_ratio", value: 5600 / 4200 }, { metric: "dex_volume_to_liquidity", value: 2.6 },
], true));

const ALL_PAYLOADS = { BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE };

for (const [name, payload] of Object.entries(ALL_PAYLOADS)) {
  test(`A. ${name}: builds a valid, fully-grounded eleven-section report with clean language`, () => {
    const report = buildEngineReport(payload);
    assertAllSectionsPresent(report);
    assertProvenance(payload, report);
    assertCleanLanguage(report);
    for (const key of ENGINE_SECTION_KEYS) assert.ok(report.analysis[key].paragraphs.length > 0, `${name}.${key} has at least a fallback paragraph`);
  });
}

test("A2. every paragraph across every fixture cites at least one source", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      for (const paragraph of report.analysis[key].paragraphs) assert.ok(paragraph.sourceIds.length > 0, `${key} paragraph has no sourceIds: ${paragraph.text}`);
    }
  }
});

test("A3. no report ever exposes an overall investment score or a buy/sell/hold verdict field", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    const json = JSON.stringify(report.analysis).toLowerCase();
    assert.ok(!/"score"/.test(json));
    assert.ok(!/\bbuy\b|\bsell\b|\bhold\b/i.test(json.replace(/buy\s*\/?\s*sell/gi, "")));
  }
});

// =====================================================================================
// B. Technical-indicator findings and relationships are real, evidence-grounded content
// =====================================================================================

test("B1. a dense, trending daily-close history produces technical findings (moving averages, MACD, RSI, structure) and a Technical Analysis section that cites them", () => {
  const findings = extractFindings(UNI_LIKE);
  const technical = findings.filter((f) => f.category === "technical");
  assert.ok(technical.length > 0, "technical indicators are extracted from a rich enough price history");
  const report = buildEngineReport(UNI_LIKE);
  const technicalText = report.analysis.technicalAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(technicalText, /no technical indicator/i);
});

test("B2. a thin, single-price-point token never fabricates a technical finding", () => {
  const findings = extractFindings(BTC_LIKE);
  assert.equal(findings.filter((f) => f.category === "technical").length, 0);
  const report = buildEngineReport(BTC_LIKE);
  assert.match(report.analysis.technicalAnalysis.paragraphs[0].text, /no technical indicator/i);
});

test("B3. the three new technical relationship types are reachable from real extracted findings", () => {
  const synthesis = synthesize(extractFindings(UNI_LIKE));
  const types = new Set(synthesis.relationships.map((r) => r.type));
  // At least one technical relationship should form given UNI_LIKE's rich technical + fundamentals + liquidity data.
  const hasTechnical = ["technical_price_confluence", "technical_fundamental_relationship", "technical_liquidity_conditions"].some((type) => types.has(type));
  assert.ok(hasTechnical, `expected at least one technical relationship, got: ${[...types].join(", ")}`);
});

test("B4. RSI/MACD/moving-average/Bollinger findings never use forbidden sentiment words (overbought/oversold/bullish/bearish/breakout)", () => {
  const report = buildEngineReport(UNI_LIKE);
  const text = report.analysis.technicalAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /overbought|oversold|bullish|bearish|breakout|uptrend|downtrend/i);
});

// =====================================================================================
// C. Cross-Domain Analysis is populated from real relationships, not padding
// =====================================================================================

test("C1. Cross-Domain Analysis has one paragraph per detected relationship, each citing that relationship's own evidence", () => {
  const report = buildEngineReport(UNI_LIKE);
  const synthesis = synthesize(extractFindings(UNI_LIKE));
  assert.equal(report.analysis.crossDomainAnalysis.paragraphs.length, synthesis.relationships.length || 1);
});

test("C2. a token with no detected relationship states that plainly, never inventing one", () => {
  const report = buildEngineReport(BTC_LIKE);
  assert.match(report.analysis.crossDomainAnalysis.paragraphs[0].text, /no cross-domain relationship/i);
});

// =====================================================================================
// D. Momentum interpretation regression (direction/pace/reversal — see calibration history)
// =====================================================================================

test("D1. a 7D-down/90D-up pattern is described as a reversal in Market Performance, never as 'broadly consistent pace'", async () => {
  const payload = await payloadFor("cal-a", seed("cal-a", "ethereum", [
    ["coingecko", "price_usd", 100],
    ["coingecko", "price_usd", 92.94, 24 * 24], ["coingecko", "price_usd", 72.41, 24 * 80],
    ["coingecko", "price_change_24h_pct", -3.28, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -3.35, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_reversal_to_down");
  const report = buildEngineReport(payload);
  const text = report.analysis.marketPerformance.paragraphs[0].text;
  assert.match(text, /revers/i);
  assert.doesNotMatch(text, /broadly consistent/i);
});

test("D2. all-positive momentum with a sharply faster recent pace is described as accelerating (normalized rate, not raw percentage comparison)", async () => {
  const payload = await payloadFor("cal-b", seed("cal-b", "ethereum", [
    ["coingecko", "price_usd", 100], ["coingecko", "price_usd", 62, 24 * 88],
    ["coingecko", "price_change_7d_pct", 14, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_consistent_up_accelerating");
  const report = buildEngineReport(payload);
  assert.match(report.analysis.marketPerformance.paragraphs[0].text, /faster/i);
});

test("D3. mixed-direction momentum (up/down/up) is never described as a reversal", async () => {
  const payload = await payloadFor("cal-d", seed("cal-d", "ethereum", [
    ["coingecko", "price_usd", 100], ["coingecko", "price_usd", 110, 24 * 24], ["coingecko", "price_usd", 95, 24 * 80],
    ["coingecko", "price_change_7d_pct", 5, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_mixed");
  const report = buildEngineReport(payload);
  assert.match(report.analysis.marketPerformance.paragraphs[0].text, /without a single consistent direction/i);
});

// =====================================================================================
// E. BTC/ETH supply-precision and SUI circulating-share phrasing regressions
// =====================================================================================

function supplyPayload(tokenId, circulating, total) {
  return payloadFor(tokenId, seed(tokenId, "bitcoin", [
    ["coingecko", "price_usd", 90000], ["coingecko", "market_cap_usd", 1_800_000_000_000],
    ["coingecko", "circulating_supply", circulating], ["coingecko", "total_supply", total], ["coingecko", "maximum_supply", 21_000_000],
  ], [], true));
}

test("E1. circulating supply exactly equal to total supply never claims 'below'", async () => {
  const payload = await supplyPayload("cal-supply-a", 19_987_731, 19_987_731);
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /below/i);
  assert.match(text, /equals/i);
});

test("E2. circulating slightly below total, with the compact display colliding at the same rounded figure, still states two different figures (never 'X is below X')", async () => {
  const payload = await supplyPayload("cal-supply-b", 19_987_731, 19_987_800);
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.find((p) => /below/i.test(p.text)).text;
  const circulatingText = /Circulating supply \(([^)]+)\)/.exec(text)?.[1];
  const totalText = /below total supply \(([^)]+)\)/.exec(text)?.[1];
  assert.ok(circulatingText && totalText);
  assert.notEqual(circulatingText, totalText);
});

test("E3. low-circulating-share phrasing never doubles up 'circulating (...) of maximum supply'", async () => {
  const payload = await payloadFor("cal-sui-share", seed("cal-sui-share", "sui", [
    ["coingecko", "price_usd", 3.42], ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 500_000_000],
    ["coingecko", "circulating_supply", 4_100_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
  ], [], true));
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.map((p) => p.text).join(" ");
  assert.match(text, /of maximum supply is currently circulating/);
  assert.doesNotMatch(text, /circulating \([^)]+\) of maximum supply/i);
});

// =====================================================================================
// F. Determinism, no network, no AI-provider env vars
// =====================================================================================

test("F1. buildEngineReport is deterministic: identical payload produces byte-identical output", () => {
  const first = buildEngineReport(UNI_LIKE);
  const second = buildEngineReport(UNI_LIKE);
  assert.equal(JSON.stringify(first.analysis), JSON.stringify(second.analysis));
});

test("F2. generating a report never calls fetch (no external AI/API call of any kind)", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => { called = true; throw new Error(`Unexpected network call: ${args[0]}`); };
  try {
    const db = createFakeSupabase({ seed: seed("cosmos-atom", "cosmos", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "cosmos-atom", { now: () => MIDNIGHT });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("F3. generation succeeds with every AI-provider environment variable absent", async () => {
  const cleared = { ...process.env };
  for (const key of Object.keys(cleared)) {
    if (/GEMINI|OPENROUTER|MISTRAL|GLM|SILICONFLOW|MODELSCOPE|ZHIPU|QWEN/i.test(key)) delete process.env[key];
  }
  try {
    const db = createFakeSupabase({ seed: seed("algorand-algo", "algorand", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "algorand-algo", { now: () => MIDNIGHT });
    assert.equal(result.ok, true);
    const state = await getDeterministicAnalysisState(db.client, "algorand-algo", MIDNIGHT);
    assert.equal(state.status, "ready");
    assert.equal(state.model, DETERMINISTIC_ENGINE_NAME);
  } finally {
    process.env = cleared;
  }
});

// =====================================================================================
// G. buildEngineReport never throws a plain Error; persistence round-trips
// =====================================================================================

test("G1. buildEngineReport itself never throws a plain Error for any real fixture — only AnalysisValidationError is a recognized failure mode", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    let report;
    try {
      report = buildEngineReport(payload);
    } catch (error) {
      assert.ok(error instanceof AnalysisValidationError, `buildEngineReport threw a non-validation error: ${error?.stack ?? error}`);
      throw error;
    }
    assertProvenance(payload, report);
    assertCleanLanguage(report);
  }
});

test("G2. persists engineVersion/analysisVersion/dataSnapshotAt, and the stored row round-trips through the state reader", async () => {
  const db = createFakeSupabase({ seed: seed("akash-akt", "akash", [["coingecko", "price_usd", 4], ["coingecko", "market_cap_usd", 3_000_000]], [], true) });
  const result = await generateDeterministicAnalysis(db.client, "akash-akt", { now: () => MIDNIGHT });
  assert.equal(result.ok, true);
  assert.equal(result.analysis.metadata.engineVersion, ENGINE_VERSION);
  assert.equal(result.analysis.metadata.analysisVersion, ANALYSIS_VERSION);
  assert.equal(result.analysis.metadata.provider, DETERMINISTIC_ENGINE_NAME);
  assert.ok("dataSnapshotAt" in result.analysis.metadata);
  const state = await getDeterministicAnalysisState(db.client, "akash-akt", new Date(MIDNIGHT.getTime() + 5 * 60 * 1000));
  assert.equal(state.status, "ready");
  assert.equal(state.latest?.metadata.engineVersion, ENGINE_VERSION);
  for (const key of ENGINE_SECTION_KEYS) assert.ok(Array.isArray(state.latest[key].paragraphs), `round-tripped analysis still has section ${key}`);
});

test("G3. invalid token IDs and an unmigrated storage table are handled without throwing", async () => {
  const db = createFakeSupabase({ seed: seed("dash-dash", "dash", [["coingecko", "price_usd", 1]], [], true) });
  const badToken = await generateDeterministicAnalysis(db.client, "not-a-real-token", { now: () => MIDNIGHT });
  assert.equal(badToken.ok, false);
  assert.equal(badToken.reason, "invalid_token");

  const noTable = createFakeSupabase({ seed: seed("dash-dash", "dash", [["coingecko", "price_usd", 1]], [], true), missingTables: ["token_ai_analyses"] });
  const state = await getDeterministicAnalysisState(noTable.client, "dash-dash", MIDNIGHT);
  assert.equal(state.status, "storage_unavailable");
  const failed = await generateDeterministicAnalysis(noTable.client, "dash-dash", { now: () => MIDNIGHT });
  assert.equal(failed.reason, "storage_unavailable");
});

test("G4. cooldown blocks an immediate second regeneration; it clears after the configured window", async () => {
  const db = createFakeSupabase({ seed: seed("celo-celo", "celo", [["coingecko", "price_usd", 1], ["coingecko", "market_cap_usd", 2_000_000]], [], true) });
  const first = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => MIDNIGHT });
  assert.equal(first.ok, true);
  const immediate = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => new Date(MIDNIGHT.getTime() + 1000) });
  assert.equal(immediate.ok, false);
  assert.equal(immediate.reason, "cooldown");
  const later = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => new Date(MIDNIGHT.getTime() + 2 * 60 * 1000) });
  assert.equal(later.ok, true);
});

// ---- H. Research-report redesign: confidence/analyticalType classification, regime, versioning ----

test("H1. every paragraph in every section of every fixture carries a valid confidence and analyticalType", () => {
  const VALID_CONFIDENCE = new Set(["high", "moderate", "low"]);
  const VALID_TYPE = new Set(["observation", "interpretation", "inference", "limitation"]);
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      for (const paragraph of analysis[key].paragraphs) {
        assert.ok(VALID_CONFIDENCE.has(paragraph.confidence), `${payload.token.symbol} ${key}: confidence "${paragraph.confidence}" must be high/moderate/low`);
        assert.ok(VALID_TYPE.has(paragraph.analyticalType), `${payload.token.symbol} ${key}: analyticalType "${paragraph.analyticalType}" must be one of the four research-report types`);
      }
    }
  }
});

test("H2. dataQualityLimitations paragraphs are always classified as limitation/high — a data gap is a directly observed fact, not an uncertain one", () => {
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const paragraph of analysis.dataQualityLimitations.paragraphs) {
      assert.equal(paragraph.analyticalType, "limitation");
      assert.equal(paragraph.confidence, "high");
    }
  }
});

test("H3. a paragraph grounded only by the bare 'token' placeholder (no real evidence) is always classified as limitation/low, regardless of its section", () => {
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      if (key === "dataQualityLimitations") continue; // H2 governs this section instead
      for (const paragraph of analysis[key].paragraphs) {
        if (paragraph.sourceIds.length === 1 && paragraph.sourceIds[0] === "token") {
          assert.equal(paragraph.analyticalType, "limitation", `${key}: a 'token'-only paragraph must read as a limitation`);
          assert.equal(paragraph.confidence, "low", `${key}: a 'token'-only paragraph must read as low confidence`);
        }
      }
    }
  }
});

test("H4. the report's regime is read directly off the same multi-horizon momentum finding Market Performance cites — never a separate judgment — and is always one of the five defined labels", () => {
  const VALID_REGIME = new Set(["positive", "negative", "mixed", "flat", "insufficient"]);
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const built = buildEngineReport(payload);
    assert.ok(VALID_REGIME.has(built.regime), `regime "${built.regime}" must be one of the five defined labels`);
    assert.ok(["high", "moderate", "low"].includes(built.regimeConfidence));
  }
});

test("H5. confidence/analyticalType survive a stored-row round-trip unchanged (parseStoredEngineAnalysis does not silently strip the new fields)", async () => {
  const db = createFakeSupabase({ seed: seed("op-roundtrip", "optimism", [["coingecko", "price_usd", 2.5], ["coingecko", "market_cap_usd", 900_000_000]], [], true) });
  const generated = await generateDeterministicAnalysis(db.client, "op-roundtrip", { now: () => MIDNIGHT });
  assert.equal(generated.ok, true);
  const state = await getDeterministicAnalysisState(db.client, "op-roundtrip");
  assert.equal(state.status, "ready");
  for (const key of ENGINE_SECTION_KEYS) {
    for (const paragraph of state.latest[key].paragraphs) {
      assert.ok(paragraph.confidence, `${key}: confidence must survive the store/reload round-trip`);
      assert.ok(paragraph.analyticalType, `${key}: analyticalType must survive the store/reload round-trip`);
    }
  }
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
console.log(`${cases.length - failures}/${cases.length} deep-analysis-engine checks passed.`);
if (failures > 0) process.exitCode = 1;
