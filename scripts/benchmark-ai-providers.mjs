// Phase 1B free-provider bake-off (isolated from the application).
//
//   node --conditions=react-server scripts/benchmark-ai-providers.mjs [--providers=gemini,openrouter,mistral,groq]
//        [--tokens=bitcoin-btc,uniswap-uni] [--out=<results.json>] [--dry-run]
//
// Reads each token's current research context from Supabase (read-only, no
// writes), then sends ONE request per provider per token (no retries) with the
// same instruction, context, and schema. Providers without a key are reported
// as NOT CONFIGURED. Prints and saves only normalized measurements: never keys,
// prompts, contexts, or model output.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_TOKENS = 2;
const ALL_PROVIDERS = ["gemini", "mistral", "groq", "openrouter", "qwen", "deepseek", "glm", "kimi", "minimax"];

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
const list = (value, fallback) => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback);

try {
  const providers = list(args.providers, ALL_PROVIDERS);
  const tokenIds = list(args.tokens, ["bitcoin-btc", "uniswap-uni"]);
  if (tokenIds.length === 0 || tokenIds.length > MAX_TOKENS) throw new Error(`Pass 1-${MAX_TOKENS} token IDs.`);
  for (const provider of providers) if (!ALL_PROVIDERS.includes(provider)) throw new Error(`Unknown provider ${provider}.`);
  loadLocalEnvironment();

  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { loadResearchContext } = await import("../src/lib/analysis/research-context.ts");
  const { ADAPTERS } = await import("../benchmark/adapters.ts");
  const { runBenchmark, BENCHMARK_MAX_OUTPUT_TOKENS, BENCHMARK_TIMEOUT_MS } = await import("../benchmark/run.ts");

  const client = createSupabaseAdminClient();
  const now = new Date();
  const tokens = [];
  for (const tokenId of tokenIds) {
    // Loaded once per token, so every provider receives the identical context.
    const context = await loadResearchContext(client, tokenId, now);
    if (!context) throw new Error(`No research context for ${tokenId}.`);
    tokens.push({ tokenId, context });
  }
  console.log(JSON.stringify({
    type: "benchmark_config", tokens: tokenIds, contextBuiltAt: now.toISOString(), maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS, timeoutMs: BENCHMARK_TIMEOUT_MS,
    providers: providers.map((id) => ({ id, model: ADAPTERS[id].model(process.env), configured: Boolean(process.env[ADAPTERS[id].keyEnv]?.trim()), structuredOutput: ADAPTERS[id].structuredOutput })),
  }));
  if (args["dry-run"] === true) process.exit(0);

  const results = await runBenchmark(providers, tokens, {
    env: process.env,
    onResult: (result) => console.log(JSON.stringify({ type: "benchmark_result", ...result })),
  });
  console.table(results.map((result) => ({
    provider: result.provider, model: result.servedModel ?? result.model, token: result.token,
    success: result.success, latencyS: result.latencyMs === null ? null : Math.round(result.latencyMs / 100) / 10,
    input: result.inputTokens, output: result.outputTokens, reasoning: result.reasoningTokens,
    jsonValid: result.structuredOutputValid, evidenceValid: result.validationPassed, violations: result.validationViolationCount,
    sections: result.sectionsPresent, cost: result.cost, error: result.errorCategory ? `${result.errorCategory} ${result.errorStatus ?? ""}`.trim() : null,
  })));
  if (typeof args.out === "string") writeFileSync(args.out, JSON.stringify({ contextBuiltAt: now.toISOString(), results }, null, 2));
} catch (error) {
  console.error(`Benchmark failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
