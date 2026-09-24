export type DexScreenerTokenMapping = {
  tokenId: string;
  canonicalChainId: string;
  dexChainId: string | null;
  tokenAddress: string | null;
  identityNote: string;
  mappingEvidence?: string;
  unmappedReason?: string;
};

/**
 * Address mappings are explicit canonical identities, not ticker searches.
 * A wrapped representation (WETH, wSOL, WBNB, WAVAX, WBTC...) is a distinct
 * asset and is never used as a proxy for a native token. Tokens without a
 * verified DEX identifier remain unqueried instead of being mapped by symbol.
 * Native identifiers are used only when CoinGecko lists them as the asset's
 * own-chain platform identifier AND DEX Screener reports exact-address pairs
 * for the native asset itself (checked 2026-09-25).
 * New contract mappings use the explicit CoinGecko ID + platform address
 * from /coins/list?include_platform=true, checked 2026-09-24.
 */
export const dexScreenerTokenMappings: DexScreenerTokenMapping[] = [
  { tokenId: "ethereum-eth", canonicalChainId: "ethereum", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native ETH has no token address; DEX markets trade Wrapped Ether (WETH), a distinct wrapped asset that is not substituted for ETH." },
  { tokenId: "bitcoin-btc", canonicalChainId: "bitcoin", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "No canonical Bitcoin-chain DEX Screener token address is configured; bridged BTC wrappers are distinct assets." },
  { tokenId: "solana-sol", canonicalChainId: "solana", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native SOL has no token address; DEX markets trade Wrapped SOL (the wSOL mint), a distinct wrapped asset that is not substituted for SOL." },
  { tokenId: "bnb-bnb", canonicalChainId: "bnb-chain", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native BNB has no token address; DEX markets trade Wrapped BNB (WBNB), a distinct wrapped asset that is not substituted for BNB." },
  { tokenId: "xrp-xrp", canonicalChainId: "xrp-ledger", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "XRPL native-asset address encoding has not been curated; no wrapped representation is assumed." },
  { tokenId: "avalanche-avax", canonicalChainId: "avalanche", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native AVAX has no token address; DEX markets trade Wrapped AVAX (WAVAX), a distinct wrapped asset that is not substituted for AVAX." },
  { tokenId: "arbitrum-arb", canonicalChainId: "arbitrum", dexChainId: "arbitrum", tokenAddress: "0x912CE59144191C1204E64559FE8253a0e49E6548", identityNote: "Canonical ARB token contract on Arbitrum One." },
  { tokenId: "optimism-op", canonicalChainId: "optimism", dexChainId: "optimism", tokenAddress: "0x4200000000000000000000000000000000000042", identityNote: "Canonical OP token contract on Optimism." },
  { tokenId: "aave-aave", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDAe9", identityNote: "AAVE token contract on Ethereum." },
  { tokenId: "uniswap-uni", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", identityNote: "UNI token contract on Ethereum." },
  { tokenId: "lido-ldo", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", identityNote: "LDO token contract on Ethereum." },
  { tokenId: "maker-mkr", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x56072C95FAA701256059aa122697B133aDEd9279", identityNote: "The demo record is SKY (formerly Maker); mapped to the current SKY token contract, not the legacy MKR token." },
  { tokenId: "chainlink-link", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x514910771AF9Ca656af840dff83E8264EcF986CA", identityNote: "LINK token contract on Ethereum." },
  { tokenId: "sui-sui", canonicalChainId: "sui", dexChainId: "sui", tokenAddress: "0x2::sui::SUI", identityNote: "Native SUI coin type on Sui (the native asset itself, not a wrapper).", mappingEvidence: "CoinGecko platform sui = 0x…02::sui::SUI; DEX Screener /token-pairs/v1/sui returned exact-address pairs for SUI (Sui), 2026-09-25." },
  { tokenId: "aptos-apt", canonicalChainId: "aptos", dexChainId: "aptos", tokenAddress: "0x1::aptos_coin::AptosCoin", identityNote: "Native APT coin type on Aptos (the native asset itself, not a wrapper).", mappingEvidence: "CoinGecko platform aptos = 0x1::aptos_coin::AptosCoin; DEX Screener /token-pairs/v1/aptos returned exact-address pairs for APT (Aptos Coin), 2026-09-25." },
  { tokenId: "polygon-pol", canonicalChainId: "polygon", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "CoinGecko's own-chain POL identifier (0x…1010) returned no DEX Screener pairs; DEX markets trade wrapped POL, a distinct asset." },
  { tokenId: "near-near", canonicalChainId: "near", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "No exact DEX Screener token-address representation for native NEAR is configured." },
  { tokenId: "celestia-tia", canonicalChainId: "celestia", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "No exact DEX Screener token-address representation for native TIA is configured; bridged assets are distinct." },
  { tokenId: "render-render", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", identityNote: "Official RENDER token mint on Solana." },
  { tokenId: "jupiter-jup", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", identityNote: "JUP token mint on Solana." },
  { tokenId: "ethereum-usdt", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", identityNote: "USDT on Ethereum; other chain representations are not combined.", mappingEvidence: "CoinGecko ID tether, platforms.ethereum." },
  { tokenId: "ethereum-usdc", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", identityNote: "USDC on Ethereum; other chain representations are not combined.", mappingEvidence: "CoinGecko ID usd-coin, platforms.ethereum." },
  { tokenId: "ethereum-wbtc", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", identityNote: "Ethereum WBTC market data; not native BTC or another wrapped deployment.", mappingEvidence: "CoinGecko ID wrapped-bitcoin, platforms.ethereum." },
  { tokenId: "dogecoin-doge", canonicalChainId: "dogecoin", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native Dogecoin has no token contract; no wrapped DOGE deployment is selected as canonical." },
  { tokenId: "tron-trx", canonicalChainId: "tron", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native TRX has no token contract; TRC-20/wrapped representations are not substituted." },
  { tokenId: "cardano-ada", canonicalChainId: "cardano", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native ADA has no token contract; wrapped representations are not substituted." },
  { tokenId: "polkadot-dot", canonicalChainId: "polkadot", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native DOT has no EVM contract identity; bridged deployments are not substituted." },
  { tokenId: "cosmos-atom", canonicalChainId: "cosmos", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "CoinGecko's Cosmos Hub denom (uatom) returned no DEX Screener pairs; IBC and BNB representations are different chain assets." },
  { tokenId: "litecoin-ltc", canonicalChainId: "litecoin", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native LTC has no token contract; wrapped representations are not substituted." },
  { tokenId: "stellar-xlm", canonicalChainId: "stellar", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "CoinGecko's Stellar asset-contract identifier for native XLM returned no DEX Screener pairs; Stellar-issued assets are distinct." },
  { tokenId: "monero-xmr", canonicalChainId: "monero", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native XMR has no token contract; wrapped representations are not substituted." },
  { tokenId: "internet-computer-icp", canonicalChainId: "internet-computer", dexChainId: "icp", tokenAddress: "ryjl3-tyaaa-aaaaa-aaaba-cai", identityNote: "Native ICP ledger canister on the Internet Computer (the native asset itself; the ERC-20 representations are not used).", mappingEvidence: "CoinGecko platform internet-computer = ryjl3-tyaaa-aaaaa-aaaba-cai; DEX Screener /token-pairs/v1/icp returned exact-address pairs for ICP (Internet Computer), 2026-09-25." },
  { tokenId: "filecoin-fil", canonicalChainId: "filecoin", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native FIL has no EVM token contract; wrapped representations are not substituted." },
  { tokenId: "ethereum-crv", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xd533a949740bb3306d119cc777fa900ba034cd52", identityNote: "CRV on Ethereum; other deployments remain distinct.", mappingEvidence: "CoinGecko ID curve-dao-token, platforms.ethereum." },
  { tokenId: "ethereum-comp", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xc00e94cb662c3520282e6f5717214004a7f26888", identityNote: "COMP on Ethereum; other deployments remain distinct.", mappingEvidence: "CoinGecko ID compound-governance-token, platforms.ethereum." },
  { tokenId: "ethereum-pendle", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x808507121b80c02388fad14726482e061b8da827", identityNote: "PENDLE on Ethereum; other deployments remain distinct.", mappingEvidence: "CoinGecko ID pendle, platforms.ethereum." },
  { tokenId: "ethereum-dai", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x6b175474e89094c44da98b954eedeac495271d0f", identityNote: "DAI on Ethereum; not conflated with USDS or other DAI deployments.", mappingEvidence: "CoinGecko ID dai, platforms.ethereum." },
  { tokenId: "ethereum-ena", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x57e114b691db790c35207b2e685d4a43181e6061", identityNote: "ENA on Ethereum; other chain representations remain distinct.", mappingEvidence: "CoinGecko ID ethena, platforms.ethereum." },
  { tokenId: "ethereum-ondo", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", identityNote: "ONDO token on Ethereum, not an Ondo protocol identifier.", mappingEvidence: "CoinGecko ID ondo-finance, platforms.ethereum." },
  { tokenId: "ethereum-shib", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce", identityNote: "SHIB on Ethereum; bridged copies are not substituted.", mappingEvidence: "CoinGecko ID shiba-inu, platforms.ethereum." },
  { tokenId: "ethereum-pepe", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x6982508145454ce325ddbe47a25d4ec3d2311933", identityNote: "PEPE on Ethereum; same-ticker deployments are not substituted.", mappingEvidence: "CoinGecko ID pepe, platforms.ethereum." },
  { tokenId: "solana-bonk", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", identityNote: "BONK mint on Solana; wrapped copies are distinct.", mappingEvidence: "CoinGecko ID bonk, platforms.solana." },
  { tokenId: "solana-ray", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", identityNote: "RAY mint on Solana.", mappingEvidence: "CoinGecko ID raydium, platforms.solana." },
  { tokenId: "solana-jto", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", identityNote: "JTO mint on Solana; distinct from JitoSOL.", mappingEvidence: "CoinGecko ID jito-governance-token, platforms.solana." },
  { tokenId: "solana-pyth", canonicalChainId: "solana", dexChainId: "solana", tokenAddress: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", identityNote: "PYTH mint on Solana.", mappingEvidence: "CoinGecko ID pyth-network, platforms.solana." },
  { tokenId: "base-aero", canonicalChainId: "base", dexChainId: "base", tokenAddress: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", identityNote: "AERO contract on Base; Base identity is kept separate from same-ticker tokens.", mappingEvidence: "CoinGecko ID aerodrome-finance, platforms.base." },
  { tokenId: "ethereum-morpho", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x58d97b57bb95320f9a05dc918aef65434969c2b2", identityNote: "MORPHO on Ethereum, not the protocol entity or other deployment.", mappingEvidence: "CoinGecko ID morpho, platforms.ethereum." },
  { tokenId: "ethereum-grt", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0xc944e90c64b2c07662a292be6244bdf05cda44a7", identityNote: "GRT on Ethereum; other deployments remain distinct.", mappingEvidence: "CoinGecko ID the-graph, platforms.ethereum." },
  { tokenId: "arweave-ar", canonicalChainId: "arweave", dexChainId: null, tokenAddress: null, identityNote: "", unmappedReason: "Native AR has no token contract; no wrapped representation is selected as canonical." },
  { tokenId: "ethereum-mnt", canonicalChainId: "ethereum", dexChainId: "ethereum", tokenAddress: "0x3c3a81e81dc49a522a592e7622a7e711c06bf354", identityNote: "Ethereum MNT representation only; this mapping is not the native Mantle chain token.", mappingEvidence: "CoinGecko ID mantle, platforms.ethereum." },
];

export const DEX_SCREENER_METRIC_NOTE =
  "DEX Screener pair data; selected/aggregated using explicit chain and token-address matches. Provider snapshot time is collection time because no pair-update timestamp is returned.";
