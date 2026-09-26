import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dailyCloses, drawdownSeries, pointsInPeriod, riskProfile, rollingVolatility, RISK_VOLATILITY_WINDOW_DAYS } from "../src/lib/data/historical-series.ts";
import { buildTokenHistory } from "../src/lib/data/live-data.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);

const DAY = 24 * 60 * 60 * 1000;
const TODAY = Date.parse("2026-09-25T00:00:00.000Z");
const asOf = new Date("2026-09-25T06:00:00.000Z");
const iso = (daysAgo, extraMs = 0) => new Date(TODAY - daysAgo * DAY + extraMs).toISOString();
let id = 1;
/** Daily points ending today; values[i] is `values.length − 1 − i` days ago. */
const daily = (values) => values.map((value, i) => ({ timestamp: iso(values.length - 1 - i), valueUsd: value, sourceId: `obs:${id++}` }));
const values = (points) => points.map((p) => p.valueUsd);

test("1. volatility = sample σ of 7 daily log returns × √365 × 100", () => {
  const prices = [100, 102, 99, 101, 105, 103, 104, 108];
  const [v] = rollingVolatility(daily(prices));
  const r = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = r.reduce((a, b) => a + b) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  close(v.valueUsd, sd * Math.sqrt(365) * 100);
  assert.equal(RISK_VOLATILITY_WINDOW_DAYS, 7);
  assert.equal(rollingVolatility(daily(prices.slice(0, 7))).length, 0, "7 closes give only 6 returns: no value");
  assert.equal(values(rollingVolatility(daily([5, 5, 5, 5, 5, 5, 5, 5])))[0], 0, "constant prices → 0% volatility (a genuine zero)");
});

test("2–5. drawdown from the running peak: 0 at a peak, negative below, never positive", () => {
  const dd = drawdownSeries(daily([100, 120, 90, 120, 130, 65]));
  assert.deepEqual(values(dd).map((v) => Math.round(v * 100) / 100), [0, 0, -25, 0, 0, -50]);
  assert.ok(dd.every((p) => p.valueUsd <= 0 && !Object.is(p.valueUsd, -0)));
  const falling = drawdownSeries(daily([10, 9, 8, 7]));
  assert.deepEqual(values(falling).map((v) => Math.round(v * 10) / 10), [0, -10, -20, -30]);
});

test("6. missing, null, zero, negative and non-finite prices are skipped, never zero", () => {
  const points = [
    ...daily([100, 110]),
    { timestamp: iso(0, 3600e3), valueUsd: 0, sourceId: "obs:900" },
    { timestamp: iso(3), valueUsd: Number.NaN, sourceId: "obs:901" },
    { timestamp: iso(4), valueUsd: -5, sourceId: "obs:902" },
  ];
  const closes = dailyCloses(points, asOf);
  assert.deepEqual(values(closes), [100, 110], "invalid prices never become daily closes");
  assert.deepEqual(values(drawdownSeries([{ timestamp: iso(1), valueUsd: 0, sourceId: "x" }, ...daily([50])])), [0], "a zero price is ignored, not a 100% drawdown");
  // Built from stored rows: an unavailable/null price is not a point at all.
  const rows = [
    { id: 1, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: 10, status: "available", observed_at: iso(2), collected_at: iso(2), source_field: "p", note: null },
    { id: 2, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: null, status: "unavailable", observed_at: iso(1), collected_at: iso(1), source_field: "p", note: null },
    { id: 3, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: 8, status: "available", observed_at: iso(0), collected_at: iso(0), source_field: "p", note: null },
  ];
  const profile = riskProfile(buildTokenHistory("t", rows, asOf).priceUsd.points, "7D", asOf);
  assert.deepEqual(values(profile.daily), [10, 8]);
  assert.deepEqual(values(profile.drawdown).map((v) => Math.round(v)), [0, -20]);
});

test("gaps are never bridged: a missing day inside the lookback yields no volatility", () => {
  const points = daily([100, 101, 102, 103, 104, 105, 106, 107, 108]).filter((_, i) => i !== 4);
  assert.equal(rollingVolatility(points).length, 0);
});

test("7. chronological order: drawdown sorts by time; daily closes come from 00:00 UTC samples only", () => {
  const shuffled = daily([100, 80, 120, 60]).reverse();
  assert.deepEqual(values(drawdownSeries(shuffled)).map((v) => Math.round(v * 1e6) / 1e6), [0, -20, 0, -50]);
  const mixed = [...daily([100, 101]), { timestamp: iso(0, 5 * 3600e3), valueUsd: 999, sourceId: "obs:hourly" }];
  assert.deepEqual(values(dailyCloses(mixed, asOf)), [100, 101], "an off-midnight snapshot is not a daily close");
});

test("8. 7D / 30D / 90D windows: drawdown peak restarts per window; volatility may look back before it", () => {
  const prices = Array.from({ length: 90 }, (_, i) => (i < 40 ? 200 - i : 100 + Math.sin(i) * 5 + i * 0.2));
  const points = daily(prices);
  for (const [period, days] of [["7D", 7], ["30D", 30], ["90D", 90]]) {
    const { daily: inWindow, drawdown, volatility } = riskProfile(points, period, asOf);
    assert.equal(inWindow.length, days, period);
    assert.equal(drawdown.length, inWindow.length);
    assert.equal(drawdown[0].valueUsd, 0, `${period} starts at its own peak`);
    assert.ok(volatility.every((p) => pointsInPeriod([p], period, asOf).length === 1), `${period} volatility dates lie inside the window`);
  }
  assert.equal(riskProfile(points, "7D", asOf).volatility.length, 7, "7D volatility uses lookback before the window");
  assert.equal(riskProfile(points, "90D", asOf).volatility.length, 90 - 7, "the first 7 closes of the history have no full lookback");
  assert.equal(riskProfile(points, "24H", asOf).daily.length, 1, "24H has one daily close: the card shows its empty state");
});

test("9. both series are present and independent; the card is wired into Market History", () => {
  const { volatility, drawdown } = riskProfile(daily(Array.from({ length: 30 }, (_, i) => 100 + i * (i % 3 ? 1 : -2))), "30D", asOf);
  assert.ok(volatility.length > 0 && drawdown.length > 0);
  assert.ok(volatility.every((p) => p.valueUsd >= 0) && drawdown.every((p) => p.valueUsd <= 0));
  const chart = readFileSync(new URL("../src/components/HistoricalSection.tsx", import.meta.url), "utf8");
  for (const phrase of [">Risk profile<", "Historical risk profile based on price volatility and drawdown.", "Volatility measures historical price variability; drawdown measures the decline from a prior peak.", "<ReferenceLine y={0}", '(["volatility", "drawdown"] as const)', "RiskTooltip"]) {
    assert.ok(chart.includes(phrase), phrase);
  }
  assert.doesNotMatch(chart, /Risk analysis|risk score|bullish|bearish|volumeToMarketCap|Volume \/ market cap/i);
});

test("10. no database writes: the history and chart code only reads and computes", () => {
  for (const path of ["../src/lib/data/historical-series.ts", "../src/components/HistoricalSection.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.(insert|upsert|update|delete)\(|createSupabase|fetch\(/, path);
  }
});

test("11. Price and Volume · 24h charts are unchanged; Market cap is no longer in Market History", () => {
  const model = readFileSync(new URL("../src/lib/ui/profile-model.ts", import.meta.url), "utf8");
  assert.match(model, /const MARKET_HISTORY: HistoryChartKey\[\] = \["priceUsd", "volumeUsd", "riskProfile"\];/);
  const chart = readFileSync(new URL("../src/components/HistoricalSection.tsx", import.meta.url), "utf8");
  assert.match(chart, /priceUsd: \{ label: "Price", color: "#d0443b" \}/);
  assert.match(chart, /volumeUsd: \{ label: "Volume · 24h", color: "#c9a45c" \}/);
  assert.match(chart, /<strong>\{formatUsd\(value\)\}<\/strong>/, "USD charts keep their tooltip");
  assert.match(chart, /metric === "riskProfile"\n\s+\? <RiskProfileCard/);
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
console.log(`${cases.length - failures}/${cases.length} risk-profile checks passed.`);
if (failures > 0) process.exitCode = 1;
