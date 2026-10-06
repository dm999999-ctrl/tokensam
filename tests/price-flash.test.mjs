import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { detectPriceMoves, PRICE_FLASH_MS } from "../src/lib/ui/price-flash.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const t = (id, priceUsd) => ({ id, priceUsd });

test("a token seen for the first time never flashes", () => {
  // Otherwise every row lights on first paint, and again on every pagination or
  // filter change, which reads as noise rather than as a price moving.
  const seen = new Map();
  assert.deepEqual(detectPriceMoves([t("a", 100), t("b", 50)], seen), {});
  // The baseline is still recorded, so the NEXT move is detected.
  assert.equal(seen.get("a"), 100);
  assert.deepEqual(detectPriceMoves([t("a", 101)], seen), { a: "up" });
});

test("direction follows the price move", () => {
  const seen = new Map([["a", 100], ["b", 100]]);
  assert.deepEqual(detectPriceMoves([t("a", 100.01), t("b", 99.99)], seen), { a: "up", b: "down" });
});

test("an unchanged price does not flash", () => {
  const seen = new Map([["a", 100]]);
  assert.deepEqual(detectPriceMoves([t("a", 100)], seen), {});
});

test("the baseline advances, so a repeatedly moving token flashes each time", () => {
  // Comparing against the first-seen price instead would flash once and then go quiet
  // while the price kept climbing.
  const seen = new Map();
  detectPriceMoves([t("a", 100)], seen);
  assert.deepEqual(detectPriceMoves([t("a", 101)], seen), { a: "up" });
  assert.deepEqual(detectPriceMoves([t("a", 102)], seen), { a: "up" });
  assert.deepEqual(detectPriceMoves([t("a", 101)], seen), { a: "down" });
});

test("an unusable price is ignored and does not disturb the baseline", () => {
  const seen = new Map([["a", 100]]);
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(detectPriceMoves([t("a", bad)], seen), {}, `${bad} must not flash`);
    assert.equal(seen.get("a"), 100, `${bad} must not overwrite the baseline`);
  }
});

test("a token leaving and re-entering the list does not flash on return", () => {
  // Pagination and filtering remove rows from the array; the baseline is held by id,
  // so coming back at the same price is not a move.
  const seen = new Map();
  detectPriceMoves([t("a", 100), t("b", 50)], seen);
  detectPriceMoves([t("b", 50)], seen);            // "a" filtered out
  assert.deepEqual(detectPriceMoves([t("a", 100), t("b", 50)], seen), {}, "quiet on return");
});

// The cell markup has no render harness in this suite (see tests/deep-analysis-panel.test.mjs),
// so these assert the wiring at source level.
const dashboard = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("only the price column flashes", () => {
  assert.match(dashboard, /column\.key === "priceUsd" && flash/, "guarded on the price column");
  // Market cap and FDV also move with the live price; lighting them too would wash the row.
  for (const key of ["marketCapUsd", "fdvUsd", "change24hPct"]) {
    assert.ok(!new RegExp(`column\\.key === "${key}" && flash`).test(dashboard), `${key} must not flash`);
  }
});

test("the flash is defined for both directions and honours reduced motion", () => {
  for (const name of ["price-flash-up", "price-flash-down"]) {
    assert.match(css, new RegExp(`@keyframes ${name}`), `${name} keyframes defined`);
    assert.match(css, new RegExp(`\\.${name} \\{ animation: ${name}`), `${name} class defined`);
  }
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*price-flash-up, \.price-flash-down \{ animation: none/,
    "a decorative flash must be disabled for viewers who ask for reduced motion");
  assert.match(css, /animation: price-flash-up 1\.5s/, "duration matches PRICE_FLASH_MS");
  assert.equal(PRICE_FLASH_MS, 1500, "within the 1-2 second window asked for");
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown"}`); }
}
console.log(`${cases.length - failures}/${cases.length} price-flash checks passed.`);
if (failures > 0) process.exitCode = 1;
