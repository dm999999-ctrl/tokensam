// Phase 0 AI pipeline diagnostics: context-size measurement from real fixtures,
// and mocked provider attempts (no network, no API quota). Also checks that the
// instrumentation is observational: same results, and nothing sensitive logged.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { measureResearchContext, sanitizeProviderError } from "../src/lib/analysis/diagnostics.ts";
import { generateStructuredJson } from "../src/lib/analysis/gemini.ts";
import { generateStructuredJsonOpenRouter } from "../src/lib/analysis/openrouter.ts";
import { SYSTEM_INSTRUCTION, buildUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA } from "../src/lib/analysis/schema.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const GEMINI_KEY = "test-gemini-key-not-real-diag";
const OR_KEY = "sk-or-test-key-not-real-diag";
const PROMPT_MARKER = "PROMPT-MARKER-7f3a";
const OUTPUT_MARKER = "OUTPUT-MARKER-91c2";
const ERROR_MARKER = "RAW-ERROR-TEXT-55e1";
const noSleep = async () => {};
const request = { systemInstruction: `System ${PROMPT_MARKER}`, userText: `User ${PROMPT_MARKER}`, responseSchema: { type: "object" } };

function collector() {
  const events = [];
  return {
    events,
    sink: (event) => events.push(event),
    /** Attempt events are emitted once the (cloned) body read settles; wait for them. */
    async settle(count) {
      for (let i = 0; i < 200 && events.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      return events;
    },
  };
}

function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    return next(init);
  };
  return { fetchImpl, calls };
}

const json = (body, status = 200, headers = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const googleError = (code, status, message, details = []) => json({ error: { code, status, message: `${message} ${ERROR_MARKER} ${GEMINI_KEY}`, details } }, code);
const geminiSuccess = (output = { ok: OUTPUT_MARKER }) => json({
  candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }],
  modelVersion: "gemini-test-model",
  usageMetadata: { promptTokenCount: 15234, candidatesTokenCount: 4120, thoughtsTokenCount: 2210, totalTokenCount: 21564, promptTokensDetails: [{ modality: "TEXT", tokenCount: 15234 }] },
});
const openRouterSuccess = (output = { ok: OUTPUT_MARKER }) => json({
  id: "gen-123abc", model: "vendor/routed-model:free", provider: "UpstreamCo",
  choices: [{ finish_reason: "stop", native_finish_reason: "stop", message: { content: JSON.stringify(output) } }],
  usage: { prompt_tokens: 16000, completion_tokens: 6000, total_tokens: 22000, completion_tokens_details: { reasoning_tokens: 2500 } },
});
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** 2xx headers now, whitespace keep-alive bytes, then the body stalls until a (shortened) deadline aborts it. */
const stalledBody = (whitespace = "\n \n \n ", stallMs = 40) => () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(whitespace));
      setTimeout(() => controller.error(timeoutError()), stallMs);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
};

function assertClean(events) {
  const serialized = JSON.stringify(events);
  for (const secret of [GEMINI_KEY, OR_KEY, PROMPT_MARKER, OUTPUT_MARKER, ERROR_MARKER, "authorization", "x-goog-api-key"]) {
    assert.ok(!serialized.includes(secret), `diagnostics must not contain ${secret}`);
  }
}

// ---- Context size (real-data fixture; no provider calls) ----

const FIXTURES = [{ token: "bitcoin (2026-09-24)", path: "tests/fixtures/bitcoin-context-2026-09-24.json" }];

test("C1. context size is measured from the real research-context fixture(s)", () => {
  const rows = [];
  for (const fixture of FIXTURES) {
    const context = JSON.parse(readFileSync(fixture.path, "utf8"));
    const size = measureResearchContext(context, { systemInstruction: SYSTEM_INSTRUCTION, userContent: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA });
    assert.equal(size.contextBytes, Buffer.byteLength(JSON.stringify(context)));
    assert.equal(size.promptBytes, size.systemInstructionBytes + size.userContentBytes + size.responseSchemaBytes);
    assert.ok(size.userContentBytes >= size.contextBytes, "the user turn carries the whole context");
    assert.ok(["history", "calculatedMetrics"].includes(size.largestComponent));
    rows.push({
      token: fixture.token, contextVersion: size.contextVersion, contextBytes: size.contextBytes,
      calculatedMetricsBytes: size.componentBytes.calculatedMetrics, historyBytes: size.componentBytes.history,
      observationsBytes: size.componentBytes.observations, unavailableBytes: size.componentBytes.unavailable,
      largest: size.largestComponent, systemBytes: size.systemInstructionBytes, schemaBytes: size.responseSchemaBytes,
      promptBytes: size.promptBytes, ...size.counts,
    });
  }
  console.table(rows);
});

// ---- Gemini (mocked) ----

test("G1. Gemini HTTP 503 twice: status, sanitized reason, retry flags, no raw error text", async () => {
  const diag = collector();
  const { fetchImpl, calls } = scripted([
    googleError(503, "UNAVAILABLE", "The model is overloaded. Please try again later."),
    googleError(503, "UNAVAILABLE", "This model is currently experiencing high demand."),
  ]);
  await assert.rejects(
    generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: diag.sink, runId: "r1" } }),
    /Gemini returned HTTP 503\./,
  );
  assert.equal(calls.length, 2, "retry count unchanged");
  const [first, second] = await diag.settle(2);
  assert.deepEqual([first.attempt, first.isRetry, second.attempt, second.isRetry], [1, false, 2, true]);
  for (const event of [first, second]) {
    assert.equal(event.type, "ai.provider_attempt");
    assert.equal(event.runId, "r1");
    assert.equal(event.httpStatus, 503);
    assert.equal(event.outcome, "http_error");
    assert.equal(event.headersReceived, true);
    assert.equal(event.error.status, "UNAVAILABLE");
    assert.equal(event.model, "gemini-test");
    assert.equal(event.requestBytes, Buffer.byteLength(calls[0].init.body));
    assert.ok(event.body.bytes > 0);
  }
  assert.equal(first.error.category, "overloaded");
  assert.equal(second.error.category, "high_demand");
  assertClean(diag.events);
});

test("G2. Gemini HTTP 429: quota IDs, RetryInfo, and Retry-After are captured", async () => {
  const diag = collector();
  const details = [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" },
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
  ];
  const limited = () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota ${ERROR_MARKER}`, details } }), { status: 429, headers: { "retry-after": "7" } });
  const { fetchImpl } = scripted([limited, limited]);
  await assert.rejects(generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: diag.sink } }), /HTTP 429/);
  const [event] = await diag.settle(2);
  assert.equal(event.httpStatus, 429);
  assert.equal(event.retryAfterSeconds, 7);
  assert.equal(event.error.status, "RESOURCE_EXHAUSTED");
  assert.equal(event.error.category, "quota");
  assert.deepEqual(event.error.reasons, ["RATE_LIMIT_EXCEEDED"]);
  assert.ok(event.error.quotaIds.includes("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"));
  assert.equal(event.error.retryDelay, "7s");
  assertClean(diag.events);
});

test("G3. Gemini success: usageMetadata, served model, finish reason, response size; result unchanged", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([geminiSuccess()]);
  const result = await generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: diag.sink } });
  assert.deepEqual(result, { json: { ok: OUTPUT_MARKER }, modelVersion: "gemini-test-model", usage: { promptTokenCount: 15234, candidatesTokenCount: 4120, thoughtsTokenCount: 2210, totalTokenCount: 21564, "promptTokensDetails.TEXT": 15234 } });
  const [event] = await diag.settle(1);
  assert.equal(event.outcome, "success");
  assert.equal(event.response.finishReason, "STOP");
  assert.equal(event.response.servedModel, "gemini-test-model");
  assert.deepEqual(event.response.usage, { promptTokenCount: 15234, candidatesTokenCount: 4120, thoughtsTokenCount: 2210, totalTokenCount: 21564, "promptTokensDetails.TEXT": 15234 });
  assert.equal(event.body.state, "complete");
  assert.ok(event.body.bytes > 100);
  assert.equal(event.error, null);
  assertClean(diag.events);
});

test("G4. Gemini timeout and network failure: no headers, timedOut flag, same thrown errors", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([() => { throw timeoutError(); }, () => { throw timeoutError(); }]);
  await assert.rejects(generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: diag.sink } }), /The Gemini request timed out\./);
  const events = await diag.settle(2);
  assert.deepEqual(events.map((event) => [event.outcome, event.timedOut, event.headersReceived, event.httpStatus]), [["timeout", true, false, null], ["timeout", true, false, null]]);

  const network = collector();
  const failing = scripted([() => { throw new TypeError("fetch failed"); }, () => { throw new TypeError("fetch failed"); }]);
  await assert.rejects(generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl: failing.fetchImpl, sleep: noSleep, diagnostics: { sink: network.sink } }), /network error/);
  assert.deepEqual((await network.settle(2)).map((event) => event.outcome), ["network", "network"]);
});

test("G5. Gemini body stalls after 2xx headers: body_timeout with headers-first evidence", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([stalledBody()]);
  await assert.rejects(generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: diag.sink } }), /timed out while receiving the response/);
  const [event] = await diag.settle(1);
  assert.equal(event.outcome, "body_timeout");
  assert.equal(event.headersReceived, true);
  assert.equal(event.body.state, "aborted");
});

// ---- OpenRouter (mocked) ----

test("O1. OpenRouter 2xx headers then stalled body: headers arrived first; whitespace-only bytes; aborted", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([stalledBody("\n\n\n\n\n\n", 60)]);
  await assert.rejects(
    generateStructuredJsonOpenRouter({ config: { apiKey: OR_KEY, model: "vendor/model:free" }, ...request, fetchImpl, diagnostics: { sink: diag.sink } }),
    /The OpenRouter request timed out while receiving the response\./,
  );
  const [event] = await diag.settle(1);
  assert.equal(event.provider, "openrouter");
  assert.equal(event.model, "vendor/model:free");
  assert.equal(event.httpStatus, 200);
  assert.equal(event.headersReceived, true);
  assert.ok(event.headersMs < event.latencyMs, "headers arrived before the deadline");
  assert.equal(event.outcome, "body_timeout");
  assert.equal(event.timedOut, true);
  assert.equal(event.body.state, "aborted");
  assert.equal(event.body.bytes, 6);
  assert.equal(event.body.leadingWhitespaceBytes, 6, "only keep-alive whitespace arrived");
  assert.equal(event.body.firstContentByteMs, null, "no JSON content arrived before the abort");
  assertClean(diag.events);
});

test("O2. OpenRouter success: routed model, upstream provider, generation ID, usage; result unchanged", async () => {
  const diag = collector();
  const { fetchImpl, calls } = scripted([openRouterSuccess()]);
  const result = await generateStructuredJsonOpenRouter({ config: { apiKey: OR_KEY, model: "vendor/model:free" }, ...request, fetchImpl, diagnostics: { sink: diag.sink } });
  assert.deepEqual(result, { json: { ok: OUTPUT_MARKER }, model: "vendor/routed-model:free", upstreamProvider: "UpstreamCo", usage: { prompt_tokens: 16000, completion_tokens: 6000, total_tokens: 22000, "completion_tokens_details.reasoning_tokens": 2500 } });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ["model", "messages", "response_format", "provider", "max_tokens"], "request body unchanged");
  assert.equal(body.max_tokens, 16_384);
  const [event] = await diag.settle(1);
  assert.equal(event.outcome, "success");
  assert.equal(event.response.servedModel, "vendor/routed-model:free");
  assert.equal(event.response.upstreamProvider, "UpstreamCo");
  assert.equal(event.response.generationId, "gen-123abc");
  assert.deepEqual(event.response.usage, { prompt_tokens: 16000, completion_tokens: 6000, total_tokens: 22000, "completion_tokens_details.reasoning_tokens": 2500 });
  assert.equal(event.body.state, "complete");
  assertClean(diag.events);
});

test("O3. OpenRouter non-2xx: status and sanitized upstream provider, never the raw message", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([json({ error: { code: 429, message: `Rate limit exceeded: free-models-per-day ${ERROR_MARKER}`, metadata: { provider_name: "UpstreamCo", raw: `${ERROR_MARKER} upstream body` } } }, 429)]);
  await assert.rejects(generateStructuredJsonOpenRouter({ config: { apiKey: OR_KEY, model: "vendor/model:free" }, ...request, fetchImpl, diagnostics: { sink: diag.sink } }), /OpenRouter returned HTTP 429\./);
  const [event] = await diag.settle(1);
  assert.equal(event.httpStatus, 429);
  assert.equal(event.outcome, "http_error");
  assert.equal(event.error.category, "rate_limit");
  assert.deepEqual(event.error.reasons, ["provider:UpstreamCo"]);
  assertClean(diag.events);
});

test("O4. OpenRouter timeout before headers: timedOut, no headers", async () => {
  const diag = collector();
  const { fetchImpl } = scripted([() => { throw timeoutError(); }]);
  await assert.rejects(generateStructuredJsonOpenRouter({ config: { apiKey: OR_KEY, model: "vendor/model:free" }, ...request, fetchImpl, diagnostics: { sink: diag.sink } }), /The OpenRouter request timed out\./);
  const [event] = await diag.settle(1);
  assert.deepEqual([event.outcome, event.headersReceived, event.timedOut], ["timeout", false, true]);
});

// ---- Observational guarantees ----

test("S1. a failing diagnostics sink never changes the result", async () => {
  const throwing = () => { throw new Error("sink exploded"); };
  const { fetchImpl } = scripted([geminiSuccess()]);
  const result = await generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep: noSleep, diagnostics: { sink: throwing } });
  assert.deepEqual(result.json, { ok: OUTPUT_MARKER });
  const or = scripted([openRouterSuccess()]);
  const orResult = await generateStructuredJsonOpenRouter({ config: { apiKey: OR_KEY, model: "m" }, ...request, fetchImpl: or.fetchImpl, diagnostics: { sink: throwing } });
  assert.deepEqual(orResult.json, { ok: OUTPUT_MARKER });
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("S2. retry timing is unchanged: Retry-After (capped 10 s) or 2 s, then 1 s after a network error", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const cases = [
    [[googleError(503, "UNAVAILABLE", "x"), geminiSuccess()], [2000]],
    [[json({ error: { code: 429 } }, 429, { "retry-after": "30" }), geminiSuccess()], [10000]],
    [[() => { throw new TypeError("fetch failed"); }, geminiSuccess()], [1000]],
  ];
  for (const [responses, expected] of cases) {
    sleeps.length = 0;
    const { fetchImpl } = scripted(responses);
    await generateStructuredJson({ config: { apiKey: GEMINI_KEY, model: "gemini-test" }, ...request, fetchImpl, sleep, diagnostics: { sink: () => {} } });
    assert.deepEqual(sleeps, expected);
  }
});

test("S3. the sanitizer keeps only allow-listed shapes", () => {
  assert.equal(sanitizeProviderError("not json", 503).category, "unavailable");
  assert.equal(sanitizeProviderError(null, 200), null);
  const hostile = sanitizeProviderError(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE; DROP TABLE x", details: [{ reason: "bad reason with spaces and a very long tail" }] } }), 503);
  assert.equal(hostile.status, null, "non-enum status text is dropped");
  assert.deepEqual(hostile.reasons, [], "non-enum reason text is dropped");
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
console.log(`${cases.length - failures}/${cases.length} AI diagnostics checks passed.`);
if (failures > 0) process.exitCode = 1;
