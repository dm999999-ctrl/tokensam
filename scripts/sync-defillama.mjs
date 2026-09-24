import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnvironment() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvironment();

// Default: current TVL, fees, and revenue (what the scheduled refresh collects).
// --history: dated 90-day TVL history from /protocol/{slug} (large payloads; run explicitly).
const mode = process.argv.includes("--history") ? "history" : "current";

try {
  const { getDefiLlamaConfig } = await import("../src/lib/providers/defillama.ts");
  // Enforce the documented written-permission gate before loading credentials
  // or constructing the privileged database client.
  getDefiLlamaConfig();
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { runDefiLlamaCollection } = await import("../src/lib/providers/run-defillama-collection.ts");
  const result = await runDefiLlamaCollection(createSupabaseAdminClient(), { mode });
  console.log(`DeFiLlama ${mode} collection completed.`);
  console.log(`Curated protocols mapped: ${result.mappedProtocols}; returned: ${result.returnedProtocols}.`);
  console.log(`Raw records stored: ${result.rawRecords}; normalized observations stored: ${result.observations}.`);
  console.log(`Requests: ${result.requests}; retried: ${result.retriedRequests}; slowest: ${result.slowestRequest}.`);
  for (const item of result.skipped) console.log(`Skipped ${item.tokenId}: ${item.reason}`);
  if (result.unavailable.length > 0) {
    console.log(`Unavailable protocol metrics: ${result.unavailable.length}.`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown collection error.";
  console.error(`DeFiLlama collection did not run: ${message}`);
  process.exitCode = 1;
}
