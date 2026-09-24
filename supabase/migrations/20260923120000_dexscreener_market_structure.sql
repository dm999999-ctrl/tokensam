begin;

-- Transaction counts are normalized numeric observations and need an explicit
-- count unit instead of being mislabeled as token amounts.
alter table public.metric_definitions
  drop constraint if exists metric_definitions_unit_check;
alter table public.metric_definitions
  add constraint metric_definitions_unit_check
  check (unit in ('USD', 'token', 'percent', 'count'));

insert into public.metric_definitions (id, name, domain, unit, description) values
  ('liquidity_usd', 'Pair liquidity', 'market', 'USD', 'USD liquidity of the selected DEX pair.'),
  ('fdv_usd', 'Fully diluted valuation', 'market', 'USD', 'Provider-reported fully diluted valuation.'),
  ('transactions_24h_count', '24-hour transactions', 'market', 'count', 'Sum of provider-reported buys and sells across exact-address pairs.'),
  ('buys_24h_count', '24-hour buys', 'market', 'count', 'Sum of provider-reported buys across exact-address pairs.'),
  ('sells_24h_count', '24-hour sells', 'market', 'count', 'Sum of provider-reported sells across exact-address pairs.')
on conflict (id) do update set
  name = excluded.name,
  domain = excluded.domain,
  unit = excluded.unit,
  description = excluded.description;

-- One canonical token can have many pair mappings. The original full pair
-- responses remain in raw_provider_records; this table provides indexed links.
create table public.provider_pairs (
  provider_id text not null references public.data_providers(id) on delete restrict,
  chain_id text not null references public.chains(id) on update cascade on delete restrict,
  dex_chain_id text not null,
  token_id text not null,
  token_address text not null,
  pair_address text not null,
  dex_id text,
  pair_url text,
  base_token_address text,
  quote_token_address text,
  pair_created_at timestamptz,
  last_seen_at timestamptz not null,
  raw_record_id bigint references public.raw_provider_records(id) on delete set null,
  primary key (provider_id, chain_id, token_id, pair_address),
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete cascade
);

create index provider_pairs_token_seen_idx
  on public.provider_pairs (token_id, chain_id, last_seen_at desc);
create index provider_pairs_pair_lookup_idx
  on public.provider_pairs (provider_id, chain_id, pair_address);

alter table public.provider_pairs enable row level security;
revoke all on table public.provider_pairs from anon, authenticated;
grant select, insert, update, delete on table public.provider_pairs to service_role;

commit;
