import assert from "node:assert/strict";

import { buildMarketSnapshot, isSpotTradable } from "../src/lib/universe/binance-client.ts";
import { binanceUnavailable, resolveBinanceSpot } from "../src/lib/universe/binance-resolver.ts";
import { DEFAULT_ELIGIBILITY_CONFIG } from "../src/lib/universe/config.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const CHECKED_AT = "2026-09-29T00:00:00.000Z";
const config = DEFAULT_ELIGIBILITY_CONFIG;

function snapshotOf(spotSymbols, futuresSymbols = []) {
  return buildMarketSnapshot(spotSymbols, futuresSymbols);
}

test("a direct USDT Spot market resolves with the highest-priority method", () => {
  const snapshot = snapshotOf([{ symbol: "ETHUSDT", status: "TRADING", baseAsset: "ETH", quoteAsset: "USDT" }, { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }]);
  const result = resolveBinanceSpot({ symbol: "ETH" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "pass");
  assert.equal(result.binanceResolutionMethod, "direct_usdt");
  assert.equal(result.binanceMarketType, "spot");
  assert.equal(result.binanceSymbol, "ETHUSDT");
});

test("a direct USDC Spot market resolves when no USDT pair exists", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }, { symbol: "FOOUSDC", status: "TRADING", baseAsset: "FOO", quoteAsset: "USDC" }]);
  const result = resolveBinanceSpot({ symbol: "FOO" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "pass");
  assert.equal(result.binanceResolutionMethod, "direct_usdc");
});

test("an approved USD stablecoin pair resolves when USDT/USDC are absent", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }, { symbol: "BARFDUSD", status: "TRADING", baseAsset: "BAR", quoteAsset: "FDUSD" }]);
  const result = resolveBinanceSpot({ symbol: "BAR" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "pass");
  assert.equal(result.binanceResolutionMethod, "approved_stable");
});

test("the BTC route resolves only when BTC/USDT itself is tradable", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }, { symbol: "OBSCUREBTC", status: "TRADING", baseAsset: "OBSCURE", quoteAsset: "BTC" }]);
  const result = resolveBinanceSpot({ symbol: "OBSCURE" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "pass");
  assert.equal(result.binanceResolutionMethod, "btc_route");
});

test("the BTC route does not resolve when BTC/USDT is not tradable", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "BREAK", baseAsset: "BTC", quoteAsset: "USDT" }, { symbol: "OBSCUREBTC", status: "TRADING", baseAsset: "OBSCURE", quoteAsset: "BTC" }]);
  const result = resolveBinanceSpot({ symbol: "OBSCURE" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "fail");
  assert.equal(result.binanceFailureReason, "BINANCE_NOT_TRADING");
});

test("the ETH route resolves only when ETH/USDT itself is tradable", () => {
  const snapshot = snapshotOf([{ symbol: "ETHUSDT", status: "TRADING", baseAsset: "ETH", quoteAsset: "USDT" }, { symbol: "OBSCUREETH", status: "TRADING", baseAsset: "OBSCURE", quoteAsset: "ETH" }]);
  const result = resolveBinanceSpot({ symbol: "OBSCURE" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "pass");
  assert.equal(result.binanceResolutionMethod, "eth_route");
});

test("direct stablecoin pairs are preferred over the BTC/ETH routes when both exist", () => {
  const snapshot = snapshotOf([
    { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" },
    { symbol: "FOOUSDT", status: "TRADING", baseAsset: "FOO", quoteAsset: "USDT" },
    { symbol: "FOOBTC", status: "TRADING", baseAsset: "FOO", quoteAsset: "BTC" },
  ]);
  const result = resolveBinanceSpot({ symbol: "FOO" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceResolutionMethod, "direct_usdt");
});

test("no Spot pair and no Futures listing resolves as not found", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }]);
  const result = resolveBinanceSpot({ symbol: "NOWHERE" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "fail");
  assert.equal(result.binanceFailureReason, "BINANCE_SPOT_NOT_FOUND");
  assert.equal(result.binanceMarketType, "none");
});

test("a Futures-only listing is never substituted for Spot", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }], [{ symbol: "FUTONLYUSDT", status: "TRADING", baseAsset: "FUTONLY", quoteAsset: "USDT" }]);
  const result = resolveBinanceSpot({ symbol: "FUTONLY" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "fail");
  assert.equal(result.binanceFailureReason, "BINANCE_FUTURES_ONLY");
  assert.equal(result.binanceMarketType, "futures_only");
});

test("a suspended (non-TRADING) Spot symbol fails as not-trading, not silently passed", () => {
  const snapshot = snapshotOf([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }, { symbol: "PAUSEDUSDT", status: "BREAK", baseAsset: "PAUSED", quoteAsset: "USDT" }]);
  const result = resolveBinanceSpot({ symbol: "PAUSED" }, "valid", snapshot, config, CHECKED_AT);
  assert.equal(result.binanceStatus, "fail");
  assert.equal(result.binanceFailureReason, "BINANCE_NOT_TRADING");
  assert.equal(result.binanceMarketStatus, "BREAK");
});

test("an unresolved (colliding) identity is never given a Binance mapping, even if a matching symbol exists", () => {
  const snapshot = snapshotOf([{ symbol: "TOKENUSDT", status: "TRADING", baseAsset: "TOKEN", quoteAsset: "USDT" }]);
  const result = resolveBinanceSpot({ symbol: "TOKEN" }, "collision", snapshot, config, CHECKED_AT);
  assert.equal(result, null);
});

test("isSpotTradable rejects symbols explicitly marked spot-trading-disallowed", () => {
  assert.equal(isSpotTradable({ symbol: "X", status: "TRADING", baseAsset: "X", quoteAsset: "USDT", isSpotTradingAllowed: false }), false);
  assert.equal(isSpotTradable({ symbol: "X", status: "TRADING", baseAsset: "X", quoteAsset: "USDT", permissions: ["MARGIN"] }), false);
  assert.equal(isSpotTradable({ symbol: "X", status: "TRADING", baseAsset: "X", quoteAsset: "USDT", permissions: ["SPOT", "MARGIN"] }), true);
});

test("a Binance-wide outage is reported as temporarily_unavailable, never a hard failure", () => {
  const result = binanceUnavailable(CHECKED_AT, "network error");
  assert.equal(result.binanceStatus, "temporarily_unavailable");
  assert.ok(result.binanceFailureReason.startsWith("BINANCE_UNAVAILABLE"));
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
console.log(`${cases.length - failures}/${cases.length} Phase A Binance checks passed.`);
if (failures > 0) process.exitCode = 1;
