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

test("a candidate absent from the latest catalog fetch becomes deprecated, not deleted", () => {
  const stillListed = candidate({ coingeckoId: "still-here" });
  const noLongerListed = candidate({ coingeckoId: "gone-now" });
  const result = applyCatalogAbsenceDeprecation([stillListed, noLongerListed], new Set(["still-here"]), "2026-09-29T00:00:00.000Z");
  assert.equal(result.find((c) => c.coingeckoId === "still-here").universeStatus, "candidate");
  const deprecated = result.find((c) => c.coingeckoId === "gone-now");
  assert.equal(deprecated.universeStatus, "deprecated");
  assert.ok(deprecated.statusReason.includes("2026-09-29"));
});

test("a candidate already duplicate/migrated is left alone by the catalog-absence rule", () => {
  const dup = candidate({ coingeckoId: "already-duplicate", universeStatus: "duplicate" });
  const result = applyCatalogAbsenceDeprecation([dup], new Set(), "2026-09-29T00:00:00.000Z");
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
