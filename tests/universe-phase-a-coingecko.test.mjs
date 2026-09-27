import assert from "node:assert/strict";

import { coinGeckoNotFound, coinGeckoUnavailable, validateCoinGeckoCandidate } from "../src/lib/universe/coingecko-validation.ts";
import { discoverCandidates, resolvePlatformIdentity } from "../src/lib/universe/coingecko-discovery.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const CHECKED_AT = "2026-09-29T00:00:00.000Z";

test("a valid CoinGecko market row passes with market and supply data recorded", () => {
  const result = validateCoinGeckoCandidate(
    { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 60000, market_cap: 1_000_000_000, circulating_supply: 19_000_000, market_cap_rank: 1 },
    CHECKED_AT,
  );
  assert.equal(result.coingeckoStatus, "pass");
  assert.equal(result.coingeckoHasMarketData, true);
  assert.equal(result.coingeckoHasSupplyData, true);
  assert.equal(result.marketCapRank, 1);
  assert.equal(result.coingeckoFailureReason, null);
});

test("missing market data (no price, no market cap) fails with incomplete-metadata, not not-found", () => {
  const result = validateCoinGeckoCandidate({ id: "ghost-coin", symbol: "ghost", name: "Ghost Coin", current_price: null, market_cap: null }, CHECKED_AT);
  assert.equal(result.coingeckoStatus, "fail");
  assert.equal(result.coingeckoFailureReason, "COINGECKO_METADATA_INCOMPLETE");
  assert.equal(result.coingeckoHasMarketData, false);
});

test("incomplete metadata (missing name) fails deterministically", () => {
  const result = validateCoinGeckoCandidate({ id: "broken", symbol: "brk", name: "" }, CHECKED_AT);
  assert.equal(result.coingeckoStatus, "fail");
  assert.equal(result.coingeckoFailureReason, "COINGECKO_METADATA_INCOMPLETE");
});

test("an explicitly missing/invalid ID is reported as not found", () => {
  const result = coinGeckoNotFound(CHECKED_AT);
  assert.equal(result.coingeckoStatus, "fail");
  assert.equal(result.coingeckoFailureReason, "COINGECKO_NOT_FOUND");
});

test("a temporary API failure is reported as temporarily_unavailable, never a hard failure", () => {
  const result = coinGeckoUnavailable(CHECKED_AT, "network error");
  assert.equal(result.coingeckoStatus, "temporarily_unavailable");
  assert.ok(result.coingeckoFailureReason.startsWith("COINGECKO_UNAVAILABLE"));
  assert.equal(result.coingeckoHasMarketData, null);
});

test("supply data absent (zero circulating supply) is not counted as supply data present", () => {
  const result = validateCoinGeckoCandidate({ id: "no-supply", symbol: "ns", name: "No Supply", current_price: 1, market_cap: 100, circulating_supply: 0 }, CHECKED_AT);
  assert.equal(result.coingeckoHasSupplyData, false);
});

test("a platform map with exactly one contract is a confident chain/contract identity", () => {
  const identity = resolvePlatformIdentity({ id: "x", symbol: "x", name: "X", platforms: { ethereum: "0xABC123" } });
  assert.equal(identity.chainId, "ethereum");
  assert.equal(identity.contractAddress, "0xabc123");
  assert.equal(identity.isNative, false);
});

test("a multi-chain platform map is left chain-unresolved rather than guessing one deployment", () => {
  const identity = resolvePlatformIdentity({ id: "usdt", symbol: "usdt", name: "Tether", platforms: { ethereum: "0xdac17f", tron: "TR7NHq" } });
  assert.equal(identity.chainId, null);
  assert.equal(identity.contractAddress, null);
  assert.deepEqual(Object.keys(identity.platforms).sort(), ["ethereum", "tron"]);
});

test("an empty platform map is treated as a native-candidate with no fabricated chain", () => {
  const identity = resolvePlatformIdentity({ id: "bitcoin", symbol: "btc", name: "Bitcoin", platforms: {} });
  assert.equal(identity.chainId, null);
  assert.equal(identity.isNative, true);
});

test("discovery paginates /coins/markets up to the pool size and enriches identity from /coins/list", async () => {
  let marketsCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v3/coins/markets") {
      marketsCalls += 1;
      const page = Number(parsed.searchParams.get("page"));
      const items = page === 1
        ? Array.from({ length: 250 }, (_, i) => ({ id: `coin-${i}`, symbol: `c${i}`, name: `Coin ${i}`, current_price: 1, market_cap: 1000, market_cap_rank: i + 1 }))
        : [{ id: "coin-250", symbol: "c250", name: "Coin 250", current_price: 1, market_cap: 1000, market_cap_rank: 251 }];
      return new Response(JSON.stringify(items), { status: 200 });
    }
    if (parsed.pathname === "/api/v3/coins/list") {
      return new Response(JSON.stringify([{ id: "coin-0", symbol: "c0", name: "Coin 0", platforms: { ethereum: "0xdead" } }]), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await discoverCandidates({
    poolSize: 251,
    config: { apiKey: "k", baseUrl: "https://api.coingecko.com/api/v3", keyHeader: "x-cg-demo-api-key" },
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(marketsCalls, 2);
  assert.equal(result.candidates.length, 251);
  assert.equal(result.candidates[0].chainId, "ethereum");
  assert.equal(result.candidates[0].contractAddress, "0xdead");
  assert.equal(result.outage, null);
  assert.equal(result.listOutage, null);
  assert.deepEqual([...result.listedCoingeckoIds], ["coin-0"], "listedCoingeckoIds reflects /coins/list, not the ranked markets pool");
});

test("a /coins/list outage is recorded separately from a discovery outage, so absence detection can be skipped for this run", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v3/coins/markets") {
      return new Response(JSON.stringify([{ id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 1, market_cap: 1000 }]), { status: 200 });
    }
    if (parsed.pathname === "/api/v3/coins/list") return new Response("", { status: 500 });
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await discoverCandidates({
    poolSize: 10,
    config: { apiKey: "k", baseUrl: "https://api.coingecko.com/api/v3", keyHeader: "x-cg-demo-api-key" },
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.outage, null, "candidate discovery itself still succeeded");
  assert.equal(result.candidates.length, 1);
  assert.ok(result.listOutage, "the catalog-list outage is reported so absence evidence is never inferred from it");
  assert.equal(result.listedCoingeckoIds.size, 0);
});

test("a discovery-wide outage is reported, not thrown, and the pool is left empty", async () => {
  const fetchImpl = async () => new Response("", { status: 500 });
  const result = await discoverCandidates({
    poolSize: 10,
    config: { apiKey: "k", baseUrl: "https://api.coingecko.com/api/v3", keyHeader: "x-cg-demo-api-key" },
    fetchImpl,
    sleep: async () => {},
  });
  assert.ok(result.outage);
  assert.equal(result.candidates.length, 0);
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
console.log(`${cases.length - failures}/${cases.length} Phase A CoinGecko checks passed.`);
if (failures > 0) process.exitCode = 1;
