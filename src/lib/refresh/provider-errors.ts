import { CoinGeckoApiError } from "../providers/coingecko.ts";

/**
 * Coarse classification of a provider failure, used to decide whether a
 * rate-limit cooldown applies. Deliberately small: only "rate_limited" is
 * acted on today, but the other kinds keep the orchestrator's error handling
 * legible and give future providers a place to plug in without inventing a
 * new shape.
 */
export type ProviderFailureKind =
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "configuration_error"
  | "unknown";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  /** Retry-After from the provider's final response, in ms, when it provided one. */
  retryAfterMs: number | null;
};

/**
 * Classify a collector's thrown error. Structured (error class + HTTP status)
 * rather than string-matching, so classification survives message wording
 * changes. Only errors from collectors that expose a status are classified
 * beyond "unknown" today; extend this as more providers need cooldowns.
 */
export function classifyProviderError(error: unknown): ProviderFailure {
  if (error instanceof CoinGeckoApiError) {
    if (error.status === 429) return { kind: "rate_limited", retryAfterMs: error.retryAfterMs };
    if (error.status !== null && error.status >= 500) return { kind: "server_error", retryAfterMs: null };
    if (error.status === null) return { kind: "network_error", retryAfterMs: null };
    return { kind: "unknown", retryAfterMs: null };
  }
  return { kind: "unknown", retryAfterMs: null };
}
