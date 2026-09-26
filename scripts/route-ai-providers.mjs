// Phase 2 controlled real test of the AI provider router, in isolated mode.
//
//   node --conditions=react-server scripts/route-ai-providers.mjs [--tokens=bitcoin-btc,uniswap-uni]
//
// Reads each token's Token Profile data from Supabase (read-only) and builds the same
// profile payload the service sends (what the page shows), then routes ONE
// report request per token through the production router, registry, adapters,
// schema check, and evidence validator, sharing one provider-health store across
// tokens (so a provider that fails for the first token cools down for the second).
// Nothing is stored. Prints only sanitized route records: never keys, prompts,
// contexts, or model output.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_TOKENS = 2;

function loadLocalEnvironment() {
  const envPath = resolve(process.cwd(), ".env.local");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? true];
}));

try {
  const tokenIds = typeof args.tokens === "string" ? args.tokens.split(",").map((id) => id.trim()).filter(Boolean) : ["bitcoin-btc", "uniswap-uni"];
  if (tokenIds.length === 0 || tokenIds.length > MAX_TOKENS) throw new Error(`Pass 1-${MAX_TOKENS} token IDs.`);
  loadLocalEnvironment();

  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { getLiveTokenProfile } = await import("../src/lib/data/live-data.ts");
  const { buildProfilePayload } = await import("../src/lib/analysis/profile-payload.ts");
  const { buildProfileEvidenceIndex } = await import("../src/lib/analysis/profile-evidence.ts");
  const { attachEvidencePeriods, buildProfileResponseSchema, buildProfileValidationSchema } = await import("../src/lib/analysis/profile-contract.ts");
  const { buildCorrectionUserContent, correctionItems, unmappedWordingFrom } = await import("../src/lib/analysis/correction-pass.ts");
  const { PROFILE_SYSTEM_INSTRUCTION: SYSTEM_INSTRUCTION, buildProfileUserContent } = await import("../src/lib/analysis/prompt.ts");
  const { AnalysisValidationError, validateModelAnalysis } = await import("../src/lib/analysis/schema.ts");
  const { schemaErrors } = await import("../src/lib/analysis/ai/json-schema.ts");
  const { allowedFreeTiers, buildProviders, providerPriority } = await import("../src/lib/analysis/ai/registry.ts");
  const { NoProviderSucceededError, routeReport } = await import("../src/lib/analysis/ai/router.ts");
  const { createProviderHealth } = await import("../src/lib/analysis/ai/health.ts");
  const { categorize } = await import("../benchmark/evaluate.ts");
  const { ANALYSIS_DEADLINE_MS } = await import("../src/lib/analysis/service.ts");

  const env = process.env;
  const providers = buildProviders(env);
  const allowed = allowedFreeTiers(env);
  console.log(JSON.stringify({
    type: "router_config", priority: providerPriority(env), allowedTiers: [...allowed],
    providers: [...providers.values()].map((provider) => ({ id: provider.id, model: provider.model, configured: provider.configured, freeTier: provider.freeTier.status, structuredOutput: provider.capabilities.structuredOutput })),
  }));

  const client = createSupabaseAdminClient();
  const health = createProviderHealth();

  // --max-requests=N: hard cap on provider HTTP requests for the whole run (e.g. 1 for a single
  // controlled request). Requests beyond the cap never leave the machine; the adapter sees a
  // network error, so the router records it and stops without contacting the provider.
  const maxRequests = typeof args["max-requests"] === "string" ? Number(args["max-requests"]) : Infinity;
  let providerRequests = 0;
  const fetchImpl = async (url, init) => {
    providerRequests += 1;
    if (providerRequests > maxRequests) {
      console.log(JSON.stringify({ type: "request_blocked", reason: `--max-requests=${maxRequests} reached`, host: new URL(String(url)).hostname }));
      throw new TypeError("Blocked by --max-requests (not sent).");
    }
    return fetch(url, init);
  };
  for (const tokenId of tokenIds) {
    const profile = await getLiveTokenProfile(tokenId, client);
    if (!profile) throw new Error(`No Token Profile data for ${tokenId}.`);
    const payload = buildProfilePayload(profile);
    const evidence = buildProfileEvidenceIndex(payload);
    const userText = buildProfileUserContent(payload);
    // Same structural contract as the service: payload-derived ID enums, periods attached by the server.
    const responseSchema = buildProfileResponseSchema(payload);
    const validationSchema = buildProfileValidationSchema(payload);
    console.log(JSON.stringify({ type: "payload_size", tokenId, payloadVersion: payload.version, fields: payload.fields.length, payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).length, systemBytes: new TextEncoder().encode(SYSTEM_INSTRUCTION).length, userTextBytes: new TextEncoder().encode(userText).length, responseSchemaBytes: new TextEncoder().encode(JSON.stringify(responseSchema)).length }));
    const last = { raw: null, messages: [], schemaValid: null };
    const validate = (raw) => {
      last.raw = raw;
      last.messages = [];
      const json = attachEvidencePeriods(raw, payload);
      const shape = schemaErrors(json, validationSchema);
      last.schemaValid = shape.length === 0;
      if (shape.length) { last.messages = shape; }
      if (shape.length) { console.log(JSON.stringify({ type: "schema_errors", tokenId, count: shape.length, first: shape.slice(0, 5) })); return { ok: false, category: "structured_output", violations: shape.length, reason: "schema_mismatch" }; }
      try {
        return { ok: true, value: validateModelAnalysis(json, evidence), violations: 0 };
      } catch (error) {
        if (!(error instanceof AnalysisValidationError)) throw error;
        last.messages = error.violations;
        // Categories only (no violation text, which can quote model output).
        const types = {};
        for (const violation of error.violations) { const key = categorize(violation); types[key] = (types[key] ?? 0) + 1; }
        console.log(JSON.stringify({ type: "validation_violations", tokenId, total: error.violations.length, byCategory: types }));
        if (args["show-violations"] === true) for (const violation of error.violations) console.log(JSON.stringify({ type: "violation", tokenId, category: categorize(violation), message: violation }));
        return { ok: false, category: "validation", violations: error.violations.length, reason: "evidence_contract" };
      }
    };
    const started = Date.now();
    const bytes = new TextEncoder().encode(SYSTEM_INSTRUCTION + userText + JSON.stringify(responseSchema)).length;
    // ---- BENCHMARK: --direct-provider=<id> sends ONE request to that provider's adapter, bypassing
    // router eligibility (production routing is unchanged), then applies the identical server checks.
    if (typeof args["direct-provider"] === "string") {
      const provider = providers.get(args["direct-provider"]);
      if (!provider) throw new Error(`Unknown provider ${args["direct-provider"]}.`);
      if (!provider.configured) throw new Error(`${provider.id} is not configured (key or model missing).`);
      console.log(JSON.stringify({ type: "direct_request", tokenId, provider: provider.id, model: provider.model, freeTier: provider.freeTier.status, structuredOutput: provider.capabilities.structuredOutput, timeoutMs: ANALYSIS_DEADLINE_MS }));
      const result = await provider.generateStructuredReport(
        { systemInstruction: SYSTEM_INSTRUCTION, userText, responseSchema, estimatedInputTokens: Math.ceil(bytes / 3.5) },
        { timeoutMs: ANALYSIS_DEADLINE_MS, fetchImpl, diagnostics: { runId: `direct-${tokenId}`, sink: (event) => { if (event.type === "ai.provider_attempt") console.log(JSON.stringify({ type: "provider_http", provider: event.provider, model: event.model, httpStatus: event.httpStatus, latencyMs: event.latencyMs, outcome: event.outcome, responseBytes: event.body?.bytes ?? null, error: event.error, usage: event.response?.usage ?? null })); } } },
      );
      const elapsed = Date.now() - started;
      const verdict = result.ok ? validate(result.json) : null;
      const messages = result.ok ? last.messages : [];
      const count = (pattern) => messages.filter((message) => pattern.test(message)).length;
      const known = [/unknown source ID|value not in enum/, /has no period/, /is not a period established|names a period/, /do not match any value|contains numbers or dates/, /context's reason|explains unavailable/, /directional\/sentiment language/, /must cite|without citing their sources/, /introduces "/];
      const lines = [
        `${provider.displayName} benchmark (direct, one request, nothing stored)`,
        "",
        `Model: ${result.ok ? result.servedModel ?? provider.model : provider.model}`,
        `HTTP status: ${result.ok ? 200 : result.httpStatus ?? "none"}${result.ok ? "" : ` (${result.category}: ${result.reason})`}`,
        `Latency: ${elapsed} ms`,
        `Input tokens: ${result.usage?.inputTokens ?? "n/a"}  Output tokens: ${result.usage?.outputTokens ?? "n/a"}  Reasoning tokens: ${result.usage?.reasoningTokens ?? "n/a"}`,
        `JSON valid: ${result.ok ? "yes" : result.category === "structured_output" ? "no" : "n/a"}`,
        `Schema valid: ${result.ok ? (last.schemaValid ? "yes" : "no") : "n/a"}`,
        `Evidence-contract valid: ${verdict?.ok ? "yes" : result.ok && last.schemaValid ? "no" : "n/a"}`,
        `Violation count: ${result.ok ? messages.length : "n/a"}`,
        "",
        `invented evidence IDs: ${count(known[0])}`,
        `missing periods: ${count(known[1])}`,
        `unsupported period words: ${count(known[2])}`,
        `unsupported numbers: ${count(known[3])}`,
        `provider-mapping violations: ${count(known[4])}`,
        `sentiment violations: ${count(known[5])}`,
        `missing citations: ${count(known[6])}`,
        `outside-concept violations: ${count(known[7])}`,
        `other: ${messages.filter((message) => !known.some((pattern) => pattern.test(message))).length}`,
        "",
        `Result: ${verdict?.ok ? "ACCEPTED" : "REJECTED"}`,
      ];
      console.log(lines.join("\n"));
      if (messages.length) {
        console.log("\nValidator violations:");
        for (const message of messages) console.log(`- ${message}`);
      }
      continue;
    }
    let attempts;
    let outcome;
    try {
      const routed = await routeReport({
        request: { systemInstruction: SYSTEM_INSTRUCTION, userText, responseSchema, estimatedInputTokens: Math.ceil(bytes / 3.5) },
        providers, priority: providerPriority(env), allowedTiers: allowed, deadlineAt: started + ANALYSIS_DEADLINE_MS, validate, health, fetchImpl,
        diagnostics: { runId: `route-${tokenId}`, sink: (event) => { if (event.type === "ai.provider_attempt") console.log(JSON.stringify({ type: "provider_http", provider: event.provider, model: event.model, httpStatus: event.httpStatus, latencyMs: event.latencyMs, headersMs: event.headersMs, outcome: event.outcome, responseBytes: event.body?.bytes ?? null, error: event.error, usage: event.response?.usage ?? null })); } },
      });
      attempts = routed.attempts;
      outcome = { ok: true, provider: routed.provider.id };
    } catch (error) {
      if (!(error instanceof NoProviderSucceededError)) throw error;
      attempts = error.attempts;
      outcome = { ok: false, invalidOutput: error.invalidOutput };
    }
    for (const attempt of attempts) {
      console.log(JSON.stringify({
        type: "route_attempt", tokenId, provider: attempt.providerId, model: attempt.model, action: attempt.action, skipReason: attempt.skipReason,
        retry: attempt.retry, latencyMs: attempt.latencyMs === null ? null : Math.round(attempt.latencyMs), timeoutMs: attempt.timeoutMs,
        httpStatus: attempt.httpStatus, category: attempt.category, reason: attempt.reason, servedModel: attempt.servedModel, upstreamProvider: attempt.upstreamProvider,
        inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null, reasoningTokens: attempt.usage?.reasoningTokens ?? null,
        validationPassed: attempt.validationPassed, validationViolations: attempt.validationViolations,
      }));
    }
    console.log(JSON.stringify({ type: "route_result", tokenId, ...outcome, wallMs: Date.now() - started, stored: false }));

    // ---- EXPERIMENT: one constrained correction pass (isolated; nothing stored) ----
    const initial = attempts.filter((attempt) => attempt.action === "attempted").at(-1);
    if (args["correction-pass"] === true && !outcome.ok && initial && initial.category === "validation" && last.raw) {
      const initialViolations = [...last.messages];
      const items = correctionItems(initialViolations, unmappedWordingFrom(SYSTEM_INSTRUCTION));
      const correctionText = buildCorrectionUserContent(payload, last.raw, items);
      console.log(JSON.stringify({ type: "correction_request", tokenId, provider: initial.providerId, locations: items.length, violations: initialViolations.length, userTextBytes: new TextEncoder().encode(correctionText).length }));
      for (const item of items) console.log(JSON.stringify({ type: "correction_item", ...item }));
      const provider = providers.get(initial.providerId);
      const correctionStarted = Date.now();
      const corrected = await provider.generateStructuredReport(
        { systemInstruction: SYSTEM_INSTRUCTION, userText: correctionText, responseSchema, estimatedInputTokens: Math.ceil(new TextEncoder().encode(SYSTEM_INSTRUCTION + correctionText).length / 3.5) },
        { timeoutMs: provider.attemptTimeoutMs, fetchImpl, diagnostics: { runId: `correction-${tokenId}`, sink: (event) => { if (event.type === "ai.provider_attempt") console.log(JSON.stringify({ type: "correction_http", provider: event.provider, model: event.model, httpStatus: event.httpStatus, latencyMs: event.latencyMs, outcome: event.outcome, responseBytes: event.body?.bytes ?? null, usage: event.response?.usage ?? null })); } } },
      );
      const correctionMs = Date.now() - correctionStarted;
      let finalResult = null;
      if (corrected.ok) finalResult = validate(corrected.json);
      const finalMessages = corrected.ok ? last.messages : [];
      const count = (pattern) => finalMessages.filter((message) => pattern.test(message)).length;
      const lines = [
        "Mistral correction-pass experiment",
        "",
        "Initial:",
        `  model: ${initial.servedModel ?? initial.model}`,
        `  latency: ${Math.round(initial.latencyMs)} ms`,
        `  input tokens: ${initial.usage?.inputTokens ?? "n/a"}  output tokens: ${initial.usage?.outputTokens ?? "n/a"}`,
        `  violations: ${initialViolations.length}`,
        "",
        "Correction:",
        `  HTTP: ${corrected.ok ? 200 : corrected.httpStatus ?? "none"}${corrected.ok ? "" : ` (${corrected.category}: ${corrected.reason})`}`,
        `  JSON valid: ${corrected.ok ? "yes" : "no"}`,
        `  schema valid: ${corrected.ok ? (last.schemaValid ? "yes" : "no") : "n/a"}`,
        `  response time: ${correctionMs} ms`,
        `  input tokens: ${corrected.usage?.inputTokens ?? "n/a"}  output tokens: ${corrected.usage?.outputTokens ?? "n/a"}`,
        "",
        "Final:",
        `  violations: ${corrected.ok ? finalMessages.length : "n/a (no corrected report)"}`,
        `  invented evidence IDs: ${count(/unknown source ID|value not in enum/)}`,
        `  missing periods: ${count(/has no period/)}`,
        `  unsupported period words: ${count(/is not a period established|names a period/)}`,
        `  unsupported numbers: ${count(/do not match any value|contains numbers or dates/)}`,
        `  provider-mapping violations: ${count(/context's reason|explains unavailable/)}`,
        `  sentiment violations: ${count(/directional\/sentiment language/)}`,
        "",
        "Result:",
        `  ${finalResult?.ok ? "ACCEPTED" : "REJECTED"}`,
        "",
        `Total elapsed: ${Date.now() - started} ms (nothing stored)`,
      ];
      console.log(lines.join("\n"));
      if (finalMessages.length) {
        console.log("\nFinal validator violations:");
        for (const message of finalMessages) console.log(`- ${message}`);
      }
    }
  }
  console.log(JSON.stringify({ type: "health_after", health: health.snapshot() }));
} catch (error) {
  console.error(`Router test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
