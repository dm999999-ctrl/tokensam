import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import { DefiLlamaFundamentalsProvider, getDefiLlamaConfig, type DefiLlamaProtocolAsset } from "./defillama.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

function utcDateString(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Automated, idempotent DeFiLlama daily-TVL-history step.
 *
 * Reuses `DefiLlamaFundamentalsProvider.fetchHistorySnapshots` (the same
 * /protocol/{slug} fetch and normalization the explicit `--history` backfill
 * uses; scripts/sync-defillama.mjs) and the shared `persistProviderSnapshots`
 * function, so the stored representation is identical to what dailySamples()
 * (src/lib/indicators/series.ts) already consumes.
 *
 * This does not call the manual backfill's `runDefiLlamaCollection({ mode:
 * "history" })` wrapper directly: that wrapper persists whatever the provider
 * returns, and DeFiLlama's own `tvl` array can include a point dated *today*
 * that is really a live snapshot rather than a completed day. To keep that
 * distinction (never treat the current, still-open UTC day as a completed
 * daily close), this step filters each snapshot's observations to strictly
 * earlier UTC calendar days before persisting; the shared normalization
 * function itself is left unchanged, so the manual backfill's behavior and
 * tests are unaffected.
 *
 * DeFiLlama's /protocol/{slug} endpoint has no date-range parameter, so the
 * request itself cannot be narrowed further; the existing 90-day retention
 * window (normalizeDefiLlamaHistory) and this step's once-per-UTC-day
 * scheduling (see DAILY_HISTORY_POLICY) keep it from running more often than
 * necessary, and persistence already dedupes by exact stored timestamp.
 */
export async function runDefiLlamaDailyHistory(
  client: SupabaseAdminClient,
  options: {
    tokenIds?: string[];
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  } = {},
): Promise<{ provider: "defillama_daily"; mappedProtocols: number; returnedProtocols: number; skipped: { tokenId: string; reason: string }[]; newObservations: number; advanced: boolean; latestObservedAt: string | null; notYetAvailable?: string }> {
  // Checked before any network call or database write, same as the routine and backfill paths.
  const config = getDefiLlamaConfig(options.env);
  const now = options.now ?? (() => new Date());
  const today = utcDateString(now().toISOString());

  const selected = defillamaProtocolMappings.filter((mapping) => !options.tokenIds || options.tokenIds.includes(mapping.tokenId));
  const assets: DefiLlamaProtocolAsset[] = selected.map((mapping) => ({
    tokenId: mapping.tokenId,
    chainId: mapping.chainId,
    externalAssetId: mapping.externalAssetId,
    recordId: mapping.recordId,
  }));
  const provider = new DefiLlamaFundamentalsProvider({
    ...config,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
  });

  const { snapshots, skipped } = await provider.fetchHistorySnapshots(assets);
  if (snapshots.length === 0) {
    throw new Error("DeFiLlama returned no protocol history for the curated mappings.");
  }

  const completed = snapshots
    .map((snapshot) => {
      const observations = snapshot.observations.filter((observation) => utcDateString(observation.observedAt) < today);
      return { ...snapshot, observations, observedAt: observations.at(-1)?.observedAt ?? snapshot.observedAt };
    })
    .filter((snapshot) => snapshot.observations.length > 0);

  const { error: providerError } = await client.from("data_providers").upsert(
    { id: "defillama", name: "DeFiLlama", enabled: true },
    { onConflict: "id" },
  );
  throwOnSupabaseError(providerError, "upsert DeFiLlama provider");

  const persisted = completed.length > 0
    ? await persistProviderSnapshots(client, completed)
    : { rawRecords: 0, observations: 0, pairMappings: 0 };

  const latestObservedAt = completed
    .flatMap((snapshot) => snapshot.observations)
    .map((observation) => observation.observedAt)
    .sort()
    .at(-1) ?? null;

  return {
    provider: "defillama_daily",
    mappedProtocols: defillamaProtocolMappings.length,
    returnedProtocols: snapshots.length,
    skipped,
    newObservations: persisted.observations,
    advanced: persisted.observations > 0,
    latestObservedAt: persisted.observations > 0 ? latestObservedAt : null,
    notYetAvailable: persisted.observations > 0 ? undefined : "No new completed UTC daily TVL point was available from DeFiLlama for any mapped protocol.",
  };
}
