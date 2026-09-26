// Local (browser) Deep AI Analysis proof of concept: prompt parity with the external path,
// and the unchanged schema + evidence validator applied to local model output. No network, no model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { PROFILE_SYSTEM_INSTRUCTION, buildProfileUserContent } from "../src/lib/analysis/prompt.ts";
import { LOCAL_EVIDENCE_INSTRUCTION, LOCAL_MODEL, buildLocalPrompt, finalizeLocalAnalysis } from "../src/lib/analysis/local/local-analysis.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
let id = 1000;
const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
  id: id++, token_id: "uniswap-uni", chain_id: "ethereum", provider_id: provider, metric_id: metric, value,
  status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
});
const seed = {
  tokens: [{ id: "uniswap-uni", name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null }],
  chains: [{ id: "ethereum", name: "Ethereum" }],
  token_metric_observations: [
    ["coingecko", "price_usd", 9.33], ["coingecko", "market_cap_usd", 5_790_000_000], ["coingecko", "price_change_7d_pct", 32.95, 0.5, { window_days: 7 }],
    ["coingecko", "maximum_supply", null],
  ].map(obs),
  metric_definitions: [],
  calculated_metric_observations: [],
  calculated_metric_definitions: CALCULATED_METRICS.map((metric) => ({ id: metric.id, category: metric.category, source_scopes: metric.sourceScopes })),
};
const payload = buildProfilePayload(await getLiveTokenProfile("uniswap-uni", createFakeSupabase({ seed }).client));
const field = (fieldId) => payload.fields.find((item) => item.id === fieldId);
const empty = { overview: "No statement is made in this section.", statements: [] };
const report = (overrides = {}) => ({
  executiveSummary: empty, marketPerformance: empty, fundamentalPerformance: empty, valuation: empty, marketFundamentalRelationships: empty,
  liquidityMarketStructure: empty, tokenomics: empty, risks: [], dataGaps: [], furtherResearchQuestions: [], ...overrides,
});
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });
const stats = { modelId: LOCAL_MODEL.id, loadMs: 1000, inferenceMs: 2000, inputTokens: 100, outputTokens: 50, prefillTokensPerSecond: null, decodeTokensPerSecond: null, finishReason: "stop" };

test("L1. the local prompt is the canonical payload in compact form (every ID, value and required period), not the research packet", () => {
  const prompt = buildLocalPrompt(payload);
  for (const item of payload.fields) {
    assert.ok(prompt.user.includes(`"id":"${item.id}"`), item.id);
    assert.ok(prompt.user.includes(JSON.stringify(item.value)), `${item.id} value`);
    if (item.periodRequired) assert.ok(prompt.user.includes(JSON.stringify(item.period)), `${item.id} period`);
  }
  for (const note of payload.scope) assert.ok(prompt.user.includes(`"id":"${note.id}"`), note.id);
  assert.ok(prompt.user.length < buildProfileUserContent(payload).length, "smaller than the full payload JSON");
  assert.ok(prompt.system.startsWith(PROFILE_SYSTEM_INSTRUCTION), "the unchanged profile system instruction");
  assert.ok(prompt.system.includes(LOCAL_EVIDENCE_INSTRUCTION));
  assert.equal(LOCAL_EVIDENCE_INSTRUCTION, "Use only the supplied Token Samurai data as factual evidence. Do not introduce unsupported factual claims. If the supplied data is insufficient to support a conclusion, state that the supplied data is insufficient.");
  for (const key of ["executiveSummary", "tokenomics", "risks", "dataGaps", "furtherResearchQuestions"]) assert.ok(prompt.system.includes(`- ${key}:`), key);
  assert.doesNotMatch(prompt.user, /research_context|providerFreshness|calculatedMetrics/, "no old research-context packet");
});

test("L2. valid local output passes the unchanged validator and becomes a renderable report", async () => {
  const change = field("obs:change_7d");
  const raw = JSON.stringify(report({
    executiveSummary: { overview: "The profile shows token-level market data.", statements: [st("observed", "The profile shows a price of $9.33.", ["obs:price"])] },
    marketPerformance: { overview: "Changes are shown over their stated periods.", statements: [st("observed", `The 7-day change shown is ${change.value}.`, [change.id], change.period)] },
    dataGaps: [{ category: "unavailable_metric", detail: "Maximum supply is not reported.", sourceIds: ["obs:maximum_supply"] }],
  }));
  const result = await finalizeLocalAnalysis(raw, payload, stats, new Date("2026-09-26T00:00:00Z"));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.issues, 0);
  assert.equal(result.analysis.metadata.provider, "Local AI (browser)");
  assert.equal(result.analysis.metadata.model, LOCAL_MODEL.id);
  assert.match(result.analysis.metadata.contextHash, /^[0-9a-f]{64}$/);
  assert.ok(result.analysis.metadata.sources["obs:price"], "cited IDs get their payload labels");
});

test("L3. invalid local output is rejected at the right stage and never displayed (validator not weakened)", async () => {
  const truncated = await finalizeLocalAnalysis('{"executiveSummary": {"overview": "x"', payload, { ...stats, finishReason: "length" });
  assert.deepEqual([truncated.ok, truncated.stage], [false, "parse"]);
  assert.match(truncated.message, /output limit/);
  const shape = await finalizeLocalAnalysis(JSON.stringify({ executiveSummary: empty }), payload, stats);
  assert.deepEqual([shape.ok, shape.stage], [false, "schema"]);
  const ungrounded = await finalizeLocalAnalysis(JSON.stringify(report({
    executiveSummary: { overview: "The price is shown.", statements: [st("observed", "The price is $12.50 and bullish.", ["obs:price"])] },
    tokenomics: { overview: "Supply is shown.", statements: [st("observed", "Supply exists.", ["obs:invented_id"])] },
  })), payload, stats);
  assert.deepEqual([ungrounded.ok, ungrounded.stage], [false, "evidence"]);
  assert.ok(ungrounded.issues >= 2 && ungrounded.violations.length === ungrounded.issues);
});

test("L4. privacy and separation: the local panel never calls the server action or an AI provider, and has no silent fallback", () => {
  const panel = source("src/components/LocalAnalysisPanel.tsx");
  const core = source("src/lib/analysis/local/local-analysis.ts");
  for (const text of [panel, core]) {
    assert.doesNotMatch(text, /requestTokenAnalysis|app\/tokens\/\[id\]\/actions|ai\/router|ai\/registry|gemini|mistral|openrouter|fetch\(/i);
  }
  assert.match(panel, /await import\("@mlc-ai\/web-llm"\)/, "the model runtime loads only on demand, in the browser");
  assert.match(panel, /response_format: \{ type: "json_object", schema: JSON\.stringify\(ANALYSIS_RESPONSE_SCHEMA\) \}/, "the existing report schema constrains decoding");
  assert.match(panel, /Local AI — running on your device/);
  assert.doesNotMatch(core, /node:/, "the local core is browser-safe");
  assert.doesNotMatch(source("src/lib/analysis/profile-evidence-index.ts"), /node:/);
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
console.log(`${cases.length - failures}/${cases.length} local-analysis checks passed.`);
if (failures > 0) process.exitCode = 1;
