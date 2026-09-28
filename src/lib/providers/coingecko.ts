import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderSnapshot,
} from "./types.ts";

const PROVIDER_ID = "coingecko";
const ENDPOINT_LABEL = "GET /coins/markets";
const MAX_IDS_PER_REQUEST = 250;
const MAX_ATTEMPTS = 3;
// A legacy official support article still documents 30 RPM, while the current
// pricing page lists 100 RPM. Stay below the lower published limit.
export const MIN_REQUEST_INTERVAL_MS = 2_100;

type CoinGeckoPlan = "demo" | "pro";

type CoinGeckoMarketItem = {
  id: string;
  last_updated?: string | null;
  current_price?: number | null;
  market_cap?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
};

export class CoinGeckoApiError extends Error {
  readonly status: number | null;
  /** Retry-After from the final failing response, in ms, uncapped; null when absent or not applicable. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number | null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "CoinGeckoApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function getCoinGeckoConfig(
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; plan: CoinGeckoPlan; baseUrl: string; keyHeader: string } {
  const apiKey = env.COINGECKO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Set COINGECKO_API_KEY in the ignored root .env.local file.");
  }

  const plan = (env.COINGECKO_API_PLAN?.trim().toLowerCase() || "demo") as CoinGeckoPlan;
  if (plan !== "demo" && plan !== "pro") {
    throw new Error("COINGECKO_API_PLAN must be either demo or pro.");
  }

  return {
    apiKey,
    plan,
    baseUrl:
      plan === "pro"
        ? "https://pro-api.coingecko.com/api/v3"
        : "https://api.coingecko.com/api/v3",
    keyHeader: plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key",
  };
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

/** Raw Retry-After parse, uncapped; null when the header is absent or unparsable. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.max(dateMs, 0) : null;
}

/** Retry-After for this collector's own request pacing: same parse, capped short so a single retry wait stays bounded. */
export function retryAfterMs(value: string | null, fallbackMs: number): number {
  const parsed = parseRetryAfterMs(value);
  return parsed === null ? fallbackMs : Math.min(parsed, 30_000);
}

async function fetchMarketBatch(
  ids: string[],
  options: {
    apiKey: string;
    baseUrl: string;
    keyHeader: string;
    fetchImpl: typeof fetch;
    sleep: (durationMs: number) => Promise<void>;
  },
): Promise<CoinGeckoMarketItem[]> {
  const url = new URL(`${options.baseUrl}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("price_change_percentage", "24h,7d");
  // CoinGecko now excludes rehypothecated/wrapped assets from /coins/markets by default.
  // WBTC is a deliberate canonical asset in this universe, so request this class explicitly.
  url.searchParams.set("include_rehypothecated", "true");
  url.searchParams.set("per_page", String(MAX_IDS_PER_REQUEST));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { [options.keyHeader]: options.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new CoinGeckoApiError("CoinGecko request failed due to a network error.", null);
      }
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new CoinGeckoApiError("CoinGecko returned an unexpected market response.", response.status);
      }
      return payload as CoinGeckoMarketItem[];
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      // Avoid including request URLs or response bodies in errors and logs.
      // Exposed to the refresh orchestrator so a final 429 can size its cooldown.
      const finalRetryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) : null;
      throw new CoinGeckoApiError(
        `CoinGecko returned HTTP ${response.status}. Check the API plan, key configuration, and usage limits.`,
        response.status,
        finalRetryAfterMs,
      );
    }

    const fallbackMs = 500 * 2 ** (attempt - 1);
    await options.sleep(
      response.status === 429
        ? retryAfterMs(response.headers.get("retry-after"), fallbackMs)
        : fallbackMs,
    );
  }

  throw new CoinGeckoApiError("CoinGecko request exhausted its retry limit.", null);
}

function numericObservation(
  asset: ProviderAsset,
  metricId: string,
  rawValue: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  windowDays: number | null = null,
): NormalizedObservation {
  const available = typeof rawValue === "number" && Number.isFinite(rawValue);
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: available ? rawValue : null,
    status: available ? "available" : "unavailable",
    observedAt,
    collectedAt,
    windowDays,
    scope: "token",
    sourceField,
    note: available ? null : "CoinGecko did not return a numeric value for this field.",
  };
}

export function normalizeCoinGeckoMarketItem(
  asset: ProviderAsset,
  item: CoinGeckoMarketItem,
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const validProviderTime = item.last_updated && Number.isFinite(Date.parse(item.last_updated));
  const observedAt = validProviderTime ? new Date(item.last_updated as string).toISOString() : collectedAt;
  const observations = [
    numericObservation(asset, "price_usd", item.current_price, "current_price", observedAt, collectedAt),
    numericObservation(asset, "market_cap_usd", item.market_cap, "market_cap", observedAt, collectedAt),
    numericObservation(asset, "volume_24h_usd", item.total_volume, "total_volume", observedAt, collectedAt),
    numericObservation(
      asset,
      "price_change_24h_pct",
      item.price_change_percentage_24h,
      "price_change_percentage_24h",
      observedAt,
      collectedAt,
      1,
    ),
    numericObservation(
      asset,
      "price_change_7d_pct",
      item.price_change_percentage_7d_in_currency,
      "price_change_percentage_7d_in_currency",
      observedAt,
      collectedAt,
      7,
    ),
    numericObservation(asset, "circulating_supply", item.circulating_supply, "circulating_supply", observedAt, collectedAt),
    numericObservation(asset, "total_supply", item.total_supply, "total_supply", observedAt, collectedAt),
    numericObservation(asset, "maximum_supply", item.max_supply, "max_supply", observedAt, collectedAt),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: ENDPOINT_LABEL,
    asset,
    observedAt,
    collectedAt,
    rawPayload: item,
    observations,
  };
}

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private readonly options: {
    apiKey: string;
    baseUrl: string;
    keyHeader: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  };

  constructor(
    options: {
      apiKey: string;
      baseUrl: string;
      keyHeader: string;
      fetchImpl?: typeof fetch;
      sleep?: (durationMs: number) => Promise<void>;
      now?: () => Date;
    },
  ) {
    this.options = options;
  }

  async fetchSnapshots(assets: ProviderAsset[]): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    const now = this.options.now ?? (() => new Date());
    const uniqueAssets = [...new Map(assets.map((asset) => [asset.externalAssetId, asset])).values()];
    const batches = splitIntoBatches(uniqueAssets, MAX_IDS_PER_REQUEST);
    const snapshots: ProviderSnapshot[] = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (batchIndex > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
      const batch = batches[batchIndex];
      const records = await fetchMarketBatch(
        batch.map((asset) => asset.externalAssetId),
        { ...this.options, fetchImpl, sleep },
      );
      const assetsByExternalId = new Map(batch.map((asset) => [asset.externalAssetId, asset]));
      const collectedAt = now().toISOString();
      for (const record of records) {
        const asset = assetsByExternalId.get(record.id);
        if (asset) snapshots.push(normalizeCoinGeckoMarketItem(asset, record, collectedAt));
      }
    }

    return snapshots;
  }
}
