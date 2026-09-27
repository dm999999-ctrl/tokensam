// Binance exchange-metadata client (AGENTS.md #9-#11). `exchangeInfo` returns
// every Spot symbol in one response, so resolving the whole candidate pool
// costs exactly one Spot request and one Futures request, regardless of pool
// size (AGENTS.md #33). No ticker/price/tick endpoint is ever called here —
// Phase A validates market *existence and status*, never trades or ticks
// (AGENTS.md #10, #27, #30).

import { fetchJsonWithRetry, type Sleep } from "./http.ts";

export type BinanceSpotSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
};

export type BinanceFuturesSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
};

export function getBinanceConfig(env: Record<string, string | undefined> = process.env): { spotBaseUrl: string; futuresBaseUrl: string } {
  return {
    // data-api.binance.vision is Binance's public market-data mirror: same
    // /api/v3/* paths and payload shape as api.binance.com, reachable without
    // an API key, and confirmed reachable where api.binance.com is not.
    // BINANCE_SPOT_API_BASE_URL still overrides this for tests/environments
    // where api.binance.com (or another mirror) is the reachable host.
    spotBaseUrl: env.BINANCE_SPOT_API_BASE_URL?.trim() || "https://data-api.binance.vision",
    futuresBaseUrl: env.BINANCE_FUTURES_API_BASE_URL?.trim() || "https://fapi.binance.com",
  };
}

export async function fetchSpotExchangeInfo(
  config: { spotBaseUrl: string },
  options: { fetchImpl: typeof fetch; sleep: Sleep },
): Promise<BinanceSpotSymbol[]> {
  const url = new URL(`${config.spotBaseUrl}/api/v3/exchangeInfo`);
  const payload = await fetchJsonWithRetry<{ symbols: BinanceSpotSymbol[] }>(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    { ...options, label: "Binance Spot /api/v3/exchangeInfo" },
  );
  return payload.symbols ?? [];
}

export async function fetchFuturesExchangeInfo(
  config: { futuresBaseUrl: string },
  options: { fetchImpl: typeof fetch; sleep: Sleep },
): Promise<BinanceFuturesSymbol[]> {
  const url = new URL(`${config.futuresBaseUrl}/fapi/v1/exchangeInfo`);
  const payload = await fetchJsonWithRetry<{ symbols: BinanceFuturesSymbol[] }>(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    { ...options, label: "Binance Futures /fapi/v1/exchangeInfo" },
  );
  return payload.symbols ?? [];
}

export function isSpotTradable(entry: BinanceSpotSymbol): boolean {
  if (entry.status !== "TRADING") return false;
  if (entry.isSpotTradingAllowed === false) return false;
  if (entry.permissions && entry.permissions.length > 0 && !entry.permissions.includes("SPOT")) return false;
  return true;
}

export type BinanceMarketSnapshot = {
  spotByBaseAsset: Map<string, BinanceSpotSymbol[]>;
  futuresBaseAssets: Set<string>;
  btcUsdtTradable: boolean;
  ethUsdtTradable: boolean;
};

/** Build the lookup structures once per run from the two exchangeInfo responses. */
export function buildMarketSnapshot(spotSymbols: BinanceSpotSymbol[], futuresSymbols: BinanceFuturesSymbol[]): BinanceMarketSnapshot {
  const spotByBaseAsset = new Map<string, BinanceSpotSymbol[]>();
  for (const entry of spotSymbols) {
    const group = spotByBaseAsset.get(entry.baseAsset);
    if (group) group.push(entry);
    else spotByBaseAsset.set(entry.baseAsset, [entry]);
  }
  const btcUsdt = spotSymbols.find((entry) => entry.symbol === "BTCUSDT");
  const ethUsdt = spotSymbols.find((entry) => entry.symbol === "ETHUSDT");
  return {
    spotByBaseAsset,
    futuresBaseAssets: new Set(futuresSymbols.map((entry) => entry.baseAsset)),
    btcUsdtTradable: Boolean(btcUsdt && isSpotTradable(btcUsdt)),
    ethUsdtTradable: Boolean(ethUsdt && isSpotTradable(ethUsdt)),
  };
}
