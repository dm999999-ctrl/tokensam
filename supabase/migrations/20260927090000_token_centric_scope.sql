-- Token-centric provider scope and identity (additive; safe to re-run).
--
-- 1. Every observation records its economic scope (token / protocol / chain /
--    market), the provider identifier used, and the provider mapping row.
-- 2. Provider mappings record their scope and how they were verified.
-- 3. Rows collected under the retired wrapped-asset "proxy" DEX mappings
--    (WETH->ETH, wSOL->SOL, WBNB->BNB, WAVAX->AVAX) are EXCLUDED, not deleted:
--    they stay auditable but are never read as the native token's data.
-- 4. Registers DeFiLlama's token-level coins API as its own provider and
--    refresh step, separate from DeFiLlama protocol data.

-- ---- Observations: scope, provider identifier, mapping, exclusion ----
alter table public.token_metric_observations
  add column if not exists scope text check (scope in ('token', 'protocol', 'chain', 'market')),
  add column if not exists provider_asset_id text,
  add column if not exists mapping_id bigint,
  add column if not exists excluded_reason text;

update public.token_metric_observations set scope = case provider_id
    when 'coingecko' then 'token'
    when 'defillama' then 'protocol'
    when 'dexscreener' then 'market'
  end
where scope is null and provider_id in ('coingecko', 'defillama', 'dexscreener');

update public.token_metric_observations as observation
set provider_asset_id = raw.external_asset_id
from public.raw_provider_records as raw
where observation.raw_record_id = raw.id and observation.provider_asset_id is null;

alter table public.raw_provider_records
  add column if not exists excluded_reason text;

-- ---- Provider mappings: stable ID, scope, verification ----
alter table public.provider_token_mappings
  add column if not exists id bigint generated always as identity,
  add column if not exists scope text check (scope in ('token', 'protocol', 'chain', 'market')),
  add column if not exists verification_method text,
  add column if not exists verified_at timestamptz,
  add column if not exists verification_evidence jsonb not null default '{}'::jsonb;

create unique index if not exists provider_token_mappings_id_idx on public.provider_token_mappings (id);

update public.provider_token_mappings set scope = case provider_id
    when 'coingecko' then 'token'
    when 'defillama' then 'protocol'
    when 'dexscreener' then 'market'
  end
where scope is null and provider_id in ('coingecko', 'defillama', 'dexscreener');

update public.token_metric_observations as observation
set mapping_id = mapping.id
from public.provider_token_mappings as mapping
where observation.mapping_id is null
  and mapping.provider_id = observation.provider_id
  and mapping.token_id = observation.token_id;

-- ---- Retire wrapped-asset proxy DEX mappings for native tokens ----
update public.token_metric_observations
set excluded_reason = 'retired_wrapped_asset_proxy_mapping'
where provider_id = 'dexscreener'
  and token_id in ('ethereum-eth', 'solana-sol', 'bnb-bnb', 'avalanche-avax')
  and excluded_reason is null;

update public.raw_provider_records
set excluded_reason = 'retired_wrapped_asset_proxy_mapping'
where provider_id = 'dexscreener'
  and token_id in ('ethereum-eth', 'solana-sol', 'bnb-bnb', 'avalanche-avax')
  and excluded_reason is null;

delete from public.provider_token_mappings
where provider_id = 'dexscreener'
  and token_id in ('ethereum-eth', 'solana-sol', 'bnb-bnb', 'avalanche-avax');

-- ---- DeFiLlama token-level coins API as a separate provider and refresh step ----
insert into public.data_providers (id, name, enabled)
values ('defillama_coins', 'DeFiLlama (token prices)', true)
on conflict (id) do nothing;

alter table public.data_refresh_steps drop constraint if exists data_refresh_steps_step_check;
alter table public.data_refresh_steps add constraint data_refresh_steps_step_check
  check (step in ('coingecko', 'defillama', 'dexscreener', 'defillama_coins', 'metrics'));

-- ---- Calculated-metric definitions: explicit source scopes and names ----
alter table public.calculated_metric_definitions
  add column if not exists source_scopes text;

update public.calculated_metric_definitions as definition
set name = updated.name, source_scopes = updated.source_scopes
from (values
  ('market_cap_to_tvl', 'Market cap / associated protocol TVL', 'token/protocol'),
  ('fdv_to_tvl', 'DEX-reported FDV / associated protocol TVL', 'market/protocol'),
  ('market_cap_to_revenue_24h', 'Market cap / associated protocol 24h revenue', 'token/protocol'),
  ('fdv_to_revenue_24h', 'DEX-reported FDV / associated protocol 24h revenue', 'market/protocol'),
  ('volume_to_market_cap', 'Volume / market cap', 'token'),
  ('tvl_growth_pct', 'Associated protocol TVL growth', 'protocol'),
  ('revenue_growth_pct', 'Associated protocol revenue growth', 'protocol'),
  ('fees_growth_pct', 'Associated protocol fees growth', 'protocol'),
  ('price_growth_pct', 'Price growth', 'token'),
  ('market_cap_growth_pct', 'Market cap growth', 'token'),
  ('price_change_vs_tvl_growth_pct_points', 'Price change vs associated protocol TVL growth', 'token/protocol'),
  ('price_change_vs_revenue_growth_pct_points', 'Price change vs associated protocol revenue growth', 'token/protocol'),
  ('market_cap_change_vs_tvl_growth_pct_points', 'Market-cap change vs associated protocol TVL growth', 'token/protocol'),
  ('market_cap_change_vs_revenue_growth_pct_points', 'Market-cap change vs associated protocol revenue growth', 'token/protocol'),
  ('dex_aggregate_volume_24h_usd', 'Aggregate DEX volume (24h)', 'market'),
  ('dex_aggregate_liquidity_usd', 'Aggregate DEX liquidity', 'market'),
  ('dex_primary_pair_liquidity_usd', 'Primary-pair liquidity', 'market'),
  ('dex_primary_pair_volume_24h_usd', 'Primary-pair volume (24h)', 'market'),
  ('dex_liquidity_to_market_cap_pct', 'Primary-pair liquidity / market cap', 'market/token'),
  ('dex_aggregate_liquidity_to_market_cap_pct', 'Aggregate DEX liquidity / market cap', 'market/token'),
  ('dex_volume_to_liquidity', 'DEX volume / liquidity', 'market'),
  ('dex_buy_sell_ratio', 'DEX buy / sell transaction ratio', 'market'),
  ('divergence_price_up_tvl_down', 'Price up, associated protocol TVL down', 'token/protocol'),
  ('divergence_price_down_tvl_up', 'Price down, associated protocol TVL up', 'token/protocol'),
  ('divergence_market_cap_up_faster_tvl', 'Market cap grew faster than associated protocol TVL', 'token/protocol'),
  ('divergence_tvl_up_faster_market_cap', 'Associated protocol TVL grew faster than market cap', 'token/protocol'),
  ('divergence_revenue_up_market_cap_down', 'Associated protocol revenue up, market cap down', 'token/protocol'),
  ('divergence_revenue_down_market_cap_up', 'Associated protocol revenue down, market cap up', 'token/protocol')
) as updated(id, name, source_scopes)
where definition.id = updated.id;

-- ---- Latest views: expose scope/provenance and ignore excluded rows ----
create or replace view public.latest_token_metric_observations
with (security_invoker = true) as
select distinct on (token_id, provider_id, metric_id)
  id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, status,
  observed_at, collected_at, source_field, note, scope, provider_asset_id, mapping_id
from public.token_metric_observations
where excluded_reason is null
order by token_id, provider_id, metric_id, observed_at desc, collected_at desc, id desc;

create or replace view public.latest_raw_provider_records
with (security_invoker = true) as
select distinct on (provider_id, token_id, chain_id)
  id, provider_id, token_id, chain_id, collected_at, endpoint_label, payload
from public.raw_provider_records
where excluded_reason is null
order by provider_id, token_id, chain_id, collected_at desc, id desc;

grant select on table public.latest_token_metric_observations, public.latest_raw_provider_records to service_role;
