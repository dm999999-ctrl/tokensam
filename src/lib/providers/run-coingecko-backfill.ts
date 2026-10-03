import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { readLatestObservations } from "../data/observation-reads.ts";
import { CoinGeckoApiError, MIN_REQUEST_INTERVAL_MS, getCoinGeckoConfig } from "./coingecko.ts";
import { fetchMarketChart, normalizeMarketChartHistory } from "./coingecko-history.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const BACKFILL_METRICS = ["price_usd", "market_cap_usd", "volume_24h_usd"];
const BACKFILL_DAYS = 30;
/** One market_chart request per token; the current 182-token universe fits in four bounded batches. */
export const MAX_BACKFILL_TOKENS = 50;

export type BackfillTokenResult = {
  tokenId: string;
  status: "backfilled" | "up_to_date" | "failed" | "skipped";
  newObservations: number;
  rawRecords: number;
  error?: string;
};

async function existingKeys(client: SupabaseAdminClient, tokenId: string, since: Date): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from("token_metric_observations")
      .select("metric_id,observed_at").eq("token_id", tokenId).eq("provider_id", "coingecko")
      .in("metric_id", BACKFILL_METRICS).gte("observed_at", since.toISOString())
      .order("id").range(offset, offset + 999);
    if (error) throw new Error(`Supabase read existing CoinGecko history failed: ${error.message}`);
    for (const row of (data ?? []) as { metric_id: string; observed_at: string }[]) keys.add(`${row.metric_id}|${new Date(row.observed_at).toISOString()}`);
    if (!data || data.length < 1000) return keys;
  }
}

/**
 * Manual, bounded CoinGecko history backfill. Separate from the scheduled
 * refresh: it only adds legitimate historical provider points that are older
 * than the newest stored observation, never modifies existing rows, and is
 * idempotent (already-stored timestamps are skipped; a token with nothing new
 * writes nothing, not even a raw record).
 */
export async function runCoinGeckoBackfill(
  client: SupabaseAdminClient,
  options: {
    tokenIds?: string[];
    dryRun?: boolean;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    log?: (line: string) => void;
  } = {},
): Promise<{ results: BackfillTokenResult[]; requests: number; stoppedEarly: string | null }> {
  const config = getCoinGeckoConfig(options.env);
  log("Backfill diagnostics: CoinGecko configuration resolved; reading latest stored observations...");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  const wanted = options.tokenIds ?? canonicalTokens.map((token) => token.id);
  const unknown = wanted.filter((id) => !canonicalTokens.some((token) => token.id === id));
  if (unknown.length > 0) throw new Error(`Unknown canonical token ID(s): ${unknown.join(", ")}.`);
  if (wanted.length > MAX_BACKFILL_TOKENS) throw new Error(`At most ${MAX_BACKFILL_TOKENS} tokens per backfill run.`);
  const tokens = canonicalTokens.filter((token) => wanted.includes(token.id));

  const latest = await readLatestObservations<{ id: number; token_id: string; provider_id: string; metric_id: string; observed_at: string; collected_at: string }>(client, tokens.map((token) => token.id));
  log(`Backfill diagnostics: latest-observation read complete (${latest.length} row(s)); starting token requests.`);
  const results: BackfillTokenResult[] = [];
  let requests = 0;
  let stoppedEarly: string | null = null;
  const request = async (coinId: string, query: { days: number; interval?: "daily" }) => {
    if (requests > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    requests += 1;
    return fetchMarketChart(coinId, query, { ...config, fetchImpl, sleep });
  };

  for (const token of tokens) {
    if (stoppedEarly) {
      results.push({ tokenId: token.id, status: "skipped", newObservations: 0, rawRecords: 0, error: stoppedEarly });
      continue;
    }
    const coinId = coingeckoTokenIds[token.id];
    if (!coinId) {
      results.push({ tokenId: token.id, status: "skipped", newObservations: 0, rawRecords: 0, error: "No CoinGecko mapping." });
      continue;
    }
    try {
      log(`${token.id}: starting market_chart request for CoinGecko ID ${coinId}`);
      const requestStartedAt = Date.now();
      // No `interval` param: CoinGecko may return the provider's native granularity for
      // the 30-day range. Only genuine provider points from that rolling 30-day window
      // are stored. Provider timestamps are never synthesized, rounded, shifted, or retimed.
      const daily = await request(coinId, { days: BACKFILL_DAYS });
      log(`${token.id}: market_chart response received in ${Date.now() - requestStartedAt}ms`);
      const notAfter = Object.fromEntries(latest
        .filter((row) => row.token_id === token.id && row.provider_id === "coingecko")
        .map((row) => [row.metric_id, row.observed_at]));
      log(`${token.id}: checking existing CoinGecko timestamps before normalization`);
      const existing = await existingKeys(client, token.id, new Date(now().getTime() - (BACKFILL_DAYS + 1) * 24 * 60 * 60 * 1000));
      log(`${token.id}: existing timestamp read complete (${existing.size} key(s)); normalizing provider points`);
      const snapshot = normalizeMarketChartHistory({
        asset: { tokenId: token.id, chainId: token.chainId, externalAssetId: coinId },
        daily,
        collectedAt: now().toISOString(),
        notAfter,
        existing,
      });
      log(`${token.id}: normalization complete (${snapshot?.observations.length ?? 0} new observation(s))`);
      if (!snapshot) {
        results.push({ tokenId: token.id, status: "up_to_date", newObservations: 0, rawRecords: 0 });
      } else if (options.dryRun) {
        results.push({ tokenId: token.id, status: "backfilled", newObservations: snapshot.observations.length, rawRecords: 0 });
      } else {
        log(`${token.id}: persisting ${snapshot.observations.length} observation(s)`);
        const persisted = await persistProviderSnapshots(client, [snapshot]);
        log(`${token.id}: persistence complete (${persisted.observations} observation(s), ${persisted.rawRecords} raw record(s))`);
        results.push({ tokenId: token.id, status: persisted.observations > 0 ? "backfilled" : "up_to_date", newObservations: persisted.observations, rawRecords: persisted.rawRecords });
      }
      const result = results.at(-1)!;
      log(`${token.id}: ${result.status} (${result.newObservations} new observation(s))`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown backfill error.";
      results.push({ tokenId: token.id, status: "failed", newObservations: 0, rawRecords: 0, error: message });
      log(`${token.id}: failed (${message})`);
      // Rate-limit or credential failures stop the run rather than burning quota on retries.
      if (error instanceof CoinGeckoApiError && (error.status === 429 || error.status === 401 || error.status === 403)) {
        stoppedEarly = `Stopped after ${message}`;
      }
    }
  }
  return { results, requests, stoppedEarly };
}
