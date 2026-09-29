import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { CoinGeckoMarketDataProvider, getCoinGeckoConfig } from "./coingecko.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import type { ProviderAsset } from "./types.ts";
import { CollectorDiagnostics } from "../refresh/collector-diagnostics.ts";

/**
 * Diagnostic-only stage order for a CoinGecko collection run (see
 * collector-diagnostics.ts). Declared up front so an aborted run's snapshot
 * still shows every stage it never reached, as "not_started".
 */
export const COINGECKO_STAGES = [
  "coingecko.fetchSnapshots",
  "coingecko.parseTransform",
  "coingecko.prepareDatabase",
  "coingecko.prepareDatabase.upsertChains",
  "coingecko.prepareDatabase.upsertTokens",
  "coingecko.prepareDatabase.upsertProviderRegistry",
  "coingecko.prepareDatabase.upsertMetricDefinitions",
  "coingecko.prepareDatabase.upsertProviderMappings",
  "coingecko.persistProviderSnapshots",
  "coingecko.persist.rawRecordsInsert",
  "coingecko.persist.mappingLookup",
  "coingecko.persist.existingKeysLookup",
  "coingecko.persist.observationInsert",
] as const;

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

/**
 * Runs one upsert wrapped in start/end diagnostics, returning its Supabase error (if any) instead
 * of throwing, so independent phase-1 upserts below can run concurrently via Promise.all without
 * one rejection skipping the others' diagnostics.
 */
async function timedUpsert(
  diagnostics: CollectorDiagnostics,
  stage: string,
  run: () => PromiseLike<{ error: { message: string } | null }>,
): Promise<{ error: { message: string } | null }> {
  diagnostics.start(stage);
  const { error } = await run();
  diagnostics.end(stage);
  return { error };
}

/**
 * Upserts canonical reference data before persisting observations. FK dependencies (from
 * supabase/migrations/20260923000000_database_foundation.sql): tokens.chain_id -> chains(id);
 * provider_token_mappings -> data_providers(id) and (token_id, chain_id) -> tokens. chains,
 * data_providers, and metric_definitions have no dependency on each other or on tokens/mappings,
 * so they run concurrently (phase 1); tokens only needs chains, so it runs next (phase 2); and
 * provider_token_mappings, needing both tokens and data_providers, runs last (phase 3).
 */
async function prepareDatabase(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  diagnostics: CollectorDiagnostics,
) {
  const rows = canonicalRows();
  const chains = [...new Map(rows.map(({ token, chainId }) => [chainId, { id: chainId, name: token.chainName }])).values()];

  const [{ error: chainsError }, { error: providerError }, { error: metricsError }] = await Promise.all([
    timedUpsert(diagnostics, "coingecko.prepareDatabase.upsertChains", () => client.from("chains").upsert(chains, { onConflict: "id" })),
    timedUpsert(diagnostics, "coingecko.prepareDatabase.upsertProviderRegistry", () => client.from("data_providers").upsert(
      { id: "coingecko", name: "CoinGecko", enabled: true },
      { onConflict: "id" },
    )),
    timedUpsert(diagnostics, "coingecko.prepareDatabase.upsertMetricDefinitions", () => client.from("metric_definitions").upsert(
      PRICE_CHANGE_METRICS.map((metric) => ({ ...metric, domain: "market", unit: "percent" })),
      { onConflict: "id" },
    )),
  ]);
  throwOnSupabaseError(chainsError, "upsert chains");
  throwOnSupabaseError(providerError, "upsert provider registry");
  throwOnSupabaseError(metricsError, "upsert metric definitions");

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
  const { error: tokensError } = await timedUpsert(
    diagnostics, "coingecko.prepareDatabase.upsertTokens",
    () => client.from("tokens").upsert(tokens, { onConflict: "id" }),
  );
  throwOnSupabaseError(tokensError, "upsert canonical tokens");

  const mappings = rows.map(({ token, chainId, externalAssetId }) => ({
    provider_id: "coingecko",
    chain_id: chainId,
    token_id: token.id,
    external_asset_id: externalAssetId,
    scope: "token",
    verification_method: "curated_coingecko_id",
  }));
  const { error: mappingsError } = await timedUpsert(
    diagnostics, "coingecko.prepareDatabase.upsertProviderMappings",
    () => client.from("provider_token_mappings").upsert(mappings, { onConflict: "provider_id,chain_id,external_asset_id" }),
  );
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
    /** Diagnostic-only stage timing (see collector-diagnostics.ts); the orchestrator supplies its own
     *  instance so it can still read partial progress after a timeout. Defaults to a throwaway instance
     *  for direct callers (scripts, tests) that don't need it. */
    diagnostics?: CollectorDiagnostics;
  } = {},
) {
  const diagnostics = options.diagnostics ?? new CollectorDiagnostics();
  diagnostics.declareStages(COINGECKO_STAGES);

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

  const collectorStart = Date.now();
  // Fetch and validate first; failed provider responses do not modify Supabase.
  const httpStart = Date.now();
  diagnostics.start("coingecko.fetchSnapshots");
  const snapshots = await provider.fetchSnapshots(assets, diagnostics);
  diagnostics.end("coingecko.fetchSnapshots");
  const httpMs = Date.now() - httpStart;
  // parseTransform is a sub-stage of fetchSnapshots (see coingecko.ts); read back its
  // recorded duration for the success-path timingMs summary below.
  const parseTransformStage = diagnostics.snapshot().stages["coingecko.parseTransform"];
  const parseTransformMs = parseTransformStage?.status === "completed" ? parseTransformStage.durationMs : null;
  if (snapshots.length === 0) {
    throw new Error("CoinGecko returned no records for the configured canonical token mappings.");
  }

  const prepareDbStart = Date.now();
  diagnostics.start("coingecko.prepareDatabase");
  await prepareDatabase(client, diagnostics);
  diagnostics.end("coingecko.prepareDatabase");
  const prepareDbMs = Date.now() - prepareDbStart;
  const persistStart = Date.now();
  diagnostics.start("coingecko.persistProviderSnapshots");
  const persisted = await persistProviderSnapshots(client, snapshots, diagnostics);
  diagnostics.end("coingecko.persistProviderSnapshots");
  const persistMs = Date.now() - persistStart;
  const returnedIds = new Set(snapshots.map((snapshot) => snapshot.asset.externalAssetId));
  const missingAssetIds = assets
    .filter((asset) => !returnedIds.has(asset.externalAssetId))
    .map((asset) => asset.externalAssetId);

  const { timingMs: persistTimingMs, ...persistCounts } = persisted;
  return {
    provider: "coingecko",
    mappedAssets: assets.length,
    returnedAssets: snapshots.length,
    missingAssetIds,
    ...persistCounts,
    // Timing diagnostics only (durations in ms); no request/response bodies, keys, or headers.
    timingMs: { totalMs: Date.now() - collectorStart, httpMs, parseTransformMs, prepareDbMs, persistMs, ...persistTimingMs },
  };
}
