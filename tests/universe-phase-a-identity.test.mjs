import assert from "node:assert/strict";

import { buildSymbolIndex, resolveCandidateIdentity } from "../src/lib/universe/identity.ts";
import { applyCatalogAbsenceDeprecation, applyDuplicateAndLifecycleRules } from "../src/lib/universe/duplicates.ts";
import { newCandidateFromMarket } from "../src/lib/universe/types.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

function candidate(overrides) {
  const base = newCandidateFromMarket({ id: overrides.coingeckoId ?? "example", symbol: overrides.symbol ?? "EX", name: overrides.name ?? "Example" }, "2026-09-29T00:00:00.000Z");
  return { ...base, ...overrides };
}

test("a symbol unique in the pool resolves to a valid identity", () => {
  const solo = candidate({ coingeckoId: "solana", symbol: "SOL" });
  const index = buildSymbolIndex([solo]);
  const resolution = resolveCandidateIdentity(solo, index);
  assert.equal(resolution.status, "valid");
  assert.equal(resolution.evidence.method, "unique_symbol_in_pool");
});

test("a colliding symbol with no curated override stays unresolved (never guessed)", () => {
  const a = candidate({ coingeckoId: "token-a", symbol: "TOKEN" });
  const b = candidate({ coingeckoId: "token-b", symbol: "TOKEN" });
  const index = buildSymbolIndex([a, b]);
  const resolutionA = resolveCandidateIdentity(a, index);
  const resolutionB = resolveCandidateIdentity(b, index);
  assert.equal(resolutionA.status, "collision");
  assert.equal(resolutionB.status, "collision");
  assert.deepEqual(resolutionA.evidence.collidingCoingeckoIds, ["token-a", "token-b"]);
});

test("contract-address duplicates are marked duplicate, pointing at the higher-market-cap canonical row, never deleted", () => {
  const canonical = candidate({ coingeckoId: "canonical-coin", symbol: "DUP", chainId: "ethereum", contractAddress: "0xABC", marketCapRank: 10 });
  const dupe = candidate({ coingeckoId: "duplicate-coin", symbol: "DUP2", chainId: "ethereum", contractAddress: "0xabc", marketCapRank: 500 });
  const result = applyDuplicateAndLifecycleRules([canonical, dupe]);
  const canonicalRow = result.find((c) => c.coingeckoId === "canonical-coin");
  const dupeRow = result.find((c) => c.coingeckoId === "duplicate-coin");
  assert.equal(canonicalRow.universeStatus, "candidate");
  assert.equal(dupeRow.universeStatus, "duplicate");
  assert.ok(dupeRow.statusReason.includes("canonical-coin"));
});

test("a curated migration marks the old ID migrated without deleting it", () => {
  const matic = candidate({ coingeckoId: "matic-network", symbol: "MATIC" });
  const result = applyDuplicateAndLifecycleRules([matic]);
  assert.equal(result[0].universeStatus, "migrated");
  assert.equal(result[0].migratedToCoingeckoId, "polygon-ecosystem-token");
  assert.ok(result[0].statusReason.length > 0);
});

test("a curated deprecation marks the asset deprecated without deleting it", () => {
  const ftt = candidate({ coingeckoId: "ftx-token", symbol: "FTT" });
  const result = applyDuplicateAndLifecycleRules([ftt]);
  assert.equal(result[0].universeStatus, "deprecated");
});

const CHECKED_AT = "2026-09-29T00:00:00.000Z";
const THRESHOLD = 3;

test("falling outside this run's ranked pool but still in CoinGecko's full catalog is NOT deprecation evidence", () => {
  // The classic false positive this fix targets: a token drops from rank #2,499
  // to #2,501 on a volatile day. It is absent from `discoveredIds` (the ranked
  // top-poolSize window) but still returned by /coins/list.
  const rankedOut = candidate({ coingeckoId: "fell-out-of-pool" });
  const result = applyCatalogAbsenceDeprecation([rankedOut], new Set(), new Set(["fell-out-of-pool"]), null, THRESHOLD, CHECKED_AT);
  assert.equal(result[0].universeStatus, "candidate", "still genuinely listed, so its status is untouched");
  assert.equal(result[0].absentFromSourceStreak, 0);
});

test("a /coins/list outage never counts as absence evidence, in either direction", () => {
  const candidateWithPriorStreak = candidate({ coingeckoId: "unknown-during-outage", absentFromSourceStreak: 2 });
  const result = applyCatalogAbsenceDeprecation([candidateWithPriorStreak], new Set(), new Set(), "network error", THRESHOLD, CHECKED_AT);
  assert.equal(result[0].universeStatus, "candidate");
  assert.equal(result[0].absentFromSourceStreak, 2, "the streak is neither advanced nor reset during a provider outage");
});

test("a single confirmed absence from the full catalog is needs_review, never an immediate deprecation", () => {
  const goneOnce = candidate({ coingeckoId: "confirmed-absent-once" });
  const result = applyCatalogAbsenceDeprecation([goneOnce], new Set(), new Set(), null, THRESHOLD, CHECKED_AT);
  assert.equal(result[0].universeStatus, "needs_review");
  assert.equal(result[0].absentFromSourceStreak, 1);
  assert.ok(result[0].statusReason.includes("1 of 3"));
});

test("only threshold consecutive confirmed absences promote a candidate to deprecated", () => {
  let current = candidate({ coingeckoId: "confirmed-absent-repeatedly" });
  for (let run = 1; run < THRESHOLD; run += 1) {
    current = applyCatalogAbsenceDeprecation([current], new Set(), new Set(), null, THRESHOLD, CHECKED_AT)[0];
    assert.equal(current.universeStatus, "needs_review", `run ${run} should still be needs_review, not deprecated`);
  }
  current = applyCatalogAbsenceDeprecation([current], new Set(), new Set(), null, THRESHOLD, CHECKED_AT)[0];
  assert.equal(current.universeStatus, "deprecated");
  assert.equal(current.absentFromSourceStreak, THRESHOLD);
  assert.ok(current.statusReason.includes(`${THRESHOLD} consecutive`));
});

test("reappearing in the full catalog resets the absence streak", () => {
  const previouslyFlagged = candidate({ coingeckoId: "back-again", universeStatus: "needs_review", absentFromSourceStreak: 2 });
  const result = applyCatalogAbsenceDeprecation([previouslyFlagged], new Set(), new Set(["back-again"]), null, THRESHOLD, CHECKED_AT);
  assert.equal(result[0].absentFromSourceStreak, 0);
  assert.equal(result[0].universeStatus, "needs_review", "duplicates.ts only resets the streak; run-validation.ts clears the status once it is re-validated as present");
});

test("a candidate re-validated this run (present in discoveredIds) is left alone by the absence rule entirely", () => {
  const rechecked = candidate({ coingeckoId: "rechecked-this-run", absentFromSourceStreak: 1 });
  const result = applyCatalogAbsenceDeprecation([rechecked], new Set(["rechecked-this-run"]), new Set(), null, THRESHOLD, CHECKED_AT);
  assert.equal(result[0], rechecked, "no change at all: run-validation.ts is responsible for resetting the streak on the fresh-validation path");
});

test("a candidate already duplicate/migrated is left alone by the catalog-absence rule", () => {
  const dup = candidate({ coingeckoId: "already-duplicate", universeStatus: "duplicate" });
  const result = applyCatalogAbsenceDeprecation([dup], new Set(), new Set(), null, THRESHOLD, CHECKED_AT);
  assert.equal(result[0].universeStatus, "duplicate");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} Phase A identity/duplicate checks passed.`);
if (failures > 0) process.exitCode = 1;
