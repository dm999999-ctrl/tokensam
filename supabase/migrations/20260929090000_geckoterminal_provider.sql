-- GeckoTerminal provider registration.
--
-- GeckoTerminal is a separate, standalone data provider (the public
-- https://api.geckoterminal.com/api/v2 API, never CoinGecko's /onchain
-- endpoints), kept independent of the existing CoinGecko integration and its
-- free-tier quota. It supplies on-chain DEX pool data (pairs, liquidity,
-- volume, DEX identity, and contract address by network), the same shape of
-- data DEX Screener already supplies, so it reuses the existing 'market'-scope
-- metric catalog (price_usd, volume_24h_usd, liquidity_usd,
-- price_change_24h_pct, transactions_24h_count, buys_24h_count,
-- sells_24h_count, fdv_usd, market_cap_usd) and the existing provider-scoped
-- provider_pairs table added by 20260923120000_dexscreener_market_structure.sql.
-- No new metric definitions or tables are needed; only the provider identity
-- is new, since raw_provider_records, provider_token_mappings, and
-- token_metric_observations all reference data_providers(id) by foreign key.
--
-- Idempotent.

begin;

insert into public.data_providers (id, name, enabled)
values ('geckoterminal', 'GeckoTerminal', true)
on conflict (id) do nothing;

commit;

-- Verification (expected: one row):
-- select id, name, enabled from public.data_providers where id = 'geckoterminal';
