# DeFiLlama fundamentals collector (Phase 7)

The DeFiLlama adapter is a server-side, opt-in collector. The UI reads the stored observations server-side (see [the live data guide](live-data.md)). There is no browser request path to DeFiLlama.

## Official documentation and use limits checked

Reviewed September 23, 2026:

- The free API base is `https://api.llama.fi` and does not require authentication. The docs describe its rate limit only as “Standard”; they do not publish a numeric free-tier limit. The adapter runs requests serially, spaces them by at least 1.1 seconds, retries a bounded number of transient failures, and honors `Retry-After` on HTTP 429. Do not interpret this as a published quota or guarantee. See the [official API docs](https://api-docs.defillama.com/).
- The free API documentation lists `/protocol/{protocol}` for protocol TVL history, `/tvl/{protocol}` for current TVL, and `/overview/fees` and `/summary/fees/{protocol}` with `dataType=dailyFees` or `dailyRevenue` for fees and revenue. The API docs do not specify a universal freshness SLA, cache TTL, or a storage TTL for these endpoints. The collector records provider observation time when available and a separate collection time; fee/revenue summaries use collection time because no point timestamp is supplied with `total24h`.
- The [official pricing page](https://docs.llama.fi/pro-api) currently lists an Open/free tier with TVL, revenue/fees, and prices. Its separate API plan is $300/month or $3,000/year, with 1,000 requests/minute, 1 million calls/month and overage pricing. The $49/month Pro dashboard tier does not include API access. These are access/pricing limits, not data-reuse permission.
- The [Terms of Use](https://defillama.com/terms), effective June 24, 2025, restrict the general license to personal, non-commercial use. Clause 8 prohibits copying, harvesting, or otherwise using the data for commercial purposes without prior written consent; it also restricts republishing, mirroring, and resale without permission. No general caching/storage allowance or specific attribution format was found in the API docs/terms reviewed. Terms also prohibit removing proprietary notices. Written permission should specify API use, server-side storage, retention, derived metrics, commercial use, and customer-facing display/redistribution. A paid API plan alone should not be assumed to grant those rights; confirm data licensing with DeFiLlama.
- The docs identify protocol TVL and protocol fees/revenue, while the [data definitions](https://docs.llama.fi/analysts/data-definitions) distinguish fees paid by protocol users from revenue retained by a protocol. These are protocol-level values, not token price, token valuation, or token-holder revenue.

This is a summary of published material, not legal advice. Re-check current terms before using the source or changing the product's use.

## Commercial-use gate

Because Token Samurai is being built as a commercial product and the published terms require prior written consent for commercial data use, `pnpm defillama:sync` is disabled until that permission is obtained. Add a non-secret reference to the written agreement or permission in the ignored root `.env.local` file:

```env
DEFILLAMA_WRITTEN_PERMISSION_REFERENCE=agreement-or-approval-reference
```

Do not put the agreement contents or credentials in the repository. The collector checks this value before loading the Supabase admin client, making API calls, or writing records. It is a local operational gate, not a substitute for actual permission. There is no DeFiLlama API key in this integration. Until permission is documented and the live responses are reviewed, the sync must not be run and no DeFiLlama records are stored.

## Endpoints and data flow

The collector has two modes. Both apply the written-permission gate, run requests one at a time with at least 1.1 s between them, and fetch everything before writing to Supabase.

**Current mode** is used by the scheduled refresh and `pnpm defillama:sync`. It makes three small requests per curated protocol:

- `GET /tvl/{protocol}`: current protocol TVL as a single number.
- `GET /summary/fees/{protocol}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees`
- `GET /summary/fees/{protocol}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue`

**History mode** runs only through `pnpm backfill:defillama` and is never scheduled. It makes one request per protocol:

- `GET /protocol/{protocol}`: the full TVL history. The collector keeps dated points from the last 90 days and writes TVL only.

### Why current and history are separate (measured 2026-09-24)

`/protocol/{slug}` returns the protocol's entire history, including per-token and per-chain breakdowns. The collector uses only the `tvl` series, about 0.1 MB. The full payloads for the mapped records were much larger:

| Record | Payload size | Download time |
| --- | --- | --- |
| Curve DEX | 68.9 MB (41.5 MB is `chainTvls`) | 7–34 s (same URL, different runs) |
| Morpho Blue | 32 MB | not recorded |
| Aerodrome | 14 MB | not recorded |
| Aave | 10.5 MB | not recorded |

The two global `/overview/fees` lists added 8.5 MB, covering about 2,700 protocols. The old collector fetched all of this on every refresh, with a 20 s timeout per request. Curve's download could therefore exceed its timeout. An 11-protocol run was projected at 90–130 s against the step's 120 s budget.

Current mode transfers well under 1 MB. A read-only live run of all 11 protocols took 59.0 s with no retries:

- 35.2 s pacing;
- 23.7 s request time;
- slowest single request: 3.5 s.

`/tvl/{slug}` matched the latest point of the `/protocol` series for the same record: Curve DEX 1,307,607,081 in both; Aave 19,325,702,021 vs 19,325,702,019. Current TVL has no provider timestamp, so its observation time is the collection time, and the note says so. Dated daily history comes only from history mode.

Each run stores request telemetry in the refresh step detail: request count, retried requests, and the slowest request. A slow run can be traced to the call that caused it.

### Record identity: parent vs child

DeFiLlama has two kinds of record. A **parent** record, such as `parent#aave`, aggregates every sub-protocol DeFiLlama lists under that project. A **child** record, such as `3` for Curve DEX, is one sub-protocol.

Each mapping pins the record ID it was verified against, taken from the `id` of `/protocol/{slug}` and `/summary/fees/{slug}` on 2026-09-24. On each run, the collector checks every fees and revenue response against that ID:

- If a response comes from any other record, fees, revenue and TVL for that protocol are all marked unavailable. The response is never substituted, because the slug no longer resolves to the verified record.
- A 404 means no summary exists for this record. That metric is marked unavailable, and the run continues.

The collector never adds up child totals to build a parent figure. It also never uses a child's figure in place of a parent's, or the other way round.

The fees overview has no row for a parent record. That is why the old collector, which matched by exact slug in `/overview/fees`, always reported fees and revenue as unavailable for AAVE, UNI, PENDLE, ENA, RAY, JTO and AERO. The per-record summary returns DeFiLlama's own parent total. That total is not the same as the sum of the children in the overview. For example, on 2026-09-24:

- Aave parent 24h fees: 1,277,769;
- sum of its child rows in the overview: 1,250,979.

`total24h` is DeFiLlama's own 24-hour figure. For lumpy series it can refer to a different day than the overview does. On 2026-09-24, Ethena's parent reported $35 (the 09-23 value), while its latest daily point was $3,387,472. The stored value keeps DeFiLlama's figure as published, with `window_days = 1`.

Missing, null, non-finite or mismatched values are stored with `status = unavailable` and `value = null`. A numeric zero is stored as an available zero.

Mapping uses the exact, curated provider slug plus the verified record ID. Tickers and fuzzy name matching are never used.

| Canonical token | Slug | Record | Kind | What the data describes |
| --- | --- | --- | --- | --- |
| `aave-aave` | `aave` | `parent#aave` | parent | Every Aave version (V1–V4, Arc, Aptos, Horizon RWA) |
| `uniswap-uni` | `uniswap` | `parent#uniswap` | parent | Every Uniswap version (V1–V4, Auctions) |
| `lido-ldo` | `lido` | `182` | standalone | Lido |
| `ethereum-crv` | `curve-dex` | `3` | child | Curve DEX only (not crvUSD or LlamaLend) |
| `ethereum-comp` | `compound-v3` | `2088` | child | Compound V3 only |
| `ethereum-pendle` | `pendle` | `parent#pendle` | parent | Pendle V2 and Boros |
| `ethereum-ena` | `ethena` | `parent#ethena` | parent | Ethena USDe, USDtb and tsUSDe |
| `solana-ray` | `raydium` | `parent#raydium` | parent | Raydium AMM, Perps and LaunchLab |
| `solana-jto` | `jito` | `parent#jito` | parent | Jito Liquid Staking, Restaking, MEV Tips and DAO |
| `base-aero` | `aerodrome` | `parent#aerodrome` | parent | Aerodrome V1, Slipstream, Ignition and Aero Lite |
| `ethereum-morpho` | `morpho-blue` | `4025` | child | Morpho Blue only |

Before 2026-09-24, the labels for PENDLE, ENA, RAY, JTO and AERO named a single sub-protocol, such as "Pendle V2" or "Ethena USDe". The data had always come from the parent record. The labels now say what the data actually describes. The slugs, and therefore the stored data, did not change.

These project associations do not turn protocol TVL, fees or revenue into token-level fundamentals. Every observation is stored with `scope = protocol` and a note saying so. A token without a reviewed association gets no record.

## Persistence and UI scope

After an approved sync, the collector writes the exact protocol mapping, including its verified record ID and kind in `verification_evidence`, to `provider_token_mappings`, the raw protocol/fee/revenue records to `raw_provider_records`, and normalized TVL history plus 24-hour fee/revenue observations to `token_metric_observations`. It uses the existing `data_providers` and metric catalog; no schema migration or new dependency is needed. Provider observations preserve protocol-level scope in `note`, with endpoint, source field, observed timestamp, and collection timestamp.

CoinGecko code/data are unchanged. No DEX Screener or Gemini integration is included.

## Verification

Run the existing provider test suite, build, lint, and this command to confirm the live-use gate fails closed:

```bash
pnpm test
pnpm build
pnpm lint
pnpm defillama:sync
pnpm backfill:defillama
```

Without a written-permission reference, the last command must stop before accessing Supabase or calling DeFiLlama. The adapter tests use mocked responses and make no external requests.
