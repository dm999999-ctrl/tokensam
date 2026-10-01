import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";
import {
  configuredDexScreenerAssets,
  DexScreenerMarketDataProvider,
  getUnmappedDexScreenerTokens,
} from "./dexscreener.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";

const REQUIRED_METRICS = [
  "price_usd",
  "volume_24h_usd",
  "liquidity_usd",
  "price_change_24h_pct",
  "transactions_24h_count",
  "buys_24h_count",
  "sells_24h_count",
  "fdv_usd",
  "market_cap_usd",
];

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

async function verifySchema(client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>) {
  const { error: pairTableError } = await client.from("provider_pairs").select("pair_address").limit(0);
  if (pairTableError) {
    throw new Error("Apply supabase/migrations/20260923120000_dexscreener_market_structure.sql in the Supabase SQL Editor before running the DEX Screener collector.");
  }
  const { data, error } = await client.from("metric_definitions").select("id").in("id", REQUIRED_METRICS);
  throwOnSupabaseError(error, "check DEX Screener metric definitions");
  const present = new Set((data ?? []).map((row: { id: string }) => row.id));
  const missing = REQUIRED_METRICS.filter((metricId) => !present.has(metricId));
  if (missing.length > 0) {
    throw new Error("The DEX Screener metric catalog is incomplete. Apply supabase/migrations/20260923120000_dexscreener_market_structure.sql.");
  }
}

export async function runDexScreenerCollection(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  options: { tokenIds?: string[]; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
) {
  // Fail before provider calls if the Supabase migration has not been applied.
  await verifySchema(client);
  const activeCanonicalTokenIds = new Set(canonicalTokens.map((token) => token.id));
  const assets = configuredDexScreenerAssets().filter(
    (asset) => activeCanonicalTokenIds.has(asset.tokenId) && (!options.tokenIds || options.tokenIds.includes(asset.tokenId)),
  );
  const provider = new DexScreenerMarketDataProvider(options);
  const snapshots = await provider.fetchSnapshots(assets);
  if (snapshots.length !== assets.length) throw new Error("DEX Screener returned an incomplete token collection.");

  const { error: providerError } = await client.from("data_providers").upsert(
    { id: "dexscreener", name: "DEX Screener", enabled: true },
    { onConflict: "id" },
  );
  throwOnSupabaseError(providerError, "upsert DEX Screener provider");

  const mappings = assets.map((asset) => ({
    provider_id: "dexscreener",
    chain_id: asset.chainId,
    token_id: asset.tokenId,
    external_asset_id: asset.externalAssetId,
    external_contract_address: asset.tokenAddress,
    scope: "market",
    verification_method: "exact_chain_address",
  }));
  // onConflict targets (provider_id,token_id): see the identical fix and rationale in
  // run-coingecko-collection.ts and run-defillama-coins-collection.ts.
  const { error: mappingsError } = await client
    .from("provider_token_mappings")
    .upsert(mappings, { onConflict: "provider_id,token_id" });
  throwOnSupabaseError(mappingsError, "upsert DEX Screener token mappings");

  const persisted = await persistProviderSnapshots(client, snapshots);
  const unavailable = snapshots.flatMap((snapshot) =>
    snapshot.observations
      .filter((item) => item.status === "unavailable")
      .map((item) => ({ tokenId: item.tokenId, metricId: item.metricId })),
  );

  return {
    provider: "dexscreener",
    tokensInUniverse: canonicalTokens.length,
    mappedTokens: assets.length,
    unmappedTokens: getUnmappedDexScreenerTokens(),
    returnedTokens: snapshots.length,
    ...persisted,
    unavailable,
  };
}
