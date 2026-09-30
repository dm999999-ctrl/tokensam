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
  const { runCoinGeckoBackfill, MAX_BACKFILL_TOKENS } = await import("../src/lib/providers/run-coingecko-backfill.ts");
  const { MIN_REQUEST_INTERVAL_MS } = await import("../src/lib/providers/coingecko.ts");
  const { canonicalTokens } = await import("../src/data/canonical-tokens.ts");
  const client = createSupabaseAdminClient();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // MAX_BACKFILL_TOKENS caps a single call; auto-chunk the full universe (or an explicit
  // --tokens list) into batches that size instead of requiring the caller to split it
  // manually. Sequential (not parallel), same pacing as the live collector.
  const allIds = tokenIds ?? canonicalTokens.map((token) => token.id);
  const batches = [];
  for (let i = 0; i < allIds.length; i += MAX_BACKFILL_TOKENS) batches.push(allIds.slice(i, i + MAX_BACKFILL_TOKENS));

  const allResults = [];
  let totalRequests = 0;
  for (const [index, batch] of batches.entries()) {
    // runCoinGeckoBackfill's own pacing counter resets to 0 on each call, so its first
    // request wouldn't otherwise wait -- without this, back-to-back batches could fire
    // two requests less than MIN_REQUEST_INTERVAL_MS apart at the boundary.
    if (index > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    if (batches.length > 1) console.log(`-- Batch ${index + 1}/${batches.length} (${batch.length} tokens) --`);
    const summary = await runCoinGeckoBackfill(client, { tokenIds: batch, dryRun, log: (line) => console.log(line) });
    allResults.push(...summary.results);
    totalRequests += summary.requests;
    if (summary.stoppedEarly) {
      console.log(`${summary.stoppedEarly} Stopping remaining batches.`);
      break;
    }
  }

  const count = (status) => allResults.filter((result) => result.status === status).length;
  const added = allResults.reduce((sum, result) => sum + result.newObservations, 0);
  console.log(`CoinGecko backfill ${dryRun ? "(dry run, nothing written) " : ""}completed: ${totalRequests} request(s).`);
  console.log(`Tokens backfilled: ${count("backfilled")}; already up to date: ${count("up_to_date")}; failed: ${count("failed")}; skipped: ${count("skipped")}.`);
  console.log(`${dryRun ? "Observations that would be added" : "New historical observations stored"}: ${added}.`);
  if (count("failed") > 0) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown backfill error.";
  console.error(`CoinGecko backfill did not run: ${message}`);
  process.exitCode = 1;
}
