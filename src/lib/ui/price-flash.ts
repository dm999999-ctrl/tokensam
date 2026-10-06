import type { DashboardToken } from "../../types/token.ts";

export type FlashDirection = "up" | "down";

/** How long a cell stays lit after a price moves. */
export const PRICE_FLASH_MS = 1_500;

/**
 * Which tokens moved since they were last seen, and in which direction.
 *
 * Separated from the hook so the rule can be tested without a React renderer (this
 * suite has none). `lastSeen` is the caller's baseline and IS UPDATED IN PLACE: a
 * token's new price becomes the baseline for the next call, which is what makes a
 * repeatedly moving token flash on each move rather than only against its first
 * value.
 *
 * A token absent from `lastSeen` is recorded and never reported as a move, so first
 * paint, pagination and filter changes stay quiet.
 */
export function detectPriceMoves(
  tokens: DashboardToken[],
  lastSeen: Map<string, number>,
): Record<string, FlashDirection> {
  const started: Record<string, FlashDirection> = {};
  for (const token of tokens) {
    const price = token.priceUsd;
    if (price === null || price === undefined || !Number.isFinite(price)) continue;
    const previous = lastSeen.get(token.id);
    lastSeen.set(token.id, price);
    if (previous === undefined || previous === price) continue;
    started[token.id] = price > previous ? "up" : "down";
  }
  return started;
}
