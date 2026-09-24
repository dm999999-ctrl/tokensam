# Phase 10: canonical token universe

The server-side provider collection universe has grown from 20 to 50 canonical assets. The dashboard lists every canonical token from Supabase. No schema migration was needed; the CoinGecko collection already upserts canonical chain, token, and provider-mapping rows before it persists observations.

## Added canonical assets

Each record has its own stable internal ID and chain identity. Contract-bearing assets are identified by chain plus contract address; native assets are identified as native assets on their chain. A symbol by itself is never used as an identity.

| Internal ID | Asset | Chain | CoinGecko ID |
| --- | --- | --- | --- |
| `ethereum-usdt` | Tether (USDT) | Ethereum | `tether` |
| `ethereum-usdc` | USDC | Ethereum | `usd-coin` |
| `ethereum-wbtc` | Wrapped Bitcoin (WBTC) | Ethereum | `wrapped-bitcoin` |
| `dogecoin-doge` | Dogecoin (DOGE) | Dogecoin | `dogecoin` |
| `tron-trx` | TRON (TRX) | TRON | `tron` |
| `cardano-ada` | Cardano (ADA) | Cardano | `cardano` |
| `polkadot-dot` | Polkadot (DOT) | Polkadot | `polkadot` |
| `cosmos-atom` | Cosmos Hub (ATOM) | Cosmos Hub | `cosmos` |
| `litecoin-ltc` | Litecoin (LTC) | Litecoin | `litecoin` |
| `stellar-xlm` | Stellar (XLM) | Stellar | `stellar` |
| `monero-xmr` | Monero (XMR) | Monero | `monero` |
| `internet-computer-icp` | Internet Computer (ICP) | Internet Computer | `internet-computer` |
| `filecoin-fil` | Filecoin (FIL) | Filecoin | `filecoin` |
| `ethereum-crv` | Curve DAO (CRV) | Ethereum | `curve-dao-token` |
| `ethereum-comp` | Compound (COMP) | Ethereum | `compound-governance-token` |
| `ethereum-pendle` | Pendle (PENDLE) | Ethereum | `pendle` |
| `ethereum-dai` | Dai (DAI) | Ethereum | `dai` |
| `ethereum-ena` | Ethena (ENA) | Ethereum | `ethena` |
| `ethereum-ondo` | Ondo (ONDO) | Ethereum | `ondo-finance` |
| `ethereum-shib` | Shiba Inu (SHIB) | Ethereum | `shiba-inu` |
| `ethereum-pepe` | Pepe (PEPE) | Ethereum | `pepe` |
| `solana-bonk` | Bonk (BONK) | Solana | `bonk` |
| `solana-ray` | Raydium (RAY) | Solana | `raydium` |
| `solana-jto` | Jito (JTO) | Solana | `jito-governance-token` |
| `solana-pyth` | Pyth Network (PYTH) | Solana | `pyth-network` |
| `base-aero` | Aerodrome Finance (AERO) | Base | `aerodrome-finance` |
| `ethereum-morpho` | Morpho (MORPHO) | Ethereum | `morpho` |
| `ethereum-grt` | The Graph (GRT) | Ethereum | `the-graph` |
| `arweave-ar` | Arweave (AR) | Arweave | `arweave` |
| `ethereum-mnt` | Mantle Ethereum representation (MNT) | Ethereum | `mantle` |

CoinGecko IDs and contract addresses were reconciled against its `/coins/list?include_platform=true` catalog on 2026-09-24. This deliberately distinguishes canonical native assets from bridged or wrapped representations. For example, ICP remains the native Internet Computer asset, ATOM remains native to Cosmos Hub, and MNT is explicitly the Ethereum representation returned by the catalog. CoinGecko's catalog is the provider identity source; symbol matches alone are not used. See [CoinGecko's coin-list reference](https://docs.coingecko.com/reference/coins-list).

The CoinGecko collector uses `/coins/markets` with explicit IDs in one batch (the endpoint supports up to 250 IDs) and requests rehypothecated assets explicitly so WBTC can be returned. See [CoinGecko's markets reference](https://docs.coingecko.com/reference/coins-markets).

## Provider mapping coverage

- **CoinGecko: 50 of 50.** Each canonical ID has a unique explicit CoinGecko ID mapping. It does not infer mappings from symbols.
- **DEX Screener: 34 of 50.** The 34 entries have an explicit chain and exact token address/coin type. All exact-address pairs returned for those assets are retained; primary-pair selection remains based on liquidity, then volume, then stable pair-address ordering. The 16 unmapped canonical assets are Bitcoin, XRP, POL, NEAR, TIA, DOGE, TRX, ADA, DOT, ATOM, LTC, XLM, XMR, ICP, FIL, and AR. Their native or chain-specific identity is not represented by a curated exact DEX token address in the current mapping. Wrapped or bridged substitutes are not guessed. DEX Screener's documented token lookup accepts token addresses and returns pair data; see its [API reference](https://docs.dexscreener.com/api/reference).
- **DeFiLlama: 11 of 50 curated protocol associations.** These are project-to-protocol associations, not token-level measurements. Existing mappings are Aave, Uniswap, and Lido. Additions are:

| Token | Exact DeFiLlama record | Scope note |
| --- | --- | --- |
| CRV | `curve-dex` (Curve DEX) | Protocol-wide Curve activity, not CRV-token activity |
| COMP | `compound-v3` (Compound V3) | Compound V3 record only; not every Compound version |
| PENDLE | `pendle` (Pendle V2) | Pendle V2 record |
| ENA | `ethena` (Ethena USDe) | The provider record is specifically the USDe protocol record |
| RAY | `raydium` (Raydium AMM) | Protocol-wide AMM activity, not RAY-token activity |
| JTO | `jito` (Jito Liquid Staking) | Liquid-staking protocol scope |
| AERO | `aerodrome` (Aerodrome V1) | V1 record only, not every deployment |
| MORPHO | `morpho-blue` (Morpho Blue) | Morpho Blue record only, not all Morpho products |

No DeFiLlama mapping was added for Dai, Ondo, or The Graph: their token-to-protocol relationship was not sufficiently precise for the provider records selected. Native assets also are not given protocol IDs based on ticker or chain name. Protocol-level metrics are annotated as protocol-wide in observations and must not be presented as activity intrinsic to the associated token. The configured written-permission gate remains in effect. See the [DeFiLlama API documentation](https://api-docs.defillama.com/).

## Collection and verification

Run the server-side collectors in this order so CoinGecko first upserts the expanded canonical rows:

```bash
pnpm coingecko:sync
pnpm defillama:sync
pnpm dexscreener:sync
pnpm metrics:calculate
```

CoinGecko collection creates or updates the canonical `chains`, `tokens`, and `provider_token_mappings` rows. The provider adapters store raw responses separately from normalized observations; DEX Screener also stores exact token-to-pair mappings. For DeFiLlama, the raw record retains provider identity, current chain TVL, and TVL history within the same 90-day window used by normalization; older TVL points and unrelated response fields are omitted to keep raw inserts bounded. The deterministic metrics engine then calculates only metrics supported by stored observations. These commands do not change the demo-backed UI. They make live provider requests when run and require the configured server-side credentials/permission settings documented by each provider guide.

The fixture suite includes universe-identity and mapping-uniqueness checks. `pnpm test`, `pnpm lint`, and `pnpm build` validate the integration without making provider calls.
