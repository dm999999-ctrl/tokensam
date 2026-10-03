begin;

-- Retention policy v2: 30-day granular chart history.
--
-- token_metric_observations:
--   * 0-30 days: FULL granular resolution for chart data and all other metrics.
--   * 30-91 days: weekly representation.
--   * >90 days: delete.
--
-- raw_provider_records:
--   * retain 7 days, then delete.
--
-- IMPORTANT: chart metrics must never be collapsed during the first 30 days.

create or replace function public.retention_collapse_series_intraday_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with retained_series(metric_id) as (
    values ('revenue_24h_usd'), ('fees_24h_usd')
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    join retained_series s on s.metric_id = t.metric_id
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '91 days'
      and exists (
        select 1
        from public.token_metric_observations newer
        where newer.token_id = t.token_id
          and newer.metric_id = t.metric_id
          and newer.observed_at >= date_trunc('day', t.observed_at)
          and newer.observed_at < date_trunc('day', t.observed_at) + interval '1 day'
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    order by t.observed_at, t.id
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$function$;

create or replace function public.retention_collapse_other_intraday_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with chart_metrics(metric_id) as (
    values ('price_usd'), ('market_cap_usd'), ('volume_24h_usd'), ('tvl_usd')
  ),
  series_metrics(metric_id) as (
    values ('price_usd'), ('market_cap_usd'), ('tvl_usd'), ('revenue_24h_usd'), ('fees_24h_usd')
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    where t.metric_id not in (select metric_id from series_metrics)
      and t.metric_id not in (select metric_id from chart_metrics)
      and t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '91 days'
      and exists (
        select 1
        from public.token_metric_observations newer
        where newer.token_id = t.token_id
          and newer.metric_id = t.metric_id
          and newer.observed_at >= date_trunc('day', t.observed_at)
          and newer.observed_at < date_trunc('day', t.observed_at) + interval '1 day'
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    order by t.observed_at, t.id
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$function$;

create or replace function public.retention_collapse_weekly_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with chart_metrics(metric_id) as (
    values ('price_usd'), ('market_cap_usd'), ('volume_24h_usd'), ('tvl_usd')
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '91 days'
      and (
        (
          t.metric_id in (select metric_id from chart_metrics)
          and exists (
            select 1
            from public.token_metric_observations newer
            where newer.token_id = t.token_id
              and newer.metric_id = t.metric_id
              and newer.observed_at >= date_trunc('week', t.observed_at)
              and newer.observed_at < date_trunc('week', t.observed_at) + interval '1 week'
              and (newer.observed_at, newer.id) > (t.observed_at, t.id)
          )
        )
        or
        (
          t.metric_id not in (select metric_id from chart_metrics)
          and not (t.provider_id = 'coingecko' and t.metric_id = 'price_usd')
          and exists (
            select 1
            from public.token_metric_observations newer
            where newer.token_id = t.token_id
              and newer.metric_id = t.metric_id
              and newer.observed_at >= date_trunc('week', t.observed_at)
              and newer.observed_at < date_trunc('week', t.observed_at) + interval '1 week'
              and (newer.observed_at, newer.id) > (t.observed_at, t.id)
          )
        )
      )
    order by t.observed_at, t.id
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$function$;

create or replace function public.retention_expire_observations_batch(batch_size integer default 40)
returns integer
language sql
as $function$
  with doomed as (
    select id
    from public.token_metric_observations
    where observed_at < now() - interval '90 days'
    order by observed_at, id
    limit batch_size
    for update skip locked
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int,0) from deleted;
$function$;

create or replace function public.retention_expire_raw_provider_records_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with doomed as (
    select id
    from public.raw_provider_records
    where collected_at < now() - interval '7 days'
    order by collected_at, id
    limit batch_size
  ),
  deleted as (
    delete from public.raw_provider_records t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$function$;

commit;
