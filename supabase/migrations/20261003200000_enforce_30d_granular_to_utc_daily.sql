-- Enforce the 30-day compression boundary exactly as documented.
-- 0-30 days: retain all granular observations.
-- Once observations are older than 30 days, retain only the observation
-- closest to 00:00 UTC for each token/metric/provider/UTC day and delete
-- every other granular observation. This is the daily historical observation.
create or replace function public.retention_collapse_daily_batch(batch_size integer default 1000)
returns integer
language sql
as $function$
  with ranked as (
    select t.id,
      row_number() over (
        partition by t.token_id, t.metric_id, t.provider_id,
          date_trunc('day', t.observed_at at time zone 'UTC')
        order by
          abs(extract(epoch from (
            t.observed_at -
            (date_trunc('day', t.observed_at at time zone 'UTC') at time zone 'UTC')
          ))),
          t.id
      ) as rn
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '90 days'
  ),
  doomed as (
    select id
    from ranked
    where rn > 1
    order by id
    limit greatest(batch_size,0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select coalesce(count(*)::int,0) from deleted;
$function$;
