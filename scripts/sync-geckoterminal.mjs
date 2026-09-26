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

const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
const { runGeckoTerminalCollection } = await import("../src/lib/providers/run-geckoterminal-collection.ts");

try {
  const result = await runGeckoTerminalCollection(createSupabaseAdminClient());
  console.log("GeckoTerminal collection completed.");
  console.log(`Canonical tokens in universe: ${result.tokensInUniverse}; eligible: ${result.eligibleTokens}; collected this run: ${result.mappedTokens}.`);
  if (result.cappedByRateLimit) {
    console.log(`Run capped to stay within the public rate limit; ${result.eligibleTokens - result.mappedTokens} eligible token(s) were not collected this run.`);
  }
  console.log(`Raw records stored: ${result.rawRecords}; normalized observations stored: ${result.observations}; pool mappings stored: ${result.pairMappings}.`);
  console.log(`Networks covered: ${result.networksCovered.map((item) => `${item.network} (${item.count} DEXes)`).join(", ") || "none"}.`);
  console.log(`Unavailable normalized metrics: ${result.unavailable.length}.`);
  if (result.unmappedTokens.length > 0) {
    console.log(`No exact GeckoTerminal network/address configured for ${result.unmappedTokens.length} token(s).`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown collection error.";
  console.error(`GeckoTerminal collection failed: ${message}`);
  process.exitCode = 1;
}
