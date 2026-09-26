// Phase 2 multi-provider AI router: mocked fetch only (no network, no quota).
// Requests go through the real registry and adapters; only fetch is scripted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createProviderHealth, COOLDOWN_POLICY } from "../src/lib/analysis/ai/health.ts";
import { schemaErrors } from "../src/lib/analysis/ai/json-schema.ts";
import { allowedFreeTiers, buildProviders, providerPriority } from "../src/lib/analysis/ai/registry.ts";
import { NoProviderSucceededError, routeReport } from "../src/lib/analysis/ai/router.ts";
import { buildEvidenceIndex } from "../src/lib/analysis/evidence-rules.ts";
import { SYSTEM_INSTRUCTION, buildUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA, AnalysisValidationError, validateModelAnalysis } from "../src/lib/analysis/schema.ts";
import { generateTokenAnalysis } from "../src/lib/analysis/service.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const KEYS = {
  DASHSCOPE_API_KEY: "qwen-key-not-real-p2", MISTRAL_API_KEY: "mistral-key-not-real-p2",
  GEMINI_API_KEY: "gemini-key-not-real-p2", OPENROUTER_API_KEY: "or-key-not-real-p2",
};
const ENV = { ...KEYS, OPENROUTER_MODEL: "openrouter/free", AI_ALLOWED_FREE_TIERS: "FREE,FREE_TRIAL" };
const RAW_ERROR = "RAW-PROVIDER-ERROR-TEXT-9d1";

// ---- Evidence: the real Bitcoin research-context fixture and a report that satisfies the contract ----

const context = JSON.parse(readFileSync("tests/fixtures/bitcoin-context-2026-09-24.json", "utf8"));
const obs = (metric) => context.observations.find((item) => item.provider === "CoinGecko" && item.metric === metric);
const calc = (metricId) => context.calculatedMetrics.find((item) => item.metricId === metricId);
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });
function validReport() {
  const growth = calc("price_growth_pct");
  return {
    executiveSummary: { overview: "Bitcoin evidence here is limited to CoinGecko market data.", statements: [st("observed", `CoinGecko reported a price of about $${Math.round(obs("price_usd").value).toLocaleString("en-US")}.`, [obs("price_usd").id])] },
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [st("calculated", `Price decreased by about ${Math.abs(growth.value).toFixed(2)}% between the two most recent stored observations.`, [growth.id], growth.period.label)] },
    fundamentalPerformance: { overview: "No protocol-level fundamentals are available for this token.", statements: [st("uncertainty", "Bitcoin has no DeFiLlama mapping, so protocol TVL, fees, and revenue are unavailable by design.", ["scope:defillama"])] },
    valuation: { overview: "Only one valuation ratio is available.", statements: [st("calculated", `CoinGecko volume was about ${(calc("volume_to_market_cap").value * 100).toFixed(1)}% of market capitalization.`, [calc("volume_to_market_cap").id])] },
    marketFundamentalRelationships: { overview: "No price-to-fundamentals relationship can be assessed for this token.", statements: [] },
    liquidityMarketStructure: { overview: "DEX market structure is unavailable by design for this token.", statements: [st("uncertainty", "No verified DEX Screener address mapping exists for Bitcoin, so DEX metrics are unavailable by design.", ["scope:dexscreener"])] },
    tokenomics: { overview: "Supply figures come from CoinGecko.", statements: [] },
    risks: [{ title: "Protocol fundamentals unavailable", basis: "data_limitation", detail: "Bitcoin has no DeFiLlama mapping, so TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    dataGaps: [{ category: "mapping_limitation", detail: "Bitcoin has no DeFiLlama mapping; TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    furtherResearchQuestions: [{ question: "Which additional data sources could describe Bitcoin market structure beyond CoinGecko aggregates?", rationale: "Only CoinGecko market data is available in this context.", sourceIds: [] }],
  };
}
function invalidReport() {
  const report = validReport();
  report.executiveSummary.overview = "Bitcoin is bullish and traded near $84,388.";
  return report;
}
const evidence = buildEvidenceIndex(context);
function validate(json) {
  const shape = schemaErrors(json, ANALYSIS_RESPONSE_SCHEMA);
  if (shape.length) return { ok: false, category: "structured_output", violations: shape.length, reason: "schema_mismatch" };
  try {
    return { ok: true, value: validateModelAnalysis(json, evidence), violations: 0 };
  } catch (error) {
    if (!(error instanceof AnalysisValidationError)) throw error;
    return { ok: false, category: "validation", violations: error.violations.length, reason: "evidence_contract" };
  }
}
const request = { systemInstruction: SYSTEM_INSTRUCTION, userText: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA, estimatedInputTokens: 22_000 };

// ---- Mocked provider responses, scripted per host ----

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chatOk = (report = validReport(), model = "served-model") => () => json({ id: "gen-x", model, choices: [{ finish_reason: "stop", message: { content: typeof report === "string" ? report : JSON.stringify(report) } }], usage: { prompt_tokens: 21000, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 900 } } });
const geminiOk = (report = validReport()) => () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(report) }] }, finishReason: "STOP" }], modelVersion: "gemini-served", usageMetadata: { promptTokenCount: 21000, candidatesTokenCount: 3000, thoughtsTokenCount: 800 } });
const orOk = (report = validReport()) => () => json({ id: "gen-or", model: "vendor/model:free", provider: "Upstream", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(report) } }], usage: { prompt_tokens: 21500, completion_tokens: 5000 } });
const http = (code, message = `upstream ${RAW_ERROR} ${Object.values(KEYS).join(" ")}`) => () => json({ error: { code, message } }, code);
const timeout = () => () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
const network = () => () => { throw new TypeError("fetch failed"); };

const HOSTS = { qwen: "dashscope-intl.aliyuncs.com", mistral: "api.mistral.ai", gemini: "generativelanguage.googleapis.com", openrouter: "openrouter.ai", groq: "api.groq.com", glm: "api.z.ai", siliconflow: "api.siliconflow.com", modelscope: "api-inference.modelscope.cn" };
function scripted(script) {
  const calls = Object.fromEntries(Object.keys(HOSTS).map((id) => [id, []]));
  const fetchImpl = async (url, init) => {
    const host = new URL(String(url)).hostname;
    const id = Object.keys(HOSTS).find((key) => host === HOSTS[key]);
    if (!id) throw new Error(`Unexpected host ${host}`);
    calls[id].push({ url: String(url), init });
    const next = script[id]?.shift();
    if (!next) throw new Error(`No scripted ${id} response left`);
    return next();
  };
  return { fetchImpl, calls };
}

async function route(script, { env = ENV, health = createProviderHealth(), clock, deadlineAt, events = [] } = {}) {
  const { fetchImpl, calls } = scripted(script);
  const now = clock ?? Date.now;
  try {
    const result = await routeReport({
      request, providers: buildProviders(env), priority: providerPriority(env), allowedTiers: allowedFreeTiers(env),
      deadlineAt: deadlineAt ?? now() + 240_000, validate, health, clock: now, fetchImpl,
      diagnostics: { runId: "test-run", sink: (event) => events.push(event) },
    });
    return { result, calls, health, events };
  } catch (error) {
    if (error instanceof NoProviderSucceededError) return { error, calls, health, events };
    throw error;
  }
}
const attempted = (attempts) => attempts.filter((item) => item.action === "attempted").map((item) => `${item.providerId}:${item.validationPassed ? "ok" : item.category}`);

// ---- 1-11: success, failure classes, fallback order ----

test("1. primary provider (Qwen) success: one request, native JSON schema, validated", async () => {
  const { result, calls } = await route({ qwen: [chatOk()] });
  assert.equal(result.provider.id, "qwen");
  assert.equal(calls.qwen.length, 1);
  const body = JSON.parse(calls.qwen[0].init.body);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, JSON.parse(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)));
  assert.equal(body.messages[0].content, SYSTEM_INSTRUCTION, "same system instruction as every provider");
  assert.equal(calls.qwen[0].init.headers.authorization, `Bearer ${KEYS.DASHSCOPE_API_KEY}`);
  assert.equal(result.attempt.validationPassed, true);
  assert.deepEqual(result.attempt.usage, { inputTokens: 21000, outputTokens: 4000, reasoningTokens: 900 });
});

test("2-5. primary 503, 429, timeout, and network error are transient: one request, cooldown, next provider", async () => {
  for (const failure of [http(503), http(429), timeout(), network()]) {
    const { result, calls, health } = await route({ qwen: [failure], mistral: [chatOk()] });
    assert.equal(calls.qwen.length, 1, "no retry on the failing provider");
    assert.equal(result.provider.id, "mistral");
    assert.equal(result.attempts.find((item) => item.providerId === "qwen").category, "transient");
    assert.equal(health.get("qwen", Date.now()).status, "cooldown");
  }
});

test("6. invalid JSON: one controlled retry on the same provider, then fallback", async () => {
  const { result, calls } = await route({ qwen: [chatOk("not json at all"), chatOk("{still not json")], mistral: [chatOk()] });
  assert.equal(calls.qwen.length, 2);
  assert.deepEqual(attempted(result.attempts), ["qwen:structured_output", "qwen:structured_output", "mistral:ok"]);
  const schemaMismatch = await route({ qwen: [chatOk({ executiveSummary: "x" }), chatOk(validReport())] });
  assert.equal(schemaMismatch.result.provider.id, "qwen", "a schema mismatch is retried once and can recover");
});

test("7. evidence-validation failure: not accepted, no cooldown, next provider", async () => {
  const { result, health } = await route({ qwen: [chatOk(invalidReport())], mistral: [chatOk()] });
  assert.deepEqual(attempted(result.attempts), ["qwen:validation", "mistral:ok"]);
  const qwen = result.attempts.find((item) => item.providerId === "qwen");
  assert.equal(qwen.validationPassed, false);
  assert.ok(qwen.validationViolations >= 2);
  assert.equal(health.get("qwen", Date.now()).status, "healthy", "the provider answered; validation is not an availability failure");
});

test("8-10. fallback to the second provider, the third, and Gemini as backup", async () => {
  const { result } = await route({ qwen: [http(503)], mistral: [http(502)], gemini: [geminiOk()] });
  assert.equal(result.provider.id, "gemini");
  assert.deepEqual(attempted(result.attempts), ["qwen:transient", "mistral:transient", "gemini:ok"]);
  assert.deepEqual(result.attempt.usage, { inputTokens: 21000, outputTokens: 3800, reasoningTokens: 800 });
  const skipped = result.attempts.filter((item) => item.action === "skipped").map((item) => `${item.providerId}:${item.skipReason}`);
  assert.deepEqual(skipped, ["hunyuan:not_configured", "glm:not_configured", "groq:not_configured", "siliconflow:not_configured"]);
});

test("11. OpenRouter backup after Gemini", async () => {
  const { result, calls } = await route({ qwen: [http(500)], mistral: [timeout()], gemini: [http(503)], openrouter: [orOk()] });
  assert.equal(result.provider.id, "openrouter");
  assert.equal(calls.gemini.length, 1, "Gemini gets one attempt, not two");
  assert.equal(result.attempt.servedModel, "vendor/model:free");
  assert.equal(result.attempt.upstreamProvider, "Upstream");
});

// ---- 12-15: cooldown, recovery, configuration, quota ----

test("12-13. cooldown blocks requests; after it ends a probe is allowed; success restores, failure extends", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const health = createProviderHealth();
  await route({ qwen: [http(503)], mistral: [chatOk()] }, { health, clock });
  assert.equal(health.get("qwen", now).available, false);

  const during = await route({ mistral: [chatOk()] }, { health, clock });
  assert.equal(during.calls.qwen.length, 0, "no request to a provider in cooldown");
  assert.equal(during.result.attempts[0].skipReason, "cooldown");

  now += COOLDOWN_POLICY.transientBaseMs + 1;
  assert.equal(health.get("qwen", now).probing, true);
  const failedProbe = await route({ qwen: [http(503)], mistral: [chatOk()] }, { health, clock });
  assert.equal(failedProbe.calls.qwen.length, 1, "one probe request");
  assert.equal(health.get("qwen", now).until, now + COOLDOWN_POLICY.transientBaseMs * 2, "a failed probe doubles the cooldown");

  now += COOLDOWN_POLICY.transientBaseMs * 2 + 1;
  const recovered = await route({ qwen: [chatOk()] }, { health, clock });
  assert.equal(recovered.result.provider.id, "qwen");
  assert.deepEqual(health.get("qwen", now), { status: "healthy", until: null, consecutiveFailures: 0, lastCategory: null, available: true, probing: false });
});

test("14. configuration errors (401/403/404) are not retried and mark the provider unavailable", async () => {
  for (const code of [401, 403, 404]) {
    const { result, calls, health } = await route({ qwen: [http(code)], mistral: [chatOk()] });
    assert.equal(calls.qwen.length, 1);
    assert.equal(result.provider.id, "mistral");
    assert.equal(health.get("qwen", Date.now()).status, "configuration_error", `HTTP ${code}`);
  }
  const noKey = await route({ mistral: [chatOk()] }, { env: { ...ENV, DASHSCOPE_API_KEY: "" } });
  assert.equal(noKey.result.attempts[0].skipReason, "not_configured");
  const badModel = await route({ mistral: [chatOk()] }, { env: { ...ENV, QWEN_MODEL: "bad model !" } });
  assert.equal(badModel.calls.qwen.length, 0, "an invalid model is a configuration error found before any request");
});

test("15. free quota exhausted: FREE_QUOTA_EXHAUSTED, long cooldown, next provider; never falls into paid usage", async () => {
  const freeTierOnly = () => json({ error: { code: "AllocationQuota.FreeTierOnly", message: "The free tier of the model has been exhausted." } }, 403);
  const { result, health } = await route({ qwen: [freeTierOnly], mistral: [chatOk()] });
  assert.equal(result.attempts.find((item) => item.providerId === "qwen").category, "quota");
  const state = health.get("qwen", Date.now());
  assert.equal(state.status, "free_quota_exhausted");
  assert.ok(state.until - Date.now() > COOLDOWN_POLICY.quotaMs - 5_000);
  const paymentRequired = await route({ qwen: [http(402)], mistral: [chatOk()] });
  assert.equal(paymentRequired.result.attempts[0].category, "quota");
});

// ---- 16-18: capability, deadline, nothing available ----

test("16. capability and free-tier mismatches are skipped before any request", async () => {
  // glm and siliconflow are deliberately left out of this priority list: their structured-output
  // mode (json_object) is now eligible (see test 22+), so they no longer belong among the skips
  // this test demonstrates. hunyuan stays "unverified" (no documented mode either way).
  const env = { GROQ_API_KEY: "g", HUNYUAN_API_KEY: "h", HUNYUAN_MODEL: "hunyuan-x", DASHSCOPE_API_KEY: "q", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "vendor/paid-model", MISTRAL_API_KEY: "m", MISTRAL_MODEL: "mistral-medium-2604", AI_PROVIDER_PRIORITY: "qwen,hunyuan,groq,mistral" };
  const { result, calls } = await route({ mistral: [chatOk()] }, { env });
  const skips = Object.fromEntries(result.attempts.filter((item) => item.action === "skipped").map((item) => [item.providerId, item.skipReason]));
  assert.equal(skips.qwen, "free_tier_free_trial", "a free trial needs explicit opt-in (AI_ALLOWED_FREE_TIERS)");
  assert.equal(skips.hunyuan, "free_tier_free_trial");
  assert.equal(result.provider.id, "mistral");
  assert.equal(calls.groq.length + calls.qwen.length, 0);

  const onlyGroqAndPaidOpenRouter = await route({}, { env: { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "vendor/paid-model" } });
  const later = Object.fromEntries(onlyGroqAndPaidOpenRouter.error.attempts.map((item) => [item.providerId, item.skipReason]));
  assert.equal(later.groq, "request_token_limit", "the free 8K TPM cap cannot carry a ~22K-token prompt");
  assert.equal(later.openrouter, "free_tier_paid_only", "a non-:free OpenRouter model is never called");

  const cerebras = buildProviders({ CEREBRAS_API_KEY: "c" }).get("cerebras");
  assert.equal(cerebras.freeTier.status, "FREE_TRIAL", "30-day credits are a trial, not a permanent free tier");
  assert.ok(!providerPriority({}).includes("cerebras"), "not in the default priority (explicit opt-in)");
  const optedIn = await route({}, { env: { CEREBRAS_API_KEY: "c", AI_PROVIDER_PRIORITY: "cerebras", AI_ALLOWED_FREE_TIERS: "FREE,FREE_TRIAL" } });
  assert.equal(optedIn.error.attempts[0].skipReason, "request_token_limit", "~22K input + 8K output exceeds the 30K free-trial TPM");
});

test("17. one overall deadline: each attempt gets only the remaining budget; nothing starts without enough time", async () => {
  let now = 5_000_000;
  const clock = () => now;
  const deadlineAt = now + 100_000;
  const events = [];
  const slow = () => { now += 85_000; return json({ error: { code: 503 } }, 503); };
  const { error } = await route({ qwen: [slow], mistral: [chatOk()] }, { clock, deadlineAt, events });
  const [qwenAttempt] = error.attempts.filter((item) => item.action === "attempted");
  // Four providers are actually eligible here (qwen, mistral, gemini, openrouter; hunyuan/glm/groq/siliconflow
  // are all unconfigured in this env): the first provider gets min(its cap, remaining, a fair 1/4 share),
  // not the whole 100s remaining — see test 25 for the full starvation scenario this prevents.
  assert.equal(qwenAttempt.timeoutMs, 25_000, "the first provider gets an equal share of the remaining deadline, not all of it");
  const mistral = error.attempts.find((item) => item.providerId === "mistral");
  assert.equal(mistral.skipReason, "deadline", "15 s left is below the minimum attempt window");
  assert.ok(events.some((event) => event.type === "ai.router_attempt" && event.skipReason === "deadline"));
});

test("18. no provider available: a controlled error, no requests", async () => {
  const { error, calls } = await route({}, { env: {} });
  assert.ok(error instanceof NoProviderSucceededError);
  assert.match(error.message, /No AI provider is currently available/);
  assert.equal(Object.values(calls).flat().length, 0);
});

// ---- 19-20: storage through the real service ----

const TOKEN = "uniswap-uni";
const NOW = new Date("2026-09-25T12:00:00.000Z");
function seed() {
  return {
    tokens: [{ id: TOKEN, name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null }],
    chains: [{ id: "ethereum", name: "Ethereum" }],
    token_metric_observations: [{ id: 101, token_id: TOKEN, chain_id: "ethereum", provider_id: "coingecko", metric_id: "price_usd", value: 9.33, status: "available", observed_at: NOW.toISOString(), collected_at: NOW.toISOString(), window_days: null, note: null }],
    metric_definitions: [{ id: "price_usd", name: "Price", unit: "USD", description: "Token price in US dollars." }],
    calculated_metric_observations: [], calculated_metric_definitions: [], data_refresh_steps: [],
  };
}
const quietSection = { overview: "No statement is made in this section.", statements: [] };
const minimalReport = {
  executiveSummary: quietSection, marketPerformance: quietSection, fundamentalPerformance: quietSection, valuation: quietSection,
  marketFundamentalRelationships: quietSection, liquidityMarketStructure: quietSection, tokenomics: quietSection,
  risks: [], dataGaps: [], furtherResearchQuestions: [],
};
async function serviceRun(script) {
  const db = createFakeSupabase({ seed: seed() });
  const { fetchImpl, calls } = scripted(script);
  const events = [];
  const [error, info] = [console.error, console.info];
  console.error = () => {};
  console.info = () => {};
  try {
    const result = await generateTokenAnalysis(db.client, TOKEN, { env: ENV, fetchImpl, now: () => NOW, providerHealth: createProviderHealth(), diagnosticsSink: (event) => events.push(event) });
    return { result, db, calls, events };
  } finally {
    console.error = error;
    console.info = info;
  }
}

test("19. a valid report is stored with provider, models, route, and validation metadata", async () => {
  const { result, db } = await serviceRun({ qwen: [http(503)], mistral: [chatOk(minimalReport, "mistral-medium-2609")] });
  assert.equal(result.ok, true, result.message);
  const [row] = db.rows("token_ai_analyses");
  const { metadata } = row.analysis;
  assert.equal(metadata.provider, "Mistral");
  assert.equal(metadata.requestedModel, "mistral-medium-2604");
  assert.equal(metadata.model, "mistral-medium-2609");
  assert.equal(row.model, "mistral-medium-2609");
  assert.equal(metadata.routing.providerId, "mistral");
  assert.equal(metadata.routing.fallbackReason, "qwen_503");
  assert.deepEqual(metadata.routing.attempts.filter((item) => item.action === "attempted").map((item) => [item.provider, item.category, item.validationPassed]), [["qwen", "transient", null], ["mistral", null, true]]);
  assert.deepEqual(metadata.fallback, { used: false, reason: null }, "the panel's Gemini→OpenRouter line is not shown for other routes");
  assert.ok(metadata.contextAsOf);
});

test("20. an invalid report is never stored", async () => {
  const bad = { ...minimalReport, executiveSummary: { overview: "UNI traded at $9.33 and looks bullish.", statements: [] } };
  const { result, db } = await serviceRun({ qwen: [chatOk(bad)], mistral: [chatOk(bad)], gemini: [geminiOk(bad)], openrouter: [orOk(bad)] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_output");
  assert.equal(db.rows("token_ai_analyses").length, 0);
});

// ---- 21: secrets ----

test("21. no secret or raw provider text leaks into results, errors, diagnostics, or stored metadata", async () => {
  const run = await serviceRun({ qwen: [http(503)], mistral: [http(401)], gemini: [http(429)], openrouter: [http(502)] });
  const events = [];
  const routed = await route({ qwen: [http(500)], mistral: [chatOk()] }, { events });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const blob = JSON.stringify([run.result, run.events, routed.result.attempts, events]);
  for (const secret of [...Object.values(KEYS), RAW_ERROR, "authorization", "x-goog-api-key"]) assert.ok(!blob.includes(secret), `no ${secret}`);
  assert.equal(run.result.reason, "provider_failed");
  assert.match(run.result.message, /Qwen \(Alibaba Cloud Model Studio\): temporarily unavailable \(HTTP 503\); Mistral: configuration error \(HTTP 401\)/);
});

test("22. GLM reads ZHIPU_API_KEY and uses JSON-object mode (schema as text)", async () => {
  assert.equal(buildProviders({ ZHIPU_API_KEY: "zk" }).get("glm").configured, true);
  assert.equal(buildProviders({ ZAI_API_KEY: "zk" }).get("glm").configured, false, "the old variable name is no longer read");
  const glm = buildProviders({ ZHIPU_API_KEY: KEYS.DASHSCOPE_API_KEY }).get("glm");
  assert.equal(glm.model, "glm-4.7-flash");
  assert.equal(glm.capabilities.structuredOutput, "json_object", "documented JSON mode, not a claimed json_schema");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return chatOk()(); };
  const outcome = await glm.generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl });
  assert.equal(outcome.ok, true);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.z.ai/api/paas/v4/chat/completions");
  assert.deepEqual(body.response_format, { type: "json_object" }, "JSON mode, not a claimed json_schema");
  assert.ok(body.messages[0].content.startsWith(SYSTEM_INSTRUCTION), "the system instruction is unchanged, with the schema appended");
  assert.ok(body.messages[0].content.endsWith(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)), "the exact schema is given as text");
  assert.equal(body.messages[1].content, request.userText);
  const mistral = scripted({ mistral: [chatOk()] });
  await buildProviders(ENV).get("mistral").generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl: mistral.fetchImpl });
  assert.equal(JSON.parse(mistral.calls.mistral[0].init.body).response_format.type, "json_schema", "JSON-schema providers are unchanged");
});

// ---- 23: GLM (json_object) is a first-class, fully validated routing path ----

const GLM_ENV = { ZHIPU_API_KEY: "zk", MISTRAL_API_KEY: KEYS.MISTRAL_API_KEY, MISTRAL_MODEL: "mistral-medium-2604", AI_PROVIDER_PRIORITY: "glm,mistral" };

test("23A-B. GLM is no longer skipped for its structured-output mode, and is selected first when configured", async () => {
  const { result, calls } = await route({ glm: [chatOk()], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "glm", "json_object is now an eligible routing path");
  assert.equal(result.attempts[0].skipReason, null, "not skipped");
  assert.equal(calls.mistral.length, 0, "the router stops at the first success");
});

test("23C. GLM valid JSON + valid schema + valid evidence is accepted", async () => {
  const { result } = await route({ glm: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "glm");
  assert.equal(result.attempt.validationPassed, true);
});

test("23D. GLM malformed JSON is rejected (retried once), then falls back to Mistral", async () => {
  const { result, calls } = await route({ glm: [chatOk("not json at all"), chatOk("{still not json")], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(calls.glm.length, 2, "one same-provider retry, same as any json_schema provider");
  assert.deepEqual(attempted(result.attempts), ["glm:structured_output", "glm:structured_output", "mistral:ok"]);
});

test("23E. GLM JSON that does not match the report schema is rejected, then falls back to Mistral", async () => {
  const { result, calls } = await route({ glm: [chatOk({ executiveSummary: "x" }), chatOk({ executiveSummary: "y" })], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(calls.glm.length, 2);
  assert.deepEqual(attempted(result.attempts), ["glm:structured_output", "glm:structured_output", "mistral:ok"]);
});

test("23F. GLM output failing the evidence contract is rejected (no retry) and falls back to Mistral", async () => {
  const { result, health } = await route({ glm: [chatOk(invalidReport())], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.deepEqual(attempted(result.attempts), ["glm:validation", "mistral:ok"]);
  const glmAttempt = result.attempts.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.validationPassed, false);
  assert.ok(glmAttempt.validationViolations >= 2);
  assert.equal(health.get("glm", Date.now()).status, "healthy", "the provider answered; validation is not an availability failure");
});

test("23G. GLM HTTP 429/5xx/timeout is infrastructure-transient and falls back to Mistral", async () => {
  for (const failure of [http(429), http(503), timeout()]) {
    const { result, calls, health } = await route({ glm: [failure], mistral: [chatOk()] }, { env: GLM_ENV, health: createProviderHealth() });
    assert.equal(calls.glm.length, 1, "no retry on an infrastructure failure");
    assert.equal(result.provider.id, "mistral");
    assert.equal(result.attempts.find((item) => item.providerId === "glm").category, "transient");
    assert.equal(health.get("glm", Date.now()).status, "cooldown");
  }
});

// ---- 24: SiliconFlow and ModelScope wiring (verified json_object capability, no invented model) ----

test("24. SiliconFlow and ModelScope are eligible json_object providers, but stay unconfigured without their model env var", async () => {
  const siliconflow = buildProviders({ SILICONFLOW_API_KEY: "sk" }).get("siliconflow");
  assert.equal(siliconflow.capabilities.structuredOutput, "json_object", "documented JSON mode (docs.siliconflow.cn JSON-mode guide), not a claimed json_schema");
  assert.equal(siliconflow.configured, false, "no default model is invented; SILICONFLOW_MODEL is required");
  assert.equal(buildProviders({ SILICONFLOW_API_KEY: "sk", SILICONFLOW_MODEL: "some-model" }).get("siliconflow").configured, true);

  const modelscope = buildProviders({ MODELSCOPE_API_TOKEN: "mt" }).get("modelscope");
  assert.equal(modelscope.capabilities.structuredOutput, "json_object", "json_schema is a documented open bug (modelscope/modelscope#1801); json_object is used instead");
  assert.equal(modelscope.configured, false, "no default model is invented; MODELSCOPE_MODEL is required");
  assert.equal(buildProviders({ MODELSCOPE_API_TOKEN: "mt", MODELSCOPE_MODEL: "some-model" }).get("modelscope").configured, true);
  assert.equal(buildProviders({}).get("modelscope").configured, false, "no token configured in this environment");

  const routed = await route({}, { env: { SILICONFLOW_API_KEY: "sk", MODELSCOPE_API_TOKEN: "mt", AI_PROVIDER_PRIORITY: "siliconflow,modelscope" } });
  const skips = Object.fromEntries(routed.error.attempts.map((item) => [item.providerId, item.skipReason]));
  assert.equal(skips.siliconflow, "not_configured", "eligible capability, but still no model");
  assert.equal(skips.modelscope, "not_configured");
});

// ---- 25-26: bounded per-provider timeout budgeting (production incident: GLM alone used 118.7s
// of a 240s deadline, and OpenRouter's later attempt was cut off, so SiliconFlow/ModelScope/Gemini
// never even got skipped-for-real-eligibility — they were starved to zero) ----

const SIX_ENV = {
  ZHIPU_API_KEY: "zk", MISTRAL_API_KEY: "mk", MISTRAL_MODEL: "mistral-medium-2604",
  OPENROUTER_API_KEY: "ok", OPENROUTER_MODEL: "openrouter/free",
  SILICONFLOW_API_KEY: "sk", SILICONFLOW_MODEL: "some-model",
  MODELSCOPE_API_TOKEN: "mt", MODELSCOPE_MODEL: "some-model",
  GEMINI_API_KEY: "gk",
  AI_PROVIDER_PRIORITY: "glm,mistral,openrouter,siliconflow,modelscope,gemini",
};

test("25. with all six providers eligible, the first attempt gets an equal share of the 240s deadline, not the whole thing, and every provider reaches an actual attempt (none pre-emptively starved)", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  // Each mock fails (or, for the last, succeeds) near-instantly: this isolates the allocation
  // formula itself from real request latency, so remaining stays ~240s throughout.
  const { result, calls } = await route(
    { glm: [http(500)], mistral: [http(500)], openrouter: [http(500)], siliconflow: [http(500)], modelscope: [http(500)], gemini: [geminiOk()] },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(result.provider.id, "gemini", "the chain reaches the last provider and succeeds");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"], "every provider is actually attempted, none skipped for \"deadline\"");
  assert.ok(result.attempts.every((item) => item.skipReason !== "deadline"), "none of the six is starved before it even gets a turn");
  // At the very first attempt, before any clock advance, remaining is exactly 240_000 and all six
  // are candidates: the fair share is 240_000 / 6 = 40_000, well below GLM's own 120_000 cap —
  // proving the cap actually engaged instead of handing GLM the whole remaining budget.
  const glmAttempt = attempted.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.timeoutMs, 40_000, "GLM's allocation is bounded to its fair share, not min(cap, remaining) alone");
  assert.equal(calls.gemini.length, 1);
});

test("26. worst case — every provider fully consumes its own allocated share, every time — still leaves every later provider a genuine, non-zero window (the exact production starvation is fixed)", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  // With 6 equally-weighted candidates and a 240_000ms budget, an even split gives each one
  // exactly 40_000ms, and — critically — consuming exactly that share still leaves the same even
  // split for whoever is left, so the allocation is 40_000ms for all six, every single time.
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result } = await route(
    {
      glm: [advanceBy(40_000, http(500))],
      mistral: [advanceBy(40_000, http(500))],
      openrouter: [advanceBy(40_000, http(500))],
      siliconflow: [advanceBy(40_000, http(500))],
      modelscope: [advanceBy(40_000, http(500))],
      gemini: [advanceBy(40_000, geminiOk())],
    },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(result.provider.id, "gemini", "even in the worst case, the last provider in priority still gets attempted and succeeds");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"]);
  // Every attempt got exactly the same 40_000ms share: no earlier provider's full-share consumption
  // ever reduces a later one's guaranteed slice below its fair portion of what remains.
  assert.deepEqual(attempted.map((item) => item.timeoutMs), [40_000, 40_000, 40_000, 40_000, 40_000, 40_000]);
  assert.equal(now, 240_000, "all six providers, including Gemini, each got and used their full 40s share of the 240s budget");
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
console.log(`${cases.length - failures}/${cases.length} AI router checks passed.`);
if (failures > 0) process.exitCode = 1;
