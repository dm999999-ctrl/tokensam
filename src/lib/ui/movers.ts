import { isValidNumber } from "./format.ts";

/**
 * Sidebar market panel: rankings of the tracked research universe from values
 * already read for the dashboard (latest CoinGecko `price_change_24h_pct` and
 * `volume_24h_usd` observation per canonical token). Presentation only: no
 * other period or metric is ever substituted, and nothing is fetched.
 */
export type Mover = { id: string; name: string; symbol: string; logoUrl: string | null; change24hPct: number };
export type VolumeRank = { id: string; name: string; symbol: string; logoUrl: string | null; volume24hUsd: number };
export type Movers = { gainers: Mover[]; losers: Mover[]; active: VolumeRank[]; inactive: VolumeRank[] };
export type MoverCandidate = {
  id: string; name: string; symbol: string; logoUrl?: string | null;
  change24hPct: number | null;
  volume24hUsd?: number | null;
};

export const MOVERS_PER_SIDE = 5;

/**
 * - Gainers: highest positive 24H change first. Losers: most negative first.
 *   Missing/non-finite changes are excluded; a 0% change is neither side.
 * - Active: highest valid 24H volume first. Inactive: lowest valid 24H volume
 *   first. Only finite, non-negative volumes rank: null/unavailable volume is
 *   excluded (never treated as zero); a genuinely reported 0 is eligible.
 * Each token appears at most once per list; ties break on the canonical token ID.
 */
export function selectMovers(tokens: MoverCandidate[], limit = MOVERS_PER_SIDE): Movers {
  const unique = tokens.filter((token, index) => tokens.findIndex((other) => other.id === token.id) === index);
  const base = (token: MoverCandidate) => ({ id: token.id, name: token.name, symbol: token.symbol, logoUrl: token.logoUrl ?? null });
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

  const changes: Mover[] = unique.filter((token) => isValidNumber(token.change24hPct))
    .map((token) => ({ ...base(token), change24hPct: token.change24hPct as number }));
  const volumes: VolumeRank[] = unique.filter((token) => isValidNumber(token.volume24hUsd) && token.volume24hUsd >= 0)
    .map((token) => ({ ...base(token), volume24hUsd: token.volume24hUsd as number }));

  return {
    gainers: changes.filter((token) => token.change24hPct > 0)
      .sort((a, b) => b.change24hPct - a.change24hPct || byId(a, b)).slice(0, limit),
    losers: changes.filter((token) => token.change24hPct < 0)
      .sort((a, b) => a.change24hPct - b.change24hPct || byId(a, b)).slice(0, limit),
    active: [...volumes].sort((a, b) => b.volume24hUsd - a.volume24hUsd || byId(a, b)).slice(0, limit),
    inactive: [...volumes].sort((a, b) => a.volume24hUsd - b.volume24hUsd || byId(a, b)).slice(0, limit),
  };
}

/** Compact USD with at most three significant digits: $48.2B, $6.42B, $842M, $95.3M, $0. */
export function formatVolumeCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumSignificantDigits: 3 }).format(value);
}
