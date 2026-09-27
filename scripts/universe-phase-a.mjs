import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

// Usage: pnpm universe:validate [--pool-size=2500] [--dry-run] [--report-out=docs/universe-phase-a-report.md]
//
// Discovers a CoinGecko-sized candidate pool, validates CoinGecko/Binance
// Spot/identity/logo/historical/supply eligibility for each candidate, and
// writes both a Markdown and a JSON validation report (AGENTS.md Phase A
// #32). Without --dry-run this also upserts every candidate into
// `universe_candidates` and records a `universe_validation_runs` row; it never
// touches `tokens`, the Dashboard's canonical universe, or any historical
// observation (AGENTS.md #26, #30).
const args = process.argv.slice(2);
const poolSizeArg = args.find((arg) => arg.startsWith("--pool-size="));
const poolSize = poolSizeArg ? Number(poolSizeArg.slice("--pool-size=".length)) : undefined;
const dryRun = args.includes("--dry-run");
const reportOutArg = args.find((arg) => arg.startsWith("--report-out="));
const reportOutPath = resolve(process.cwd(), reportOutArg ? reportOutArg.slice("--report-out=".length) : "docs/universe-phase-a-report.md");

loadLocalEnvironment();

const sleep = (durationMs) => new Promise((r) => setTimeout(r, durationMs));

try {
  const { runUniverseValidation } = await import("../src/lib/universe/run-validation.ts");
  const { renderMarkdownReport } = await import("../src/lib/universe/report.ts");

  let client = null;
  let existingCandidates = [];
  let persist = null;
  if (!dryRun) {
    const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
    persist = await import("../src/lib/universe/persist.ts");
    client = createSupabaseAdminClient();
    existingCandidates = await persist.loadExistingCandidates(client);
  }

  const startedAt = new Date().toISOString();
  const runId = client ? await persist.startValidationRun(client, startedAt, { poolSize: poolSize ?? null }) : null;

  const result = await runUniverseValidation({
    config: poolSize ? { candidatePoolSize: poolSize } : undefined,
    fetchImpl: fetch,
    sleep,
    existingCandidates,
  });

  if (client) {
    await persist.persistCandidates(client, result.candidates);
    await persist.finishValidationRun(client, runId, new Date().toISOString(), result.outage ? "failed" : "succeeded", result.report.counts, result.outage);
  }

  mkdirSync(dirname(reportOutPath), { recursive: true });
  writeFileSync(reportOutPath, renderMarkdownReport(result.report));
  writeFileSync(reportOutPath.replace(/\.md$/, ".json"), JSON.stringify(result.report, null, 2));

  const c = result.report.counts;
  console.log(`Phase A validation ${dryRun ? "(dry run, nothing persisted) " : ""}completed: ${c.totalCandidates} candidates.`);
  console.log(`CoinGecko valid: ${c.coinGeckoValid}; Binance Spot valid: ${c.binanceSpotValid}; both valid: ${c.bothValid}.`);
  console.log(`Eligible: ${c.eligible}; needs review: ${c.needsReview}; temporarily unavailable: ${c.temporarilyUnavailable}; ineligible: ${c.ineligible}.`);
  console.log(`Report written to ${reportOutPath}`);
  if (result.outage) {
    console.error(`Provider outage during discovery: ${result.outage}`);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown Phase A validation error.";
  console.error(`Phase A validation did not run: ${message}`);
  process.exitCode = 1;
}
