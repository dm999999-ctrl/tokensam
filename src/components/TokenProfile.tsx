"use client";

import { useState } from "react";
import Link from "next/link";
import type { CalculatedMetricView, LiveTokenProfileData, MetricSource } from "@/types/token";
import { HistoricalSection } from "@/components/HistoricalSection";
import { RefreshStatusLine } from "@/components/RefreshStatusLine";
import { DeepAnalysisPanel, deepAnalysisButtonHint } from "@/components/DeepAnalysisPanel";
import type { AnalysisState } from "@/lib/analysis/service";
import { DEFILLAMA_PRO_TOKEN_METRICS, type CoverageProvider } from "@/data/provider-coverage";

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
  // Keep small non-zero values from rounding to a misleading "+0%".
  const options = value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 };
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", options).format(value)}%`;
}

function formatSupply(value: number | null) {
  if (value === null) return null;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 3 }).format(value);
}

function Unavailable() {
  return <span className="unavailable">Data unavailable</span>;
}

function Currency({ value, compact = false }: { value: number | null; compact?: boolean }) {
  const formatted = formatCurrency(value, compact);
  return formatted === null ? <Unavailable /> : <span className="numeric-value">{formatted}</span>;
}

function Percent({ value }: { value: number | null }) {
  const formatted = formatPercent(value);
  if (formatted === null) return <Unavailable />;
  const direction = value! > 0 ? "positive" : value! < 0 ? "negative" : "flat";
  return <span className={`change-value ${direction}`}>{formatted}</span>;
}

function Supply({ value, symbol }: { value: number | null; symbol: string }) {
  const formatted = formatSupply(value);
  return formatted === null ? <Unavailable /> : <span className="numeric-value">{formatted} {symbol}</span>;
}

function SnapshotDate({ value }: { value: string }) {
  const date = new Date(value);
  return <>{date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}</>;
}

function sourceTitle(source: MetricSource | undefined) {
  if (!source) return undefined;
  const provider = source.providerId === "calculated" ? "Deterministic metric" : source.providerId;
  return `${provider} · collected ${new Date(source.collectedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })}${source.note ? ` · ${source.note}` : ""}`;
}

const CATEGORY_GROUPS: { category: CalculatedMetricView["category"]; label: string }[] = [
  { category: "valuation", label: "Valuation relationships" },
  { category: "growth", label: "Changes over stored intervals" },
  { category: "divergence", label: "Divergence flags" },
];

/** One concise explanation for an entire unavailable group, with the detail still reachable. */
function GroupNote({ title, reason, items }: { title: string; reason: string; items?: string[] }) {
  return (
    <div className="group-note" role="note">
      <strong>{title}: not available</strong>
      <p>{reason}</p>
      {items && items.length > 0 && <details><summary>Details</summary><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    </div>
  );
}

/** Unavailable metrics collapsed into one expandable line with each reason preserved. */
function UnavailableMetrics({ metrics }: { metrics: CalculatedMetricView[] }) {
  return (
    <details className="unavailable-group">
      <summary>{metrics.length} unavailable {metrics.length === 1 ? "metric" : "metrics"} · why</summary>
      <ul>{metrics.map((metric) => <li key={metric.id}><b>{metric.name}</b>{metric.sourceScopes ? <small> ({metric.sourceScopes})</small> : null}: {metric.unavailableReason ?? (metric.status === "invalid" ? "Invalid source values." : "Required observations are unavailable.")}</li>)}</ul>
    </details>
  );
}

function calculatedLabel(metric: CalculatedMetricView | undefined) {
  if (!metric || metric.status !== "available" || metric.value === null) return <Unavailable />;
  if (metric.unit === "USD") return <Currency value={metric.value} compact />;
  if (metric.unit === "percent" || metric.unit === "percentage_points") return <Percent value={metric.value} />;
  if (metric.unit === "boolean") return metric.value === 1 ? "Observed" : "Not observed";
  if (metric.unit === "count") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(metric.value);
  return <span className="numeric-value">{new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(metric.value)}×</span>;
}

export function TokenProfile({ data, analysisState }: { data: LiveTokenProfileData; analysisState: AnalysisState }) {
  const { token, calculatedMetrics } = data;
  // A stored analysis is shown by default; otherwise the panel opens on request.
  const [showAnalysis, setShowAnalysis] = useState(analysisState.status === "ready" && analysisState.latest !== null);
  const markClass = token.category.toLowerCase().replaceAll(" ", "-");
  const calculated = (id: string) => calculatedMetrics.find((metric) => metric.id === id);
  const marketCapTvl = calculated("market_cap_to_tvl");
  const revenueGrowth = calculated("revenue_growth_pct");
  const latestUpdate = Object.values(data.metricSources).map((source) => source?.collectedAt ?? "").filter(Boolean).sort().at(-1);
  const dexMetrics = calculatedMetrics.filter((metric) => metric.category === "market_structure");
  const availableDex = dexMetrics.filter((metric) => metric.status === "available");
  const unavailableDex = dexMetrics.filter((metric) => metric.status !== "available");
  const coverageFor = (provider: CoverageProvider) => data.coverage.find((item) => item.provider === provider);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Katana dashboard home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 30 30">
              <path d="M6 22 22.5 7.5" />
              <path d="m17.5 7.5 5.8-.4-.4 5.8" />
              <path d="m8 20 2 2" />
            </svg>
          </span>
          <span className="brand-copy"><strong>Katana</strong><small>CRYPTO FUNDAMENTALS</small></span>
        </Link>
        <div className="nav-section-label">WORKSPACE</div>
        <nav aria-label="Main navigation" className="main-nav">
          <Link className="nav-link" href="/">
            <span className="nav-icon grid-icon" aria-hidden="true">▦</span><span>Fundamentals</span>
          </Link>
        </nav>
        <div className="sidebar-foot"><span className="status-dot" /><span>Live stored data</span><span className="sidebar-version">v0.1</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><Link href="/">Research</Link><span className="breadcrumb-separator">/</span><strong>{token.symbol} profile</strong></div>
          <div className="topbar-right"><span className="data-state"><span className="status-dot" /> Live stored data</span><span className="topbar-divider" /><span className="user-mark" aria-label="Research workspace">K</span></div>
        </header>

        <div className="content-wrap profile-content">
          <div className="live-data-banner" role="note"><span className="live-indicator" /> Values come from stored provider observations and deterministic calculations; collection times may differ by source.</div>

          <div className="profile-back-row">
            <Link className="back-link" href="/" aria-label="Back to dashboard">← <span>Back to dashboard</span></Link>
            <div className="profile-breadcrumb">ASSET RESEARCH <span>/</span> TOKEN PROFILE</div>
          </div>

          <section className="profile-hero" aria-labelledby="profile-title">
            <div className="profile-identity">
              <span className={`token-mark profile-token-mark mark-${markClass}`} aria-hidden="true">{token.symbol.slice(0, 1)}</span>
              <div className="profile-title-copy">
                <div className="eyebrow">TOKEN FUNDAMENTALS <span className="identity-dot">·</span> {token.chain.toUpperCase()}</div>
                <h1 id="profile-title">{token.name} <span>{token.symbol}</span></h1>
                <div className="identity-tags"><span>{token.chain}</span><span>{token.category}</span><span className="sample-tag">LIVE PROFILE</span></div>
              </div>
            </div>
            <div className="hero-price-panel">
              <span className="metric-kicker">PRICE · USD</span>
              <strong className="hero-price"><Currency value={token.priceUsd} /></strong>
              <div className="hero-changes"><span>24h <Percent value={token.change24hPct} /></span><span>7d <Percent value={token.change7dPct} /></span></div>
            </div>
          </section>

          <div className="profile-intro-row">
            <p className="profile-description">{data.description ?? <Unavailable />}</p>
            <button className="deep-analysis-button" type="button" onClick={() => setShowAnalysis((shown) => !shown)} aria-expanded={showAnalysis} aria-controls="deep-ai-analysis">
              <span className="analysis-button-mark" aria-hidden="true">↗</span>
              <span className="analysis-button-copy"><strong>Deep AI Analysis</strong><small>{deepAnalysisButtonHint(analysisState)}</small></span>
              <span className="analysis-button-arrow" aria-hidden="true">→</span>
            </button>
          </div>

          <DeepAnalysisPanel tokenId={token.id} initialState={analysisState} hidden={!showAnalysis} />

          <section className="profile-metric-grid" aria-label="Market metrics">
            <article className="profile-metric-card"><span className="profile-card-label">Market cap</span><strong><Currency value={token.marketCapUsd} compact /></strong><span className="profile-card-note">CoinGecko observation</span></article>
            <article className="profile-metric-card"><span className="profile-card-label">Volume · 24h</span><strong><Currency value={token.volume24hUsd} compact /></strong><span className="profile-card-note">CoinGecko observation</span></article>
            <article className="profile-metric-card"><span className="profile-card-label">Market cap / TVL</span><strong title={marketCapTvl?.formula}>{calculatedLabel(marketCapTvl)}</strong><span className="profile-card-note">Stored deterministic metric</span></article>
            <article className="profile-metric-card"><span className="profile-card-label">Revenue growth</span><strong title={revenueGrowth?.formula}>{calculatedLabel(revenueGrowth)}</strong><span className="profile-card-note">Stored deterministic metric</span></article>
          </section>

          <HistoricalSection data={data.history} />

          <div className="profile-panels-grid">
            <section className="research-panel" aria-labelledby="token-defi-title">
              <div className="profile-section-header"><div><div className="eyebrow">TOKEN-LEVEL DEFI DATA</div><h2 id="token-defi-title">DeFiLlama token data</h2></div><span className="panel-index">01</span></div>
              <div className="metric-list">
                <div className="metric-list-row">
                  <span>Token price <small>{coverageFor("defillama_coins")?.identifier ? `DeFiLlama coins API · ${coverageFor("defillama_coins")?.identifier}` : "DeFiLlama coins API"}</small></span>
                  <strong title={data.tokenLevelPrice?.note ?? undefined}>{data.tokenLevelPrice ? <Currency value={data.tokenLevelPrice.value} /> : <Unavailable />}</strong>
                </div>
              </div>
              <GroupNote title="Token liquidity, emissions/unlocks, protocol exposure" reason="Available from DeFiLlama only through its paid Pro API, which is not configured." items={DEFILLAMA_PRO_TOKEN_METRICS.map((item) => `${item.metric}: ${item.detail}`)} />
              <p className="panel-footnote">Token-level data for this exact asset. It is separate from protocol data below and is never inferred from protocol or chain TVL.</p>
            </section>

            <section className="research-panel" aria-labelledby="protocol-metrics-title">
              <div className="profile-section-header"><div><div className="eyebrow">ASSOCIATED PROTOCOL DATA</div><h2 id="protocol-metrics-title">Protocol activity</h2></div><span className="panel-index">02</span></div>
              {coverageFor("defillama")?.status === "mapped" ? (
                <>
                  <div className="metric-list">
                    <div className="metric-list-row"><span>Protocol TVL <small>Latest curated DeFiLlama protocol observation</small></span><strong title={sourceTitle(token.metricSources?.tvlUsd)}><Currency value={token.tvlUsd} compact /></strong></div>
                    <div className="metric-list-row"><span>Protocol TVL change <small>Stored observations approximately 30 days apart</small></span><strong title={sourceTitle(token.metricSources?.tvlChange30dPct)}><Percent value={token.tvlChange30dPct} /></strong></div>
                    <div className="metric-list-row"><span>Protocol fees <small>Latest curated DeFiLlama 24-hour value</small></span><strong title={sourceTitle(token.metricSources?.fees24hUsd)}><Currency value={token.fees24hUsd} compact /></strong></div>
                    <div className="metric-list-row"><span>Protocol revenue <small>Latest curated DeFiLlama 24-hour value</small></span><strong title={sourceTitle(token.metricSources?.revenue24hUsd)}><Currency value={token.revenue24hUsd} compact /></strong></div>
                  </div>
                  <p className="panel-footnote">{coverageFor("defillama")?.detail}</p>
                </>
              ) : (
                <GroupNote title="Protocol TVL, fees, and revenue" reason={coverageFor("defillama")?.detail ?? "No protocol association."} />
              )}
            </section>

            <section className="research-panel" aria-labelledby="market-structure-title">
              <div className="profile-section-header"><div><div className="eyebrow">DEX MARKET DATA</div><h2 id="market-structure-title">DEX markets</h2></div><span className="panel-index">03</span></div>
              {coverageFor("dexscreener")?.status === "mapped" ? (
                <>
                  <p className="market-structure-copy">Exact-address DEX Screener pairs for {coverageFor("dexscreener")?.identifier}. DEX data covers these pairs only, not the whole market.</p>
                  <div className="metric-list">
                    {availableDex.map((metric) => <div className="metric-list-row" key={metric.id}><span>{metric.name}<small>{metric.periodEndAt ? `Through ${new Date(metric.periodEndAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })}` : "Stored calculated metric"}</small></span><strong title={metric.formula}>{calculatedLabel(metric)}</strong></div>)}
                  </div>
                  {unavailableDex.length > 0 && <UnavailableMetrics metrics={unavailableDex} />}
                </>
              ) : (
                <GroupNote title="DEX liquidity, volume, and transactions" reason={coverageFor("dexscreener")?.detail ?? "No verified DEX Screener mapping."} />
              )}
              <div className="profile-detail-row"><span>Chain</span><strong>{token.chain}</strong></div>
              <div className="profile-detail-row"><span>Category</span><strong>{token.category}</strong></div>
              <div className="profile-detail-row contract-row"><span>Contract / mint</span><strong>{data.isNative ? "Native asset · no contract address" : data.contractAddress ?? <Unavailable />}</strong></div>
            </section>

            <section className="research-panel tokenomics-panel" aria-labelledby="tokenomics-title">
              <div className="profile-section-header"><div><div className="eyebrow">SUPPLY PROFILE</div><h2 id="tokenomics-title">Tokenomics</h2></div><span className="panel-index">04</span></div>
              <div className="supply-grid">
                <div className="supply-item"><span>Circulating supply</span><strong title={sourceTitle(data.metricSources.circulating_supply)}><Supply value={data.circulatingSupply} symbol={token.symbol} /></strong></div>
                <div className="supply-item"><span>Total supply</span><strong title={sourceTitle(data.metricSources.total_supply)}><Supply value={data.totalSupply} symbol={token.symbol} /></strong></div>
                <div className="supply-item"><span>Maximum supply</span><strong title={sourceTitle(data.metricSources.maximum_supply)}><Supply value={data.maximumSupply} symbol={token.symbol} /></strong></div>
              </div>
              <p className="panel-footnote">Supply values are CoinGecko token-level observations. Emissions and unlock schedules are not collected (DeFiLlama offers them only through its Pro API).</p>
            </section>

            <section className="research-panel data-notes-panel coverage-panel" aria-labelledby="data-notes-title">
              <div className="profile-section-header"><div><div className="eyebrow">EVIDENCE & COVERAGE</div><h2 id="data-notes-title">Provider coverage</h2></div><span className="panel-index">05</span></div>
              <div className="provenance-stamp"><span className="status-dot" /> PROVIDER OBSERVATIONS <span>{latestUpdate ? <SnapshotDate value={latestUpdate} /> : "No collection timestamp"}</span></div>
              <RefreshStatusLine status={data.refreshStatus} />
              <table className="coverage-table">
                <thead><tr><th scope="col">Provider</th><th scope="col">Scope</th><th scope="col">Identifier / reason</th></tr></thead>
                <tbody>
                  {data.coverage.map((item) => (
                    <tr key={item.provider} className={item.status}>
                      <td>{item.label}</td>
                      <td>{item.scope}</td>
                      <td>{item.status === "mapped" ? <><code>{item.identifier}</code><small>{item.verification}</small></> : <><b>Unavailable</b><small>{item.detail}</small></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="data-notes-list">{data.dataNotes.length ? data.dataNotes.map((note) => <li key={note}>{note}</li>) : <li>Provider notes are unavailable for this token.</li>}</ul>
              <p className="provenance-line">Each metric retains provider, scope, identifier, and collection time. Protocol and DEX data are never presented as token-level data.</p>
            </section>
          </div>

          <section className="research-panel calculated-metrics-panel" aria-labelledby="calculated-metrics-title">
            <div className="profile-section-header"><div><div className="eyebrow">DETERMINISTIC DERIVATIONS</div><h2 id="calculated-metrics-title">Calculated metrics</h2></div><span className="panel-index">06</span></div>
            {CATEGORY_GROUPS.map(({ category, label }) => {
              const group = calculatedMetrics.filter((metric) => metric.category === category);
              const available = group.filter((metric) => metric.status === "available");
              const unavailable = group.filter((metric) => metric.status !== "available");
              if (group.length === 0) return null;
              return (
                <div className="calculated-group" key={category}>
                  <h3>{label}</h3>
                  {available.length > 0 && (
                    <div className="calculated-metrics-grid">{available.map((metric) => <article className="calculated-metric" key={metric.id} title={`${metric.formula}${metric.sourceScopes ? ` · sources: ${metric.sourceScopes}` : ""}${metric.periodStartAt ? ` · ${metric.periodStartAt} to ${metric.periodEndAt}` : ""}`}><span>{metric.name}</span><strong>{calculatedLabel(metric)}</strong><small>Calculated {new Date(metric.calculatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })}{metric.sourceScopes ? ` · ${metric.sourceScopes}` : ""}</small></article>)}</div>
                  )}
                  {unavailable.length > 0 && <UnavailableMetrics metrics={unavailable} />}
                </div>
              );
            })}
          </section>

          <footer className="page-footer"><span>KATANA <b>·</b> CRYPTO FUNDAMENTALS</span><span>Live stored data <b>·</b> AI analysis on request only</span></footer>
        </div>
      </main>
    </div>
  );
}
