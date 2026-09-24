import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { defillamaCoinsIdentifier } from "../../data/provider-coverage.ts";
import { getDefiLlamaConfig } from "./defillama.ts";
import { DEFILLAMA_COINS_PROVIDER_ID, fetchCoinsSnapshots } from "./defillama-coins.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import type { ProviderAsset } from "./types.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

/**
 * Token-level DeFiLlama prices for the canonical universe (or a subset).
 * Subject to the same written-permission gate as the protocol collector.
 */
export async function runDefiLlamaCoinsCollection(
  client: SupabaseAdminClient,
  options: { tokenIds?: string[]; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
) {
  getDefiLlamaConfig(options.env);
  const tokens = canonicalTokens.filter((token) => !options.tokenIds || options.tokenIds.includes(token.id));
  const assets: ProviderAsset[] = tokens.flatMap((token) => {
    const key = defillamaCoinsIdentifier(token);
    return key ? [{ tokenId: token.id, chainId: token.chainId, externalAssetId: key }] : [];
  });

  // Fetch everything before touching Supabase; a failed request writes nothing.
  const snapshots = await fetchCoinsSnapshots(assets, options);

  const { error: providerError } = await client.from("data_providers")
    .upsert({ id: DEFILLAMA_COINS_PROVIDER_ID, name: "DeFiLlama (token prices)", enabled: true }, { onConflict: "id" });
  fail(providerError, "upsert DeFiLlama coins provider");
  const { error: mappingError } = await client.from("provider_token_mappings").upsert(assets.map((asset) => ({
    provider_id: DEFILLAMA_COINS_PROVIDER_ID,
    chain_id: asset.chainId,
    token_id: asset.tokenId,
    external_asset_id: asset.externalAssetId,
    scope: "token",
    verification_method: asset.externalAssetId.startsWith("coingecko:") ? "coins_key_from_coingecko_id" : "coins_key_from_verified_contract_address",
  })), { onConflict: "provider_id,chain_id,external_asset_id" });
  fail(mappingError, "upsert DeFiLlama coins mappings");

  const persisted = await persistProviderSnapshots(client, snapshots);
  const unavailable = snapshots.filter((snapshot) => snapshot.observations[0].status === "unavailable").map((snapshot) => snapshot.asset.tokenId);
  return { provider: DEFILLAMA_COINS_PROVIDER_ID, mappedTokens: assets.length, returnedPrices: assets.length - unavailable.length, unavailable, ...persisted };
}
