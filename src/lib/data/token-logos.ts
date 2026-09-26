import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";

/**
 * Token logos come from the `image` field of stored CoinGecko /coins/markets
 * payloads (no extra API call). A logo is decoration, never identity: it is
 * accepted only when the payload's own CoinGecko `id` equals the curated
 * CoinGecko ID for the canonical token, and only from CoinGecko's image CDN.
 */
export const COINGECKO_MARKETS_ENDPOINT = "GET /coins/markets";
const LOGO_HOSTS = new Set(["coin-images.coingecko.com", "assets.coingecko.com"]);

export function validatedLogoUrl(tokenId: string, payloadId: unknown, image: unknown): string | null {
  const expected = coingeckoTokenIds[tokenId];
  if (!expected || payloadId !== expected || typeof image !== "string") return null;
  try {
    const url = new URL(image);
    return url.protocol === "https:" && LOGO_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export type LogoRecord = { token_id: string | null; collected_at: string; endpoint_label: string | null; image: unknown; payload_id: unknown };

export type MarketFieldRecord = { token_id: string | null; endpoint_label: string | null; payload_id: unknown; fdv: unknown; collected_at: string };

/**
 * Token-level FDV from the latest stored /coins/markets record (no extra API
 * call). Same identity guard as logos: the payload's own CoinGecko `id` must
 * equal the curated ID. Only the latest record is used, so a stale value is
 * never carried forward; a missing or non-numeric FDV stays unavailable.
 */
export function reportedFdvFromRecords(records: MarketFieldRecord[]): Record<string, { value: number; collectedAt: string }> {
  const fdv: Record<string, { value: number; collectedAt: string }> = {};
  for (const record of records) {
    if (!record.token_id || record.endpoint_label !== COINGECKO_MARKETS_ENDPOINT) continue;
    if (record.payload_id !== coingeckoTokenIds[record.token_id]) continue;
    const value = typeof record.fdv === "number" ? record.fdv : typeof record.fdv === "string" && record.fdv.trim() !== "" ? Number(record.fdv) : NaN;
    if (Number.isFinite(value) && value >= 0) fdv[record.token_id] = { value, collectedAt: record.collected_at };
  }
  return fdv;
}

/** Newest valid logo per token from stored /coins/markets records. */
export function logosFromRecords(records: LogoRecord[]): Record<string, string> {
  const logos: Record<string, string> = {};
  const newestFirst = [...records].sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at));
  for (const record of newestFirst) {
    if (!record.token_id || logos[record.token_id] || record.endpoint_label !== COINGECKO_MARKETS_ENDPOINT) continue;
    const url = validatedLogoUrl(record.token_id, record.payload_id, record.image);
    if (url) logos[record.token_id] = url;
  }
  return logos;
}
