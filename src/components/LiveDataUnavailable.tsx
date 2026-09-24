import Link from "next/link";

export function LiveDataUnavailable() {
  return (
    <main className="live-unavailable-page">
      <span className="eyebrow">LIVE DATA CONNECTION</span>
      <h1>Live data unavailable</h1>
      <p>Stored Supabase data could not be loaded. No demonstration values are being shown.</p>
      <Link className="back-link" href="/">← Back to dashboard</Link>
    </main>
  );
}
