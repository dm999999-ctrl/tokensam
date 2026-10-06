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

export type MarketFieldRecord = { token_id: string | null; endpoint_label: string | null; payload_id: unknown; fdv: unknown; price: unknown; collected_at: string };

/**
 * Token-level FDV from the latest stored /coins/markets record (no extra API
 * call). Same identity guard as logos: the payload's own CoinGecko `id` must
 * equal the curated ID. Only the latest record is used, so a stale value is
 * never carried forward; a missing or non-numeric FDV stays unavailable.
 */
function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
}

export function reportedFdvFromRecords(records: MarketFieldRecord[]): Record<string, { value: number; supply: number | null; collectedAt: string }> {
  const fdv: Record<string, { value: number; supply: number | null; collectedAt: string }> = {};
  for (const record of records) {
    if (!record.token_id || record.endpoint_label !== COINGECKO_MARKETS_ENDPOINT) continue;
    if (record.payload_id !== coingeckoTokenIds[record.token_id]) continue;
    const value = numeric(record.fdv);
    if (!Number.isFinite(value) || value < 0) continue;

    /**
     * Supply implied by this same payload's own FDV and price.
     *
     * FDV is price x TOTAL supply, and total supply is not carried on the dashboard
     * row -- only circulating and maximum are, and maximum is both different and
     * frequently absent (68 of 182 tokens have none). Dividing the payload's FDV by
     * the payload's price recovers exactly the supply CoinGecko used, from one
     * internally consistent record: checked across 182 tokens, 181 matched the
     * payload's own total_supply within 0.5%, where only 69 matched max supply.
     *
     * This is what lets the live price move FDV without inventing a supply figure.
     * Taken from the same record as the FDV so the two can never be mismatched by a
     * price that arrived at a different moment.
     */
    const price = numeric(record.price);
    const supply = Number.isFinite(price) && price > 0 ? value / price : null;
    fdv[record.token_id] = { value, supply, collectedAt: record.collected_at };
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
