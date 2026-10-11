-- Keep recent individual DeFiLlama revenue observations long enough for 24-hour comparisons.
-- Older revenue history still rolls up using the existing arithmetic-mean policy.
-- The metrics series RPC must not substitute daily averages for individual revenue samples.

begin;

create or replace function public.retention_aggregate_daily_observations(
  batch_size integer default 80,
  retention_scope text default 'non_chart'
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  target_day date;
  target_day_start timestamptz;
  target_day_end timestamptz;
  candidate_at timestamptz;
  earliest_candidate timestamptz;
  provider_key text;
  group_limit integer := least(greatest(coalesce(batch_size, 0), 0), 80);
  deleted_count integer := 0;
  utc_today timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  oldest_90_start timestamptz := date_trunc('day', (now() - interval '90 days') at time zone 'UTC') at time zone 'UTC';
  cutoff_30_start timestamptz := date_trunc('day', (now() - interval '30 days') at time zone 'UTC') at time zone 'UTC';
  cutoff_37_start timestamptz := date_trunc('day', (now() - interval '37 days') at time zone 'UTC') at time zone 'UTC';
begin
  if retention_scope not in ('non_chart', 'chart_history') then
    raise exception 'Unknown retention scope: %', retention_scope;
  end if;
  if not pg_try_advisory_xact_lock(hashtext('token_metric_daily_aggregation'), 1) then
    return 0;
  end if;
  if group_limit = 0 then
    return 0;
  end if;

  if retention_scope = 'chart_history' then
    -- Each branch can use provider_metric_history_lookup_idx directly.
    select min(c.observed_at) into earliest_candidate
    from (
      (select t.observed_at
       from public.token_metric_observations t
       where t.provider_id = 'coingecko' and t.metric_id = 'price_usd'
         and t.observed_at >= oldest_90_start and t.observed_at < cutoff_37_start
       order by t.observed_at, t.id limit 1)
      union all
      (select t.observed_at
       from public.token_metric_observations t
       where t.provider_id = 'coingecko' and t.metric_id = 'volume_24h_usd'
         and t.observed_at >= oldest_90_start and t.observed_at < cutoff_30_start
       order by t.observed_at, t.id limit 1)
      union all
      (select t.observed_at
       from public.token_metric_observations t
       where t.provider_id = 'defillama' and t.metric_id = 'tvl_usd'
         and t.observed_at >= oldest_90_start and t.observed_at < cutoff_30_start
       order by t.observed_at, t.id limit 1)
    ) c;
  else
    -- Providers added later are covered automatically. Each lookup is pinned
    -- to provider_id so the provider/observed_at index bounds its work.
    for provider_key in
      select p.id from public.data_providers p where p.id not in ('coingecko', 'defillama')
    loop
      select t.observed_at into candidate_at
      from public.token_metric_observations t
      where t.provider_id = provider_key
        and t.observed_at >= oldest_90_start and t.observed_at < utc_today
      order by t.observed_at, t.id limit 1;
      if candidate_at is not null and (earliest_candidate is null or candidate_at < earliest_candidate) then
        earliest_candidate := candidate_at;
      end if;
    end loop;

    select t.observed_at into candidate_at
    from public.token_metric_observations t
    where t.provider_id = 'coingecko'
      and t.observed_at >= oldest_90_start and t.observed_at < utc_today
      and t.metric_id not in ('price_usd', 'volume_24h_usd')
    order by t.observed_at, t.id limit 1;
    if candidate_at is not null and (earliest_candidate is null or candidate_at < earliest_candidate) then
      earliest_candidate := candidate_at;
    end if;

    select t.observed_at into candidate_at
    from public.token_metric_observations t
    where t.provider_id = 'defillama'
      and t.observed_at >= oldest_90_start and t.observed_at < utc_today
      and t.metric_id <> 'tvl_usd'
      and (t.metric_id <> 'revenue_24h_usd' or t.observed_at < utc_today - interval '3 days')
    order by t.observed_at, t.id limit 1;
    if candidate_at is not null and (earliest_candidate is null or candidate_at < earliest_candidate) then
      earliest_candidate := candidate_at;
    end if;
  end if;

  if earliest_candidate is null then
    return 0;
  end if;
  target_day := (earliest_candidate at time zone 'UTC')::date;
  target_day_start := target_day::timestamp at time zone 'UTC';
  target_day_end := (target_day + 1)::timestamp at time zone 'UTC';

  with selected_groups as materialized (
    select t.token_id, t.chain_id, t.metric_id, t.provider_id
    from public.token_metric_observations t
    where t.observed_at >= target_day_start and t.observed_at < target_day_end
      and (
        (retention_scope = 'non_chart'
          and not (
            (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
            or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
            or (t.provider_id = 'defillama' and t.metric_id = 'revenue_24h_usd' and target_day >= (utc_today at time zone 'UTC')::date - 3)
          ))
        or (retention_scope = 'chart_history' and (
          (t.provider_id = 'coingecko' and t.metric_id = 'price_usd' and t.observed_at < cutoff_37_start)
          or (t.provider_id = 'coingecko' and t.metric_id = 'volume_24h_usd' and t.observed_at < cutoff_30_start)
          or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd' and t.observed_at < cutoff_30_start)
        ))
      )
    group by t.token_id, t.chain_id, t.metric_id, t.provider_id
    order by t.provider_id, t.metric_id, t.token_id
    limit group_limit
  ),
  daily_values as materialized (
    select g.token_id, g.chain_id, g.metric_id, g.provider_id,
      target_day as utc_day,
      avg(t.value) filter (
        where t.value is not null
          and t.status in ('available', 'estimated', 'stale')
          and t.value::text not in ('NaN', 'Infinity', '-Infinity')
      ) as mean_value,
      count(*)::integer as source_observation_count,
      count(*) filter (
        where t.value is not null
          and t.status in ('available', 'estimated', 'stale')
          and t.value::text not in ('NaN', 'Infinity', '-Infinity')
      )::integer as valid_value_count,
      min(t.observed_at) as first_source_observed_at,
      max(t.observed_at) as last_source_observed_at,
      array_agg(t.id order by t.observed_at, t.id) as source_observation_ids
    from selected_groups g
    join public.token_metric_observations t
      on t.token_id = g.token_id and t.chain_id = g.chain_id
      and t.metric_id = g.metric_id and t.provider_id = g.provider_id
      and t.observed_at >= target_day_start and t.observed_at < target_day_end
    group by g.token_id, g.chain_id, g.metric_id, g.provider_id
  ),
  upserted as (
    insert into public.token_metric_daily_aggregates as existing (
      token_id, chain_id, metric_id, provider_id, utc_day, value, status,
      source_observation_count, valid_value_count,
      first_source_observed_at, last_source_observed_at,
      source_observation_ids, aggregation_method, aggregated_at
    )
    select d.token_id, d.chain_id, d.metric_id, d.provider_id, d.utc_day,
      d.mean_value, case when d.valid_value_count > 0 then 'available' else 'unavailable' end,
      d.source_observation_count, d.valid_value_count,
      d.first_source_observed_at, d.last_source_observed_at,
      d.source_observation_ids, 'arithmetic_mean', now()
    from daily_values d
    on conflict (token_id, metric_id, provider_id, utc_day) do update set
      value = case when existing.valid_value_count + excluded.valid_value_count = 0 then null
        else (coalesce(existing.value * existing.valid_value_count, 0)
          + coalesce(excluded.value * excluded.valid_value_count, 0))
          / nullif(existing.valid_value_count + excluded.valid_value_count, 0) end,
      status = case when existing.valid_value_count + excluded.valid_value_count > 0 then 'available' else 'unavailable' end,
      source_observation_count = existing.source_observation_count + excluded.source_observation_count,
      valid_value_count = existing.valid_value_count + excluded.valid_value_count,
      first_source_observed_at = least(existing.first_source_observed_at, excluded.first_source_observed_at),
      last_source_observed_at = greatest(existing.last_source_observed_at, excluded.last_source_observed_at),
      source_observation_ids = existing.source_observation_ids || excluded.source_observation_ids,
      aggregated_at = now()
    returning id
  ),
  deleted as (
    delete from public.token_metric_observations t using selected_groups g
    where t.token_id = g.token_id and t.chain_id = g.chain_id
      and t.metric_id = g.metric_id and t.provider_id = g.provider_id
      and t.observed_at >= target_day_start and t.observed_at < target_day_end
    returning t.id
  )
  select count(*)::integer into deleted_count
  from deleted cross join (select count(*) from upserted) applied;

  return coalesce(deleted_count, 0);
end;
$function$;

revoke all on function public.retention_aggregate_daily_observations(integer, text) from public, anon, authenticated;
grant execute on function public.retention_aggregate_daily_observations(integer, text) to service_role;

create or replace function public.metrics_series_recent_points(
  p_token_ids text[],
  p_providers text[],
  p_metrics text[],
  p_now timestamptz,
  p_horizon_hours int default 24,
  p_tolerance_hours int default 6,
  p_max_lookback_days int default 30
)
returns setof public.token_metric_observations
language sql
stable
as $$
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
      from public.token_metric_observations o
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
      from public.token_metric_observations o
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
  select distinct on (id) *
  from (
    select * from recent2
    union all
    select * from horizon_point
  ) combined
  order by id;
$$;

revoke all on function public.metrics_series_recent_points(text[], text[], text[], timestamptz, int, int, int) from public;
grant execute on function public.metrics_series_recent_points(text[], text[], text[], timestamptz, int, int, int) to service_role;

commit;
