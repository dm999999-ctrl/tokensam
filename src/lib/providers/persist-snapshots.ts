import type { ProviderSnapshot } from "./types";

type SupabaseAdminClient = ReturnType<
  typeof import("../supabase/admin").createSupabaseAdminClient
>;

const CHUNK_SIZE = 500;
const RAW_RECORD_MAX_BATCH_BYTES = 200_000;
const RAW_RECORD_MAX_BATCH_ROWS = 25;

function chunkRawRows(rows: Record<string, unknown>[]): Record<string, unknown>[][] {
  const chunks: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (current.length > 0 && (currentBytes + rowBytes > RAW_RECORD_MAX_BATCH_BYTES || current.length >= RAW_RECORD_MAX_BATCH_ROWS)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function assertNoError(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`Supabase ${operation} failed: ${error.message}`);
}

/** Chunks are independent inserts (no shared state or ordering requirement), so they run concurrently
 *  instead of one at a time — the wall-clock cost here is per-round-trip network latency, not server work. */
async function writeInChunks(
  client: SupabaseAdminClient,
  table: "token_metric_observations",
  rows: Record<string, unknown>[],
): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) chunks.push(rows.slice(index, index + CHUNK_SIZE));
  await Promise.all(chunks.map(async (chunk) => {
    const { error } = await client.from(table).insert(chunk);
    assertNoError(error, `insert into ${table}`);
  }));
}

function observationKey(row: {
  token_id: string;
  chain_id: string;
  metric_id: string;
  observed_at: string;
  window_days: number | null;
}): string {
  return [
    row.token_id,
    row.chain_id,
    row.metric_id,
    new Date(row.observed_at).toISOString(),
    row.window_days ?? "null",
  ].join("|");
}

/** Persist generic normalized provider snapshots and their source JSON. */
export async function persistProviderSnapshots(
  client: SupabaseAdminClient,
  snapshots: ProviderSnapshot[],
): Promise<{ rawRecords: number; observations: number; pairMappings: number; timingMs: Record<string, number> }> {
  if (snapshots.length === 0) return { rawRecords: 0, observations: 0, pairMappings: 0, timingMs: {} };

  const rawRows = snapshots.map((snapshot) => ({
    provider_id: snapshot.providerId,
    chain_id: snapshot.asset.chainId,
    token_id: snapshot.asset.tokenId,
    external_asset_id: snapshot.asset.externalAssetId,
    collected_at: snapshot.collectedAt,
    endpoint_label: snapshot.endpointLabel,
    response_status: "success",
    payload: snapshot.rawPayload,
  }));

  const providers = [...new Set(snapshots.map((snapshot) => snapshot.providerId))];
  const tokenIdsForMapping = [...new Set(snapshots.map((snapshot) => snapshot.asset.tokenId))];

  // Raw-record chunk inserts and the mapping-ID lookup are independent of each other
  // (mapping lookup needs no raw-record IDs), so run them concurrently rather than
  // paying for each Supabase round trip's network latency one at a time.
  const rawInsertStart = Date.now();
  const mappingLookupStart = rawInsertStart;
  const [insertedRawRows, mappingRows] = await Promise.all([
    (async () => {
      const chunks = chunkRawRows(rawRows);
      const results = await Promise.all(chunks.map(async (rawBatch) => {
        const { data, error } = await client
          .from("raw_provider_records")
          .insert(rawBatch)
          .select("id, token_id, chain_id");
        assertNoError(error, "insert into raw_provider_records");
        return (data ?? []) as { id: number; token_id: string; chain_id: string }[];
      }));
      return results.flat();
    })(),
    (async () => {
      const { data, error } = await client.from("provider_token_mappings")
        .select("id,provider_id,token_id").in("provider_id", providers).in("token_id", tokenIdsForMapping);
      assertNoError(error, "read provider mapping IDs");
      return (data ?? []) as { id: number; provider_id: string; token_id: string }[];
    })(),
  ]);
  const rawInsertMs = Date.now() - rawInsertStart;
  const mappingLookupMs = Date.now() - mappingLookupStart;

  const rawIdByTokenAndChain = new Map(
    insertedRawRows.map((row) => [`${row.token_id}:${row.chain_id}`, row.id]),
  );
  const pairRows = snapshots.flatMap((snapshot) =>
    (snapshot.providerPairs ?? []).map((pair) => ({
      provider_id: snapshot.providerId,
      token_id: pair.tokenId,
      chain_id: pair.chainId,
      dex_chain_id: pair.providerChainId,
      token_address: pair.tokenAddress,
      pair_address: pair.pairAddress,
      dex_id: pair.dexId,
      pair_url: pair.pairUrl,
      base_token_address: pair.baseTokenAddress,
      quote_token_address: pair.quoteTokenAddress,
      pair_created_at: pair.pairCreatedAt,
      last_seen_at: pair.lastSeenAt,
      raw_record_id: rawIdByTokenAndChain.get(`${pair.tokenId}:${pair.chainId}`) ?? null,
    })),
  );
  if (pairRows.length > 0) {
    const { error: pairError } = await client
      .from("provider_pairs")
      .upsert(pairRows, { onConflict: "provider_id,chain_id,token_id,pair_address" });
    assertNoError(pairError, "upsert into provider_pairs");
  }
  // Mapping IDs identify the provider mapping each observation was collected under.
  const mappingIds = new Map<string, number>();
  for (const row of mappingRows) mappingIds.set(`${row.provider_id}:${row.token_id}`, row.id);
  const observationRows = snapshots.flatMap((snapshot) =>
    snapshot.observations.map((observation) => ({
      token_id: observation.tokenId,
      chain_id: observation.chainId,
      metric_id: observation.metricId,
      provider_id: snapshot.providerId,
      raw_record_id: rawIdByTokenAndChain.get(`${observation.tokenId}:${observation.chainId}`) ?? null,
      value: observation.value,
      window_days: observation.windowDays,
      status: observation.status,
      observed_at: observation.observedAt,
      collected_at: observation.collectedAt,
      source_field: observation.sourceField,
      note: observation.note,
      scope: observation.scope,
      provider_asset_id: snapshot.asset.externalAssetId,
      mapping_id: mappingIds.get(`${snapshot.providerId}:${observation.tokenId}`) ?? null,
    })),
  );

  const providerIds = [...new Set(snapshots.map((snapshot) => snapshot.providerId))];
  const tokenIds = [...new Set(snapshots.map((snapshot) => snapshot.asset.tokenId))];
  const observedTimes = observationRows.map((row) => Date.parse(String(row.observed_at)));
  const startAt = new Date(Math.min(...observedTimes)).toISOString();
  const endAt = new Date(Math.max(...observedTimes)).toISOString();
  const existingKeys = new Set<string>();
  const existingKeysStart = Date.now();

  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from("token_metric_observations")
      .select("token_id, chain_id, metric_id, observed_at, window_days")
      .in("provider_id", providerIds)
      .in("token_id", tokenIds)
      .gte("observed_at", startAt)
      .lte("observed_at", endAt)
      .range(offset, offset + 999);
    assertNoError(error, "check existing observations");
    for (const row of data ?? []) existingKeys.add(observationKey(row));
    if (!data || data.length < 1000) break;
  }
  const existingKeysMs = Date.now() - existingKeysStart;

  const newObservationRows = observationRows.filter(
    (row) => !existingKeys.has(observationKey(row as {
      token_id: string;
      chain_id: string;
      metric_id: string;
      observed_at: string;
      window_days: number | null;
    })),
  );
  const observationInsertStart = Date.now();
  await writeInChunks(client, "token_metric_observations", newObservationRows);
  const observationInsertMs = Date.now() - observationInsertStart;
  return {
    rawRecords: rawRows.length,
    observations: newObservationRows.length,
    pairMappings: pairRows.length,
    timingMs: { rawInsertMs, mappingLookupMs, existingKeysMs, observationInsertMs },
  };
}
