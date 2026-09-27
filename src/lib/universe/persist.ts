// Idempotent persistence for `universe_candidates` / `universe_validation_runs`
// (AGENTS.md #34). Upserts on `coingecko_id`, so re-running Phase A never
// duplicates a candidate row; it only updates the columns a fresh check
// produced. No existing table (`tokens`, `provider_token_mappings`, etc.) is
// written to here (AGENTS.md #26, #30).

import type { UniverseCandidate } from "./types.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const CHUNK_SIZE = 500;

function assertNoError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export function candidateToRow(candidate: UniverseCandidate, updatedAt: string): Record<string, unknown> {
  return {
    coingecko_id: candidate.coingeckoId,
    symbol: candidate.symbol,
    name: candidate.name,
    chain_id: candidate.chainId,
    contract_address: candidate.contractAddress,
    is_native: candidate.isNative,
    token_id: candidate.tokenId,
    identity_status: candidate.identityStatus,
    identity_evidence: candidate.identityEvidence,

    universe_status: candidate.universeStatus,
    duplicate_of_id: candidate.duplicateOfId,
    migrated_to_coingecko_id: candidate.migratedToCoingeckoId,
    status_reason: candidate.statusReason,

    source: candidate.source,
    market_cap_rank: candidate.marketCapRank,
    discovered_at: candidate.discoveredAt,
    last_seen_in_source_at: candidate.lastSeenInSourceAt,

    coingecko_status: candidate.coingeckoStatus,
    coingecko_checked_at: candidate.coingeckoCheckedAt,
    coingecko_failure_reason: candidate.coingeckoFailureReason,
    coingecko_has_market_data: candidate.coingeckoHasMarketData,
    coingecko_has_supply_data: candidate.coingeckoHasSupplyData,

    binance_status: candidate.binanceStatus,
    binance_symbol: candidate.binanceSymbol,
    binance_base_asset: candidate.binanceBaseAsset,
    binance_quote_asset: candidate.binanceQuoteAsset,
    binance_market_status: candidate.binanceMarketStatus,
    binance_market_type: candidate.binanceMarketType,
    binance_resolution_method: candidate.binanceResolutionMethod,
    binance_checked_at: candidate.binanceCheckedAt,
    binance_failure_reason: candidate.binanceFailureReason,

    logo_url: candidate.logoUrl,
    logo_source: candidate.logoSource,
    logo_verified: candidate.logoVerified,
    logo_status: candidate.logoStatus,
    logo_checked_at: candidate.logoCheckedAt,
    logo_failure_reason: candidate.logoFailureReason,

    historical_data_status: candidate.historicalDataStatus,
    historical_coverage_days: candidate.historicalCoverageDays,
    historical_required_days: candidate.historicalRequiredDays,
    historical_data_checked_at: candidate.historicalDataCheckedAt,
    historical_data_failure_reason: candidate.historicalDataFailureReason,

    supply_status: candidate.supplyStatus,
    has_circulating_supply: candidate.hasCirculatingSupply,
    has_total_supply: candidate.hasTotalSupply,
    has_max_supply: candidate.hasMaxSupply,
    has_reported_fdv: candidate.hasReportedFdv,
    supply_checked_at: candidate.supplyCheckedAt,
    supply_failure_reason: candidate.supplyFailureReason,

    eligibility_status: candidate.eligibilityStatus,
    eligibility_reason_codes: candidate.eligibilityReasonCodes,
    eligibility_checked_at: candidate.eligibilityCheckedAt,
    eligibility_config_version: candidate.eligibilityConfigVersion,

    updated_at: updatedAt,
  };
}

export function rowToCandidate(row: Record<string, unknown>): UniverseCandidate {
  // A DB-row boundary: Supabase returns loosely-typed JSON, and the columns
  // are already constrained by the migration's check constraints, so this is
  // a single explicit cast rather than an unchecked `any` throughout.
  return {
    id: row.id ?? null,
    coingeckoId: row.coingecko_id,
    symbol: row.symbol,
    name: row.name,
    chainId: row.chain_id ?? null,
    contractAddress: row.contract_address ?? null,
    isNative: Boolean(row.is_native),
    tokenId: row.token_id ?? null,
    identityStatus: row.identity_status ?? "unresolved",
    identityEvidence: row.identity_evidence ?? {},

    universeStatus: row.universe_status ?? "candidate",
    duplicateOfId: row.duplicate_of_id ?? null,
    migratedToCoingeckoId: row.migrated_to_coingecko_id ?? null,
    statusReason: row.status_reason ?? null,

    source: row.source ?? "coingecko_markets",
    marketCapRank: row.market_cap_rank ?? null,
    discoveredAt: row.discovered_at,
    lastSeenInSourceAt: row.last_seen_in_source_at ?? null,

    coingeckoStatus: row.coingecko_status ?? null,
    coingeckoCheckedAt: row.coingecko_checked_at ?? null,
    coingeckoFailureReason: row.coingecko_failure_reason ?? null,
    coingeckoHasMarketData: row.coingecko_has_market_data ?? null,
    coingeckoHasSupplyData: row.coingecko_has_supply_data ?? null,

    binanceStatus: row.binance_status ?? null,
    binanceSymbol: row.binance_symbol ?? null,
    binanceBaseAsset: row.binance_base_asset ?? null,
    binanceQuoteAsset: row.binance_quote_asset ?? null,
    binanceMarketStatus: row.binance_market_status ?? null,
    binanceMarketType: row.binance_market_type ?? null,
    binanceResolutionMethod: row.binance_resolution_method ?? null,
    binanceCheckedAt: row.binance_checked_at ?? null,
    binanceFailureReason: row.binance_failure_reason ?? null,

    logoUrl: row.logo_url ?? null,
    logoSource: row.logo_source ?? null,
    logoVerified: Boolean(row.logo_verified),
    logoStatus: row.logo_status ?? null,
    logoCheckedAt: row.logo_checked_at ?? null,
    logoFailureReason: row.logo_failure_reason ?? null,

    historicalDataStatus: row.historical_data_status ?? null,
    historicalCoverageDays: row.historical_coverage_days ?? null,
    historicalRequiredDays: row.historical_required_days ?? null,
    historicalDataCheckedAt: row.historical_data_checked_at ?? null,
    historicalDataFailureReason: row.historical_data_failure_reason ?? null,

    supplyStatus: row.supply_status ?? null,
    hasCirculatingSupply: row.has_circulating_supply ?? null,
    hasTotalSupply: row.has_total_supply ?? null,
    hasMaxSupply: row.has_max_supply ?? null,
    hasReportedFdv: row.has_reported_fdv ?? null,
    supplyCheckedAt: row.supply_checked_at ?? null,
    supplyFailureReason: row.supply_failure_reason ?? null,

    eligibilityStatus: row.eligibility_status ?? null,
    eligibilityReasonCodes: row.eligibility_reason_codes ?? [],
    eligibilityCheckedAt: row.eligibility_checked_at ?? null,
    eligibilityConfigVersion: row.eligibility_config_version ?? null,
  } as unknown as UniverseCandidate;
}

/** All previously-stored candidates, for deprecation-by-absence and existing-logo fallback lookups. */
export async function loadExistingCandidates(client: SupabaseAdminClient): Promise<UniverseCandidate[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from("universe_candidates").select("*").range(offset, offset + 999);
    assertNoError(error, "read universe_candidates");
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows.map(rowToCandidate);
}

export async function persistCandidates(client: SupabaseAdminClient, candidates: UniverseCandidate[], now: () => Date = () => new Date()): Promise<{ upserted: number }> {
  const updatedAt = now().toISOString();
  const rows = candidates.map((candidate) => candidateToRow(candidate, updatedAt));
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const { error } = await client.from("universe_candidates").upsert(rows.slice(index, index + CHUNK_SIZE), { onConflict: "coingecko_id" });
    assertNoError(error, "upsert universe_candidates");
  }
  return { upserted: rows.length };
}

export async function startValidationRun(client: SupabaseAdminClient, startedAt: string, config: Record<string, unknown>): Promise<number> {
  const { data, error } = await client.from("universe_validation_runs").insert({ started_at: startedAt, status: "running", config }).select("id").single();
  assertNoError(error, "insert universe_validation_runs");
  return data!.id as number;
}

export async function finishValidationRun(
  client: SupabaseAdminClient,
  runId: number,
  finishedAt: string,
  status: "succeeded" | "failed",
  summary: Record<string, unknown>,
  error: string | null,
): Promise<void> {
  const { error: updateError } = await client.from("universe_validation_runs").update({ finished_at: finishedAt, status, summary, error }).eq("id", runId);
  assertNoError(updateError, "update universe_validation_runs");
}
