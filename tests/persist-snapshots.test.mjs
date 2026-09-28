import assert from "node:assert/strict";

import { persistProviderSnapshots } from "../src/lib/providers/persist-snapshots.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-28T17:45:00.000Z");
const observedAt = (offsetMinutes) => new Date(NOW.getTime() - offsetMinutes * 60_000).toISOString();

function snapshot(tokenId, priceObservedAt) {
  return {
    providerId: "coingecko",
    endpointLabel: "GET /coins/markets",
    asset: { tokenId, chainId: "ethereum", externalAssetId: tokenId },
    observedAt: priceObservedAt,
    collectedAt: NOW.toISOString(),
    rawPayload: { id: tokenId },
    observations: [{
      tokenId, chainId: "ethereum", metricId: "price_usd", value: 1, status: "available",
      observedAt: priceObservedAt, collectedAt: NOW.toISOString(), windowDays: null,
      scope: "token", sourceField: "current_price", note: null,
    }],
  };
}

function existingRow(id, tokenId, metricId, observedAtIso) {
  return {
    id, token_id: tokenId, chain_id: "ethereum", metric_id: metricId, provider_id: "coingecko",
    value: 1, status: "available", observed_at: observedAtIso, collected_at: observedAtIso,
    window_days: null, source_field: "current_price", note: null,
  };
}

test("existingKeysLookup keyset pagination: dedup is exact across more than one page of pre-existing rows", async () => {
  // 1500 pre-existing rows across 1500 distinct tokens, all inside the observed_at window this
  // run's snapshots fall in — forces the existingKeys loop through 2 pages (limit 1000/page).
  const existingRows = Array.from({ length: 1500 }, (_, index) => existingRow(index + 1, `padding-token-${index}`, "price_usd", observedAt(30)));

  // Two real snapshots: one duplicates an existing token+metric+observedAt+window key exactly
  // (must be excluded from the insert), the other is genuinely new (must be inserted).
  const duplicateTokenId = "padding-token-0";
  const duplicateObservedAt = existingRows[0].observed_at;
  const newTokenId = "brand-new-token";

  const db = createFakeSupabase({ seed: { token_metric_observations: existingRows } });
  const result = await persistProviderSnapshots(db.client, [
    snapshot(duplicateTokenId, duplicateObservedAt),
    snapshot(newTokenId, observedAt(30)),
  ]);

  assert.equal(result.observations, 1, "the duplicate observation is excluded; only the new one is inserted");
  const inserted = db.rows("token_metric_observations").filter((row) => row.token_id === newTokenId);
  assert.equal(inserted.length, 1);
  assert.equal(db.rows("token_metric_observations").filter((row) => row.token_id === duplicateTokenId).length, 1,
    "the pre-existing duplicate row is untouched, not doubled");
  assert.equal(db.rows("token_metric_observations").length, existingRows.length + 1);
});

test("existingKeysLookup keyset pagination: every pre-existing row is visited exactly once (no gaps, no repeats)", async () => {
  // Enough rows to require 3 pages (limit 1000/page); every one of them should be treated as
  // "existing" for its own token, so none of the corresponding new snapshots get inserted.
  const existingRows = Array.from({ length: 2500 }, (_, index) => existingRow(index + 1, `token-${index}`, "price_usd", observedAt(10)));
  const db = createFakeSupabase({ seed: { token_metric_observations: existingRows } });

  const snapshots = existingRows.map((row) => snapshot(row.token_id, row.observed_at));
  const result = await persistProviderSnapshots(db.client, snapshots);

  assert.equal(result.observations, 0, "every snapshot duplicates an existing row across all 3 keyset pages");
  assert.equal(db.rows("token_metric_observations").length, existingRows.length, "nothing new was inserted");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} persist-snapshots checks passed.`);
if (failures > 0) process.exitCode = 1;
