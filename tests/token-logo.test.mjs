// Regression test for the token-logo rendering fix: a validated remote
// CoinGecko logo URL (e.g. Immutable/IMX) must render as the actual image,
// never fall back to the monogram, and the component must not strip the
// Referer header on the request (the confirmed cause of some validated
// logos silently failing to load from CoinGecko's CDN).
//
// This repo's test runner has no TSX/JSX loader (importing a .tsx file
// throws "Unknown file extension"), so — consistent with movers.test.mjs's
// `source()` pattern — component behavior is verified against the compiled
// source text rather than by rendering the component.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validatedLogoUrl } from "../src/lib/data/token-logos.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const IMX_URL = "https://coin-images.coingecko.com/coins/images/17233/large/immutableX-symbol-BLK-RGB.png?1696516787";

test("1. the confirmed IMX record validates to a non-null logo URL (data path is sound)", () => {
  const url = validatedLogoUrl("ethereum-imx", "immutable-x", IMX_URL);
  assert.equal(url, IMX_URL);
});

test("2. TokenLogo no longer strips the Referer header on the remote image request", () => {
  const component = source("src/components/TokenLogo.tsx");
  assert.doesNotMatch(component, /referrerPolicy=/, "the referrerPolicy attribute must be removed from <Image>: it caused validated logos (e.g. IMX) to fail loading from CoinGecko's CDN");
});

test("3. TokenLogo still renders the remote image unoptimized (no Next.js image-optimization proxy)", () => {
  const component = source("src/components/TokenLogo.tsx");
  assert.match(component, /<Image\b/, "still uses next/image");
  assert.match(component, /\bunoptimized\b/, "must stay unoptimized so the browser fetches the CDN URL directly");
});

test("4. TokenLogo's fallback conditions are unchanged: only a missing src or a load failure shows the monogram", () => {
  const component = source("src/components/TokenLogo.tsx");
  // A valid src must not immediately trigger the fallback branch.
  assert.match(component, /if \(!src \|\| failed\)/, "fallback must only trigger on a missing src or a genuine load failure, not on a valid src");
  assert.match(component, /token-logo-fallback/, "monogram fallback markup must still exist");
  assert.match(component, /onError=\{\(\) => setFailed\(true\)\}/, "a failed remote load must still fall back to the monogram, never a broken-image icon");
  assert.match(component, /naturalWidth === 0/, "pre-hydration image failures must still be detected on mount");
});

test("5. every consumer passes the validated logoUrl straight through to TokenLogo (no ad hoc URL construction)", () => {
  for (const path of ["src/components/Dashboard.tsx", "src/components/SidebarMovers.tsx", "src/components/TokenProfile.tsx", "src/components/AppShell.tsx"]) {
    const component = source(path);
    assert.match(component, /<TokenLogo\s/, `${path} should render the shared TokenLogo component`);
    assert.doesNotMatch(component, /TokenLogo[\s\S]{0,120}src=\{`/, `${path} must not construct a logo URL from a template (symbol, contract address, etc.)`);
  }
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
console.log(`${cases.length - failures}/${cases.length} token-logo checks passed.`);
if (failures > 0) process.exitCode = 1;
