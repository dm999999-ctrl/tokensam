// Shared retrying-JSON-fetch helper for Phase A provider clients. Both
// CoinGecko and Binance need the same shape of behavior (bounded retries,
// honor Retry-After, distinguish a transport/5xx/429 outage from a genuine
// 4xx rejection) so the distinction between "not found" and "provider
// unavailable" (AGENTS.md #25) is made in exactly one place.

export type Sleep = (durationMs: number) => Promise<void>;

export const defaultSleep: Sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

export class ProviderOutageError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ProviderOutageError";
    this.status = status;
  }
}

export class ProviderRejectedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderRejectedError";
    this.status = status;
  }
}

export function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallbackMs;
}

/**
 * Fetch JSON with bounded retries. Throws `ProviderOutageError` for a network
 * failure, timeout, 429, or 5xx (retryable, and the caller should record
 * `temporarily_unavailable` rather than a hard failure) and
 * `ProviderRejectedError` for any other non-2xx response (a genuine rejection,
 * e.g. 404).
 */
export async function fetchJsonWithRetry<T>(
  url: string | URL,
  init: RequestInit,
  options: { fetchImpl: typeof fetch; sleep: Sleep; maxAttempts?: number; timeoutMs?: number; label: string },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (attempt === maxAttempts) {
        throw new ProviderOutageError(`${options.label} request failed due to a network error.`, null);
      }
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw new ProviderRejectedError(`${options.label} returned HTTP ${response.status}.`, response.status);
    }
    if (attempt === maxAttempts) {
      throw new ProviderOutageError(`${options.label} returned HTTP ${response.status} after ${maxAttempts} attempts.`, response.status);
    }
    const fallbackMs = 500 * 2 ** (attempt - 1);
    await options.sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), fallbackMs) : fallbackMs);
  }

  throw new ProviderOutageError(`${options.label} exhausted its retry limit.`, null);
}
