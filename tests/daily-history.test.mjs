import assert from "node:assert/strict";

import { DAY_MS, dailySamples, SERIES_RULES } from "../src/lib/indicators/series.ts";
import { evaluateTechnicalIndicators } from "../src/lib/indicators/build.ts";
import { runCoinGeckoDailyHistory } from "../src/lib/providers/run-coingecko-daily-history.ts";
import { runDefiLlamaDailyHistory } from "../src/lib/providers/run-defillama-daily-history.ts";
import { isDailyHistoryDue, runDataRefresh } from "../src/lib/refresh/orchestrator.ts";
import { SupabaseRefreshStore } from "../src/lib/refresh/store.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

// Mirrors the investigated GMX scenario: "now" sits partway through 26 Sept 2026 UTC.
const TODAY = Date.UTC(2026, 8, 26); // 2026-09-26T00:00:00.000Z
const NOW = new Date(TODAY + 17 * 60 * 60 * 1000 + 35 * 60 * 1000); // 2026-09-26T17:35:00.000Z
const midnight = (daysAgo) => new Date(TODAY - daysAgo * DAY_MS).toISOString();
const noSleep = async () => {};
const env = { COINGECKO_API_KEY: "test-key-not-real" };
const llamaEnv = { DEFILLAMA_WRITTEN_PERMISSION_REFERENCE: "agreement-123" };

function dailyChart(daysAgoList, base = 100) {
  const pairs = (offset) => daysAgoList.map((d, i) => [Date.parse(midnight(d)), base + offset + i]);
  return { prices: pairs(0), market_caps: pairs(1000), total_volumes: pairs(50) };
}

function coingeckoDailyFetch(daysAgoList, mode = "ok") {
  return async () => {
    if (mode === "error") return new Response("{}", { status: 500 });
    return Response.json(dailyChart(daysAgoList));
  };
}

function llamaTvlFetch(daysAgoList, base = 1_000_000_000) {
  return async () => Response.json({
    id: "parent#aave",
    name: "Aave",
    tvl: daysAgoList.map((d, i) => ({ date: Math.floor(Date.parse(midnight(d)) / 1000), totalLiquidityUSD: base + i })),
  });
}

const priceRow = (id, tokenId, chainId, value, iso) => ({
  id, token_id: tokenId, chain_id: chainId, provider_id: "coingecko", metric_id: "price_usd",
  value, status: "available", observed_at: iso, collected_at: iso, source_field: "price_usd", note: null,
});
const tvlRow = (id, tokenId, chainId, value, iso) => ({
  id, token_id: tokenId, chain_id: chainId, provider_id: "defillama", metric_id: "tvl_usd",
  value, status: "available", observed_at: iso, collected_at: iso, source_field: "tvl_usd", note: null,
});

/** A minimal indicator definition so tests don't need 20-31 days of fixture data for SMA/RSI/price-vs-TVL. */
function testDefinition(id, inputs, minPoints = 2) {
  return {
    id, name: id, category: "divergence", inputs, minPoints, windowDays: 10_000,
    parameters: {}, periodLabel: "test", summary: "test", description: "test", formula: "test",
    compute: (series) => ({ readings: [{ label: "value", value: series[0].at(-1).value }], state: null, used: series }),
  };
}

// ---- Test A: ingestion ----

test("A. a genuine new daily observation is normalized, persisted, and consumable by dailySamples()", async () => {
  const db = createFakeSupabase({ seed: {} });
  const result = await runCoinGeckoDailyHistory(db.client, {
    tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => NOW,
    fetchImpl: coingeckoDailyFetch([1]), // yesterday (25 Sept) only
  });
  assert.equal(result.advanced, true);
  assert.equal(result.notYetAvailable, undefined);
  assert.ok(result.newObservations > 0);

  const rows = db.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko" && row.metric_id === "price_usd");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observed_at, midnight(1));
  const samples = dailySamples(rows, SERIES_RULES.price, NOW.getTime());
  assert.equal(samples.length, 1);
  assert.equal(samples[0].time, Date.parse(midnight(1)));
});

// ---- Test B: idempotency ----

test("B. running the updater twice with the same provider data never duplicates a daily observation", async () => {
  const db = createFakeSupabase({ seed: {} });
  const opts = { tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => NOW, fetchImpl: coingeckoDailyFetch([1]) };
  const first = await runCoinGeckoDailyHistory(db.client, opts);
  assert.equal(first.advanced, true);
  const countAfterFirst = db.rows("token_metric_observations").length;

  const second = await runCoinGeckoDailyHistory(db.client, opts);
  assert.equal(second.advanced, false, "nothing new the second time");
  assert.equal(second.notYetAvailable, "No new completed UTC daily point was available from CoinGecko for any mapped token.");
  assert.equal(db.rows("token_metric_observations").length, countAfterFirst, "no duplicate rows");
});

// ---- Test C: the current intraday day is never treated as a completed daily close ----

test("C. a provider point dated the current UTC day is dropped, not persisted as a daily close", async () => {
  const db = createFakeSupabase({ seed: {} });
  // The provider's most recent point is dated *today* (26 Sept) — no genuine
  // completed day is available yet, even though the point itself is numeric
  // and midnight-aligned. Only day 0 (today) is offered, deliberately no
  // days-ago > 0, to isolate this from the "provider lag" case (Test D).
  const result = await runCoinGeckoDailyHistory(db.client, {
    tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => NOW,
    fetchImpl: coingeckoDailyFetch([0]),
  });
  assert.equal(result.advanced, false);
  assert.match(result.notYetAvailable, /No new completed UTC daily point/);
  assert.equal(db.rows("token_metric_observations").length, 0, "today's point is never persisted as a daily close");
});

// ---- Test D: provider availability lag, then a later run picks it up ----

test("D. when the provider has not yet published the newly completed day, no fabricated point is stored, and a later run advances", async () => {
  const db = createFakeSupabase({ seed: {} });
  const stillLagging = await runCoinGeckoDailyHistory(db.client, {
    tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => NOW,
    fetchImpl: coingeckoDailyFetch([]), // provider has nothing new at all yet
  });
  assert.equal(stillLagging.advanced, false);
  assert.match(stillLagging.notYetAvailable, /No new completed UTC daily point/);
  assert.equal(db.rows("token_metric_observations").length, 0);

  // A later attempt (still the same UTC day, or a later one) finds the provider has caught up.
  const caughtUp = await runCoinGeckoDailyHistory(db.client, {
    tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => NOW,
    fetchImpl: coingeckoDailyFetch([1]),
  });
  assert.equal(caughtUp.advanced, true);
  assert.equal(db.rows("token_metric_observations").filter((row) => row.metric_id === "price_usd").length, 1);
});

test("isDailyHistoryDue: at most once per UTC day, gated by the safe hour, paced when not-yet-available", () => {
  const midnightUtc = new Date("2026-09-27T00:20:00.000Z");
  const pastSafeHour = new Date("2026-09-27T02:10:00.000Z");
  assert.equal(isDailyHistoryDue("coingecko_daily", undefined, undefined, midnightUtc), false, "too early: before the safe hour");
  assert.equal(isDailyHistoryDue("coingecko_daily", undefined, undefined, pastSafeHour), true);
  assert.equal(isDailyHistoryDue("coingecko_daily", "2026-09-27T01:00:00.000Z", undefined, pastSafeHour), false, "already advanced today");
  assert.equal(isDailyHistoryDue("coingecko_daily", "2026-09-26T01:00:00.000Z", undefined, pastSafeHour), true, "last advance was yesterday");
  assert.equal(isDailyHistoryDue("coingecko_daily", undefined, "2026-09-27T02:00:00.000Z", pastSafeHour), false, "retried too recently");
  assert.equal(isDailyHistoryDue("coingecko_daily", undefined, "2026-09-27T01:00:00.000Z", pastSafeHour), true, "enough time since the last attempt");
});

// ---- Test E: providers fail independently ----

test("E. one daily-history provider failing never rolls back the other's persisted result (both directions)", async () => {
  const cgSucceeds = { collect: async (client) => { await client.from("token_metric_observations").insert([priceRow(undefined, "bitcoin-btc", "bitcoin", 1, midnight(1))]); return { advanced: true, newObservations: 1 }; } };
  const cgFails = { collect: async () => { throw new Error("CoinGecko daily history failed."); } };
  const llamaSucceeds = { collect: async (client) => { await client.from("token_metric_observations").insert([tvlRow(undefined, "aave-aave", "ethereum", 2, midnight(1))]); return { advanced: true, newObservations: 1 }; } };
  const llamaFails = { collect: async () => { throw new Error("DeFiLlama daily history failed."); } };

  const dbA = createFakeSupabase({ seed: {} });
  const resultA = await runDataRefresh(dbA.client, new SupabaseRefreshStore(dbA.client), {
    trigger: "scheduled", force: true, includeDailyHistory: true, only: [], calculateMetrics: async () => ({}),
    dailyHistoryCollectors: { coingecko_daily: cgFails, defillama_daily: llamaSucceeds },
  });
  const byStepA = Object.fromEntries(resultA.steps.map((step) => [step.step, step]));
  assert.equal(byStepA.coingecko_daily.status, "failed");
  assert.equal(byStepA.defillama_daily.status, "succeeded");
  assert.equal(dbA.rows("token_metric_observations").filter((row) => row.provider_id === "defillama").length, 1, "DeFiLlama's result survives CoinGecko's failure");
  assert.equal(dbA.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko").length, 0);

  const dbB = createFakeSupabase({ seed: {} });
  const resultB = await runDataRefresh(dbB.client, new SupabaseRefreshStore(dbB.client), {
    trigger: "scheduled", force: true, includeDailyHistory: true, only: [], calculateMetrics: async () => ({}),
    dailyHistoryCollectors: { coingecko_daily: cgSucceeds, defillama_daily: llamaFails },
  });
  const byStepB = Object.fromEntries(resultB.steps.map((step) => [step.step, step]));
  assert.equal(byStepB.coingecko_daily.status, "succeeded");
  assert.equal(byStepB.defillama_daily.status, "failed");
  assert.equal(dbB.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko").length, 1, "CoinGecko's result survives DeFiLlama's failure");
});

// ---- Test F: Technical Analysis advances once a genuine newer daily close is ingested ----

test("F. Technical Analysis advances to the newly completed day once the daily-history updater persists it", async () => {
  const db = createFakeSupabase({ seed: {
    // The historical daily closes (25 Sept and earlier), plus the routine
    // refresh's always-fresher live snapshot (26 Sept 17:35) — exactly like
    // production, where a live intraday observation is always newer than any
    // day's own midnight point, so notAfter never excludes a genuinely new day.
    token_metric_observations: [
      ...[1, 2, 3, 4, 5].map((d) => priceRow(100 + d, "bitcoin-btc", "bitcoin", 60_000 + d, midnight(d))),
      priceRow(199, "bitcoin-btc", "bitcoin", 61_500, NOW.toISOString()),
    ],
  } });
  const asOfBefore = NOW;
  const before = evaluateTechnicalIndicators(db.rows("token_metric_observations"), {
    asOf: asOfBefore, protocolMapped: false, definitions: [testDefinition("test_price", ["price"])],
  });
  assert.equal(before.view.groups[0].indicators[0].provenance.observationEnd, midnight(1), "starts at 25 Sept, the last stored daily close");

  // Viewed from just after 26 Sept has fully elapsed, the provider now offers
  // 26 Sept's completed daily point (this run's "today" is 27 Sept, so 26
  // Sept passes the current-day exclusion in run-coingecko-daily-history.ts).
  const dayAfter = new Date(Date.UTC(2026, 8, 27, 2, 10, 0));
  const updater = await runCoinGeckoDailyHistory(db.client, {
    tokenIds: ["bitcoin-btc"], env, sleep: noSleep, now: () => dayAfter, fetchImpl: coingeckoDailyFetch([0]),
  });
  assert.equal(updater.advanced, true);

  const after = evaluateTechnicalIndicators(db.rows("token_metric_observations"), {
    asOf: dayAfter, protocolMapped: false, definitions: [testDefinition("test_price", ["price"])],
  });
  assert.equal(after.view.groups[0].indicators[0].provenance.observationEnd, midnight(0), "advances to 26 Sept without any indicator formula changing");
});

// ---- Test G & H: Price vs TVL uses the latest *common* daily observation, never mixed dates ----

test("G-H. price-vs-TVL stays at the latest common daily observation, and never pairs a newer price with an older TVL", async () => {
  const priceThrough26 = [4, 3, 2, 1, 0].map((d) => priceRow(200 + d, "aave-aave", "ethereum", 90 + d, midnight(d)));
  const tvlThrough25Only = [4, 3, 2, 1].map((d) => tvlRow(300 + d, "aave-aave", "ethereum", 5_000 + d, midnight(d)));
  const db = createFakeSupabase({ seed: { token_metric_observations: [...priceThrough26, ...tvlThrough25Only] } });

  const definition = testDefinition("test_price_vs_tvl", ["price", "tvl"]);
  const stillAt25 = evaluateTechnicalIndicators(db.rows("token_metric_observations"), { asOf: NOW, protocolMapped: true, definitions: [definition] });
  const before = stillAt25.view.groups[0].indicators[0];
  assert.equal(before.provenance.observationEnd, midnight(1), "TVL has nothing for 26 Sept yet, so the pair stays at 25 Sept");
  const usedBefore = before.readings; // sanity: an indicator was produced at all
  assert.ok(usedBefore.length > 0);

  // DeFiLlama now (a day later) publishes 26 Sept's TVL; the daily-history
  // updater persists it using the real ingestion path (not a hand-seeded row).
  const dayAfter = new Date(Date.UTC(2026, 8, 27, 3, 10, 0));
  const llamaUpdate = await runDefiLlamaDailyHistory(db.client, {
    tokenIds: ["aave-aave"], env: llamaEnv, sleep: noSleep, now: () => dayAfter,
    fetchImpl: llamaTvlFetch([4, 3, 2, 1, 0]),
  });
  assert.equal(llamaUpdate.advanced, true);

  const nowAt26 = evaluateTechnicalIndicators(db.rows("token_metric_observations"), { asOf: dayAfter, protocolMapped: true, definitions: [definition] });
  const after = nowAt26.view.groups[0].indicators[0];
  assert.equal(after.provenance.observationEnd, midnight(0), "advances to 26 Sept once both series have it");

  // H: explicitly prove no date mixing. alignSeries() (untouched by this fix)
  // only ever returns series whose points share identical timestamps index
  // for index, so a single `observationEnd` for the pair is only reachable
  // when both sides' newest point is the same UTC day; the two checks above
  // (25 Sept while TVL lags, 26 Sept once TVL catches up) already show that
  // in practice. This checks provenance names an observation from each side,
  // both on 26 Sept, rather than a 26 Sept price silently paired with a 25
  // Sept TVL row.
  const priceIds = new Set(priceThrough26.filter((row) => row.observed_at === midnight(0)).map((row) => row.id));
  const tvlIds = new Set(db.rows("token_metric_observations").filter((row) => row.metric_id === "tvl_usd" && row.observed_at === midnight(0)).map((row) => row.id));
  assert.ok(after.provenance.sourceObservationIds.some((id) => priceIds.has(id)), "provenance includes 26 Sept's price observation");
  assert.ok(after.provenance.sourceObservationIds.some((id) => tvlIds.has(id)), "provenance includes 26 Sept's TVL observation");
  assert.equal(after.provenance.observationEnd, midnight(0), "the newest date used is 26 Sept on both sides, never 26 Sept price with 25 Sept TVL");
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
console.log(`${cases.length - failures}/${cases.length} daily-history checks passed.`);
if (failures > 0) process.exitCode = 1;
