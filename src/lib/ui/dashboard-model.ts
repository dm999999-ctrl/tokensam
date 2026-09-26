import type { DashboardToken } from "../../types/token.ts";
import { visibleColumns } from "../data/column-visibility.ts";

/**
 * Research Universe: a market-only overview table. Every column is
 * token-level market or supply data; protocol fundamentals and DEX market
 * structure live in the Token Profile. Column visibility is recomputed from
 * the rows actually displayed; a token is never hidden for missing data.
 */

export type ColumnFormat = "usd" | "usd-compact" | "change" | "ratio" | "share";
export type ColumnKey =
  | "priceUsd" | "change24hPct" | "change7dPct" | "marketCapUsd" | "fdvUsd" | "volume24hUsd" | "volumeToMarketCap"
  | "volume7dUsd";

export type Column = { key: ColumnKey; label: string; format: ColumnFormat; hint?: string };
export type Row = Record<ColumnKey, number | null> & { token: DashboardToken };

export const SCOPE_NOTE = "Token-level market data. Open a token for protocol fundamentals, DEX market structure, history, and AI analysis.";

export const COLUMNS: Column[] = [
  { key: "priceUsd", label: "Price", format: "usd" },
  { key: "change24hPct", label: "24h", format: "change", hint: "24-hour price change" },
  { key: "change7dPct", label: "7d", format: "change", hint: "7-day price change" },
  { key: "marketCapUsd", label: "Market cap", format: "usd-compact" },
  { key: "fdvUsd", label: "FDV", format: "usd-compact", hint: "Fully diluted valuation, as reported for the token" },
  { key: "volume24hUsd", label: "24H Volume", format: "usd-compact" },
  { key: "volumeToMarketCap", label: "Vol / mcap", format: "ratio", hint: "24-hour volume divided by market cap" },
  { key: "volume7dUsd", label: "7D Volume", format: "usd-compact", hint: "Sum of seven non-overlapping 24-hour volume observations covering the latest 7 days" },
];

export const DEFAULT_SORT_KEY: ColumnKey = "marketCapUsd";

export function toRow(token: DashboardToken): Row {
  const calc = token.calculated ?? {};
  return {
    token,
    priceUsd: token.priceUsd,
    change24hPct: token.change24hPct,
    change7dPct: token.change7dPct,
    marketCapUsd: token.marketCapUsd,
    fdvUsd: token.fdvUsd ?? null,
    volume24hUsd: token.volume24hUsd,
    volumeToMarketCap: calc.volume_to_market_cap ?? null,
    volume7dUsd: token.volume7dUsd ?? null,
  };
}

export type Filters = { query: string; chain: string; category: string; move: "all" | "positive" | "negative"; coverage: "all" | "protocol" | "dex" };
export const EMPTY_FILTERS: Filters = { query: "", chain: "all", category: "all", move: "all", coverage: "all" };

export function filterRows(rows: Row[], filters: Filters): Row[] {
  const search = filters.query.trim().toLocaleLowerCase();
  return rows.filter(({ token }) => {
    if (search && !`${token.name} ${token.symbol} ${token.chain} ${token.category}`.toLocaleLowerCase().includes(search)) return false;
    if (filters.chain !== "all" && token.chain !== filters.chain) return false;
    if (filters.category !== "all" && token.category !== filters.category) return false;
    if (filters.move === "positive" && !(token.change24hPct !== null && token.change24hPct > 0)) return false;
    if (filters.move === "negative" && !(token.change24hPct !== null && token.change24hPct < 0)) return false;
    if (filters.coverage === "protocol" && !token.coverage?.hasProtocolData) return false;
    if (filters.coverage === "dex" && !token.coverage?.hasDexData) return false;
    return true;
  });
}

export type SortKey = ColumnKey | "name";
export function sortRows(rows: Row[], key: SortKey, direction: "asc" | "desc"): Row[] {
  return [...rows].sort((left, right) => {
    const a = key === "name" ? left.token.name.toLocaleLowerCase() : left[key];
    const b = key === "name" ? right.token.name.toLocaleLowerCase() : right[key];
    // Unavailable values stay last in either direction.
    if (a === null) return b === null ? left.token.name.localeCompare(right.token.name) : 1;
    if (b === null) return -1;
    const result = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
    return result === 0 ? left.token.name.localeCompare(right.token.name) : direction === "asc" ? result : -result;
  });
}

/** Research Universe columns, hiding only those with no valid value among the displayed rows (zero is valid). */
export function researchColumns(rows: Row[]): { visible: Column[]; hidden: Column[] } {
  return visibleColumns<Row, Column>(COLUMNS, rows);
}


/** Why one cell is empty, for its tooltip. */
export function missingReason(column: Column, token: DashboardToken): string {
  if (column.key === "volume7dUsd") {
    if (token.volume24hUsd === null) return "No 24-hour volume is reported for this token";
    return "Not enough stored 24-hour volume history to cover the latest 7 days";
  }
  return "Not reported for this token";
}

export type UniverseSummary = {
  assets: number; chains: number; up: number; down: number; flat: number; protocol: number; dex: number;
  /** Tracked tokens with a valid 24H price change (up + down + flat); the rest are not classified. */
  withChange: number;
  /** Sum over tokens with a valid market cap / 24H volume; null when none has one. Missing values are skipped, never zero. */
  marketCapUsd: number | null; marketCapCount: number;
  volume24hUsd: number | null; volumeCount: number;
  /** Median 24H price change across tokens with a valid change; null when none has one. */
  medianChange24hPct: number | null;
};

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Median of finite values (mean of the two middle values for an even count); null for none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function universeSummary(tokens: DashboardToken[]): UniverseSummary {
  const changes = tokens.map((token) => token.change24hPct).filter(finite);
  const caps = tokens.map((token) => token.marketCapUsd).filter(finite);
  const volumes = tokens.map((token) => token.volume24hUsd).filter(finite);
  return {
    assets: tokens.length,
    chains: new Set(tokens.map((token) => token.chain)).size,
    up: changes.filter((change) => change > 0).length,
    down: changes.filter((change) => change < 0).length,
    flat: changes.filter((change) => change === 0).length,
    protocol: tokens.filter((token) => token.coverage?.hasProtocolData).length,
    dex: tokens.filter((token) => token.coverage?.hasDexData).length,
    withChange: changes.length,
    marketCapUsd: caps.length > 0 ? caps.reduce((sum, value) => sum + value, 0) : null,
    marketCapCount: caps.length,
    volume24hUsd: volumes.length > 0 ? volumes.reduce((sum, value) => sum + value, 0) : null,
    volumeCount: volumes.length,
    medianChange24hPct: median(changes),
  };
}
