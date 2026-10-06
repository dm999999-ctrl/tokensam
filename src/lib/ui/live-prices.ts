import { binanceSymbols } from "../../data/binance-token-mappings.ts";
import type { DashboardToken } from "../../types/token.ts";

/**
 * Client-side live prices.
 *
 * The dashboard is server-rendered with the stored Binance-preferred price (see
 * livePriceRow in src/lib/data/live-data.ts), which is at most one refresh cycle
 * old. This layer only makes the two live-able numbers -- price and 24h change --
 * keep moving between renders, by polling the Worker's public /binance-prices
 * route. It writes nothing: no Supabase, no provider calls from the browser, and
 * no persistence of any kind. Stored history stays the collector's job.
 *
 * The browser never talks to Binance directly, which is deliberate: Binance is
 * geo-blocked in some of this project's markets (Malaysia among them), so a
 * direct connection would simply fail for those viewers. The Worker sits on
 * Cloudflare's network, which is not blocked.
 */

/**
 * `p` live price, `c` Binance's reported 24-hour change, `c7` the 7-day change
 * computed server-side from `p` against Binance's own 7-day opening price (see
 * src/app/api/live-prices/route.ts). `c7` is optional: it is absent when no
 * opening price is held, and the row then keeps its stored 7-day change.
 */
export type LivePriceEntry = { p: number; c: number; c7?: number };
export type LivePriceResponse = { asOf: string; prices: Record<string, LivePriceEntry> };

/**
 * Poll interval. Binance updates a ticker about once a second, and the Worker
 * edge-caches for 5 s, so polling faster than this buys nothing but requests --
 * and request count, not Binance's rate limit, is the budget that binds here
 * (one always-open tab at this interval is ~12,000 Worker requests/day).
 */
export const LIVE_PRICE_POLL_MS = 7_000;

/**
 * A payload older than this is ignored rather than displayed.
 *
 * Guards the case where the edge keeps serving a cached response while upstream
 * has stopped updating: without it the dashboard would show a frozen price that
 * still looks live. Past this age the server-rendered value is kept instead,
 * which carries its own honest "as of" timestamp.
 */
export const LIVE_PRICE_MAX_AGE_MS = 60_000;

/** Canonical token id for each quoted Binance symbol (the inverse of binanceSymbols). */
const tokenIdBySymbol = new Map(Object.entries(binanceSymbols).map(([tokenId, symbol]) => [symbol, tokenId]));

export function tokenIdForSymbol(symbol: string): string | undefined {
  return tokenIdBySymbol.get(symbol);
}

/**
 * Overlays live prices onto the server-rendered rows.
 *
 * Returns the original array unchanged when there is nothing to apply, so React
 * sees a stable reference and skips re-rendering on a poll that changed nothing.
 *
 * Provenance is updated with the value: a row showing a live price says so in
 * `metricSources`, rather than keeping the attribution of the stored observation
 * it replaced. A token with no live entry keeps its server-rendered value and
 * source untouched -- the two never mix within a row.
 */
export function applyLivePrices(
  tokens: DashboardToken[],
  response: LivePriceResponse | null,
  now: number = Date.now(),
): DashboardToken[] {
  if (!response) return tokens;
  const asOf = Date.parse(response.asOf);
  if (!Number.isFinite(asOf) || now - asOf > LIVE_PRICE_MAX_AGE_MS) return tokens;

  const collectedAt = new Date(asOf).toISOString();
  let changed = false;
  const next = tokens.map((token) => {
    const symbol = binanceSymbols[token.id];
    const live = symbol ? response.prices[symbol] : undefined;
    if (!live || !Number.isFinite(live.p) || !Number.isFinite(live.c)) return token;
    // c7 is supplementary: a missing or unusable one leaves the stored 7-day change alone.
    const live7d = Number.isFinite(live.c7) ? (live.c7 as number) : null;
    // Market cap and Vol / mcap derive from the price, so price being unchanged is enough
    // to know they are unchanged too.
    if (token.priceUsd === live.p && token.change24hPct === live.c
      && (live7d === null || token.change7dPct === live7d)) return token;
    changed = true;
    const source = {
      providerId: "binance" as const,
      collectedAt,
      note: "Binance spot last trade, USDT-quoted (a USD proxy, not USD), polled live in the browser. Single-venue price for the fungible asset, not a cross-venue average.",
    };
    /**
     * Market cap is price x circulating supply, and supply does not move in seconds, so a
     * live price makes the stored market cap wrong until the next refresh. It is scaled by
     * the price move rather than recomputed as price x circulatingSupply: CoinGecko's own
     * market cap does not exactly equal that product (checked across 181 tokens -- 158
     * within 0.1%, worst 0.64%), so recomputing would visibly jump the figure the moment
     * polling started. Scaling is jump-free, because the ratio is 1 on the first poll, and
     * it applies only what actually changed.
     */
    const priceRatio = Number.isFinite(token.priceUsd) && (token.priceUsd as number) > 0
      ? live.p / (token.priceUsd as number)
      : null;
    const liveMarketCap = priceRatio !== null && Number.isFinite(token.marketCapUsd) && (token.marketCapUsd as number) > 0
      ? (token.marketCapUsd as number) * priceRatio
      : null;

    const sources = { ...token.metricSources, priceUsd: source, change24hPct: source };
    if (live7d !== null) {
      sources.change7dPct = {
        providerId: "binance" as const,
        collectedAt,
        note: "Binance 7-day price change: the live USDT-quoted last trade against Binance's own 7-day rolling opening price. Single-venue, and derived from those two Binance figures rather than reported as a single field.",
      };
    }
    if (liveMarketCap !== null) {
      sources.marketCapUsd = {
        providerId: "binance" as const,
        collectedAt,
        note: "Stored market cap scaled by the live Binance price move. Circulating supply is unchanged from the stored figure; only the price component is live.",
      };
    }

    // Vol / mcap is a server-calculated metric whose denominator just moved, so it must be
    // recomputed or the row would show a ratio that contradicts its own market-cap column.
    // The 24-hour volume is NOT touched: it is value actually traded over a window, which a
    // price tick does not retroactively change.
    const calculated = liveMarketCap !== null && Number.isFinite(token.volume24hUsd)
      ? { ...token.calculated, volume_to_market_cap: (token.volume24hUsd as number) / liveMarketCap }
      : token.calculated;

    return {
      ...token,
      priceUsd: live.p,
      change24hPct: live.c,
      ...(live7d !== null ? { change7dPct: live7d } : {}),
      ...(liveMarketCap !== null ? { marketCapUsd: liveMarketCap } : {}),
      calculated,
      metricSources: sources,
    };
  });
  return changed ? next : tokens;
}

/**
 * Endpoint the browser polls. Unset (or blank) means the same-origin route
 * /api/live-prices, which is where live prices are served from: Binance rejects
 * Cloudflare Workers' egress with intermittent 403s, while Vercel's reaches it
 * reliably (see src/app/api/live-prices/route.ts). Same-origin also removes the
 * CORS surface and the cross-origin round trip.
 *
 * NEXT_PUBLIC_LIVE_PRICES_URL therefore only needs setting to point somewhere
 * else; pointing it at the Cloudflare Worker is what this default replaces.
 *
 * Takes the value rather than reading process.env itself. Next.js only inlines a
 * NEXT_PUBLIC_* variable into client code where it appears literally as
 * `process.env.NEXT_PUBLIC_...`; reading it through a dynamic property lookup
 * leaves it undefined in the browser, which would silently disable live polling
 * with no error anywhere. The caller therefore passes the literal, and this stays
 * a pure function the tests can drive.
 */
export const DEFAULT_LIVE_PRICES_PATH = "/api/live-prices";

export function livePricesUrl(value: string | undefined): string | null {
  const base = value?.trim().replace(/\/+$/, "");
  return base ? base : DEFAULT_LIVE_PRICES_PATH;
}
