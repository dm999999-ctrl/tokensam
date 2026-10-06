"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardToken } from "../../types/token.ts";
import { detectPriceMoves, PRICE_FLASH_MS, type FlashDirection } from "./price-flash.ts";

/**
 * Tracks which tokens' prices just moved, and in which direction, so the dashboard
 * can light the price cell green or red for a moment.
 *
 * Deliberate behaviours:
 *
 * - A token seen for the first time never flashes. Without that, every row would
 *   light up on first paint and on every pagination or filter change, which reads
 *   as noise rather than as a price moving. The first observation only seeds the
 *   baseline.
 * - The baseline is kept in a ref keyed by token id, not derived from render, so a
 *   row scrolling out of view and back does not count as a change. It is also
 *   compared against the LAST SEEN price rather than the server-rendered one, so a
 *   token that moves repeatedly flashes on each move.
 * - Each flash has its own timer, replaced if the price moves again before it
 *   expires, so a fast mover re-lights rather than going dark mid-flash.
 * - Every timer is cleared on unmount; none can fire into a gone component.
 */
export function usePriceFlashes(
  tokens: DashboardToken[],
  durationMs: number = PRICE_FLASH_MS,
): Record<string, FlashDirection> {
  const lastSeen = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [flashes, setFlashes] = useState<Record<string, FlashDirection>>({});

  useEffect(() => {
    const started = detectPriceMoves(tokens, lastSeen.current);
    if (Object.keys(started).length === 0) return;

    setFlashes((current) => ({ ...current, ...started }));
    for (const tokenId of Object.keys(started)) {
      const existing = timers.current.get(tokenId);
      if (existing) clearTimeout(existing);
      timers.current.set(tokenId, setTimeout(() => {
        timers.current.delete(tokenId);
        setFlashes((current) => {
          if (!(tokenId in current)) return current;
          const next = { ...current };
          delete next[tokenId];
          return next;
        });
      }, durationMs));
    }
  }, [tokens, durationMs]);

  // Clear every outstanding timer on unmount, so none can fire into a gone component.
  // The ref is read inside the effect rather than during render: reading it during render
  // is a React rule violation (and would capture a map that could since have been replaced).
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return flashes;
}
