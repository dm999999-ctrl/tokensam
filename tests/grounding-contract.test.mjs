import assert from "node:assert/strict";

import { buildProviders, providerPriority, DEFAULT_PROVIDER_PRIORITY } from "../src/lib/analysis/ai/registry.ts";
import { PROFILE_PROMPT_VERSION, PROFILE_SYSTEM_INSTRUCTION } from "../src/lib/analysis/prompt.ts";

/**
 * Proves the shared grounding contract (PROFILE_SYSTEM_INSTRUCTION) reaches every one of the
 * six currently configured Production providers unmodified, that each provider's structured-output
 * mode (json_schema vs json_object) is unaffected by the prompt change, and that the specific
 * failure modes from Production run r4k2vvp1 (unsupported numbers/periods, unmapped DEX Screener
 * mentions, unavailable-data hedging) are explicitly prohibited in the instruction text every
 * provider receives. This does not call any real API: every fetch is faked.
 */

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const ENV = {
  AI_PROVIDER_PRIORITY: "glm,mistral,openrouter,siliconflow,modelscope,gemini",
  AI_ALLOWED_FREE_TIERS: "FREE",
  ZHIPU_API_KEY: "fake-glm-key", GLM_MODEL: "glm-4.7-flash",
  MISTRAL_API_KEY: "fake-mistral-key", MISTRAL_MODEL: "ministral-14b-2512",
  OPENROUTER_API_KEY: "fake-openrouter-key", OPENROUTER_MODEL: "openrouter/free",
  SILICONFLOW_API_KEY: "fake-siliconflow-key", SILICONFLOW_MODEL: "Qwen/Qwen3-32B",
  MODELSCOPE_API_TOKEN: "fake-modelscope-key", MODELSCOPE_MODEL: "Qwen/Qwen3.5-72B-Instruct",
  GEMINI_API_KEY: "fake-gemini-key", GEMINI_MODEL: "gemini-3.6-flash",
};

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const REQUEST = { systemInstruction: PROFILE_SYSTEM_INSTRUCTION, userText: "<token_samurai_data>{}</token_samurai_data>", responseSchema: SCHEMA, estimatedInputTokens: 100 };

/** A minimal, well-formed success body per provider's API shape (only enough to complete the call). */
function fakeResponseFor(id) {
  if (id === "gemini") {
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], modelVersion: "gemini-3.6-flash", usageMetadata: {} }), text: async () => "{}" };
  }
  // openrouter and every OpenAI-compatible provider share the chat-completions envelope.
  const body = JSON.stringify({ id: "gen-1", model: "served-model", choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage: {} });
  return { ok: true, status: 200, headers: new Map(), text: async () => body, json: async () => JSON.parse(body) };
}

test("1. every one of the six configured providers receives PROFILE_SYSTEM_INSTRUCTION verbatim (as its own text or as a prefix before the schema)", async () => {
  const providers = buildProviders(ENV);
  const sixProviders = ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"];
  assert.deepEqual(providerPriority(ENV), sixProviders, "the six providers named in the implementation request, in order");
  for (const id of sixProviders) {
    const provider = providers.get(id);
    assert.ok(provider?.configured, `${id} is configured from ENV`);
    const requestsPerHost = new Map();
    const fetchImpl = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      requestsPerHost.set(id, body);
      return fakeResponseFor(id === "gemini" ? "gemini" : "openai_compatible");
    };
    const outcome = await provider.generateStructuredReport(REQUEST, { fetchImpl, timeoutMs: 5_000, diagnostics: { runId: "t", sink: () => {} } });
    assert.equal(outcome.ok, true, `${id}: the faked call completes`);
    const body = requestsPerHost.get(id);
    const systemText = id === "gemini" ? body.systemInstruction.parts[0].text : body.messages[0].content;
    assert.ok(systemText.startsWith(PROFILE_SYSTEM_INSTRUCTION), `${id}: the exact shared instruction is the system message (or its prefix before an appended schema)`);
  }
});

test("2-3. json_schema providers keep json_schema; json_object providers keep json_object — the prompt change did not touch structured-output configuration", async () => {
  const providers = buildProviders(ENV);
  const expectations = { glm: "json_object", mistral: "json_schema", openrouter: "json_schema", siliconflow: "json_object", modelscope: "json_object", gemini: "json_schema" };
  for (const [id, expected] of Object.entries(expectations)) {
    assert.equal(providers.get(id).capabilities.structuredOutput, expected, `${id} capability`);
  }
  for (const [id, expected] of Object.entries(expectations)) {
    if (id === "gemini") continue; // Gemini enforces the schema through generationConfig, not response_format.
    const provider = providers.get(id);
    let sentBody;
    const fetchImpl = async (_url, init) => { sentBody = JSON.parse(init.body); return fakeResponseFor("openai_compatible"); };
    await provider.generateStructuredReport(REQUEST, { fetchImpl, timeoutMs: 5_000, diagnostics: { runId: "t", sink: () => {} } });
    assert.equal(sentBody.response_format.type, expected, `${id}: response_format.type unchanged`);
    if (expected === "json_object") {
      assert.ok(sentBody.messages[0].content.includes(JSON.stringify(SCHEMA)), `${id}: schema still appended as text after the instruction`);
    } else {
      assert.deepEqual(sentBody.response_format.json_schema.schema, SCHEMA, `${id}: schema still sent as an enforced json_schema`);
    }
  }
});

test("4. the prompt explicitly prohibits unsupported numbers and periods, tied to the statement's own citations", () => {
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Every number in any text must appear in a field that the SAME statement's own sourceIds cite/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /never a field cited only by a different statement, risk, data gap, or question/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /only when a field cited in this same statement's sourceIds states that same period/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Do not assume a metric exists just because it is commonly available/);
});

test("5. the prompt explicitly prohibits unmapped DEX Screener references", () => {
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /there is no verified DEX Screener mapping for this token, so DEX data is unavailable by design/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Never give another reason for the absence/);
});

test("6. the prompt explicitly requires unavailable data to be reported as unavailable, not filled from general knowledge", () => {
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /If something is not in the data, it is unavailable/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /it is unavailable for this token in this report, and you must say so instead of filling the gap/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /If the needed data is unavailable, say that it is unavailable instead/);
});

test("7. the evidence validator (evidence-rules.ts, schema.ts, profile-contract.ts) is untouched by this change: only prompt.ts and its version changed", async () => {
  const { execSync } = await import("node:child_process");
  const diffNames = execSync("git diff --name-only HEAD", { cwd: process.cwd() }).toString().trim().split("\n").filter(Boolean);
  const validatorFiles = ["src/lib/analysis/evidence-rules.ts", "src/lib/analysis/schema.ts", "src/lib/analysis/profile-contract.ts", "src/lib/analysis/ai/router.ts"];
  for (const file of validatorFiles) assert.ok(!diffNames.includes(file), `${file} must not appear in the diff for this change`);
  assert.equal(PROFILE_PROMPT_VERSION, "profile-5", "the prompt version was bumped so stored analyses record which instructions produced them");
});

test("8. the provider priority list and default order are unchanged by this change", () => {
  assert.deepEqual(DEFAULT_PROVIDER_PRIORITY, ["qwen", "hunyuan", "glm", "mistral", "groq", "siliconflow", "gemini", "openrouter"]);
});

test("9. Production run gdj2hhww: the prompt now explicitly covers overview-writing order, history-metadata-is-not-evidence, source-naming-is-not-evidence, and period-inference bans", () => {
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /write that section's statements first\. Then write the overview describing only which topics those statements cover/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /A hist: field is historical evidence only when it actually appears in fields\[\]/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /The existence of a metric name or a window label in these instructions is not by itself evidence that this token has that history/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Naming a provider, metric, or period anywhere in these instructions or in the response schema does not make it available for this token/);
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Never infer a period from a metric's name.*from a history-series definition, from an API or schema naming convention, or from general knowledge/);
});

let passed = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${cases.length} grounding-contract checks passed.`);
