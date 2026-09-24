begin;

-- Canonical network names used by the normalized application model.
create table public.chains (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Canonical token identity. A ticker is intentionally not unique.
create table public.tokens (
  id text primary key,
  name text not null,
  symbol text not null,
  chain_id text not null references public.chains(id) on update cascade on delete restrict,
  contract_address text,
  is_native boolean not null default false,
  category text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chain_id),
  check (not is_native or contract_address is null)
);

-- Contract identities are chain-scoped and case-insensitive. Native assets
-- have their own chain-scoped identity; symbols never determine identity.
create unique index tokens_chain_contract_identity_idx
  on public.tokens (chain_id, lower(btrim(contract_address)))
  where contract_address is not null;
create unique index tokens_one_native_asset_per_chain_idx
  on public.tokens (chain_id)
  where is_native;

create table public.data_providers (
  id text primary key,
  name text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- Provider identifiers vary; retain them as mappings to canonical tokens.
create table public.provider_token_mappings (
  provider_id text not null references public.data_providers(id) on delete restrict,
  chain_id text not null references public.chains(id) on update cascade on delete restrict,
  token_id text not null,
  external_asset_id text not null,
  external_contract_address text,
  created_at timestamptz not null default now(),
  primary key (provider_id, chain_id, external_asset_id),
  unique (provider_id, token_id),
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete cascade
);

-- One normalized metric catalog handles market, supply, and fundamentals.
create table public.metric_definitions (
  id text primary key,
  name text not null,
  domain text not null check (domain in ('market', 'supply', 'fundamental')),
  unit text not null check (unit in ('USD', 'token', 'percent')),
  description text not null
);

-- Original provider responses are kept separate from normalized observations.
create table public.raw_provider_records (
  id bigint generated always as identity primary key,
  provider_id text not null references public.data_providers(id) on delete restrict,
  chain_id text references public.chains(id) on update cascade on delete set null,
  token_id text,
  external_asset_id text,
  collected_at timestamptz not null default now(),
  endpoint_label text,
  response_status text not null check (response_status in ('success', 'partial', 'failed')),
  payload jsonb,
  check (
    (response_status in ('success', 'partial') and payload is not null)
    or response_status = 'failed'
  ),
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete set null
);

-- Each row is one point in a token metric time series, with source and timing.
create table public.token_metric_observations (
  id bigint generated always as identity primary key,
  token_id text not null,
  chain_id text not null,
  metric_id text not null references public.metric_definitions(id) on update cascade on delete restrict,
  provider_id text not null references public.data_providers(id) on delete restrict,
  raw_record_id bigint references public.raw_provider_records(id) on delete set null,
  value numeric,
  window_days smallint check (window_days is null or window_days > 0),
  status text not null check (status in ('available', 'unavailable', 'estimated', 'stale', 'invalid')),
  observed_at timestamptz not null,
  collected_at timestamptz not null default now(),
  source_field text,
  note text,
  created_at timestamptz not null default now(),
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete cascade,
  check (
    (status in ('available', 'estimated', 'stale') and value is not null)
    or (status in ('unavailable', 'invalid') and value is null)
  )
);

create index token_metric_history_lookup_idx
  on public.token_metric_observations (token_id, metric_id, observed_at desc);
create index chain_metric_history_lookup_idx
  on public.token_metric_observations (chain_id, metric_id, observed_at desc);
create index provider_metric_history_lookup_idx
  on public.token_metric_observations (provider_id, metric_id, observed_at desc);
create index raw_provider_collection_lookup_idx
  on public.raw_provider_records (provider_id, collected_at desc);

insert into public.data_providers (id, name) values
  ('demo', 'Katana demo data'),
  ('coingecko', 'CoinGecko'),
  ('defillama', 'DeFiLlama'),
  ('dexscreener', 'DEX Screener'),
  ('manual', 'Manual curation');

insert into public.metric_definitions (id, name, domain, unit, description) values
  ('price_usd', 'Price', 'market', 'USD', 'Token price in US dollars.'),
  ('market_cap_usd', 'Market capitalization', 'market', 'USD', 'Market capitalization in US dollars.'),
  ('volume_24h_usd', '24-hour volume', 'market', 'USD', 'Rolling 24-hour trading volume in US dollars.'),
  ('circulating_supply', 'Circulating supply', 'supply', 'token', 'Circulating token supply.'),
  ('total_supply', 'Total supply', 'supply', 'token', 'Total token supply.'),
  ('maximum_supply', 'Maximum supply', 'supply', 'token', 'Maximum token supply, when defined.'),
  ('tvl_usd', 'Total value locked', 'fundamental', 'USD', 'Protocol TVL in US dollars.'),
  ('tvl_change_pct', 'TVL change', 'fundamental', 'percent', 'TVL percentage change for the source-reported period.'),
  ('fees_24h_usd', '24-hour fees', 'fundamental', 'USD', 'Fees for the source-reported 24-hour period.'),
  ('revenue_24h_usd', '24-hour revenue', 'fundamental', 'USD', 'Revenue for the source-reported 24-hour period.'),
  ('revenue_change_pct', 'Revenue change', 'fundamental', 'percent', 'Revenue percentage change for the source-reported period.');

-- Private until a later phase adds deliberate access policies. The backend
-- secret key bypasses RLS and must only be used by server-side code.
alter table public.chains enable row level security;
alter table public.tokens enable row level security;
alter table public.data_providers enable row level security;
alter table public.provider_token_mappings enable row level security;
alter table public.metric_definitions enable row level security;
alter table public.raw_provider_records enable row level security;
alter table public.token_metric_observations enable row level security;

revoke all on table
  public.chains,
  public.tokens,
  public.data_providers,
  public.provider_token_mappings,
  public.metric_definitions,
  public.raw_provider_records,
  public.token_metric_observations
from anon, authenticated;

grant select, insert, update, delete on table
  public.chains,
  public.tokens,
  public.data_providers,
  public.provider_token_mappings,
  public.metric_definitions,
  public.raw_provider_records,
  public.token_metric_observations
to service_role;

grant usage, select on all sequences in schema public to service_role;

commit;
