import assert from "node:assert/strict";

import {
  configuredGeckoTerminalAssets,
  GeckoTerminalMarketDataProvider,
  getUnmappedGeckoTerminalTokens,
  normalizeGeckoTerminalToken,
  parseNetworkDexes,
  parseTokenPools,
} from "../src/lib/providers/geckoterminal.ts";
import { geckoTerminalTokenMappings } from "../src/data/geckoterminal-token-mappings.ts";
import { dexScreenerTokenMappings } from "../src/data/dexscreener-token-mappings.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";

const collectedAt = "2026-09-29T12:00:00.000Z";
const assets = configuredGeckoTerminalAssets();
const aave = assets.find((asset) => asset.tokenId === "aave-aave");
const jupiter = assets.find((asset) => asset.tokenId === "jupiter-jup");

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test("identity: reuses the verified DEX Screener chain+address mapping, translated to GeckoTerminal network slugs", () => {
  assert.equal(canonicalTokens.length, geckoTerminalTokenMappings.length);
  assert.equal(new Set(geckoTerminalTokenMappings.map((mapping) => mapping.tokenId)).size, canonicalTokens.length);

  // A token unmapped for DEX Screener (native, no contract address) is unmapped for GeckoTerminal too.
  for (const dexMapping of dexScreenerTokenMappings.filter((mapping) => !mapping.tokenAddress)) {
    const gt = geckoTerminalTokenMappings.find((mapping) => mapping.tokenId === dexMapping.tokenId);
    assert.equal(gt.gtNetwork, null, `${dexMapping.tokenId} has no contract address, so no GeckoTerminal mapping`);
    assert.equal(gt.tokenAddress, null);
    assert.ok(gt.unmappedReason, `${dexMapping.tokenId} records why it is unmapped`);
  }

  // Ethereum contract tokens reuse the exact same address, translated to GeckoTerminal's "eth" network slug.
  assert.equal(aave.gtNetwork, "eth");
  assert.equal(aave.tokenAddress.toLowerCase(), dexScreenerTokenMappings.find((mapping) => mapping.tokenId === "aave-aave").tokenAddress.toLowerCase());
  assert.equal(jupiter.gtNetwork, "solana");
  assert.equal(jupiter.tokenAddress, dexScreenerTokenMappings.find((mapping) => mapping.tokenId === "jupiter-jup").tokenAddress);

  // A DEX Screener-mapped token on a chain without a verified GeckoTerminal network slug stays unmapped, not guessed.
  const suiDex = dexScreenerTokenMappings.find((mapping) => mapping.tokenId === "sui-sui");
  if (suiDex?.tokenAddress) {
    const suiGt = geckoTerminalTokenMappings.find((mapping) => mapping.tokenId === "sui-sui");
    assert.equal(suiGt.gtNetwork, null, "sui-sui has a DEX Screener address but no verified GeckoTerminal network slug");
    assert.match(suiGt.unmappedReason, /not been verified/);
  }

  assert.ok(assets.every((asset) => asset.tokenAddress && asset.externalAssetId === `${asset.gtNetwork}:${asset.tokenAddress}`));
  assert.equal(assets.some((asset) => asset.tokenId === "bitcoin-btc"), false);
  assert.equal(getUnmappedGeckoTerminalTokens().length, geckoTerminalTokenMappings.length - assets.length);
});

test("parseTokenPools: reads pool address, dex identity (joined via included), liquidity, volume, creation time", () => {
  const payload = {
    data: [
      {
        id: "eth_0xpool-a",
        type: "pool",
        attributes: { address: "0xpool-a", reserve_in_usd: "50000.5", volume_usd: { h24: "12345.6" }, pool_created_at: "2024-01-01T00:00:00Z" },
        relationships: {
          dex: { data: { id: "uniswap_v3", type: "dex" } },
          base_token: { data: { id: "eth_0xaave", type: "token" } },
          quote_token: { data: { id: "eth_0xusdc", type: "token" } },
        },
      },
      { id: "eth_0xpool-b", type: "pool", attributes: { address: null } },
    ],
    included: [{ id: "uniswap_v3", type: "dex", attributes: { name: "Uniswap V3" } }],
  };
  const pools = parseTokenPools(payload);
  assert.equal(pools.length, 1, "a pool with no address is dropped");
  assert.equal(pools[0].poolAddress, "0xpool-a");
  assert.equal(pools[0].dexId, "uniswap_v3");
  assert.equal(pools[0].dexName, "Uniswap V3");
  assert.equal(pools[0].liquidityUsd, 50000.5);
  assert.equal(pools[0].volume24hUsd, 12345.6);
  assert.equal(pools[0].poolCreatedAt, "2024-01-01T00:00:00Z");
  assert.equal(pools[0].baseTokenId, "0xaave");
  assert.equal(pools[0].quoteTokenId, "0xusdc");
});

test("parseNetworkDexes: reads the DEX list catalog", () => {
  const dexes = parseNetworkDexes({ data: [{ id: "uniswap_v3", type: "dex", attributes: { name: "Uniswap V3" } }, { id: "", type: "dex" }] });
  assert.deepEqual(dexes, [{ id: "uniswap_v3", name: "Uniswap V3" }]);
  assert.deepEqual(parseNetworkDexes({}), []);
});

test("normalizeGeckoTerminalToken: liquidity and volume reuse the existing metric catalog; missing fields are unavailable, not zero", () => {
  const snapshot = normalizeGeckoTerminalToken(
    aave,
    { total_reserve_in_usd: "1000000.25", volume_usd: { h24: "500000" } },
    [{ poolAddress: "0xpool-a", dexId: "uniswap_v3", dexName: "Uniswap V3", liquidityUsd: 1_000_000.25, volume24hUsd: 500_000, poolCreatedAt: null, baseTokenId: aave.tokenAddress, quoteTokenId: "0xusdc" }],
    collectedAt,
  );
  const metric = (id) => snapshot.observations.find((item) => item.metricId === id);

  assert.equal(snapshot.providerId, "geckoterminal");
  assert.equal(metric("liquidity_usd").value, 1_000_000.25);
  assert.equal(metric("liquidity_usd").status, "available");
  assert.equal(metric("liquidity_usd").scope, "market");
  assert.equal(metric("volume_24h_usd").value, 500_000);
  assert.equal(metric("volume_24h_usd").windowDays, 1);
  assert.equal(snapshot.observations.length, 2, "only liquidity and volume are populated in this initial integration");
  assert.equal(snapshot.providerPairs.length, 1);
  assert.equal(snapshot.providerPairs[0].pairAddress, "0xpool-a");
  assert.equal(snapshot.providerPairs[0].providerChainId, "eth");

  const empty = normalizeGeckoTerminalToken(aave, null, [], collectedAt);
  assert.equal(empty.observations.every((item) => item.status === "unavailable" && item.value === null), true);

  const zero = normalizeGeckoTerminalToken(aave, { total_reserve_in_usd: "0", volume_usd: { h24: "0" } }, [], collectedAt);
  assert.equal(zero.observations.every((item) => item.value === 0 && item.status === "available"), true, "numeric zero is a real value, not unavailable");
});

test("adapter: batches token-attribute lookups, paces requests, avoids authentication, and never calls CoinGecko", async () => {
  const requests = [];
  const delays = [];
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    now: () => new Date(collectedAt),
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, headers: new Headers(init.headers) });
      if (parsed.pathname.includes("/tokens/multi/")) {
        return Response.json({
          data: [
            { id: `eth_${aave.tokenAddress}`, type: "token", attributes: { total_reserve_in_usd: "10", volume_usd: { h24: "20" } } },
          ],
        });
      }
      if (parsed.pathname.endsWith("/pools")) return Response.json({ data: [] });
      if (parsed.pathname.endsWith("/dexes")) return Response.json({ data: [{ id: "uniswap_v3", type: "dex", attributes: { name: "Uniswap V3" } }] });
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
  });

  const snapshots = await provider.fetchSnapshots([aave]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].observations.find((item) => item.metricId === "liquidity_usd").value, 10);
  assert.ok(requests.every((request) => request.url.hostname === "api.geckoterminal.com"), "every request goes to the standalone GeckoTerminal API host");
  assert.ok(requests.every((request) => !request.url.pathname.includes("/onchain")), "never uses CoinGecko's /onchain path shape");
  assert.ok(requests.every((request) => !request.headers.has("authorization") && !request.headers.has("x-api-key")), "no API key is sent");
  assert.ok(delays.every((delay) => delay >= 0), "pacing delays are non-negative");

  const { dexes } = await provider.fetchNetworkDexes("eth");
  assert.deepEqual(dexes, [{ id: "uniswap_v3", name: "Uniswap V3" }]);
  const dexesRequestCount = requests.filter((request) => request.url.pathname.endsWith("/dexes")).length;
  await provider.fetchNetworkDexes("eth");
  assert.equal(requests.filter((request) => request.url.pathname.endsWith("/dexes")).length, dexesRequestCount, "repeat network-dexes lookups are served from cache, not re-fetched");
});

test("adapter: retries 429 with Retry-After and bounds retries", async () => {
  let requests = 0;
  const delays = [];
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      requests += 1;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(provider.fetchNetworkDexes("eth"), /HTTP 429/);
  assert.equal(requests, 3);
});

test("adapter: a 404 (no pools/no resource) is treated as empty, not a failure", async () => {
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async () => {},
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  const { dexes } = await provider.fetchNetworkDexes("eth");
  assert.deepEqual(dexes, []);
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
console.log(`${cases.length - failures}/${cases.length} GeckoTerminal checks passed.`);
if (failures > 0) process.exitCode = 1;
