import assert from "node:assert/strict";

import { CANONICAL_CHAIN_IDS, COINGECKO_PLATFORM_TO_CHAIN_ID, resolveCanonicalChainId } from "../src/lib/universe/coingecko-chain-map.ts";
import { resolvePlatformIdentity } from "../src/lib/universe/coingecko-discovery.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test("a directly matching platform key resolves to the same canonical chain ID", () => {
  assert.equal(resolveCanonicalChainId("ethereum"), "ethereum");
  assert.equal(resolveCanonicalChainId("solana"), "solana");
  assert.equal(resolveCanonicalChainId("tron"), "tron");
});

test("each documented naming-difference mapping resolves to its real canonical chain ID", () => {
  assert.equal(resolveCanonicalChainId("binance-smart-chain"), "bnb-chain");
  assert.equal(resolveCanonicalChainId("optimistic-ethereum"), "optimism");
  assert.equal(resolveCanonicalChainId("polygon-pos"), "polygon");
  assert.equal(resolveCanonicalChainId("zksync-era"), "zksync");
  assert.equal(resolveCanonicalChainId("the-open-network"), "ton");
});

test("an unknown CoinGecko platform key resolves to null, never a guess", () => {
  assert.equal(resolveCanonicalChainId("some-brand-new-l2-nobody-has-heard-of"), null);
  assert.equal(resolveCanonicalChainId(""), null);
});

test("every mapped value is a real row in the current chains catalog: no candidate can violate the chains foreign key", () => {
  assert.ok(CANONICAL_CHAIN_IDS.size > 0, "the canonical chain catalog itself must not be empty");
  for (const [platformKey, chainId] of Object.entries(COINGECKO_PLATFORM_TO_CHAIN_ID)) {
    assert.ok(CANONICAL_CHAIN_IDS.has(chainId), `mapping "${platformKey}" -> "${chainId}" must reference a real chains row`);
  }
});

test("resolveCanonicalChainId can never return a value outside the canonical chain catalog, even defensively", () => {
  for (const platformKey of Object.keys(COINGECKO_PLATFORM_TO_CHAIN_ID)) {
    const resolved = resolveCanonicalChainId(platformKey);
    assert.ok(resolved === null || CANONICAL_CHAIN_IDS.has(resolved));
  }
});

// ---- resolvePlatformIdentity: the four identity states this module must distinguish ----

test("native asset: no platforms at all", () => {
  const identity = resolvePlatformIdentity({ id: "bitcoin", symbol: "btc", name: "Bitcoin", platforms: {} });
  assert.equal(identity.isNative, true);
  assert.equal(identity.chainId, null);
  assert.equal(identity.contractAddress, null);
});

test("single-chain contract asset with a confidently-mapped platform: chain and contract are both set", () => {
  const identity = resolvePlatformIdentity({ id: "example", symbol: "ex", name: "Example", platforms: { "binance-smart-chain": "0xAbCdEf0000000000000000000000000000dEaD" } });
  assert.equal(identity.chainId, "bnb-chain");
  assert.equal(identity.contractAddress, "0xabcdef0000000000000000000000000000dead");
  assert.equal(identity.isNative, false);
  assert.deepEqual(identity.platforms, { "binance-smart-chain": "0xAbCdEf0000000000000000000000000000dEaD" });
});

test("single-chain contract asset on an UNMAPPED platform: chainId and contractAddress are withheld, never a raw CoinGecko key inserted as the chain", () => {
  const identity = resolvePlatformIdentity({ id: "example-2", symbol: "ex2", name: "Example 2", platforms: { "some-brand-new-l2": "0x1111111111111111111111111111111111111" } });
  assert.equal(identity.chainId, null, "this is the exact bug being fixed: a CoinGecko platform key must never become the chain_id");
  assert.equal(identity.contractAddress, null);
  assert.equal(identity.isNative, false);
  // The raw evidence is still preserved for later review, per requirement #4.
  assert.deepEqual(identity.platforms, { "some-brand-new-l2": "0x1111111111111111111111111111111111111" });
});

test("multi-chain asset: chain identity is unresolved, never guessed, but every platform is preserved as evidence", () => {
  const identity = resolvePlatformIdentity({ id: "usdt", symbol: "usdt", name: "Tether", platforms: { ethereum: "0xdac17f958d2ee523a2206206994597c13d831ec7", tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" } });
  assert.equal(identity.chainId, null);
  assert.equal(identity.contractAddress, null);
  assert.equal(identity.isNative, false);
  assert.deepEqual(Object.keys(identity.platforms).sort(), ["ethereum", "tron"]);
});

test("a resolved chain identity is always one of the real canonical chains, never a raw CoinGecko slug", () => {
  const identity = resolvePlatformIdentity({ id: "op-example", symbol: "opx", name: "OP Example", platforms: { "optimistic-ethereum": "0x2222222222222222222222222222222222222" } });
  assert.equal(identity.chainId, "optimism");
  assert.notEqual(identity.chainId, "optimistic-ethereum");
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
console.log(`${cases.length - failures}/${cases.length} Phase A CoinGecko chain-map checks passed.`);
if (failures > 0) process.exitCode = 1;
