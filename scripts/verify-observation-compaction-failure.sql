-- Inject a collision only inside a transaction that is always rolled back.
begin;
set local statement_timeout='20s';
set local lock_timeout='250ms';
set local role service_role;
do $failure$
declare chosen public.token_metric_observations%rowtype; original jsonb; result jsonb; paused boolean;
begin
  select * into strict chosen from public.token_metric_observations
  where metadata_id is null and observed_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
    and source_field is not null order by id limit 1 for update;
  original := to_jsonb(chosen);
  update public.observation_metadata_compaction_state set enabled=true,verified_release='failure-canary-rolled-back' where id=true;
  insert into public.observation_metadata(fingerprint,note,source_field,scope,provider_asset_id)
  values(md5(jsonb_build_array(chosen.note,chosen.source_field,chosen.scope,chosen.provider_asset_id)::text),
    'intentionally different canary note',chosen.source_field,chosen.scope,chosen.provider_asset_id);
  result := public.compact_observation_metadata_batch(1,array[chosen.id]);
  if result->>'status' <> 'paused_error' or result->>'error_code' <> 'P0001' then
    raise exception 'Collision did not pause safely: %',result;
  end if;
  if (select to_jsonb(o) from public.token_metric_observations o where id=chosen.id) is distinct from original then
    raise exception 'Failed batch changed the source observation';
  end if;
  select not enabled and last_error_code='P0001' into paused from public.observation_metadata_compaction_state where id=true;
  if not paused then raise exception 'Failure did not persist the paused state'; end if;
  update public.observation_metadata_compaction_state set enabled=true,max_database_bytes=1 where id=true;
  result := public.compact_observation_metadata_batch(1,array[chosen.id]);
  if result->>'status' <> 'headroom_required' then raise exception 'Headroom guard did not stop packing'; end if;
end;
$failure$;
rollback;
select 'Collision rollback, automatic pause, and headroom guard passed; all changes rolled back' as result;
