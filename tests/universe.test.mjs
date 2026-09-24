import assert from "node:assert/strict";

import { canonicalTokens, additionalCanonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds, nativeTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { defillamaProtocolMappings } from "../src/data/defillama-protocol-mappings.ts";
import { dexScreenerTokenMappings } from "../src/data/dexscreener-token-mappings.ts";
import { configuredDexScreenerAssets } from "../src/lib/providers/dexscreener.ts";
import { persistProviderSnapshots } from "../src/lib/providers/persist-snapshots.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test("the canonical set grows from 20 to 50 with unique chain-scoped identities", () => {
  assert.equal(canonicalTokens.length, 50);
  assert.equal(additionalCanonicalTokens.length, 30);
  assert.equal(new Set(canonicalTokens.map((token) => token.id)).size, 50);
  assert.equal(new Set(canonicalTokens.map((token) => `${token.chainId}:${token.contractAddress?.toLowerCase() ?? "native"}`)).size, 50);
  assert.equal(new Set(canonicalTokens.filter((token) => token.isNative).map((token) => token.chainId)).size, canonicalTokens.filter((token) => token.isNative).length);
  assert.ok(canonicalTokens.every((token) => token.id && token.chainId && token.symbol && token.name));
});

test("provider mappings are unique, explicit, chain-consistent, and leave unsupported assets unmapped", () => {
  const ids = new Set(canonicalTokens.map((token) => token.id));
  const coinIds = canonicalTokens.map((token) => coingeckoTokenIds[token.id]);
  assert.equal(coinIds.filter(Boolean).length, 50);
  assert.equal(new Set(coinIds).size, 50);
  assert.equal(new Set(dexScreenerTokenMappings.map((mapping) => mapping.tokenId)).size, 50);
  const dexAssetsByToken = new Map(configuredDexScreenerAssets().map((asset) => [asset.tokenId, asset]));
  for (const mapping of dexScreenerTokenMappings) {
    assert.ok(ids.has(mapping.tokenId));
    if (mapping.tokenAddress) {
      assert.ok(mapping.dexChainId);
      assert.equal(
        dexAssetsByToken.get(mapping.tokenId)?.externalAssetId,
        `${mapping.dexChainId}:${mapping.tokenAddress}`,
      );
    } else {
      assert.ok(mapping.unmappedReason);
    }
  }
  assert.equal(new Set(defillamaProtocolMappings.map((mapping) => mapping.tokenId)).size, defillamaProtocolMappings.length);
  assert.ok(defillamaProtocolMappings.every((mapping) => ids.has(mapping.tokenId) && mapping.externalAssetId && mapping.relationship));
  assert.ok(nativeTokenIds.size < 50);
});

test("provider observation persistence is idempotent while raw snapshots remain append-only", async () => {
  const observations = [];
  let nextRawId = 1;
  const client = {
    from(table) {
      if (table === "raw_provider_records") {
        return {
          insert(rows) {
            return {
              select: async () => ({
                data: rows.map((row) => ({ id: nextRawId++, token_id: row.token_id, chain_id: row.chain_id })),
                error: null,
              }),
            };
          },
        };
      }
      if (table === "token_metric_observations") {
        const query = {
          select() { return this; },
          in() { return this; },
          gte() { return this; },
          lte() { return this; },
          range: async () => ({ data: observations, error: null }),
          insert: async (rows) => { observations.push(...rows); return { error: null }; },
        };
        return query;
      }
      if (table === "provider_token_mappings") {
        const query = { in: () => query, then: (resolve) => resolve({ data: [], error: null }) };
        return { select: () => query };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const snapshot = {
    providerId: "coingecko",
    endpointLabel: "fixture",
    asset: { tokenId: "ethereum-usdt", chainId: "ethereum", externalAssetId: "tether" },
    observedAt: "2026-09-24T00:00:00.000Z",
    collectedAt: "2026-09-24T00:01:00.000Z",
    rawPayload: { fixture: true },
    observations: [{
      tokenId: "ethereum-usdt", chainId: "ethereum", metricId: "price_usd", value: 1,
      status: "available", observedAt: "2026-09-24T00:00:00.000Z", collectedAt: "2026-09-24T00:01:00.000Z",
      windowDays: null, sourceField: "fixture", note: null,
    }],
  };
  const first = await persistProviderSnapshots(client, [snapshot]);
  const second = await persistProviderSnapshots(client, [snapshot]);
  assert.equal(first.observations, 1);
  assert.equal(second.observations, 0);
  assert.equal(observations.length, 1);
  assert.equal(first.rawRecords, 1);
  assert.equal(second.rawRecords, 1, "each sync preserves its own raw response for provenance");
});

test("large raw provider responses are persisted in bounded payload batches", async () => {
  const rawBatchSizes = [];
  const client = {
    from(table) {
      if (table === "raw_provider_records") {
        return {
          insert(rows) {
            rawBatchSizes.push(rows.length);
            return { select: async () => ({
              data: rows.map((row, index) => ({ id: index + 1, token_id: row.token_id, chain_id: row.chain_id })),
              error: null,
            }) };
          },
        };
      }
      if (table === "token_metric_observations") {
        return {
          select() { return this; },
          in() { return this; },
          gte() { return this; },
          lte() { return this; },
          range: async () => ({ data: [], error: null }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === "provider_token_mappings") {
        const query = { in: () => query, then: (resolve) => resolve({ data: [], error: null }) };
        return { select: () => query };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const makeSnapshot = (tokenId, externalAssetId) => ({
    providerId: "defillama",
    endpointLabel: "fixture",
    asset: { tokenId, chainId: "ethereum", externalAssetId },
    observedAt: "2026-09-24T00:00:00.000Z",
    collectedAt: "2026-09-24T00:01:00.000Z",
    rawPayload: { response: "x".repeat(110_000) },
    observations: [{
      tokenId, chainId: "ethereum", metricId: "price_usd", value: 1, status: "available",
      observedAt: "2026-09-24T00:00:00.000Z", collectedAt: "2026-09-24T00:01:00.000Z",
      windowDays: null, sourceField: "fixture", note: null,
    }],
  });
  await persistProviderSnapshots(client, [makeSnapshot("ethereum-one", "one"), makeSnapshot("ethereum-two", "two")]);
  assert.deepEqual(rawBatchSizes, [1, 1]);
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
console.log(`${cases.length - failures}/${cases.length} universe checks passed.`);
if (failures > 0) process.exitCode = 1;
