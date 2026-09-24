# Historical data

Phase 12.5 makes historical charts, calculated metrics and the Deep AI Analysis context describe **what is actually stored**. A period button selects a requested window; it never claims that the window is fully covered.

## Architecture

```
Normal refresh (hourly, Phase 11B) ──► latest provider observations ─┐
Manual CoinGecko backfill (bounded) ──► older historical points ─────┼─► token_metric_observations (append-only)
DeFiLlama collector ──► protocol TVL points within 90 days ──────────┘         │  + raw_provider_records
                                                                              ▼
                        buildHistoricalSeries (server) ──► chart series + per-period coverage
                                                        ──► Deep AI Analysis context (coverage per window)
```

- **Refresh and backfill are separate.** The hourly refresh fetches only current values. The backfill is manual (`pnpm backfill:coingecko`) and never runs on the schedule, so it doesn't consume quota every hour.
- **Every value is an actual stored observation,** with its provider, provider timestamp (`observed_at`), collection time, metric, token (or protocol) and raw record. Charts join these points with straight lines; nothing is interpolated, zero-filled or synthesized.

## Periods and coverage

The supported periods are **24H, 7D, 30D and 90D**. Each is a requested window `[asOf − period, asOf]`, inclusive at both ends, where `asOf` is the server time when the page was built. The window is not measured from the latest observation. The contract lives in [`src/types/historical-data.ts`](../src/types/historical-data.ts) and [`src/lib/data/historical-series.ts`](../src/lib/data/historical-series.ts). For each series and period, the server reports:

| Field | Meaning |
| --- | --- |
| `requestedPeriod`, `windowStart`, `windowEnd` | The requested window |
| `status` | `available` (2 or more points), `insufficient_history` (1 point), `unavailable` (none) |
| `observationCount`, `coverageStart`, `coverageEnd`, `coverageHours` | What the window actually contains |
| `fullCoverage` | True only when the stored points span at least 90% of the window |
| `coverageLabel` | For example "3 observations spanning 4.3 hours" (never a period name) |
| `unavailableReason` | For example "No stored observations fall in the requested 24H window", or the mapping reason for an unmapped provider |

Each series also records its `providerId` and `scope` (token-level or protocol-level), and every point carries a `sourceId` (`obs:<id>`).

How the chart presents this:
- The footer shows "Requested 30D · N observations spanning X".
- Changes read "+x% across X of observations". Short spans get a **Partial coverage** note with exact timestamps.
- Insufficient windows show "No sufficient stored history is available for this period." with the reason.
- The time axis is proportional, so mixed daily and hourly density isn't distorted, and sparse series show their individual points.

## Period semantics of calculated metrics

This phase changes no metric definitions. Growth metrics remain "latest vs previous distinct observation", and their period comes from the stored `period_start_at`/`period_end_at`, labelled with the exact interval. After the backfill, for example, Bitcoin price growth spans **2.5 hours**, and Uniswap's price-vs-TVL comparison uses a **40-minute** aligned interval. Neither is called 24-hour, 7-day or 30-day, and a metric without a valid period stays `unavailable` with its reason.

The dashboard's "TVL · 30d" needs a baseline observation between 30 and 33 days old; otherwise it is unavailable.

## Deep AI Analysis

Each `history[]` series in the research context carries `coverage` for 24H, 7D and 30D, computed from **all** stored observations rather than the daily sample (context version 2). Each entry has `observationCount`, `coverageStart`, `coverageEnd`, `coverageHours`, `coverageLabel` and `coversRequestedWindow`. Prompt version 2 adds rule 6a: a requested window is not achieved coverage, so the model must describe the actual span ("across about 21 hours of stored observations") and treat unavailable windows as data gaps.

## Coverage (verified 24 Sep 2026)

| Series | Before Phase 12.5 | After backfill + one refresh |
| --- | --- | --- |
| CoinGecko price, market cap, volume (50 tokens) | 2–3 points each, spanning about 26 hours; no window genuinely covered | 251–253 points each; **7D, 30D and 90D fully covered for all 50**; 24H covered after the refresh (24 points spanning 23.6 hours) |
| DeFiLlama protocol TVL (11 mapped protocols) | 91–92 daily points from 26 Jun to 23 Sep | Unchanged: 30D and 90D fully covered. 7D is partial (5.7 days) and 24H has no points, because the DeFiLlama collector is still timing out |
| DeFiLlama fees and revenue | 5 values across 11 protocols | Unchanged; no historical endpoint is used |
| DEX Screener (34 mapped tokens) | 2–3 snapshots | Unchanged; there is no history API. History grows only through the hourly refresh |
| 39 tokens without a DeFiLlama mapping | TVL unavailable | Unchanged: shown as unavailable by design, never as zero |

## CoinGecko backfill

```bash
pnpm backfill:coingecko --tokens=bitcoin-btc --dry-run
```

```bash
pnpm backfill:coingecko
```

- **Requests:** two per token (`/coins/{id}/market_chart`: `days=90&interval=daily`, and `days=7`, which returns hourly points), paced at 2.1 seconds with bounded retries. The whole universe is 100 calls, about 1% of the Demo plan's 10,000 monthly calls. A 429 or authentication error stops the run.
- **Values:** stores `price_usd`, `market_cap_usd` and `volume_24h_usd` (CoinGecko's `total_volumes` is the rolling 24-hour volume) with the provider timestamp and a `market_chart.*` source field. Each token gets one raw record (about 27 KB) that the observation rows link to.
- **Never supersedes live data:** only points **older than the newest stored observation** for that metric are added, so backfill can't replace the current value or make data look fresher.
- **Idempotent:** existing timestamps are skipped, and a token with nothing new writes nothing, not even a raw record. A verified rerun added 0 rows.
- **Recommended order:** run a normal refresh first, then the backfill, so the gap up to the latest refresh can be filled.

## Provider assessments

**CoinGecko** (current provider). `GET /coins/{id}/market_chart` returns `[timestamp_ms, value]` arrays for prices, market caps and total volumes. According to the [endpoint reference](https://docs.coingecko.com/reference/coins-id-market-chart):
- **Granularity:** 5-minutely for 1 day, hourly for 2–90 days, and daily for more than 90 days. `interval=daily` is available on all plans, and `hourly` covers the past 100 days.
- **Depth:** Demo/keyless access is limited to the past 2 years. Paid plans start at the dates listed on the reference.
- **Verification:** our Demo key successfully retrieved 90 days of daily data and 7 days of hourly data.

The [pricing page](https://www.coingecko.com/en/api/pricing) lists Demo at 10,000 calls a month with attribution required, and **commercial use is not permitted on Demo**; commercial use starts with the paid plans. This restriction applies to all stored CoinGecko data, live and backfilled. Any commercial or customer-facing use requires a paid plan and the required attribution, and neither is in place yet.

**DeFiLlama** (current provider). `/protocol/{slug}` returns the protocol's full TVL history. Its payloads reach 69 MB, so only the explicit `pnpm backfill:defillama` requests it; the scheduled refresh does not. The backfill keeps dated points from the last 90 days (91–94 daily points per protocol are stored), marks them protocol-level, writes TVL only, and accepts only the verified DeFiLlama record. The scheduled refresh adds current TVL (`/tvl/{slug}`), stamped with the collection time, about every 6 hours. See [the DeFiLlama guide](defillama-integration.md#endpoints-and-data-flow).

**DEX Screener** (current provider). No historical endpoint is used; current pair snapshots are never treated as history.

**CoinMarketCap** (possible future backup; not integrated). The [pricing page](https://coinmarketcap.com/api/pricing/) lists:

| Plan | Price | Credits/month | Rate limit | Historical data |
| --- | --- | --- | --- | --- |
| Basic (free) | Free | 15,000 | 50/min | None (latest data only) |
| Builder | $29/mo | 150,000 | 300/min | 3 years |
| Startup | $79/mo | 450,000 | 600/min | All-time |
| Growth | $299/mo | 2M | 750/min | All-time |
| Professional | $699/mo | 5M | 1,200/min | All-time |

Commercial use is approved on all listed plans. The API offers historical quotes and OHLCV endpoints (`/v2/cryptocurrency/quotes/historical`, `/v2/cryptocurrency/ohlcv/historical`). Their per-plan intervals and credit costs were not verified from the documentation and must be checked before any integration.

Assessment: CoinMarketCap is a realistic paid backup for history, and unlike CoinGecko Demo it permits commercial use. The free tier can't serve history.

## Storage implications

Measured on 24 Sep 2026 with this database. Monthly figures assume hourly CoinGecko and DEX Screener, DeFiLlama every 6 hours and metrics hourly.

| Store | Per run | Per month (hourly) |
| --- | --- | --- |
| Observations (about 620 B JSON per row) | about 706 rows | about 510k rows, around 320 MB plus 5 indexes |
| Calculated metrics (about 1.5 KB per row, including about 1 KB of provenance) | about 692 new rows | about 500k rows, around 750 MB plus indexes |
| Raw payloads (CoinGecko about 0.9 KB, DEX about 1.9 KB, DeFiLlama about 6 KB per record) | about 110 KB | about 90 MB |
| One-off CoinGecko backfill | 37,350 rows + 1.4 MB raw | n/a |

At hourly cadence the database grows by roughly **1–1.5 GB a month**, mostly from calculated-metric provenance. That exceeds the Supabase Free plan's 500 MB database within about 1–2 weeks. No data is deleted by this phase. Proposed separately, for a decision:
1. Store a new calculated-metric row only when its value changes materially, or keep full provenance only on the latest row plus one row per day.
2. Downsample observations older than 90 days to one per UTC day, keeping the raw record IDs.
3. Keep raw payloads for 30 days, retaining one per token per day after that.

Each option trades away some audit detail and should be chosen deliberately.
