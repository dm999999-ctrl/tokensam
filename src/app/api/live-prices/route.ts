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

const SYMBOLS = Object.values(binanceSymbols);

type Ticker = { symbol?: string; lastPrice?: string; priceChangePercent?: string };

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function GET(): Promise<Response> {
  const { baseUrl } = getBinanceConfig();

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

  const prices: Record<string, { p: number; c: number }> = {};
  for (const ticker of tickers) {
    const price = Number(ticker?.lastPrice);
    const change = Number(ticker?.priceChangePercent);
    // A non-finite field is omitted rather than sent as 0, so the client keeps the
    // server-rendered value for that token instead of showing a fabricated price.
    if (!ticker?.symbol || !Number.isFinite(price) || !Number.isFinite(change)) continue;
    prices[ticker.symbol] = { p: price, c: change };
  }

  return Response.json({ asOf: new Date().toISOString(), prices }, {
    headers: { "cache-control": CACHE_CONTROL },
  });
}
