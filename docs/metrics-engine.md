# Deterministic metrics engine (Phase 9)

The metrics engine reads only normalized CoinGecko, DeFiLlama, and DEX Screener observations already stored in Supabase, plus the latest DEX Screener raw pair records. It makes no provider/API requests, uses no AI, and does not change the dashboard or Token Profile data source. CoinMarketCap is not included.

## Data separation and provenance

Provider observations remain facts in `token_metric_observations`. Calculations are materialized separately in `calculated_metric_observations`, with definitions in `calculated_metric_definitions`. Each calculated row includes its formula, unit, status, calculation version and timestamp, observation period, source observation IDs, raw record IDs, and JSON provenance describing the inputs. An input fingerprint makes repeated runs idempotent for unchanged inputs; new provider observations produce new derived rows.

Missing inputs and insufficient history produce `status=unavailable` and `value=null`. Invalid negative inputs produce `status=invalid` and `value=null`. Division by zero is unavailable. A numeric zero remains a real observed/calculated value. Divergence checks store numeric `1` or `0` with unit `boolean` only when the required aligned observations exist; `0` means the condition was checked and not observed, while missing history remains unavailable.

## Source policy and formulas

- CoinGecko supplies price, market capitalization, and 24-hour volume.
- DeFiLlama supplies TVL, fees, and revenue. Its TVL/fee/revenue values describe the explicitly mapped protocol, not the token itself; derived market-cap-to-fundamental ratios preserve that scope in provenance. The 24-hour revenue multiples are not annualized.
- DEX Screener supplies FDV, buy/sell counts, and pair-level market-structure data. Pair data is read from the latest exact-address raw response. All exact-address pairs are retained for aggregate volume/liquidity. The primary pair is selected by preferring token-base pairs, then USD liquidity descending, 24-hour volume descending, and pair address ascending (the same deterministic policy as the adapter).

Implemented calculations cover market-cap/TVL, FDV/TVL, market-cap/revenue, FDV/revenue, CoinGecko volume/market-cap, historical TVL/revenue/fee/price/market-cap growth, four timestamp-aligned growth spreads, aggregate and primary-pair DEX volume/liquidity, primary-pair and aggregate liquidity relative to market cap, DEX volume/liquidity, buy/sell ratio, and six neutral divergence flags. No metric is inferred from ticker similarity or unavailable data.

Single-series growth uses the latest two distinct available observations and requires a nonzero earlier value. Cross-source comparisons require both start timestamps and both end timestamps to be within 24 hours, with compared interval lengths within 24 hours. If those conditions are not met, the comparison and its associated divergence checks are unavailable. This avoids presenting mismatched periods as a relationship.

## Migration and run

Apply [`20260924100000_metrics_engine.sql`](../supabase/migrations/20260924100000_metrics_engine.sql) in the Supabase SQL Editor. It creates the calculated-metric catalog and results table, enables RLS, and grants access only to the service role. The browser receives no direct access; the Token Profile reads the results server-side. The automated refresh recalculates metrics after each successful provider sync and bounds what the runner reads (latest value per metric plus a 14-day window for the compared series); see [the automated refresh guide](automated-refresh.md).

Then, from the project root, run:

```bash
pnpm metrics:calculate
```

The command reads stored provider observations and the latest DEX pair snapshots, processes every canonical database token, and upserts derived results. It prints aggregate counts only and does not display credentials or raw provider payloads. Run it again after a provider sync to materialize calculations for newly collected observations.

The metric catalog and calculation code are versioned together. When formulas or source policy change, update the calculation version and migration/catalog documentation so prior results remain interpretable.
