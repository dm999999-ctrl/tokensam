"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DashboardMetricKey, DashboardToken, MetricSource } from "@/types/token";
import { visibleColumns } from "@/lib/data/column-visibility";
import type { RefreshStatusView } from "@/lib/refresh/freshness";
import { RefreshStatusLine } from "@/components/RefreshStatusLine";

type SortKey =
  | "name"
  | "chain"
  | "priceUsd"
  | "change24hPct"
  | "change7dPct"
  | "marketCapUsd"
  | "volume24hUsd"
  | "tvlUsd"
  | "tvlChange30dPct"
  | "fees24hUsd"
  | "revenue24hUsd";

type SortDirection = "asc" | "desc";
type DirectionFilter = "all" | "positive" | "negative";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatCurrency(value: number | null, compact = false) {
  if (value === null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : value < 1 ? 6 : 2,
    minimumFractionDigits: compact ? (value === 0 ? 2 : 1) : 2,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value === null) return null;
  return `${value > 0 ? "+" : ""}${numberFormat.format(value)}%`;
}

function sourceTitle(source: MetricSource | undefined) {
  if (!source) return undefined;
  const label = source.providerId === "calculated" ? "Calculated from DeFiLlama observations" : source.providerId;
  return `${label} · collected ${new Date(source.collectedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })}${source.note ? ` · ${source.note}` : ""}`;
}

function ChangeValue({ value, source }: { value: number | null; source?: MetricSource }) {
  if (value === null) return <Unavailable />;
  const direction = value > 0 ? "positive" : value < 0 ? "negative" : "flat";
  return <span className={`change-value ${direction}`} title={sourceTitle(source)}>{formatPercent(value)}</span>;
}

function Unavailable() {
  return <span className="unavailable">Data unavailable</span>;
}

function MetricValue({
  value,
  compact = false,
  source,
}: {
  value: number | null;
  compact?: boolean;
  source?: MetricSource;
}) {
  if (value === null) return <Unavailable />;
  return <span className="numeric-value" title={sourceTitle(source)}>{formatCurrency(value, compact)}</span>;
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="search-icon">
      <circle cx="8.8" cy="8.8" r="5.7" />
      <path d="m13 13 4 4" />
    </svg>
  );
}

function SortMark({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span aria-hidden="true" className={`sort-mark ${active ? "active" : ""}`}>
      {active ? (direction === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

const columns: { key: SortKey; label: string; kind: "text" | "currency" | "compact" | "percent"; hint?: string; alwaysVisible?: boolean }[] = [
  { key: "name", label: "Asset", kind: "text", alwaysVisible: true },
  { key: "chain", label: "Chain", kind: "text", alwaysVisible: true },
  { key: "priceUsd", label: "Price", kind: "currency" },
  { key: "change24hPct", label: "24h", kind: "percent" },
  { key: "change7dPct", label: "7d", kind: "percent" },
  { key: "marketCapUsd", label: "Market cap", kind: "compact" },
  { key: "volume24hUsd", label: "Vol · 24h", kind: "compact" },
  { key: "tvlUsd", label: "TVL", kind: "compact" },
  { key: "tvlChange30dPct", label: "TVL · 30d", kind: "percent", hint: "30-day change" },
  { key: "fees24hUsd", label: "Fees · 24h", kind: "compact" },
  { key: "revenue24hUsd", label: "Revenue · 24h", kind: "compact" },
];

function getSortValue(token: DashboardToken, key: SortKey) {
  if (key === "name") return token.name.toLocaleLowerCase();
  if (key === "chain") return token.chain.toLocaleLowerCase();
  return token[key];
}

function sortTokens(tokens: DashboardToken[], key: SortKey, direction: SortDirection) {
  return [...tokens].sort((left, right) => {
    const a = getSortValue(left, key);
    const b = getSortValue(right, key);

    // Keep unavailable values last in either sort direction.
    if (a === null) return b === null ? left.name.localeCompare(right.name) : 1;
    if (b === null) return -1;
    const result = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
    return result === 0 ? left.name.localeCompare(right.name) : direction === "asc" ? result : -result;
  });
}

export default function Dashboard({ tokens, error, dataUpdatedAt, refreshStatus }: { tokens: DashboardToken[]; error: string | null; dataUpdatedAt: string | null; refreshStatus: RefreshStatusView | null }) {
  const [query, setQuery] = useState("");
  const [chainFilter, setChainFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("marketCapUsd");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const chains = useMemo(() => [...new Set(tokens.map((token) => token.chain))].sort(), [tokens]);
  const categories = useMemo(() => [...new Set(tokens.map((token) => token.category))].sort(), [tokens]);

  const visibleTokens = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const filtered = tokens.filter((token) => {
      const matchesSearch =
        !search ||
        `${token.name} ${token.symbol} ${token.chain} ${token.category}`.toLocaleLowerCase().includes(search);
      const matchesChain = chainFilter === "all" || token.chain === chainFilter;
      const matchesCategory = categoryFilter === "all" || token.category === categoryFilter;
      const matchesDirection =
        directionFilter === "all" ||
        (directionFilter === "positive" && token.change24hPct !== null && token.change24hPct > 0) ||
        (directionFilter === "negative" && token.change24hPct !== null && token.change24hPct < 0);
      return matchesSearch && matchesChain && matchesCategory && matchesDirection;
    });

    return sortTokens(filtered, sortKey, sortDirection);
  }, [categoryFilter, chainFilter, directionFilter, query, sortDirection, sortKey, tokens]);

  const hasFilters = Boolean(query) || chainFilter !== "all" || categoryFilter !== "all" || directionFilter !== "all";
  // Hide a column only when no displayed token has valid data for it (zero is valid; null is not).
  const { visible: shownColumns, hidden: hiddenColumns } = useMemo(() => visibleColumns(columns, visibleTokens), [visibleTokens]);
  const tvlCoverage = tokens.filter((token) => token.tvlUsd !== null).length;

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "name" || key === "chain" ? "asc" : "desc");
  }

  function resetFilters() {
    setQuery("");
    setChainFilter("all");
    setCategoryFilter("all");
    setDirectionFilter("all");
  }

  function renderCell(token: DashboardToken, column: (typeof columns)[number]) {
    const value = token[column.key];
    if (column.kind === "text") {
      if (column.key === "name") {
          return (
          <Link href={`/tokens/${token.id}`} className="asset-link" aria-label={`Open ${token.name} token profile`}>
            <div className="asset-cell">
              <span className={`token-mark mark-${token.category.toLowerCase().replaceAll(" ", "-")}`} aria-hidden="true">
                {token.symbol.slice(0, 1)}
              </span>
              <span className="asset-copy">
                <span className="asset-name">{token.name}</span>
                <span className="asset-symbol">{token.symbol}</span>
              </span>
            </div>
          </Link>
        );
      }
      return <span className="chain-label">{token.chain}</span>;
    }
    const sourceKey = column.key as DashboardMetricKey;
    if (column.kind === "percent") return <ChangeValue value={value as number | null} source={token.metricSources?.[sourceKey]} />;
    return <MetricValue value={value as number | null} compact={column.kind === "compact"} source={token.metricSources?.[sourceKey]} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#dashboard" aria-label="Fundamental home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 30 30">
              <path d="M6 22 22.5 7.5" />
              <path d="m17.5 7.5 5.8-.4-.4 5.8" />
              <path d="m8 20 2 2" />
            </svg>
          </span>
          <span className="brand-copy">
              <strong>Katana</strong>
              <small>CRYPTO FUNDAMENTALS</small>
          </span>
        </a>

        <div className="nav-section-label">WORKSPACE</div>
        <nav aria-label="Main navigation" className="main-nav">
          <a className="nav-link selected" href="#dashboard" aria-current="page">
            <span className="nav-icon grid-icon" aria-hidden="true">▦</span>
            <span>Fundamentals</span>
            <span className="nav-current-dot" />
          </a>
        </nav>

        <div className="sidebar-foot">
          <span className="status-dot" />
          <span>Live stored data</span>
          <span className="sidebar-version">v0.1</span>
        </div>
      </aside>

      <main className="main-area" id="dashboard">
        <header className="topbar">
          <div className="breadcrumb"><span>Research</span><span className="breadcrumb-separator">/</span><strong>Fundamentals</strong></div>
          <div className="topbar-right">
            <span className="data-state"><span className="status-dot" /> Live stored data</span>
            <span className="topbar-divider" />
            <span className="user-mark" aria-label="Research workspace">K</span>
          </div>
        </header>

        <div className="content-wrap">
          {error ? <div className="live-data-error" role="alert">{error}</div> : <div className="live-data-banner" role="note"><span className="live-indicator" /> Values are from the latest observations stored in Supabase; hover metric values for source and collection time.</div>}

          <section className="page-heading" aria-labelledby="page-title">
            <div>
              <div className="eyebrow">MARKET INTELLIGENCE</div>
              <h1 id="page-title">Fundamentals overview</h1>
              <p className="page-description">Cut through market noise to examine token fundamentals and evidence.</p>
            </div>
            <div className="snapshot-box">
              <span className="snapshot-label">DATA STATUS</span>
              <strong>{error ? "Unavailable" : "Supabase snapshot"}</strong>
              <span>{error ? "Live data could not be loaded" : dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC · source/time on hover` : "No provider observations have been collected"}</span>
              <RefreshStatusLine status={refreshStatus} />
            </div>
          </section>

          <section className="summary-grid" aria-label="Live universe summary">
            <article className="summary-card">
              <div className="summary-label">Tracked assets <span className="summary-index">01</span></div>
              <div className="summary-value">{tokens.length}<span className="summary-unit">assets</span></div>
              <div className="summary-foot">Canonical tracked universe</div>
            </article>
            <article className="summary-card">
              <div className="summary-label">Chains represented <span className="summary-index">02</span></div>
              <div className="summary-value">{chains.length}<span className="summary-unit">networks</span></div>
              <div className="summary-foot">Across {categories.length} broad asset categories</div>
            </article>
            <article className="summary-card">
              <div className="summary-label">TVL data coverage <span className="summary-index">03</span></div>
              <div className="summary-value">{tvlCoverage}<span className="summary-unit">of {tokens.length} assets</span></div>
              <div className="summary-foot">Missing metrics remain clearly marked</div>
            </article>
            <article className="summary-card snapshot-summary">
              <div className="summary-label">Snapshot status <span className="summary-index">04</span></div>
              <div className="summary-value summary-status"><span className="status-dot" /> {error ? "UNAVAILABLE" : "LIVE STORED"}</div>
              <div className="summary-foot">Missing observations are not filled with zero</div>
            </article>
          </section>

          <section className="universe-section" aria-labelledby="universe-title">
            <div className="section-heading">
              <div>
                <div className="eyebrow">ASSET UNIVERSE</div>
                <h2 id="universe-title">Tracked tokens</h2>
              </div>
              <div className="section-meta"><span className="live-indicator" /> Supabase · provider observations</div>
            </div>

            <div className="filter-panel" aria-label="Token search and filters">
              <label className="search-field">
                <SearchIcon />
                <span className="visually-hidden">Search assets</span>
                <input
                  type="search"
                  placeholder="Search name, symbol, chain…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search tokens by name, symbol, chain, or category"
                  data-testid="token-search"
                />
              </label>
              <label className="filter-control">
                <span>Chain</span>
                <select value={chainFilter} onChange={(event) => setChainFilter(event.target.value)} aria-label="Filter by chain" data-testid="chain-filter">
                  <option value="all">All chains</option>
                  {chains.map((chain) => <option value={chain} key={chain}>{chain}</option>)}
                </select>
              </label>
              <label className="filter-control category-control">
                <span>Category</span>
                <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="Filter by category" data-testid="category-filter">
                  <option value="all">All categories</option>
                  {categories.map((category) => <option value={category} key={category}>{category}</option>)}
                </select>
              </label>
              <label className="filter-control move-control">
                <span>24h move</span>
                <select value={directionFilter} onChange={(event) => setDirectionFilter(event.target.value as DirectionFilter)} aria-label="Filter by 24-hour move" data-testid="move-filter">
                  <option value="all">All movements</option>
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                </select>
              </label>
              {hasFilters && <button className="reset-button" type="button" onClick={resetFilters}>Reset</button>}
            </div>

            <div className="table-toolbar">
              <span><strong>{visibleTokens.length}</strong> of {tokens.length} assets</span>
              <span>Sort by selecting any column <span className="toolbar-divider">·</span> Missing values shown explicitly{hiddenColumns.length > 0 && visibleTokens.length > 0 ? <><span className="toolbar-divider">·</span> Hidden (no displayed token has data): {hiddenColumns.map((column) => column.label).join(", ")}</> : null}</span>
            </div>

            <div className="table-frame">
              <table className="token-table">
                  <caption className="visually-hidden">Live stored token market and fundamentals observations. Missing values are identified explicitly.</caption>
                <thead>
                  <tr>
                    {shownColumns.map((column) => {
                      const active = sortKey === column.key;
                      return (
                        <th key={column.key} scope="col" aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"} className={column.key === "name" ? "asset-column" : undefined}>
                          <button type="button" className="sort-button" onClick={() => handleSort(column.key)} aria-label={`Sort by ${column.label}`}>
                            <span>{column.label}</span>
                            {column.hint && <span className="visually-hidden">, {column.hint}</span>}
                            <SortMark active={active} direction={sortDirection} />
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {visibleTokens.map((token) => (
                    <tr key={token.id} data-testid="token-row">
                      {shownColumns.map((column) => (
                        <td key={column.key} className={column.key === "name" ? "asset-column" : undefined}>
                          {renderCell(token, column)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {visibleTokens.length === 0 && (
                    <tr>
                      <td colSpan={shownColumns.length} className="empty-state">
                        <span className="empty-state-mark">⌕</span>
                        <strong>No assets match these filters</strong>
                        <span>{error ? "Live data could not be loaded from Supabase." : "Try a different search or reset the filters."}</span>
                        <button type="button" className="empty-reset" onClick={resetFilters}>Clear filters</button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-footnote">
              <span>Live means most recently stored; collection times may differ by provider.</span>
              <span>CoinGecko: market data <i /> DeFiLlama: curated protocol metrics <i /> TVL change compares stored observations around 30 days apart</span>
            </div>
          </section>

          <footer className="page-footer">
            <span>KATANA <b>·</b> CRYPTO FUNDAMENTALS</span>
            <span>Live stored data <b>·</b> sources remain provider-specific</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
