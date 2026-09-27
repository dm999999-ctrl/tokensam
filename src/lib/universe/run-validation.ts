// Phase A orchestrator: discover -> validate -> resolve identity -> resolve
// Binance -> resolve logo/historical/supply -> score eligibility -> persist ->
// report. Every step is independently unit-tested; this module wires them
// together in the documented order and short-circuits the expensive
// per-candidate historical check to candidates that already passed the
// cheaper CoinGecko + identity checks (AGENTS.md #33).

import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { getCoinGeckoConfig } from "../providers/coingecko.ts";
import { buildMarketSnapshot, fetchFuturesExchangeInfo, fetchSpotExchangeInfo, getBinanceConfig, type BinanceMarketSnapshot } from "./binance-client.ts";
import { binanceUnavailable, resolveBinanceSpot } from "./binance-resolver.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { CONFIG_VERSION, DEFAULT_ELIGIBILITY_CONFIG, HISTORICAL_CHECK_CONCURRENCY, HISTORICAL_CHECK_MIN_INTERVAL_MS, type UniverseEligibilityConfig } from "./config.ts";
import { discoverCandidates } from "./coingecko-discovery.ts";
import { coinGeckoUnavailable, validateCoinGeckoCandidate } from "./coingecko-validation.ts";
import { applyCatalogAbsenceDeprecation, applyDuplicateAndLifecycleRules } from "./duplicates.ts";
import { evaluateEligibility } from "./eligibility.ts";
import { checkHistoricalData } from "./historical.ts";
import { buildSymbolIndex, resolveCandidateIdentity } from "./identity.ts";
import { resolveLogo } from "./logo.ts";
import { ProviderOutageError } from "./http.ts";
import { buildValidationReport, type ValidationReport } from "./report.ts";
import { evaluateSupplyData } from "./supply.ts";
import type { CoinGeckoMarketCandidate, UniverseCandidate } from "./types.ts";

const ACTIVE_STATUSES = new Set(["candidate", "canonical", "needs_review"]);
const coingeckoIdToTokenId = new Map(Object.entries(coingeckoTokenIds).map(([tokenId, cgId]) => [cgId, tokenId]));

export type RunValidationOptions = {
  config?: Partial<UniverseEligibilityConfig>;
  env?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  sleep: (durationMs: number) => Promise<void>;
  now?: () => Date;
  /** Previously stored candidates, for idempotent re-runs and deprecation-by-absence. */
  existingCandidates?: UniverseCandidate[];
  /** Live-verify existing-logo fallback URLs (disable for fast/offline dry runs). */
  verifyExistingLogos?: boolean;
};

export type RunValidationResult = {
  candidates: UniverseCandidate[];
  report: ValidationReport;
  outage: string | null;
};

function matchExistingToken(candidate: UniverseCandidate): UniverseCandidate {
  const tokenId = coingeckoIdToTokenId.get(candidate.coingeckoId);
  return tokenId ? { ...candidate, tokenId } : candidate;
}

export async function runUniverseValidation(options: RunValidationOptions): Promise<RunValidationResult> {
  const config: UniverseEligibilityConfig = { ...DEFAULT_ELIGIBILITY_CONFIG, ...options.config };
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const cgConfig = getCoinGeckoConfig(options.env);
  const existing = options.existingCandidates ?? [];
  const existingById = new Map(existing.map((candidate) => [candidate.coingeckoId, candidate]));

  const discovery = await discoverCandidates({ poolSize: config.candidatePoolSize, config: cgConfig, fetchImpl: options.fetchImpl, sleep: options.sleep, now });
  if (discovery.outage) {
    // A discovery-wide outage never destroys previously validated candidates
    // (AGENTS.md #25); it just cannot refresh them this run.
    const stale = existing.map((candidate) => ({ ...candidate, ...coinGeckoUnavailable(checkedAt, discovery.outage as string) }));
    const scored = stale.map((candidate) => ({ ...candidate, ...evaluateEligibility(candidate, config, checkedAt) }));
    return { candidates: scored, report: buildValidationReport(scored, checkedAt), outage: discovery.outage };
  }

  // ---- 1. CoinGecko validation of every freshly discovered candidate ----
  const validatedFresh: UniverseCandidate[] = discovery.candidates.map((candidate) => {
    const market = discovery.marketsById.get(candidate.coingeckoId) as CoinGeckoMarketCandidate;
    const previous = existingById.get(candidate.coingeckoId);
    const merged: UniverseCandidate = previous ? { ...candidate, id: previous.id, tokenId: previous.tokenId ?? candidate.tokenId } : candidate;
    return matchExistingToken({ ...merged, ...validateCoinGeckoCandidate(market, checkedAt), lastSeenInSourceAt: checkedAt });
  });

  // ---- 2. Carry forward previously-tracked candidates absent from this fetch ----
  const staleExisting = existing.filter((candidate) => !discovery.discoveredIds.has(candidate.coingeckoId));
  let allCandidates = applyCatalogAbsenceDeprecation([...validatedFresh, ...staleExisting], discovery.discoveredIds, checkedAt);

  // ---- 3. Duplicate / deprecated / migrated lifecycle rules ----
  allCandidates = applyDuplicateAndLifecycleRules(allCandidates);

  // ---- 4. Identity collision resolution (only among still-active candidates) ----
  const activeForIdentity = allCandidates.filter((candidate) => ACTIVE_STATUSES.has(candidate.universeStatus));
  const symbolIndex = buildSymbolIndex(activeForIdentity);
  allCandidates = allCandidates.map((candidate) => {
    if (!ACTIVE_STATUSES.has(candidate.universeStatus)) return candidate;
    const resolution = resolveCandidateIdentity(candidate, symbolIndex);
    return { ...candidate, identityStatus: resolution.status, identityEvidence: { ...candidate.identityEvidence, ...resolution.evidence } };
  });

  // ---- 5. Binance Spot resolution (one exchangeInfo call total, not per candidate) ----
  let binanceOutage: string | null = null;
  let snapshot: BinanceMarketSnapshot | null = null;
  try {
    const binanceConfig = getBinanceConfig(options.env);
    const [spotSymbols, futuresSymbols] = await Promise.all([
      fetchSpotExchangeInfo(binanceConfig, options),
      fetchFuturesExchangeInfo(binanceConfig, options).catch(() => []),
    ]);
    snapshot = buildMarketSnapshot(spotSymbols, futuresSymbols);
  } catch (error) {
    if (error instanceof ProviderOutageError) binanceOutage = error.message;
    else throw error;
  }

  allCandidates = allCandidates.map((candidate) => {
    if (!ACTIVE_STATUSES.has(candidate.universeStatus) || candidate.coingeckoStatus !== "pass") return candidate;
    if (binanceOutage) return { ...candidate, ...binanceUnavailable(checkedAt, binanceOutage) };
    const resolution = resolveBinanceSpot(candidate, candidate.identityStatus, snapshot!, config, checkedAt);
    return resolution ? { ...candidate, ...resolution } : candidate;
  });

  // ---- 6. Logo + supply (cheap: reuse the already-fetched market row) ----
  const logoResults = await Promise.all(
    allCandidates.map(async (candidate) => {
      if (!ACTIVE_STATUSES.has(candidate.universeStatus) || candidate.coingeckoStatus !== "pass") return candidate;
      const market = discovery.marketsById.get(candidate.coingeckoId);
      const previous = existingById.get(candidate.coingeckoId);
      const logo = await resolveLogo({
        coinGeckoImageUrl: market?.image,
        existingLogoUrl: previous?.logoUrl ?? null,
        checkedAt,
        fetchImpl: options.fetchImpl,
        verifyExisting: options.verifyExistingLogos ?? true,
      });
      const supply = evaluateSupplyData(
        {
          hasMarketCap: Boolean(candidate.coingeckoHasMarketData),
          circulatingSupply: market?.circulating_supply ?? null,
          totalSupply: market?.total_supply ?? null,
          maxSupply: market?.max_supply ?? null,
          reportedFdv: market?.fully_diluted_valuation ?? null,
        },
        checkedAt,
      );
      return { ...candidate, ...logo, ...supply };
    }),
  );
  allCandidates = logoResults;

  // ---- 7. Historical data: the expensive per-candidate check, only for viable candidates ----
  const historicalTargets = allCandidates.filter(
    (candidate) => ACTIVE_STATUSES.has(candidate.universeStatus) && candidate.coingeckoStatus === "pass" && candidate.identityStatus === "valid",
  );
  const historicalResults = await mapWithConcurrency(historicalTargets, HISTORICAL_CHECK_CONCURRENCY, async (candidate) => {
    try {
      return await checkHistoricalData(candidate.coingeckoId, config.historicalRequiredDays, cgConfig, {
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        now,
      });
    } finally {
      await options.sleep(HISTORICAL_CHECK_MIN_INTERVAL_MS);
    }
  });
  const historicalByCoingeckoId = new Map(historicalTargets.map((candidate, index) => [candidate.coingeckoId, historicalResults[index]]));
  allCandidates = allCandidates.map((candidate) => {
    const historical = historicalByCoingeckoId.get(candidate.coingeckoId);
    return historical ? { ...candidate, ...historical } : candidate;
  });

  // ---- 8. Eligibility engine ----
  allCandidates = allCandidates.map((candidate) => ({ ...candidate, ...evaluateEligibility(candidate, config, checkedAt) }));

  return { candidates: allCandidates, report: buildValidationReport(allCandidates, checkedAt), outage: null };
}

export { CONFIG_VERSION };
