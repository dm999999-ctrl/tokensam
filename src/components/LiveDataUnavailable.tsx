import Link from "next/link";

export function LiveDataUnavailable() {
  return (
    <div className="page">
      <div className="standalone-card inline">
        <p className="eyebrow">Live data connection</p>
        <h1>Live data unavailable</h1>
        <div className="blade-rule" aria-hidden="true" />
        <p className="muted-copy">Stored Supabase data could not be loaded. No demonstration values are being shown.</p>
        <Link className="text-button" href="/">← Back to Research Universe</Link>
      </div>
    </div>
  );
}
