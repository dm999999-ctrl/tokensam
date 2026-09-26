import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { readLatestObservations } from "../data/observation-reads.ts";
import { CoinGeckoApiError, MIN_REQUEST_INTERVAL_MS, getCoinGeckoConfig } from "./coingecko.ts";
import { fetchMarketChart, normalizeMarketChartHistory } from "./coingecko-history.ts";
import { existingKeys } from "./run-coingecko-backfill.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const DAILY_METRICS = ["price_usd", "market_cap_usd", "volume_24h_usd"];
/**
 * Small bounded lookback for the automated daily step: enough to pick up the
 * newest completed day, plus a few days of slack if a run or two was missed,
 * without repeating the manual backfill's full 90-day pull every day. One
 * request per token (interval=daily only; no hourly reconciliation call).
 */
const DAILY_LOOKBACK_DAYS = 7;

export type DailyHistoryTokenResult = {
  tokenId: string;
  status: "advanced" | "up_to_date" | "failed" | "skipped";
  newObservations: number;
  latestObservedAt: string | null;
  error?: string;
};

function utcDateString(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Automated, bounded, idempotent CoinGecko daily-history step.
 *
 * Reuses the exact backfill normalization and persistence functions
 * (coingecko-history.ts, persist-snapshots.ts) so the stored representation
 * is identical to what dailySamples() (src/lib/indicators/series.ts) already
 * consumes, and identical to what the manual backfill produces.
 *
 * Differences from the manual backfill (scripts/backfill-coingecko.mjs):
 * - a 7-day lookback instead of 90, since this runs automatically every day;
 * - no separate 7-day hourly reconciliation call (the daily job only needs
 *   genuine daily-interval points);
 * - any provider point dated the *current* UTC day is dropped before
 *   persistence: the current day is never a completed day yet, so it is
 *   never treated as a daily close, however the provider timestamps it.
 */
export async function runCoinGeckoDailyHistory(
  client: SupabaseAdminClient,
  options: {
    tokenIds?: string[];
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  } = {},
): Promise<{ provider: "coingecko_daily"; tokensChecked: number; requests: number; newObservations: number; advanced: boolean; latestObservedAt: string | null; notYetAvailable?: string; results: DailyHistoryTokenResult[] }> {
  const config = getCoinGeckoConfig(options.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const today = utcDateString(now().toISOString());

  const tokens = canonicalTokens.filter((token) => !options.tokenIds || options.tokenIds.includes(token.id));
  const latest = await readLatestObservations<{ id: number; token_id: string; provider_id: string; metric_id: string; observed_at: string; collected_at: string }>(
    client,
    tokens.map((token) => token.id),
  );

  const results: DailyHistoryTokenResult[] = [];
  let requests = 0;
  let latestObservedAt: string | null = null;
  let stoppedEarly: string | null = null;

  for (const token of tokens) {
    if (stoppedEarly) {
      results.push({ tokenId: token.id, status: "skipped", newObservations: 0, latestObservedAt: null, error: stoppedEarly });
      continue;
    }
    const coinId = coingeckoTokenIds[token.id];
    if (!coinId) {
      results.push({ tokenId: token.id, status: "skipped", newObservations: 0, latestObservedAt: null, error: "No CoinGecko mapping." });
      continue;
    }
    try {
      if (requests > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
      requests += 1;
      const daily = await fetchMarketChart(coinId, { days: DAILY_LOOKBACK_DAYS, interval: "daily" }, { ...config, fetchImpl, sleep });
      const notAfter = Object.fromEntries(latest
        .filter((row) => row.token_id === token.id && row.provider_id === "coingecko")
        .map((row) => [row.metric_id, row.observed_at]));
      const since = new Date(now().getTime() - (DAILY_LOOKBACK_DAYS + 1) * 24 * 60 * 60 * 1000);
      const snapshot = normalizeMarketChartHistory({
        asset: { tokenId: token.id, chainId: token.chainId, externalAssetId: coinId },
        daily,
        hourly: {},
        collectedAt: now().toISOString(),
        notAfter,
        existing: await existingKeys(client, token.id, since),
      });
      // Never treat the current, still-open UTC day as a completed daily close,
      // regardless of how the provider timestamps its most recent point.
      const completed = snapshot
        ? { ...snapshot, observations: snapshot.observations.filter((observation) => utcDateString(observation.observedAt) < today) }
        : null;
      if (!completed || completed.observations.length === 0) {
        results.push({ tokenId: token.id, status: "up_to_date", newObservations: 0, latestObservedAt: null });
        continue;
      }
      const persisted = await persistProviderSnapshots(client, [{ ...completed, observedAt: completed.observations.at(-1)!.observedAt }]);
      const newestForToken = completed.observations.filter((observation) => DAILY_METRICS.includes(observation.metricId)).at(-1)?.observedAt ?? null;
      if (persisted.observations > 0 && newestForToken) {
        if (latestObservedAt === null || newestForToken.localeCompare(latestObservedAt) > 0) {
          latestObservedAt = newestForToken;
        }
      }
      results.push({ tokenId: token.id, status: persisted.observations > 0 ? "advanced" : "up_to_date", newObservations: persisted.observations, latestObservedAt: persisted.observations > 0 ? newestForToken : null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown daily-history error.";
      results.push({ tokenId: token.id, status: "failed", newObservations: 0, latestObservedAt: null, error: message });
      // Rate-limit or credential failures stop the run rather than burning quota on retries.
      if (error instanceof CoinGeckoApiError && (error.status === 429 || error.status === 401 || error.status === 403)) {
        stoppedEarly = `Stopped after ${message}`;
      }
    }
  }

  const advanced = results.some((result) => result.status === "advanced");
  const attempted = results.filter((result) => result.status !== "skipped");
  const allFailed = attempted.length > 0 && attempted.every((result) => result.status === "failed");
  if (allFailed) {
    throw new Error(`CoinGecko daily history failed for every checked token: ${attempted[0].error ?? "unknown error"}`);
  }

  return {
    provider: "coingecko_daily",
    tokensChecked: tokens.length,
    requests,
    newObservations: results.reduce((sum, result) => sum + result.newObservations, 0),
    advanced,
    latestObservedAt,
    notYetAvailable: advanced ? undefined : "No new completed UTC daily point was available from CoinGecko for any mapped token.",
    results,
  };
}
