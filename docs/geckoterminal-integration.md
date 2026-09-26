# GeckoTerminal adapter (pipeline-establishment phase)

GeckoTerminal is a new, independent on-chain DEX data provider. It uses the **standalone GeckoTerminal Public API** (`https://api.geckoterminal.com/api/v2`) directly — never CoinGecko's `/onchain` endpoints — and is completely separate from the existing CoinGecko integration, its API key/configuration, its request schedule, and its quota. The collector never calls CoinGecko, and CoinGecko's collector is unchanged.

This phase only establishes and verifies the data pipeline (collection, identity mapping, storage). **No Token Profile UI field reads GeckoTerminal data yet**, and the Deep AI Analysis evidence context and the dashboard/Token Profile freshness display explicitly exclude it (see "Deliberately not surfaced" below) so the product is unchanged until GeckoTerminal fields are intentionally added.

## A network-access limitation in this environment

This work was implemented and verified against the codebase (unit tests, typecheck, lint, `next build`) in a sandboxed environment whose network egress policy blocks `api.geckoterminal.com` (`curl`/`WebFetch` both return an explicit egress-block error). **No live GeckoTerminal API call could be made from this environment.** Everything endpoint-shape-related (JSON field names, JSON:API resource-id conventions) is based on GeckoTerminal's publicly documented v2 API and was not re-verified against a live response here. Before relying on this in production:

1. Run `pnpm geckoterminal:sync` (or `pnpm refresh --providers=geckoterminal --force`) from an environment with normal internet access.
2. Compare the stored `raw_provider_records` payloads for a few tokens against the live API docs at https://apiguide.geckoterminal.com/ to confirm field names match exactly (in particular the `tokens/multi` resource ID format `{network}_{address}`, assumed in `geckoterminal.ts`'s `byId` lookup).
3. If a field name differs, only `src/lib/providers/geckoterminal.ts`'s `Gt*Attributes`/`Gt*Response` types and the small number of readers of those fields need to change — the DB schema, persistence, and orchestration are unaffected.

## Endpoints implemented

All requests go to `https://api.geckoterminal.com/api/v2`, GET only, no authentication header, `accept: application/json;version=20230302`:

| Endpoint | Data type | Batching |
| --- | --- | --- |
| `GET /networks/{network}/tokens/multi/{addresses}` | Contract/address data by network; DEX liquidity (`total_reserve_in_usd`); DEX volume (`volume_usd.h24`) | Up to 30 addresses per request |
| `GET /networks/{network}/tokens/{address}/pools` | DEX pairs (pools) for one token, including its DEX identity via the JSON:API `included` array | One request per token (not batchable) |
| `GET /networks/{network}/dexes` | DEX list for a network | One request per distinct network in a run |

`GET /networks/{network}/tokens/{address}` (single-token) and `GET /networks/{network}/pools/{address}` (single-pool) are documented but not used, since `tokens/multi` and `tokens/{address}/pools` cover everything this phase needs with fewer requests.

## Rate limiting and caching

The public API's rate limit is not published as a numeric guarantee; it is treated conservatively as **~10 requests/minute** (6.5 s minimum pacing between requests, `MIN_REQUEST_INTERVAL_MS` in `geckoterminal.ts`, slightly above the exact 6.0 s that 10/min implies). Pacing, retry/backoff (429 `Retry-After`, 5xx exponential backoff, bounded to 3 attempts), and a 404-as-empty rule mirror the existing DEX Screener adapter's conventions.

Because the per-token pools lookup is not batchable, each `GeckoTerminalMarketDataProvider` instance also keeps an in-process response cache (5-minute TTL, keyed by request path) so a repeated lookup — for example, the DEX list for a network shared by several tokens — is served once, not re-fetched. The collector caps an **automatic** (unscheduled `tokenIds`) run to 12 tokens (`DEFAULT_MAX_TOKENS_PER_RUN` in `run-geckoterminal-collection.ts`) so one run's pool lookups plus its batched token-attribute and DEX-list requests comfortably fit inside the 150 s step timeout without approaching the rate limit; an explicit `tokenIds` option (manual/targeted collection, as used for verification) is never capped.

`REFRESH_POLICY.geckoterminal` (`src/lib/refresh/config.ts`) refreshes every 6 hours, the least frequent provider, reflecting the tight quota. It is a normal `ProviderStep` in the orchestrator (`src/lib/refresh/orchestrator.ts`), runs concurrently with the other providers, and has no permission gate (the public API is free and keyless) and needs no API key — none was added.

## Identity: network + contract address, reused from DEX Screener

GeckoTerminal indexes on-chain DEX activity by exact chain + contract address — the same identity DEX Screener already uses. Rather than re-deriving and re-verifying addresses, `src/data/geckoterminal-token-mappings.ts` reuses the already-verified `dexScreenerTokenMappings` contract addresses unchanged, and adds only a translation from canonical chain to GeckoTerminal's own network slug:

| Canonical chain | GeckoTerminal network slug |
| --- | --- |
| `ethereum` | `eth` |
| `bnb-chain` | `bsc` |
| `avalanche` | `avax` |
| `arbitrum` | `arbitrum` |
| `optimism` | `optimism` |
| `base` | `base` |
| `solana` | `solana` |
| `polygon` | `polygon_pos` |

Only these eight canonical chains are mapped. A token is unmapped for GeckoTerminal, with an explicit reason, when either:

- it has no DEX Screener contract address (native asset, or unverified) — GeckoTerminal has no on-chain contract identity for it either, for the same reason; or
- it has a DEX Screener address on a chain not in the table above — the GeckoTerminal network slug for that chain has not been verified against a live response in this environment, so it is not guessed. (GeckoTerminal likely supports more networks than these eight; add them here once their exact slug is confirmed against a live `/networks` response or the docs.)

Tickers and fuzzy name matching are never used, matching the rest of the codebase's identity policy.

## Data architecture

No new tables were needed. `provider_token_mappings`, `raw_provider_records`, `token_metric_observations`, and `provider_pairs` are already provider-neutral (`provider_id` is free text referencing `data_providers`), and the two metrics this phase populates — `liquidity_usd` and `volume_24h_usd` — already exist in `metric_definitions` from the DEX Screener migration. The only schema change ([`20260929090000_geckoterminal_provider.sql`](../supabase/migrations/20260929090000_geckoterminal_provider.sql)) is additive:

- inserts the `geckoterminal` row into `data_providers`;
- widens the `data_refresh_steps.step` check constraint to include `'geckoterminal'`.

Per token, the collector stores:

- **`provider_token_mappings`**: one row per token, `provider_id = 'geckoterminal'`, `scope = 'market'`, `external_asset_id = "{network}:{address}"`, `verification_method = 'exact_chain_address_reused_from_dexscreener'`.
- **`raw_provider_records`**: the token's `tokens/multi` attributes and its full `pools` response, preserved verbatim in `payload` — plus one **network-level** raw record per distinct network in the run (`token_id = null`, `external_asset_id = "{network}:dexes"`) holding the network's DEX list response.
- **`token_metric_observations`**: `liquidity_usd` (from `total_reserve_in_usd`) and `volume_24h_usd` (from `volume_usd.h24`, `window_days = 1`), `scope = 'market'`, `provider_id = 'geckoterminal'`. Both reuse the existing metric IDs DEX Screener already writes — this is deliberate: per-provider observations under the same metric ID is exactly how CoinGecko/DeFiLlama coins already coexist for `price_usd`, and it means GeckoTerminal's DEX Screener-style aggregate market observations are not a new metric concept requiring a new column, and are never summed with DEX Screener's own rows anywhere (see below).
- **`provider_pairs`**: one row per pool (pair) returned for the token — pool address, GeckoTerminal DEX slug (`dex_id`), base/quote token addresses, pool creation time. This models DEX pools separately from the token entity, the same way DEX Screener's pairs already do.

No `price_usd`, `fdv_usd`, `market_cap_usd`, `price_change_24h_pct`, or transaction-count observations are written from GeckoTerminal in this phase — only the two metrics the task scoped ("DEX liquidity", "DEX volume"). "DEX pairs" and "Contract/address data by network" are captured through `provider_pairs`/`provider_token_mappings` and the raw payload, not as time-series metrics. "DEX list" is the per-network raw record described above.

### No double-counting with DEX Screener

The metrics engine (`src/lib/metrics/engine.ts`) computes `dex_aggregate_liquidity_usd`, `dex_aggregate_volume_24h_usd`, and the other DEX-derived calculated metrics by reading rows with `provider_id === "dexscreener"` explicitly (`metricSource(tokenRows, "dexscreener", ...)`), never generically by metric ID. Adding GeckoTerminal rows under the same `liquidity_usd`/`volume_24h_usd` metric IDs does not change any existing calculated metric, and does not create a new, duplicate metric definition merely because DEX Screener already reports something similar.

## Deliberately not surfaced yet

Three places in the codebase generically iterate all registered providers or all latest observations; GeckoTerminal is explicitly excluded from each so this phase changes nothing the user can see:

- **AI research context** (`src/lib/analysis/research-context.ts`): `EVIDENCE_PROVIDER_STEPS` excludes `geckoterminal` from the provider-freshness evidence, and the per-token observation list explicitly filters out `provider_id === "geckoterminal"`. Deep AI Analysis output is unaffected.
- **Dashboard/Token Profile freshness UI** (`DataStatus.tsx`, `UniverseHero.tsx`, via `src/lib/refresh/freshness.ts`): `buildRefreshStatus` now reads `DISPLAYED_PROVIDER_STEPS` (all providers except `geckoterminal`) instead of the full `PROVIDER_STEPS`, so no "GeckoTerminal" row appears in the provider freshness list.
- **Per-token dataset freshness** (`buildDatasetFreshness`, used by the Token Profile): already takes an explicit `relevant: ProviderStep[]` list from `live-data.ts` that does not include `geckoterminal`; no change was needed there.

`PROVIDER_STEPS` itself (used by the refresh orchestrator, the cron route, and `pnpm refresh --providers=`) does include `geckoterminal`, so it is a normal part of the scheduled/manual refresh pipeline.

## Running and verifying

```bash
pnpm test               # includes tests/geckoterminal.test.mjs (fixture-only, no network)
pnpm lint
pnpm build
pnpm geckoterminal:sync # live collection; requires SUPABASE_URL/SUPABASE_SECRET_KEY, needs network access to api.geckoterminal.com
```

`pnpm refresh --providers=geckoterminal --force` runs it through the orchestrator instead of standalone. No GeckoTerminal-specific environment variable is required or was added.

## Fields GeckoTerminal could not provide in this phase

Nothing was unavailable from the API itself (per its documentation) — the fields left out (price, FDV, market cap, price change, transaction counts, holder counts, technical indicators) were excluded by the task's explicit scope, not by a provider limitation. They are natural follow-ups once this pipeline is verified against a live response and Token Profile UI work is in scope.
