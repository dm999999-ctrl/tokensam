import { binanceSymbols } from "../../../data/binance-token-mappings.ts";
import { getBinanceConfig } from "../../../lib/providers/binance.ts";

/**
 * Live Binance prices for the dashboard's polling.
 *
 * This lives on Vercel rather than the Cloudflare Worker because Binance rejects
 * Cloudflare Workers' egress: the Worker's requests returned HTTP 403
 * intermittently -- a different batch failing on each call, one as small as 20
 * symbols in a 385-character URL -- while the identical requests succeed from
 * other networks. So it is neither request shape nor size, and no User-Agent or
 * batching change fixes it. Vercel's egress reaches Binance without trouble,
 * which the 15-minute collector has demonstrated continuously (180/180 tokens
 * per run), so the live route uses the egress that already works. This mirrors
 * /coingecko-proxy on the Worker, which exists for the opposite reason:
 * CoinGecko rejects Vercel's range, so those calls go out through Cloudflare.
 *
 * The route reads and writes nothing. No Supabase, no persistence: it is a thin,
 * cached pass-through, and the stored history remains the collector's job.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Edge cache window. This is what keeps viewer count off the function count:
 * Vercel's CDN serves repeat polls within the window without invoking the
 * function at all, so a dashboard open in many tabs costs roughly one invocation
 * every few seconds rather than one per poll. stale-while-revalidate lets a
 * slightly old payload be served instantly while the refresh happens behind it,
 * so no viewer ever waits on Binance.
 */
const CACHE_CONTROL = "public, s-maxage=5, stale-while-revalidate=25";

/** Matches the collector's batching (see MAX_SYMBOLS_PER_REQUEST in lib/providers/binance.ts). */
const MAX_SYMBOLS_PER_REQUEST = 100;

/**
 * How long a 7-day opening price is reused.
 *
 * The 7-day change is NOT taken from Binance's reported percentage, because
 * /api/v3/ticker?windowSize=7d costs 200 request-weight per batch (capped),
 * i.e. 400 for this universe against 80 for /ticker/24hr. Fetching it on every
 * poll would be ~5,760 weight/minute against a published 6,000/minute budget --
 * 96%, with no headroom for the collector or a burst of cache misses.
 *
 * Instead only the window's OPENING price is fetched, on this slower cycle, and
 * the percentage is recomputed against the live price on every poll. The open is
 * the price seven days ago, so it barely moves within a minute, while the
 * computed percentage still reacts instantly to each price tick -- which is the
 * part that has to feel live. Verified against Binance's own figure: BTCUSDT
 * 86280.01 / 84254.00 - 1 = 2.4047%, reported 2.405.
 *
 * Cost at this cadence is ~400 weight/minute for the opens plus ~960 for the
 * 24-hour tickers: about 23% of the budget.
 */
const SEVEN_DAY_OPEN_TTL_MS = 60_000;

const SYMBOLS = Object.values(binanceSymbols);

type Ticker = { symbol?: string; lastPrice?: string; priceChangePercent?: string };
type WindowTicker = { symbol?: string; openPrice?: string };

/**
 * Module-scoped memo of the 7-day opens, deliberately not Next's Data Cache:
 * `dynamic = "force-dynamic"` opts this route out of that cache, so relying on it
 * would silently refetch every invocation and land back at 96% of the weight
 * budget. A warm serverless instance reuses this; a cold one refetches, which is
 * correct but merely costs one extra call. A failure leaves the previous opens in
 * place rather than dropping the 7-day column.
 */
let sevenDayOpens: { at: number; opens: Record<string, number> } | null = null;

async function readSevenDayOpens(baseUrl: string): Promise<Record<string, number>> {
  if (sevenDayOpens && Date.now() - sevenDayOpens.at < SEVEN_DAY_OPEN_TTL_MS) return sevenDayOpens.opens;
  try {
    const responses = await Promise.all(batches(SYMBOLS, MAX_SYMBOLS_PER_REQUEST).map(async (batch) => {
      const url = new URL(`${baseUrl}/ticker`);
      url.searchParams.set("symbols", JSON.stringify(batch));
      url.searchParams.set("windowSize", "7d");
      const result = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const payload: unknown = await result.json();
      if (!Array.isArray(payload)) throw new Error("unexpected response");
      return payload as WindowTicker[];
    }));
    const opens: Record<string, number> = {};
    for (const item of responses.flat()) {
      const open = Number(item?.openPrice);
      // A zero open would make the percentage infinite, so it is dropped like any
      // other unusable value: that token simply keeps its server-rendered 7-day change.
      if (!item?.symbol || !Number.isFinite(open) || open <= 0) continue;
      opens[item.symbol] = open;
    }
    sevenDayOpens = { at: Date.now(), opens };
    return opens;
  } catch {
    // The 7-day column is supplementary: a failure here must not fail the live price.
    return sevenDayOpens?.opens ?? {};
  }
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function GET(): Promise<Response> {
  const { baseUrl } = getBinanceConfig();
  // Started first so the (usually memoised) opens overlap the 24-hour fetch.
  const opensPromise = readSevenDayOpens(baseUrl);

  let tickers: Ticker[];
  try {
    const responses = await Promise.all(batches(SYMBOLS, MAX_SYMBOLS_PER_REQUEST).map(async (batch) => {
      const url = new URL(`${baseUrl}/ticker/24hr`);
      // Binance expects a JSON array literal for the multi-symbol form, not a comma list.
      url.searchParams.set("symbols", JSON.stringify(batch));
      const result = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
        // Next would otherwise cache this upstream response and defeat the point of the route.
        cache: "no-store",
      });
      // Never surface Binance's body; the status is all the client needs to back off.
      if (!result.ok) throw new Error(`Binance returned HTTP ${result.status}.`);
      const payload: unknown = await result.json();
      if (!Array.isArray(payload)) throw new Error("Binance returned an unexpected ticker response.");
      return payload as Ticker[];
    }));
    tickers = responses.flat();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Binance request failed.";
    // 502 with no cache header: a failure must not be cached in front of a working upstream.
    return Response.json({ error: message }, { status: 502, headers: { "cache-control": "no-store" } });
  }

  const opens = await opensPromise;
  const prices: Record<string, { p: number; c: number; c7?: number }> = {};
  for (const ticker of tickers) {
    const price = Number(ticker?.lastPrice);
    const change = Number(ticker?.priceChangePercent);
    // A non-finite field is omitted rather than sent as 0, so the client keeps the
    // server-rendered value for that token instead of showing a fabricated price.
    if (!ticker?.symbol || !Number.isFinite(price) || !Number.isFinite(change)) continue;
    const entry: { p: number; c: number; c7?: number } = { p: price, c: change };
    // Live price against Binance's own 7-day opening price. Omitted when no open is
    // held, so the row keeps CoinGecko's stored 7-day change rather than showing a
    // figure derived from a price this provider never quoted.
    const open = opens[ticker.symbol];
    if (Number.isFinite(open) && open > 0) entry.c7 = ((price / open) - 1) * 100;
    prices[ticker.symbol] = entry;
  }

  return Response.json({ asOf: new Date().toISOString(), prices }, {
    headers: { "cache-control": CACHE_CONTROL },
  });
}
