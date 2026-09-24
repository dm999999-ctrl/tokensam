# Provider coverage matrix (50 tokens)

Generated from stored Supabase data after full refresh run 3. Providers were collected at 2026-09-24T18:58:46Z, and metrics were recalculated at 2026-09-24T19:04:08Z with calculation version 3. Regenerate this matrix after each coverage change. Do not edit it by hand.

A cell shows *available/returned* metrics for the latest observations. "—" means the token has no mapping for that provider, followed by the reason in italics. Each provider's scope is shown in its column header and never mixes with another scope:

- **CoinGecko:** token-level aggregate market data (8 metrics).
- **DeFiLlama price:** token-level price from the coins API (1 metric).
- **DeFiLlama protocol:** TVL, fees and revenue for the associated protocol record (3 metrics). This is **not** token data. The cell shows the verified record ID.
- **DEX Screener:** DEX pairs matching the exact chain and token address (9 metrics). This is **not** the token's whole market.
- **Calculated:** the 28 derived metrics.

## Summary

| Provider | Tokens mapped | Metrics available / returned |
| --- | --- | --- |
| CoinGecko | 50 / 50 | 379 / 400 |
| DeFiLlama price | 50 / 50 | 50 / 50 |
| DeFiLlama protocol | 11 / 50 | 33 / 33 |
| DEX Screener | 31 / 50 | 273 / 279 |
| Calculated metrics | 50 / 50 | 536 / 1400 |

Every latest provider row was collected in this run (stale rows: 0). No row is missing its scope, provider asset ID, mapping ID or raw-record link (rows with missing provenance: 0).

## Matrix

| Token | Chain | CoinGecko (token) | DeFiLlama price (token) | DeFiLlama protocol (protocol) | DEX Screener (market) | Calculated |
| --- | --- | --- | --- | --- | --- | --- |
| ETH | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | — *wrapped only* | 3/28 |
| BTC | bitcoin | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| SOL | solana | 7/8 (no max supply) | 1/1 | — *no protocol* | — *wrapped only* | 3/28 |
| BNB | bnb-chain | 8/8 | 1/1 | — *no protocol* | — *wrapped only* | 3/28 |
| XRP | xrp-ledger | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| AVAX | avalanche | 8/8 | 1/1 | — *no protocol* | — *wrapped only* | 3/28 |
| ARB | arbitrum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| OP | optimism | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| AAVE | ethereum | 8/8 | 1/1 | 3/3 `parent#aave` | 9/9 | 22/28 |
| UNI | ethereum | 8/8 | 1/1 | 3/3 `parent#uniswap` | 9/9 | 22/28 |
| LDO | ethereum | 8/8 | 1/1 | 3/3 `182` | 9/9 | 28/28 |
| SKY | ethereum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| LINK | ethereum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| SUI | sui | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| APT | aptos | 8/8 | 1/1 | — *no protocol* | 7/9 (no FDV, mcap) | 11/28 |
| POL | polygon | 7/8 (no max supply) | 1/1 | — *no protocol* | — *no pairs* | 3/28 |
| NEAR | near | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| TIA | celestia | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| RENDER | solana | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| JUP | solana | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| USDT | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| USDC | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| WBTC | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| DOGE | dogecoin | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| TRX | tron | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| ADA | cardano | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| DOT | polkadot | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| ATOM | cosmos | 7/8 (no max supply) | 1/1 | — *no protocol* | — *no pairs* | 3/28 |
| LTC | litecoin | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| XLM | stellar | 7/8 (no max supply) | 1/1 | — *no protocol* | — *no pairs* | 3/28 |
| XMR | monero | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| ICP | internet-computer | 7/8 (no max supply) | 1/1 | — *no protocol* | 5/9 (no price, 24h change, FDV, mcap) | 11/28 |
| FIL | filecoin | 7/8 (no max supply) | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| CRV | ethereum | 8/8 | 1/1 | 3/3 `3` | 9/9 | 28/28 |
| COMP | ethereum | 8/8 | 1/1 | 3/3 `2088` | 9/9 | 28/28 |
| PENDLE | ethereum | 7/8 (no max supply) | 1/1 | 3/3 `parent#pendle` | 9/9 | 22/28 |
| DAI | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| ENA | ethereum | 8/8 | 1/1 | 3/3 `parent#ethena` | 9/9 | 22/28 |
| ONDO | ethereum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| SHIB | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| PEPE | ethereum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| BONK | solana | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| RAY | solana | 8/8 | 1/1 | 3/3 `parent#raydium` | 9/9 | 22/28 |
| JTO | solana | 7/8 (no max supply) | 1/1 | 3/3 `parent#jito` | 9/9 | 22/28 |
| PYTH | solana | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |
| AERO | base | 7/8 (no max supply) | 1/1 | 3/3 `parent#aerodrome` | 9/9 | 22/28 |
| MORPHO | ethereum | 8/8 | 1/1 | 3/3 `4025` | 9/9 | 21/28 |
| GRT | ethereum | 7/8 (no max supply) | 1/1 | — *no protocol* | 9/9 | 11/28 |
| AR | arweave | 8/8 | 1/1 | — *no protocol* | — *native, no address* | 3/28 |
| MNT | ethereum | 8/8 | 1/1 | — *no protocol* | 9/9 | 11/28 |

## Why a provider has no mapping

| Provider | Reason | Tokens | Explanation (example) |
| --- | --- | --- | --- |
| DeFiLlama protocol | `no_protocol_association` | 39: ETH, BTC, SOL, BNB, XRP, AVAX, ARB, OP, SKY, LINK, SUI, APT, POL, NEAR, TIA, RENDER, JUP, USDT, USDC, WBTC, DOGE, TRX, ADA, DOT, ATOM, LTC, XLM, XMR, ICP, FIL, DAI, ONDO, SHIB, PEPE, BONK, PYTH, GRT, AR, MNT | Ethereum is a chain's native asset, not a DeFiLlama protocol; chain-level TVL is not ETH token data and is not used. |
| DEX Screener | `native_asset_lacks_provider_identifier` | 12: BTC, XRP, NEAR, TIA, DOGE, TRX, ADA, DOT, LTC, XMR, FIL, AR | No canonical Bitcoin-chain DEX Screener token address is configured; bridged BTC wrappers are distinct assets. |
| DEX Screener | `wrapped_representation_only` | 4: ETH, SOL, BNB, AVAX | Native ETH has no token address; DEX markets trade Wrapped Ether (WETH), a distinct wrapped asset that is not substituted for ETH. |
| DEX Screener | `no_provider_data` | 3: POL, ATOM, XLM | CoinGecko's own-chain POL identifier (0x…1010) returned no DEX Screener pairs; DEX markets trade wrapped POL, a distinct asset. |

For DeFiLlama protocol data, `no_protocol_association` covers two different cases:

- **Chain-native assets** (BTC, ETH, SOL and others): chain-level TVL is not token data and is never used.
- **Tokens with no reviewed association to a specific DeFiLlama protocol record.** For DAI, ONDO and GRT, the relationship was reviewed and judged not precise enough (see [the token universe guide](token-universe.md)). The rest have no curated association yet.

DeFiLlama's token-level unlock/emissions and liquidity endpoints require the paid Pro plan and are not used.

## Metrics a mapped provider did not return

| Provider | Metric | Tokens | Reason |
| --- | --- | --- | --- |
| CoinGecko | `maximum_supply` | 21: ETH, SOL, POL, NEAR, TIA, USDT, USDC, WBTC, DOGE, TRX, ATOM, XLM, XMR, ICP, FIL, PENDLE, DAI, SHIB, JTO, AERO, GRT | CoinGecko did not return a numeric value for this field. |
| DEX Screener | `fdv_usd` | 2: APT, ICP | DEX Screener did not return this field for the exact-address pairs. |
| DEX Screener | `market_cap_usd` | 2: APT, ICP | DEX Screener did not return this field for the exact-address pairs. |
| DEX Screener | `price_usd` | 1: ICP | No exact-address base-token pair; the token appears only as the quote token, and pair prices are not inverted. |
| DEX Screener | `price_change_24h_pct` | 1: ICP | No exact-address base-token pair; the token appears only as the quote token, and pair prices are not inverted. |

CoinGecko returned `max_supply: null` for these tokens. The collector does not infer why; the metric is stored as unavailable, never as zero.

## Why calculated metrics are unavailable

| Cause | Unavailable metric rows | Tokens affected |
| --- | --- | --- |
| No protocol association (protocol-based metrics cannot apply) | 621 | 39 |
| No DEX Screener mapping, or DEX Screener did not return a field the metric needs | 194 | 21 |
| Mapped protocol has only one fees/revenue observation so far (first collected this run); needs a second run | 42 | 7 |
| Zero denominator or zero prior value (the provider reported a genuine zero) | 7 | 1 |

The "only one observation" gaps affect AAVE, UNI, PENDLE, ENA, RAY, JTO and AERO. These parent-record protocols returned fees and revenue for the first time in this run (see [the DeFiLlama guide](defillama-integration.md#record-identity-parent-vs-child)). The gaps clear after the next DeFiLlama collection. MORPHO's remaining gaps come from Morpho Blue's reported 24-hour revenue of exactly 0.

## Wrapped-proxy verification

| Check | Result |
| --- | --- |
| DEX Screener rows for ETH/SOL/BNB/AVAX/BTC in the latest view | 0 |
| Active (non-excluded) DEX Screener observations for those tokens | 0 |
| DEX Screener observations written for them in this run | 0 |
| Active DEX Screener raw records for them | 0 |
| DEX Screener mappings for them | 0 |
| Excluded proxy observations (unchanged since the migration) | 144 total, 0 added this run |
| Latest rows for a native token with a wrapped address as identity | 0 |
| Calculated rows for those tokens citing DEX Screener | 0 |
| WBTC address used by any token other than WBTC | 0 |
| Legacy `provider_pairs` rows for those tokens | 26. Last seen 2026-09-24T17:02:54.145+00:00, before the migration; 0 touched this run. Nothing reads this table. `20260928090000_exclude_wrapped_proxy_pairs.sql` marks them excluded. |

The only identifiers used for native tokens are `coingecko:<id>` (DeFiLlama price) and the CoinGecko ID.
