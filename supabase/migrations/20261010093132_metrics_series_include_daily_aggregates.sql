-- Include retained UTC daily values in the server-side metrics series read.
-- Raw observations remain preferred where they provide a closer 24-hour point;
-- aggregates fill the historical points after source observations are compacted.
begin;

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
    where a.utc_day >= (p_now at time zone 'UTC')::date - p_max_lookback_days
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
