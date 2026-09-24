# CoinGecko collector (Phase 6)

The CoinGecko collector is an opt-in server-side job. The UI reads the stored observations server-side (see [the live data guide](live-data.md)). Nothing calls CoinGecko from the browser, and no API key is exposed through a `NEXT_PUBLIC_` variable.

## Official API details reviewed

Documentation and plan details were checked on September 23, 2026:

- The current market collector uses `GET /api/v3/coins/markets` with `vs_currency=usd`, mapped CoinGecko `ids`, and `price_change_percentage=24h,7d`. One request can include up to 250 IDs. The endpoint returns price, market cap, 24-hour volume and changes, supply fields, and provider `last_updated` where available. See the [official endpoint reference](https://docs.coingecko.com/reference/coins-markets).
- Demo requests use `https://api.coingecko.com/api/v3` and the `x-cg-demo-api-key` header. Paid Pro requests use `https://pro-api.coingecko.com/api/v3` and `x-cg-pro-api-key`. The key is sent as a server-side request header, never as a query parameter. See CoinGecko's [Demo API key guide](https://support.coingecko.com/hc/en-us/articles/21880397454233-User-Guide-How-to-sign-up-for-CoinGecko-Demo-API-and-generate-an-API-key).
- The current [pricing page](https://www.coingecko.com/en/api/pricing) lists Demo at 10,000 calls/month and 100 calls/minute, with attribution required. An older [official support article](https://support.coingecko.com/hc/en-us/articles/4538771776153-What-is-the-rate-limit-for-CoinGecko-API-public-plan) still says 30 calls/minute for a Demo key. The collector spaces batches at 2.1 seconds (under 30/minute) and handles 429 responses, taking the conservative limit while official pages disagree. The pricing page lists commercial licensing for paid Basic and higher plans. Plan details can change; the account's current plan limits and agreement govern actual use.
- CoinGecko's [API terms](https://www.coingecko.com/en/api_terms) say that stored/cached data should be refreshed at least every 24 hours, stored data should receive strong security protections, and data should be deleted if API access is terminated. The terms also require a binding user agreement and privacy policy when the product is offered outside the developer's entity.
- The [commercial licensing guide](https://support.coingecko.com/hc/en-us/articles/16760512207257-What-Are-the-Differences-Between-Commercial-and-Custom-Licenses) describes a paid-plan Standard Commercial License and requires prominent `Data provided by CoinGecko` attribution with a direct link to CoinGecko's API page. Demo access is suitable for development/testing with attribution, not a commercial customer-facing launch. Obtain a paid commercial or custom license before exposing CoinGecko data in the commercial product.

These notes summarize published documentation, not legal advice. Re-check plan terms before launch or a material change in data use.

## Collected fields and normalized storage

`pnpm coingecko:sync` requests one batched market response for the explicit provider ID mappings in `src/data/coingecko-token-mappings.ts`. It does not look up tokens by ticker. Canonical records use the internal token ID together with a chain ID; the provider-specific CoinGecko ID is stored in `provider_token_mappings`.

For each returned asset, the collector writes:

- the provider response item and collection metadata to `raw_provider_records`;
- normalized price, market capitalization, 24-hour volume, 24-hour and 7-day price change, circulating supply, total supply, and maximum supply to `token_metric_observations`;
- provider and canonical identity links to `data_providers`, `chains`, `tokens`, and `provider_token_mappings`;
- the two percentage-change metric definitions to `metric_definitions`.

CoinGecko does not provide protocol TVL, fees, or revenue from the endpoint used here. Those fields remain demo-only/unavailable. Null provider values are recorded as `status=unavailable` with a null value, never as zero. `observed_at` uses CoinGecko's `last_updated`; collection time is recorded separately. Re-running a response does not append duplicate normalized observations for the same token, metric, observation time, and comparison window.

## Run locally

Add a CoinGecko key to the ignored project-root `.env.local` file yourself. Do not paste it into chat or commit it:

```env
COINGECKO_API_KEY=your-key
COINGECKO_API_PLAN=demo
```

Use `COINGECKO_API_PLAN=pro` with a paid Pro API key. The plan defaults to `demo` if omitted. Then run:

```bash
pnpm coingecko:sync
```

This is a deliberate manual operation. It fetches from CoinGecko before making database changes, seeds/updates the provider mappings and canonical token catalog only after a successful response, and writes to Supabase using the existing server-only admin helper. It does not update the UI. Keep the API key and Supabase secret server-side.

The current mapping covers the 20 existing demo tokens. If a CoinGecko ID is unavailable or the API plan rejects a request, the collector reports the failure without printing keys. HTTP 429 and server errors receive at most two retries (three total attempts); a `Retry-After` response is honored, requests are spaced below the lower published per-minute limit, and mappings are batched at no more than 250 IDs per request. The free monthly call allowance is not automatically replenished or monitored by this local command; check the CoinGecko developer dashboard. One normal run uses one market endpoint call for this current universe.

## What is not connected

- The collector does not fetch historical chart data. `/coins/{id}/market_chart` is documented separately at the [official historical-chart endpoint reference](https://docs.coingecko.com/reference/coins-id-market-chart), and remains out of scope for this collector.
- Historical data: `pnpm backfill:coingecko` uses `/coins/{id}/market_chart` (2 calls per token) to add past price, market cap and volume points older than the newest stored observation. See [the historical data guide](historical-data.md).
- Automated scheduling runs this collector hourly through the refresh orchestrator (see [the automated refresh guide](automated-refresh.md)). Gemini and customer-facing CoinGecko attribution have not been implemented. Add the required attribution/legal disclosures before exposing it to users.
