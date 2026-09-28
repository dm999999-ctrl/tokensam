import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { runCoinGeckoCollection } from "../src/lib/providers/run-coingecko-collection.ts";
import { CollectorDiagnostics } from "../src/lib/refresh/collector-diagnostics.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

process.env.COINGECKO_API_KEY = "test-coingecko-key-not-real";
process.env.COINGECKO_API_PLAN = "demo";

const DEX_METRICS = []; // Not needed: this file only exercises the CoinGecko collector.
const NOW = new Date();
const noSleep = async () => {};

function marketItem(id) {
  return {
    id, last_updated: NOW.toISOString(), current_price: 2, market_cap: 2_000, total_volume: 200,
    price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2,
    circulating_supply: 1_000, total_supply: 1_000, max_supply: null,
  };
}

function okFetch() {
  return async (input) => {
    const url = new URL(String(input));
    return Response.json(url.searchParams.get("ids").split(",").map(marketItem));
  };
}

function baseSeed() {
  return { tokens: [], provider_pairs: [] };
}

/** Wraps a fake Supabase client so a chosen table's upsert() finishes only after `delayMs`,
 *  letting a test detect whether a dependent table was written before that delay elapsed —
 *  i.e. whether the dependency was actually awaited, not just called. */
function withDelayedUpsert(client, table, delayMs, log) {
  return {
    from(name) {
      const query = client.from(name);
      if (name !== table) return query;
      const originalUpsert = query.upsert.bind(query);
      query.upsert = (...args) => {
        log.push({ table: name, event: "upsert-called", at: Date.now() });
        const delayed = new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => originalUpsert(...args));
        // Preserve the thenable/query chain shape (fake-supabase's Query.then resolves on execute()).
        return { then: (resolve, reject) => delayed.then((result) => {
          log.push({ table: name, event: "upsert-resolved", at: Date.now() });
          resolve(result);
        }, reject) };
      };
      return query;
    },
  };
}

test("prepareDatabase: tokens (depends on chains) only writes after chains actually resolves, not just after it's called", async () => {
  const log = [];
  const db = createFakeSupabase({ seed: baseSeed() });
  const client = withDelayedUpsert(db.client, "chains", 30, log);
  const originalTokensFrom = client.from;
  client.from = (name) => {
    const query = originalTokensFrom(name);
    if (name === "tokens") {
      const originalUpsert = query.upsert.bind(query);
      query.upsert = (...args) => { log.push({ table: "tokens", event: "upsert-called", at: Date.now() }); return originalUpsert(...args); };
    }
    return query;
  };

  await runCoinGeckoCollection(client, {
    tokenIds: [canonicalTokens[0].id, canonicalTokens[1].id],
    fetchImpl: okFetch(), sleep: noSleep,
    diagnostics: new CollectorDiagnostics(),
  });

  const chainsCalled = log.find((entry) => entry.table === "chains" && entry.event === "upsert-called");
  const chainsResolved = log.find((entry) => entry.table === "chains" && entry.event === "upsert-resolved");
  const tokensCalled = log.find((entry) => entry.table === "tokens" && entry.event === "upsert-called");
  assert.ok(chainsCalled && chainsResolved && tokensCalled, "all three events were recorded");
  assert.ok(chainsResolved.at - chainsCalled.at >= 25, "the artificial delay actually elapsed before chains resolved");
  assert.ok(tokensCalled.at >= chainsResolved.at,
    "tokens.upsert() is only invoked after chains.upsert() has resolved, even though both run inside the same concurrent phase 1/phase 2 split — parallelizing independent upserts must not let a dependent write race ahead of what it depends on");
});

test("prepareDatabase: provider_token_mappings (depends on tokens and data_providers) only writes after both resolve", async () => {
  const log = [];
  const db = createFakeSupabase({ seed: baseSeed() });
  let client = withDelayedUpsert(db.client, "data_providers", 25, log);
  const withTokensDelay = withDelayedUpsert(client, "tokens", 15, log);
  client = withTokensDelay;
  const originalFrom = client.from;
  client.from = (name) => {
    const query = originalFrom(name);
    if (name === "provider_token_mappings") {
      const originalUpsert = query.upsert.bind(query);
      query.upsert = (...args) => { log.push({ table: "provider_token_mappings", event: "upsert-called", at: Date.now() }); return originalUpsert(...args); };
    }
    return query;
  };

  await runCoinGeckoCollection(client, {
    tokenIds: [canonicalTokens[0].id],
    fetchImpl: okFetch(), sleep: noSleep,
    diagnostics: new CollectorDiagnostics(),
  });

  const providersResolved = log.find((entry) => entry.table === "data_providers" && entry.event === "upsert-resolved");
  const tokensResolved = log.find((entry) => entry.table === "tokens" && entry.event === "upsert-resolved");
  const mappingsCalled = log.find((entry) => entry.table === "provider_token_mappings" && entry.event === "upsert-called");
  assert.ok(providersResolved && tokensResolved && mappingsCalled);
  assert.ok(mappingsCalled.at >= providersResolved.at, "provider_token_mappings waits for data_providers to resolve");
  assert.ok(mappingsCalled.at >= tokensResolved.at, "provider_token_mappings waits for tokens to resolve");
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
console.log(`${cases.length - failures}/${cases.length} coingecko-collection checks passed.`);
if (failures > 0) process.exitCode = 1;
