# Database foundation

The dashboard and token profiles read this schema server-side through the service-role client; the browser never calls Supabase directly. See [the live data guide](live-data.md).

## Tables

- `chains`: canonical network identifiers and display names.
- `tokens`: canonical token identity, keyed by internal ID and chain. Symbol is not unique. Contract addresses are unique within a chain (case-insensitive); native assets use a separate chain-scoped identity.
- `data_providers`: source registry. Provider rows are disabled by default; registering a provider does not connect to it.
- `provider_token_mappings`: maps provider-specific IDs to canonical token IDs.
- `metric_definitions`: normalized metric names and units.
- `raw_provider_records`: optional original provider JSON and collection metadata.
- `token_metric_observations`: normalized timestamped values, source/provider, chain, status, observation time, collection time, and optional `window_days` for percentage changes. Price, TVL, volume, supply, fees, and revenue use the same history model.

Row Level Security is enabled on every table. There are no `anon` or `authenticated` policies or grants. The future server-only secret client uses Supabase's elevated `service_role`, which bypasses RLS; only call it from server code that controls authorization. The schema has no public read/write path.

## Mapping the existing mock records later

1. Upsert `demoTokens` from `src/data/demo-tokens.ts` into `chains` and `tokens`. Keep each existing `id` as the internal token ID; map `chain`, `name`, `symbol`, `category`, and profile description. Do not key records by `symbol`.
2. Map nullable snapshot fields to metric observations at their existing `observedAt` timestamps. Use provider `demo`, status `available` for numeric values, and status `unavailable` with a null value for missing data. A real zero remains an available numeric zero.
3. Map `demoTokenHistory` points to `price_usd`, `tvl_usd`, and `volume_24h_usd` observations. Each point's timestamp becomes `observed_at`; the import time becomes `collected_at`.
4. Map supply and profile changes to the catalog keys `circulating_supply`, `total_supply`, `maximum_supply`, `tvl_change_pct`, and `revenue_change_pct`. Set `window_days` for percentage changes when the source defines a comparison window. Map fees and revenue snapshots to `fees_24h_usd` and `revenue_24h_usd`.
5. When a provider is added later, keep its original response in `raw_provider_records`, map its asset ID in `provider_token_mappings`, and write converted values in `token_metric_observations` with the raw record reference. Do not put provider-specific payload fields in the normalized tables.

The Phase 5 foundation did not seed the current mocks, create a Supabase project, or contact any provider. The optional Phase 6 CoinGecko collector and its current data/licensing limits are documented in [the CoinGecko integration guide](coingecko-integration.md).

## Connecting a Supabase project

When you are ready to create the remote database:

1. Create a Supabase project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. In that project's **SQL Editor**, create a new query, paste the contents of `supabase/migrations/20260923000000_database_foundation.sql`, and run it. This applies the schema and registers metric/provider names, but it does not insert token data or enable any provider.
3. In **Project Settings → API Keys**, copy the project URL and create/copy a **secret key**. Put them in the ignored root `.env.local` file as `SUPABASE_URL=...` and `SUPABASE_SECRET_KEY=...`. Do not prefix the secret with `NEXT_PUBLIC_`, commit it, or paste it into chat. `.env.example` contains the names only.
4. Restart the development server after adding `.env.local`. The current UI still does not query Supabase; the server client is available for a later phase.

Running SQL directly in the Dashboard does not register this file in Supabase CLI migration history. Keep the migration file as the schema source of truth; before adopting CLI deployment later, capture the remote schema with Supabase's migration workflow.
