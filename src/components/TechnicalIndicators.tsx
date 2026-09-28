import type { TechnicalIndicator, TechnicalIndicatorGroup, TechnicalIndicatorsView } from "@/types/technical-indicators";
import { formatParameters, formatReading, readingTone } from "@/lib/ui/indicator-format";
import { formatUtc } from "@/lib/ui/format";
import { datasetLabel } from "@/lib/ui/data-language";

/**
 * One indicator: name, values, neutral state and a one-line summary up front;
 * the full description, window, formula, parameters and provenance sit in a
 * collapsed "Method & data" disclosure. Every registered indicator renders a
 * card — unavailable ones explain why instead of showing readings, and stale
 * ones show their true (older) date rather than being hidden or backdated.
 */
export function IndicatorCard({ indicator }: { indicator: TechnicalIndicator }) {
  const { provenance } = indicator;
  if (indicator.status === "unavailable" || !provenance) {
    return (
      <article className="indicator-card indicator-unavailable" aria-labelledby={`indicator-${indicator.id}`}>
        <header className="indicator-head">
          <strong id={`indicator-${indicator.id}`}>{indicator.name}</strong>
        </header>
        <p className="indicator-state">Data unavailable</p>
        <p className="indicator-desc">{indicator.detail}</p>
        <details className="indicator-method">
          <summary>Method &amp; data</summary>
          <p>{indicator.description}</p>
          <p>Window: {indicator.periodLabel}</p>
          <p>{indicator.formula}</p>
          {Object.keys(indicator.parameters).length > 0 ? <p>Parameters: {formatParameters(indicator.parameters)}</p> : null}
        </details>
      </article>
    );
  }
  const datasets = [...new Set(provenance.providers.map((provider) => datasetLabel(provider, "Market data")))].join(" + ");
  const start = formatUtc(provenance.observationStart, false), end = formatUtc(provenance.observationEnd, false);
  const readings = indicator.readings
    .map((reading) => ({ reading, text: formatReading(reading), tone: readingTone(reading) }))
    .filter((item): item is { reading: typeof item.reading; text: string; tone: typeof item.tone } => item.text !== null);
  const stale = indicator.status === "stale";
  return (
    <article className={`indicator-card${stale ? " indicator-stale" : ""}`} aria-labelledby={`indicator-${indicator.id}`}>
      <header className="indicator-head">
        <strong id={`indicator-${indicator.id}`}>{indicator.name}</strong>
      </header>
      <dl className="indicator-readings">
        {readings.map(({ reading, text, tone }) => (
          <div key={reading.label}>
            <dt>{reading.label}</dt>
            <dd className={`tone-${tone}`}>{text}{reading.at ? <small>{formatUtc(reading.at, false)}</small> : null}</dd>
          </div>
        ))}
      </dl>
      {indicator.state ? <p className="indicator-state">{indicator.state}</p> : null}
      <p className="indicator-desc">{indicator.summary} <span className="indicator-asof">{stale ? "Stale — most recent usable data as of" : "As of"} {end}.</span></p>
      <details className="indicator-method">
        <summary>Method &amp; data</summary>
        <p>{indicator.description}</p>
        <p>Window: {indicator.periodLabel}</p>
        <p>{indicator.formula}</p>
        {Object.keys(indicator.parameters).length > 0 ? <p>Parameters: {formatParameters(indicator.parameters)}</p> : null}
        <p>{datasets} · {provenance.observationCount} observations · daily samples {start === end ? start : `${start} → ${end}`}</p>
        <p>Latest observation used: {formatUtc(provenance.observationEnd)} · calculated {formatUtc(provenance.calculatedAt)}</p>
      </details>
    </article>
  );
}

/**
 * Technical indicators for one token: a persistent section. Every registered
 * indicator is shown, calculated or not — data availability changes a card's
 * own state, never whether it (or the section) appears.
 */
export function TechnicalIndicators({ view, groups }: { view: TechnicalIndicatorsView | null | undefined; groups: TechnicalIndicatorGroup[] }) {
  return (
    <>
      <p className="scope-line">Calculated from daily closes, using the most recent usable run of history; each card explains its state when data is stale or unavailable. Analytical measurements, not trading signals.</p>
      {groups.map((group) => (
        <div key={group.category} className="indicator-group">
          <h3>{group.label}<small>{group.indicators.length}</small></h3>
          <div className="indicator-grid">
            {group.indicators.map((indicator) => <IndicatorCard key={indicator.id} indicator={indicator} />)}
          </div>
        </div>
      ))}
      {view ? (
        <details className="indicator-method indicator-footnote">
          <summary>How indicators are calculated</summary>
          <p>{view.method} Calculated {formatUtc(view.calculatedAt)}.</p>
        </details>
      ) : null}
    </>
  );
}
