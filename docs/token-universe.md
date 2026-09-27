# Canonical token universe

The universe is 100 canonical tokens on 46 chains: the verified 50 from Phase 10 (unchanged, same IDs and order) plus 50 added in Phase 15. Current per-token coverage, generated from stored data, is in [provider-coverage.md](provider-coverage.md). Regenerate it with `pnpm coverage:report`.

This curated universe is what the Dashboard and Token Profiles read today, and Phase A does not change that. A separate, much larger machine-validated candidate pool (heading toward a future Active 1,000 plus reserve) is being built alongside it; see [universe-phase-a.md](universe-phase-a.md).

# Phase 10: 20 to 50 tokens

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

## Provider mapping coverage (Phase 10, historical)

The counts in this section describe the universe at Phase 10. The wrapped-proxy cleanup later reduced DEX Screener coverage of the 50 to 31, and several labels were corrected; see [provider-coverage.md](provider-coverage.md) for current figures.


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

# Phase 15: 50 to 100 tokens

## Selection

The 50 additions were chosen to fill gaps in the 50-token baseline, not by market-cap rank. The baseline had no restaking, RWA, privacy, DePIN, AI/compute, interoperability, derivatives, gaming, exchange-token or identity assets. Twenty of its 50 tokens were on Ethereum, and 23 chains had a single token. After Phase 15 the universe has 22 categories (was 12) and 46 chains (was 25).

Assets considered and not added: OSMO, IOTX, VELO, EUL and FRAX (small or thin markets), AXL and 1INCH (sector already covered), OKB (exchange tokens are represented by LEO and CRO), and TRUMP and FLOKI (meme assets are already represented by DOGE, SHIB, PEPE, BONK and WIF). `mantra-dao` does not exist in the CoinGecko catalog and was dropped.

## Identity rules applied

- Every token uses an explicit CoinGecko ID, verified on 2026-09-25 against `/coins/list?include_platform=true` (identity and platform addresses) and `/coins/markets` (market data, image, supply). Two requests covered all candidates.
- Contract tokens use CoinGecko's platform address on the stated chain. Deployments on other chains, including the same address reused on another chain (for example ZRO), are separate assets and are not combined.
- Native assets have no contract address. A native asset is mapped to DEX Screener only when CoinGecko lists an own-chain identifier for the native asset itself **and** DEX Screener returns exact-address pairs for it: TON (`EQAAAA…M9c`, appears only as a quote token, so no DEX price is derived) and HYPE (HyperCore token `0x0d01…b4011ec`, an order book with no pool liquidity reported). No wrapped token (WETH, wSOL, WBNB, WAVAX, WHYPE, wS, WCRO and others) is used for a native asset.
- Names and symbols follow CoinGecko's current record. For example, TON is listed as "Gram (prev. Toncoin)", symbol GRAM. STRK is the Ethereum L1 contract and is labelled "(Ethereum representation)".

## Added assets

| Symbol | Name | Chain | Category | CoinGecko ID | DeFiLlama protocol (protocol scope) | DEX Screener (market scope) |
| --- | --- | --- | --- | --- | --- | --- |
| GRAM | Gram (prev. Toncoin) | TON | Layer 1 | `the-open-network` | None: native asset; chain-level TVL is never used. | `ton:EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c` (quote-side only: no DEX price) |
| HBAR | Hedera | Hedera | Layer 1 | `hedera-hashgraph` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native HBAR; wrapped HBAR is a distinct asset and is not substituted. |
| ALGO | Algorand | Algorand | Layer 1 | `algorand` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native ALGO; no representation is substituted. |
| KAS | Kaspa | Kaspa | Layer 1 | `kaspa` | None: native asset; chain-level TVL is never used. | — Native KAS has no token contract; bridged representations are not substituted. |
| SEI | Sei | Sei | Layer 1 | `sei-network` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native SEI; wrapped SEI is a distinct asset and is not substituted. |
| INJ | Injective | Injective | Layer 1 | `injective-protocol` | Declined: the matching record is the Injective Orderbook exchange module of a general-purpose L1. | — CoinGecko lists no Injective-chain identifier for native INJ; its Ethereum, BNB Chain, Solana, and IBC representations are distinct and not substituted. |
| BCH | Bitcoin Cash | Bitcoin Cash | Payments | `bitcoin-cash` | None: native asset; chain-level TVL is never used. | — Native BCH has no token contract; bridged representations are not substituted. |
| ETC | Ethereum Classic | Ethereum Classic | Layer 1 | `ethereum-classic` | None: native asset; chain-level TVL is never used. | — Native ETC has no token contract; wrapped ETC is a distinct asset and is not substituted. |
| VET | VeChain | VeChain | Layer 1 | `vechain` | None: native asset; chain-level TVL is never used. | — CoinGecko lists an empty VeChain identifier for native VET; wrapped VET is a distinct asset and is not substituted. |
| S | Sonic | Sonic | Layer 1 | `sonic-3` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native S; wrapped S is a distinct asset and is not substituted. |
| HYPE | Hyperliquid | Hyperliquid | Derivatives | `hyperliquid` | `hyperliquid` → `parent#hyperliquid` | `hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec` (order book: no pool liquidity) |
| TAO | Bittensor | Bittensor | AI & compute | `bittensor` | None: native asset; chain-level TVL is never used. | — Native TAO has no token contract; wrapped TAO is a distinct asset and is not substituted. |
| CRO | Cronos | Cronos | Exchange token | `crypto-com-chain` | Declined: the matching record (Defi Swap) is a DEX product CRO does not govern. | — CoinGecko lists no Cronos-chain identifier for native CRO; wrapped CRO and the Ethereum representation are distinct and not substituted. |
| ZEC | Zcash | Zcash | Privacy | `zcash` | None: native asset; chain-level TVL is never used. | — Native ZEC has no token contract; bridged representations are not substituted. |
| AKT | Akash Network | Akash | AI & compute | `akash-network` | None: native asset; chain-level TVL is never used. | — Native AKT (denom uakt) is on a chain DEX Screener does not cover; IBC representations on other chains are distinct and not substituted. |
| DYDX | dYdX | dYdX Chain | Derivatives | `dydx-chain` | `dydx` → `parent#dydx` | — Native DYDX has no DEX Screener-covered identifier; the legacy Ethereum ethDYDX token and IBC representations are distinct and not substituted. |
| RUNE | THORChain | THORChain | Interoperability | `thorchain` | `thorchain-dex` → `412` | — CoinGecko lists an empty THORChain identifier for native RUNE; no representation is substituted. |
| STX | Stacks | Stacks | Layer 2 | `blockstack` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native STX; no representation is substituted. |
| XTZ | Tezos | Tezos | Layer 1 | `tezos` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native XTZ; no representation is substituted. |
| THETA | Theta Network | Theta | DePIN | `theta-token` | None: native asset; chain-level TVL is never used. | — CoinGecko lists no own-chain identifier for native THETA; no representation is substituted. |
| STRK | Starknet (Ethereum representation) | Ethereum | Layer 2 | `starknet` | Declined: the matching record is the Starknet canonical bridge (effectively chain-level TVL). | `ethereum:0xca14007eff0db1f8135f4c25b34de49ab0d42766` |
| ZK | ZKsync | ZKsync Era | Layer 2 | `zksync` | None: no DeFiLlama record carries this CoinGecko ID. | `zksync:0x5a7d6b2f92c77fad6ccabd7ee0624e64907eaf3e` |
| IMX | Immutable | Ethereum | Gaming | `immutable-x` | Declined: the matching record covers only the ImmutableX NFT marketplace. | `ethereum:0xf57e7e7c23978c3caec3c3548e3d615c346e79ff` |
| CAKE | PancakeSwap | BNB Chain | DEX | `pancakeswap-token` | `pancakeswap` → `parent#pancakeswap` | `bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82` |
| ORCA | Orca | Solana | DEX | `orca` | `orca` → `parent#orca` | `solana:orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` |
| GMX | GMX | Arbitrum | Derivatives | `gmx` | `gmx` → `parent#gmx` | `arbitrum:0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a` |
| KMNO | Kamino | Solana | Lending | `kamino` | `kamino` → `parent#kamino-finance` | `solana:KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS` |
| SYRUP | Maple Finance | Ethereum | RWA | `syrup` | `maple-finance` → `parent#maple-finance` | `ethereum:0x643c4e15d7d62ad0abec4a9bd4b001aa3ef52d66` |
| RPL | Rocket Pool | Ethereum | Liquid staking | `rocket-pool` | `rocket-pool` → `900` | `ethereum:0xd33526068d116ce69f19a9ee46f0bd304f21a51f` |
| EIGEN | EigenCloud (prev. EigenLayer) | Ethereum | Restaking | `eigenlayer` | `eigencloud` → `3107` | `ethereum:0xec53bf9167f50cdeb3ae105f56099aaab9061f83` |
| ETHFI | Ether.fi | Ethereum | Restaking | `ether-fi` | `ether.fi` → `parent#ether-fi` | `ethereum:0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb` |
| CVX | Convex Finance | Ethereum | DeFi | `convex-finance` | `convex-finance` → `319` | `ethereum:0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b` |
| USDe | Ethena USDe | Ethereum | Stablecoin | `ethena-usde` | None: a stablecoin has no governance relationship with an issuer protocol record. | `ethereum:0x4c9edd5852cd905f086c759e8383e09bff1e68b3` |
| USDS | USDS | Ethereum | Stablecoin | `usds` | None: a stablecoin has no governance relationship with an issuer protocol record. | `ethereum:0xdc035d45d973e3ec169d2276ddab16f1e407384f` |
| PYUSD | PayPal USD | Ethereum | Stablecoin | `paypal-usd` | None: a stablecoin has no governance relationship with an issuer protocol record. | `ethereum:0x6c3ea9036406852006290770bedfcaba0e23a0e8` |
| EURC | EURC | Ethereum | Stablecoin | `euro-coin` | None: a stablecoin has no governance relationship with an issuer protocol record. | `ethereum:0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` |
| ZRO | LayerZero | Ethereum | Interoperability | `layerzero` | `layerzero` → `parent#layerzero` | `ethereum:0x6985884c4392d348587b19cb9eaaf157f13271cd` |
| W | Wormhole | Solana | Interoperability | `wormhole` | Declined: the matching record is the Portal bridge application, not the Wormhole protocol. | `solana:85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ` |
| QNT | Quant | Ethereum | Interoperability | `quant-network` | None: no DeFiLlama record carries this CoinGecko ID. | `ethereum:0x4a220e6096b25eadb88358cb44068a3248254675` |
| HNT | Helium | Solana | DePIN | `helium` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `solana:hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux` |
| FET | Artificial Superintelligence Alliance | Ethereum | AI & compute | `fetch-ai` | None: no DeFiLlama record carries this CoinGecko ID. | `ethereum:0xaea46a60368a7bd060eec7df8cba43b7ef41ad85` |
| VIRTUAL | Virtuals Protocol | Base | AI & compute | `virtual-protocol` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `base:0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b` |
| SAND | The Sandbox | Ethereum | Gaming | `the-sandbox` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `ethereum:0x3845badade8e6dff049820680d1f14bd3903a5d0` |
| WIF | dogwifhat | Solana | Meme asset | `dogwifcoin` | None: no DeFiLlama record carries this CoinGecko ID. | `solana:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |
| ENS | Ethereum Name Service | Ethereum | Identity | `ethereum-name-service` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `ethereum:0xc18360217d8f7ab5e7c516566761ea12ce7f9d72` |
| GRASS | Grass | Solana | DePIN | `grass` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `solana:Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs` |
| ATH | Aethir | Ethereum | AI & compute | `aethir` | Deferred: fee-only record; its TVL of 0 would be stored as a real value. | `ethereum:0xbe0ed4138121ecfc5c0e56b40517da27e6c5226b` |
| PLUME | Plume | Ethereum | RWA | `plume` | None: no DeFiLlama record carries this CoinGecko ID. | `ethereum:0x4c1746a800d224393fe2470c70a35717ed4ea5f1` |
| LEO | LEO Token | Ethereum | Exchange token | `leo-token` | None: no DeFiLlama record carries this CoinGecko ID. | `ethereum:0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3` |
| WLD | Worldcoin | Ethereum | Identity | `worldcoin-wld` | None: no DeFiLlama record carries this CoinGecko ID. | `ethereum:0x163f8c2467924be0ae7b5347228cabf260318753` |

## DeFiLlama protocol associations

Thirteen associations were added, bringing the total to 24. Each uses DeFiLlama's own link: the protocol record's `geckoId` equals the token's curated CoinGecko ID. Each record ID was pinned from `/summary/fees/{slug}`, which returned exactly that ID on 2026-09-25. The existing parent/child safeguard rejects any response from a different record. Two slugs are not the record name: Kamino resolves at `kamino` (parent `parent#kamino-finance`) and ether.fi at `ether.fi` (parent `parent#ether-fi`).

HYPE, DYDX and RUNE are native chain assets that map to their **exchange protocol records** (Hyperliquid, dYdX and THORChain DEX). This is protocol-scope data. It is not the chain-level TVL of Hyperliquid L1, dYdX Chain or THORChain, which is never used.

Records carrying a candidate's `geckoId` were reviewed and **not** mapped where the relationship is not the token's own protocol, or where the data would misrepresent it:

- INJ: Injective Orderbook, one module of a general-purpose L1.
- W: Portal, a bridge application built on Wormhole.
- STRK: Starknet Bridge, a canonical bridge and therefore effectively chain-level.
- CRO: Defi Swap, which CRO does not govern.
- IMX: ImmutableX, the NFT marketplace only.
- SAND, ENS, VIRTUAL, ATH, HNT and GRASS: fee-only records that report TVL as 0. The current-TVL collector would store that 0 as a real value, so these mappings are deferred until the collector can mark TVL as not applicable.
- Stablecoins (USDe, USDS, PYUSD, EURC): no governance relationship. Issuer-protocol TVL is not a stablecoin metric.

## Phase 15 run log (2026-09-25)

| Step | Requests | Runtime | Rate limits / retries | Result |
| --- | --- | --- | --- | --- |
| Identity validation (CoinGecko list + markets) | 2 | < 2 s | 0 / 0 | 69 candidates checked, 1 not found |
| Candidate discovery (DEX Screener, DeFiLlama) | 9 + 1 + 28 | ~2 min | 0 / 0 | pairs and record IDs verified |
| Representative test (10 tokens, 4 providers) | 1 + 6 + 15 + 1 | ~32 s | 0 / 0 | all scopes and identifiers correct |
| CoinGecko 90-day backfill (50 new tokens only) | 100 | 358 s | 0 / 0 | 37,812 observations (753–759 per token) |
| DeFiLlama TVL history (13 new protocols only) | 13 | 70 s | 0 / 0 | 1,180 dated TVL points; all records matched |
| Metrics calculation | 0 | 12 s | — | 2,800 rows, 0 invalid |
| Full refresh, 100 tokens (orchestrator, `--force`) | 90 (CoinGecko 1, DEX Screener 13, DeFiLlama 72, DeFiLlama prices 4) | 127 s (DeFiLlama step 109 s) | 0 / 0 | all steps succeeded; 1,137 / 2,800 metrics available |

At 24 protocols, the DeFiLlama current step (3 requests per protocol, paced 1.1 s) took 109 s against its 120 s budget. The budget is now 150 s. Pacing is unchanged. Providers run in parallel, and 150 s plus the 90 s metrics budget stays below the cron route's 300 s `maxDuration`.

The existing 50 were not re-backfilled. The backfill script still limits a run to 50 tokens and defaults to the whole universe, so pass `--tokens` to target a subset.

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
