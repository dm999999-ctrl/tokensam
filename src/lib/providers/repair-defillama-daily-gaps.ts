import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { getDefiLlamaConfig } from "./defillama.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const LOOKBACK_DAYS = 14;
const MAX_PROTOCOL_TOKENS = 1;
const MAX_COIN_PRICE_TOKENS = 10;
const PROTOCOL_METRICS = ["tvl_usd"];
const COIN_METRICS = ["price_usd"];
const COINS_BASE_URL = "https://coins.llama.fi";

type Gap = { token_id: string; metric_id: string; missing_date: string };
type Mapping = { id: number; token_id: string; external_asset_id: string; chain_id: string };

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function dayEndExclusive(date: string): number {
  return dayStart(date) + 24 * 60 * 60 * 1000;
}

function completedWindow(now = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return await response.json() as T;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Historical provider request returned HTTP ${response.status}.`);
      }
      lastError = new Error(`Historical provider request returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await sleep(1_500);
  }
  throw lastError instanceof Error ? lastError : new Error("Historical provider request failed.");
}

function dailyCoinPoints(payload: unknown, key: string): Array<{ timestamp: number; price: number }> {
  const prices = (payload as { coins?: Record<string, { prices?: unknown[] }> })?.coins?.[key]?.prices;
  if (!Array.isArray(prices)) return [];
  const byDay = new Map<string, { timestamp: number; price: number }>();
  for (const item of prices) {
    if (!Array.isArray(item) || item.length < 2 || !isFiniteNumber(item[0]) || !isFiniteNumber(item[1])) continue;
    const timestamp = item[0];
    const price = item[1];
    const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const previous = byDay.get(day);
    if (!previous || Math.abs(timestamp * 1000 - dayStart(day)) < Math.abs(previous.timestamp * 1000 - dayStart(day))) {
      byDay.set(day, { timestamp, price });
    }
  }
  return [...byDay.values()];
}

function dailyProtocolTvl(protocol: unknown): Array<{ date: number; value: number }> {
  const points = (protocol as { tvl?: unknown[] })?.tvl;
  if (!Array.isArray(points)) return [];
  const byDay = new Map<string, { date: number; value: number }>();
  for (const point of points) {
    const date = (point as { date?: unknown })?.date;
    const value = (point as { totalLiquidityUSD?: unknown })?.totalLiquidityUSD;
    if (!isFiniteNumber(date) || !isFiniteNumber(value)) continue;
    const day = new Date(date * 1000).toISOString().slice(0, 10);
    const previous = byDay.get(day);
    if (!previous || Math.abs(date * 1000 - dayStart(day)) < Math.abs(previous.date * 1000 - dayStart(day))) {
      byDay.set(day, { date, value });
    }
  }
  return [...byDay.values()];
}

async function insertMissing(
  client: SupabaseAdminClient,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await client.from("token_metric_observations").insert(rows);
  if (error) throw new Error(`Supabase provider gap repair insert failed: ${error.message}`);
  return rows.length;
}

/**
 * Bounded, provider-native recovery for missed completed UTC days.
 *
 * DeFiLlama protocol TVL uses /protocol/{slug}; token-level prices use /chart/{coins}.
 * Fees/revenue are intentionally not repaired here because the current public integration
 * only has daily summary endpoints for those metrics, not a historical series endpoint.
 *
 * No raw_provider_records are created: these are recovery observations only, keeping
 * storage growth bounded. Existing observations are never overwritten.
 */
export async function repairDefiLlamaDailyGaps(
  client: SupabaseAdminClient,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  } = {},
) {
  getDefiLlamaConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const { start, end } = completedWindow(now());

  const [protocolResult, coinResult] = await Promise.all([
    client.rpc("get_provider_daily_gaps", {
      p_provider_id: "defillama",
      p_start_date: start,
      p_end_date: end,
      p_metric_ids: PROTOCOL_METRICS,
    }),
    client.rpc("get_provider_daily_gaps", {
      p_provider_id: "defillama_coins",
      p_start_date: start,
      p_end_date: end,
      p_metric_ids: COIN_METRICS,
    }),
  ]);
  if (protocolResult.error) throw new Error(`Supabase DeFiLlama protocol gap lookup failed: ${protocolResult.error.message}`);
  if (coinResult.error) throw new Error(`Supabase DeFiLlama coins gap lookup failed: ${coinResult.error.message}`);

  const protocolGaps = (protocolResult.data ?? []) as Gap[];
  const coinGaps = (coinResult.data ?? []) as Gap[];
  const protocolTokenIds = [...new Set(protocolGaps.map((gap) => gap.token_id))].slice(0, MAX_PROTOCOL_TOKENS);
  const coinTokenIds = [...new Set(coinGaps.map((gap) => gap.token_id))].slice(0, MAX_COIN_PRICE_TOKENS);

  let observations = 0;
  let protocolRequests = 0;
  let coinRequests = 0;

  if (protocolTokenIds.length > 0) {
    const { data: mappings, error } = await client
      .from("provider_token_mappings")
      .select("id,token_id,external_asset_id,chain_id")
      .eq("provider_id", "defillama")
      .in("token_id", protocolTokenIds);
    if (error) throw new Error(`Supabase DeFiLlama protocol mapping lookup failed: ${error.message}`);
    const mappingByToken = new Map((mappings ?? []).map((row) => [row.token_id, row as Mapping]));
    const gapsByToken = new Map<string, Set<string>>();
    for (const gap of protocolGaps) if (protocolTokenIds.includes(gap.token_id)) {
      if (!gapsByToken.has(gap.token_id)) gapsByToken.set(gap.token_id, new Set());
      gapsByToken.get(gap.token_id)!.add(gap.missing_date);
    }

    for (const tokenId of protocolTokenIds) {
      const mapping = mappingByToken.get(tokenId);
      const requiredDays = gapsByToken.get(tokenId);
      if (!mapping || !requiredDays || requiredDays.size === 0) continue;
      const url = `https://api.llama.fi/protocol/${encodeURIComponent(mapping.external_asset_id)}`;
      const payload = await fetchJson<unknown>(url, fetchImpl, sleep);
      protocolRequests += 1;
      const points = dailyProtocolTvl(payload);
      const rows = points
        .filter((point) => requiredDays.has(new Date(point.date * 1000).toISOString().slice(0, 10)))
        .map((point) => ({
          token_id: tokenId,
          chain_id: mapping.chain_id,
          metric_id: "tvl_usd",
          provider_id: "defillama",
          raw_record_id: null,
          value: point.value,
          window_days: null,
          status: "available",
          observed_at: new Date(point.date * 1000).toISOString(),
          collected_at: now().toISOString(),
          source_field: "tvl[].totalLiquidityUSD",
          note: "Provider-native daily gap repair from DeFiLlama /protocol/{slug}; real historical point, no interpolation.",
          scope: "protocol",
          provider_asset_id: mapping.external_asset_id,
          mapping_id: mapping.id,
        }));
      observations += await insertMissing(client, rows);
    }
  }

  if (coinTokenIds.length > 0) {
    const { data: mappings, error } = await client
      .from("provider_token_mappings")
      .select("token_id,external_asset_id,chain_id")
      .eq("provider_id", "defillama_coins")
      .in("token_id", coinTokenIds);
    if (error) throw new Error(`Supabase DeFiLlama coins mapping lookup failed: ${error.message}`);
    const mappingByToken = new Map((mappings ?? []).map((row) => [row.token_id, row as Mapping]));
    const keys = coinTokenIds.map((tokenId) => mappingByToken.get(tokenId)?.external_asset_id).filter((value): value is string => Boolean(value));
    if (keys.length > 0) {
      const params = new URLSearchParams({
        start: String(Math.floor(dayStart(start) / 1000)),
        end: String(Math.floor(dayEndExclusive(end) / 1000)),
        period: "1d",
      });
      const url = `${COINS_BASE_URL}/chart/${keys.map(encodeURIComponent).join(",")}?${params.toString()}`;
      const payload = await fetchJson<unknown>(url, fetchImpl, sleep);
      coinRequests += 1;

      const rows: Record<string, unknown>[] = [];
      for (const tokenId of coinTokenIds) {
        const mapping = mappingByToken.get(tokenId);
        if (!mapping) continue;
        const requiredDays = new Set(coinGaps.filter((gap) => gap.token_id === tokenId).map((gap) => gap.missing_date));
        const points = dailyCoinPoints(payload, mapping.external_asset_id);
        for (const point of points) {
          const day = new Date(point.timestamp * 1000).toISOString().slice(0, 10);
          if (!requiredDays.has(day)) continue;
          rows.push({
            token_id: tokenId,
            chain_id: mapping.chain_id,
            metric_id: "price_usd",
            provider_id: "defillama_coins",
            raw_record_id: null,
            value: point.price,
            window_days: null,
            status: "available",
            observed_at: new Date(point.timestamp * 1000).toISOString(),
            collected_at: now().toISOString(),
            source_field: `coins["${mapping.external_asset_id}"].prices`,
            note: "Provider-native daily gap repair from DeFiLlama coins /chart; real historical point, no interpolation.",
            scope: "token",
            provider_asset_id: mapping.external_asset_id,
            mapping_id: null,
          });
        }
      }
      observations += await insertMissing(client, rows);
    }
  }

  return {
    checkedDays: LOOKBACK_DAYS,
    protocolAffectedTokens: [...new Set(protocolGaps.map((gap) => gap.token_id))].length,
    coinPriceAffectedTokens: [...new Set(coinGaps.map((gap) => gap.token_id))].length,
    protocolRequests,
    coinRequests,
    observations,
    remainingProtocolTokens: Math.max(0, [...new Set(protocolGaps.map((gap) => gap.token_id))].length - protocolTokenIds.length),
    remainingCoinTokens: Math.max(0, [...new Set(coinGaps.map((gap) => gap.token_id))].length - coinTokenIds.length),
  };
}
