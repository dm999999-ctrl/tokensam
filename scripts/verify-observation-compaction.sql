-- Production-safe canary: no changes commit, even after success.
begin;
set local lock_timeout = '250ms';
set local statement_timeout = '20s';
set local role service_role;
do $verify$
declare ids bigint[]; original jsonb; resolved jsonb; restored jsonb; result jsonb;
begin
  select array_agg(id) into ids from (
    select id from public.token_metric_observations
    where token_id in ('bitcoin-btc','ethereum-eth','lido-ldo','bnb-chain-cake')
      and provider_id in ('coingecko','defillama')
      and observed_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
      and metadata_id is null
      and (note is not null or source_field is not null or scope is not null or provider_asset_id is not null)
    order by id limit 20 for update
  ) targets;
  if cardinality(ids) <> 20 then raise exception 'Expected 20 canary observations'; end if;
  select jsonb_agg(to_jsonb(o)-'metadata_id' order by id) into original
    from public.token_metric_observations o where id=any(ids);
  update public.observation_metadata_compaction_state
    set enabled=true,verified_release='transactional-canary-rolled-back' where id=true;
  result := public.compact_observation_metadata_batch(20,ids);
  if (result->>'compacted')::integer <> 20 then raise exception 'Unexpected canary result %',result; end if;
  select jsonb_agg(to_jsonb(o)-'metadata_id' order by id) into resolved
    from public.token_metric_observations_resolved o where id=any(ids);
  if resolved is distinct from original then raise exception 'Compacted logical rows differ'; end if;
  result := public.compact_observation_metadata_batch(20,ids);
  if (result->>'compacted')::integer <> 0 then raise exception 'Canary is not idempotent'; end if;
  if public.restore_observation_metadata(ids) <> 20 then raise exception 'Restore count mismatch'; end if;
  select jsonb_agg(to_jsonb(o)-'metadata_id' order by id) into restored
    from public.token_metric_observations o where id=any(ids);
  if restored is distinct from original then raise exception 'Restored rows differ'; end if;
  raise notice 'PASS 20 real observations: service-role packing, exact row parity, idempotence and restoration';
end;
$verify$;
rollback;
