import { configuredGeckoTerminalAssets, MIN_REQUEST_INTERVAL_MS, type GeckoTerminalAsset } from "./geckoterminal.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export const GECKOTERMINAL_GAP_DAYS = 30;
// GeckoTerminal's public API is far more rate-limited (~10 req/min, see
// MIN_REQUEST_INTERVAL_MS) than CoinGecko's, so this stays well below that
// provider's MAX_GAP_REPAIR_TOKENS of 10: 5 requests * 6.5s pacing adds well
// under a minute to one refresh tick.
export const MAX_GAP_REPAIR_TOKENS = 5;
const BASE_URL = "https://api.geckoterminal.com/api/v2/";

const METRICS = ["price_usd", "volume_24h_usd"];

type Gap = { token_id: string; metric_id: string; missing_date: string };
type PoolRow = { pair_address: string };

type OhlcvResponse = {
  data?: { attributes?: { ohlcv_list?: unknown } };
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Each candle is [unixSeconds, open, high, low, close, volumeUsd]; only close/volume are used. */
function dailyCandles(payload: unknown): Array<{ timestamp: number; close: number; volume: number }> {
  const list = (payload as OhlcvResponse)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Array<{ timestamp: number; close: number; volume: number }> = [];
  for (const candle of list) {
    if (!Array.isArray(candle) || candle.length < 6) continue;
    const [timestamp, , , , close, volume] = candle;
    if (!isFiniteNumber(timestamp) || !isFiniteNumber(close) || !isFiniteNumber(volume)) continue;
    out.push({ timestamp, close, volume });
  }
  return out;
}

async function fetchDailyOhlcv(
  asset: GeckoTerminalAsset,
  poolAddress: string,
  days: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(`networks/${encodeURIComponent(asset.gtNetworkId)}/pools/${encodeURIComponent(poolAddress)}/ohlcv/day`, BASE_URL);
  url.searchParams.set("aggregate", "1");
  // One extra day of headroom for UTC/candle-boundary rounding.
  url.searchParams.set("limit", String(days + 1));
  url.searchParams.set("currency", "usd");
  // The exact token's own price, never the pool's quote-side price.
  url.searchParams.set("token", "base");
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GeckoTerminal OHLCV request returned HTTP ${response.status}.`);
  return response.json();
}

/**
 * Bounded, provider-native recovery for missed completed UTC days of
 * GeckoTerminal price_usd/volume_24h_usd, mirroring repair-coingecko-daily-gaps.ts
 * and repair-defillama-daily-gaps.ts. Uses the exact base-token pool's own daily
 * OHLCV history (close price, volume) -- real provider data, never interpolated
 * or synthesized.
 *
 * Only price_usd and volume_24h_usd are repairable this way: liquidity_usd,
 * fdv_usd, market_cap_usd, and the buy/sell/transaction counts are point-in-time
 * pool state with no historical series in GeckoTerminal's public API, so a
 * missed snapshot for those fields is not recoverable.
 *
 * The primary pool address is read from the already-persisted provider_pairs
 * row (most recently seen), not re-selected via a live pools call, to avoid
 * spending extra request budget against GeckoTerminal's strict ~10 req/min limit.
 */
export async function repairGeckoTerminalDailyGaps(
  client: SupabaseAdminClient,
  options: {
    now?: () => Date;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const endDate = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate() - 1)).toISOString().slice(0, 10);
  const startDate = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate() - GECKOTERMINAL_GAP_DAYS)).toISOString().slice(0, 10);

  const { data: gaps, error: gapError } = await client.rpc("get_provider_daily_gaps", {
    p_provider_id: "geckoterminal",
    p_start_date: startDate,
    p_end_date: endDate,
    p_metric_ids: METRICS,
  });
  if (gapError) throw new Error(`Supabase GeckoTerminal daily gap audit failed: ${gapError.message}`);

  const allGaps = (gaps ?? []) as Gap[];
  const tokenIds = [...new Set(allGaps.map((gap) => gap.token_id))].slice(0, MAX_GAP_REPAIR_TOKENS);
  if (tokenIds.length === 0) {
    return { checkedDays: GECKOTERMINAL_GAP_DAYS, affectedTokens: 0, requests: 0, observations: 0, remainingTokens: 0 };
  }

  const assetByToken = new Map(configuredGeckoTerminalAssets().map((asset) => [asset.tokenId, asset]));

  let requests = 0;
  let observations = 0;
  for (const tokenId of tokenIds) {
    const asset = assetByToken.get(tokenId);
    if (!asset) continue;

    const { data: pool } = await client.from("provider_pairs")
      .select("pair_address")
      .eq("provider_id", "geckoterminal")
      .eq("token_id", tokenId)
      .is("excluded_reason", null)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const poolAddress = (pool as PoolRow | null)?.pair_address;
    if (!poolAddress) continue;

    if (requests > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    requests += 1;
    const payload = await fetchDailyOhlcv(asset, poolAddress, GECKOTERMINAL_GAP_DAYS, fetchImpl);
    const candles = dailyCandles(payload);

    const missing = new Set(
      allGaps.filter((gap) => gap.token_id === tokenId).map((gap) => `${gap.metric_id}|${gap.missing_date}`),
    );
    if (missing.size === 0) continue;

    const { data: mapping } = await client.from("provider_token_mappings")
      .select("id")
      .eq("provider_id", "geckoterminal")
      .eq("token_id", tokenId)
      .maybeSingle();
    const mappingId = (mapping as { id: number } | null)?.id ?? null;

    const rows: Record<string, unknown>[] = [];
    for (const candle of candles) {
      const observedAt = new Date(candle.timestamp * 1000).toISOString();
      const day = observedAt.slice(0, 10);
      if (missing.has(`price_usd|${day}`)) {
        rows.push({
          token_id: tokenId,
          chain_id: asset.chainId,
          metric_id: "price_usd",
          provider_id: "geckoterminal",
          raw_record_id: null,
          value: candle.close,
          window_days: null,
          status: "available",
          observed_at: observedAt,
          collected_at: now().toISOString(),
          source_field: "ohlcv.close",
          note: "GeckoTerminal automatic gap repair from the exact base-token pool's daily OHLCV; one real provider point per missing UTC day; no values were interpolated or synthesized.",
          scope: "market",
          provider_asset_id: asset.externalAssetId,
          mapping_id: mappingId,
        });
      }
      if (missing.has(`volume_24h_usd|${day}`)) {
        rows.push({
          token_id: tokenId,
          chain_id: asset.chainId,
          metric_id: "volume_24h_usd",
          provider_id: "geckoterminal",
          raw_record_id: null,
          value: candle.volume,
          window_days: 1,
          status: "available",
          observed_at: observedAt,
          collected_at: now().toISOString(),
          source_field: "ohlcv.volume",
          note: "GeckoTerminal automatic gap repair from the exact base-token pool's daily OHLCV; one real provider point per missing UTC day; no values were interpolated or synthesized.",
          scope: "market",
          provider_asset_id: asset.externalAssetId,
          mapping_id: mappingId,
        });
      }
    }
    if (rows.length === 0) continue;

    const { error } = await client.from("token_metric_observations").insert(rows);
    if (error) throw new Error(`Supabase GeckoTerminal daily gap repair insert failed: ${error.message}`);
    observations += rows.length;
  }

  return {
    checkedDays: GECKOTERMINAL_GAP_DAYS,
    affectedTokens: tokenIds.length,
    requests,
    observations,
    remainingTokens: Math.max(0, new Set(allGaps.map((gap) => gap.token_id)).size - tokenIds.length),
  };
}
