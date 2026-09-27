// Logo resolution and validation (AGENTS.md #15-#16). Preferred order:
// CoinGecko -> Binance -> an already-verified existing Token Samurai logo ->
// unavailable. Validation happens once, here, during the Phase A run — never
// per frontend render.

import { LOGO_HOSTS } from "../data/token-logos.ts";
import type { LogoSource, UniverseCandidate } from "./types.ts";

export type LogoResolution = Pick<UniverseCandidate, "logoUrl" | "logoSource" | "logoVerified" | "logoStatus" | "logoCheckedAt" | "logoFailureReason">;

function isTrustedCoinGeckoUrl(image: string | null | undefined): string | null {
  if (!image) return null;
  try {
    const url = new URL(image);
    return url.protocol === "https:" && LOGO_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Binance publishes no documented, stable public logo endpoint. Rather than
 * scrape an undocumented CDN path and risk a broken/incorrect image, this
 * fallback intentionally returns null; CoinGecko and the existing-logo
 * fallback cover the vast majority of candidates in practice.
 */
function resolveBinanceLogo(): string | null {
  return null;
}

async function verifyUrlReachable(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<"ok" | "broken" | "outage"> {
  try {
    let response = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
    }
    if (!response.ok) return "broken";
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.startsWith("image/") || contentType === "" ? "ok" : "broken";
  } catch {
    return "outage";
  }
}

export type ResolveLogoInput = {
  coinGeckoImageUrl?: string | null;
  existingLogoUrl?: string | null;
  checkedAt: string;
  fetchImpl: typeof fetch;
  /** Live-verify a non-trusted-CDN URL (the existing-logo fallback). Trusted CoinGecko CDN URLs are never re-fetched. */
  verifyExisting?: boolean;
  timeoutMs?: number;
};

export async function resolveLogo(input: ResolveLogoInput): Promise<LogoResolution> {
  const trustedCoinGecko = isTrustedCoinGeckoUrl(input.coinGeckoImageUrl);
  if (trustedCoinGecko) {
    return pass(trustedCoinGecko, "coingecko", input.checkedAt);
  }

  const binanceLogo = resolveBinanceLogo();
  if (binanceLogo) {
    return pass(binanceLogo, "binance", input.checkedAt);
  }

  if (input.existingLogoUrl) {
    if (!(input.verifyExisting ?? true)) return pass(input.existingLogoUrl, "existing", input.checkedAt, false);
    const result = await verifyUrlReachable(input.existingLogoUrl, input.fetchImpl, input.timeoutMs ?? 10_000);
    if (result === "ok") return pass(input.existingLogoUrl, "existing", input.checkedAt);
    if (result === "outage") {
      // Temporary provider failure: keep the URL, don't reject it outright (AGENTS.md #16, #25).
      return {
        logoUrl: input.existingLogoUrl,
        logoSource: "existing",
        logoVerified: false,
        logoStatus: "temporarily_unavailable",
        logoCheckedAt: input.checkedAt,
        logoFailureReason: "Logo endpoint did not respond within the timeout window.",
      };
    }
    return {
      logoUrl: null,
      logoSource: "unavailable",
      logoVerified: false,
      logoStatus: "fail",
      logoCheckedAt: input.checkedAt,
      logoFailureReason: "LOGO_UNAVAILABLE",
    };
  }

  return {
    logoUrl: null,
    logoSource: "unavailable",
    logoVerified: false,
    logoStatus: "fail",
    logoCheckedAt: input.checkedAt,
    logoFailureReason: "LOGO_UNAVAILABLE",
  };
}

function pass(url: string, source: LogoSource, checkedAt: string, verified = true): LogoResolution {
  return { logoUrl: url, logoSource: source, logoVerified: verified, logoStatus: "pass", logoCheckedAt: checkedAt, logoFailureReason: null };
}
