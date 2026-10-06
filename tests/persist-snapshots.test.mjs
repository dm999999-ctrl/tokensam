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

test("persistRawRecords: false stores observations but writes no raw_provider_records", async () => {
  // Binance opts out (see run-binance-collection.ts): its ticker payload holds nothing the
  // observations do not, and at 180 tokens per run the rows dominated a 500 MB plan.
  const db = createFakeSupabase({ seed: {} });
  const result = await persistProviderSnapshots(
    db.client, [snapshot("bitcoin", observedAt(1))], undefined, undefined, { persistRawRecords: false },
  );

  assert.equal(result.rawRecords, 0, "the reported count must not claim rows it did not write");
  assert.equal(db.rows("raw_provider_records").length, 0, "no raw rows may be written");
  const observations = db.rows("token_metric_observations");
  assert.equal(observations.length, 1, "observations are still persisted");
  assert.equal(observations[0].raw_record_id, null, "the FK is left null, not dangling");
  assert.equal(Number(observations[0].value), 1);
});

test("raw records are still written by default, so other providers are unaffected", async () => {
  const db = createFakeSupabase({ seed: {} });
  const result = await persistProviderSnapshots(db.client, [snapshot("bitcoin", observedAt(1))]);

  assert.equal(result.rawRecords, 1);
  assert.equal(db.rows("raw_provider_records").length, 1);
  assert.equal(db.rows("token_metric_observations")[0].raw_record_id, db.rows("raw_provider_records")[0].id);
});

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

test("existingKeysLookup: token filtering now happens in JS (not SQL), but dedup keys still partition correctly by token_id", async () => {
  // 1200 pre-existing rows belong to OTHER tokens this run never mentions (same provider/window,
  // so the DB-side query still returns them now that `.in('token_id', ...)` was dropped from SQL
  // in favor of a Set check in JS) plus one genuine duplicate for a token this run DOES touch.
  // Total matching rows (1201) still forces 2 keyset pages, exercising pagination across a mix of
  // in-scope and out-of-scope tokens.
  const foreignRows = Array.from({ length: 1200 }, (_, index) => existingRow(index + 1, `unrelated-token-${index}`, "price_usd", observedAt(20)));
  const ourExistingRow = existingRow(1201, "our-token-a", "price_usd", observedAt(20));
  const db = createFakeSupabase({ seed: { token_metric_observations: [...foreignRows, ourExistingRow] } });

  const result = await persistProviderSnapshots(db.client, [
    snapshot("our-token-a", ourExistingRow.observed_at), // duplicates ourExistingRow: must be excluded
    snapshot("our-token-b", observedAt(20)), // genuinely new: must be inserted
  ]);

  assert.equal(result.observations, 1, "only the genuinely new token's observation is inserted");
  assert.equal(db.rows("token_metric_observations").filter((row) => row.token_id === "our-token-a").length, 1,
    "the existing row for our-token-a is not duplicated, even though unrelated tokens' rows share its provider/observed_at window");
  assert.equal(db.rows("token_metric_observations").filter((row) => row.token_id === "our-token-b").length, 1,
    "our-token-b is inserted: unrelated tokens' rows never suppress a different token's genuinely new observation");
  assert.equal(db.rows("token_metric_observations").filter((row) => row.token_id.startsWith("unrelated-token-")).length, 1200,
    "unrelated tokens' pre-existing rows are read but never written to or duplicated");
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
