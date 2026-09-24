# DEX Screener adapter (Phase 8)

The DEX Screener collector is server-side and manually invoked. The Token Profile displays stored DEX-derived calculated metrics (see [the live data guide](live-data.md)).

## Official API reference and terms

Reviewed September 23, 2026:

- The collector uses `GET /tokens/v1/{chainId}/{tokenAddresses}`. The endpoint accepts up to 30 comma-separated token addresses and returns all corresponding pairs. The reference lists a limit of 300 requests/minute for token/pair endpoints. Requests are grouped by chain, batched to at most 30 addresses, serialized with a 300 ms minimum gap, and retried at most three times; 429 handling honors `Retry-After`. The endpoint docs show no API key/authentication requirement. See the [official API reference](https://docs.dexscreener.com/api/reference).
- Pair responses include pair address, DEX ID, URL, base/quote token identity, USD price, 24-hour transactions/volume/change, liquidity, FDV, market cap, and pair creation time where available. The API does not publish a pair snapshot/update timestamp; `observed_at` therefore uses our collection time. `pairCreatedAt` is retained separately and is not used as a market observation time.
- The [API terms](https://docs.dexscreener.com/api/api-terms-and-conditions) allow commercial and non-commercial use subject to restrictions. They prohibit using the API to build, enhance, or market a product whose primary purpose directly competes with DEX Screener, and prohibit resale or unauthorized third-party access to the API services. The Token Profile now displays DEX-derived calculated metrics. Review those restrictions before exposing DEX-derived data to customers or offering data/API access. No endpoint-specific attribution format was stated in the API reference; provider provenance is retained in stored records regardless.

## Identity and pair-selection policy

Token lookup uses an explicit chain + token-address mapping, never a ticker/name search. The current map covers 15 of the existing 20 canonical tokens. Five are intentionally unmapped: BTC, XRP, POL, NEAR, and TIA. Their bridged/wrapped alternatives or native-asset address formats are not guessed. ETH, SOL, BNB, and AVAX use explicit wrapped-native proxy addresses; their records are labeled as wrapped-asset market proxies, not direct native-asset pools. RENDER uses the official Solana mint, SKY uses the current SKY contract rather than legacy MKR, and SUI/APT use their native coin-type identifiers. Contract references for the current migrations are available from [Render Network](https://know.rendernetwork.com/general-render-network/rndr-to-render-what-you-need-to-know/render-network-upgrade-portal-faq), [Sky Protocol](https://developers.skyeco.com/guides/sky/token-governance-upgrade/key-info/), and [Polygon Support](https://support.polygon.technology/support/solutions/articles/82000906989-information-related-to-pol-contract-and-migration).

For each mapped token, the collector:

1. Requests all pairs for its exact provider chain and address. It filters the response back to exact chain/address matches and deduplicates by pair address.
2. Retains every matched pair. It selects a primary **base-token** pair by USD liquidity descending, then 24-hour volume descending, then pair address ascending. If no base-token pair exists, the most liquid matched pair is retained for pair-level metadata, but its base-token price/change/FDV/market cap are not misrepresented as the queried quote token's metrics.
3. Uses primary-pair values for price, liquidity, 24-hour change, FDV, and market cap. It sums volume and buy/sell counts across all exact-address pairs. Missing/null fields become unavailable with null values; zero remains a valid value.

The canonical token-address mapping is stored in `provider_token_mappings`. Raw records retain the matched provider pair objects and selection details. `provider_pairs` holds one indexed mapping row per canonical token and pair, including canonical chain, DEX chain ID, pair address, DEX, URL, token sides, creation time, and latest observation's raw-record link. This preserves many-pairs-per-token identity for future Phase 10 market-structure calculations.

## Database migration

Before syncing, apply [`20260923120000_dexscreener_market_structure.sql`](../supabase/migrations/20260923120000_dexscreener_market_structure.sql) in the Supabase SQL Editor. It:

- permits `count` as a metric unit and seeds liquidity, FDV, and 24-hour transaction-count metric definitions;
- creates `provider_pairs` with RLS enabled and service-role-only grants.

The collector checks for this migration before making DEX Screener requests. The migration does not expose database access to the browser.

## Run the collector

No DEX Screener key or new environment variable is required. `.env.local` only needs the existing server-only Supabase settings. After applying the migration:

```bash
pnpm dexscreener:sync
```

The command processes the 20-token universe, reports exact-address mappings and unmapped assets, and stores provider mappings, raw pair records, normalized observations, and pair mappings. It does not update the UI. A provider response can legitimately contain no pools for a mapped token; in that case the collector stores an empty raw pair result and unavailable observations for its metrics.

## Tests

`pnpm test` includes fixture-only DEX Screener checks for address matching, multiple-pair selection, pair preservation, aggregation, missing values, zero values, batching, request pacing, and 429 retry behavior. Tests make no network requests. `pnpm lint` and `pnpm build` verify the application.
