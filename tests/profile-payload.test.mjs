// Token Profile payload: the canonical dataset shared by the page, "Copy data", and the AI analysis.
// Built through the page's own loader (getLiveTokenProfile) against an in-memory database. No network.

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { buildProfilePayload, formatProfilePayloadText } from "../src/lib/analysis/profile-payload.ts";
import { buildProfileEvidenceIndex } from "../src/lib/analysis/profile-evidence.ts";
import { PROFILE_SYSTEM_INSTRUCTION, buildProfileUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA, AnalysisValidationError, validateModelAnalysis } from "../src/lib/analysis/schema.ts";
import { allowedEvidenceIds, attachEvidencePeriods, buildProfileResponseSchema, buildProfileValidationSchema } from "../src/lib/analysis/profile-contract.ts";
import { schemaErrors } from "../src/lib/analysis/ai/json-schema.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

function seed(tokenId, chainId, rows, calculated = []) {
  let id = 1000;
  const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
    id: id++, token_id: tokenId, chain_id: chainId, provider_id: provider, metric_id: metric, value,
    status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
  });
  return {
    tokens: [
      { id: "uniswap-uni", name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null },
      { id: "bitcoin-btc", name: "Bitcoin", symbol: "BTC", chain_id: "bitcoin", contract_address: null, is_native: true, category: "Layer 1", description: null },
    ],
    chains: [{ id: "ethereum", name: "Ethereum" }, { id: "bitcoin", name: "Bitcoin" }],
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

const UNISWAP = seed("uniswap-uni", "ethereum", [
  ["coingecko", "price_usd", 9.33], ["coingecko", "price_usd", 9.21, 26], ["coingecko", "market_cap_usd", 5_790_000_000],
  ["coingecko", "volume_24h_usd", 0], ["coingecko", "price_change_24h_pct", -0.13, 0.5, { window_days: 1 }],
  ["coingecko", "price_change_7d_pct", 32.95, 0.5, { window_days: 7 }], ["coingecko", "circulating_supply", 620_668_000],
  ["coingecko", "maximum_supply", null], ["defillama", "tvl_usd", 3_910_000_000, 2], ["defillama", "fees_24h_usd", 1_250_000, 2],
], [
  { metric: "price_growth_pct", value: 1.3, start: at(1.5), end: at(0.5) },
  { metric: "market_cap_to_tvl", value: 1.481, start: at(2), end: at(0.5) },
]);
const BITCOIN = seed("bitcoin-btc", "bitcoin", [
  ["coingecko", "price_usd", 84388.12], ["coingecko", "market_cap_usd", 1_690_000_000_000], ["coingecko", "circulating_supply", 20_088_743],
  ["coingecko", "maximum_supply", 21_000_000],
]);

const profile = (tokenId, data) => getLiveTokenProfile(tokenId, createFakeSupabase({ seed: data }).client);
const uniswap = await profile("uniswap-uni", UNISWAP);
const bitcoin = await profile("bitcoin-btc", BITCOIN);
const uniPayload = buildProfilePayload(uniswap);
const btcPayload = buildProfilePayload(bitcoin);
const field = (payload, id) => payload.fields.find((item) => item.id === id);

function violations(output, payload) {
  try {
    validateModelAnalysis(output, buildProfileEvidenceIndex(payload));
  } catch (error) {
    if (error instanceof AnalysisValidationError) return error.violations;
    throw error;
  }
  return [];
}
const empty = { overview: "No statement is made in this section.", statements: [] };
function report(overrides = {}) {
  return {
    executiveSummary: empty, marketPerformance: empty, fundamentalPerformance: empty, valuation: empty, marketFundamentalRelationships: empty,
    liquidityMarketStructure: empty, tokenomics: empty, risks: [], dataGaps: [], furtherResearchQuestions: [], ...overrides,
  };
}
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });

test("P1. every card the page displays is a payload field with the same label and displayed value", () => {
  const model = buildProfileModel(uniswap);
  const displayed = [...model.snapshot.cards, ...model.snapshot.changes, ...(model.fundamentals.available ? [...model.fundamentals.primary, ...model.fundamentals.valuation, ...model.fundamentals.changes] : []), ...(model.tokenomics.available ? model.tokenomics.items : [])];
  assert.ok(displayed.length >= 6);
  for (const card of displayed) {
    const match = uniPayload.fields.find((item) => item.label === card.label && item.value === card.value);
    assert.ok(match, `displayed "${card.label}: ${card.value}" is in the payload`);
  }
  assert.equal(field(uniPayload, "obs:price").value, "$9.33", "the header price as displayed");
  assert.equal(field(uniPayload, "calc:market_cap_to_tvl").value, model.fundamentals.valuation.find((card) => card.id === "market_cap_to_tvl").value);
});

test("P2. deterministic: the same profile data yields the identical payload, prompt input, and copy text", async () => {
  const again = buildProfilePayload(await profile("uniswap-uni", UNISWAP));
  const strip = (payload) => JSON.parse(JSON.stringify(payload, (key, value) => (key === "asOf" || key === "dataAsOf" ? undefined : value)));
  assert.deepEqual(strip(again), strip(uniPayload), "no randomness or provider-specific content");
  assert.equal(buildProfileUserContent(uniPayload), buildProfileUserContent(uniPayload));
  assert.equal(formatProfilePayloadText(uniPayload), formatProfilePayloadText(buildProfilePayload(uniswap)));
});

test("P3. unavailable is 'not reported', never zero; a real zero stays a value", () => {
  const max = field(uniPayload, "obs:maximum_supply");
  assert.deepEqual([max.status, max.value, max.raw], ["not_reported", "Not reported", null]);
  const volume = field(uniPayload, "obs:volume_24h");
  assert.equal(volume.status, "shown", "a stored zero is displayed and passed on");
  assert.equal(volume.raw, 0);
  assert.equal(volume.value, "$0");
});

test("P4. provider-reported windows keep their periods; point-in-time ratios carry none", () => {
  assert.match(field(uniPayload, "obs:change_24h").period, /^24H/);
  assert.match(field(uniPayload, "obs:change_7d").period, /^7D/);
  assert.match(field(uniPayload, "obs:volume_24h").period, /^24H/);
  assert.equal(field(uniPayload, "obs:change_7d").periodRequired, true);
  assert.equal(field(uniPayload, "calc:market_cap_to_tvl").period, null, "a ratio is not a change over an interval");
  assert.match(field(uniPayload, "calc:price_growth_pct").period, /1 hour/, "a snapshot change states its actual interval");
});

test("P5. scope: protocol data is labelled protocol; unmapped providers are stated as unmapped", () => {
  assert.equal(field(uniPayload, "obs:tvl").scope, "protocol");
  assert.match(field(uniPayload, "obs:tvl").section, /associated protocol/);
  const defillama = btcPayload.scope.find((note) => note.id === "scope:defillama");
  const dex = btcPayload.scope.find((note) => note.id === "scope:dexscreener");
  assert.equal(defillama.mapped, false);
  assert.match(defillama.statement, /no DeFiLlama protocol mapping/);
  assert.equal(dex.mapped, false);
  assert.match(dex.statement, /no verified DEX Screener address mapping/);
  assert.ok(!btcPayload.fields.some((item) => item.id === "obs:tvl"), "no protocol TVL is invented for an unmapped token");
});

test("P6. the AI input is the payload itself: compact, and without research-context-only data", () => {
  const text = buildProfileUserContent(uniPayload);
  const json = JSON.parse(text.slice(text.indexOf("<token_samurai_data>\n") + 21, text.lastIndexOf("\n</token_samurai_data>")));
  assert.deepEqual(json, JSON.parse(JSON.stringify(uniPayload)));
  assert.ok(!/"calculatedMetrics"|"providerFreshness"|"points"/.test(text), "no internal research-context structures");
  assert.ok(!uniPayload.fields.some((item) => /^obs:\d+$/.test(item.id)), "IDs name displayed fields, not database rows");
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Use only the supplied Token Samurai data as factual evidence\. Do not introduce unsupported factual claims\. If the supplied data is insufficient to support a conclusion, say so\./);
});

test("P7. Copy data text is the same dataset, human-readable", () => {
  const text = formatProfilePayloadText(btcPayload);
  assert.match(text, /^TOKEN SAMURAI — BITCOIN\nToken: Bitcoin \(BTC\)\nChain: Bitcoin\nCategory: Layer 1/);
  for (const item of btcPayload.fields) assert.ok(text.includes(`${item.label}: ${item.value}`), `${item.label} is copied`);
  assert.match(text, /Price: \$84,388\.12/);
  assert.match(text, /Maximum supply: 21M BTC/);
});

test("P8. the unchanged validator runs on payload IDs: grounded numbers and exact periods pass", () => {
  const change = field(uniPayload, "obs:change_7d");
  const ok = report({
    executiveSummary: { overview: "The profile shows token-level market data.", statements: [st("observed", "The profile shows a price of $9.33.", ["obs:price"])] },
    marketPerformance: { overview: "Changes are shown over their stated periods.", statements: [st("observed", `The 7-day change shown is ${change.value}.`, [change.id], change.period)] },
    dataGaps: [{ category: "unavailable_metric", detail: "Maximum supply is not reported.", sourceIds: ["obs:maximum_supply"] }],
  });
  assert.deepEqual(violations(ok, uniPayload), []);
});

test("P9. the validator still rejects unsupported numbers, missing periods, unknown IDs, outside concepts, and invented unmapped reasons", () => {
  const change = field(uniPayload, "obs:change_7d");
  const found = violations(report({
    executiveSummary: { overview: "The profile shows market data.", statements: [
      st("observed", "The price was $12.40.", ["obs:price"]),
      st("observed", `The 7-day change shown is ${change.value}.`, [change.id]),
      st("observed", "Supply is capped.", ["obs:row_123"]),
      st("interpretation", "The halving may explain this.", ["obs:price"]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /number\(s\) 12\.40/.test(item)), "unsupported number");
  assert.ok(found.some((item) => /cites time-based evidence but has no period/.test(item)), "missing period");
  assert.ok(found.some((item) => /unknown source ID "obs:row_123"/.test(item)), "unknown ID");
  assert.ok(found.some((item) => /introduces "halving"/.test(item)), "outside concept");
  const btc = violations(report({
    liquidityMarketStructure: { overview: "DEX liquidity is unavailable because the data is stale.", statements: [] },
  }), btcPayload);
  assert.ok(btc.some((item) => /DEX Screener data as "stale"/.test(item)), "invented reason for an unmapped provider");
});

test("P10. the prompt's prescribed unmapped-provider wording satisfies the (unchanged) validator rule", () => {
  const wording = (provider) => {
    const match = PROFILE_SYSTEM_INSTRUCTION.match(new RegExp(`- ${provider}: "([^"]+)"`));
    assert.ok(match, `the prompt prescribes wording for ${provider}`);
    return match[1];
  };
  const defillama = wording("DeFiLlama");
  const dex = wording("DEX Screener");
  const btc = violations(report({
    fundamentalPerformance: { overview: `Protocol TVL, fees, and revenue are not shown: ${defillama}.`, statements: [] },
    liquidityMarketStructure: { overview: `DEX liquidity and pairs are not shown: ${dex}.`, statements: [] },
    dataGaps: [
      { category: "mapping_limitation", detail: `TVL is not reported: ${defillama}.`, sourceIds: ["scope:defillama"] },
      { category: "mapping_limitation", detail: `Liquidity is not reported: ${dex}.`, sourceIds: ["scope:dexscreener"] },
    ],
  }), btcPayload);
  assert.deepEqual(btc, [], "the wording passes wherever it is used");
  const bare = violations(report({ liquidityMarketStructure: { overview: "DEX liquidity is not shown for this token.", statements: [] } }), btcPayload);
  assert.ok(bare.some((item) => /without stating the context's reason/.test(item)), "without the wording the rule still fails");
});

// ---- Structural evidence contract (profile-contract.ts) ----

const btcSchema = buildProfileResponseSchema(btcPayload);
const idEnum = (schema) => schema.properties.executiveSummary.properties.statements.items.properties.sourceIds.items.enum;

test("C1. the response schema's evidence IDs are generated per token from the payload (no hand-written list)", () => {
  assert.deepEqual(idEnum(btcSchema), allowedEvidenceIds(btcPayload));
  assert.deepEqual(allowedEvidenceIds(btcPayload), ["token", ...btcPayload.scope.map((note) => note.id), ...btcPayload.fields.map((item) => item.id)]);
  const uniIds = idEnum(buildProfileResponseSchema(uniPayload));
  assert.ok(uniIds.includes("obs:tvl") && !idEnum(btcSchema).includes("obs:tvl"), "each token gets its own IDs");
  for (const path of [btcSchema.properties.risks.items, btcSchema.properties.dataGaps.items, btcSchema.properties.furtherResearchQuestions.items]) {
    assert.deepEqual(path.properties.sourceIds.items.enum, allowedEvidenceIds(btcPayload), "risks, gaps, and questions are constrained too");
  }
  assert.ok(!idEnum(btcSchema).includes("obs:change_30d"), "an ID the payload lacks cannot be selected");
});

test("C2. the model does not write periods; the static report schema is unchanged", () => {
  const statement = btcSchema.properties.marketPerformance.properties.statements.items;
  assert.equal(statement.properties.period, undefined);
  assert.ok(!statement.required.includes("period"));
  assert.ok(ANALYSIS_RESPONSE_SCHEMA.required.length === 10 && JSON.stringify(ANALYSIS_RESPONSE_SCHEMA).includes('"period"'), "the stored report format keeps its period field");
  assert.equal(statement.additionalProperties, false);
});

test("C3. periods are attached from the cited fields, overriding anything a model writes", () => {
  const change = field(uniPayload, "obs:change_7d");
  const out = attachEvidencePeriods(report({ marketPerformance: { overview: "x", statements: [
    { kind: "observed", text: "t", sourceIds: [change.id] },
    { kind: "observed", text: "t", sourceIds: [change.id], period: "30 days (invented)" },
    { kind: "observed", text: "t", sourceIds: ["obs:price"] },
    { kind: "observed", text: "t", sourceIds: ["obs:price", "obs:change_24h"] },
  ] } }), uniPayload);
  assert.deepEqual(out.marketPerformance.statements.map((item) => item.period), [change.period, change.period, "", field(uniPayload, "obs:change_24h").period]);
  assert.equal(attachEvidencePeriods("not an object", uniPayload), "not an object", "malformed output is left for the schema check");
});

test("C4. after attachment, an invented ID fails the constrained schema; the unchanged validator still judges the rest", () => {
  const validation = buildProfileValidationSchema(uniPayload);
  const change = field(uniPayload, "obs:change_7d");
  const invented = attachEvidencePeriods(report({ executiveSummary: { overview: "x.", statements: [{ kind: "observed", text: "t", sourceIds: ["obs:change_30d"] }] } }), uniPayload);
  assert.ok(schemaErrors(invented, validation).some((error) => /value not in enum/.test(error)));
  const withoutPeriod = report({ marketPerformance: { overview: "Changes are shown over their stated periods.", statements: [
    { kind: "observed", text: `The 7-day change shown is ${change.value}.`, sourceIds: [change.id] },
  ] } });
  const attached = attachEvidencePeriods(withoutPeriod, uniPayload);
  assert.deepEqual(schemaErrors(attached, validation), []);
  assert.deepEqual(violations(attached, uniPayload), [], "the attached exact period satisfies the unchanged period rule");
  const namedPeriod = attachEvidencePeriods(report({ marketPerformance: { overview: "x.", statements: [
    { kind: "observed", text: "The price is shown over 30 days.", sourceIds: ["obs:price"] },
  ] } }), uniPayload);
  assert.ok(violations(namedPeriod, uniPayload).some((item) => /"30 days" is not a period established/.test(item)), "period words in text are still checked");
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
console.log(`${cases.length - failures}/${cases.length} profile-payload checks passed.`);
if (failures > 0) process.exitCode = 1;
