import assert from "node:assert/strict";

import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { readLatestObservations, readObservationWindow } from "../src/lib/data/observation-reads.ts";

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

/**
 * These cover the keyset (seek) paging that replaced OFFSET paging in
 * observation-reads.ts. OFFSET made the metrics engine's 14-day coingecko
 * price_usd read cost O(n^2/page) and exceed PostgREST's statement timeout in
 * production. The paging loop is the risky part of that change: it must return
 * every row, never skip or duplicate across page boundaries, and terminate.
 */
const PAGE_SIZE = 1000;

function observation(id, tokenId, providerId, metricId, observedAt) {
  return {
    id,
    token_id: tokenId,
    chain_id: "chain-a",
    metric_id: metricId,
    provider_id: providerId,
    raw_record_id: null,
    value: id,
    status: "available",
    observed_at: observedAt,
    collected_at: observedAt,
    window_days: null,
    source_field: metricId,
    note: null,
    excluded_reason: null,
  };
}

/** Rows spanning several pages, with ids deliberately non-contiguous. */
function seedRows(count) {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => observation(
    // Gaps in the id sequence: a seek of "id > last" must not assume id == offset.
    (index + 1) * 3,
    `token-${index % 7}`,
    "coingecko",
    "price_usd",
    new Date(base + index * 60_000).toISOString(),
  ));
}

test("readObservationWindow returns every row across multiple keyset pages", async () => {
  const count = PAGE_SIZE * 2 + 137; // two full pages plus a partial one
  const rows = seedRows(count);
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  const read = await readObservationWindow(
    db.client,
    [...new Set(rows.map((row) => row.token_id))],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.equal(read.length, count, "every row must come back");
  const ids = read.map((row) => row.id);
  assert.equal(new Set(ids).size, count, "no row may be returned twice across page boundaries");
  assert.deepEqual([...ids].sort((a, b) => a - b), rows.map((row) => row.id), "no row may be skipped");
});

test("readObservationWindow stops at the cutoff and does not loop forever", async () => {
  const rows = seedRows(PAGE_SIZE + 10);
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  // A cutoff past every seeded row: the first page comes back empty and paging ends.
  const none = await readObservationWindow(
    db.client,
    ["token-0"],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2027-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(none, []);

  // An exact page-size result set must also terminate rather than spin on a full page.
  const exact = createFakeSupabase({ seed: { token_metric_observations: seedRows(PAGE_SIZE) } });
  const all = await readObservationWindow(
    exact.client,
    [...new Set(seedRows(PAGE_SIZE).map((row) => row.token_id))],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(all.length, PAGE_SIZE);
});

test("a provider or metric outside the requested series is never returned", async () => {
  const rows = [
    ...seedRows(5),
    observation(9001, "token-0", "binance", "price_usd", "2026-10-01T00:00:00.000Z"),
    observation(9002, "token-0", "coingecko", "market_cap_usd", "2026-10-01T00:00:00.000Z"),
  ];
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  const read = await readObservationWindow(
    db.client,
    ["token-0"],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );
  for (const row of read) {
    assert.equal(row.provider_id, "coingecko");
    assert.equal(row.metric_id, "price_usd");
  }
});

test("readLatestObservations still collapses to the newest row per token/provider/metric", async () => {
  // Row order from the database is now id order, not newest-first, so the
  // newest-per-metric collapse must come from latestPerMetric rather than the query.
  const rows = [
    observation(1, "token-a", "coingecko", "price_usd", "2026-10-06T09:00:00.000Z"),
    observation(2, "token-a", "coingecko", "price_usd", "2026-10-06T11:00:00.000Z"),
    observation(3, "token-a", "coingecko", "price_usd", "2026-10-06T10:00:00.000Z"),
  ];
  const db = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });

  const read = await readLatestObservations(db.client, ["token-a"]);
  const prices = read.filter((row) => row.metric_id === "price_usd");
  assert.equal(prices.length, 1, "one row per token/provider/metric");
  assert.equal(prices[0].observed_at, "2026-10-06T11:00:00.000Z", "the newest observation wins, not the highest id");
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

console.log(`${cases.length - failures}/${cases.length} observation-read checks passed.`);
if (failures > 0) process.exitCode = 1;
