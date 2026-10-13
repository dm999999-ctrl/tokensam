-- Exercise real cross-metric baseline inputs without committing any packing.
begin isolation level repeatable read;
set local statement_timeout = '20s';
set local lock_timeout = '250ms';
set local role service_role;
do $contracts$
declare ids bigint[]; before_rpc jsonb; after_rpc jsonb; outcome jsonb;
  at_time timestamptz := now();
  tokens text[] := array['bitcoin-btc','ethereum-eth','lido-ldo','bnb-chain-cake'];
  providers text[] := array['coingecko','coingecko','coingecko','defillama','defillama','defillama'];
  metrics text[] := array['price_usd','market_cap_usd','volume_24h_usd','tvl_usd','fees_24h_usd','revenue_24h_usd'];
begin
  select array_agg(o.id) into ids from public.token_metric_observations o
  where o.id in (select p.id from public.metrics_series_recent_points(tokens,providers,metrics,at_time) p
    where p.id>0 and p.observed_at < date_trunc('day',at_time at time zone 'UTC') at time zone 'UTC');
  if coalesce(cardinality(ids),0) < 6 then raise exception 'Too few real 24h baseline inputs for the contract canary'; end if;
  perform 1 from public.token_metric_observations where id=any(ids) for update;
  select jsonb_agg(to_jsonb(p)-'metadata_id' order by id) into before_rpc
    from public.metrics_series_recent_points(tokens,providers,metrics,at_time) p;
  update public.observation_metadata_compaction_state set enabled=true,verified_release='contract-canary-rolled-back' where id=true;
  outcome := public.compact_observation_metadata_batch(100,ids);
  if (outcome->>'compacted')::int <> cardinality(ids) then raise exception 'Unexpected compacted baseline count: %',outcome; end if;
  select jsonb_agg(to_jsonb(p)-'metadata_id' order by id) into after_rpc
    from public.metrics_series_recent_points(tokens,providers,metrics,at_time) p;
  if before_rpc is distinct from after_rpc then raise exception 'Cross-metric RPC contract changed after compaction'; end if;
end;
$contracts$;
rollback;
select 'Cross-metric baseline compaction contract passed and rolled back' as result;
