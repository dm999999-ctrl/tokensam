// Duplicate / deprecated / migrated detection (AGENTS.md #13-#14). Never
// deletes anything; only assigns `universeStatus` and preserves the reason so
// Phase D can explain later why a row was excluded. Rules are applied in a
// fixed precedence so a hand-verified curated fact is never overridden by a
// heuristic: known migrations, then known deprecations, then contract-address
// duplicates, then "no longer in the latest catalog fetch".

import { universeKnownDeprecations, universeKnownMigrations } from "../../data/universe-known-migrations.ts";
import type { UniverseCandidate } from "./types.ts";

function contractIdentityKey(candidate: UniverseCandidate): string | null {
  if (candidate.contractAddress && candidate.chainId) {
    return `${candidate.chainId}:${candidate.contractAddress.toLowerCase()}`;
  }
  if (candidate.isNative && candidate.chainId) return `${candidate.chainId}:native`;
  return null;
}

/** Lower rank number = larger market cap = preferred as the canonical row. Missing ranks sort last. */
function preferCanonical(a: UniverseCandidate, b: UniverseCandidate): UniverseCandidate {
  const rankA = a.marketCapRank ?? Number.POSITIVE_INFINITY;
  const rankB = b.marketCapRank ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA < rankB ? a : b;
  return a.coingeckoId <= b.coingeckoId ? a : b;
}

function applyKnownMigrations(candidates: UniverseCandidate[]): UniverseCandidate[] {
  return candidates.map((candidate) => {
    const migration = universeKnownMigrations[candidate.coingeckoId];
    if (!migration || candidate.universeStatus !== "candidate") return candidate;
    return {
      ...candidate,
      universeStatus: "migrated",
      migratedToCoingeckoId: migration.migratedToCoingeckoId,
      statusReason: migration.reason,
    };
  });
}

function applyKnownDeprecations(candidates: UniverseCandidate[]): UniverseCandidate[] {
  return candidates.map((candidate) => {
    const reason = universeKnownDeprecations[candidate.coingeckoId];
    if (!reason || candidate.universeStatus !== "candidate") return candidate;
    return { ...candidate, universeStatus: "deprecated", statusReason: reason };
  });
}

function applyContractDuplicates(candidates: UniverseCandidate[]): UniverseCandidate[] {
  const groups = new Map<string, UniverseCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.universeStatus !== "candidate") continue;
    const key = contractIdentityKey(candidate);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const duplicateOf = new Map<string, UniverseCandidate>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const canonical = group.reduce(preferCanonical);
    for (const candidate of group) {
      if (candidate.coingeckoId !== canonical.coingeckoId) duplicateOf.set(candidate.coingeckoId, canonical);
    }
  }

  return candidates.map((candidate) => {
    const canonical = duplicateOf.get(candidate.coingeckoId);
    if (!canonical) return candidate;
    return {
      ...candidate,
      universeStatus: "duplicate",
      duplicateOfId: canonical.id,
      statusReason: `Same on-chain identity (${contractIdentityKey(candidate)}) as canonical candidate ${canonical.coingeckoId}.`,
    };
  });
}

/**
 * Handle previously-tracked candidates this run did not re-validate
 * (AGENTS.md #14, #25). Absence is never treated as a single fact with one
 * meaning:
 *
 * - Still present in `/coins/list` (CoinGecko's near-complete catalog), just
 *   outside this run's ranked top-`poolSize` window: not deprecation
 *   evidence at all — a token can rank #2,501 on a volatile day without being
 *   delisted. Left completely untouched, streak reset.
 * - `/coins/list` itself could not be fetched this run (`listOutage` set):
 *   a provider outage, not evidence of anything. Left completely untouched.
 * - Genuinely absent from `/coins/list`: real evidence, but a single
 *   occurrence could still be a transient/incomplete response, so it only
 *   raises `needs_review` and increments a streak; only `threshold`
 *   *consecutive* confirmed absences promote it to `deprecated`.
 */
export function applyCatalogAbsenceDeprecation(
  candidates: UniverseCandidate[],
  discoveredIds: Set<string>,
  listedCoingeckoIds: Set<string>,
  listOutage: string | null,
  threshold: number,
  checkedAt: string,
): UniverseCandidate[] {
  return candidates.map((candidate) => {
    if (discoveredIds.has(candidate.coingeckoId)) return candidate; // re-validated this run; run-validation.ts resets its streak
    if (candidate.universeStatus !== "candidate" && candidate.universeStatus !== "canonical" && candidate.universeStatus !== "needs_review") return candidate;
    if (listOutage) return candidate; // catalog fetch failed: no absence evidence either way

    if (listedCoingeckoIds.has(candidate.coingeckoId)) {
      // Still genuinely listed on CoinGecko; only fell outside this run's ranked window.
      return candidate.absentFromSourceStreak === 0 ? candidate : { ...candidate, absentFromSourceStreak: 0 };
    }

    const streak = candidate.absentFromSourceStreak + 1;
    if (streak >= threshold) {
      return {
        ...candidate,
        universeStatus: "deprecated",
        statusReason: `Confirmed absent from CoinGecko's own catalog (/coins/list) across ${streak} consecutive validation runs, most recently on ${checkedAt}.`,
        absentFromSourceStreak: streak,
      };
    }
    return {
      ...candidate,
      universeStatus: "needs_review",
      statusReason: `Absent from CoinGecko's catalog fetch on ${checkedAt} (occurrence ${streak} of ${threshold} before being treated as deprecated).`,
      absentFromSourceStreak: streak,
    };
  });
}

/** Run the full precedence chain once, over a freshly-discovered candidate batch. */
export function applyDuplicateAndLifecycleRules(candidates: UniverseCandidate[]): UniverseCandidate[] {
  return applyContractDuplicates(applyKnownDeprecations(applyKnownMigrations(candidates)));
}
