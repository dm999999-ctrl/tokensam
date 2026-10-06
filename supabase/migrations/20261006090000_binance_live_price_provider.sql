-- Binance as the live price provider, with CoinGecko as the fallback.
--
-- Binance supplies exactly two metrics (see src/lib/providers/binance.ts):
-- price_usd and price_change_24h_pct, both from GET /api/v3/ticker/24hr. It
-- deliberately supplies no volume, market cap, supply, or 7-day change --
-- Binance's quoteVolume is one venue's 24-hour volume rather than the
-- cross-venue total CoinGecko reports, and the rest it does not publish at
-- all -- so those metrics stay CoinGecko's and remain comparable with their
-- own stored history.
--
-- Nothing here changes CoinGecko's rows or the retention guards, which stay
-- scoped to provider_id = 'coingecko' for the 30-day granular chart window
-- (see 20261004140000_extend_price_usd_granular_window_for_risk_profile.sql).
-- That is intentional: Binance is the live value, CoinGecko remains the
-- history and chart provider, so Binance's price_usd rows are collapsed to
-- one row per day by the non-chart retention path like any other
-- non-chart observation.

-- ---- Provider registry ----
insert into public.data_providers (id, name, enabled)
values ('binance', 'Binance', true)
on conflict (id) do nothing;

-- ---- Refresh step ----
alter table public.data_refresh_steps drop constraint if exists data_refresh_steps_step_check;
alter table public.data_refresh_steps add constraint data_refresh_steps_step_check
  check (step in ('coingecko', 'binance', 'defillama', 'dexscreener', 'defillama_coins', 'metrics'));

-- ---- Shared metric definitions become provider-neutral ----
-- price_change_24h_pct is now written by both CoinGecko and Binance. Its
-- description was CoinGecko-specific, and a definition row is shared across
-- providers (token_metric_observations carries the provider, the definition
-- does not), so leaving provider wording in it would have the two collectors
-- describe the same row differently on every run. Per-observation provenance
-- lives in each observation's own note, which does name its provider.
update public.metric_definitions
set description = 'Provider-reported 24-hour price change percentage. The reporting provider is recorded per observation.'
where id = 'price_change_24h_pct';

-- Verify:
--   select id, name, enabled from public.data_providers where id = 'binance';
--   select description from public.metric_definitions where id = 'price_change_24h_pct';
