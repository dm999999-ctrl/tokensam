# GeckoTerminal adapter

The GeckoTerminal collector is server-side. It is a separate, standalone data provider kept independent of the existing CoinGecko integration and its free-tier quota. Its data is surfaced on the Token Profile ("DEX Markets" and "Contract / On-chain Identity") and backs two cross-sectional technical indicators (Pool Concentration and DEX Concentration HHI). It can be run manually (`pnpm geckoterminal:sync`) or on a schedule (`/api/cron/geckoterminal`, disabled by default — see "Recurring scheduled collection" below); it is still **not** part of the `/api/cron/refresh` cron, for the timeout-budget reason explained there.

## Current coverage (reconciled 2026-09-28)

The canonical token universe has grown from 100 to **238 tokens** since this integration was built. Every canonical token now has an explicit row in `src/data/geckoterminal-token-mappings.ts` — mapped or documented-unmapped — but the mapping itself has not grown with the universe:

- **238** canonical tokens total.
- **63 mapped** — the same 63 tokens covered when this integration was built, each an exact GeckoTerminal network + contract/coin-type address, reusing the same exact address already verified for DEX Screener.
- **175 unmapped**, each with a documented reason. Of those, **37** are the original unmapped tokens (natives with no non-wrapped identity, or tokens where no DEX Screener-verified exact address existed). The other **138** are tokens added to the canonical universe after this integration was built; none of them has a DEX Screener-verified exact address to reuse either (`src/data/dexscreener-token-mappings.ts` has not been extended to them), so — per this integration's no-invented-mappings policy — every one of them is left explicitly unmapped rather than guessed from a ticker, name, or another chain's deployment. Extending coverage to any of them requires the same address-verification work already done for the original 63 (confirming an exact contract/coin-type address via CoinGecko's `/coins/list?include_platform=true` or equivalent, then confirming GeckoTerminal returns pools for it), which is out of scope for this reconciliation.

## Official API reference

Reviewed September 26, 2026:

- This integration uses the **standalone GeckoTerminal Public API** at `https://api.geckoterminal.com/api/v2`, confirmed live. It is a distinct product from CoinGecko's own API; this integration never calls CoinGecko's `/onchain` endpoints and never spends CoinGecko API quota or its API key.
- The collector uses `GET /networks/{network}/tokens/{address}/pools` (page 1), which returns every pool for a token: pool address, name, creation time, reserve (liquidity) in USD, 24-hour volume/transactions/price-change, FDV, market cap, and `relationships` identifying the base token, quote token (both by exact chain-scoped address), and the DEX. This single endpoint supplies all the fields this phase targets: DEX pairs, DEX liquidity, DEX volume, DEX list (via each pool's `relationships.dex.id`), and contract/address data by network (via `relationships.base_token`/`quote_token`).
- No API key or authentication is required or sent.
- The endpoint has no documented numeric rate limit; GeckoTerminal's public API is treated conservatively as **~10 requests/minute**. There is no multi-address batch form for this endpoint (unlike DEX Screener's), so requests are one token at a time, serialized with a 6.5 second minimum gap (≈9.2 requests/minute), retried at most three times, with 429 responses honoring `Retry-After`. A live burst test during development observed 429s when requests were sent faster than this; spacing at 6.5 s or slower avoided them.
- GeckoTerminal's network catalog (`GET /networks`) was fetched live to confirm which of DEX Screener's already-verified exact-address mappings have a corresponding GeckoTerminal network id, using each network's published `coingecko_asset_platform_id` to cross-check identity.

## Identity and pool-selection policy

Token lookup uses an explicit GeckoTerminal network id + exact token/coin-type address, never a ticker/name search — the same identity policy as the DEX Screener adapter. `src/data/geckoterminal-token-mappings.ts` reuses the exact addresses already verified for DEX Screener and translates the chain to GeckoTerminal's own network id (for example DEX Screener's `ethereum` is GeckoTerminal's `eth`; `sui` is `sui-network`). The map covers 63 of the current 238 canonical tokens (see "Current coverage" above); natives without a wrapped-asset substitution (ETH, SOL, BNB, AVAX, BTC, and others) stay unmapped with an explicit reason, matching the DEX Screener policy of never substituting a wrapped asset for a native one.

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

`/api/cron/geckoterminal` accumulates GeckoTerminal history over time, the same way CoinGecko's schedule accumulates its price/volume history: each successful run writes a new `observed_at`/`collected_at` timestamp, never overwriting the previous one (verified — see below). This is what future liquidity/volume time-series indicators (7D/30D liquidity change, DEX volume trend, etc.) will eventually read; **none of those are implemented yet**, and this phase adds no new `IndicatorInput`, `SERIES_RULES` entry, or indicator definition.

**External trigger: Cloudflare Worker, not Vercel Cron.** Vercel's Hobby plan cannot run a Cron Trigger more often than once a day, so a `*/15 * * * *` Vercel Cron entry fails deployment. Instead, the existing Cloudflare Worker at [`cloudflare/refresh-scheduler/`](../cloudflare/refresh-scheduler/) — already responsible for pinging `/api/cron/refresh` every 5 minutes — also pings this route on the same 5-minute Cron Trigger. `vercel.json` keeps only a once-daily Vercel Cron entry for `/api/cron/refresh` as a fallback; it does not reference this route at all.

**Disabled by default.** Set `GECKOTERMINAL_SYNC_ENABLED=true` to turn it on; otherwise the route is a no-op even if pinged, so deploying it never silently starts spending GeckoTerminal's rate limit.

**Configuration** (all optional, read only by the route, never hard-coded into the provider):

- `GECKOTERMINAL_SYNC_ENABLED` — `"true"` to enable; anything else (including unset) keeps the route disabled.
- `GECKOTERMINAL_SYNC_INTERVAL` — minimum milliseconds between successful runs (a due-check independent of how often the Cloudflare Worker's own tick fires, mirroring the refresh orchestrator's `isProviderDue`). Default: `780000` (13 min — 15 minutes minus a 2-minute tolerance, the same interval-minus-tolerance pattern `REFRESH_POLICY`/`DUE_TOLERANCE_MS` uses). Since the Worker ticks every 5 minutes, this due-check is what turns those frequent pings into an effective ~15-minute GeckoTerminal cadence: two out of three ticks return `{"status":"skipped","reason":"not_due"}` immediately, and the third actually collects.
- `GECKOTERMINAL_BATCH_DELAY_MS` — an optional *additional* pacing floor. It can only raise the delay between requests above the collector's built-in `6500`ms minimum; it can never lower it, so this cannot weaken the existing rate-limit protection.

**Why not the shared refresh route.** A full 63-token sync takes roughly 7 minutes unthrottled, and longer with any 429 cooldowns — far beyond what fits alongside CoinGecko/DEX Screener/DeFiLlama in the shared route's 300 s budget. Rather than force it in, this is a **separate route with its own budget** (`maxDuration = 300`, with an internal 270 s processing deadline so the collector always has time to persist what it collected before the platform's own timeout).

**Rotation, batch size, and freshness.** Each invocation is time-budget driven, not a fixed batch count: it keeps requesting tokens (one at a time, 6.5 s apart) until either every mapped token has been attempted or the 270 s processing deadline is reached, then persists a `nextTokenId` cursor so the *next* invocation resumes exactly where this one stopped rather than restarting at the first token (`resolveGeckoTerminalStartTokenId`, backed by `geckoterminal_sync_runs.summary`). At 6.5 s pacing, 270 s fits roughly 41 tokens in the theoretical best case; allowing margin for request latency, retries, and 429 cooldowns, a **conservative estimate is ~30 tokens per invocation**. With 63 mapped tokens:

- Safe tokens per invocation: **~30** (time-budget bounded, not a hard-coded limit).
- Full rotation across all 63 mapped tokens: **~2 invocations**, i.e. roughly **30 minutes** at the ~15-minute effective cadence (more if a run is throttled or interrupted).
- Estimated maximum token freshness: **~30–45 minutes** in the typical case (one full rotation, plus slack for a slow or partially-throttled run) — a large improvement over the previous daily cadence, though still not uniform: a token collected early in a rotation is fresher than one collected just before the next rotation starts.

15 minutes is the **effective invocation cadence** (via the Cloudflare Worker's 5-minute ticks plus this route's own 13-minute due-check), not a freshness guarantee for every token — rotation means freshness depends on mapped-token count and tokens processed per run, which is why this section reports an estimate rather than a fixed number.

**Partial-failure tolerance.** Unlike the manual `pnpm geckoterminal:sync` (which is all-or-nothing, matching every other provider's collector), the scheduled path persists every token that succeeded even if others in the same run failed or ran out of time budget. The response and server logs report `attempted`, `succeeded`, `failed` (with each token's error), `skipped` (time budget), `observations`, `unavailable`, `rateLimitEvents`, and `retries`.

**Locking.** `geckoterminal_sync_runs` (see migration above) prevents overlapping runs — a scheduled invocation while another (scheduled or manual) is in progress gets `{"status":"busy"}` (HTTP 409) and does nothing; an abandoned run's lease (15 minutes) expires automatically so a crash never blocks collection indefinitely.

**Retention.** No retention/deletion policy exists anywhere in this schema today (checked before writing this feature); GeckoTerminal observations are not deleted by anything in this codebase, consistent with every other provider.

## Scope

- Not wired into `src/lib/refresh/config.ts` / `src/lib/refresh/orchestrator.ts` (the hourly, multi-provider refresh) — see "Why not the hourly refresh route" above. `data_refresh_runs`/`data_refresh_steps` (typed to that orchestrator's `ProviderStep` set) are untouched; GeckoTerminal's lock is a separate, small table instead.
- The existing CoinGecko, DeFiLlama, and DEX Screener integrations, collectors, request schedules, and configuration are untouched.
- No historical/time-series GeckoTerminal indicators exist yet (DEX volume trend/momentum, liquidity change, price/volume divergence, etc.) — those need several days of accumulated history first; see the next section.

## How many snapshots are needed before time-series indicators are safe

The existing indicator pipeline (`src/lib/indicators/`) requires between 8 and 61 consecutive daily samples depending on the indicator (e.g. 8 for a 7-day change, 31 for a 30-day comparison, up to 61 for MACD-style warm-up). Since each scheduled GeckoTerminal run produces at most one observation per token per day, **the daily cron needs to run for roughly that many consecutive days** before the shortest new indicators (a 7-day liquidity change) could be safely enabled, and closer to 30+ days before 30-day comparisons (liquidity trend, price/DEX-volume divergence) would have enough history. This is a lower bound: the pipeline's own staleness/contiguity rules (`series.ts`) also require the run of days to be unbroken and recent, so any missed or delayed run pushes that date out further for the tokens it affects.
