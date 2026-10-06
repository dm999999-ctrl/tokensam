# Binance adapter (live price)

Binance is the **preferred source of the live price and 24-hour price change**. CoinGecko remains the fallback for those two values, and stays the sole source of everything else. The collector runs inside the existing `/api/cron/refresh` orchestration as the `binance` provider step; it needs no API key and no written permission gate.

This adapter is deliberately narrow. It replaces CoinGecko *for the live price*, not as the market-data provider.

## Why Binance for the live price

CoinGecko's `/coins/markets` is a cross-venue aggregate refreshed on a 15-minute cadence here (bounded by the Demo plan's ~10,000 calls/month — see `REFRESH_POLICY`'s quota notes in `src/lib/refresh/config.ts`). Binance publishes a venue's own last trade, costs no quota worth budgeting, and so refreshes every 5 minutes. For a price shown as "live", a 5-minute-old exchange trade beats a 15-minute-old aggregate.

## What Binance supplies, and what it must not

| Metric | Source | Why |
| --- | --- | --- |
| `price_usd` | **Binance** `lastPrice`, CoinGecko fallback | The live number |
| `price_change_24h_pct` | **Binance** `priceChangePercent`, CoinGecko fallback | Comes from the same ticker as the price, so the two agree |
| `volume_24h_usd` | CoinGecko only | Binance's `quoteVolume` is **one venue's** 24-hour volume. CoinGecko's `total_volume` is cross-venue. Substituting one for the other would make the stored series incomparable with its own history |
| `market_cap_usd`, supply, `price_change_7d_pct` | CoinGecko only | Binance does not publish them |
| All chart/history series | CoinGecko only | See "History and retention" |

The collector writes **only** the first two metrics. This is asserted in `tests/binance.test.mjs`, both at the normalization layer and at the read layer.

## Official API reference

Verified live on 2026-10-06:

- Endpoint: `GET /api/v3/ticker/24hr`, multi-symbol form, which takes `symbols` as a **JSON array literal** (`["BTCUSDT","ETHUSDT"]`), not a comma-separated list.
- No API key, authentication, or account is required for market-data endpoints.
- Request weight is tiered by symbol count (2 for ≤20 symbols, 40 for ≤100, 80 above) against a published **6,000 request-weight per minute per IP**. The whole mapped universe costs 80 per run; the collector batches at 100 symbols, so a run is two requests at weight 40 each. At the 5-minute cadence that is ~960 weight/hour against a 360,000/hour budget — roughly 0.3%.
- `429` carries `Retry-After` and is honored; `418` (IP auto-ban after repeated 429s) is treated the same way. Both are retried up to three attempts total.

### Host choice: the geo-restriction

**`api.binance.com` cannot be used from this deployment.** It answers `HTTP 451` ("Service unavailable from a restricted location") to US-originating requests, which includes Vercel's functions. No API key changes this. Tested on 2026-10-06 from this project's egress:

| Host | Result |
| --- | --- |
| `api.binance.com` | 451 |
| `api1.binance.com` | 451 |
| `api-gcp.binance.com` | 451 |
| **`data-api.binance.vision`** | **200** |
| `api.binance.us` | 200 (different listing set — not used) |

The adapter therefore defaults to **`https://data-api.binance.vision/api/v3`**, Binance's official public market-data mirror. It serves the identical `/api/v3` market-data endpoints, requires no key, and is not geo-restricted. `api.binance.us` is a separate exchange with its own, much smaller listing set and its own prices, so it is not used as an equivalent.

Set `BINANCE_API_BASE_URL` to override the host — for example to route through a proxy, as `COINGECKO_PROXY_URL` already does for CoinGecko. A `451` from whatever host is configured fails immediately with that instruction rather than consuming retries, since a geo block is not transient.

## Identity policy

A Binance symbol **is a ticker pair**, which collides with this project's rule that identity is never a ticker. Two deliberate consequences:

1. `src/data/binance-token-mappings.ts` is a **curated table**, generated against Binance's own `GET /api/v3/exchangeInfo?permissions=SPOT` on 2026-10-06 and kept only where the symbol's `status` was `TRADING` and `isSpotTradingAllowed` was true. It is never derived at runtime by concatenating `symbol + "USDT"`. `tests/binance.test.mjs` asserts no two canonical tokens share a Binance symbol, so a future token addition cannot silently make one token adopt another's price.
2. For a canonical token that is one chain's deployment of a multi-chain asset (`ethereum-usdc`, say), Binance prices the **fungible asset**, not that deployment. Prices are arbitraged across deployments, so this is acceptable for a live price and is stated in every observation's note. It is not acceptable for supply or market cap, which is why this provider writes neither.

All mapped symbols are USDT-quoted. **USDT is a USD proxy, not USD.** The stored metric keeps the `price_usd` id so it is a drop-in for CoinGecko's, but each Binance observation carries a note saying it is a single-venue, USDT-quoted last trade, and nothing in the code treats the two providers' provenance as identical.

## Coverage (verified 2026-10-06)

- **182** canonical tokens.
- **180 mapped**, each an exact Binance spot symbol, all USDT-quoted.
- **2 unmapped**, each with a stated reason in `binanceUnmapped`:
  - `ethereum-usdt` — USDT is the quote currency of every symbol used here, so there is no `USDTUSDT` market to price it against.
  - `ethereum-stg` — `STGUSDT` exists but its status was `BREAK` (trading halted), so its last price is frozen and must not be served as live.

Both fall back to CoinGecko, which is what the fallback is for. A measured run against the live API returned tickers for all 180 mapped symbols in ~1.2 s.

## Staleness: two different checks

These are easy to conflate, and the distinction matters.

**In the collector — is Binance's own price frozen?** `MAX_TICKER_AGE_MS` (1 hour) compares the ticker's `closeTime` against the run's collection time. Past it, the observation is written as `unavailable` with a reason, which is what triggers the CoinGecko fallback. The threshold guards against one specific failure: a halted symbol keeps reporting the trade it was frozen at.

An hour, not a few minutes, because **`closeTime` is the symbol's last trade, not when Binance built the response** — on a quiet pair it lags because nobody traded. Measured across all 180 mapped symbols on 2026-10-06: median 3 s, p95 40 s, but `DGBUSDT` at 645 s and `XNOUSDT` at 519 s, both correctly priced. A ten-minute threshold rejected those two. Nothing in that sample sat between 11 minutes and the multi-day staleness of a genuinely halted symbol, so an hour separates "quiet" from "frozen" with room on both sides.

**In the read layer — has the pipeline refreshed recently?** `livePriceRow` in `src/lib/data/live-data.ts` prefers a Binance row only while its **`collected_at`** is within `REFRESH_POLICY.binance.staleAfterMs` (20 minutes, ~4 missed runs). It uses `collected_at`, not `observed_at`, precisely because of the lag above: judging this on `observed_at` would push every thinly traded token onto CoinGecko for no reason. Whether the venue price itself is frozen is already settled by the collector.

## Fallback behavior

`livePriceRow` falls back to CoinGecko whenever Binance cannot stand behind the number:

- no Binance mapping for the token,
- the Binance row is `unavailable` (stale/halted ticker, non-numeric field),
- the Binance row's `collected_at` has aged past the bound — for instance the Binance step is failing while CoinGecko's keeps succeeding.

The function returns the **row**, not the value, so the caller records which provider actually supplied the number in `metricSources`. A Binance price is attributed to Binance with its USDT-quoted single-venue note; a fallback price is attributed to CoinGecko. Neither ever carries the other's provenance.

`src/lib/data/observation-reads.ts` must keep `binance` in its `PROVIDERS` list — dropping it would silently fall every token back to CoinGecko with no error.

## History and retention

Binance is **never** the history or chart provider. Charts, indicators, and the risk profile continue to read CoinGecko's `price_usd` series, and the retention guards stay scoped to `provider_id = 'coingecko'` for the 30-day granular chart window (`20261004140000_extend_price_usd_granular_window_for_risk_profile.sql`). Binance's `price_usd` rows are therefore collapsed to one row per day by the non-chart retention path, like any other non-chart observation. That is intentional: Binance supplies the live value, CoinGecko supplies the series.

There is also no gap-repair step for Binance, unlike CoinGecko and DeFiLlama, for the same reason — there is no Binance series to repair.

## Database migration

Apply `supabase/migrations/20261006090000_binance_live_price_provider.sql` in the Supabase SQL Editor. It:

1. inserts the `binance` row into `data_providers`,
2. extends the `data_refresh_steps.step` check constraint to allow `'binance'`,
3. makes `price_change_24h_pct`'s description provider-neutral, since both collectors now write that metric and a `metric_definitions` row is shared across providers (otherwise the two would overwrite each other's description every run). Per-observation provenance lives in each observation's own note.

## Run it

Binance is part of the normal refresh, so no separate script is needed:

```
pnpm refresh                                    # whatever is due
curl '/api/cron/refresh?providers=binance&force=1'   # Binance only
```

## Presentation

Per the project's data-language policy (`src/lib/ui/data-language.ts`), the provider name is not shown in the main UI: the dataset is labelled **"Live exchange price"** for freshness lines, `plainLanguage` rewrites "Binance" to "exchange" in stored note text, and "Binance" itself appears only in the optional Data provenance disclosure.
