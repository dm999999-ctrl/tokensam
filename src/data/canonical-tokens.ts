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

export const canonicalTokens: CanonicalTokenDefinition[] = [...originalTwenty, ...additionalThirty];
export const additionalCanonicalTokens = additionalThirty;
