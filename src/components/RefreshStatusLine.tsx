import type { RefreshStatusView } from "@/lib/refresh/freshness";

function utc(value: string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

/** Compact per-provider freshness; ages are computed on the server for this request. */
export function RefreshStatusLine({ status }: { status: RefreshStatusView | null }) {
  if (!status) return null;
  return (
    <div className="refresh-status" aria-label="Provider data freshness">
      {status.providers.map((provider) => (
        <span
          key={provider.id}
          className={`refresh-provider ${provider.state}`}
          title={provider.refreshedAt ? `${provider.label} last refreshed ${utc(provider.refreshedAt)} UTC` : `${provider.label} data has not been collected`}
        >
          <span className="refresh-dot" aria-hidden="true" />
          {provider.label}: {provider.state === "unavailable" ? "not collected" : provider.ageLabel}
          {provider.state === "stale" ? <b> · stale</b> : null}
        </span>
      ))}
    </div>
  );
}
