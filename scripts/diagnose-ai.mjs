// Phase 0 AI pipeline diagnostics.
//
//   node --conditions=react-server scripts/diagnose-ai.mjs --tokens=bitcoin-btc,uniswap-uni
//     Read-only: builds each token's research context from Supabase and prints its
//     sizes. No provider calls, no writes.
//
//   ... --generate
//     Also runs ONE real generation per token through the normal service path
//     (same models, retries, timeouts, validation, cooldown, hourly cap, and
//     storage as the Token Profile button). At most 4 tokens, run sequentially,
//     never retried. Prints only the sanitized diagnostic events.
//
// Never prints keys, prompts, research contexts, or model output.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_TOKENS = 4;

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
const tokens = String(args.tokens ?? "").split(",").map((token) => token.trim()).filter(Boolean);

try {
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) throw new Error(`Pass --tokens=<id,...> with 1-${MAX_TOKENS} canonical token IDs.`);
  loadLocalEnvironment();
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { isCanonicalTokenId, loadResearchContext } = await import("../src/lib/analysis/research-context.ts");
  const { measureResearchContext } = await import("../src/lib/analysis/diagnostics.ts");
  const { SYSTEM_INSTRUCTION, buildUserContent } = await import("../src/lib/analysis/prompt.ts");
  const { ANALYSIS_RESPONSE_SCHEMA } = await import("../src/lib/analysis/schema.ts");
  const { getGeminiConfig } = await import("../src/lib/analysis/gemini.ts");
  const { getOpenRouterConfig } = await import("../src/lib/analysis/openrouter.ts");
  const client = createSupabaseAdminClient();

  // Model identifiers are not secrets; keys are never read into output.
  const gemini = getGeminiConfig();
  let openRouter = null;
  try { openRouter = getOpenRouterConfig(); } catch { openRouter = null; }
  console.log(JSON.stringify({ type: "config", geminiConfigured: Boolean(gemini), geminiModel: gemini?.model ?? null, openRouterConfigured: Boolean(openRouter), openRouterModel: openRouter?.model ?? null }));

  const rows = [];
  for (const tokenId of tokens) {
    if (!isCanonicalTokenId(tokenId)) throw new Error(`Not a canonical token ID: ${tokenId}`);
    const context = await loadResearchContext(client, tokenId);
    if (!context) throw new Error(`No context for ${tokenId}`);
    const size = measureResearchContext(context, { systemInstruction: SYSTEM_INSTRUCTION, userContent: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA });
    console.log(JSON.stringify({ type: "context_size", tokenId, ...size }));
    rows.push({
      tokenId, contextBytes: size.contextBytes, calculatedMetricsBytes: size.componentBytes.calculatedMetrics, historyBytes: size.componentBytes.history,
      observationsBytes: size.componentBytes.observations, unavailableBytes: size.componentBytes.unavailable, largest: size.largestComponent,
      promptBytes: size.promptBytes, observations: size.counts.observations, calculated: size.counts.calculatedMetrics, historyPoints: size.counts.historyPoints, citableIds: size.counts.citableIds,
    });
  }
  console.table(rows);

  if (args.generate === true) {
    const { generateTokenAnalysis } = await import("../src/lib/analysis/service.ts");
    for (const tokenId of tokens) {
      const events = [];
      const started = Date.now();
      const result = await generateTokenAnalysis(client, tokenId, { diagnosticsSink: (event) => events.push(event) });
      // Attempt events are emitted when their (cloned) body read settles.
      await new Promise((done) => setTimeout(done, 1500));
      for (const event of events) console.log(JSON.stringify(event));
      console.log(JSON.stringify({
        type: "generation_result", tokenId, ok: result.ok, reason: result.ok ? null : result.reason,
        message: result.ok ? null : result.message, wallMs: Date.now() - started,
        provider: result.ok ? result.analysis.metadata.provider : null, model: result.ok ? result.analysis.metadata.model : null,
        fallback: result.ok ? result.analysis.metadata.fallback ?? null : null,
      }));
    }
  }
} catch (error) {
  console.error(`AI diagnostics failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
