# Live data layer

The dashboard (`/`) and Token Profile (`/tokens/[id]`) are server-rendered on every request (`dynamic = "force-dynamic"`) from data stored in Supabase. Reads go through the service-role client in `src/lib/supabase/admin.ts`, which is `server-only`; the browser never receives Supabase credentials or talks to Supabase or any provider directly.

The projection logic lives in [`src/lib/data/live-data.ts`](../src/lib/data/live-data.ts).

## Sources

| UI value | Table | Provider / rule |
| --- | --- | --- |
| Price, 24h/7d change, market cap, 24h volume, supply | `token_metric_observations` | CoinGecko only |
| TVL, 24h fees, 24h revenue | `token_metric_observations` | DeFiLlama only (protocol-level association) |
| TVL · 30d | `token_metric_observations` | Computed server-side from DeFiLlama TVL observations ~30 days apart (3-day baseline tolerance) |
| Calculated metrics | `calculated_metric_observations` + `calculated_metric_definitions` | Latest row per metric; category comes from the definition |
| Historical charts | `token_metric_observations` | Last 90 days of available observations; a series needs at least two points |
| Deep AI Analysis | `token_ai_analyses` | Newest stored, validated analysis; Gemini is called only on request (see [deep-ai-analysis.md](deep-ai-analysis.md)) |
| Provider freshness line | `data_refresh_steps` + latest collection times | Per-provider "updated … ago", marked stale past that provider's threshold |

## Rules

- Each value comes from the **latest** observation for its designated provider. If that latest observation is `unavailable`, the UI shows "Data unavailable". It does not fall back to older rows or other providers.
- A true zero is shown as zero; missing data is never filled with zero.
- Every value carries its provider and collection time, shown on hover.
- If Supabase cannot be read, the dashboard shows an error banner and the profile shows a "Live data unavailable" page. The underlying error is logged server-side. No demo data is substituted.

## Bounded reads

Latest values come from the `latest_token_metric_observations` view; only the series a page needs are read over a time window (DeFiLlama TVL for ~34 days on the dashboard; 90 days of price, TVL, and volume on a profile). Before the Phase 11B migration is applied, reads fall back to the original full scan.

## Refreshing data

Refreshes are automated; see [the automated refresh guide](automated-refresh.md). To refresh manually, run `pnpm refresh`, or run the collectors and then the metrics engine:

```bash
pnpm coingecko:sync
```

```bash
pnpm defillama:sync
```

```bash
pnpm dexscreener:sync
```

```bash
pnpm geckoterminal:sync
```

```bash
pnpm metrics:calculate
```

Pages pick up new rows on the next request. GeckoTerminal (see [geckoterminal-integration.md](geckoterminal-integration.md)) is collected and stored but intentionally not read by any page yet; it is not in the sources table above.

## Legacy demo files

`src/data/demo-token-history.ts` and `src/data/demo-token-profiles.ts` are no longer used by the UI. `src/data/demo-tokens.ts` is still imported by `src/data/canonical-tokens.ts` for the base token registry.
