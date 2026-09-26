export type ProviderStep = "coingecko" | "defillama" | "dexscreener" | "defillama_coins" | "geckoterminal";
export type RefreshStep = ProviderStep | "metrics";

export const PROVIDER_STEPS: ProviderStep[] = ["coingecko", "dexscreener", "defillama", "defillama_coins", "geckoterminal"];

/**
 * Providers shown in the dashboard/Token Profile freshness UI (see
 * DataStatus.tsx, UniverseHero.tsx). GeckoTerminal is intentionally excluded:
 * this integration only establishes and verifies its data pipeline (see
 * docs/geckoterminal-integration.md) and does not change the Token Profile
 * UI yet. It still runs in the refresh pipeline via PROVIDER_STEPS.
 */
export const DISPLAYED_PROVIDER_STEPS: ProviderStep[] = PROVIDER_STEPS.filter((step) => step !== "geckoterminal");

const MINUTE = 60 * 1000;

/**
 * Per-provider refresh policy.
 *
 * - intervalMs: a provider is "due" once this long has passed since its last
 *   successful refresh. The scheduler fires hourly; each run collects only the
 *   providers that are due, so a missed or duplicated cron delivery self-heals.
 * - staleAfterMs: when stored data stops being "current" in the UI. Roughly
 *   interval x 3 (one missed run plus slack), and a full day for DeFiLlama,
 *   whose fees/revenue are 24-hour totals and whose TVL history is daily.
 * - timeoutMs: provider-fetch budget inside one run. Collectors fetch before
 *   writing, so a timeout aborts before any Supabase change.
 *
 * Quota notes (see docs/*-integration.md): one CoinGecko run is one
 * /coins/markets call (100 IDs < 250 per call), so hourly is ~744 calls/month
 * against the documented 10,000/month Demo allowance. DEX Screener uses ~13
 * requests per run against its documented 300/minute. DeFiLlama publishes no
 * numeric free-tier limit, so it is refreshed least often.
 *
 * Providers run in parallel, then metrics (METRICS_TIMEOUT_MS). The longest
 * provider budget plus the metrics budget must stay below the cron route's
 * 300 s maxDuration: 150 s + 90 s = 240 s.
 */
export const REFRESH_POLICY: Record<ProviderStep, { label: string; intervalMs: number; staleAfterMs: number; timeoutMs: number }> = {
  coingecko: { label: "CoinGecko", intervalMs: 60 * MINUTE, staleAfterMs: 3 * 60 * MINUTE, timeoutMs: 90_000 },
  dexscreener: { label: "DEX Screener", intervalMs: 60 * MINUTE, staleAfterMs: 3 * 60 * MINUTE, timeoutMs: 90_000 },
  // Current TVL + fees + revenue: three small requests per protocol (72 for 24), paced 1.1 s apart.
  // Measured 2026-09-25 at 109 s for 24 protocols, so the budget is 150 s (pacing is unchanged).
  // Dated TVL history (/protocol, up to ~69 MB per record) is a separate explicit backfill.
  defillama: { label: "DeFiLlama", intervalMs: 6 * 60 * MINUTE, staleAfterMs: 24 * 60 * MINUTE, timeoutMs: 150_000 },
  // Token-level DeFiLlama prices: small batched requests (25 keys each; four for 100 tokens).
  defillama_coins: { label: "DeFiLlama (token prices)", intervalMs: 60 * MINUTE, staleAfterMs: 3 * 60 * MINUTE, timeoutMs: 30_000 },
  // Standalone GeckoTerminal Public API (never CoinGecko's /onchain endpoints; a
  // separate provider with its own quota). Its public rate limit is treated
  // conservatively as ~10 requests/minute (6.5 s minimum pacing). Per-token DEX
  // pool lookups are not batchable, so each run is capped to a small token
  // subset (see run-geckoterminal-collection.ts) and refreshed infrequently.
  geckoterminal: { label: "GeckoTerminal", intervalMs: 6 * 60 * MINUTE, staleAfterMs: 24 * 60 * MINUTE, timeoutMs: 150_000 },
};

/** Cron delivery can be late or early by minutes; treat a provider as due slightly early. */
export const DUE_TOLERANCE_MS = 10 * MINUTE;

/** Metrics read Supabase only; bound them so a slow database cannot hang the run. */
export const METRICS_TIMEOUT_MS = 90_000;

/**
 * A run holds the lock for at most this long. Longer than the route's
 * maxDuration (300 s) so a live run is never stolen, but short enough that a
 * crashed run does not block refreshes for more than one cron interval.
 */
export const RUN_LEASE_MS = 10 * MINUTE;
