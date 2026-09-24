"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoricalMetric, HistoricalPeriod, TokenHistoricalData } from "@/types/historical-data";
import { HISTORICAL_PERIODS, coverageChangePct, formatSpan, pointsInPeriod } from "@/lib/data/historical-series";

// Charts connect actual stored observations only; below this count each point is also drawn.
const MAX_POINTS_WITH_DOTS = 40;
const metricLabels: Record<HistoricalMetric, string> = {
  priceUsd: "Price",
  tvlUsd: "TVL",
  volumeUsd: "Volume",
};

function money(value: number, compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : value < 1 ? 6 : 2,
    minimumFractionDigits: compact ? 1 : 2,
  }).format(value);
}

function utc(value: string, withTime = true) {
  return new Date(value).toLocaleString("en-GB", withTime ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" } : { dateStyle: "medium", timeZone: "UTC" });
}

function ChartCard({
  metric,
  data,
  period,
  wide = false,
}: {
  metric: HistoricalMetric;
  data: TokenHistoricalData;
  period: HistoricalPeriod;
  wide?: boolean;
}) {
  const series = data[metric];
  // Windows end at the server time the page was built, not at the latest observation.
  const coverage = series.periods[period];
  const points = pointsInPeriod(series.points, period, new Date(data.asOf));
  // A numeric time axis keeps spacing proportional to time when daily and hourly points are mixed.
  const chartPoints = points.map((item) => ({ ...item, time: Date.parse(item.timestamp) }));
  const latest = points.at(-1);
  const hasTrend = coverage.status === "available";
  const change = hasTrend ? coverageChangePct(points) : null;
  const label = metricLabels[metric];
  const provider = series.providerId;
  const scopeLabel = series.scope === "protocol" ? "protocol-level" : "token-level";

  return (
    <article className={`history-chart-card${wide ? " history-chart-wide" : ""}`} aria-label={`${label} history chart`}>
      <header className="history-chart-header">
        <div><span className="history-chart-title">{label} history</span><span className="history-chart-unit">USD</span></div>
        <div className="history-chart-summary">
          {latest ? <span className="history-latest-label" title={`${latest.sourceId} · observed ${utc(latest.timestamp)} UTC`}>LATEST IN WINDOW · {provider}</span> : null}
          <strong>{latest ? money(latest.valueUsd, true) : <span className="unavailable">Data unavailable</span>}</strong>
          {change !== null && coverage.coverageHours !== null ? <span className={change > 0 ? "positive" : change < 0 ? "negative" : "flat"}>{change > 0 ? "+" : ""}{change.toFixed(2)}% <small>across {formatSpan(coverage.coverageHours)} of observations</small></span> : null}
        </div>
      </header>
      {hasTrend ? (
        <div className="history-chart-plot" role="img" aria-label={`${label} in USD: ${coverage.coverageLabel} within the requested ${period} window`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartPoints} margin={{ top: 12, right: 10, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="rgba(215, 207, 191, 0.08)" vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value: number) => new Date(value).toLocaleString("en-US", period === "24H" ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" })}
                tick={{ fill: "#77766f", fontSize: 9 }}
                axisLine={{ stroke: "#34332f" }}
                tickLine={false}
                minTickGap={24}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={(value: number) => money(value, true)}
                tick={{ fill: "#77766f", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                width={58}
                domain={["auto", "auto"]}
              />
              <Tooltip
                labelFormatter={(value) => `${utc(new Date(Number(value)).toISOString())} UTC`}
                formatter={(value, _name, item) => [money(Number(value)), `${label} · ${provider} · ${(item?.payload as { sourceId?: string } | undefined)?.sourceId ?? ""}`]}
                contentStyle={{ background: "#181817", border: "1px solid #48443d", borderRadius: 3, color: "#e7e1d7", fontSize: 11 }}
                labelStyle={{ color: "#a7a197", marginBottom: 5 }}
                itemStyle={{ color: "#e7e1d7" }}
                cursor={{ stroke: "#756e62", strokeDasharray: "3 3" }}
              />
              <Line
                type="linear"
                dataKey="valueUsd"
                name={label}
                stroke="#c94b4b"
                strokeWidth={2}
                dot={points.length <= MAX_POINTS_WITH_DOTS ? { r: 2, fill: "#c94b4b", strokeWidth: 0 } : false}
                activeDot={{ r: 3, fill: "#d76b5e", stroke: "#191817", strokeWidth: 1 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="history-unavailable" role="status">
          <span className="history-unavailable-mark" aria-hidden="true">—</span>
          <strong>No sufficient stored history is available for this period.</strong>
          <span>{coverage.unavailableReason}</span>
        </div>
      )}
      {hasTrend && !coverage.fullCoverage && coverage.coverageStart && coverage.coverageEnd ? (
        <p className="history-partial" role="note">Partial coverage: stored observations span {formatSpan(coverage.coverageHours ?? 0)} ({utc(coverage.coverageStart)} to {utc(coverage.coverageEnd)} UTC) of the requested {period} window.</p>
      ) : null}
      <footer className="history-chart-footer"><span>Requested {period} · {coverage.coverageLabel}</span><span>Source: {provider} · {scopeLabel}</span></footer>
    </article>
  );
}

export function HistoricalSection({ data }: { data: TokenHistoricalData }) {
  const [period, setPeriod] = useState<HistoricalPeriod>("30D");

  return (
    <section className="historical-section" aria-labelledby="historical-title">
      <div className="history-section-topline"><span className="live-indicator" /><span>Stored historical observations · provider sources remain separate</span></div>
      <div className="history-section-heading">
        <div className="profile-section-header history-section-title">
          <div><div className="eyebrow">MARKET BEHAVIOR & FUNDAMENTALS</div><h2 id="historical-title">Historical signals</h2></div>
          <span className="panel-index">05</span>
        </div>
        <div className="history-period-control" role="group" aria-label="Historical chart period">
          {HISTORICAL_PERIODS.map((option) => (
            <button key={option} type="button" onClick={() => setPeriod(option)} aria-pressed={period === option}>{option}</button>
          ))}
        </div>
      </div>
      <p className="history-intro">Compare market movement with protocol activity. Each series is kept independently so reliable fundamentals can be aligned with price as source history becomes available.</p>
      <div className="history-chart-grid">
        <ChartCard metric="priceUsd" data={data} period={period} wide />
        <ChartCard metric="tvlUsd" data={data} period={period} />
        <ChartCard metric="volumeUsd" data={data} period={period} />
      </div>
      <p className="history-provenance">Price and volume use stored CoinGecko observations (token-level); TVL uses curated DeFiLlama protocol-level history. The period selects a requested window ending now; charts show only the observations actually stored in it, and changes compare the first and last of those observations over the span shown.</p>
    </section>
  );
}
