import type { RefreshStatusView } from "@/lib/refresh/freshness";
import { formatUtc } from "@/lib/ui/format";
import { datasetLabel } from "@/lib/ui/data-language";

/** Freshness per dataset (named by what it covers, not by provider); ages are computed on the server for this request. */
export function RefreshStatusList({ status }: { status: RefreshStatusView | null }) {
  if (!status) return <p className="muted-copy">Data freshness is unavailable.</p>;
  return (
    <ul className="freshness-list" aria-label="Data freshness">
      {status.providers.map((provider) => (
        <li key={provider.id} className={`freshness-row ${provider.state}`}>
          <span className="freshness-dot" aria-hidden="true" />
          <span className="freshness-label">{datasetLabel(provider.id, provider.label)}</span>
          <span className="freshness-age" title={provider.refreshedAt ? formatUtc(provider.refreshedAt) ?? undefined : undefined}>
            {provider.state === "unavailable" ? "Not collected" : provider.ageLabel}
            {provider.state === "stale" ? <b> · stale</b> : null}
          </span>
        </li>
      ))}
      {status.metricsCalculatedAt ? (
        <li className="freshness-row current">
          <span className="freshness-dot" aria-hidden="true" />
          <span className="freshness-label">Calculated metrics</span>
          <span className="freshness-age">{formatUtc(status.metricsCalculatedAt)}</span>
        </li>
      ) : null}
    </ul>
  );
}

/** One concise data-status line; per-dataset freshness sits in a disclosure popover. */
export function DataStatus({ status, updatedAt }: { status: RefreshStatusView | null; updatedAt: string | null }) {
  const stale = status?.providers.filter((provider) => provider.state === "stale").length ?? 0;
  const current = status?.providers.filter((provider) => provider.state === "current").length ?? 0;
  const summary = stale > 0 ? `${stale} dataset${stale === 1 ? "" : "s"} stale` : `${current} dataset${current === 1 ? "" : "s"} current`;
  return (
    <details className="data-status">
      <summary>
        <span className={`status-dot${stale > 0 ? " stale" : ""}`} aria-hidden="true" />
        <span>{updatedAt ? <>Data as of <b>{formatUtc(updatedAt)}</b></> : "No stored observations yet"}</span>
        {status ? <span className="data-status-meta">· {summary}</span> : null}
      </summary>
      <div className="data-status-popover">
        <p className="popover-title">Data freshness</p>
        <RefreshStatusList status={status} />
        <p className="popover-note">Values are the latest stored observations; collection times differ by dataset.</p>
      </div>
    </details>
  );
}
