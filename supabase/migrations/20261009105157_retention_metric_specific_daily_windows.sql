-- The initial implementation applied UTC date casts to every history row.
-- Use provider/timestamp indexes to find a candidate day, then a bounded UTC
-- timestamp range for all group, aggregate, and delete work.
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

-- Keep only the history windows consumed by website indicators from daily means.
-- Market-cap needs 46 UTC days: 30 days plus the 15-day freshness allowance
-- and one boundary day. Circulating supply needs 11 days for its 7-day indicator
-- plus its 3-day freshness allowance and one boundary day. Total/maximum supply
-- have no historical indicator, so retain only each token's latest completed day.
create or replace function public.retention_expire_daily_aggregates_batch(batch_size integer default 1000)
returns integer
language sql
set search_path = pg_catalog, public
as $function$
  with ranked_singletons as materialized (
    select id,
      row_number() over (
        partition by token_id, metric_id, provider_id
        order by utc_day desc, id desc
      ) as rn
    from public.token_metric_daily_aggregates
    where provider_id = 'coingecko'
      and metric_id in ('total_supply', 'maximum_supply')
  ), expired as (
    select a.id
    from public.token_metric_daily_aggregates a
    left join ranked_singletons r on r.id = a.id
    where (
      a.provider_id = 'coingecko' and a.metric_id = 'market_cap_usd'
      and a.utc_day < ((now() at time zone 'UTC')::date - 46)
    ) or (
      a.provider_id = 'coingecko' and a.metric_id = 'circulating_supply'
      and a.utc_day < ((now() at time zone 'UTC')::date - 11)
    ) or (
      a.provider_id = 'coingecko' and a.metric_id in ('total_supply', 'maximum_supply')
      and r.rn > 1
    ) or (
      not (a.provider_id = 'coingecko' and a.metric_id in ('market_cap_usd', 'circulating_supply', 'total_supply', 'maximum_supply'))
      and a.utc_day < ((now() - interval '90 days') at time zone 'UTC')::date
    )
    order by a.utc_day, a.id
    limit greatest(batch_size, 0)
    for update of a skip locked
  ), deleted as (
    delete from public.token_metric_daily_aggregates a
    using expired e
    where a.id = e.id
    returning a.id
  )
  select count(*)::integer from deleted;
$function$;

revoke all on function public.retention_aggregate_daily_observations(integer, text) from public, anon, authenticated;
grant execute on function public.retention_aggregate_daily_observations(integer, text) to service_role;
revoke all on function public.retention_expire_daily_aggregates_batch(integer) from public, anon, authenticated;
grant execute on function public.retention_expire_daily_aggregates_batch(integer) to service_role;