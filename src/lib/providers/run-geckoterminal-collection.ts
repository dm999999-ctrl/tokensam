import { geckoTerminalTokenMappings } from "../../data/geckoterminal-token-mappings.ts";
import {
  configuredGeckoTerminalAssets,
  GeckoTerminalMarketDataProvider,
  getUnmappedGeckoTerminalTokens,
} from "./geckoterminal.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";

const PROVIDER_ID = "geckoterminal";

/**
 * The public API's conservative ~10 requests/minute budget (6.5 s minimum
 * pacing between requests) makes the per-token pools lookup the dominant
 * cost: it is not batchable, unlike the token-attributes ("multi") endpoint.
 * Within the step's 150 s timeout budget (see REFRESH_POLICY), 12 tokens'
 * worth of pool lookups (~78 s) plus a handful of batched token-attribute and
 * DEX-list requests comfortably fits with margin. An explicit `tokenIds`
 * option (manual/targeted collection) is never capped, since the caller has
 * already decided which tokens are worth the request budget.
 */
const DEFAULT_MAX_TOKENS_PER_RUN = 12;

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

/**
 * Independent GeckoTerminal collector: the standalone GeckoTerminal Public
 * API (https://api.geckoterminal.com/api/v2), never CoinGecko's /onchain
 * endpoints. It never calls CoinGecko and does not consume CoinGecko quota.
 */
export async function runGeckoTerminalCollection(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  options: { tokenIds?: string[]; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
) {
  const matched = configuredGeckoTerminalAssets().filter((asset) => !options.tokenIds || options.tokenIds.includes(asset.tokenId));
  const assets = options.tokenIds ? matched : matched.slice(0, DEFAULT_MAX_TOKENS_PER_RUN);
  const provider = new GeckoTerminalMarketDataProvider(options);
  const snapshots = await provider.fetchSnapshots(assets);
  if (snapshots.length !== assets.length) throw new Error("GeckoTerminal returned an incomplete token collection.");

  const { error: providerError } = await client.from("data_providers").upsert(
    { id: PROVIDER_ID, name: "GeckoTerminal", enabled: true },
    { onConflict: "id" },
  );
  throwOnSupabaseError(providerError, "upsert GeckoTerminal provider");

  const mappings = assets.map((asset) => ({
    provider_id: PROVIDER_ID,
    chain_id: asset.chainId,
    token_id: asset.tokenId,
    external_asset_id: asset.externalAssetId,
    external_contract_address: asset.tokenAddress,
    scope: "market",
    verification_method: "exact_chain_address_reused_from_dexscreener",
  }));
  const { error: mappingsError } = await client
    .from("provider_token_mappings")
    .upsert(mappings, { onConflict: "provider_id,chain_id,external_asset_id" });
  throwOnSupabaseError(mappingsError, "upsert GeckoTerminal token mappings");

  const persisted = await persistProviderSnapshots(client, snapshots);

  // The "DEX list" data type: one network-level (not token-level) raw record
  // per distinct network in this run, capturing GeckoTerminal's DEX catalog.
  const networks = [...new Set(assets.map((asset) => asset.gtNetwork))];
  const collectedAt = (options.now ?? (() => new Date()))().toISOString();
  const dexRows: { count: number; network: string }[] = [];
  for (const network of networks) {
    const { dexes, raw } = await provider.fetchNetworkDexes(network);
    const canonicalChainId = assets.find((asset) => asset.gtNetwork === network)?.chainId ?? null;
    const { error: dexRecordError } = await client.from("raw_provider_records").insert({
      provider_id: PROVIDER_ID,
      chain_id: canonicalChainId,
      token_id: null,
      external_asset_id: `${network}:dexes`,
      collected_at: collectedAt,
      endpoint_label: "GET /networks/{network}/dexes",
      response_status: "success",
      payload: raw,
    });
    throwOnSupabaseError(dexRecordError, "insert GeckoTerminal DEX list record");
    dexRows.push({ network, count: dexes.length });
  }

  const unavailable = snapshots.flatMap((snapshot) =>
    snapshot.observations
      .filter((item) => item.status === "unavailable")
      .map((item) => ({ tokenId: item.tokenId, metricId: item.metricId })),
  );

  return {
    provider: PROVIDER_ID,
    tokensInUniverse: geckoTerminalTokenMappings.length,
    eligibleTokens: matched.length,
    mappedTokens: assets.length,
    cappedByRateLimit: !options.tokenIds && matched.length > assets.length,
    unmappedTokens: getUnmappedGeckoTerminalTokens(),
    returnedTokens: snapshots.length,
    networksCovered: dexRows,
    ...persisted,
    unavailable,
  };
}
