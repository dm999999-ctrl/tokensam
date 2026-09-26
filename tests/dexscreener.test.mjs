import assert from "node:assert/strict";

import {
  configuredDexScreenerAssets,
  DexScreenerMarketDataProvider,
  getUnmappedDexScreenerTokens,
  normalizeDexScreenerToken,
  selectPrimaryPair,
} from "../src/lib/providers/dexscreener.ts";
import { dexScreenerTokenMappings } from "../src/data/dexscreener-token-mappings.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";

const collectedAt = "2026-09-23T12:00:00.000Z";
const assets = configuredDexScreenerAssets();
const aave = assets.find((asset) => asset.tokenId === "aave-aave");
const jupiter = assets.find((asset) => asset.tokenId === "jupiter-jup");
const pair = (overrides = {}) => ({
  chainId: "ethereum",
  dexId: "fixture-dex",
  url: "https://dex.example/pair",
  pairAddress: "0xpair-low",
  baseToken: { address: aave.tokenAddress, name: "Aave", symbol: "AAVE" },
  quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
  priceUsd: "10.5",
  txns: { h24: { buys: 70, sells: 30 } },
  volume: { h24: 20_000 },
  priceChange: { h24: 3.5 },
  liquidity: { usd: 10_000, base: 500, quote: 5_000 },
  fdv: 100_000_000,
  marketCap: 80_000_000,
  pairCreatedAt: 1_700_000_000_000,
  ...overrides,
});

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test("maps the 238 canonical token universe by chain and explicit address only", () => {
  assert.equal(canonicalTokens.length, 238);
  assert.equal(dexScreenerTokenMappings.length, 238);
  assert.equal(new Set(dexScreenerTokenMappings.map((mapping) => mapping.tokenId)).size, 238);
  assert.equal(new Set(canonicalTokens.map((token) => token.id)).size, 238);
  // 58 verified contracts + native SUI, APT, ICP, TON, and HYPE identifiers; wrapped proxies for natives are retired.
  // Phase 16 (100 -> 238) adds no new DEX Screener mappings (no contract address is invented), so
  // the mapped count is unchanged and every one of the 138 new tokens is unmapped.
  assert.equal(assets.length, 63);
  assert.equal(getUnmappedDexScreenerTokens().length, 175);
  // Phase 15: a contract token's DEX address is exactly its canonical contract on the canonical chain.
  for (const token of canonicalTokens.filter((candidate) => !candidate.isNative && candidate.contractAddress)) {
    const asset = assets.find((item) => item.tokenId === token.id);
    if (asset) assert.equal(asset.tokenAddress.toLowerCase(), token.contractAddress.toLowerCase(), `${token.id} DEX address is its canonical contract`);
  }
  assert.equal(assets.find((asset) => asset.tokenId === "bnb-chain-cake")?.dexChainId, "bsc");
  assert.equal(assets.find((asset) => asset.tokenId === "zksync-zk")?.dexChainId, "zksync");
  assert.equal(assets.find((asset) => asset.tokenId === "ton-gram")?.tokenAddress, "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
  assert.equal(assets.find((asset) => asset.tokenId === "hyperliquid-hype")?.tokenAddress, "0x0d01dc56dcaaca66ad901c959b4011ec");
  for (const native of ["sonic-s", "cronos-cro", "hedera-hbar", "sei-sei", "ethereum-classic-etc", "bittensor-tao", "injective-inj", "zcash-zec"]) {
    assert.equal(assets.some((asset) => asset.tokenId === native), false, `${native} has no DEX mapping and no wrapped substitute`);
    assert.ok(getUnmappedDexScreenerTokens().find((item) => item.tokenId === native)?.reason, `${native} records why it is unmapped`);
  }
  for (const native of ["ethereum-eth", "solana-sol", "bnb-bnb", "avalanche-avax"]) {
    assert.equal(assets.some((asset) => asset.tokenId === native), false, `${native} is not mapped to a wrapped asset`);
  }
  assert.equal(assets.some((asset) => asset.tokenId === "internet-computer-icp" && asset.dexChainId === "icp" && asset.tokenAddress === "ryjl3-tyaaa-aaaaa-aaaba-cai"), true);
  assert.ok(assets.every((asset) => asset.tokenAddress && asset.externalAssetId.includes(":")));
  assert.equal(assets.some((asset) => asset.tokenId === "bitcoin-btc"), false);
  assert.equal(assets.some((asset) => asset.tokenId === "ethereum-usdt" && asset.tokenAddress === "0xdac17f958d2ee523a2206206994597c13d831ec7"), true);
  assert.equal(assets.some((asset) => asset.tokenId === "base-aero" && asset.dexChainId === "base"), true);
});

test("selects the most liquid exact base-token pair, with deterministic tie breaks", () => {
  const baseLow = pair();
  const baseHigh = pair({ pairAddress: "0xpair-high", liquidity: { usd: 50_000 }, volume: { h24: 30_000 }, priceUsd: "11" });
  const quoteOnly = pair({
    pairAddress: "0xpair-quote",
    baseToken: { address: "0xother", name: "Other", symbol: "OTHER" },
    quoteToken: { address: aave.tokenAddress, name: "Aave", symbol: "AAVE" },
    liquidity: { usd: 100_000 },
    priceUsd: "99",
  });
  const wrongAddress = pair({ pairAddress: "0xfake", baseToken: { address: "0xfake", name: "Aave", symbol: "AAVE" } });
  const wrongChain = pair({ pairAddress: "0f-wrong-chain", chainId: "bsc" });

  assert.equal(selectPrimaryPair(aave, [baseLow, quoteOnly, wrongAddress, wrongChain, baseHigh])?.pairAddress, "0xpair-high");
  assert.equal(selectPrimaryPair(aave, [baseLow, pair({ pairAddress: "0xpair-a", liquidity: { usd: 10_000 } })])?.pairAddress, "0xpair-a");
});

test("normalizes selected-pair metrics and aggregate pair activity while retaining all exact pairs", () => {
  const best = pair({ pairAddress: "0xpair-best", liquidity: { usd: 50_000 }, volume: { h24: 30_000 }, priceUsd: "11", priceChange: { h24: 4.2 }, fdv: 110_000_000, marketCap: 90_000_000 });
  const secondary = pair({ pairAddress: "0xpair-secondary", liquidity: { usd: 15_000 }, volume: { h24: 12_000 }, txns: { h24: { buys: 10, sells: 8 } } });
  const quoteOnly = pair({
    pairAddress: "0xpair-quote",
    baseToken: { address: "0xother", name: "Other", symbol: "OTHER" },
    quoteToken: { address: aave.tokenAddress, name: "Aave", symbol: "AAVE" },
    liquidity: { usd: 100_000 },
    volume: { h24: 8_000 },
    txns: { h24: { buys: 4, sells: 6 } },
    priceUsd: "99",
  });
  const snapshot = normalizeDexScreenerToken(aave, [best, secondary, quoteOnly], collectedAt);
  const metric = (id) => snapshot.observations.find((item) => item.metricId === id);

  assert.equal(snapshot.providerId, "dexscreener");
  assert.equal(snapshot.providerPairs.length, 3);
  assert.equal(snapshot.rawPayload.providerPairs.length, 3);
  assert.equal(metric("price_usd")?.value, 11, "price is from the primary exact base-token pair");
  assert.equal(metric("price_change_24h_pct")?.value, 4.2);
  assert.equal(metric("liquidity_usd")?.value, 50_000);
  assert.equal(metric("volume_24h_usd")?.value, 50_000, "24-hour pair volume aggregates across matched pools");
  assert.equal(metric("buys_24h_count")?.value, 84);
  assert.equal(metric("sells_24h_count")?.value, 44);
  assert.equal(metric("transactions_24h_count")?.value, 128);
  assert.equal(metric("fdv_usd")?.value, 110_000_000);
  assert.equal(metric("market_cap_usd")?.value, 90_000_000);
  assert.equal(snapshot.providerPairs.find((item) => item.pairAddress === "0xpair-best")?.pairCreatedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(snapshot.observedAt, collectedAt, "API response has no provider snapshot timestamp");
});

test("null values stay unavailable, numeric zero stays available, and quote-only price is not inverted", () => {
  const quoteOnly = pair({
    baseToken: { address: "0xother", name: "Other", symbol: "OTHER" },
    quoteToken: { address: aave.tokenAddress, name: "Aave", symbol: "AAVE" },
    priceUsd: "123.45",
    priceChange: { h24: 5 },
    fdv: 100,
    marketCap: 90,
    liquidity: { usd: null },
    volume: { h24: 0 },
    txns: { h24: { buys: 0, sells: 0 } },
  });
  const snapshot = normalizeDexScreenerToken(aave, [quoteOnly], collectedAt);
  const metric = (id) => snapshot.observations.find((item) => item.metricId === id);

  for (const id of ["price_usd", "price_change_24h_pct", "fdv_usd", "market_cap_usd", "liquidity_usd"]) {
    assert.equal(metric(id)?.status, "unavailable", `${id} should not be misread from quote-side/no-liquidity data`);
    assert.equal(metric(id)?.value, null);
  }
  assert.equal(metric("volume_24h_usd")?.value, 0);
  assert.equal(metric("volume_24h_usd")?.status, "available");
  assert.equal(metric("buys_24h_count")?.value, 0);
  assert.equal(metric("sells_24h_count")?.value, 0);
  assert.equal(metric("transactions_24h_count")?.value, 0);
});

test("adapter groups addresses by chain, avoids authentication, and uses fixtures only", async () => {
  const requests = [];
  const delays = [];
  const provider = new DexScreenerMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    now: () => new Date(collectedAt),
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), headers: new Headers(init.headers) });
      return new Response(JSON.stringify([pair({ chainId: "ethereum", baseToken: { address: aave.tokenAddress, name: "Aave", symbol: "AAVE" } })]), { status: 200 });
    },
  });
  const snapshots = await provider.fetchSnapshots([aave, jupiter]);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname.startsWith("/tokens/v1/ethereum/"), true);
  assert.equal(requests[1].url.pathname.startsWith("/tokens/v1/solana/"), true);
  assert.equal(requests[0].url.pathname.includes(encodeURIComponent(aave.tokenAddress)), true);
  assert.equal(requests.every((request) => !request.headers.has("authorization") && !request.headers.has("x-api-key")), true);
  assert.deepEqual(delays, [300]);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.find((snapshot) => snapshot.asset.tokenId === "jupiter-jup")?.providerPairs.length, 0);
});

test("429 responses honor Retry-After and bound retries", async () => {
  let requests = 0;
  const delays = [];
  const provider = new DexScreenerMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      requests += 1;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(provider.fetchSnapshots([aave]), /HTTP 429/);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [0, 0]);
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
console.log(`${cases.length - failures}/${cases.length} DEX Screener checks passed.`);
if (failures > 0) process.exitCode = 1;
