"use client";

import { useEffect, useState } from "react";
import { LIVE_PRICE_POLL_MS, type LivePriceResponse } from "./live-prices.ts";

/**
 * Polls the Worker's public /binance-prices route while the tab is visible.
 *
 * Deliberate behaviours:
 *
 * - Polling stops when the tab is hidden and resumes (with an immediate fetch) on
 *   return. A dashboard left open on a second monitor is the worst case for
 *   request count, and this removes it: background tabs cost nothing.
 * - A failed poll keeps the last good payload rather than clearing it, so a blip
 *   leaves the displayed price slightly stale instead of making it disappear. If
 *   failures persist the payload ages out of LIVE_PRICE_MAX_AGE_MS and
 *   applyLivePrices falls back to the server-rendered value on its own.
 * - Consecutive failures back the interval off (doubling, capped) so a broken
 *   endpoint is not hammered every 7 seconds by every open tab.
 * - The in-flight request is aborted on unmount and before each new poll, so a
 *   slow response cannot land after the component is gone or overwrite a newer one.
 *
 * Returns null until the first successful poll, which is the signal to keep using
 * the server-rendered values.
 */
export function useLivePrices(url: string | null, intervalMs: number = LIVE_PRICE_POLL_MS): LivePriceResponse | null {
  const [response, setResponse] = useState<LivePriceResponse | null>(null);

  useEffect(() => {
    if (!url) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;

    const schedule = () => {
      if (cancelled) return;
      // Back off on repeated failure: 1x, 2x, 4x, capped at 8x the base interval.
      const delay = intervalMs * Math.min(2 ** failures, 8);
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Not an error: just wait for the tab to come back (see the listener below).
        return;
      }
      controller?.abort();
      controller = new AbortController();
      try {
        const result = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        const payload = (await result.json()) as LivePriceResponse;
        if (cancelled) return;
        // Ignore a malformed body rather than feeding it to the overlay.
        if (payload && typeof payload.asOf === "string" && payload.prices && typeof payload.prices === "object") {
          failures = 0;
          setResponse(payload);
        } else {
          failures += 1;
        }
      } catch {
        // Includes the abort on unmount, which schedule() below never sees because
        // cancelled is already true by then.
        if (!cancelled) failures += 1;
      }
      schedule();
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs]);

  return response;
}
