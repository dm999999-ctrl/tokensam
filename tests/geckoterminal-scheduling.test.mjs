import assert from "node:assert/strict";

import { configuredGeckoTerminalAssets, fetchGeckoTerminalSnapshotsTolerant } from "../src/lib/providers/geckoterminal.ts";
import { runGeckoTerminalCollection, runGeckoTerminalScheduledCollection } from "../src/lib/providers/run-geckoterminal-collection.ts";
import {
  acquireGeckoTerminalSyncLock,
  finishGeckoTerminalSyncLock,
  lastSuccessfulGeckoTerminalSync,
  resolveGeckoTerminalStartTokenId,
  withGeckoTerminalSyncLock,
} from "../src/lib/providers/geckoterminal-sync-lock.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

const assets = configuredGeckoTerminalAssets();
const aave = assets.find((asset) => asset.tokenId === "aave-aave");
const jupiter = assets.find((asset) => asset.tokenId === "jupiter-jup");
const uni = assets.find((asset) => asset.tokenId === "uniswap-uni");
const noSleep = async () => {};

function pool(overrides = {}) {
  return {
    attributes: {
      address: "0xpool", name: "TOKEN / USDC", pool_created_at: "2023-01-01T00:00:00Z",
      token_price_usd: "1.5", reserve_in_usd: "10000", volume_usd: { h24: "5000" },
      price_change_percentage: { h24: "2" }, fdv_usd: "1000000", market_cap_usd: "900000",
      transactions: { h24: { buys: 10, sells: 5 } },
      ...overrides.attributes,
    },
    relationships: {
      base_token: { data: { id: `${overrides.network ?? "eth"}_${(overrides.baseAddress ?? "0xpool").toLowerCase()}` } },
      quote_token: { data: { id: `${overrides.network ?? "eth"}_0xquote` } },
      dex: { data: { id: "fixture-dex" } },
    },
  };
}

function fixedResponse(body, status = 200) {
  return async () => new Response(JSON.stringify(body), { status });
}

const REQUIRED_METRICS = ["price_usd", "volume_24h_usd", "liquidity_usd", "price_change_24h_pct", "transactions_24h_count", "buys_24h_count", "sells_24h_count", "fdv_usd", "market_cap_usd"];

function baseSeed(extra = {}) {
  return {
    data_providers: [{ id: "geckoterminal" }],
    metric_definitions: REQUIRED_METRICS.map((id) => ({ id })),
    provider_pairs: [],
    provider_token_mappings: [],
    ...extra,
  };
}

// ---- fetchGeckoTerminalSnapshotsTolerant: partial failure, retries, rate limits, deadline ----

test("all tokens succeed: every requested asset returns a snapshot", async () => {
  const requests = [];
  const fetchImpl = async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ data: [pool({ baseAddress: aave.tokenAddress })] }), { status: 200 }); };
  const { snapshots, outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter], { fetchImpl, sleep: noSleep });
  assert.equal(snapshots.length, 2);
  assert.deepEqual(outcomes.map((o) => o.status), ["succeeded", "succeeded"]);
  assert.equal(requests.length, 2);
});

test("a partial failure still returns snapshots for every token that succeeded", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 3) return new Response("", { status: 500 }); // aave's 3 attempts all fail
    return new Response(JSON.stringify({ data: [pool({ baseAddress: jupiter.tokenAddress })] }), { status: 200 }); // jupiter succeeds
  };
  const { snapshots, outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter], { fetchImpl, sleep: noSleep });
  assert.equal(snapshots.length, 1, "the successful token's snapshot must not be discarded by the other token's failure");
  assert.equal(snapshots[0].asset.tokenId, "jupiter-jup");
  const byToken = Object.fromEntries(outcomes.map((o) => [o.tokenId, o]));
  assert.equal(byToken["aave-aave"].status, "failed");
  assert.match(byToken["aave-aave"].error, /HTTP 500/);
  assert.equal(byToken["jupiter-jup"].status, "succeeded");
});

test("retries: a transient failure that succeeds on a later attempt is reflected in the attempt count", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const { outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave], { fetchImpl, sleep: noSleep });
  assert.equal(outcomes[0].status, "succeeded");
  assert.equal(outcomes[0].attempts, 2);
});

test("a 429 with an unreliable Retry-After: 0 still waits the 20s cooldown floor, and the token still eventually fails after exhausting retries", async () => {
  const delays = [];
  const fetchImpl = async () => new Response("", { status: 429, headers: { "retry-after": "0" } });
  const { outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave], { fetchImpl, sleep: async (ms) => delays.push(ms) });
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].error, /HTTP 429/);
  assert.equal(outcomes[0].rateLimited, true);
  // Two backoff waits between three attempts, both floored at 20s despite Retry-After: 0.
  assert.deepEqual(delays, [20_000, 20_000]);
});

test("a token that hits a 429 but recovers on retry is still marked rate-limited even though it ultimately succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const { outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave], { fetchImpl, sleep: noSleep });
  assert.equal(outcomes[0].status, "succeeded");
  assert.equal(outcomes[0].rateLimited, true);
  assert.equal(outcomes[0].attempts, 2);
});

test("a deadline already in the past skips every token without making any request", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  const past = new Date("2020-01-01T00:00:00Z");
  const { snapshots, outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter], {
    fetchImpl, sleep: noSleep, now: () => past, deadlineAt: past.getTime() - 1,
  });
  assert.equal(requests, 0);
  assert.equal(snapshots.length, 0);
  assert.deepEqual(outcomes.map((o) => o.status), ["skipped_time_budget", "skipped_time_budget"]);
});

test("a deadline that passes mid-run completes tokens already in flight and skips the rest, without discarding earlier successes", async () => {
  const times = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z"), new Date("2026-01-01T00:00:02.000Z")];
  let call = 0;
  const now = () => times[Math.min(call, times.length - 1)];
  const fetchImpl = async () => { call += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  // Deadline sits between the first and second token's clock reading.
  const deadlineAt = times[0].getTime() + 500;
  const { snapshots, outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], { fetchImpl, sleep: noSleep, now, deadlineAt });
  assert.equal(snapshots.length, 1, "the token processed before the deadline keeps its snapshot");
  assert.equal(outcomes[0].status, "succeeded");
  assert.equal(outcomes[1].status, "skipped_time_budget");
  assert.equal(outcomes[2].status, "skipped_time_budget");
});

test("minRequestIntervalMs may only raise pacing above the built-in floor, never lower it", async () => {
  const delays = [];
  const fetchImpl = fixedResponse({ data: [] });
  await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter], { fetchImpl, sleep: async (ms) => delays.push(ms), minRequestIntervalMs: 1 });
  assert.deepEqual(delays, [6_500], "an interval below the floor is ignored; the floor still applies");
  delays.length = 0;
  await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter], { fetchImpl, sleep: async (ms) => delays.push(ms), minRequestIntervalMs: 20_000 });
  assert.deepEqual(delays, [20_000], "a higher configured interval is honored");
});

// ---- Locking: overlapping invocations, lease expiry, due-check ----

test("a second acquire is refused while the first run is still 'running'", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [] } });
  const now = new Date("2026-09-30T00:00:00Z");
  const first = await acquireGeckoTerminalSyncLock(db.client, "scheduled", now, 60_000);
  assert.equal(typeof first, "number");
  const second = await acquireGeckoTerminalSyncLock(db.client, "manual", now, 60_000);
  assert.equal(second, null, "an overlapping invocation (scheduled or manual) must be refused, not double-run");
});

test("a lock is released once finished, and a new run can then be acquired", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [] } });
  const now = new Date("2026-09-30T00:00:00Z");
  const first = await acquireGeckoTerminalSyncLock(db.client, "scheduled", now, 60_000);
  await finishGeckoTerminalSyncLock(db.client, first, "succeeded", now, { observations: 10 }, null);
  const second = await acquireGeckoTerminalSyncLock(db.client, "scheduled", new Date(now.getTime() + 1000), 60_000);
  assert.equal(typeof second, "number");
  assert.notEqual(second, first);
});

test("an abandoned run (lease expired) is released automatically and does not block a new acquire", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [] } });
  const started = new Date("2026-09-30T00:00:00Z");
  const stale = await acquireGeckoTerminalSyncLock(db.client, "scheduled", started, 1_000); // lease expires 1s later
  assert.equal(typeof stale, "number");
  const muchLater = new Date(started.getTime() + 60_000);
  const revived = await acquireGeckoTerminalSyncLock(db.client, "scheduled", muchLater, 60_000);
  assert.equal(typeof revived, "number", "a crashed run's expired lease must not block future runs indefinitely");
  const staleRow = db.rows("geckoterminal_sync_runs").find((row) => row.id === stale);
  assert.equal(staleRow.status, "failed");
  assert.match(staleRow.error, /lease expired/);
});

test("withGeckoTerminalSyncLock refuses to start work while another run holds the lock, and releases on success", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [] } });
  let started = 0;
  await withGeckoTerminalSyncLock(db.client, "manual", 60_000, async () => { started += 1; });
  assert.equal(started, 1);
  assert.equal(db.rows("geckoterminal_sync_runs")[0].status, "succeeded");

  // Simulate a still-running lock, then confirm the wrapper refuses to start work.
  db.rows("geckoterminal_sync_runs").push({ id: 99, trigger: "scheduled", status: "running", started_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
  let ranWhileBusy = false;
  await assert.rejects(
    withGeckoTerminalSyncLock(db.client, "manual", 60_000, async () => { ranWhileBusy = true; }),
    /already running/,
  );
  assert.equal(ranWhileBusy, false, "work must never start while another run holds the lock");
});

test("lastSuccessfulGeckoTerminalSync ignores failed/running rows and returns the newest succeeded-or-partial finish time", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [
    { id: 1, trigger: "scheduled", status: "failed", started_at: "2026-09-28T00:00:00Z", finished_at: "2026-09-28T00:05:00Z", lease_expires_at: "2026-09-28T00:10:00Z" },
    { id: 2, trigger: "scheduled", status: "partial", started_at: "2026-09-29T00:00:00Z", finished_at: "2026-09-29T00:05:00Z", lease_expires_at: "2026-09-29T00:10:00Z" },
  ] } });
  assert.equal(await lastSuccessfulGeckoTerminalSync(db.client), "2026-09-29T00:05:00Z");
});

// ---- Historical accumulation: distinct observed_at per run, nothing overwritten ----

test("two separate scheduled runs each create their own new observation timestamp; the first snapshot is never overwritten", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const fetchImpl = fixedResponse({ data: [pool({ baseAddress: aave.tokenAddress, attributes: { reserve_in_usd: "1000" } })] });

  const day1 = new Date("2026-09-28T00:05:00.000Z");
  const result1 = await runGeckoTerminalScheduledCollection(db.client, { tokenIds: ["aave-aave"], fetchImpl, sleep: noSleep, now: () => day1 });
  assert.equal(result1.observations > 0, true);

  const day2 = new Date("2026-09-29T00:05:00.000Z");
  const result2 = await runGeckoTerminalScheduledCollection(db.client, { tokenIds: ["aave-aave"], fetchImpl, sleep: noSleep, now: () => day2 });
  assert.equal(result2.observations > 0, true);

  const liquidityRows = db.rows("token_metric_observations").filter((row) => row.provider_id === "geckoterminal" && row.metric_id === "liquidity_usd" && row.token_id === "aave-aave");
  assert.equal(liquidityRows.length, 2, "two runs on different days must produce two distinct historical rows, not one overwritten row");
  const observedTimes = new Set(liquidityRows.map((row) => row.observed_at));
  assert.equal(observedTimes.size, 2);
  assert.ok(observedTimes.has(day1.toISOString()));
  assert.ok(observedTimes.has(day2.toISOString()));
  // The first day's raw snapshot is still present, untouched, alongside the second.
  const rawRows = db.rows("raw_provider_records").filter((row) => row.provider_id === "geckoterminal");
  assert.equal(rawRows.length, 2);
});

test("a scheduled run persists successful tokens even when another token in the same run fails", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const fetchImpl = async (url) => {
    if (String(url).includes(encodeURIComponent(aave.tokenAddress))) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ data: [pool({ baseAddress: jupiter.tokenAddress })] }), { status: 200 });
  };
  const result = await runGeckoTerminalScheduledCollection(db.client, { tokenIds: ["aave-aave", "jupiter-jup"], fetchImpl, sleep: noSleep });
  assert.equal(result.attempted, 2);
  assert.deepEqual(result.succeeded, ["jupiter-jup"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].tokenId, "aave-aave");
  assert.ok(result.observations > 0, "jupiter's observations must still be written despite aave's failure");
  const jupiterRows = db.rows("token_metric_observations").filter((row) => row.token_id === "jupiter-jup");
  assert.ok(jupiterRows.length > 0);
  const aaveRows = db.rows("token_metric_observations").filter((row) => row.token_id === "aave-aave");
  assert.equal(aaveRows.length, 0, "a failed token writes nothing, but does not block the rest of the run");
});

test("runGeckoTerminalCollection (manual) refuses to run while a scheduled run holds the lock", async () => {
  const db = createFakeSupabase({ seed: baseSeed({
    geckoterminal_sync_runs: [{ id: 1, trigger: "scheduled", status: "running", started_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString() }],
  }) });
  await assert.rejects(
    runGeckoTerminalCollection(db.client, { tokenIds: ["aave-aave"], fetchImpl: fixedResponse({ data: [] }), sleep: noSleep }),
    /already running/,
  );
});

// ---- Rotation: fair, resumable scheduling across successive runs ----

test("startTokenId rotates the processing order and wraps around at the end of the list", async () => {
  const requests = [];
  const fetchImpl = async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  const { outcomes, nextTokenId } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], {
    fetchImpl, sleep: noSleep, startTokenId: jupiter.tokenId,
  });
  assert.deepEqual(outcomes.map((o) => o.tokenId), [jupiter.tokenId, uni.tokenId, aave.tokenId], "processing starts at jupiter and wraps back through the list");
  assert.equal(requests[0].includes(encodeURIComponent(jupiter.tokenAddress)), true);
  assert.equal(nextTokenId, jupiter.tokenId, "a full, uninterrupted pass wraps the cursor back to where it started");
});

test("an unknown or omitted startTokenId starts at index 0, same as before rotation existed", async () => {
  const { outcomes } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], { fetchImpl: fixedResponse({ data: [] }), sleep: noSleep, startTokenId: "not-a-real-token" });
  assert.deepEqual(outcomes.map((o) => o.tokenId), [aave.tokenId, jupiter.tokenId, uni.tokenId]);
});

test("a time-budget-limited run reports nextTokenId as the first token it had to skip", async () => {
  const times = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z"), new Date("2026-01-01T00:00:02.000Z")];
  let call = 0;
  const now = () => times[Math.min(call, times.length - 1)];
  const fetchImpl = async () => { call += 1; return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  const deadlineAt = times[0].getTime() + 500; // only the first (rotated) token fits inside the budget
  const { outcomes, nextTokenId } = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], {
    fetchImpl, sleep: noSleep, now, deadlineAt, startTokenId: jupiter.tokenId,
  });
  assert.deepEqual(outcomes.map((o) => o.status), ["succeeded", "skipped_time_budget", "skipped_time_budget"]);
  assert.equal(nextTokenId, uni.tokenId, "the next run must resume at the first token this run could not reach, not restart at jupiter");
  // Existing time-budget behavior is otherwise unchanged: skipped tokens make no request and keep no snapshot.
  assert.equal(outcomes[1].attempts, 0);
});

test("a token that fails every time is retried on every cycle, never permanently skipped by the rotation", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes(encodeURIComponent(aave.tokenAddress))) return new Response("", { status: 500 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const run1 = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], { fetchImpl, sleep: noSleep });
  assert.equal(run1.outcomes.find((o) => o.tokenId === aave.tokenId).status, "failed");
  assert.equal(run1.nextTokenId, aave.tokenId, "a completed pass wraps back to the start even though aave failed in it");

  const run2 = await fetchGeckoTerminalSnapshotsTolerant([aave, jupiter, uni], { fetchImpl, sleep: noSleep, startTokenId: run1.nextTokenId });
  assert.equal(run2.outcomes[0].tokenId, aave.tokenId, "the previously failed token is presented again, not permanently excluded");
  assert.equal(run2.outcomes[0].status, "failed", "it keeps failing (the fixture never changes), which is expected — the point is that it is retried at all");
});

test("resolveGeckoTerminalStartTokenId returns null when no run has ever recorded a cursor", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [] } });
  assert.equal(await resolveGeckoTerminalStartTokenId(db.client), null);
});

test("resolveGeckoTerminalStartTokenId skips rows with no recorded cursor (running/manual/pre-rotation runs) to find the last real one", async () => {
  const db = createFakeSupabase({ seed: { geckoterminal_sync_runs: [
    { id: 1, trigger: "scheduled", status: "succeeded", started_at: "2026-09-28T00:00:00Z", finished_at: "2026-09-28T00:05:00Z", lease_expires_at: "2026-09-28T00:10:00Z", summary: { nextTokenId: "token-a" } },
    { id: 2, trigger: "manual", status: "succeeded", started_at: "2026-09-29T00:00:00Z", finished_at: "2026-09-29T00:05:00Z", lease_expires_at: "2026-09-29T00:10:00Z", summary: {} },
    { id: 3, trigger: "scheduled", status: "running", started_at: "2026-09-30T00:00:00Z", lease_expires_at: "2026-09-30T00:10:00Z" },
  ] } });
  assert.equal(await resolveGeckoTerminalStartTokenId(db.client), "token-a", "the manual run and the still-running row carry no cursor, so the search must look past them");
});

test("rotation does not weaken the sync lock: an overlapping scheduled run is still refused", async () => {
  const db = createFakeSupabase({ seed: baseSeed({
    geckoterminal_sync_runs: [{ id: 1, trigger: "scheduled", status: "running", started_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 60_000).toISOString() }],
  }) });
  const runId = await acquireGeckoTerminalSyncLock(db.client, "scheduled", new Date(), 60_000);
  assert.equal(runId, null, "an overlapping run must still be refused regardless of cursor state");
});

test("integration: successive scheduled runs resume after the previous stop, reach every token, and wrap around", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const tokenIds = [aave.tokenId, jupiter.tokenId, uni.tokenId];
  const fetchImpl = fixedResponse({ data: [] });

  async function runOnce(baseMs) {
    let calls = 0;
    const now = () => new Date(baseMs + (calls++) * 1_000);
    const runId = await acquireGeckoTerminalSyncLock(db.client, "scheduled", new Date(baseMs), 15 * 60 * 1000);
    assert.equal(typeof runId, "number", "the lock must be free between successive scheduled runs");
    const result = await runGeckoTerminalScheduledCollection(db.client, {
      tokenIds, fetchImpl, sleep: noSleep, now,
      deadlineAt: baseMs + 1_500, // wide enough for exactly one token's request+snapshot timestamp, not a second
    });
    const status = result.failed.length === 0 && result.skipped.length === 0 ? "succeeded" : result.succeeded.length > 0 ? "partial" : "failed";
    await finishGeckoTerminalSyncLock(db.client, runId, status, new Date(baseMs + 3_000), result, null);
    return result;
  }

  const day1 = Date.parse("2026-10-01T00:00:00.000Z");
  const run1 = await runOnce(day1);
  assert.equal(run1.startTokenId, null, "run 1 has no prior history, so it starts at the first token");
  assert.equal(run1.succeeded.length, 1, "run 1's time budget only fits one token");
  assert.equal(run1.skipped.length, 2);

  const day2 = Date.parse("2026-10-02T00:00:00.000Z");
  const run2 = await runOnce(day2);
  assert.equal(run2.startTokenId, run1.nextTokenId, "run 2 must resume exactly where run 1 stopped");
  assert.notEqual(run2.succeeded[0], run1.succeeded[0], "run 2 must not just repeat run 1's token while the others stay stale");

  const day3 = Date.parse("2026-10-03T00:00:00.000Z");
  const run3 = await runOnce(day3);
  assert.equal(run3.startTokenId, run2.nextTokenId);

  // Across three runs, every mapped token was reached exactly once — none starved.
  const processed = [run1.succeeded[0], run2.succeeded[0], run3.succeeded[0]];
  assert.equal(new Set(processed).size, 3, "all three tokens must have been processed, not just the first one repeatedly");
  assert.deepEqual([...processed].sort(), [...tokenIds].sort());

  const day4 = Date.parse("2026-10-04T00:00:00.000Z");
  const run4 = await runOnce(day4);
  assert.equal(run4.startTokenId, run3.nextTokenId);
  assert.equal(run4.succeeded[0], run1.succeeded[0], "the rotation wraps back to the first token once the whole universe has been covered");

  // Every token now has at least one stored historical observation from this rotation.
  for (const tokenId of tokenIds) {
    const rows = db.rows("token_metric_observations").filter((row) => row.token_id === tokenId && row.provider_id === "geckoterminal");
    assert.ok(rows.length > 0, `${tokenId} must have received an observation somewhere across the rotation`);
  }
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
console.log(`${cases.length - failures}/${cases.length} GeckoTerminal scheduling checks passed.`);
if (failures > 0) process.exitCode = 1;
