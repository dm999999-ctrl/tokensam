# GeckoTerminal adapter

The GeckoTerminal collector is server-side. It is a separate, standalone data provider kept independent of the existing CoinGecko integration and its free-tier quota. Its data is surfaced on the Token Profile ("DEX Markets" and "Contract / On-chain Identity") and backs two cross-sectional technical indicators (Pool Concentration and DEX Concentration HHI). It can be run manually (`pnpm geckoterminal:sync`) or on a **daily** schedule (`/api/cron/geckoterminal`, disabled by default — see "Recurring scheduled collection" below); it is still **not** part of the hourly `/api/cron/refresh` cron, for the timeout-budget reason explained there.

## Official API reference

Reviewed September 26, 2026:

- This integration uses the **standalone GeckoTerminal Public API** at `https://api.geckoterminal.com/api/v2`, confirmed live. It is a distinct product from CoinGecko's own API; this integration never calls CoinGecko's `/onchain` endpoints and never spends CoinGecko API quota or its API key.
- The collector uses `GET /networks/{network}/tokens/{address}/pools` (page 1), which returns every pool for a token: pool address, name, creation time, reserve (liquidity) in USD, 24-hour volume/transactions/price-change, FDV, market cap, and `relationships` identifying the base token, quote token (both by exact chain-scoped address), and the DEX. This single endpoint supplies all the fields this phase targets: DEX pairs, DEX liquidity, DEX volume, DEX list (via each pool's `relationships.dex.id`), and contract/address data by network (via `relationships.base_token`/`quote_token`).
- No API key or authentication is required or sent.
- The endpoint has no documented numeric rate limit; GeckoTerminal's public API is treated conservatively as **~10 requests/minute**. There is no multi-address batch form for this endpoint (unlike DEX Screener's), so requests are one token at a time, serialized with a 6.5 second minimum gap (≈9.2 requests/minute), retried at most three times, with 429 responses honoring `Retry-After`. A live burst test during development observed 429s when requests were sent faster than this; spacing at 6.5 s or slower avoided them.
- GeckoTerminal's network catalog (`GET /networks`) was fetched live to confirm which of DEX Screener's already-verified exact-address mappings have a corresponding GeckoTerminal network id, using each network's published `coingecko_asset_platform_id` to cross-check identity.

## Identity and pool-selection policy

Token lookup uses an explicit GeckoTerminal network id + exact token/coin-type address, never a ticker/name search — the same identity policy as the DEX Screener adapter. `src/data/geckoterminal-token-mappings.ts` reuses the exact addresses already verified for DEX Screener and translates the chain to GeckoTerminal's own network id (for example DEX Screener's `ethereum` is GeckoTerminal's `eth`; `sui` is `sui-network`). The map covers 63 of the 100 canonical tokens, the same coverage as DEX Screener; natives without a wrapped-asset substitution (ETH, SOL, BNB, AVAX, BTC, and others) stay unmapped with an explicit reason, matching the DEX Screener policy of never substituting a wrapped asset for a native one.

For each mapped token, the collector:

1. Requests page 1 of pools for its exact network and address.
2. Filters the response back to exact network/address matches (as base or quote token) and deduplicates by pool address.
3. Retains every matched pool. It selects a primary **base-token** pool by USD liquidity (`reserve_in_usd`) descending, then 24-hour volume descending, then pool address ascending. If no base-token pool exists, the most liquid matched pool is retained for pool-level metadata, but its base-token price/change/FDV/market cap are not misrepresented as the queried quote token's metrics (mirrors the DEX Screener policy — no price inversion).
4. Uses the primary pool's values for price, liquidity, 24-hour change, FDV, and market cap. It sums volume and buy/sell counts across all exact-address pools. Missing/null fields become unavailable with null values; zero remains a valid value.

## No duplicate metrics

GeckoTerminal supplies the same kind of on-chain DEX data DEX Screener already supplies, so this integration **reuses the existing metric catalog** (`price_usd`, `volume_24h_usd`, `liquidity_usd`, `price_change_24h_pct`, `transactions_24h_count`, `buys_24h_count`, `sells_24h_count`, `fdv_usd`, `market_cap_usd`) rather than creating parallel metric definitions. Rows are distinguished by `provider_id = 'geckoterminal'`, the same way CoinGecko, DeFiLlama, and DEX Screener rows already coexist per metric. It also reuses the existing `provider_pairs` table (already parameterized by `provider_id`) for pool-level records instead of a new table.

## Database migrations

Apply, in order, in the Supabase SQL Editor:

1. [`20260929090000_geckoterminal_provider.sql`](../supabase/migrations/20260929090000_geckoterminal_provider.sql) — registers the `geckoterminal` row in `data_providers` (required because `raw_provider_records`, `provider_token_mappings`, and `token_metric_observations` all reference `data_providers(id)` by foreign key). No new metric definitions were added — everything else needed already exists from [`20260923120000_dexscreener_market_structure.sql`](../supabase/migrations/20260923120000_dexscreener_market_structure.sql).
2. [`20260930090000_geckoterminal_scheduled_collection.sql`](../supabase/migrations/20260930090000_geckoterminal_scheduled_collection.sql) — adds one small table, `geckoterminal_sync_runs`, a lease-based lock (mirroring `data_refresh_runs`' proven pattern) so a scheduled run and a manual `pnpm geckoterminal:sync` can never execute concurrently. No changes to `token_metric_observations`, `raw_provider_records`, or `provider_pairs`.

The collector checks for all of the above before making any GeckoTerminal request.

## Run the collector manually

No GeckoTerminal key or new environment variable is required for a manual run. `.env.local` only needs the existing server-only Supabase settings. After applying the migrations:

```bash
pnpm geckoterminal:sync
```

This is now lock-protected: it refuses to start (with a clear error) if a scheduled collection is already in progress, and vice versa.

## Recurring scheduled collection

`/api/cron/geckoterminal` (Vercel Cron, daily by default — see [`vercel.json`](../vercel.json)) accumulates GeckoTerminal history over time, the same way CoinGecko's hourly cron accumulates its price/volume history: each successful run writes a new `observed_at`/`collected_at` timestamp, never overwriting the previous one (verified — see below). This is what future liquidity/volume time-series indicators (7D/30D liquidity change, DEX volume trend, etc.) will eventually read; **none of those are implemented yet**, and this phase adds no new `IndicatorInput`, `SERIES_RULES` entry, or indicator definition.

**Disabled by default.** Set `GECKOTERMINAL_SYNC_ENABLED=true` to turn it on; otherwise the route is a no-op even if the cron fires, so deploying it never silently starts spending GeckoTerminal's rate limit.

**Configuration** (all optional, read only by the route, never hard-coded into the provider):

- `GECKOTERMINAL_SYNC_ENABLED` — `"true"` to enable; anything else (including unset) keeps the route disabled.
- `GECKOTERMINAL_SYNC_INTERVAL` — minimum milliseconds between successful runs (a due-check independent of the cron's own firing schedule, mirroring the hourly refresh's `isProviderDue`). Default: `86400000` (24h).
- `GECKOTERMINAL_BATCH_DELAY_MS` — an optional *additional* pacing floor. It can only raise the delay between requests above the collector's built-in `6500`ms minimum; it can never lower it, so this cannot weaken the existing rate-limit protection.

**Why not the hourly refresh route.** A full 63-token sync takes roughly 7 minutes unthrottled, and longer with any 429 cooldowns — far beyond what fits alongside CoinGecko/DEX Screener/DeFiLlama in the shared route's 300 s budget. Rather than force it in, this is a **separate route with its own budget** (`maxDuration = 300`, with an internal 270 s processing deadline so the collector always has time to persist what it collected before the platform's own timeout). A Cloudflare Worker already exists in this repo (`cloudflare/refresh-scheduler/`, built independently) as an external pinger for the *hourly* refresh; GeckoTerminal's daily cadence has no similar reliability pressure, so it uses Vercel's native cron declaration directly rather than adding a second external trigger.

**Partial-failure tolerance.** Unlike the manual `pnpm geckoterminal:sync` (which is all-or-nothing, matching every other provider's collector), the scheduled path persists every token that succeeded even if others in the same run failed or ran out of time budget. The response and server logs report `attempted`, `succeeded`, `failed` (with each token's error), `skipped` (time budget), `observations`, `unavailable`, `rateLimitEvents`, and `retries`.

**Locking.** `geckoterminal_sync_runs` (see migration above) prevents overlapping runs — a scheduled invocation while another (scheduled or manual) is in progress gets `{"status":"busy"}` (HTTP 409) and does nothing; an abandoned run's lease (15 minutes) expires automatically so a crash never blocks collection indefinitely.

**Retention.** No retention/deletion policy exists anywhere in this schema today (checked before writing this feature); GeckoTerminal observations are not deleted by anything in this codebase, consistent with every other provider.

## Scope

- Not wired into `src/lib/refresh/config.ts` / `src/lib/refresh/orchestrator.ts` (the hourly, multi-provider refresh) — see "Why not the hourly refresh route" above. `data_refresh_runs`/`data_refresh_steps` (typed to that orchestrator's `ProviderStep` set) are untouched; GeckoTerminal's lock is a separate, small table instead.
- The existing CoinGecko, DeFiLlama, and DEX Screener integrations, collectors, request schedules, and configuration are untouched.
- No historical/time-series GeckoTerminal indicators exist yet (DEX volume trend/momentum, liquidity change, price/volume divergence, etc.) — those need several days of accumulated history first; see the next section.

## How many snapshots are needed before time-series indicators are safe

The existing indicator pipeline (`src/lib/indicators/`) requires between 8 and 61 consecutive daily samples depending on the indicator (e.g. 8 for a 7-day change, 31 for a 30-day comparison, up to 61 for MACD-style warm-up). Since each scheduled GeckoTerminal run produces at most one observation per token per day, **the daily cron needs to run for roughly that many consecutive days** before the shortest new indicators (a 7-day liquidity change) could be safely enabled, and closer to 30+ days before 30-day comparisons (liquidity trend, price/DEX-volume divergence) would have enough history. This is a lower bound: the pipeline's own staleness/contiguity rules (`series.ts`) also require the run of days to be unbroken and recent, so any missed or delayed run pushes that date out further for the tokens it affects.
