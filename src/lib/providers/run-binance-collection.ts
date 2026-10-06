import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { binanceSymbols } from "../../data/binance-token-mappings.ts";
import { BinanceMarketDataProvider, getBinanceConfig } from "./binance.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import type { ProviderAsset } from "./types.ts";
import { CollectorDiagnostics } from "../refresh/collector-diagnostics.ts";

/**
 * Diagnostic-only stage order for a Binance collection run (see
 * collector-diagnostics.ts). Declared up front so an aborted run's snapshot
 * still shows every stage it never reached, as "not_started".
 */
export const BINANCE_STAGES = [
  "binance.fetchSnapshots",
  "binance.parseTransform",
  "binance.prepareDatabase",
  "binance.prepareDatabase.upsertProviderRegistry",
  "binance.prepareDatabase.upsertProviderMappings",
  "binance.persistProviderSnapshots",
  "binance.persist.rawRecordsInsert",
  "binance.persist.mappingLookup",
  "binance.persist.existingKeysLookup",
  "binance.persist.observationInsert",
] as const;

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

function mappedRows() {
  return canonicalTokens
    .map((token) => ({ token, symbol: binanceSymbols[token.id] }))
    .filter((row): row is { token: typeof row.token; symbol: string } => Boolean(row.symbol));
}

/**
 * Upserts only what this provider owns: its registry row and its own token
 * mappings.
 *
 * Unlike the CoinGecko collector this does NOT upsert chains, tokens, or the
 * shared metric_definitions rows. Those are canonical-universe records owned by
 * the CoinGecko collector (which is always enabled and is the universe's
 * source of truth), and both collectors run in the same parallel provider
 * phase: re-upserting the same rows from two collectors at once would mean two
 * transactions contending over identical values for no benefit, and two
 * collectors overwriting each other's metric descriptions on every run. The
 * cost is that provider_token_mappings here depends on tokens already existing,
 * so on a never-populated database the very first run can fail this step with
 * a loud foreign-key error and succeed on the next one, once CoinGecko has
 * seeded the universe.
 */
async function prepareDatabase(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  diagnostics: CollectorDiagnostics,
) {
  const rows = mappedRows();

  diagnostics.start("binance.prepareDatabase.upsertProviderRegistry");
  const { error: providerError } = await client.from("data_providers").upsert(
    { id: "binance", name: "Binance", enabled: true },
    { onConflict: "id" },
  );
  diagnostics.end("binance.prepareDatabase.upsertProviderRegistry");
  throwOnSupabaseError(providerError, "upsert Binance provider registry");

  const mappings = rows.map(({ token, symbol }) => ({
    provider_id: "binance",
    chain_id: token.chainId,
    token_id: token.id,
    external_asset_id: symbol,
    scope: "token",
    verification_method: "curated_binance_spot_symbol",
  }));
  // onConflict targets (provider_id,token_id), not the table's (provider_id,chain_id,
  // external_asset_id) primary key -- same reasoning as run-coingecko-collection.ts: a
  // token's curated symbol can change between runs, which changes the PK while
  // provider_id+token_id stays the same, hitting the table's OTHER unique constraint
  // as a duplicate-key error instead of updating the existing row.
  diagnostics.start("binance.prepareDatabase.upsertProviderMappings");
  const { error: mappingsError } = await client
    .from("provider_token_mappings")
    .upsert(mappings, { onConflict: "provider_id,token_id" });
  diagnostics.end("binance.prepareDatabase.upsertProviderMappings");
  throwOnSupabaseError(mappingsError, "upsert Binance provider token mappings");

  return rows;
}

export async function runBinanceCollection(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  options: {
    /** Restrict collection to these canonical tokens (representative tests); default is every mapped token. */
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
  diagnostics.declareStages(BINANCE_STAGES);

  const config = getBinanceConfig(options.env);
  const rows = mappedRows();
  const assets: ProviderAsset[] = rows
    .filter(({ token }) => !options.tokenIds || options.tokenIds.includes(token.id))
    .map(({ token, symbol }) => ({ tokenId: token.id, chainId: token.chainId, externalAssetId: symbol }));

  const provider = new BinanceMarketDataProvider({
    ...config,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
  });

  const collectorStart = Date.now();
  // Fetch and validate first; failed provider responses do not modify Supabase.
  const httpStart = Date.now();
  diagnostics.start("binance.fetchSnapshots");
  const snapshots = await provider.fetchSnapshots(assets, diagnostics);
  diagnostics.end("binance.fetchSnapshots");
  const httpMs = Date.now() - httpStart;
  // parseTransform is a sub-stage of fetchSnapshots (see binance.ts); read back its
  // recorded duration for the success-path timingMs summary below.
  const parseTransformStage = diagnostics.snapshot().stages["binance.parseTransform"];
  const parseTransformMs = parseTransformStage?.status === "completed" ? parseTransformStage.durationMs : null;
  if (snapshots.length === 0) {
    throw new Error("Binance returned no tickers for the configured canonical symbol mappings.");
  }

  const prepareDbStart = Date.now();
  diagnostics.start("binance.prepareDatabase");
  await prepareDatabase(client, diagnostics);
  diagnostics.end("binance.prepareDatabase");
  const prepareDbMs = Date.now() - prepareDbStart;

  const persistStart = Date.now();
  diagnostics.start("binance.persistProviderSnapshots");
  // No raw_provider_records for Binance. The ticker payload holds only the two fields the
  // observations already carry (lastPrice, priceChangePercent) plus closeTime, which becomes
  // observed_at, so a raw row adds no debugging value. At 180 tokens per run it was the
  // largest single consumer of a 500 MB plan -- ~52,000 rows/day against CoinGecko's ~17,500.
  const persisted = await persistProviderSnapshots(client, snapshots, diagnostics, undefined, { persistRawRecords: false });
  diagnostics.end("binance.persistProviderSnapshots");
  const persistMs = Date.now() - persistStart;

  const returnedSymbols = new Set(snapshots.map((snapshot) => snapshot.asset.externalAssetId));
  const missingAssetIds = assets
    .filter((asset) => !returnedSymbols.has(asset.externalAssetId))
    .map((asset) => asset.externalAssetId);
  // Tickers Binance returned but whose price was too stale to serve (see MAX_TICKER_AGE_MS).
  // These tokens fall back to CoinGecko in the read layer, so surface the count rather than
  // letting a silently shrinking live-price set look like a healthy run.
  const staleSymbols = snapshots
    .filter((snapshot) => snapshot.observations.every((observation) => observation.status === "unavailable"))
    .map((snapshot) => snapshot.asset.externalAssetId);

  const { timingMs: persistTimingMs, ...persistCounts } = persisted;
  return {
    provider: "binance",
    mappedAssets: assets.length,
    returnedAssets: snapshots.length,
    missingAssetIds,
    staleSymbols,
    ...persistCounts,
    // Timing diagnostics only (durations in ms); no request/response bodies or headers.
    timingMs: { totalMs: Date.now() - collectorStart, httpMs, parseTransformMs, prepareDbMs, persistMs, ...persistTimingMs },
  };
}
