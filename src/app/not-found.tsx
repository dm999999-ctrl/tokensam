import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { EMBLEM, TAGLINE } from "@/components/AppShell";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="standalone-page">
      <div className="standalone-card">
        <Image className="standalone-emblem" src={EMBLEM.src} alt={`Token Samurai — ${TAGLINE}`} width={EMBLEM.width} height={EMBLEM.height} sizes="300px" quality={90} preload />
        <p className="eyebrow">Error 404</p>
        <h1>This path leads nowhere</h1>
        <div className="blade-rule" aria-hidden="true" />
        <p className="muted-copy">The page or token you requested is not part of the Token Samurai research universe.</p>
        <Link className="blade-button" href="/">
          <span className="blade-copy"><strong>Return to Research Universe</strong></span>
          <span className="blade-edge" aria-hidden="true" />
        </Link>
      </div>
    </main>
  );
}
