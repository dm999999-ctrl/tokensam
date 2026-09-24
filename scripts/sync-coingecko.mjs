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
const { runCoinGeckoCollection } = await import("../src/lib/providers/run-coingecko-collection.ts");

try {
  const result = await runCoinGeckoCollection(createSupabaseAdminClient());
  console.log("CoinGecko collection completed.");
  console.log(`Assets mapped: ${result.mappedAssets}; returned: ${result.returnedAssets}.`);
  console.log(`Raw records stored: ${result.rawRecords}; normalized observations stored: ${result.observations}.`);
  if (result.missingAssetIds.length > 0) {
    console.log(`No market record returned for ${result.missingAssetIds.length} mapped CoinGecko ID(s).`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown collection error.";
  console.error(`CoinGecko collection failed: ${message}`);
  process.exitCode = 1;
}
