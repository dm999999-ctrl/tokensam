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

/** Mark previously-tracked candidates absent from a fresh catalog fetch as deprecated (AGENTS.md #14). */
export function applyCatalogAbsenceDeprecation(
  candidates: UniverseCandidate[],
  currentCoingeckoIds: Set<string>,
  checkedAt: string,
): UniverseCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.universeStatus !== "candidate" && candidate.universeStatus !== "canonical") return candidate;
    if (currentCoingeckoIds.has(candidate.coingeckoId)) return candidate;
    return {
      ...candidate,
      universeStatus: "deprecated",
      statusReason: `No longer present in the CoinGecko catalog fetch on ${checkedAt}.`,
    };
  });
}

/** Run the full precedence chain once, over a freshly-discovered candidate batch. */
export function applyDuplicateAndLifecycleRules(candidates: UniverseCandidate[]): UniverseCandidate[] {
  return applyContractDuplicates(applyKnownDeprecations(applyKnownMigrations(candidates)));
}
