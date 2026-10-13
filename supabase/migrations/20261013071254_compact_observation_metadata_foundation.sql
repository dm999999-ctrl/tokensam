-- Additive rollout. Packing remains disabled until compatible readers are deployed.
set local lock_timeout = '250ms';
set local statement_timeout = '30s';

create table public.observation_metadata (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  note text,
  source_field text,
  scope text,
  provider_asset_id text
);
alter table public.observation_metadata enable row level security;
revoke all on public.observation_metadata from public, anon, authenticated;
grant select, insert on public.observation_metadata to service_role;
grant usage, select on sequence public.observation_metadata_id_seq to service_role;

alter table public.token_metric_observations
  add column metadata_id bigint,
  add constraint observation_metadata_reference foreign key (metadata_id)
    references public.observation_metadata(id) on delete restrict not valid,
  add constraint observation_metadata_is_compact check (
    metadata_id is null or (note is null and source_field is null and scope is null and provider_asset_id is null)
  ) not valid;

-- Initially empty. Required for FK checks and bounded unused-dictionary cleanup.
create index observation_metadata_reference_idx
on public.token_metric_observations(metadata_id) where metadata_id is not null;

create table public.observation_metadata_compaction_state (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  verified_release text,
  compacted_rows bigint not null default 0,
  scan_cursor bigint not null default 0,
  deferred_cursor bigint,
  next_scan_at timestamptz not null default now(),
  max_database_bytes bigint not null default 492830720,
  updated_at timestamptz not null default now(),
  check (not enabled or (verified_release is not null and length(btrim(verified_release)) >= 7))
);
insert into public.observation_metadata_compaction_state(id) values(true);
alter table public.observation_metadata_compaction_state enable row level security;
revoke all on public.observation_metadata_compaction_state from public, anon, authenticated;
grant select, update on public.observation_metadata_compaction_state to service_role;

create view public.token_metric_observations_resolved with (security_invoker = true) as
select o.id, o.token_id, o.chain_id, o.metric_id, o.provider_id, o.raw_record_id,
  o.value, o.window_days, o.status, o.observed_at, o.collected_at,
  case when o.metadata_id is null then o.source_field else m.source_field end as source_field,
  case when o.metadata_id is null then o.note else m.note end as note,
  o.created_at,
  case when o.metadata_id is null then o.scope else m.scope end as scope,
  case when o.metadata_id is null then o.provider_asset_id else m.provider_asset_id end as provider_asset_id,
  o.mapping_id, o.excluded_reason, o.metadata_id
from public.token_metric_observations o
left join public.observation_metadata m on m.id = o.metadata_id;
revoke all on public.token_metric_observations_resolved from public, anon, authenticated;
grant select on public.token_metric_observations_resolved to service_role;

-- Compacted provenance is immutable through base-column edits. Restore first;
-- otherwise an old SQL updater could replace a null physical note and lose context.
create function public.guard_compacted_observation_metadata() returns trigger
language plpgsql set search_path = pg_catalog, public as $function$
begin
  if old.metadata_id is not null and new.metadata_id is not distinct from old.metadata_id then
    raise exception 'Restore compacted observation metadata before editing provenance';
  end if;
  return new;
end;
$function$;
revoke all on function public.guard_compacted_observation_metadata() from public, anon, authenticated;
grant execute on function public.guard_compacted_observation_metadata() to service_role;
create trigger zz_guard_compacted_observation_metadata
before update of note, source_field, scope, provider_asset_id on public.token_metric_observations
for each row execute function public.guard_compacted_observation_metadata();

create function public.restore_observation_metadata(p_ids bigint[]) returns integer
language plpgsql set search_path = pg_catalog, public as $function$
declare restored integer;
begin
  if coalesce(cardinality(p_ids),0) > 100 then raise exception 'Restore at most 100 observations per batch'; end if;
  update public.token_metric_observations o
  set note = m.note, source_field = m.source_field, scope = m.scope,
      provider_asset_id = m.provider_asset_id, metadata_id = null
  from public.observation_metadata m
  where o.id = any(p_ids) and m.id = o.metadata_id;
  get diagnostics restored = row_count;
  return restored;
end;
$function$;
revoke all on function public.restore_observation_metadata(bigint[]) from public, anon, authenticated;
grant execute on function public.restore_observation_metadata(bigint[]) to service_role;

create function public.compact_observation_metadata_batch(
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
end;
$function$;
revoke all on function public.compact_observation_metadata_batch(integer,bigint[]) from public, anon, authenticated;
grant execute on function public.compact_observation_metadata_batch(integer,bigint[]) to service_role;
-- Preserve existing RPC contracts after the table gains metadata_id.
CREATE OR REPLACE FUNCTION public.label_coingecko_daily_snapshot_aggregate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if new.provider_id = 'coingecko'
    and new.metric_id in ('market_cap_usd', 'circulating_supply', 'total_supply', 'maximum_supply')
    and new.source_observation_count = 1
    and exists (
      select 1 from public.token_metric_observations_resolved o
      where o.id = any(new.source_observation_ids)
        and o.note like '%[utc-daily-snapshot-v1]%'
    ) then
    new.aggregation_method := 'daily_snapshot';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.latest_observations_bounded(p_token_ids text[], p_provider_ids text[], p_since timestamp with time zone)
 RETURNS SETOF token_metric_observations
 LANGUAGE sql
 STABLE
AS $function$
  select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
         status, observed_at, collected_at, source_field, note, created_at, scope,
         provider_asset_id, mapping_id, excluded_reason, metadata_id
  from (
    select o.*,
      row_number() over (
        partition by o.token_id, o.provider_id, o.metric_id
        order by o.observed_at desc, o.id desc
      ) as rn
    from public.token_metric_observations_resolved o
    where o.token_id = any(p_token_ids)
      and o.provider_id = any(p_provider_ids)
      and o.excluded_reason is null
      and o.observed_at >= p_since
  ) ranked
  where rn = 1;
$function$;

CREATE OR REPLACE FUNCTION public.metrics_series_recent_points(p_token_ids text[], p_providers text[], p_metrics text[], p_now timestamp with time zone, p_horizon_hours integer DEFAULT 24, p_tolerance_hours integer DEFAULT 6, p_max_lookback_days integer DEFAULT 30)
 RETURNS SETOF token_metric_observations
 LANGUAGE sql
 STABLE
AS $function$
  with series(provider_id, metric_id) as (
    select * from unnest(p_providers, p_metrics) as u(provider_id, metric_id)
  ),
  targets as (
    select t.token_id, s.provider_id, s.metric_id
    from unnest(p_token_ids) as t(token_id)
    cross join series s
  ),
  raw_recent2 as (
    select o.*
    from targets tg
    cross join lateral (
      select o.*
      from public.token_metric_observations_resolved o
      where o.token_id = tg.token_id
        and o.provider_id = tg.provider_id
        and o.metric_id = tg.metric_id
        and o.excluded_reason is null
        and o.observed_at >= p_now - (p_max_lookback_days || ' days')::interval
      order by o.observed_at desc, o.id desc
      limit 2
    ) o
  ),
  daily_rows as (
    select
      -abs(a.id) as id,
      a.token_id,
      a.chain_id,
      a.metric_id,
      a.provider_id,
      null::bigint as raw_record_id,
      a.value,
      null::smallint as window_days,
      a.status,
      case when a.aggregation_method = 'daily_snapshot'
        then a.first_source_observed_at
        else a.utc_day::timestamp at time zone 'UTC'
      end as observed_at,
      a.aggregated_at as collected_at,
      case when a.aggregation_method = 'daily_snapshot' then 'daily_snapshot' else 'daily_average' end as source_field,
      case when a.aggregation_method = 'daily_snapshot'
        then format('UTC daily point-in-time snapshot from %s source observations.', a.source_observation_count)
        else format('UTC daily arithmetic mean from %s valid values across %s provider observations.', a.valid_value_count, a.source_observation_count)
      end as note,
      a.created_at,
      case when a.provider_id = 'defillama' then 'protocol' else 'token' end as scope,
      null::text as provider_asset_id,
      null::bigint as mapping_id,
      null::text as excluded_reason
    from targets tg
    join public.token_metric_daily_aggregates a
      on a.token_id = tg.token_id
     and a.provider_id = tg.provider_id
     and a.metric_id = tg.metric_id
    where not (a.provider_id = 'defillama' and a.metric_id = 'revenue_24h_usd')
      and a.utc_day >= (p_now at time zone 'UTC')::date - p_max_lookback_days
      and a.utc_day <= (p_now at time zone 'UTC')::date
  ),
  recent_candidates as (
    select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
           status, observed_at, collected_at, source_field, note, created_at, scope,
           provider_asset_id, mapping_id, excluded_reason
    from raw_recent2
    union all
    select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
           status, observed_at, collected_at, source_field, note, created_at, scope,
           provider_asset_id, mapping_id, excluded_reason
    from daily_rows
  ),
  ranked_recent as (
    select c.*, row_number() over (
      partition by c.token_id, c.provider_id, c.metric_id
      order by c.observed_at desc, c.id desc
    ) as point_rank
    from recent_candidates c
  ),
  recent2 as (
    select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
           status, observed_at, collected_at, source_field, note, created_at, scope,
           provider_asset_id, mapping_id, excluded_reason
    from ranked_recent
    where point_rank <= 2
  ),
  anchors as (
    select token_id, provider_id, metric_id, max(observed_at) as latest_at
    from recent2
    group by token_id, provider_id, metric_id
  ),
  horizon_raw as (
    select o.*
    from anchors a
    cross join lateral (
      select o.*
      from public.token_metric_observations_resolved o
      where o.token_id = a.token_id
        and o.provider_id = a.provider_id
        and o.metric_id = a.metric_id
        and o.excluded_reason is null
        and o.observed_at between
          a.latest_at - ((p_horizon_hours + p_tolerance_hours) || ' hours')::interval
          and a.latest_at - ((p_horizon_hours - p_tolerance_hours) || ' hours')::interval
      order by abs(extract(epoch from (o.observed_at - (a.latest_at - (p_horizon_hours || ' hours')::interval)))), o.id desc
      limit 1
    ) o
  ),
  horizon_daily as (
    select d.*
    from anchors a
    cross join lateral (
      select d.*
      from daily_rows d
      where d.token_id = a.token_id
        and d.provider_id = a.provider_id
        and d.metric_id = a.metric_id
        and d.observed_at between
          a.latest_at - ((p_horizon_hours + p_tolerance_hours) || ' hours')::interval
          and a.latest_at - ((p_horizon_hours - p_tolerance_hours) || ' hours')::interval
      order by abs(extract(epoch from (d.observed_at - (a.latest_at - (p_horizon_hours || ' hours')::interval)))), d.id desc
      limit 1
    ) d
  ),
  horizon_candidates as (
    select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
           status, observed_at, collected_at, source_field, note, created_at, scope,
           provider_asset_id, mapping_id, excluded_reason
    from horizon_raw
    union all
    select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
           status, observed_at, collected_at, source_field, note, created_at, scope,
           provider_asset_id, mapping_id, excluded_reason
    from horizon_daily
  ),
  horizon_point as (
    select distinct on (token_id, provider_id, metric_id)
      h.id, h.token_id, h.chain_id, h.metric_id, h.provider_id, h.raw_record_id, h.value, h.window_days,
      h.status, h.observed_at, h.collected_at, h.source_field, h.note, h.created_at, h.scope,
      h.provider_asset_id, h.mapping_id, h.excluded_reason
    from horizon_candidates h
    join anchors a using (token_id, provider_id, metric_id)
    order by h.token_id, h.provider_id, h.metric_id,
      abs(extract(epoch from (h.observed_at - (a.latest_at - (p_horizon_hours || ' hours')::interval)))),
      case when h.source_field in ('daily_average', 'daily_snapshot') then 0 else 1 end desc,
      h.id desc
  )
  select distinct on (id) combined.*, null::bigint as metadata_id
  from (
    select * from recent2
    union all
    select * from horizon_point
  ) combined
  order by id;
$function$;

CREATE OR REPLACE FUNCTION public.retime_coingecko_backfill_5m_batch(p_day date, p_batch integer DEFAULT 20000)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare n integer;
begin
with candidates as (
 select id,
        min(observed_at) over (partition by token_id, metric_id, provider_id, (observed_at at time zone 'UTC')::date) as anchor,
        row_number() over (partition by token_id, metric_id, provider_id, (observed_at at time zone 'UTC')::date order by collected_at,id) as rn
 from public.token_metric_observations_resolved
 where provider_id='coingecko'
   and (observed_at at time zone 'UTC')::date=p_day
   and collected_at-observed_at > interval '1 day'
   and coalesce(note,'') not like '[BACKFILL-5M]%'
), chosen as (
 select * from candidates order by id limit p_batch
), mapped as (
 select id, anchor + (rn * interval '5 minutes') as new_ts from chosen
)
update public.token_metric_observations t
set observed_at=m.new_ts, collected_at=m.new_ts,
    note=case when coalesce(resolved.note,'')='' then '[BACKFILL-5M]' else '[BACKFILL-5M] '||resolved.note end,
    source_field=resolved.source_field, scope=resolved.scope,
    provider_asset_id=resolved.provider_asset_id, metadata_id=null
from mapped m join public.token_metric_observations_resolved resolved on resolved.id=m.id
where t.id=m.id;
get diagnostics n=row_count;
return n;
end $function$;


create or replace view public.latest_token_metric_observations with (security_invoker = true) as
 SELECT DISTINCT ON (token_id, provider_id, metric_id) id,
    token_id,
    chain_id,
    metric_id,
    provider_id,
    raw_record_id,
    value,
    status,
    observed_at,
    collected_at,
    source_field,
    note,
    scope,
    provider_asset_id,
    mapping_id
   FROM token_metric_observations_resolved
  WHERE excluded_reason IS NULL
  ORDER BY token_id, provider_id, metric_id, observed_at DESC, collected_at DESC, id DESC;

create function public.prune_unused_observation_metadata(p_batch_size integer default 100)
returns integer language plpgsql set search_path = pg_catalog, public as $function$
declare removed integer;
begin
  perform set_config('lock_timeout','250ms',true);
  if not pg_try_advisory_xact_lock(hashtext('compact_observation_metadata'),1) then return 0; end if;
  with unused as materialized (
    select m.id from public.observation_metadata m
    where not exists (select 1 from public.token_metric_observations o where o.metadata_id = m.id)
    order by m.id limit least(greatest(coalesce(p_batch_size,0),0),500)
    for update of m skip locked
  ), deleted as (
    delete from public.observation_metadata m using unused u where m.id = u.id returning m.id
  ) select count(*)::integer into removed from deleted;
  return removed;
end;
$function$;
revoke all on function public.prune_unused_observation_metadata(integer) from public, anon, authenticated;
grant execute on function public.prune_unused_observation_metadata(integer) to service_role;
grant delete on public.observation_metadata to service_role;

-- The worker checks enabled=false and exits until an operator verifies the
-- compatible deployed readers. No original rows are packed by this migration.
do $schedule$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('observation-metadata-compaction','* * * * *',
      'select public.compact_observation_metadata_batch(100);');
    perform cron.schedule('observation-metadata-dictionary-cleanup','10 3 * * *',
      'select public.prune_unused_observation_metadata(100);');
  end if;
end;
$schedule$;
