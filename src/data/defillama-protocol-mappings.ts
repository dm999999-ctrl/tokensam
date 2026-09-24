/**
 * Curated project-to-protocol associations, not token-level DeFiLlama IDs.
 * DeFiLlama's endpoints identify protocol records. Their metrics describe the
 * protocol's activity and must never be presented as intrinsic token metrics.
 * Add a mapping only after a reviewer confirms the project relationship and
 * exact DeFiLlama slug; never infer one from a ticker.
 *
 * recordId is the DeFiLlama record the slug resolved to when verified
 * (2026-09-24, from the `id` of GET /protocol/{slug} and GET /summary/fees/{slug}).
 * The collector rejects any response for a different record. A "parent" record
 * aggregates every sub-protocol DeFiLlama lists under it, and a child record
 * is one sub-protocol only. Neither is ever substituted for the other.
 */
export const defillamaProtocolMappings = [
  {
    tokenId: "aave-aave",
    chainId: "ethereum",
    externalAssetId: "aave",
    recordId: "parent#aave",
    recordKind: "parent",
    protocolName: "Aave (parent record)",
    relationship: "AAVE governance token associated with the Aave protocol; DeFiLlama's parent record aggregates every Aave version it tracks (at verification: Aave V1-V4, Arc, Aptos, Horizon RWA), not a single deployment",
  },
  {
    tokenId: "uniswap-uni",
    chainId: "ethereum",
    externalAssetId: "uniswap",
    recordId: "parent#uniswap",
    recordKind: "parent",
    protocolName: "Uniswap (parent record)",
    relationship: "UNI governance token associated with the Uniswap protocol; DeFiLlama's parent record aggregates every Uniswap version it tracks (at verification: Uniswap V1-V4, Uniswap Auctions), not a single deployment",
  },
  {
    tokenId: "lido-ldo",
    chainId: "ethereum",
    externalAssetId: "lido",
    recordId: "182",
    recordKind: "standalone",
    protocolName: "Lido",
    relationship: "LDO governance token associated with the Lido protocol",
  },
  {
    tokenId: "ethereum-crv",
    chainId: "ethereum",
    externalAssetId: "curve-dex",
    recordId: "3",
    recordKind: "child",
    protocolName: "Curve DEX",
    relationship: "CRV governance token associated with the Curve DEX protocol; child record of Curve Finance that excludes crvUSD and LlamaLend; protocol-wide metrics, not CRV-token activity",
  },
  {
    tokenId: "ethereum-comp",
    chainId: "ethereum",
    externalAssetId: "compound-v3",
    recordId: "2088",
    recordKind: "child",
    protocolName: "Compound V3",
    relationship: "COMP governance token associated with the Compound V3 protocol record; does not include every Compound version",
  },
  {
    tokenId: "ethereum-pendle",
    chainId: "ethereum",
    externalAssetId: "pendle",
    recordId: "parent#pendle",
    recordKind: "parent",
    protocolName: "Pendle (parent record)",
    relationship: "PENDLE governance token associated with Pendle; DeFiLlama's parent record aggregates every Pendle sub-protocol (at verification: Pendle V2, Boros), not Pendle V2 alone",
  },
  {
    tokenId: "ethereum-ena",
    chainId: "ethereum",
    externalAssetId: "ethena",
    recordId: "parent#ethena",
    recordKind: "parent",
    protocolName: "Ethena (parent record)",
    relationship: "ENA governance token associated with Ethena; DeFiLlama's parent record aggregates every Ethena sub-protocol (at verification: Ethena USDe, Ethena USDtb, Ethena tsUSDe), not USDe alone",
  },
  {
    tokenId: "solana-ray",
    chainId: "solana",
    externalAssetId: "raydium",
    recordId: "parent#raydium",
    recordKind: "parent",
    protocolName: "Raydium (parent record)",
    relationship: "RAY token associated with Raydium; DeFiLlama's parent record aggregates every Raydium sub-protocol (at verification: Raydium AMM, Raydium Perps, LaunchLab); protocol-wide metrics, not RAY-token activity",
  },
  {
    tokenId: "solana-jto",
    chainId: "solana",
    externalAssetId: "jito",
    recordId: "parent#jito",
    recordKind: "parent",
    protocolName: "Jito (parent record)",
    relationship: "JTO governance token associated with Jito; DeFiLlama's parent record aggregates every Jito sub-protocol (at verification: Jito Liquid Staking, Jito Restaking, Jito MEV Tips, Jito DAO), not liquid staking alone",
  },
  {
    tokenId: "base-aero",
    chainId: "base",
    externalAssetId: "aerodrome",
    recordId: "parent#aerodrome",
    recordKind: "parent",
    protocolName: "Aerodrome (parent record)",
    relationship: "AERO governance token associated with Aerodrome; DeFiLlama's parent record aggregates every Aerodrome sub-protocol (at verification: Aerodrome V1, Aerodrome Slipstream, Aerodrome Ignition, Aero Lite), not V1 alone",
  },
  {
    tokenId: "ethereum-morpho",
    chainId: "ethereum",
    externalAssetId: "morpho-blue",
    recordId: "4025",
    recordKind: "child",
    protocolName: "Morpho Blue",
    relationship: "MORPHO governance token associated with the Morpho Blue protocol record; child record of Morpho, not all Morpho products",
  },
] as const;

export const DEFILLAMA_PROTOCOL_METRIC_NOTE =
  "Protocol-level DeFiLlama metric associated by explicit project mapping; it is not a token-level metric or a valuation of the token.";
