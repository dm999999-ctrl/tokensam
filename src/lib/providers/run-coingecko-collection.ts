import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { CoinGeckoMarketDataProvider, getCoinGeckoConfig } from "./coingecko.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import type { ProviderAsset } from "./types.ts";

const PRICE_CHANGE_METRICS = [
  {
    id: "price_change_24h_pct",
    name: "24-hour price change",
    description: "CoinGecko-reported 24-hour price change percentage.",
  },
  {
    id: "price_change_7d_pct",
    name: "7-day price change",
    description: "CoinGecko-reported 7-day price change percentage.",
  },
];

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

function canonicalRows() {
  return canonicalTokens.map((token) => {
    const externalAssetId = coingeckoTokenIds[token.id];
    if (!externalAssetId) throw new Error(`Missing explicit CoinGecko ID mapping for ${token.id}.`);
    return {
      token,
      externalAssetId,
      chainId: token.chainId,
      isNative: token.isNative,
    };
  });
}

async function prepareDatabase(client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>) {
  const rows = canonicalRows();
  const chains = [...new Map(rows.map(({ token, chainId }) => [chainId, { id: chainId, name: token.chainName }])).values()];
  const { error: chainsError } = await client.from("chains").upsert(chains, { onConflict: "id" });
  throwOnSupabaseError(chainsError, "upsert chains");

  const tokens = rows.map(({ token, chainId, isNative }) => ({
    id: token.id,
    name: token.name,
    symbol: token.symbol,
    chain_id: chainId,
    contract_address: token.contractAddress,
    is_native: isNative,
    category: token.category,
    description: token.identityNote,
  }));
  const { error: tokensError } = await client.from("tokens").upsert(tokens, { onConflict: "id" });
  throwOnSupabaseError(tokensError, "upsert canonical tokens");

  const { error: providerError } = await client.from("data_providers").upsert(
    { id: "coingecko", name: "CoinGecko", enabled: true },
    { onConflict: "id" },
  );
  throwOnSupabaseError(providerError, "upsert provider registry");

  const { error: metricsError } = await client.from("metric_definitions").upsert(
    PRICE_CHANGE_METRICS.map((metric) => ({
      ...metric,
      domain: "market",
      unit: "percent",
    })),
    { onConflict: "id" },
  );
  throwOnSupabaseError(metricsError, "upsert metric definitions");

  const mappings = rows.map(({ token, chainId, externalAssetId }) => ({
    provider_id: "coingecko",
    chain_id: chainId,
    token_id: token.id,
    external_asset_id: externalAssetId,
    scope: "token",
    verification_method: "curated_coingecko_id",
  }));
  const { error: mappingsError } = await client
    .from("provider_token_mappings")
    .upsert(mappings, { onConflict: "provider_id,chain_id,external_asset_id" });
  throwOnSupabaseError(mappingsError, "upsert provider token mappings");

  return rows;
}

export async function runCoinGeckoCollection(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  options: {
    /** Restrict collection to these canonical tokens (representative tests); default is the whole universe. */
    tokenIds?: string[];
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  } = {},
) {
  const config = getCoinGeckoConfig(options.env);
  const rows = canonicalRows();
  const assets: ProviderAsset[] = rows.filter(({ token }) => !options.tokenIds || options.tokenIds.includes(token.id)).map(({ token, chainId, externalAssetId }) => ({
    tokenId: token.id,
    chainId,
    externalAssetId,
  }));
  const provider = new CoinGeckoMarketDataProvider({
    ...config,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
  });

  // Fetch and validate first; failed provider responses do not modify Supabase.
  const snapshots = await provider.fetchSnapshots(assets);
  if (snapshots.length === 0) {
    throw new Error("CoinGecko returned no records for the configured canonical token mappings.");
  }

  await prepareDatabase(client);
  const persisted = await persistProviderSnapshots(client, snapshots);
  const returnedIds = new Set(snapshots.map((snapshot) => snapshot.asset.externalAssetId));
  const missingAssetIds = assets
    .filter((asset) => !returnedIds.has(asset.externalAssetId))
    .map((asset) => asset.externalAssetId);

  return {
    provider: "coingecko",
    mappedAssets: assets.length,
    returnedAssets: snapshots.length,
    missingAssetIds,
    ...persisted,
  };
}
