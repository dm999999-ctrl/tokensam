import type { ReactNode } from "react";
import type { RefreshStatusView } from "@/lib/refresh/freshness";
import { datasetLabel } from "@/lib/ui/data-language";

/**
 * Homepage hero, built from real text and components. The ink-wash landscape
 * is inline SVG drawn for this page (decorative, hidden from assistive tech);
 * no screenshot or raster reference is used. Every number comes from live
 * data passed in by the page; a missing value is shown as unavailable.
 */

function utcTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
}

function utcDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Ink-wash scene: brushed sun, layered ridges, a small pagoda, drifting maple leaves. */
function Landscape() {
  const leaves = [
    { x: 470, y: 96, s: 1.1, r: 18, o: 0.9 }, { x: 506, y: 132, s: 0.8, r: -24, o: 0.75 },
    { x: 446, y: 318, s: 1.2, r: 40, o: 0.85 }, { x: 488, y: 350, s: 0.9, r: -10, o: 0.7 },
    { x: 420, y: 372, s: 0.7, r: 64, o: 0.6 }, { x: 540, y: 292, s: 0.75, r: 12, o: 0.55 },
    { x: 250, y: 392, s: 0.65, r: -40, o: 0.5 },
  ];
  return (
    <svg className="hero-landscape" viewBox="0 0 760 440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="ts-sun" cx="46%" cy="42%" r="60%">
          <stop offset="0" stopColor="#d7392e" />
          <stop offset=".62" stopColor="#b1251d" />
          <stop offset="1" stopColor="#5e110e" />
        </radialGradient>
        <filter id="ts-brush" x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency=".022" numOctaves="3" seed="11" />
          <feDisplacementMap in="SourceGraphic" scale="22" />
        </filter>
        <filter id="ts-ink" x="-5%" y="-20%" width="110%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency=".012 .05" numOctaves="2" seed="4" />
          <feDisplacementMap in="SourceGraphic" scale="10" />
        </filter>
        <linearGradient id="ts-mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d0d0e" stopOpacity="0" />
          <stop offset=".55" stopColor="#0d0d0e" stopOpacity=".55" />
          <stop offset="1" stopColor="#0d0d0e" />
        </linearGradient>
        <linearGradient id="ts-ridge-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6e6862" />
          <stop offset=".45" stopColor="#34312e" />
          <stop offset="1" stopColor="#141313" />
        </linearGradient>
        <symbol id="ts-leaf" viewBox="-10 -10 20 20">
          <path d="M0-9.5 1.9-3.4 7.8-5.6 4.1-.4 8.6 4.1 1.6 2.6 0 9.5-1.6 2.6-8.6 4.1-4.1-.4-7.8-5.6-1.9-3.4Z" />
        </symbol>
      </defs>

      <circle cx="330" cy="172" r="160" fill="url(#ts-sun)" filter="url(#ts-brush)" opacity=".92" />
      <path d="M190 114c60-30 150-44 250-18" fill="none" stroke="#0d0d0e" strokeWidth="5" strokeLinecap="round" opacity=".35" filter="url(#ts-ink)" />

      <path filter="url(#ts-ink)" fill="url(#ts-ridge-far)" opacity=".78"
        d="M0 250c40-40 70-70 104-64s46 40 80 30 52-70 96-76 60 52 96 60 50-30 86-24 58 58 100 62 90-44 198-24V440H0Z" />
      <path filter="url(#ts-ink)" fill="#2a2826" opacity=".92"
        d="M0 292c52-28 96-40 140-30s70-34 118-40 70 30 108 24 54-44 104-48 72 40 118 44 92-26 172-6V440H0Z" />
      <path fill="#121111"
        d="M318 440l10-78 18-34 14-40 26-10 22 20 12 38 24 34 30 70Z" />
      <g fill="#0b0b0b" transform="translate(-170 0)">
        <rect x="552.5" y="192" width="3" height="18" />
        <polygon points="532,214 554,202 576,214 568,215 540,215" />
        <rect x="543" y="215" width="22" height="11" />
        <polygon points="526,238 554,224 582,238 572,239 536,239" />
        <rect x="540" y="239" width="28" height="12" />
        <polygon points="520,262 554,247 588,262 576,263 532,263" />
        <rect x="536" y="263" width="36" height="20" />
      </g>
      <path fill="#0f0f0f" filter="url(#ts-ink)"
        d="M0 372c80-30 150-18 214-32s120 20 196 14 130-36 206-26 104 22 144 18V440H0Z" />
      <rect x="0" y="250" width="760" height="190" fill="url(#ts-mist)" />

      <g fill="#c3322b">
        {leaves.map((leaf) => (
          <use key={`${leaf.x}-${leaf.y}`} href="#ts-leaf" width={16 * leaf.s} height={16 * leaf.s}
            x={leaf.x} y={leaf.y} opacity={leaf.o} transform={`rotate(${leaf.r} ${leaf.x + 8 * leaf.s} ${leaf.y + 8 * leaf.s})`} />
        ))}
      </g>
    </svg>
  );
}

const ICONS: Record<"assets" | "chains" | "metrics" | "updated", ReactNode> = {
  assets: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <ellipse cx="24" cy="13" rx="13" ry="5" />
      <path d="M11 13v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7M11 20v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7M11 27v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7" />
    </svg>
  ),
  chains: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M24 17 13 33M24 17l11 16M17 36h14" />
      <circle cx="24" cy="12" r="6" />
      <circle cx="11" cy="36" r="6" />
      <circle cx="37" cy="36" r="6" />
    </svg>
  ),
  metrics: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M12 8h26v32H12a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4ZM38 8a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4" />
      <path className="icon-accent" d="M17 32V24M23 32V18M29 32V21M35 32V14" />
    </svg>
  ),
  updated: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M13 6h22M13 42h22M15 6c0 9 6 12 9 18-3 6-9 9-9 18M33 6c0 9-6 12-9 18 3 6 9 9 9 18" />
      <path className="icon-accent" d="M19 14h10l-5 7ZM17 39c2-5 5-7 7-7s5 2 7 7Z" />
    </svg>
  ),
};

/**
 * One metric card: a real <dt>/<dd> pair. The label is a kicker above the
 * value (Last updated) or a caption below it; CSS order handles placement.
 */
function StatCard({ kind, value, label, detail, labelFirst = false, status }: {
  kind: keyof typeof ICONS;
  value: string;
  label: string;
  detail?: string | null;
  labelFirst?: boolean;
  status?: ReactNode;
}) {
  return (
    <div className={`hero-card hero-card-${kind}`}>
      <span className="hero-card-icon">{ICONS[kind]}</span>
      <dl className="hero-card-copy">
        <dt className={labelFirst ? "hero-card-kicker" : "hero-card-label"}>{label}{status}</dt>
        <dd className="hero-card-value">{value}</dd>
        {detail ? <dd className="hero-card-detail">{detail}</dd> : null}
      </dl>
    </div>
  );
}

export function UniverseHero({ assets, chains, metricsPerAsset, updatedAt, refreshStatus, error }: {
  assets: number;
  chains: number;
  metricsPerAsset: number;
  updatedAt: string | null;
  refreshStatus: RefreshStatusView | null;
  error: string | null;
}) {
  const live = !error;
  const stale = refreshStatus?.providers.filter((provider) => provider.state === "stale") ?? [];
  const staleNote = stale.length > 0
    ? `${stale.length} dataset${stale.length === 1 ? "" : "s"} stale: ${stale.map((provider) => datasetLabel(provider.id, provider.label)).join(", ")}`
    : "All datasets current";
  const status = updatedAt ? (
    <span className={`hero-card-status${stale.length > 0 ? " stale" : ""}`} title={staleNote}>
      <span className="visually-hidden">{staleNote}</span>
    </span>
  ) : null;

  return (
    <section className="samurai-hero" aria-labelledby="page-title">
      <Landscape />
      <div className="hero-copy">
        <p className="eyebrow hero-eyebrow">AI-powered crypto market intelligence</p>
        <h1 id="page-title" className="hero-title">
          <span>Enter the crypto</span> <span className="hero-title-accent">Samuraiverse</span>
        </h1>
        <p className="hero-lede">
          Understand crypto beyond trading prices. Cut through token fundamentals, market data, and on-chain metrics to
          uncover intelligent signal with AI.
        </p>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
      </div>
      <div className="hero-stats" aria-label="Research universe at a glance">
        <StatCard kind="assets" value={live ? String(assets) : "—"} label="Assets tracked" />
        <StatCard kind="chains" value={live ? String(chains) : "—"} label="Chains covered" />
        <StatCard kind="metrics" value={String(metricsPerAsset)} label="Metrics per asset" />
        <StatCard
          kind="updated"
          labelFirst
          status={status}
          label="Last updated"
          value={updatedAt ? `${utcTime(updatedAt)} UTC` : "Awaiting data"}
          detail={updatedAt ? utcDate(updatedAt) : null}
        />
      </div>
    </section>
  );
}
