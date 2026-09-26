import assert from "node:assert/strict";

import {
  DefiLlamaFundamentalsProvider,
  getDefiLlamaConfig,
  normalizeDefiLlamaCurrent,
  normalizeDefiLlamaHistory,
} from "../src/lib/providers/defillama.ts";
import {
  DEFILLAMA_PROTOCOL_METRIC_NOTE,
  defillamaProtocolMappings,
} from "../src/data/defillama-protocol-mappings.ts";

const asset = { tokenId: "aave-aave", chainId: "ethereum", externalAssetId: "aave", recordId: "parent#aave" };
const collectedAt = "2026-09-23T10:00:00.000Z";
const now = new Date(collectedAt);
const cases = [];
function test(name, run) {
  cases.push({ name, run });
}
const metric = (snapshot, id) => snapshot.observations.find((row) => row.metricId === id);
const provider = (fetchImpl, extra = {}) => new DefiLlamaFundamentalsProvider({
  baseUrl: "https://api.llama.fi",
  writtenPermissionReference: "agreement-123",
  sleep: async () => {},
  now: () => now,
  fetchImpl,
  ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("sync requires written permission before network or database access", () => {
  assert.throws(() => getDefiLlamaConfig({}), /written permission/);
  assert.equal(getDefiLlamaConfig({ DEFILLAMA_WRITTEN_PERMISSION_REFERENCE: "agreement-123" }).baseUrl, "https://api.llama.fi");
  assert.equal(defillamaProtocolMappings.length, 24);
  assert.equal(new Set(defillamaProtocolMappings.map((row) => row.tokenId)).size, 24);
  assert.equal(new Set(defillamaProtocolMappings.map((row) => `${row.chainId}:${row.externalAssetId}`)).size, 24);
});

test("every mapping pins its verified DeFiLlama record, and parent records are labelled as parents", () => {
  assert.equal(new Set(defillamaProtocolMappings.map((row) => row.recordId)).size, 24);
  for (const row of defillamaProtocolMappings) {
    assert.ok(row.recordId, `${row.tokenId} has a record ID`);
    assert.equal(row.recordKind === "parent", row.recordId.startsWith("parent#"), `${row.tokenId} record kind matches its record ID`);
    if (row.recordKind === "parent") {
      assert.match(row.protocolName, /\(parent record\)/);
      assert.match(row.relationship, /parent record aggregates/);
    }
  }
  const byToken = Object.fromEntries(defillamaProtocolMappings.map((row) => [row.tokenId, row]));
  assert.equal(byToken["aave-aave"].recordId, "parent#aave");
  assert.equal(byToken["uniswap-uni"].recordId, "parent#uniswap");
  assert.equal(byToken["ethereum-crv"].recordId, "3", "Curve DEX is a child record, not the Curve Finance parent");
});

test("current snapshot takes TVL and 24-hour totals only from the verified record", () => {
  const snapshot = normalizeDefiLlamaCurrent(asset, {
    tvl: 19_325_702_021.1,
    fees: { id: "parent#aave", defillamaId: "parent#aave", slug: "aave", total24h: 1_277_769, childProtocols: [{ name: "Aave V3" }, "Aave V2"] },
    revenue: { id: "parent#aave", defillamaId: "parent#aave", slug: "aave", total24h: 0 },
  }, collectedAt);

  assert.equal(metric(snapshot, "tvl_usd")?.value, 19_325_702_021.1);
  assert.equal(metric(snapshot, "tvl_usd")?.observedAt, collectedAt, "no provider timestamp: collection time is used");
  assert.match(metric(snapshot, "tvl_usd")?.note ?? "", /returns no timestamp/);
  assert.equal(metric(snapshot, "fees_24h_usd")?.value, 1_277_769);
  assert.equal(metric(snapshot, "fees_24h_usd")?.windowDays, 1);
  assert.equal(metric(snapshot, "revenue_24h_usd")?.value, 0, "a numeric zero remains available");
  assert.equal(metric(snapshot, "revenue_24h_usd")?.status, "available");
  assert.ok(snapshot.observations.every((row) => row.scope === "protocol" && row.note.includes("not a token-level metric")));
  assert.equal(snapshot.rawPayload.recordId, "parent#aave");
  assert.deepEqual(snapshot.rawPayload.dailyFees.childProtocols, ["Aave V3", "Aave V2"]);
  assert.match(snapshot.endpointLabel, /GET \/tvl\/\{protocol\}; GET \/summary\/fees\/\{protocol\}/);
});

test("a child-record summary is never substituted for a parent mapping, and TVL is withheld too", () => {
  const snapshot = normalizeDefiLlamaCurrent(asset, {
    tvl: 123,
    fees: { id: "1599", defillamaId: "1599", slug: "aave-v3", total24h: 1_219_918 },
    revenue: { id: "1599", defillamaId: "1599", slug: "aave-v3", total24h: 152_384 },
  }, collectedAt);
  for (const id of ["tvl_usd", "fees_24h_usd", "revenue_24h_usd"]) {
    assert.equal(metric(snapshot, id)?.status, "unavailable", `${id} is not taken from another record`);
    assert.equal(metric(snapshot, id)?.value, null);
    assert.match(metric(snapshot, id)?.note ?? "", /record "1599", not the verified record "parent#aave".*not substituted/);
  }
});

test("missing summaries and non-numeric values stay unavailable with distinct reasons", () => {
  const snapshot = normalizeDefiLlamaCurrent(asset, {
    tvl: null,
    fees: null,
    revenue: { defillamaId: "parent#aave", total24h: null },
  }, collectedAt);
  assert.equal(metric(snapshot, "tvl_usd")?.status, "unavailable");
  assert.match(metric(snapshot, "fees_24h_usd")?.note ?? "", /has no daily-fees summary/);
  assert.match(metric(snapshot, "revenue_24h_usd")?.note ?? "", /did not return a numeric daily-revenue/);
});

test("routine adapter makes three small serialized requests per protocol and never downloads /protocol", async () => {
  const urls = [];
  const headersSeen = [];
  let activeRequests = 0;
  let maximumConcurrent = 0;
  const delays = [];
  const client = provider(async (url, init) => {
    const parsed = new URL(url);
    urls.push(parsed);
    headersSeen.push(new Headers(init.headers));
    activeRequests += 1;
    maximumConcurrent = Math.max(maximumConcurrent, activeRequests);
    await Promise.resolve();
    activeRequests -= 1;
    if (parsed.pathname === "/tvl/aave") return json(9);
    if (parsed.pathname === "/summary/fees/aave") return json({ id: "parent#aave", total24h: parsed.searchParams.get("dataType") === "dailyFees" ? 3 : 1 });
    return json({}, 404);
  }, { sleep: async (ms) => delays.push(ms) });
  const [snapshot] = await client.fetchSnapshots([asset]);

  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(urls.map((url) => url.pathname), ["/tvl/aave", "/summary/fees/aave", "/summary/fees/aave"]);
  assert.deepEqual(urls.slice(1).map((url) => url.searchParams.get("dataType")), ["dailyFees", "dailyRevenue"]);
  assert.ok(urls.slice(1).every((url) => url.searchParams.get("excludeTotalDataChart") === "true"));
  assert.deepEqual(delays, [1_100, 1_100], "requests are paced");
  assert.equal(urls.every((url) => url.origin === "https://api.llama.fi"), true);
  assert.equal(headersSeen.every((headers) => !headers.has("authorization") && !headers.has("x-api-key")), true);
  assert.equal(metric(snapshot, "tvl_usd")?.value, 9);
  assert.equal(metric(snapshot, "fees_24h_usd")?.value, 3);
  assert.equal(metric(snapshot, "revenue_24h_usd")?.value, 1);
  assert.equal(client.telemetry.length, 3);
  assert.ok(client.telemetry.every((entry) => entry.attempts === 1));
});

test("a 404 summary (no fee adapter) marks that metric unavailable without failing the run", async () => {
  const client = provider(async (url) => (new URL(url).pathname.startsWith("/tvl/") ? json(5) : json({ message: "not found" }, 404)));
  const [snapshot] = await client.fetchSnapshots([asset]);
  assert.equal(metric(snapshot, "tvl_usd")?.value, 5);
  assert.equal(metric(snapshot, "fees_24h_usd")?.status, "unavailable");
  assert.match(metric(snapshot, "fees_24h_usd")?.note ?? "", /has no daily-fees summary/);
});

test("429 handling honors Retry-After, bounds retries, and records attempts", async () => {
  let requests = 0;
  const delays = [];
  const client = provider(async () => {
    requests += 1;
    return new Response("", { status: 429, headers: { "retry-after": "0" } });
  }, { sleep: async (delay) => delays.push(delay) });

  await assert.rejects(client.fetchSnapshots([asset]), /HTTP 429/);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [0, 0]);
});

test("a body that cannot be read in time fails clearly and is not retried", async () => {
  let requests = 0;
  const client = provider(async (_url, init) => {
    requests += 1;
    // Simulate the request timeout firing mid-download: the body is cut off.
    Object.defineProperty(init.signal, "aborted", { value: true });
    return new Response("{\"truncated\":", { status: 200 });
  });
  await assert.rejects(client.fetchSnapshots([asset]), /was not received within 20 s/);
  assert.equal(requests, 1);

  const malformed = provider(async () => new Response("{\"truncated\":", { status: 200 }));
  await assert.rejects(malformed.fetchSnapshots([asset]), /malformed JSON/);
});

test("history mode keeps dated 90-day TVL for the verified record only, and never writes unavailable rows", async () => {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const tvl = [
    { date: nowSeconds - 91 * 86400, totalLiquidityUSD: 80 },
    { date: nowSeconds - 86400, totalLiquidityUSD: 100 },
    { date: nowSeconds, totalLiquidityUSD: 0 },
  ];
  const { snapshot } = normalizeDefiLlamaHistory(asset, { id: "parent#aave", name: "Aave", tvl }, collectedAt, now);
  assert.equal(snapshot.observations.length, 2, "history is limited to 90 days");
  assert.ok(snapshot.observations.every((row) => row.metricId === "tvl_usd" && row.scope === "protocol"), "fees/revenue come from the routine path only");
  assert.equal(snapshot.observations[1].value, 0, "a numeric zero remains available");
  assert.equal(snapshot.observations[0].observedAt, new Date((nowSeconds - 86400) * 1000).toISOString(), "provider point dates are kept");
  assert.equal(snapshot.rawPayload.protocol.tvl.length, 2);
  assert.match(snapshot.rawPayload.retentionNote, /90-day normalization window/);

  const child = normalizeDefiLlamaHistory(asset, { id: "1599", tvl }, collectedAt, now);
  assert.equal(child.snapshot, null);
  assert.match(child.skipReason, /not the verified record "parent#aave"/);
  assert.equal(normalizeDefiLlamaHistory(asset, { id: "parent#aave", tvl: [] }, collectedAt, now).snapshot, null);

  const urls = [];
  const client = provider(async (url) => {
    urls.push(new URL(url).pathname);
    return json({ id: "parent#aave", tvl });
  });
  const result = await client.fetchHistorySnapshots([asset, { ...asset, tokenId: "uniswap-uni", externalAssetId: "uniswap", recordId: "parent#uniswap" }]);
  assert.deepEqual(urls, ["/protocol/aave", "/protocol/uniswap"]);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.skipped.map((item) => item.tokenId), ["uniswap-uni"]);
});

test("protocol note never presents protocol data as token data", () => {
  assert.equal(DEFILLAMA_PROTOCOL_METRIC_NOTE.includes("not a token-level metric"), true);
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

console.log(`${cases.length - failures}/${cases.length} DeFiLlama checks passed.`);
if (failures > 0) process.exitCode = 1;
