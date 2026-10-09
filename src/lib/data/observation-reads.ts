import { recordApproxRead } from "../monitoring/quota-tracker.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const PAGE_SIZE = 1000;
// Providers whose observations the dashboard's "latest" read serves. "binance" must stay
// listed: it supplies the preferred live price and 24h change (see livePriceRow in
// live-data.ts), so omitting it here would silently fall every token back to CoinGecko.
export const PROVIDERS = ["coingecko", "binance", "defillama", "dexscreener", "defillama_coins"];
// Dashboard latest reads only need a recent freshness window. Querying the
// append-only history without a cutoff forces PostgreSQL to consider the full
// table behind latest_token_metric_observations.
export const LATEST_READ_WINDOW_MS = 6 * 60 * 60 * 1000;
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

type DailyAggregateRow = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: string;
  utc_day: string;
  value: number | string | null;
  status: string;
  source_observation_count: number;
  valid_value_count: number;
  aggregated_at: string;
};

// PostgREST reports a missing relation as PGRST205 (schema cache) or 42P01 (Postgres).
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

type PageQuery = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;
/** Offset paging, kept for the small raw-record reads where depth never grows. */
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

type KeysetQuery = (fromObservedAt: string | null) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;

/**
 * Pages by seeking forward on `observed_at` instead of by OFFSET.
 *
 * OFFSET made PostgreSQL produce and discard every row before the window, so a scan
 * of N rows in pages of PAGE_SIZE cost O(N^2/PAGE_SIZE). For the 14-day coingecko
 * price_usd series the metrics engine reads (107,669 rows, 108 pages) the deep pages
 * blew PostgREST's statement timeout, which is what made the metrics step fail
 * repeatedly and leave calculated metrics stale.
 *
 * Seeking on observed_at -- rather than on `id`, which an earlier attempt at this fix
 * used -- is what makes it fast. provider_metric_history_lookup_idx is
 * (provider_id, metric_id, observed_at), so an observed_at range is an index condition
 * and every row the scan touches is a row the caller wants. Seeking on id instead
 * forced a primary-key scan that filtered provider/metric/observed_at per row and
 * discarded ~22,000 rows to fill the first page (1,478 ms, measured), which still timed
 * out under production load. Measured on production (2026-10-06) for the same first
 * page: 1,107 buffers and 29.6 ms via observed_at, against 6,717 buffers and 1,478 ms
 * via id, and 60,573 buffers and 113 ms for OFFSET 100000.
 *
 * The cursor is inclusive (`>= last observed_at`) because observed_at is NOT unique --
 * a provider writes one timestamp across every token in a batch -- so an exclusive
 * seek would skip the rest of the boundary group. The overlap that creates is removed
 * by id, which is why `seen` is tracked.
 *
 * This requires PAGE_SIZE to exceed the number of rows sharing a single observed_at
 * (182 at the time of writing: one per canonical token in a batch, against PAGE_SIZE
 * 1000). If that ever stops holding, a page cannot advance past the group, and the
 * guard below throws rather than looping forever.
 *
 * Rows come back in observed_at order. Callers that need another order sort for
 * themselves: latestPerMetric sorts by newestFirst, and run-calculation.ts sorts the
 * merged series by observed_at then id.
 */
async function readKeyset<T extends { id: number; observed_at: string }>(
  query: KeysetQuery,
  action: string,
): Promise<{ rows: T[]; missing: boolean }> {
  const rows: T[] = [];
  const seen = new Set<number>();
  let cursor: string | null = null;

  for (;;) {
    const { data, error } = await query(cursor);
    if (cursor === null && isMissingRelation(error)) return { rows, missing: true };
    fail(error, action);
    const page = (data ?? []) as T[];

    let added = 0;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      added += 1;
    }
    if (page.length < PAGE_SIZE) return { rows, missing: false };

    const nextCursor = page[page.length - 1].observed_at;
    if (added === 0 && nextCursor === cursor) {
      throw new Error(
        `Supabase ${action} failed: more than ${PAGE_SIZE} rows share observed_at ${cursor}, so keyset paging cannot advance.`,
      );
    }
    cursor = nextCursor;
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
 * Read the latest observation per (token, provider, metric) within a recent window.
 *
 * Previously: bounded token batches of 50, each doing its own keyset-paginated read of
 * every matching row in the window, collapsed to the newest row per group in application
 * memory (latestPerMetric). That shipped every row in the window over the wire only to
 * discard all but the newest per group, and request count scaled with token count (one
 * batch of requests per 50 tokens, each potentially several keyset pages). Now calls
 * latest_observations_bounded (20261007160000_metrics_calc_server_side_collapse), the
 * same RPC built for the metrics-calculation read path: one call with every token id as
 * a single array parameter (not URL-length-bounded like a GET .in() filter, so no
 * batching needed), doing the newest-row-per-group collapse server side via a window
 * function. One request regardless of token count, in place of what was previously
 * ceil(tokenIds.length / 50) batches of potentially several pages each.
 */
export async function readLatestObservations<T extends Row>(client: SupabaseAdminClient, tokenIds: string[]): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const since = new Date(Date.now() - LATEST_READ_WINDOW_MS).toISOString();
  const { data, error } = await client.rpc("latest_observations_bounded", {
    p_token_ids: tokenIds, p_provider_ids: PROVIDERS, p_since: since,
  });
  if (isMissingRelation(error)) return [];
  fail(error, "read latest observations (bounded rpc)");
  const rows = (data ?? []) as T[];
  recordApproxRead(client, rows);
  return rows;
}
/** Observations for specific provider metrics since a cutoff (bounded history for series). */
export async function readObservationWindow<T extends Row>(
  client: SupabaseAdminClient,
  tokenIds: string[],
  series: { providerId: string; metricId: string }[],
  since: Date,
): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const results = await Promise.all(series.map(async ({ providerId, metricId }) => {
    const [observations, aggregates] = await Promise.all([
      readKeyset<T>((fromObservedAt) => client.from("token_metric_observations")
        .select(COLUMNS).in("token_id", tokenIds).eq("provider_id", providerId).eq("metric_id", metricId)
        .is("excluded_reason", null)
        .gte("observed_at", fromObservedAt ?? since.toISOString())
        .order("observed_at", { ascending: true }).order("id", { ascending: true })
        .limit(PAGE_SIZE), `read ${providerId} ${metricId} history`),
      readPages<DailyAggregateRow>((from, to) => client.from("token_metric_daily_aggregates")
        .select("id,token_id,chain_id,metric_id,provider_id,utc_day,value,status,source_observation_count,valid_value_count,aggregated_at")
        .in("token_id", tokenIds).eq("provider_id", providerId).eq("metric_id", metricId)
        .gte("utc_day", since.toISOString().slice(0, 10))
        .order("utc_day", { ascending: true }).order("id", { ascending: true })
        .range(from, to), `read ${providerId} ${metricId} daily averages`),
    ]);

    // Keep the live app compatible with environments where the migration has
    // not been applied yet; the original observation history remains readable.
    if (aggregates.missing) return observations.rows;
    const dailyRows = aggregates.rows.map((row) => ({
      // Negative IDs keep aggregate provenance IDs distinct from observation IDs
      // when callers merge the two result sets by ID.
      id: -Math.abs(row.id),
      token_id: row.token_id,
      chain_id: row.chain_id,
      metric_id: row.metric_id,
      provider_id: row.provider_id,
      raw_record_id: null,
      value: row.value,
      status: row.status,
      observed_at: new Date(`${row.utc_day}T00:00:00.000Z`).toISOString(),
      collected_at: row.aggregated_at,
      source_field: "daily_average",
      note: `UTC daily arithmetic mean from ${row.valid_value_count} valid values across ${row.source_observation_count} provider observations.`,
      daily_sample_count: row.source_observation_count,
      daily_valid_value_count: row.valid_value_count,
    })) as unknown as T[];
    return [...observations.rows, ...dailyRows];
  }));
  const rows = results.flat();
  recordApproxRead(client, rows);
  return rows;
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
  if (!fromView.missing) {
    recordApproxRead(client, fromView.rows);
    return fromView.rows;
  }

  const all = await readPages<T>((from, to) => client.from("raw_provider_records")
    .select(columns).eq("provider_id", providerId).is("excluded_reason", null)
    .order("collected_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to), `read ${providerId} raw records`);
  const latest = new Map<string, T>();
  for (const record of all.rows) {
    const key = `${record.token_id}:${record.chain_id}`;
    if (record.token_id && record.chain_id && !latest.has(key)) latest.set(key, record);
  }
  const rows = [...latest.values()];
  recordApproxRead(client, rows);
  return rows;
}
