import { createHash } from "node:crypto";
import { addressEquals } from "../providers/dexscreener.ts";

/** v2: source-scope enforcement and scope-explicit metric names (token-centric architecture). */
export const CALCULATION_VERSION = "3";

/**
 * The scope each provider input must have. A row with any other scope (for
 * example a DeFiLlama "chain" or "token" TVL) is never used as an input, so a
 * protocol metric cannot be fed chain data and token metrics cannot be fed
 * protocol data. Rows stored before scope existed (no scope) keep their
 * provider's historical scope.
 */
export const INPUT_SCOPES: Record<string, "token" | "protocol" | "market"> = {
  coingecko: "token",
  defillama: "protocol",
  dexscreener: "market",
};

export function hasCompatibleScope(row: { provider_id: string; scope?: string | null }): boolean {
  const expected = INPUT_SCOPES[row.provider_id];
  return !expected || !row.scope || row.scope === expected;
}

export type ObservationInput = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: string;
  raw_record_id: number | null;
  value: number | string | null;
  status: string;
  observed_at: string;
  collected_at: string;
  source_field: string | null;
  note: string | null;
  scope?: string | null;
};

export type RawRecordInput = {
  id: number;
  provider_id: string;
  token_id: string | null;
  chain_id: string | null;
  collected_at: string;
  endpoint_label: string | null;
  payload: unknown;
};

export type TokenInput = { id: string; chain_id: string; name: string; symbol: string };

export type MetricDefinition = {
  id: string;
  name: string;
  category: "valuation" | "growth" | "market_structure" | "divergence";
  unit: "USD" | "ratio" | "percent" | "percentage_points" | "count" | "boolean";
  formula: string;
  /** Economic scopes of the inputs, e.g. "token/protocol" for market cap / associated protocol TVL. */
  sourceScopes: string;
};

export type CalculatedMetricRow = {
  token_id: string;
  chain_id: string;
  metric_id: string;
  metric_name: string;
  unit: MetricDefinition["unit"];
  value: number | null;
  status: "available" | "unavailable" | "invalid";
  formula: string;
  calculation_version: string;
  input_fingerprint: string;
  source_observation_ids: number[];
  source_raw_record_ids: number[];
  provenance: Record<string, unknown>;
  period_start_at: string | null;
  period_end_at: string | null;
  calculated_at: string;
};

export const CALCULATED_METRICS: MetricDefinition[] = [
  { id: "market_cap_to_tvl", name: "Market cap / associated protocol TVL", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko market_cap_usd / DeFiLlama protocol tvl_usd" },
  { id: "fdv_to_tvl", name: "DEX-reported FDV / associated protocol TVL", sourceScopes: "market/protocol", category: "valuation", unit: "ratio", formula: "DEX Screener primary-pair fdv_usd / DeFiLlama protocol tvl_usd" },
  { id: "market_cap_to_revenue_24h", name: "Market cap / associated protocol 24h revenue", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko market_cap_usd / DeFiLlama revenue_24h_usd" },
  { id: "fdv_to_revenue_24h", name: "DEX-reported FDV / associated protocol 24h revenue", sourceScopes: "market/protocol", category: "valuation", unit: "ratio", formula: "DEX Screener primary-pair fdv_usd / DeFiLlama revenue_24h_usd" },
  { id: "volume_to_market_cap", name: "Volume / market cap", sourceScopes: "token", category: "valuation", unit: "ratio", formula: "CoinGecko volume_24h_usd / CoinGecko market_cap_usd" },
  { id: "tvl_growth_pct", name: "Associated protocol TVL growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "(latest DeFiLlama tvl_usd / previous DeFiLlama tvl_usd - 1) * 100" },
  { id: "revenue_growth_pct", name: "Associated protocol revenue growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "(latest DeFiLlama revenue_24h_usd / previous DeFiLlama revenue_24h_usd - 1) * 100" },
  { id: "fees_growth_pct", name: "Associated protocol fees growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "(latest DeFiLlama fees_24h_usd / previous DeFiLlama fees_24h_usd - 1) * 100" },
  { id: "price_growth_pct", name: "Price growth", sourceScopes: "token", category: "growth", unit: "percent", formula: "(latest CoinGecko price_usd / previous CoinGecko price_usd - 1) * 100" },
  { id: "market_cap_growth_pct", name: "Market cap growth", sourceScopes: "token", category: "growth", unit: "percent", formula: "(latest CoinGecko market_cap_usd / previous CoinGecko market_cap_usd - 1) * 100" },
  { id: "price_change_vs_tvl_growth_pct_points", name: "Price change vs associated protocol TVL growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "price growth percent - TVL growth percent over timestamp-aligned start/end pairs" },
  { id: "price_change_vs_revenue_growth_pct_points", name: "Price change vs associated protocol revenue growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "price growth percent - protocol revenue growth percent over timestamp-aligned start/end pairs" },
  { id: "market_cap_change_vs_tvl_growth_pct_points", name: "Market-cap change vs associated protocol TVL growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "market-cap growth percent - TVL growth percent over timestamp-aligned start/end pairs" },
  { id: "market_cap_change_vs_revenue_growth_pct_points", name: "Market-cap change vs associated protocol revenue growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "market-cap growth percent - protocol revenue growth percent over timestamp-aligned start/end pairs" },
  { id: "dex_aggregate_volume_24h_usd", name: "Aggregate DEX volume (24h)", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "sum exact-address DEX pair volume.h24" },
  { id: "dex_aggregate_liquidity_usd", name: "Aggregate DEX liquidity", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "sum exact-address DEX pair liquidity.usd" },
  { id: "dex_primary_pair_liquidity_usd", name: "Primary-pair liquidity", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "liquidity.usd for primary exact-address pair" },
  { id: "dex_primary_pair_volume_24h_usd", name: "Primary-pair volume (24h)", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "volume.h24 for primary exact-address pair" },
  { id: "dex_liquidity_to_market_cap_pct", name: "Primary-pair liquidity / market cap", sourceScopes: "market/token", category: "market_structure", unit: "percent", formula: "primary-pair liquidity / CoinGecko market_cap_usd * 100" },
  { id: "dex_aggregate_liquidity_to_market_cap_pct", name: "Aggregate DEX liquidity / market cap", sourceScopes: "market/token", category: "market_structure", unit: "percent", formula: "aggregate DEX liquidity / CoinGecko market_cap_usd * 100" },
  { id: "dex_volume_to_liquidity", name: "DEX volume / liquidity", sourceScopes: "market", category: "market_structure", unit: "ratio", formula: "aggregate exact-address DEX volume.h24 / aggregate exact-address DEX liquidity.usd" },
  { id: "dex_buy_sell_ratio", name: "DEX buy / sell transaction ratio", sourceScopes: "market", category: "market_structure", unit: "ratio", formula: "exact-address DEX buys_24h_count / sells_24h_count" },
  { id: "divergence_price_up_tvl_down", name: "Price up, associated protocol TVL down", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "price growth > 0 AND TVL growth < 0 on aligned intervals" },
  { id: "divergence_price_down_tvl_up", name: "Price down, associated protocol TVL up", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "price growth < 0 AND TVL growth > 0 on aligned intervals" },
  { id: "divergence_market_cap_up_faster_tvl", name: "Market cap grew faster than associated protocol TVL", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "market-cap growth > TVL growth on aligned intervals" },
  { id: "divergence_tvl_up_faster_market_cap", name: "Associated protocol TVL grew faster than market cap", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "TVL growth > market-cap growth on aligned intervals" },
  { id: "divergence_revenue_up_market_cap_down", name: "Associated protocol revenue up, market cap down", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "protocol revenue growth > 0 AND market-cap growth < 0 on aligned intervals" },
  { id: "divergence_revenue_down_market_cap_up", name: "Associated protocol revenue down, market cap up", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "protocol revenue growth < 0 AND market-cap growth > 0 on aligned intervals" },
];

type SourceRef = Record<string, unknown> & { id: number; source_kind: "observation" | "raw_record"; raw_record_id?: number | null };
type Calculation = {
  value: number | null;
  status: CalculatedMetricRow["status"];
  sources: SourceRef[];
  rawRecords?: RawRecordInput[];
  reason?: string;
  startAt?: string | null;
  endAt?: string | null;
  details?: Record<string, unknown>;
};
type SeriesPoint = { observation: ObservationInput; value: number; time: number };

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function observationRef(row: ObservationInput): SourceRef {
  return {
    id: row.id,
    source_kind: "observation",
    provider_id: row.provider_id,
    token_id: row.token_id,
    chain_id: row.chain_id,
    metric_id: row.metric_id,
    value: numeric(row.value),
    status: row.status,
    observed_at: row.observed_at,
    collected_at: row.collected_at,
    source_field: row.source_field,
    scope: row.scope ?? INPUT_SCOPES[row.provider_id] ?? null,
    note: row.note,
    raw_record_id: row.raw_record_id,
  };
}

function sourceRecord(record: RawRecordInput): Record<string, unknown> {
  return { id: record.id, provider_id: record.provider_id, collected_at: record.collected_at, endpoint_label: record.endpoint_label };
}

function compareLatest(a: ObservationInput, b: ObservationInput): number {
  return Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at)
    || b.id - a.id;
}

function usable(row: ObservationInput | undefined): row is ObservationInput {
  return !!row && row.status === "available" && numeric(row.value) !== null;
}

function availableValue(row: ObservationInput | undefined): number | null {
  return usable(row) ? numeric(row.value) : null;
}

function ref(row: ObservationInput | undefined): SourceRef[] {
  return row ? [observationRef(row)] : [];
}

function chooseLatest(rows: ObservationInput[], provider: string, metric: string): ObservationInput | undefined {
  return rows.filter((row) => row.provider_id === provider && row.metric_id === metric).sort(compareLatest)[0];
}

function series(rows: ObservationInput[], provider: string, metric: string): SeriesPoint[] {
  const candidates = rows.filter((row) => row.provider_id === provider && row.metric_id === metric && usable(row));
  const byTime = new Map<string, ObservationInput>();
  for (const row of candidates.sort(compareLatest)) {
    if (!byTime.has(new Date(row.observed_at).toISOString())) byTime.set(new Date(row.observed_at).toISOString(), row);
  }
  return [...byTime.values()]
    .map((observation) => ({ observation, value: numeric(observation.value) as number, time: Date.parse(observation.observed_at) }))
    .sort((a, b) => a.time - b.time);
}

function unavailable(reason: string, sources: SourceRef[] = [], rawRecords: RawRecordInput[] = []): Calculation {
  return { value: null, status: "unavailable", sources, rawRecords, reason };
}

function invalid(reason: string, sources: SourceRef[] = [], rawRecords: RawRecordInput[] = []): Calculation {
  return { value: null, status: "invalid", sources, rawRecords, reason };
}

function valid(value: number, sources: SourceRef[], options: Omit<Calculation, "value" | "status" | "sources"> = {}): Calculation {
  if (!Number.isFinite(value)) return invalid("The formula produced a non-finite result.", sources, options.rawRecords);
  return { value, status: "available", sources, ...options };
}

function ratio(numerator: ObservationInput | undefined, denominator: ObservationInput | undefined, numeratorLabel: string, denominatorLabel: string): Calculation {
  const sources = [...ref(numerator), ...ref(denominator)];
  const top = availableValue(numerator);
  const bottom = availableValue(denominator);
  if (top === null || bottom === null) return unavailable(`Required input unavailable: ${top === null ? numeratorLabel : denominatorLabel}.`, sources);
  if (top < 0 || bottom < 0) return invalid("Negative values are not valid inputs for this valuation ratio.", sources);
  if (bottom === 0) return unavailable(`Denominator is zero (${denominatorLabel}).`, sources);
  return valid(top / bottom, sources, { startAt: earlier(numerator?.observed_at, denominator?.observed_at), endAt: later(numerator?.observed_at, denominator?.observed_at) });
}

function earlier(a?: string, b?: string): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a?: string, b?: string): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function growthCalculation(points: SeriesPoint[], label: string): Calculation {
  if (points.length < 2) return unavailable(`Insufficient history for ${label}; at least two distinct available observation times are required.`, points.map((point) => observationRef(point.observation)));
  const previous = points.at(-2) as SeriesPoint;
  const current = points.at(-1) as SeriesPoint;
  const sources = [observationRef(previous.observation), observationRef(current.observation)];
  if (previous.value < 0 || current.value < 0) return invalid(`${label} history includes a negative value.`, sources);
  if (previous.value === 0) return unavailable(`Previous ${label} value is zero, so percentage growth is undefined.`, sources);
  return valid(((current.value / previous.value) - 1) * 100, sources, { startAt: previous.observation.observed_at, endAt: current.observation.observed_at });
}

function nearest(point: SeriesPoint, candidates: SeriesPoint[], before: number, tolerance: number): SeriesPoint | undefined {
  return candidates
    .filter((candidate) => candidate.time < before && Math.abs(candidate.time - point.time) <= tolerance)
    .sort((a, b) => Math.abs(a.time - point.time) - Math.abs(b.time - point.time) || b.time - a.time)[0];
}

type CrossChange = { a: number; b: number; sources: SourceRef[]; startAt: string; endAt: string };

function alignedCrossChange(aPoints: SeriesPoint[], bPoints: SeriesPoint[], aName: string, bName: string): CrossChange | Calculation {
  const day = 24 * 60 * 60 * 1000;
  const endPairs = aPoints.flatMap((a) => bPoints
    .filter((b) => Math.abs(a.time - b.time) <= day)
    .map((b) => ({ a, b, time: Math.max(a.time, b.time), diff: Math.abs(a.time - b.time) })))
    .sort((x, y) => y.time - x.time || x.diff - y.diff);
  if (!endPairs.length) return unavailable(`No ${aName}/${bName} observations have end times within 24 hours.`);

  for (const end of endPairs) {
    const aPriorCandidates = aPoints.filter((point) => point.time < end.a.time).sort((x, y) => y.time - x.time);
    for (const aPrior of aPriorCandidates) {
      const bPrior = nearest(aPrior, bPoints.filter((point) => point.time < end.b.time), aPrior.time + day, day);
      if (!bPrior) continue;
      const aDuration = end.a.time - aPrior.time;
      const bDuration = end.b.time - bPrior.time;
      if (Math.abs(aDuration - bDuration) > day) continue;
      const startAt = Math.max(aPrior.time, bPrior.time);
      const endAt = Math.min(end.a.time, end.b.time);
      if (startAt >= endAt) continue;
      const sources = [aPrior, end.a, bPrior, end.b].map((point) => observationRef(point.observation));
      if ([aPrior.value, end.a.value, bPrior.value, end.b.value].some((value) => value < 0)) {
        return invalid("Aligned history includes a negative value.", sources);
      }
      if (aPrior.value === 0 || bPrior.value === 0) return unavailable("A previous aligned value is zero, so percentage change is undefined.", sources);
      return {
        a: ((end.a.value / aPrior.value) - 1) * 100,
        b: ((end.b.value / bPrior.value) - 1) * 100,
        sources,
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
      };
    }
  }
  return unavailable(`Insufficient timestamp-aligned history for ${aName} and ${bName}.`);
}

type Pair = {
  chainId?: string;
  pairAddress?: string;
  url?: string;
  dexId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string | null };
  volume?: { h24?: number | null };
  liquidity?: { usd?: number | null };
  priceUsd?: number | string | null;
  priceChange?: { h24?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
  txns?: { h24?: { buys?: number | null; sells?: number | null } };
};

// Same rule as the collector; a separate chain list here once omitted Base.
const addressMatch = addressEquals;

function numberField(value: unknown): number | null { return numeric(value); }

function sumField(pairs: Pair[], read: (pair: Pair) => unknown): number | null {
  const values = pairs.map((pair) => numberField(read(pair))).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function pairOrder(a: Pair, b: Pair): number {
  return (numberField(b.liquidity?.usd) ?? -1) - (numberField(a.liquidity?.usd) ?? -1)
    || (numberField(b.volume?.h24) ?? -1) - (numberField(a.volume?.h24) ?? -1)
    || (a.pairAddress ?? "").localeCompare(b.pairAddress ?? "");
}

function dexPairsForToken(token: TokenInput, records: RawRecordInput[]): { record?: RawRecordInput; pairs: Pair[]; primary?: Pair } {
  const record = records.filter((item) => item.provider_id === "dexscreener" && item.token_id === token.id && item.chain_id === token.chain_id)
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at) || b.id - a.id)[0];
  const payload = record?.payload as { requestedChainId?: string; requestedTokenAddress?: string; providerPairs?: Pair[] } | null;
  if (!record || !payload?.requestedChainId || !payload.requestedTokenAddress || !Array.isArray(payload.providerPairs)) return { record, pairs: [] };
  const seen = new Set<string>();
  const pairs = payload.providerPairs.filter((pair) => {
    if (pair.chainId !== payload.requestedChainId || !pair.pairAddress || seen.has(pair.pairAddress)) return false;
    if (!addressMatch(payload.requestedChainId as string, pair.baseToken?.address, payload.requestedTokenAddress)
      && !addressMatch(payload.requestedChainId as string, pair.quoteToken?.address, payload.requestedTokenAddress)) return false;
    seen.add(pair.pairAddress);
    return true;
  });
  const bases = pairs.filter((pair) => addressMatch(payload.requestedChainId as string, pair.baseToken?.address, payload.requestedTokenAddress));
  const primary = [...(bases.length ? bases : pairs)].sort(pairOrder)[0];
  return { record, pairs, primary };
}

function divideValues(numerator: number | null, denominator: number | null, sources: SourceRef[], rawRecords: RawRecordInput[], multiplier = 1): Calculation {
  if (numerator === null || denominator === null) return unavailable("Required numeric source value is unavailable.", sources, rawRecords);
  if (numerator < 0 || denominator < 0) return invalid("Negative inputs are not valid for this ratio.", sources, rawRecords);
  if (denominator === 0) return unavailable("Denominator is zero.", sources, rawRecords);
  return valid((numerator / denominator) * multiplier, sources, { rawRecords });
}

function sourceRaw(record?: RawRecordInput): RawRecordInput[] { return record ? [record] : []; }

function metricSource(rows: ObservationInput[], provider: string, metric: string): ObservationInput | undefined {
  return chooseLatest(rows, provider, metric);
}

function valueOf(row: ObservationInput | undefined): number | null { return availableValue(row); }

function divFlag(condition: boolean, sources: SourceRef[], startAt?: string, endAt?: string): Calculation {
  return valid(condition ? 1 : 0, sources, { startAt, endAt, details: { interpretation: condition ? "observed" : "not_observed_for_comparable_period" } });
}

function hashInput(token: TokenInput, metricId: string, calc: Calculation): string {
  const input = {
    version: CALCULATION_VERSION,
    token: `${token.id}:${token.chain_id}`,
    metricId,
    sources: calc.sources.map((source) => ({ kind: source.source_kind, id: source.id, value: source.value, status: source.status })).sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id),
    rawRecordIds: (calc.rawRecords ?? []).map((record) => record.id).sort((a, b) => a - b),
    result: calc.value,
    status: calc.status,
    reason: calc.reason ?? null,
    details: calc.details ?? null,
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function buildCalculation(token: TokenInput, definition: MetricDefinition, calc: Calculation, calculatedAt: string): CalculatedMetricRow {
  const sourceIds = [...new Set(calc.sources.filter((source) => source.source_kind === "observation").map((source) => source.id))].sort((a, b) => a - b);
  const rawRecords = [...new Map((calc.rawRecords ?? []).map((record) => [record.id, record])).values()];
  const rawIds = rawRecords.map((record) => record.id).sort((a, b) => a - b);
  return {
    token_id: token.id,
    chain_id: token.chain_id,
    metric_id: definition.id,
    metric_name: definition.name,
    unit: definition.unit,
    value: calc.value,
    status: calc.status,
    formula: definition.formula,
    calculation_version: CALCULATION_VERSION,
    input_fingerprint: hashInput(token, definition.id, calc),
    source_observation_ids: sourceIds,
    source_raw_record_ids: [...new Set([...rawIds, ...calc.sources.filter((source) => source.source_kind === "observation" && typeof source.raw_record_id === "number").map((source) => source.raw_record_id as number)])].sort((a, b) => a - b),
    provenance: {
      metric_name: definition.name,
      unit: definition.unit,
      source_scopes: definition.sourceScopes,
      calculation_version: CALCULATION_VERSION,
      sources: calc.sources,
      raw_records: rawRecords.map(sourceRecord),
      unavailable_reason: calc.reason ?? null,
      calculation_details: calc.details ?? {},
    },
    period_start_at: calc.startAt ?? null,
    period_end_at: calc.endAt ?? null,
    calculated_at: calculatedAt,
  };
}

export function calculateTokenMetrics(
  token: TokenInput,
  observations: ObservationInput[],
  rawRecords: RawRecordInput[],
  calculatedAt = new Date().toISOString(),
): CalculatedMetricRow[] {
  const tokenRows = observations.filter((row) => row.token_id === token.id && row.chain_id === token.chain_id && hasCompatibleScope(row));
  const cgMarketCap = metricSource(tokenRows, "coingecko", "market_cap_usd");
  const cgVolume = metricSource(tokenRows, "coingecko", "volume_24h_usd");
  const llamaTvl = metricSource(tokenRows, "defillama", "tvl_usd");
  const llamaRevenue = metricSource(tokenRows, "defillama", "revenue_24h_usd");
  const dexFdv = metricSource(tokenRows, "dexscreener", "fdv_usd");
  const dexBuys = metricSource(tokenRows, "dexscreener", "buys_24h_count");
  const dexSells = metricSource(tokenRows, "dexscreener", "sells_24h_count");
  const dexSeries = dexPairsForToken(token, rawRecords);
  const dexRaw = sourceRaw(dexSeries.record);
  const dexRawRefs = dexRaw.map((record) => ({ id: record.id, source_kind: "raw_record" as const, provider_id: record.provider_id, token_id: record.token_id, collected_at: record.collected_at, endpoint_label: record.endpoint_label }));

  const priceSeries = series(tokenRows, "coingecko", "price_usd");
  const marketCapSeries = series(tokenRows, "coingecko", "market_cap_usd");
  const tvlSeries = series(tokenRows, "defillama", "tvl_usd");
  const revenueSeries = series(tokenRows, "defillama", "revenue_24h_usd");
  const feesSeries = series(tokenRows, "defillama", "fees_24h_usd");

  const rawVolume = sumField(dexSeries.pairs, (pair) => pair.volume?.h24);
  const rawLiquidity = sumField(dexSeries.pairs, (pair) => pair.liquidity?.usd);
  const primaryLiquidity = numberField(dexSeries.primary?.liquidity?.usd);
  const primaryVolume = numberField(dexSeries.primary?.volume?.h24);
  const aggregateVolumeObs = metricSource(tokenRows, "dexscreener", "volume_24h_usd");
  const aggregateLiquidityCalc = rawLiquidity === null
    ? unavailable("No exact-address pair returned a numeric liquidity.usd value.", dexRawRefs, dexRaw)
    : valid(rawLiquidity, dexRawRefs, { rawRecords: dexRaw, startAt: dexSeries.record?.collected_at, endAt: dexSeries.record?.collected_at, details: { exact_address_pair_count: dexSeries.pairs.length } });
  const aggregateVolumeCalc = rawVolume === null
    ? unavailable("No exact-address pair returned a numeric volume.h24 value.", [...ref(aggregateVolumeObs), ...dexRawRefs], dexRaw)
    : valid(rawVolume, [...ref(aggregateVolumeObs), ...dexRawRefs], { rawRecords: dexRaw, startAt: dexSeries.record?.collected_at, endAt: dexSeries.record?.collected_at, details: { exact_address_pair_count: dexSeries.pairs.length } });
  const primaryLiquidityCalc = primaryLiquidity === null
    ? unavailable("Primary pair liquidity is unavailable.", dexRawRefs, dexRaw)
    : valid(primaryLiquidity, [...ref(metricSource(tokenRows, "dexscreener", "liquidity_usd")), ...dexRawRefs], { rawRecords: dexRaw, startAt: dexSeries.record?.collected_at, endAt: dexSeries.record?.collected_at, details: { primary_pair_address: dexSeries.primary?.pairAddress ?? null } });
  const primaryVolumeCalc = primaryVolume === null
    ? unavailable("Primary pair 24-hour volume is unavailable.", dexRawRefs, dexRaw)
    : valid(primaryVolume, dexRawRefs, { rawRecords: dexRaw, startAt: dexSeries.record?.collected_at, endAt: dexSeries.record?.collected_at, details: { primary_pair_address: dexSeries.primary?.pairAddress ?? null } });

  const historicalGrowth = {
    price: growthCalculation(priceSeries, "CoinGecko price"),
    marketCap: growthCalculation(marketCapSeries, "CoinGecko market capitalization"),
    tvl: growthCalculation(tvlSeries, "DeFiLlama protocol TVL"),
    revenue: growthCalculation(revenueSeries, "DeFiLlama protocol revenue"),
    fees: growthCalculation(feesSeries, "DeFiLlama protocol fees"),
  };
  const priceVsTvl = alignedCrossChange(priceSeries, tvlSeries, "price", "TVL");
  const priceVsRevenue = alignedCrossChange(priceSeries, revenueSeries, "price", "protocol revenue");
  const capVsTvl = alignedCrossChange(marketCapSeries, tvlSeries, "market cap", "TVL");
  const capVsRevenue = alignedCrossChange(marketCapSeries, revenueSeries, "market cap", "protocol revenue");
  const spread = (cross: CrossChange | Calculation): Calculation => {
    if (!("a" in cross)) return cross;
    return valid(cross.a - cross.b, cross.sources, { startAt: cross.startAt, endAt: cross.endAt, details: { first_series_change_pct: cross.a, second_series_change_pct: cross.b } });
  };
  const crossSpread = { priceVsTvl: spread(priceVsTvl), priceVsRevenue: spread(priceVsRevenue), capVsTvl: spread(capVsTvl), capVsRevenue: spread(capVsRevenue) };

  const marketCapToTvl = ratio(cgMarketCap, llamaTvl, "CoinGecko market cap", "DeFiLlama protocol TVL");
  const fdvToTvl = ratio(dexFdv, llamaTvl, "DEX Screener FDV", "DeFiLlama protocol TVL");
  const marketCapToRevenue = ratio(cgMarketCap, llamaRevenue, "CoinGecko market cap", "DeFiLlama protocol 24-hour revenue");
  const fdvToRevenue = ratio(dexFdv, llamaRevenue, "DEX Screener FDV", "DeFiLlama protocol 24-hour revenue");
  const volumeToMarketCap = ratio(cgVolume, cgMarketCap, "CoinGecko 24-hour volume", "CoinGecko market cap");
  const dexVolumeToLiquidity = divideValues(rawVolume, rawLiquidity, dexRawRefs, dexRaw);
  const buySell = ratio(dexBuys, dexSells, "DEX buys", "DEX sells");
  const market = valueOf(cgMarketCap);
  const primaryLiqToCap = divideValues(primaryLiquidity, market, [...dexRawRefs, ...ref(cgMarketCap)], dexRaw, 100);
  const aggregateLiqToCap = divideValues(rawLiquidity, market, [...dexRawRefs, ...ref(cgMarketCap)], dexRaw, 100);

  const flag = (cross: CrossChange | Calculation, condition: (a: number, b: number) => boolean): Calculation => {
    if (!("a" in cross)) return cross;
    return divFlag(condition(cross.a, cross.b), cross.sources, cross.startAt, cross.endAt);
  };

  const calculations: Record<string, Calculation> = {
    market_cap_to_tvl: marketCapToTvl,
    fdv_to_tvl: fdvToTvl,
    market_cap_to_revenue_24h: marketCapToRevenue,
    fdv_to_revenue_24h: fdvToRevenue,
    volume_to_market_cap: volumeToMarketCap,
    tvl_growth_pct: historicalGrowth.tvl,
    revenue_growth_pct: historicalGrowth.revenue,
    fees_growth_pct: historicalGrowth.fees,
    price_growth_pct: historicalGrowth.price,
    market_cap_growth_pct: historicalGrowth.marketCap,
    price_change_vs_tvl_growth_pct_points: crossSpread.priceVsTvl,
    price_change_vs_revenue_growth_pct_points: crossSpread.priceVsRevenue,
    market_cap_change_vs_tvl_growth_pct_points: crossSpread.capVsTvl,
    market_cap_change_vs_revenue_growth_pct_points: crossSpread.capVsRevenue,
    dex_aggregate_volume_24h_usd: aggregateVolumeCalc,
    dex_aggregate_liquidity_usd: aggregateLiquidityCalc,
    dex_primary_pair_liquidity_usd: primaryLiquidityCalc,
    dex_primary_pair_volume_24h_usd: primaryVolumeCalc,
    dex_liquidity_to_market_cap_pct: primaryLiqToCap,
    dex_aggregate_liquidity_to_market_cap_pct: aggregateLiqToCap,
    dex_volume_to_liquidity: dexVolumeToLiquidity,
    dex_buy_sell_ratio: buySell,
    divergence_price_up_tvl_down: flag(priceVsTvl, (price, tvl) => price > 0 && tvl < 0),
    divergence_price_down_tvl_up: flag(priceVsTvl, (price, tvl) => price < 0 && tvl > 0),
    divergence_market_cap_up_faster_tvl: flag(capVsTvl, (cap, tvl) => cap > tvl),
    divergence_tvl_up_faster_market_cap: flag(capVsTvl, (cap, tvl) => tvl > cap),
    divergence_revenue_up_market_cap_down: flag(capVsRevenue, (cap, revenue) => revenue > 0 && cap < 0),
    divergence_revenue_down_market_cap_up: flag(capVsRevenue, (cap, revenue) => revenue < 0 && cap > 0),
  };

  // The DeFiLlama observations intentionally retain their protocol-level scope in provenance.
  for (const calculation of Object.values(calculations)) {
    for (const source of calculation.sources) {
      if (source.provider_id === "defillama" && typeof source.note === "string") {
        calculation.details = { ...calculation.details, source_scope: source.note };
      }
    }
  }

  return CALCULATED_METRICS.map((definition) => buildCalculation(token, definition, calculations[definition.id] ?? unavailable("Metric calculation is not configured."), calculatedAt));
}

export function calculateAllMetrics(tokens: TokenInput[], observations: ObservationInput[], rawRecords: RawRecordInput[], calculatedAt = new Date().toISOString()): CalculatedMetricRow[] {
  return tokens.flatMap((token) => calculateTokenMetrics(token, observations, rawRecords, calculatedAt));
}
