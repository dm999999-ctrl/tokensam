-- Canonical 30-90 day retention:
-- keep exactly one observation per token/metric/UTC calendar day;
-- delete all other observations in the 30-90 day window.
create or replace function public.retention_collapse_daily_batch(batch_size integer default 200)
returns integer
language sql
as $function$
  with ranked as (
    select t.id,
      row_number() over (
        partition by t.token_id, t.metric_id,
          date_trunc('day', t.observed_at at time zone 'UTC')
        order by t.observed_at desc, t.id desc
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
