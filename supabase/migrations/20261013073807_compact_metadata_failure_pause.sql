-- Roll back a failed batch and persist a paused state instead of retrying a bad row forever.
set local lock_timeout='250ms';
set local statement_timeout='30s';
alter table public.observation_metadata_compaction_state
  add column last_error_code text,
  add column last_error_at timestamptz;

-- Keep update-induced dead tuples bounded while the gradual migration runs.
-- Ordinary autovacuum reuses space; this does not schedule VACUUM FULL.
alter table public.token_metric_observations set (
  autovacuum_vacuum_scale_factor=0.01,
  autovacuum_vacuum_threshold=1000,
  autovacuum_vacuum_cost_delay=10
);

create or replace function public.compact_observation_metadata_batch(
  p_batch_size integer default 25, p_ids bigint[] default null
) returns jsonb language plpgsql set search_path = pg_catalog, public as $function$
declare
  state public.observation_metadata_compaction_state%rowtype;
  observation public.token_metric_observations%rowtype;
  shared public.observation_metadata%rowtype;
  content_key text;
  before_row jsonb;
  after_row jsonb;
  scanned integer := 0;
  packed integer := 0;
  last_id bigint;
  deferred bigint;
  batch_limit integer := least(greatest(coalesce(p_batch_size,0),0),100);
  today_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  perform set_config('lock_timeout','250ms',true);
  if not pg_try_advisory_xact_lock(hashtext('compact_observation_metadata'),1) then
    return jsonb_build_object('status','busy','scanned',0,'compacted',0);
  end if;
  select * into strict state from public.observation_metadata_compaction_state where id = true for update;
  if not state.enabled then return jsonb_build_object('status','disabled','scanned',0,'compacted',0); end if;
  if batch_limit = 0 then return jsonb_build_object('status','idle','scanned',0,'compacted',0); end if;
  if p_ids is null and now() < state.next_scan_at then
    return jsonb_build_object('status','waiting','scanned',0,'compacted',0);
  end if;
  if pg_database_size(current_database()) >= state.max_database_bytes then
    return jsonb_build_object('status','headroom_required','scanned',0,'compacted',0);
  end if;
  if p_ids is not null and cardinality(p_ids) > 100 then raise exception 'Canary at most 100 observations'; end if;
  last_id := state.scan_cursor;
  deferred := state.deferred_cursor;

  -- Scan bounded primary-key ranges, including already packed/fresh rows. This
  -- avoids a new large partial index and rescanning all packed history per batch.
  -- Current UTC-day rows are deferred and revisited after the day completes.
  for observation in
    select o.* from public.token_metric_observations o
    where (p_ids is null and o.id > state.scan_cursor) or (p_ids is not null and o.id = any(p_ids))
    order by o.id limit batch_limit for update
  loop
    scanned := scanned + 1;
    last_id := greatest(last_id,observation.id);
    if observation.metadata_id is not null then continue; end if;
    if observation.observed_at >= today_start then
      deferred := least(coalesce(deferred,observation.id-1),observation.id-1);
      continue;
    end if;
    if observation.note is null and observation.source_field is null
      and observation.scope is null and observation.provider_asset_id is null then continue; end if;

    before_row := to_jsonb(observation) - 'metadata_id';
    content_key := md5(jsonb_build_array(observation.note,observation.source_field,
      observation.scope,observation.provider_asset_id)::text);
    select * into shared from public.observation_metadata where fingerprint = content_key;
    if not found then
      insert into public.observation_metadata(fingerprint,note,source_field,scope,provider_asset_id)
      values(content_key,observation.note,observation.source_field,observation.scope,observation.provider_asset_id)
      on conflict(fingerprint) do nothing;
      select * into strict shared from public.observation_metadata where fingerprint = content_key;
    end if;
    if shared.note is distinct from observation.note or shared.source_field is distinct from observation.source_field
      or shared.scope is distinct from observation.scope or shared.provider_asset_id is distinct from observation.provider_asset_id then
      raise exception 'Metadata fingerprint collision: refusing compaction';
    end if;
    update public.token_metric_observations
    set metadata_id = shared.id, note = null, source_field = null, scope = null, provider_asset_id = null
    where id = observation.id;
    select to_jsonb(r)-'metadata_id' into strict after_row
    from public.token_metric_observations_resolved r where r.id = observation.id;
    if after_row is distinct from before_row then
      raise exception 'Observation % failed lossless compaction verification',observation.id;
    end if;
    packed := packed + 1;
  end loop;
  update public.observation_metadata_compaction_state
  set compacted_rows = compacted_rows + packed,
    scan_cursor = case when p_ids is not null then scan_cursor
      when scanned < batch_limit then coalesce(deferred,last_id) else last_id end,
    deferred_cursor = case when p_ids is not null then deferred_cursor
      when scanned < batch_limit then null else deferred end,
    next_scan_at = case when p_ids is null and scanned < batch_limit
      then today_start + interval '1 day 5 minutes' else next_scan_at end,
    updated_at = now()
  where id = true;
  return jsonb_build_object('status','ok','scanned',scanned,'compacted',packed);
exception
  when query_canceled then
    update public.observation_metadata_compaction_state
    set enabled=false,last_error_code=sqlstate,last_error_at=now(),updated_at=now() where id=true;
    return jsonb_build_object('status','paused_error','error_code',sqlstate,'scanned',0,'compacted',0);
  when others then
    update public.observation_metadata_compaction_state
    set enabled=false,last_error_code=sqlstate,last_error_at=now(),updated_at=now() where id=true;
    return jsonb_build_object('status','paused_error','error_code',sqlstate,'scanned',0,'compacted',0);
end;
$function$;
