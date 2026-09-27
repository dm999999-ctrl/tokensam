import assert from "node:assert/strict";

import { resolveLogo } from "../src/lib/universe/logo.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const CHECKED_AT = "2026-09-29T00:00:00.000Z";

test("a trusted CoinGecko CDN image is accepted as the logo without a live fetch", async () => {
  let fetchCalled = false;
  const result = await resolveLogo({
    coinGeckoImageUrl: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png",
    checkedAt: CHECKED_AT,
    fetchImpl: async () => { fetchCalled = true; return new Response("", { status: 200 }); },
  });
  assert.equal(result.logoStatus, "pass");
  assert.equal(result.logoSource, "coingecko");
  assert.equal(result.logoVerified, true);
  assert.equal(fetchCalled, false, "a trusted CDN host is not re-fetched");
});

test("an untrusted host image URL is rejected as the CoinGecko source and falls through", async () => {
  const result = await resolveLogo({
    coinGeckoImageUrl: "https://evil.example.com/fake.png",
    checkedAt: CHECKED_AT,
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  assert.notEqual(result.logoSource, "coingecko");
});

test("a reachable existing (fallback) logo URL passes after live verification", async () => {
  const result = await resolveLogo({
    coinGeckoImageUrl: null,
    existingLogoUrl: "https://static.example.com/logo.png",
    checkedAt: CHECKED_AT,
    fetchImpl: async () => new Response("", { status: 200, headers: { "content-type": "image/png" } }),
  });
  assert.equal(result.logoStatus, "pass");
  assert.equal(result.logoSource, "existing");
  assert.equal(result.logoVerified, true);
});

test("a broken existing logo URL (404) is rejected, not silently kept", async () => {
  const result = await resolveLogo({
    coinGeckoImageUrl: null,
    existingLogoUrl: "https://static.example.com/missing.png",
    checkedAt: CHECKED_AT,
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal(result.logoStatus, "fail");
  assert.equal(result.logoUrl, null);
  assert.equal(result.logoFailureReason, "LOGO_UNAVAILABLE");
});

test("a temporary network failure keeps the existing logo, marked temporarily_unavailable, not deleted", async () => {
  const result = await resolveLogo({
    coinGeckoImageUrl: null,
    existingLogoUrl: "https://static.example.com/logo.png",
    checkedAt: CHECKED_AT,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(result.logoStatus, "temporarily_unavailable");
  assert.equal(result.logoUrl, "https://static.example.com/logo.png");
  assert.equal(result.logoVerified, false);
});

test("no CoinGecko image, no Binance logo, no existing logo: unavailable", async () => {
  const result = await resolveLogo({ coinGeckoImageUrl: null, existingLogoUrl: null, checkedAt: CHECKED_AT, fetchImpl: async () => new Response("", { status: 200 }) });
  assert.equal(result.logoStatus, "fail");
  assert.equal(result.logoSource, "unavailable");
  assert.equal(result.logoFailureReason, "LOGO_UNAVAILABLE");
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
console.log(`${cases.length - failures}/${cases.length} Phase A logo checks passed.`);
if (failures > 0) process.exitCode = 1;
