-- Enforce the rolling retention policy:
--   0-30 days: retain every actual granular observation unchanged.
--   >30-<90 days: retain exactly one actual observation per
--                 token/metric/provider/UTC day, chosen closest to 00:00 UTC.
--   >90 days: delete the remaining daily observation.
--
-- IMPORTANT: this migration never rewrites observed_at or collected_at.
-- Retention operates only on actual stored observations.

create or replace function public.retention_collapse_daily_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with eligible as (
    select
      t.id,
      t.token_id,
      t.metric_id,
      t.provider_id,
      t.observed_at,
      date_trunc('day', t.observed_at at time zone 'UTC') as utc_day
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '90 days'
  ),
  days as (
    select distinct token_id, metric_id, provider_id, utc_day
    from eligible
  ),
  canonical as (
    select
      d.token_id,
      d.metric_id,
      d.provider_id,
      d.utc_day,
      c.id as canonical_id
    from days d
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id = d.token_id
        and t.metric_id = d.metric_id
        and t.provider_id = d.provider_id
        and t.observed_at >= (d.utc_day at time zone 'UTC')
        and t.observed_at < ((d.utc_day + interval '1 day') at time zone 'UTC')
      order by
        abs(extract(epoch from (
          t.observed_at - (d.utc_day at time zone 'UTC')
        ))),
        t.id
      limit 1
    ) c
  ),
  doomed as (
    select e.id
    from eligible e
    join canonical c
      on c.token_id = e.token_id
     and c.metric_id = e.metric_id
     and c.provider_id = e.provider_id
     and c.utc_day = e.utc_day
    where e.id <> c.canonical_id
    order by e.observed_at, e.id
    limit greatest(batch_size, 0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0)
  from deleted;
$function$;

create or replace function public.retention_expire_observations_batch(batch_size integer default 200)
returns integer
language sql
as $function$
  with doomed as (
    select id
    from public.token_metric_observations
    where observed_at < now() - interval '90 days'
    order by observed_at, id
    limit greatest(batch_size, 0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0)
  from deleted;
$function$;
