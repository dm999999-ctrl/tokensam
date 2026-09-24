import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

try {
  loadLocalEnvironment();
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { runMetricsCalculation } = await import("../src/lib/metrics/run-calculation.ts");
  const summary = await runMetricsCalculation(createSupabaseAdminClient());
  console.log("Deterministic metrics calculation completed.");
  console.log(`Canonical tokens processed: ${summary.tokens}; provider observations read: ${summary.providerObservationsRead}; latest DEX pair records read: ${summary.latestDexPairRecords}.`);
  console.log(`Calculated metric rows upserted: ${summary.calculatedMetrics}; available: ${summary.available}; unavailable: ${summary.unavailable}; invalid: ${summary.invalid}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown metrics calculation error.";
  console.error(`Metrics calculation failed: ${message}`);
  process.exitCode = 1;
}
