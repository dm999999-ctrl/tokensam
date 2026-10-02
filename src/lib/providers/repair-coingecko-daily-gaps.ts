import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { fetchMarketChart, normalizeMarketChartHistory } from "./coingecko-history.ts";
import { getCoinGeckoConfig, MIN_REQUEST_INTERVAL_MS } from "./coingecko.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export const COINGECKO_GAP_DAYS = 30;
export const MAX_GAP_REPAIR_TOKENS = 10;

const METRICS = ["price_usd", "market_cap_usd", "volume_24h_usd"];

type Gap = { token_id: string; metric_id: string; missing_date: string };

function utcDateDaysAgo(days: number, now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function toObservationRows(
  tokenId: string,
  chainId: string,
  externalAssetId: string,
  missing: Set<string>,
  payload: Awaited<ReturnType<typeof fetchMarketChart>>,
  collectedAt: string,
) {
  const snapshot = normalizeMarketChartHistory({
    asset: { tokenId, chainId, externalAssetId },
    daily: payload,
    collectedAt,
    notAfter: {},
    existing: new Set(),
  });
  if (!snapshot) return [];
  return snapshot.observations
    .filter((row) => {
      const day = row.observedAt.slice(0, 10);
      return missing.has(`${row.metricId}|${day}`);
    })
    .map((row) => ({
      token_id: row.tokenId,
      chain_id: row.chainId,
      metric_id: row.metricId,
      provider_id: "coingecko",
      raw_record_id: null,
      value: row.value,
      window_days: row.windowDays,
      status: row.status,
      observed_at: row.observedAt,
      collected_at: row.collectedAt,
      source_field: row.sourceField,
      note: "CoinGecko automatic gap repair; one real provider point per missing UTC day; no values were interpolated or synthesized.",
      scope: row.scope,
      provider_asset_id: externalAssetId,
      mapping_id: null as number | null,
    }));
}

/**
 * Repairs only missing daily CoinGecko observations in the last 30 completed UTC days.
 * It deliberately does not write raw market_chart payloads and does not run a 90-day
 * backfill, keeping automatic recovery bounded in both storage and API usage.
 */
export async function repairCoinGeckoDailyGaps(
  client: SupabaseAdminClient,
  options: {
    now?: () => Date;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const config = getCoinGeckoConfig(options.env);
  const endDate = utcDateDaysAgo(1, now());
  const startDate = utcDateDaysAgo(COINGECKO_GAP_DAYS, now());

  const { data: gaps, error: gapError } = await client.rpc("get_coingecko_daily_gaps", {
    p_start_date: startDate,
    p_end_date: endDate,
    p_metric_ids: METRICS,
  });
  if (gapError) throw new Error(`Supabase CoinGecko daily gap audit failed: ${gapError.message}`);

  const allGaps = (gaps ?? []) as Gap[];
  const tokenIds = [...new Set(allGaps.map((gap) => gap.token_id))].slice(0, MAX_GAP_REPAIR_TOKENS);
  if (tokenIds.length === 0) {
    return { checkedDays: COINGECKO_GAP_DAYS, affectedTokens: 0, requests: 0, observations: 0, remainingTokens: 0 };
  }

  const sleepBetweenRequests = async () => {
    await sleep(MIN_REQUEST_INTERVAL_MS);
  };

  let requests = 0;
  let observations = 0;
  for (const tokenId of tokenIds) {
    const token = canonicalTokens.find((item) => item.id === tokenId);
    const externalAssetId = token ? coingeckoTokenIds[token.id] : undefined;
    if (!token || !externalAssetId) continue;

    if (requests > 0) await sleepBetweenRequests();
    requests += 1;
    const payload = await fetchMarketChart(externalAssetId, { days: COINGECKO_GAP_DAYS + 1 }, {
      ...config,
      fetchImpl,
      sleep,
    });

    const missing = new Set(
      allGaps
        .filter((gap) => gap.token_id === tokenId)
        .map((gap) => `${gap.metric_id}|${gap.missing_date}`),
    );
    const rows = toObservationRows(token.id, token.chainId, externalAssetId, missing, payload, now().toISOString());
    if (rows.length === 0) continue;

    const { data: mapping } = await client.from("provider_token_mappings")
      .select("id")
      .eq("provider_id", "coingecko")
      .eq("token_id", token.id)
      .maybeSingle();
    const mappingId = (mapping as { id: number } | null)?.id ?? null;
    for (const row of rows) row.mapping_id = mappingId;

    const { error } = await client.from("token_metric_observations").insert(rows);
    if (error) throw new Error(`Supabase CoinGecko daily gap repair insert failed: ${error.message}`);
    observations += rows.length;
  }

  return {
    checkedDays: COINGECKO_GAP_DAYS,
    affectedTokens: tokenIds.length,
    requests,
    observations,
    remainingTokens: Math.max(0, new Set(allGaps.map((gap) => gap.token_id)).size - tokenIds.length),
  };
}
