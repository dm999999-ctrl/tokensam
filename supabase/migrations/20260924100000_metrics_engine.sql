begin;

-- Deterministic calculations are stored separately from provider observations.
create table public.calculated_metric_definitions (
  id text primary key,
  name text not null,
  category text not null check (category in ('valuation', 'growth', 'market_structure', 'divergence')),
  unit text not null check (unit in ('USD', 'ratio', 'percent', 'percentage_points', 'count', 'boolean')),
  formula text not null,
  description text not null
);

create table public.calculated_metric_observations (
  id bigint generated always as identity primary key,
  token_id text not null,
  chain_id text not null,
  metric_id text not null references public.calculated_metric_definitions(id) on update cascade on delete restrict,
  metric_name text not null,
  unit text not null check (unit in ('USD', 'ratio', 'percent', 'percentage_points', 'count', 'boolean')),
  value numeric,
  status text not null check (status in ('available', 'unavailable', 'invalid')),
  formula text not null,
  calculation_version text not null,
  input_fingerprint text not null,
  source_observation_ids bigint[] not null default '{}',
  source_raw_record_ids bigint[] not null default '{}',
  provenance jsonb not null default '{}'::jsonb,
  period_start_at timestamptz,
  period_end_at timestamptz,
  calculated_at timestamptz not null default now(),
  check (
    (status = 'available' and value is not null)
    or (status in ('unavailable', 'invalid') and value is null)
  ),
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete cascade,
  unique (token_id, chain_id, metric_id, input_fingerprint)
);

create index calculated_metrics_latest_idx
  on public.calculated_metric_observations (token_id, metric_id, calculated_at desc);
create index calculated_metrics_period_idx
  on public.calculated_metric_observations (token_id, metric_id, period_end_at desc);

insert into public.calculated_metric_definitions (id, name, category, unit, formula, description) values
  ('market_cap_to_tvl', 'Market cap / TVL', 'valuation', 'ratio', 'CoinGecko market_cap_usd / DeFiLlama protocol tvl_usd', 'Market capitalization relative to the explicitly mapped protocol TVL; not a token-level valuation claim.'),
  ('fdv_to_tvl', 'FDV / TVL', 'valuation', 'ratio', 'DEX Screener primary-pair fdv_usd / DeFiLlama protocol tvl_usd', 'Fully diluted valuation relative to the explicitly mapped protocol TVL.'),
  ('market_cap_to_revenue_24h', 'Market cap / 24h protocol revenue', 'valuation', 'ratio', 'CoinGecko market_cap_usd / DeFiLlama revenue_24h_usd', 'Uses source-reported 24-hour protocol revenue; it is not annualized.'),
  ('fdv_to_revenue_24h', 'FDV / 24h protocol revenue', 'valuation', 'ratio', 'DEX Screener primary-pair fdv_usd / DeFiLlama revenue_24h_usd', 'Uses source-reported 24-hour protocol revenue; it is not annualized.'),
  ('volume_to_market_cap', 'Volume / market cap', 'valuation', 'ratio', 'CoinGecko volume_24h_usd / CoinGecko market_cap_usd', 'CoinGecko 24-hour volume relative to CoinGecko market capitalization.'),
  ('tvl_growth_pct', 'TVL growth', 'growth', 'percent', '(latest DeFiLlama tvl_usd / previous DeFiLlama tvl_usd - 1) * 100', 'Change between the latest two distinct available TVL observation times.'),
  ('revenue_growth_pct', 'Protocol revenue growth', 'growth', 'percent', '(latest DeFiLlama revenue_24h_usd / previous DeFiLlama revenue_24h_usd - 1) * 100', 'Change between the latest two distinct revenue snapshots; protocol-level association.'),
  ('fees_growth_pct', 'Protocol fees growth', 'growth', 'percent', '(latest DeFiLlama fees_24h_usd / previous DeFiLlama fees_24h_usd - 1) * 100', 'Change between the latest two distinct fee snapshots; protocol-level association.'),
  ('price_growth_pct', 'Price growth', 'growth', 'percent', '(latest CoinGecko price_usd / previous CoinGecko price_usd - 1) * 100', 'Change between the latest two distinct CoinGecko price observations.'),
  ('market_cap_growth_pct', 'Market cap growth', 'growth', 'percent', '(latest CoinGecko market_cap_usd / previous CoinGecko market_cap_usd - 1) * 100', 'Change between the latest two distinct CoinGecko market-cap observations.'),
  ('price_change_vs_tvl_growth_pct_points', 'Price change vs TVL growth', 'growth', 'percentage_points', 'price growth percent - TVL growth percent over timestamp-aligned start/end pairs', 'Percentage-point spread for comparable observation intervals; protocol-level TVL association.'),
  ('price_change_vs_revenue_growth_pct_points', 'Price change vs revenue growth', 'growth', 'percentage_points', 'price growth percent - protocol revenue growth percent over timestamp-aligned start/end pairs', 'Percentage-point spread for comparable observation intervals.'),
  ('market_cap_change_vs_tvl_growth_pct_points', 'Market-cap change vs TVL growth', 'growth', 'percentage_points', 'market-cap growth percent - TVL growth percent over timestamp-aligned start/end pairs', 'Percentage-point spread for comparable observation intervals.'),
  ('market_cap_change_vs_revenue_growth_pct_points', 'Market-cap change vs revenue growth', 'growth', 'percentage_points', 'market-cap growth percent - protocol revenue growth percent over timestamp-aligned start/end pairs', 'Percentage-point spread for comparable observation intervals.'),
  ('dex_aggregate_volume_24h_usd', 'Aggregate DEX volume (24h)', 'market_structure', 'USD', 'sum exact-address DEX pair volume.h24', 'Sum across exact chain/address-matched DEX Screener pairs.'),
  ('dex_aggregate_liquidity_usd', 'Aggregate DEX liquidity', 'market_structure', 'USD', 'sum exact-address DEX pair liquidity.usd', 'Sum across exact chain/address-matched DEX Screener pairs.'),
  ('dex_primary_pair_liquidity_usd', 'Primary-pair liquidity', 'market_structure', 'USD', 'liquidity.usd for primary exact-address base-token pair', 'Primary pair is selected by liquidity descending, then 24-hour volume descending, then pair address ascending.'),
  ('dex_primary_pair_volume_24h_usd', 'Primary-pair volume (24h)', 'market_structure', 'USD', 'volume.h24 for primary exact-address base-token pair', 'Primary pair is selected by liquidity descending, then 24-hour volume descending, then pair address ascending.'),
  ('dex_liquidity_to_market_cap_pct', 'Primary-pair liquidity / market cap', 'market_structure', 'percent', 'primary-pair liquidity / CoinGecko market_cap_usd * 100', 'Primary-pair liquidity relative to CoinGecko market capitalization.'),
  ('dex_aggregate_liquidity_to_market_cap_pct', 'Aggregate DEX liquidity / market cap', 'market_structure', 'percent', 'aggregate DEX liquidity / CoinGecko market_cap_usd * 100', 'Exact-address aggregate DEX liquidity relative to CoinGecko market capitalization.'),
  ('dex_volume_to_liquidity', 'DEX volume / liquidity', 'market_structure', 'ratio', 'aggregate exact-address DEX volume.h24 / aggregate exact-address DEX liquidity.usd', 'Aggregate 24-hour pair volume relative to aggregate pair liquidity.'),
  ('dex_buy_sell_ratio', 'DEX buy / sell transaction ratio', 'market_structure', 'ratio', 'exact-address DEX buys_24h_count / sells_24h_count', 'Aggregated buy count divided by aggregated sell count.'),
  ('divergence_price_up_tvl_down', 'Price/TVL divergence: price up, TVL down', 'divergence', 'boolean', 'price growth > 0 AND TVL growth < 0 on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.'),
  ('divergence_price_down_tvl_up', 'Price/TVL divergence: price down, TVL up', 'divergence', 'boolean', 'price growth < 0 AND TVL growth > 0 on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.'),
  ('divergence_market_cap_up_faster_tvl', 'Market-cap/TVL divergence: market cap grew faster', 'divergence', 'boolean', 'market-cap growth > TVL growth on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.'),
  ('divergence_tvl_up_faster_market_cap', 'Market-cap/TVL divergence: TVL grew faster', 'divergence', 'boolean', 'TVL growth > market-cap growth on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.'),
  ('divergence_revenue_up_market_cap_down', 'Revenue/market-cap divergence: revenue up, market cap down', 'divergence', 'boolean', 'protocol revenue growth > 0 AND market-cap growth < 0 on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.'),
  ('divergence_revenue_down_market_cap_up', 'Revenue/market-cap divergence: revenue down, market cap up', 'divergence', 'boolean', 'protocol revenue growth < 0 AND market-cap growth > 0 on aligned intervals', 'Neutral relationship flag; 1 means observed, 0 means the comparable interval was available but the condition was not observed.')
on conflict (id) do update set
  name = excluded.name,
  category = excluded.category,
  unit = excluded.unit,
  formula = excluded.formula,
  description = excluded.description;

alter table public.calculated_metric_definitions enable row level security;
alter table public.calculated_metric_observations enable row level security;
revoke all on table public.calculated_metric_definitions, public.calculated_metric_observations from anon, authenticated;
grant select, insert, update, delete on table public.calculated_metric_definitions, public.calculated_metric_observations to service_role;
grant usage, select on sequence public.calculated_metric_observations_id_seq to service_role;

commit;
