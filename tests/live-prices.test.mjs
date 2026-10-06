import assert from "node:assert/strict";

import { applyLivePrices, livePricesUrl, tokenIdForSymbol, DEFAULT_LIVE_PRICES_PATH, LIVE_PRICE_MAX_AGE_MS } from "../src/lib/ui/live-prices.ts";
import { binanceSymbols } from "../src/data/binance-token-mappings.ts";
import { BINANCE_SYMBOLS } from "../cloudflare/refresh-scheduler/src/binance-symbols.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const fresh = new Date(NOW - 3_000).toISOString();

function token(id, overrides = {}) {
  return {
    id, name: id, symbol: "X", chain: "Ethereum", category: "DeFi",
    priceUsd: 100, change24hPct: 1, change7dPct: 7, marketCapUsd: 1000,
    volume24hUsd: 50, fdvUsd: null, circulatingSupply: 10, maximumSupply: 20,
    tvlUsd: null, tvlChange30dPct: null, marketCapChange24hPct: null,
    volumeChange48hPct: null, volumeToMarketCapChange48hPct: null,
    fees24hUsd: null, revenue24hUsd: null, observedAt: fresh,
    metricSources: { priceUsd: { providerId: "coingecko", collectedAt: fresh, note: "stored" } },
    ...overrides,
  };
}

// A token that really is mapped, so the symbol lookup is exercised against real data.
const MAPPED_ID = Object.keys(binanceSymbols)[0];
const MAPPED_SYMBOL = binanceSymbols[MAPPED_ID];

test("a live price replaces the stored one and is attributed to Binance", () => {
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } },
  }, NOW);

  assert.equal(row.priceUsd, 123.45);
  assert.equal(row.change24hPct, -2.5);
  // Provenance must move with the value, never keep the replaced row's attribution.
  assert.equal(row.metricSources.priceUsd.providerId, "binance");
  assert.equal(row.metricSources.change24hPct.providerId, "binance");
  assert.match(row.metricSources.priceUsd.note, /USDT-quoted/);
  // Everything else is untouched.
  assert.equal(row.marketCapUsd, 1000);
  assert.equal(row.change7dPct, 7);
  assert.equal(row.volume24hUsd, 50);
});

test("a token with no live entry keeps its server-rendered value and source", () => {
  const [row] = applyLivePrices([token(MAPPED_ID)], { asOf: fresh, prices: {} }, NOW);
  assert.equal(row.priceUsd, 100);
  assert.equal(row.metricSources.priceUsd.providerId, "coingecko");
});

test("an unmapped token is never given another token's price", () => {
  const unmapped = "ethereum-usdt"; // documented unmapped: USDT is the quote currency
  assert.equal(binanceSymbols[unmapped], undefined);
  const [row] = applyLivePrices([token(unmapped)], {
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 999, c: 99 } },
  }, NOW);
  assert.equal(row.priceUsd, 100);
});

test("a stale or malformed payload is ignored in favour of the server-rendered value", () => {
  const input = [token(MAPPED_ID)];
  const stale = new Date(NOW - LIVE_PRICE_MAX_AGE_MS - 1_000).toISOString();
  const prices = { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } };

  assert.equal(applyLivePrices(input, { asOf: stale, prices }, NOW), input, "stale payload ignored");
  assert.equal(applyLivePrices(input, { asOf: "not-a-date", prices }, NOW), input, "unparseable asOf ignored");
  assert.equal(applyLivePrices(input, null, NOW), input, "no payload ignored");
  assert.equal(
    applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: Number.NaN, c: 1 } } }, NOW)[0].priceUsd,
    100,
    "non-finite price ignored rather than rendered",
  );
});

test("an unchanged poll returns the same array reference, so React re-renders nothing", () => {
  const input = [token(MAPPED_ID, { priceUsd: 123.45, change24hPct: -2.5 })];
  const same = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } } }, NOW);
  assert.equal(same, input, "identical values must not produce a new array");

  const moved = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.46, c: -2.5 } } }, NOW);
  assert.notEqual(moved, input, "a moved price must produce a new array");
});

test("polling defaults to the same-origin route, with the env var as an override", () => {
  // Binance 403s Cloudflare Workers' egress, so live prices are served from Vercel at
  // /api/live-prices. An unset env var must mean that route, not "disabled".
  assert.equal(livePricesUrl(undefined), DEFAULT_LIVE_PRICES_PATH);
  assert.equal(livePricesUrl("   "), DEFAULT_LIVE_PRICES_PATH);
  assert.equal(livePricesUrl("https://elsewhere.example/prices/"), "https://elsewhere.example/prices");
});

test("the Worker's generated symbol allowlist matches the canonical mapping", () => {
  // The Worker cannot import from src/, so its list is generated (pnpm binance:symbols).
  // Adding a token without regenerating would leave it with no live price, silently.
  assert.deepEqual([...BINANCE_SYMBOLS].sort(), Object.values(binanceSymbols).sort());
  // And every quoted symbol must resolve back to exactly one canonical token.
  for (const symbol of BINANCE_SYMBOLS) assert.ok(tokenIdForSymbol(symbol), `${symbol} maps to no token`);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown"}`); }
}
console.log(`${cases.length - failures}/${cases.length} live-price checks passed.`);
if (failures > 0) process.exitCode = 1;
