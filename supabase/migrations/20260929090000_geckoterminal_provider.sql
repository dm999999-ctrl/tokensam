-- GeckoTerminal: a new, independent on-chain DEX data provider.
--
-- Standalone GeckoTerminal Public API (https://api.geckoterminal.com/api/v2),
-- never CoinGecko's /onchain endpoints. Completely separate from the existing
-- CoinGecko integration and its quota.
--
-- No new tables are needed: provider_token_mappings, raw_provider_records,
-- token_metric_observations and provider_pairs are already provider-neutral
-- (provider_id is free text referencing data_providers), and the metrics this
-- integration populates (liquidity_usd, volume_24h_usd) already exist from
-- the DEX Screener migration. Only the provider registration and the
-- data_refresh_steps step enum need to change. Idempotent.

begin;

insert into public.data_providers (id, name, enabled)
values ('geckoterminal', 'GeckoTerminal', true)
on conflict (id) do nothing;

alter table public.data_refresh_steps drop constraint if exists data_refresh_steps_step_check;
alter table public.data_refresh_steps add constraint data_refresh_steps_step_check
  check (step in ('coingecko', 'defillama', 'dexscreener', 'defillama_coins', 'geckoterminal', 'metrics'));

commit;
