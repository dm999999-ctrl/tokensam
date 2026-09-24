type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const PAGE_SIZE = 1000;
const PROVIDERS = ["coingecko", "defillama", "dexscreener", "defillama_coins"];
export const OBSERVATION_COLUMNS = "id,token_id,chain_id,metric_id,provider_id,raw_record_id,value,status,observed_at,collected_at,source_field,note";
/** Provenance columns added by the token-centric scope migration (read when present). */
export const SCOPE_COLUMNS = "scope,provider_asset_id,mapping_id";
const COLUMNS = `${OBSERVATION_COLUMNS},${SCOPE_COLUMNS}`;

type Row = {
  id: number;
  token_id: string;
  provider_id: string;
  metric_id: string;
  observed_at: string;
  collected_at: string;
};

// PostgREST reports a missing relation as PGRST205 (schema cache) or 42P01 (Postgres).
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

type PageQuery = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;

async function readPages<T>(query: PageQuery, action: string): Promise<{ rows: T[]; missing: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await query(offset, offset + PAGE_SIZE - 1);
    if (offset === 0 && isMissingRelation(error)) return { rows, missing: true };
    fail(error, action);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, missing: false };
  }
}

function newestFirst(a: Row, b: Row): number {
  return Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at)
    || b.id - a.id;
}

/** Keep only the newest row per token/provider/metric (the view's DISTINCT ON rule). */
export function latestPerMetric<T extends Row>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of [...rows].sort(newestFirst)) {
    const key = `${row.token_id}|${row.provider_id}|${row.metric_id}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
}

/** Merge row sets that may overlap (latest rows are usually also inside a history window). */
export function mergeById<T extends { id: number }>(...sets: T[][]): T[] {
  return [...new Map(sets.flat().map((row) => [row.id, row])).values()];
}

/**
 * Latest observation per token/provider/metric.
 *
 * Uses the `latest_token_metric_observations` view (Phase 11B migration) so the
 * read stays small as history grows. Before that migration is applied it falls
 * back to the original full scan, so existing deployments keep working.
 */
export async function readLatestObservations<T extends Row>(client: SupabaseAdminClient, tokenIds: string[]): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const fromView = await readPages<T>((from, to) => client.from("latest_token_metric_observations")
    .select(COLUMNS).in("token_id", tokenIds).in("provider_id", PROVIDERS)
    .order("token_id").order("provider_id").order("metric_id").range(from, to), "read latest observations");
  if (!fromView.missing) return fromView.rows;

  const all = await readPages<T>((from, to) => client.from("token_metric_observations")
    .select(COLUMNS).in("token_id", tokenIds).in("provider_id", PROVIDERS).is("excluded_reason", null)
    .order("id").range(from, to), "read observations");
  return latestPerMetric(all.rows);
}

/** Observations for specific provider metrics since a cutoff (bounded history for series). */
export async function readObservationWindow<T extends Row>(
  client: SupabaseAdminClient,
  tokenIds: string[],
  series: { providerId: string; metricId: string }[],
  since: Date,
): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const results = await Promise.all(series.map(({ providerId, metricId }) => readPages<T>((from, to) => client
    .from("token_metric_observations")
    .select(COLUMNS).in("token_id", tokenIds).eq("provider_id", providerId).eq("metric_id", metricId)
    .is("excluded_reason", null)
    .gte("observed_at", since.toISOString())
    .order("observed_at", { ascending: true }).order("id", { ascending: true })
    .range(from, to), `read ${providerId} ${metricId} history`)));
  return results.flatMap((result) => result.rows);
}

/**
 * Newest raw record per token for one provider (the view from the Phase 11B
 * migration), with the original full scan as a fallback.
 */
export async function readLatestRawRecords<T extends { id: number; token_id: string | null; chain_id: string | null; collected_at: string }>(
  client: SupabaseAdminClient,
  providerId: string,
  columns: string,
): Promise<T[]> {
  const fromView = await readPages<T>((from, to) => client.from("latest_raw_provider_records")
    .select(columns).eq("provider_id", providerId).order("token_id").order("chain_id").range(from, to), `read latest ${providerId} raw records`);
  if (!fromView.missing) return fromView.rows;

  const all = await readPages<T>((from, to) => client.from("raw_provider_records")
    .select(columns).eq("provider_id", providerId).is("excluded_reason", null)
    .order("collected_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to), `read ${providerId} raw records`);
  const latest = new Map<string, T>();
  for (const record of all.rows) {
    const key = `${record.token_id}:${record.chain_id}`;
    if (record.token_id && record.chain_id && !latest.has(key)) latest.set(key, record);
  }
  return [...latest.values()];
}
