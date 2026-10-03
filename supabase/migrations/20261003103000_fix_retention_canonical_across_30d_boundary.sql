-- Retention collapse must choose the canonical observation from the whole UTC
-- calendar day, not only from rows that have already crossed 30 days.
-- This preserves the 0-30 day protection while ensuring that once a row crosses
-- 30 days it is collapsed against the true closest-to-midnight observation.
create or replace function public.retention_collapse_daily_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with eligible as (
    select t.id,
      t.token_id,
      t.metric_id,
      t.provider_id,
      date_trunc('day', t.observed_at at time zone 'UTC') as utc_day
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '90 days'
  ),
  canonical as (
    select e.token_id, e.metric_id, e.provider_id, e.utc_day,
      (
        select c.id
        from public.token_metric_observations c
        where c.token_id = e.token_id
          and c.metric_id = e.metric_id
          and c.provider_id = e.provider_id
          and c.observed_at >= (e.utc_day at time zone 'UTC')
          and c.observed_at < ((e.utc_day + interval '1 day') at time zone 'UTC')
        order by
          abs(extract(epoch from (
            c.observed_at - (e.utc_day at time zone 'UTC')
          ))),
          c.id
        limit 1
      ) as canonical_id
    from (
      select distinct token_id, metric_id, provider_id, utc_day
      from eligible
    ) e
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
    order by e.id
    limit greatest(batch_size, 0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$function$;
