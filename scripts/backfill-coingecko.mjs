import { existsSync, readFileSync } from "node:fs";
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

// Usage: pnpm backfill:coingecko [--tokens=bitcoin-btc,uniswap-uni] [--dry-run]
// Manual and bounded: 2 CoinGecko requests per token, paced like the live collector.
const args = process.argv.slice(2);
const tokensArg = args.find((arg) => arg.startsWith("--tokens="));
const tokenIds = tokensArg ? tokensArg.slice("--tokens=".length).split(",").map((value) => value.trim()).filter(Boolean) : undefined;
const dryRun = args.includes("--dry-run");

loadLocalEnvironment();

try {
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { runCoinGeckoBackfill } = await import("../src/lib/providers/run-coingecko-backfill.ts");
  const summary = await runCoinGeckoBackfill(createSupabaseAdminClient(), { tokenIds, dryRun, log: (line) => console.log(line) });
  const count = (status) => summary.results.filter((result) => result.status === status).length;
  const added = summary.results.reduce((sum, result) => sum + result.newObservations, 0);
  console.log(`CoinGecko backfill ${dryRun ? "(dry run, nothing written) " : ""}completed: ${summary.requests} request(s).`);
  console.log(`Tokens backfilled: ${count("backfilled")}; already up to date: ${count("up_to_date")}; failed: ${count("failed")}; skipped: ${count("skipped")}.`);
  console.log(`${dryRun ? "Observations that would be added" : "New historical observations stored"}: ${added}.`);
  if (summary.stoppedEarly) console.log(summary.stoppedEarly);
  if (count("failed") > 0) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown backfill error.";
  console.error(`CoinGecko backfill did not run: ${message}`);
  process.exitCode = 1;
}
