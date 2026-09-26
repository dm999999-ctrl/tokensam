import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { tokenCoverage } from "../src/data/provider-coverage.ts";
import { attachDashboardExtras, buildTokenHistory, latestCalculatedValues } from "../src/lib/data/live-data.ts";
import { logosFromRecords, validatedLogoUrl } from "../src/lib/data/token-logos.ts";
import { formatChange, formatRatio, formatShare, formatUsd, intervalBetween } from "../src/lib/ui/format.ts";
import { metricSection, presentMetric } from "../src/lib/ui/calculated.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { COLUMNS, EMPTY_FILTERS, filterRows, missingReason, researchColumns, sortRows, toRow, universeSummary } from "../src/lib/ui/dashboard-model.ts";
import { reportedFdvFromRecords } from "../src/lib/data/token-logos.ts";
import { datasetLabel, namesProvider, plainLanguage } from "../src/lib/ui/data-language.ts";
import { buildDatasetFreshness } from "../src/lib/refresh/freshness.ts";
import { latestPerMetric } from "../src/lib/data/observation-reads.ts";
import { sevenDayVolume, sevenDayVolumeBands } from "../src/lib/data/seven-day-volume.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-25T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const byId = (id) => canonicalTokens.find((token) => token.id === id);

function metric(overrides) {
  return {
    id: "price_growth_pct", name: "Price growth", category: "growth", unit: "percent", value: 1.5, status: "available",
    formula: "f", calculatedAt: NOW.toISOString(), periodStartAt: hoursAgo(1), periodEndAt: NOW.toISOString(),
    unavailableReason: null, sourceScopes: "token", ...overrides,
  };
}

function dashboardToken(id, overrides = {}) {
  const token = byId(id);
  return {
    id, name: token.name, symbol: token.symbol, chain: token.chainName, category: token.category,
    priceUsd: 1, change24hPct: 1, change7dPct: 1, marketCapUsd: 100, volume24hUsd: 10,
    tvlUsd: null, tvlChange30dPct: null, fees24hUsd: null, revenue24hUsd: null, observedAt: NOW.toISOString(), metricSources: {},
    ...overrides,
  };
}

function profileData(id, overrides = {}) {
  const token = byId(id);
  return {
    token: dashboardToken(id),
    description: null,
    contractAddress: token.contractAddress,
    isNative: token.isNative,
    circulatingSupply: 10, totalSupply: 20, maximumSupply: null,
    metricSources: {},
    calculatedMetrics: [],
    history: buildTokenHistory(id, [], NOW, { defiLlamaMapped: false }),
    dataNotes: [],
    dexMapped: false,
    defiLlamaMapped: false,
    datasetFreshness: [],
    coverage: tokenCoverage(token),
    tokenLevelPrice: null,
    logoUrl: null,
    protocol: null,
    dexActivity: { transactions24h: null, buys24h: null, sells24h: null },
    ...overrides,
  };
}

// ---- Formatting: zero is valid, missing is null, ratios and shares are not changes ----

test("1. formatters keep a legitimate zero and never turn a missing value into zero", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(null), null);
  assert.equal(formatRatio(0.0226), "0.0226×");
  assert.equal(formatShare(0.23), "0.23%", "a share carries no sign");
  assert.deepEqual(formatChange(0), { text: "0.00%", tone: "flat" });
  assert.equal(formatChange(undefined), null);
});

test("2. ratio and share metrics render neutrally; growth shows its interval and short intervals stay neutral", () => {
  const share = presentMetric(metric({ id: "dex_aggregate_liquidity_to_market_cap_pct", category: "market_structure", unit: "percent", value: 0.23, sourceScopes: "market/token" }));
  assert.equal(share.value, "0.23%");
  assert.equal(share.tone, "neutral");
  const ratio = presentMetric(metric({ id: "volume_to_market_cap", category: "valuation", unit: "ratio", value: 0.13 }));
  assert.equal(ratio.value, "0.13×");
  assert.equal(ratio.tone, "neutral");
  const snapshot = presentMetric(metric({ value: 0.54, periodStartAt: hoursAgo(0.45) }));
  assert.equal(snapshot.interval.isShort, true);
  assert.equal(snapshot.tone, "neutral", "a 27-minute change is not presented as a trend");
  assert.match(snapshot.interval.label, /over 27 minutes/);
  const trend = presentMetric(metric({ value: -3, periodStartAt: hoursAgo(72) }));
  assert.equal(trend.tone, "negative");
  assert.equal(presentMetric(metric({ status: "unavailable", value: null })), null, "an unavailable metric is hidden");
  assert.equal(presentMetric(metric({ id: "divergence_price_up_tvl_down", category: "divergence", unit: "boolean", value: 0 })).value, "Not observed", "a zero flag is a valid value");
  assert.equal(intervalBetween(null, NOW.toISOString()), null);
});

test("3. calculated metrics are placed by scope, never in the wrong section", () => {
  assert.equal(metricSection(metric({ id: "market_cap_to_tvl", sourceScopes: "token/protocol" })), "fundamentals");
  assert.equal(metricSection(metric({ id: "fdv_to_tvl", sourceScopes: "market/protocol" })), "fundamentals");
  assert.equal(metricSection(metric({ id: "dex_liquidity_to_market_cap_pct", category: "market_structure", sourceScopes: "market/token" })), "marketStructure");
  assert.equal(metricSection(metric({ id: "volume_to_market_cap", sourceScopes: "token" })), "market");
  assert.equal(metricSection(metric({ id: "tvl_growth_pct", sourceScopes: null })), "fundamentals", "without stored scopes, protocol inputs still route to Fundamentals");
});

// ---- Token Profile model ----

test("4. native assets (BTC/ETH/BNB): one explanation per unavailable section and no wrapped substitution", () => {
  for (const id of ["bitcoin-btc", "ethereum-eth", "bnb-bnb"]) {
    const model = buildProfileModel(profileData(id));
    assert.equal(model.fundamentals.available, false);
    assert.match(model.fundamentals.note.reason, /Chain-level TVL is not attributed to the token/);
    assert.equal(model.marketStructure.available, false);
    assert.match(model.marketStructure.note.reason, /wrapped assets are not substituted/);
    assert.ok(!model.sections.some((section) => section.id === "fundamentals" || section.id === "market-structure"), "unavailable sections are not in the nav");
    assert.equal("notComputed" in model.methodology, false, "no visible list of metrics that could not be computed");
  }
});

test("5. missing values are hidden (max supply is never labelled uncapped); zero values stay", () => {
  const model = buildProfileModel(profileData("bitcoin-btc", { maximumSupply: null, circulatingSupply: 0 }));
  assert.deepEqual(model.tokenomics.items.map((item) => item.id), ["circulating_supply", "total_supply"]);
  assert.equal(model.tokenomics.items[0].value, "0 BTC");
  assert.equal(model.tokenomics.circulatingOfMaxPct, null);
  assert.ok(!JSON.stringify(model).toLowerCase().includes("uncapped"));
});

test("6. protocol data appears only under Fundamentals; DEX data only under Market structure", () => {
  const aave = byId("aave-aave");
  const model = buildProfileModel(profileData("aave-aave", {
    token: dashboardToken("aave-aave", { tvlUsd: 1.9e10, fees24hUsd: 1.2e6, revenue24hUsd: 0 }),
    protocol: { name: "Aave", aggregatesVersions: true },
    contractAddress: aave.contractAddress,
    dexActivity: { transactions24h: 1169, buys24h: 613, sells24h: 556 },
    calculatedMetrics: [
      metric({ id: "volume_to_market_cap", category: "valuation", unit: "ratio", value: 0.13, sourceScopes: "token" }),
      metric({ id: "market_cap_to_tvl", category: "valuation", unit: "ratio", value: 0.116, sourceScopes: "token/protocol" }),
      metric({ id: "dex_aggregate_liquidity_usd", category: "market_structure", unit: "USD", value: 5.24e6, sourceScopes: "market" }),
      metric({ id: "dex_primary_pair_liquidity_usd", category: "market_structure", unit: "USD", value: 5.24e6, sourceScopes: "market" }),
    ],
  }));
  assert.deepEqual(model.snapshot.cards.map((item) => item.id), ["market_cap", "volume_24h", "volume_to_market_cap"]);
  assert.ok(model.fundamentals.available);
  assert.equal(model.fundamentals.protocolName, "Aave");
  assert.deepEqual(model.fundamentals.valuation.map((item) => item.id), ["market_cap_to_tvl"]);
  assert.equal(model.fundamentals.primary.find((item) => item.id === "revenue_24h").value, "$0", "reported zero revenue is shown");
  assert.ok(model.marketStructure.available);
  const dexIds = model.marketStructure.cards.map((item) => item.id);
  assert.ok(dexIds.includes("dex_aggregate_liquidity_usd") && dexIds.includes("transactions_24h"));
  assert.ok(!dexIds.includes("dex_primary_pair_liquidity_usd"), "a primary pair equal to the aggregate adds nothing and is hidden");
  assert.ok(!model.snapshot.cards.some((item) => item.id.startsWith("dex_") || item.id === "market_cap_to_tvl"));
});

test("7. technical identifiers only in methodology, and no internal database IDs anywhere", () => {
  const model = buildProfileModel(profileData("aave-aave", { protocol: { name: "Aave", aggregatesVersions: true } }));
  const serialized = JSON.stringify({ ...model, methodology: { ...model.methodology, identifiers: [] } });
  assert.ok(!serialized.includes("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDAe9"), "full identifiers stay inside Technical identifiers");
  assert.ok(model.methodology.identifiers.some((item) => item.value.includes("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDAe9")));
  assert.ok(!/mapping_id|raw_record_id|provider_asset_id/.test(JSON.stringify(model)));
});

// ---- Logos, dashboard extras, history ----

test("8. logos are accepted only for the curated CoinGecko ID and CoinGecko's image CDN", () => {
  const url = "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400";
  assert.equal(validatedLogoUrl("bitcoin-btc", "bitcoin", url), url);
  assert.equal(validatedLogoUrl("bitcoin-btc", "wrapped-bitcoin", url), null, "a different CoinGecko asset's logo is rejected");
  assert.equal(validatedLogoUrl("bitcoin-btc", "bitcoin", "https://example.com/btc.png"), null);
  assert.equal(validatedLogoUrl("bitcoin-btc", "bitcoin", "http://coin-images.coingecko.com/x.png"), null);
  const logos = logosFromRecords([
    { token_id: "bitcoin-btc", collected_at: hoursAgo(0), endpoint_label: "GET /coins/{id}/market_chart", image: null, payload_id: null },
    { token_id: "bitcoin-btc", collected_at: hoursAgo(1), endpoint_label: "GET /coins/markets", image: url, payload_id: "bitcoin" },
  ]);
  assert.equal(logos["bitcoin-btc"], url, "a newer history-backfill record without an image does not hide the markets logo");
});

test("9. dashboard calculated values: latest per metric, unavailable stays null, unmapped scopes are dropped", () => {
  const rows = [
    { id: 1, token_id: "aave-aave", metric_id: "market_cap_to_tvl", value: "0.2", status: "available", calculated_at: hoursAgo(2) },
    { id: 2, token_id: "aave-aave", metric_id: "market_cap_to_tvl", value: "0.116", status: "available", calculated_at: hoursAgo(1) },
    { id: 3, token_id: "aave-aave", metric_id: "dex_buy_sell_ratio", value: null, status: "unavailable", calculated_at: hoursAgo(1) },
    { id: 4, token_id: "aave-aave", metric_id: "volume_to_market_cap", value: "0", status: "available", calculated_at: hoursAgo(1) },
    // A stale market-scope value for a native asset must never surface.
    { id: 5, token_id: "ethereum-eth", metric_id: "dex_aggregate_liquidity_usd", value: "5000000", status: "available", calculated_at: hoursAgo(1) },
  ];
  const calculated = latestCalculatedValues(rows);
  assert.equal(calculated.get("aave-aave").market_cap_to_tvl, 0.116);
  assert.equal(calculated.get("aave-aave").dex_buy_sell_ratio, null);
  assert.equal(calculated.get("aave-aave").volume_to_market_cap, 0);
  const [aave, eth] = attachDashboardExtras([dashboardToken("aave-aave", { tvlUsd: 1.9e10 }), dashboardToken("ethereum-eth")], { logos: {}, calculated });
  assert.equal(aave.coverage.hasProtocolData, true);
  assert.equal(eth.calculated.dex_aggregate_liquidity_usd, null, "no wrapped-proxy DEX value for native ETH");
  assert.equal(eth.coverage.hasDexData, false);
  assert.equal(eth.logoUrl, null);
});

test("10. dashboard columns: hidden only when no displayed row has data; recomputed after filtering", () => {
  const tokens = attachDashboardExtras([
    dashboardToken("aave-aave", { tvlUsd: 1 }),
    dashboardToken("bitcoin-btc"),
  ], { logos: {}, calculated: new Map(), fdv: { "aave-aave": { value: 0, collectedAt: NOW.toISOString() } } });
  const rows = tokens.map(toRow);
  const all = researchColumns(rows);
  assert.ok(all.visible.some((column) => column.key === "fdvUsd"), "a zero FDV keeps the column");
  const btcOnly = researchColumns(filterRows(rows, { ...EMPTY_FILTERS, query: "bitcoin" }));
  assert.ok(!btcOnly.visible.some((column) => column.key === "fdvUsd"), "no displayed row has FDV, so the column hides");
  assert.equal(filterRows(rows, { ...EMPTY_FILTERS, coverage: "protocol" }).length, 1);
  assert.equal(missingReason(COLUMNS.find((column) => column.key === "fdvUsd"), tokens[1]), "Not reported for this token");
  const summary = universeSummary(tokens);
  assert.deepEqual([summary.assets, summary.protocol, summary.dex], [2, 1, 0]);
});

test("11. market-cap history is a token-scope CoinGecko series of stored observations only", () => {
  const row = (id, hours, value, status = "available") => ({
    id, token_id: "aave-aave", chain_id: "ethereum", metric_id: "market_cap_usd", provider_id: "coingecko", value, status,
    observed_at: hoursAgo(hours), collected_at: hoursAgo(hours), source_field: null, note: null,
  });
  const history = buildTokenHistory("aave-aave", [row(1, 48, "2.1e9"), row(2, 24, null, "unavailable"), row(3, 1, "2.2e9")], NOW, { defiLlamaMapped: true });
  assert.equal(history.marketCapUsd.scope, "token");
  assert.equal(history.marketCapUsd.providerId, "coingecko");
  assert.deepEqual(history.marketCapUsd.points.map((point) => point.valueUsd), [2.1e9, 2.2e9], "the unavailable row is not plotted or zero-filled");
});

test("12. provider names appear only in the data provenance disclosure; scope wording stays", () => {
  const withStoredText = [
    metric({ id: "market_cap_to_tvl", category: "valuation", unit: "ratio", value: 0.8, sourceScopes: "token/protocol", formula: "CoinGecko market_cap_usd / DeFiLlama protocol tvl_usd" }),
    metric({ id: "fdv_to_tvl", category: "valuation", unit: "ratio", value: null, status: "unavailable", sourceScopes: "market/protocol", formula: "f", unavailableReason: "Required input unavailable: DEX Screener FDV." }),
    metric({ id: "fees_growth_pct", category: "growth", unit: "percent", value: null, status: "unavailable", sourceScopes: "protocol", formula: "f", unavailableReason: "Insufficient history for DeFiLlama protocol fees; at least two distinct available observation times are required." }),
  ];
  const models = [
    buildProfileModel(profileData("aave-aave", { protocol: { name: "Aave", aggregatesVersions: true }, calculatedMetrics: withStoredText, token: dashboardToken("aave-aave", { tvlUsd: 2e10 }), dataNotes: ["Protocol-level DeFiLlama metric associated by explicit project mapping."] })),
    buildProfileModel(profileData("bitcoin-btc")),
    buildProfileModel(profileData("stellar-xlm")),
  ];
  for (const model of models) {
    const { provenance, ...methodology } = model.methodology;
    const visible = JSON.stringify({ ...model, methodology });
    assert.equal(namesProvider(visible), false, `no provider name outside data provenance: ${visible.match(/.{40}(coingecko|defillama|dex ?screener).{40}/i)?.[0]}`);
    assert.ok(provenance.datasets.some((item) => item.provider === "CoinGecko") && provenance.datasets.some((item) => item.provider === "DEX Screener"), "providers remain disclosed under data provenance");
    assert.ok(!model.methodology.identifiers.some((item) => /^(bitcoin|aave|coingecko:|ethereum:)/.test(item.value)), "no provider-specific IDs or slugs");
  }
  const [aave, btc] = models;
  assert.equal(aave.fundamentals.primary.find((item) => item.id === "tvl").note, "Associated protocol", "TVL is never presented as token TVL");
  assert.match(aave.fundamentals.scopeLine, /associated protocol, not the token/);
  assert.equal(aave.methodology.formulas[0].formula, "token market_cap_usd / associated-protocol tvl_usd");
  assert.equal("notComputed" in aave.methodology, false, "unavailable metrics are not listed in the UI model");
  assert.deepEqual(aave.methodology.formulas.map((item) => item.label).length, 1, "only computed metrics get a formula");
  assert.equal(aave.methodology.protocolName, "Aave", "the protocol-scope reminder names the associated protocol");
  assert.deepEqual(aave.methodology.provenance.notes, ["Protocol-level DeFiLlama metric associated by explicit project mapping."], "raw collection notes stay intact in the model (kept for audit, not rendered)");
  assert.match(btc.marketStructure.note.reason, /No canonical token market is currently available/);
  assert.equal(plainLanguage("latest CoinGecko price / previous CoinGecko price"), "latest token price / previous token price");

  const tokens = [dashboardToken("aave-aave", { coverage: { protocolMapped: true, dexMapped: true, isNative: false } }), dashboardToken("bitcoin-btc", { coverage: { protocolMapped: false, dexMapped: false, isNative: true } })];
  for (const column of COLUMNS) {
    for (const token of tokens) assert.equal(namesProvider(`${column.label} ${column.hint ?? ""} ${missingReason(column, token)}`), false);
  }
  assert.equal(datasetLabel("dexscreener", "DEX Screener"), "DEX market data");
  assert.equal(datasetLabel("defillama", "DeFiLlama"), "Protocol data");
});

test("12b. per-token dataset freshness: own latest collection, backfill ignored, provider thresholds, relevant datasets only", () => {
  const row = (provider_id, collectedHours, observedHours, status = "available") => ({ provider_id, status, collected_at: hoursAgo(collectedHours), observed_at: hoursAgo(observedHours) });
  const datasets = buildDatasetFreshness({
    rows: [
      row("coingecko", 0.1, 0.15),
      row("coingecko", 0.1, 0.12),
      row("defillama", 4, 4),
      row("defillama_coins", 3.5, 3.6),
      row("dexscreener", 0.1, 0.1, "unavailable"),
    ],
    relevant: ["coingecko", "defillama", "defillama_coins", "dexscreener"],
    calculatedAt: hoursAgo(0.05),
    now: NOW,
  });
  assert.deepEqual(datasets.map((item) => [item.label, item.ageLabel, item.state]), [
    ["CoinGecko", "6 min ago", "current"],
    ["DeFiLlama", "4 hr ago", "current"],
    ["DeFiLlama (token prices)", "3 hr ago", "stale"],
    ["Calculated metrics", "3 min ago", null],
  ], "DEX with only unavailable values is omitted; protocol data uses its 24 h threshold; metrics have no threshold label");
  assert.equal(datasets[0].observedAt, hoursAgo(0.12), "observation time stays distinct from collection time");
  assert.equal(buildDatasetFreshness({ rows: [row("defillama", 1, 1)], relevant: ["coingecko"], calculatedAt: null, now: NOW }).length, 0, "irrelevant datasets are not shown");

  // Backfilled history is collected later but is older data: the latest row per metric decides freshness.
  const obs = (id, observedHours, collectedHours) => ({ id, token_id: "aave-aave", provider_id: "coingecko", metric_id: "price_usd", status: "available", observed_at: hoursAgo(observedHours), collected_at: hoursAgo(collectedHours) });
  const latest = latestPerMetric([obs(1, 5, 5), obs(2, 48, 0.02)]);
  assert.equal(buildDatasetFreshness({ rows: latest, relevant: ["coingecko"], calculatedAt: null, now: NOW })[0].ageLabel, "5 hr ago");

  const model = buildProfileModel(profileData("bitcoin-btc", { datasetFreshness: [
    { id: "coingecko", label: "CoinGecko", collectedAt: hoursAgo(0.1), observedAt: hoursAgo(0.1), ageLabel: "6 min ago", state: "current" },
    { id: "dexscreener", label: "DEX Screener", collectedAt: hoursAgo(0.1), observedAt: hoursAgo(0.1), ageLabel: "6 min ago", state: "current" },
  ] }));
  assert.deepEqual(model.methodology.freshness.map((item) => item.label), ["Market data"], "a dataset whose section is not shown for this token is not listed");
});

test("13. market-only Research Universe: no protocol or DEX columns; FDV and supply from stored market data", () => {
  assert.deepEqual(COLUMNS.map((column) => column.key), ["priceUsd", "change24hPct", "change7dPct", "marketCapUsd", "fdvUsd", "volume24hUsd", "volumeToMarketCap", "volume7dUsd"]);
  assert.equal(COLUMNS.at(-1).label, "7D Volume");
  assert.equal(COLUMNS.at(-1).format, "usd-compact");
  const tokens = attachDashboardExtras([
    dashboardToken("aave-aave", { tvlUsd: 1.9e10, fees24hUsd: 1.2e6, circulatingSupply: 15.43e6, maximumSupply: 16e6 }),
    dashboardToken("ethereum-eth", { circulatingSupply: 122e6, maximumSupply: null }),
    dashboardToken("bitcoin-btc", { marketCapUsd: 1.7e12, circulatingSupply: 20.09e6, maximumSupply: 21e6 }),
  ], { logos: {}, calculated: new Map([["aave-aave", { dex_aggregate_liquidity_usd: 5.2e6 }]]), fdv: { "aave-aave": { value: 2.33e9, collectedAt: NOW.toISOString() } }, volume7d: { "aave-aave": 4.35e9, "bitcoin-btc": 248.6e9 } });
  const rows = tokens.map(toRow);
  for (const row of rows) {
    assert.ok(!Object.keys(row).some((key) => /tvl|fees|revenue|dex/i.test(key)), "no fundamentals or market-structure field reaches a dashboard row");
  }
  assert.equal(rows.length, 3, "every token stays in the table");
  const [aave, eth, btc] = rows;
  assert.equal(aave.fdvUsd, 2.33e9);
  assert.equal(btc.fdvUsd, null, "no reported FDV is unavailable, never zero or derived");
  assert.equal(aave.volume7dUsd, 4.35e9);
  assert.equal(eth.volume7dUsd, null, "no 7D history: unavailable, never zero or 24H x 7");
  assert.equal(formatUsd(btc.volume7dUsd, true), "$248.6B");
  assert.equal(missingReason(COLUMNS.find((column) => column.key === "volume7dUsd"), eth.token), "Not enough stored 24-hour volume history to cover the latest 7 days");
  assert.equal(missingReason(COLUMNS.find((column) => column.key === "volume7dUsd"), { ...eth.token, volume24hUsd: null }), "No 24-hour volume is reported for this token");
  assert.deepEqual(sortRows(rows, "volume7dUsd", "desc").map((row) => row.token.id), ["bitcoin-btc", "aave-aave", "ethereum-eth"], "rows without 7D volume sort last");
  assert.ok(!("circulatingToMaxPct" in aave), "Circ. / max is no longer a dashboard column");
  assert.equal(sortRows(rows, "fdvUsd", "desc").at(-1).token.id !== "aave-aave", true, "rows without FDV sort after rows with it");

  // FDV comes only from the stored market-data record whose own ID matches the curated ID (same guard as logos).
  const record = (overrides) => ({ token_id: "aave-aave", endpoint_label: "GET /coins/markets", payload_id: "aave", fdv: 2.3e9, collected_at: NOW.toISOString(), ...overrides });
  assert.deepEqual(Object.keys(reportedFdvFromRecords([record()])), ["aave-aave"]);
  assert.deepEqual(reportedFdvFromRecords([record({ payload_id: "aave-token-wrapped" })]), {}, "another asset's record is never used");
  assert.deepEqual(reportedFdvFromRecords([record({ endpoint_label: "GET /coins/{id}/market_chart" })]), {}, "only market-data snapshots carry FDV");
  assert.deepEqual(reportedFdvFromRecords([record({ fdv: null })]), {});
  assert.equal(reportedFdvFromRecords([record({ fdv: "2.3e9" })])["aave-aave"].value, 2.3e9);

});

test("14. 7D volume sums seven non-overlapping 24-hour observations; gaps and invalid values make it unavailable", () => {
  const H = 3_600_000;
  const at = (hoursBefore) => new Date(NOW.getTime() - hoursBefore * H).toISOString();
  const point = (hoursBefore, value, status = "available") => ({ observed_at: at(hoursBefore), value, status });
  // Hourly rolling-24h points for 8 days, each worth 100; daily boundaries hold 1000 + day index.
  const hourly = [];
  for (let h = 0; h <= 8 * 24; h += 1) hourly.push(point(h, h % 24 === 0 ? 1000 + h / 24 : 100));
  const full = sevenDayVolume(hourly);
  assert.equal(full.valueUsd, 1000 + 1001 + 1002 + 1003 + 1004 + 1005 + 1006, "only the seven 24-hour-spaced observations are summed, not every rolling point");
  assert.equal(full.anchorAt, NOW.toISOString());
  assert.notEqual(full.valueUsd, 1000 * 7, "never 24H x 7");

  // Nearest point within ±60 minutes is used for each window; farther points are not.
  assert.equal(sevenDayVolume([0, 24.5, 48, 72, 96, 120, 144].map((h, i) => point(h, 10 + i))).valueUsd, 10 + 11 + 12 + 13 + 14 + 15 + 16);
  assert.equal(sevenDayVolume([0, 25.5, 48, 72, 96, 120, 144].map((h) => point(h, 10))), null, "a window with no observation within 60 minutes makes 7D unavailable");

  // Missing / invalid observations are never treated as zero.
  const withGap = hourly.filter((p) => p.observed_at !== at(72) && p.observed_at !== at(71) && p.observed_at !== at(73));
  assert.equal(sevenDayVolume(withGap), null);
  const invalid = hourly.map((p) => p.observed_at === at(96) ? { ...p, value: null, status: "unavailable" } : p);
  assert.equal(sevenDayVolume(invalid).valueUsd, full.valueUsd - 1004 + 100, "an invalid boundary point is skipped for the nearest valid one within tolerance");
  assert.equal(sevenDayVolume([point(0, "abc"), point(24, -5)]), null);
  assert.equal(sevenDayVolume([]), null);
  assert.equal(sevenDayVolume([point(0, 0), point(24, 0), point(48, 0), point(72, 0), point(96, 0), point(120, 0), point(144, 0)]).valueUsd, 0, "reported zeros are valid");

  // Read bands: one group per anchor hour, seven narrow windows each.
  const bands = sevenDayVolumeBands([{ tokenId: "a", observedAt: at(0) }, { tokenId: "b", observedAt: new Date(NOW.getTime() + 60_000).toISOString() }, { tokenId: "c", observedAt: at(50) }]);
  assert.equal(bands.length, 14);
  assert.deepEqual(bands[0].tokenIds, ["a", "b"]);
  assert.equal(Date.parse(bands[6].from), NOW.getTime() - 6 * 24 * H - H);
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
console.log(`${cases.length - failures}/${cases.length} UI presentation checks passed.`);
if (failures > 0) process.exitCode = 1;
