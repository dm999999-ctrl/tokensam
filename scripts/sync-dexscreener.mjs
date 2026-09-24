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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadLocalEnvironment();

try {
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { runDexScreenerCollection } = await import("../src/lib/providers/run-dexscreener-collection.ts");
  const result = await runDexScreenerCollection(createSupabaseAdminClient());
  console.log("DEX Screener collection completed.");
  console.log(`Canonical tokens in universe: ${result.tokensInUniverse}; exact address mappings: ${result.mappedTokens}; returned: ${result.returnedTokens}.`);
  console.log(`Raw records stored: ${result.rawRecords}; normalized observations stored: ${result.observations}; pair mappings stored: ${result.pairMappings}.`);
  console.log(`Unavailable normalized metrics: ${result.unavailable.length}.`);
  if (result.unmappedTokens.length > 0) {
    console.log(`No exact provider address configured for ${result.unmappedTokens.length} token(s): ${result.unmappedTokens.map((item) => item.tokenId).join(", ")}.`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown collection error.";
  console.error(`DEX Screener collection failed: ${message}`);
  process.exitCode = 1;
}
