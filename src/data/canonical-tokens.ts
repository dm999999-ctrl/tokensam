import { demoTokens } from "./demo-tokens.ts";
import { dexScreenerTokenMappings } from "./dexscreener-token-mappings.ts";
import { nativeTokenIds } from "./coingecko-token-mappings.ts";

export type CanonicalTokenDefinition = {
  id: string;
  name: string;
  symbol: string;
  chainId: string;
  chainName: string;
  category: string;
  isNative: boolean;
  contractAddress: string | null;
  identityNote: string | null;
};

const chainIdFromName = (chainName: string) => chainName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dexByTokenId = new Map(dexScreenerTokenMappings.map((mapping) => [mapping.tokenId, mapping]));

const originalTwenty: CanonicalTokenDefinition[] = demoTokens.map((token) => {
  const isNative = nativeTokenIds.has(token.id);
  const dex = dexByTokenId.get(token.id);
  return {
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    chainId: chainIdFromName(token.chain),
    chainName: token.chain,
    category: token.category,
    isNative,
    contractAddress: isNative ? null : dex?.tokenAddress ?? null,
    // Natives without a verified DEX identity get a plain native-asset note, never a wrapped-proxy note.
    identityNote: dex?.identityNote || (isNative ? `Native ${token.name} asset on ${token.chain}.` : null),
  };
});

/**
 * Additional identities are chain-scoped and were reconciled against
 * CoinGecko's /coins/list?include_platform=true response on 2026-09-24.
 * Contract-bearing entries use that exact coin ID + platform address.
 * Native-chain assets intentionally have no contract address.
 */
const additionalThirty: CanonicalTokenDefinition[] = [
  { id: "ethereum-usdt", name: "Tether", symbol: "USDT", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", identityNote: "Ethereum Tether contract; other-chain USDT deployments remain distinct assets." },
  { id: "ethereum-usdc", name: "USDC", symbol: "USDC", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", identityNote: "Ethereum USDC contract; other-chain USDC deployments remain distinct assets." },
  { id: "ethereum-wbtc", name: "Wrapped Bitcoin", symbol: "WBTC", chainId: "ethereum", chainName: "Ethereum", category: "Wrapped asset", isNative: false, contractAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", identityNote: "Ethereum WBTC contract; this is the wrapped token, not native Bitcoin." },
  { id: "dogecoin-doge", name: "Dogecoin", symbol: "DOGE", chainId: "dogecoin", chainName: "Dogecoin", category: "Payments", isNative: true, contractAddress: null, identityNote: "Native Dogecoin asset; bridged DOGE representations are not substituted." },
  { id: "tron-trx", name: "TRON", symbol: "TRX", chainId: "tron", chainName: "TRON", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native TRON asset; TRC-20 or wrapped deployments are not substituted." },
  { id: "cardano-ada", name: "Cardano", symbol: "ADA", chainId: "cardano", chainName: "Cardano", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Cardano asset." },
  { id: "polkadot-dot", name: "Polkadot", symbol: "DOT", chainId: "polkadot", chainName: "Polkadot", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Polkadot asset; bridged DOT is not substituted." },
  { id: "cosmos-atom", name: "Cosmos Hub", symbol: "ATOM", chainId: "cosmos", chainName: "Cosmos Hub", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Cosmos Hub asset; the CoinGecko BNB representation is not used as canonical identity." },
  { id: "litecoin-ltc", name: "Litecoin", symbol: "LTC", chainId: "litecoin", chainName: "Litecoin", category: "Payments", isNative: true, contractAddress: null, identityNote: "Native Litecoin asset." },
  { id: "stellar-xlm", name: "Stellar", symbol: "XLM", chainId: "stellar", chainName: "Stellar", category: "Payments", isNative: true, contractAddress: null, identityNote: "Native Stellar asset; Stellar issued assets are distinct." },
  { id: "monero-xmr", name: "Monero", symbol: "XMR", chainId: "monero", chainName: "Monero", category: "Payments", isNative: true, contractAddress: null, identityNote: "Native Monero asset." },
  { id: "internet-computer-icp", name: "Internet Computer", symbol: "ICP", chainId: "internet-computer", chainName: "Internet Computer", category: "Infrastructure", isNative: true, contractAddress: null, identityNote: "Native ICP ledger asset; CoinGecko's Ethereum/Base representations are not used as canonical identity." },
  { id: "filecoin-fil", name: "Filecoin", symbol: "FIL", chainId: "filecoin", chainName: "Filecoin", category: "Infrastructure", isNative: true, contractAddress: null, identityNote: "Native Filecoin asset; wrapped FIL deployments are not substituted." },
  { id: "ethereum-crv", name: "Curve DAO", symbol: "CRV", chainId: "ethereum", chainName: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0xd533a949740bb3306d119cc777fa900ba034cd52", identityNote: "Ethereum CRV governance-token contract." },
  { id: "ethereum-comp", name: "Compound", symbol: "COMP", chainId: "ethereum", chainName: "Ethereum", category: "Lending", isNative: false, contractAddress: "0xc00e94cb662c3520282e6f5717214004a7f26888", identityNote: "Ethereum COMP governance-token contract." },
  { id: "ethereum-pendle", name: "Pendle", symbol: "PENDLE", chainId: "ethereum", chainName: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0x808507121b80c02388fad14726482e061b8da827", identityNote: "Ethereum PENDLE contract; other-chain deployments remain distinct." },
  { id: "ethereum-dai", name: "Dai", symbol: "DAI", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f", identityNote: "Ethereum DAI contract; not conflated with USDS or other DAI deployments." },
  { id: "ethereum-ena", name: "Ethena", symbol: "ENA", chainId: "ethereum", chainName: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0x57e114b691db790c35207b2e685d4a43181e6061", identityNote: "Ethereum ENA governance-token contract; other-chain representations remain distinct." },
  { id: "ethereum-ondo", name: "Ondo", symbol: "ONDO", chainId: "ethereum", chainName: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", identityNote: "Ethereum ONDO contract; token is not treated as the Ondo protocol entity." },
  { id: "ethereum-shib", name: "Shiba Inu", symbol: "SHIB", chainId: "ethereum", chainName: "Ethereum", category: "Meme asset", isNative: false, contractAddress: "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce", identityNote: "Ethereum SHIB contract; bridged copies are not substituted." },
  { id: "ethereum-pepe", name: "Pepe", symbol: "PEPE", chainId: "ethereum", chainName: "Ethereum", category: "Meme asset", isNative: false, contractAddress: "0x6982508145454ce325ddbe47a25d4ec3d2311933", identityNote: "Ethereum PEPE contract; other-chain lookalikes are not substituted." },
  { id: "solana-bonk", name: "Bonk", symbol: "BONK", chainId: "solana", chainName: "Solana", category: "Meme asset", isNative: false, contractAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", identityNote: "Canonical BONK mint on Solana." },
  { id: "solana-ray", name: "Raydium", symbol: "RAY", chainId: "solana", chainName: "Solana", category: "DEX", isNative: false, contractAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", identityNote: "Canonical RAY mint on Solana." },
  { id: "solana-jto", name: "Jito", symbol: "JTO", chainId: "solana", chainName: "Solana", category: "Liquid staking", isNative: false, contractAddress: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", identityNote: "Canonical JTO mint on Solana; separate from JitoSOL." },
  { id: "solana-pyth", name: "Pyth Network", symbol: "PYTH", chainId: "solana", chainName: "Solana", category: "Oracle", isNative: false, contractAddress: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", identityNote: "Canonical PYTH mint on Solana." },
  { id: "base-aero", name: "Aerodrome Finance", symbol: "AERO", chainId: "base", chainName: "Base", category: "DEX", isNative: false, contractAddress: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", identityNote: "Canonical AERO token contract on Base." },
  { id: "ethereum-morpho", name: "Morpho", symbol: "MORPHO", chainId: "ethereum", chainName: "Ethereum", category: "Lending", isNative: false, contractAddress: "0x58d97b57bb95320f9a05dc918aef65434969c2b2", identityNote: "Ethereum MORPHO token; not conflated with the Morpho protocol entity." },
  { id: "ethereum-grt", name: "The Graph", symbol: "GRT", chainId: "ethereum", chainName: "Ethereum", category: "Oracle", isNative: false, contractAddress: "0xc944e90c64b2c07662a292be6244bdf05cda44a7", identityNote: "Ethereum GRT token contract." },
  { id: "arweave-ar", name: "Arweave", symbol: "AR", chainId: "arweave", chainName: "Arweave", category: "Infrastructure", isNative: true, contractAddress: null, identityNote: "Native Arweave asset; bridged tokens are not substituted." },
  { id: "ethereum-mnt", name: "Mantle (Ethereum representation)", symbol: "MNT", chainId: "ethereum", chainName: "Ethereum", category: "Layer 2", isNative: false, contractAddress: "0x3c3a81e81dc49a522a592e7622a7e711c06bf354", identityNote: "Ethereum MNT representation returned by CoinGecko; this is not a native Mantle-chain asset." },
];

/**
 * Phase 15 expansion (50 → 100), chosen for sector and chain coverage rather
 * than market-cap rank. Reconciled against CoinGecko /coins/list?include_platform=true
 * and /coins/markets on 2026-09-25: each entry uses that exact coin ID and, for
 * contract tokens, the exact platform address on the stated chain. Names and
 * symbols follow CoinGecko's current record (e.g. TON is listed as "Gram (prev.
 * Toncoin)", symbol GRAM). Native assets carry no contract address; bridged and
 * wrapped representations on other chains are distinct assets, never merged.
 */
const phase15Fifty: CanonicalTokenDefinition[] = [
  // Native Layer 1 / chain assets
  { id: "ton-gram", name: "Gram (prev. Toncoin)", symbol: "GRAM", chainId: "ton", chainName: "TON", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native TON-chain asset (CoinGecko renamed Toncoin to Gram); the Ethereum and BNB Chain representations are not used." },
  { id: "hedera-hbar", name: "Hedera", symbol: "HBAR", chainId: "hedera", chainName: "Hedera", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Hedera asset; wrapped HBAR is not substituted." },
  { id: "algorand-algo", name: "Algorand", symbol: "ALGO", chainId: "algorand", chainName: "Algorand", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Algorand asset." },
  { id: "kaspa-kas", name: "Kaspa", symbol: "KAS", chainId: "kaspa", chainName: "Kaspa", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Kaspa asset; bridged representations are not substituted." },
  { id: "sei-sei", name: "Sei", symbol: "SEI", chainId: "sei", chainName: "Sei", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Sei asset; wrapped SEI is not substituted." },
  { id: "injective-inj", name: "Injective", symbol: "INJ", chainId: "injective", chainName: "Injective", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Injective-chain asset; CoinGecko's Ethereum, BNB Chain, Solana, and IBC representations are not used as canonical identity." },
  { id: "bitcoin-cash-bch", name: "Bitcoin Cash", symbol: "BCH", chainId: "bitcoin-cash", chainName: "Bitcoin Cash", category: "Payments", isNative: true, contractAddress: null, identityNote: "Native Bitcoin Cash asset; not Bitcoin and not a wrapped representation." },
  { id: "ethereum-classic-etc", name: "Ethereum Classic", symbol: "ETC", chainId: "ethereum-classic", chainName: "Ethereum Classic", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Ethereum Classic asset; distinct from ETH and from wrapped ETC." },
  { id: "vechain-vet", name: "VeChain", symbol: "VET", chainId: "vechain", chainName: "VeChain", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native VeChain asset; wrapped VET is not substituted." },
  { id: "sonic-s", name: "Sonic", symbol: "S", chainId: "sonic", chainName: "Sonic", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Sonic asset; wrapped S is not substituted." },
  { id: "hyperliquid-hype", name: "Hyperliquid", symbol: "HYPE", chainId: "hyperliquid", chainName: "Hyperliquid", category: "Derivatives", isNative: true, contractAddress: null, identityNote: "Native HYPE on Hyperliquid (HyperCore token 0x0d01dc56dcaaca66ad901c959b4011ec per CoinGecko); wrapped HYPE on HyperEVM is not substituted." },
  { id: "bittensor-tao", name: "Bittensor", symbol: "TAO", chainId: "bittensor", chainName: "Bittensor", category: "AI & compute", isNative: true, contractAddress: null, identityNote: "Native Bittensor asset; wrapped TAO is not substituted." },
  { id: "cronos-cro", name: "Cronos", symbol: "CRO", chainId: "cronos", chainName: "Cronos", category: "Exchange token", isNative: true, contractAddress: null, identityNote: "Native Cronos-chain asset; the Ethereum CRO representation and wrapped CRO are not used as canonical identity." },
  { id: "zcash-zec", name: "Zcash", symbol: "ZEC", chainId: "zcash", chainName: "Zcash", category: "Privacy", isNative: true, contractAddress: null, identityNote: "Native Zcash asset; bridged representations are not substituted." },
  { id: "akash-akt", name: "Akash Network", symbol: "AKT", chainId: "akash", chainName: "Akash", category: "AI & compute", isNative: true, contractAddress: null, identityNote: "Native Akash asset (denom uakt); IBC representations on other Cosmos chains are distinct." },
  { id: "dydx-dydx", name: "dYdX", symbol: "DYDX", chainId: "dydx", chainName: "dYdX Chain", category: "Derivatives", isNative: true, contractAddress: null, identityNote: "Native dYdX Chain asset (CoinGecko dydx-chain); the legacy Ethereum ethDYDX token and IBC representations are distinct." },
  { id: "thorchain-rune", name: "THORChain", symbol: "RUNE", chainId: "thorchain", chainName: "THORChain", category: "Interoperability", isNative: true, contractAddress: null, identityNote: "Native THORChain asset." },
  { id: "stacks-stx", name: "Stacks", symbol: "STX", chainId: "stacks", chainName: "Stacks", category: "Layer 2", isNative: true, contractAddress: null, identityNote: "Native Stacks asset (Bitcoin layer); not BTC." },
  { id: "tezos-xtz", name: "Tezos", symbol: "XTZ", chainId: "tezos", chainName: "Tezos", category: "Layer 1", isNative: true, contractAddress: null, identityNote: "Native Tezos asset." },
  { id: "theta-theta", name: "Theta Network", symbol: "THETA", chainId: "theta", chainName: "Theta", category: "DePIN", isNative: true, contractAddress: null, identityNote: "Native Theta asset." },
  // Contract tokens: chain + exact CoinGecko platform address
  { id: "ethereum-strk", name: "Starknet (Ethereum representation)", symbol: "STRK", chainId: "ethereum", chainName: "Ethereum", category: "Layer 2", isNative: false, contractAddress: "0xca14007eff0db1f8135f4c25b34de49ab0d42766", identityNote: "Ethereum L1 STRK contract (CoinGecko starknet, platforms.ethereum); the Starknet-chain and Solana deployments are distinct and not combined." },
  { id: "zksync-zk", name: "ZKsync", symbol: "ZK", chainId: "zksync", chainName: "ZKsync Era", category: "Layer 2", isNative: false, contractAddress: "0x5a7d6b2f92c77fad6ccabd7ee0624e64907eaf3e", identityNote: "ZK token contract on ZKsync Era (not the chain's gas asset, which is ETH); the Ethereum representation is distinct." },
  { id: "ethereum-imx", name: "Immutable", symbol: "IMX", chainId: "ethereum", chainName: "Ethereum", category: "Gaming", isNative: false, contractAddress: "0xf57e7e7c23978c3caec3c3548e3d615c346e79ff", identityNote: "Ethereum IMX contract." },
  { id: "bnb-chain-cake", name: "PancakeSwap", symbol: "CAKE", chainId: "bnb-chain", chainName: "BNB Chain", category: "DEX", isNative: false, contractAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", identityNote: "CAKE contract on BNB Chain; the Ethereum, Base, Arbitrum, Solana, and other deployments are distinct." },
  { id: "solana-orca", name: "Orca", symbol: "ORCA", chainId: "solana", chainName: "Solana", category: "DEX", isNative: false, contractAddress: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", identityNote: "Canonical ORCA mint on Solana." },
  { id: "arbitrum-gmx", name: "GMX", symbol: "GMX", chainId: "arbitrum", chainName: "Arbitrum", category: "Derivatives", isNative: false, contractAddress: "0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a", identityNote: "GMX contract on Arbitrum One; the Avalanche deployment is distinct." },
  { id: "solana-kmno", name: "Kamino", symbol: "KMNO", chainId: "solana", chainName: "Solana", category: "Lending", isNative: false, contractAddress: "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS", identityNote: "Canonical KMNO mint on Solana." },
  { id: "ethereum-syrup", name: "Maple Finance", symbol: "SYRUP", chainId: "ethereum", chainName: "Ethereum", category: "RWA", isNative: false, contractAddress: "0x643c4e15d7d62ad0abec4a9bd4b001aa3ef52d66", identityNote: "Ethereum SYRUP contract (Maple Finance); distinct from syrupUSDC and other Maple pool tokens, and from the Base deployment." },
  { id: "ethereum-rpl", name: "Rocket Pool", symbol: "RPL", chainId: "ethereum", chainName: "Ethereum", category: "Liquid staking", isNative: false, contractAddress: "0xd33526068d116ce69f19a9ee46f0bd304f21a51f", identityNote: "Ethereum RPL governance-token contract; distinct from the rETH liquid-staking token." },
  { id: "ethereum-eigen", name: "EigenCloud (prev. EigenLayer)", symbol: "EIGEN", chainId: "ethereum", chainName: "Ethereum", category: "Restaking", isNative: false, contractAddress: "0xec53bf9167f50cdeb3ae105f56099aaab9061f83", identityNote: "Ethereum EIGEN contract; the Base deployment is distinct." },
  { id: "ethereum-ethfi", name: "Ether.fi", symbol: "ETHFI", chainId: "ethereum", chainName: "Ethereum", category: "Restaking", isNative: false, contractAddress: "0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb", identityNote: "Ethereum ETHFI governance-token contract; distinct from eETH/weETH." },
  { id: "ethereum-cvx", name: "Convex Finance", symbol: "CVX", chainId: "ethereum", chainName: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b", identityNote: "Ethereum CVX contract; distinct from vlCVX and cvxCRV." },
  { id: "ethereum-usde", name: "Ethena USDe", symbol: "USDe", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", identityNote: "Ethereum USDe contract; distinct from sUSDe, from ENA, and from other-chain USDe deployments." },
  { id: "ethereum-usds", name: "USDS", symbol: "USDS", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", identityNote: "Ethereum USDS contract; not conflated with DAI or sUSDS." },
  { id: "ethereum-pyusd", name: "PayPal USD", symbol: "PYUSD", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", identityNote: "Ethereum PYUSD contract; other-chain PYUSD deployments remain distinct." },
  { id: "ethereum-eurc", name: "EURC", symbol: "EURC", chainId: "ethereum", chainName: "Ethereum", category: "Stablecoin", isNative: false, contractAddress: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", identityNote: "Ethereum EURC (euro) contract; other-chain EURC deployments remain distinct." },
  { id: "ethereum-zro", name: "LayerZero", symbol: "ZRO", chainId: "ethereum", chainName: "Ethereum", category: "Interoperability", isNative: false, contractAddress: "0x6985884c4392d348587b19cb9eaaf157f13271cd", identityNote: "ZRO contract on Ethereum; the same address on other chains is a separate deployment and is not combined." },
  { id: "solana-w", name: "Wormhole", symbol: "W", chainId: "solana", chainName: "Solana", category: "Interoperability", isNative: false, contractAddress: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", identityNote: "Canonical W mint on Solana; the EVM deployments are distinct." },
  { id: "ethereum-qnt", name: "Quant", symbol: "QNT", chainId: "ethereum", chainName: "Ethereum", category: "Interoperability", isNative: false, contractAddress: "0x4a220e6096b25eadb88358cb44068a3248254675", identityNote: "Ethereum QNT contract." },
  { id: "solana-hnt", name: "Helium", symbol: "HNT", chainId: "solana", chainName: "Solana", category: "DePIN", isNative: false, contractAddress: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", identityNote: "Canonical HNT mint on Solana; distinct from MOBILE and IOT subDAO tokens." },
  { id: "ethereum-fet", name: "Artificial Superintelligence Alliance", symbol: "FET", chainId: "ethereum", chainName: "Ethereum", category: "AI & compute", isNative: false, contractAddress: "0xaea46a60368a7bd060eec7df8cba43b7ef41ad85", identityNote: "Ethereum FET contract; Cardano, BNB Chain, and IBC representations are distinct." },
  { id: "base-virtual", name: "Virtuals Protocol", symbol: "VIRTUAL", chainId: "base", chainName: "Base", category: "AI & compute", isNative: false, contractAddress: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", identityNote: "VIRTUAL contract on Base, where the protocol operates; the Ethereum and Solana deployments are distinct." },
  { id: "ethereum-sand", name: "The Sandbox", symbol: "SAND", chainId: "ethereum", chainName: "Ethereum", category: "Gaming", isNative: false, contractAddress: "0x3845badade8e6dff049820680d1f14bd3903a5d0", identityNote: "Ethereum SAND contract; Polygon and Base deployments are distinct." },
  { id: "solana-wif", name: "dogwifhat", symbol: "WIF", chainId: "solana", chainName: "Solana", category: "Meme asset", isNative: false, contractAddress: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", identityNote: "Canonical WIF mint on Solana; same-ticker lookalikes are not substituted." },
  { id: "ethereum-ens", name: "Ethereum Name Service", symbol: "ENS", chainId: "ethereum", chainName: "Ethereum", category: "Identity", isNative: false, contractAddress: "0xc18360217d8f7ab5e7c516566761ea12ce7f9d72", identityNote: "Ethereum ENS governance-token contract." },
  { id: "solana-grass", name: "Grass", symbol: "GRASS", chainId: "solana", chainName: "Solana", category: "DePIN", isNative: false, contractAddress: "Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs", identityNote: "Canonical GRASS mint on Solana." },
  { id: "ethereum-ath", name: "Aethir", symbol: "ATH", chainId: "ethereum", chainName: "Ethereum", category: "AI & compute", isNative: false, contractAddress: "0xbe0ed4138121ecfc5c0e56b40517da27e6c5226b", identityNote: "Ethereum ATH contract; Solana and Arbitrum deployments are distinct." },
  { id: "ethereum-plume", name: "Plume", symbol: "PLUME", chainId: "ethereum", chainName: "Ethereum", category: "RWA", isNative: false, contractAddress: "0x4c1746a800d224393fe2470c70a35717ed4ea5f1", identityNote: "Ethereum PLUME contract; the BNB Chain deployment is distinct." },
  { id: "ethereum-leo", name: "LEO Token", symbol: "LEO", chainId: "ethereum", chainName: "Ethereum", category: "Exchange token", isNative: false, contractAddress: "0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3", identityNote: "Ethereum LEO contract." },
  { id: "ethereum-wld", name: "Worldcoin", symbol: "WLD", chainId: "ethereum", chainName: "Ethereum", category: "Identity", isNative: false, contractAddress: "0x163f8c2467924be0ae7b5347228cabf260318753", identityNote: "Ethereum WLD contract; the Optimism and World Chain deployments are distinct." },
];

export const canonicalTokens: CanonicalTokenDefinition[] = [...originalTwenty, ...additionalThirty, ...phase15Fifty];
export const additionalCanonicalTokens = additionalThirty;
export const phase15CanonicalTokens = phase15Fifty;
