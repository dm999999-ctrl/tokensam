import assert from "node:assert/strict";

import { runUniverseValidation } from "../src/lib/universe/run-validation.ts";
import { buildValidationReport, renderMarkdownReport } from "../src/lib/universe/report.ts";
import { candidateToRow, persistCandidates } from "../src/lib/universe/persist.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = "2026-09-29T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function sufficientPrices() {
  const now = Date.parse(NOW);
  return Array.from({ length: 31 }, (_, i) => [now - (30 - i) * DAY_MS, 100 + i]);
}
function thinPrices() {
  const now = Date.parse(NOW);
  return [[now - 2 * DAY_MS, 1], [now, 1.05]];
}

const MARKET_FIXTURES = [
  { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 60000, market_cap: 1e12, market_cap_rank: 1, circulating_supply: 19_000_000, image: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png" },
  { id: "futures-coin", symbol: "futc", name: "Futures Coin", current_price: 2, market_cap: 2_000_000, market_cap_rank: 400, circulating_supply: 1_000_000, image: "https://coin-images.coingecko.com/coins/images/2/large/futc.png" },
  { id: "thin-history-coin", symbol: "thin", name: "Thin History Coin", current_price: 3, market_cap: 3_000_000, market_cap_rank: 500, circulating_supply: 1_000_000, image: "https://coin-images.coingecko.com/coins/images/3/large/thin.png" },
  { id: "no-logo-coin", symbol: "nologo", name: "No Logo Coin", current_price: 4, market_cap: 4_000_000, market_cap_rank: 600, circulating_supply: 1_000_000, image: null },
  { id: "dup-a", symbol: "dupsym", name: "Dup A", current_price: 5, market_cap: 5_000_000, market_cap_rank: 700, circulating_supply: 1_000_000, image: "https://coin-images.coingecko.com/coins/images/5/large/dupa.png" },
  { id: "dup-b", symbol: "dupsym", name: "Dup B", current_price: 6, market_cap: 6_000_000, market_cap_rank: 701, circulating_supply: 1_000_000, image: "https://coin-images.coingecko.com/coins/images/6/large/dupb.png" },
];

const MARKET_CHART_BY_ID = {
  bitcoin: sufficientPrices(),
  "futures-coin": sufficientPrices(),
  "thin-history-coin": thinPrices(),
  "no-logo-coin": sufficientPrices(),
};

function fixtureFetch(overrides = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.coingecko.com" && parsed.pathname === "/api/v3/coins/markets") {
      return new Response(JSON.stringify(parsed.searchParams.get("page") === "1" ? MARKET_FIXTURES : []), { status: 200 });
    }
    if (parsed.hostname === "api.coingecko.com" && parsed.pathname === "/api/v3/coins/list") {
      return new Response(JSON.stringify(MARKET_FIXTURES.map((m) => ({ id: m.id, symbol: m.symbol, name: m.name, platforms: {} }))), { status: 200 });
    }
    const chartMatch = parsed.pathname.match(/^\/api\/v3\/coins\/([^/]+)\/market_chart$/);
    if (parsed.hostname === "api.coingecko.com" && chartMatch) {
      const prices = MARKET_CHART_BY_ID[chartMatch[1]] ?? [];
      return new Response(JSON.stringify({ prices }), { status: 200 });
    }
    if (parsed.hostname === "api.binance.com" && parsed.pathname === "/api/v3/exchangeInfo") {
      return new Response(JSON.stringify({
        symbols: [
          { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" },
          { symbol: "THINUSDT", status: "TRADING", baseAsset: "THIN", quoteAsset: "USDT" },
          { symbol: "NOLOGOUSDT", status: "TRADING", baseAsset: "NOLOGO", quoteAsset: "USDT" },
        ],
      }), { status: 200 });
    }
    if (parsed.hostname === "fapi.binance.com" && parsed.pathname === "/fapi/v1/exchangeInfo") {
      return new Response(JSON.stringify({ symbols: [{ symbol: "FUTCUSDT", status: "TRADING", baseAsset: "FUTC", quoteAsset: "USDT" }] }), { status: 200 });
    }
    if (overrides.fallback) return overrides.fallback(parsed);
    throw new Error(`unexpected URL in fixture fetch: ${url}`);
  };
}

test("end-to-end: each fixture candidate reaches the correct, explained eligibility outcome", async () => {
  const result = await runUniverseValidation({
    config: { candidatePoolSize: MARKET_FIXTURES.length },
    env: { COINGECKO_API_KEY: "test-key" },
    fetchImpl: fixtureFetch(),
    sleep: async () => {},
    now: () => new Date(NOW),
  });

  assert.equal(result.outage, null);
  const byId = new Map(result.candidates.map((c) => [c.coingeckoId, c]));

  const bitcoin = byId.get("bitcoin");
  assert.equal(bitcoin.eligibilityStatus, "eligible");
  assert.equal(bitcoin.binanceResolutionMethod, "direct_usdt");
  assert.equal(bitcoin.tokenId, "bitcoin-btc", "matched to the existing curated canonical token by CoinGecko ID");

  const futures = byId.get("futures-coin");
  assert.equal(futures.eligibilityStatus, "ineligible");
  assert.ok(futures.eligibilityReasonCodes.includes("BINANCE_FUTURES_ONLY"));

  const thin = byId.get("thin-history-coin");
  assert.equal(thin.eligibilityStatus, "ineligible");
  assert.ok(thin.eligibilityReasonCodes.includes("HISTORICAL_DATA_INSUFFICIENT"));

  const noLogo = byId.get("no-logo-coin");
  assert.equal(noLogo.eligibilityStatus, "ineligible");
  assert.ok(noLogo.eligibilityReasonCodes.includes("LOGO_UNAVAILABLE"));

  const dupA = byId.get("dup-a");
  const dupB = byId.get("dup-b");
  assert.equal(dupA.eligibilityStatus, "needs_review");
  assert.equal(dupB.eligibilityStatus, "needs_review");
  assert.ok(dupA.eligibilityReasonCodes.includes("IDENTITY_COLLISION"));
  assert.equal(dupA.binanceStatus, null, "no Binance mapping was attempted for a colliding identity");

  const report = buildValidationReport(result.candidates, NOW);
  assert.equal(report.counts.totalCandidates, 6);
  assert.equal(report.counts.eligible, 1);
  assert.equal(report.counts.needsReview, 2);
  assert.equal(report.counts.ineligible, 3);
  const markdown = renderMarkdownReport(report);
  assert.ok(markdown.includes("Bitcoin (BTC)"));
  assert.ok(markdown.includes("## Summary"));
});

test("a discovery-wide outage never destroys previously-persisted eligible candidates", async () => {
  const previous = (
    await runUniverseValidation({
      config: { candidatePoolSize: MARKET_FIXTURES.length },
      env: { COINGECKO_API_KEY: "test-key" },
      fetchImpl: fixtureFetch(),
      sleep: async () => {},
      now: () => new Date(NOW),
    })
  ).candidates;

  const result = await runUniverseValidation({
    config: { candidatePoolSize: MARKET_FIXTURES.length },
    env: { COINGECKO_API_KEY: "test-key" },
    fetchImpl: async () => new Response("", { status: 500 }),
    sleep: async () => {},
    now: () => new Date(NOW),
    existingCandidates: previous,
  });

  assert.ok(result.outage);
  const bitcoin = result.candidates.find((c) => c.coingeckoId === "bitcoin");
  assert.equal(bitcoin.eligibilityStatus, "temporarily_unavailable");
  assert.equal(bitcoin.binanceSymbol, "BTCUSDT", "the previously-resolved Binance mapping is preserved through the outage");
});

test("persisting the same candidate pool twice (idempotent re-run) never duplicates rows", async () => {
  const { client, rows } = createFakeSupabase({ seed: { universe_candidates: [] } });
  const first = await runUniverseValidation({
    config: { candidatePoolSize: MARKET_FIXTURES.length },
    env: { COINGECKO_API_KEY: "test-key" },
    fetchImpl: fixtureFetch(),
    sleep: async () => {},
    now: () => new Date(NOW),
  });
  await persistCandidates(client, first.candidates, () => new Date(NOW));
  await persistCandidates(client, first.candidates, () => new Date(NOW));

  const stored = rows("universe_candidates");
  assert.equal(stored.length, MARKET_FIXTURES.length, "re-running persistence does not duplicate rows");
  assert.equal(new Set(stored.map((row) => row.coingecko_id)).size, MARKET_FIXTURES.length);
});

test("candidateToRow maps every camelCase field to its documented snake_case column", async () => {
  const [candidate] = (
    await runUniverseValidation({
      config: { candidatePoolSize: 1 },
      env: { COINGECKO_API_KEY: "test-key" },
      fetchImpl: fixtureFetch(),
      sleep: async () => {},
      now: () => new Date(NOW),
    })
  ).candidates;
  const row = candidateToRow(candidate, NOW);
  assert.equal(row.coingecko_id, "bitcoin");
  assert.equal(row.eligibility_status, "eligible");
  assert.equal(row.binance_resolution_method, "direct_usdt");
  assert.equal(row.updated_at, NOW);
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}\n${error?.stack ?? ""}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} Phase A orchestrator checks passed.`);
if (failures > 0) process.exitCode = 1;
