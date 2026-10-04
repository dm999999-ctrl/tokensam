-- retention_collapse_non_chart_daily_batch (added in
-- 20261004120000_narrow_30d_granular_scope_to_chart_metrics.sql) scanned its
-- entire unbounded candidate set (every non-chart observation in the whole
-- 0-30 day window, ~487k rows) on every call: `limit batch_size` only bounded
-- the final delete, not the `eligible`/`days`/`canonical` CTEs that ran ahead
-- of it. The existing retention_collapse_daily_batch gets away with the same
-- shape only because its 30-90 day window is much smaller (already mostly
-- collapsed). A single call here was taking 60s+, and a 1000-iteration loop
-- hit the 10-minute statement_timeout with zero progress (one DO block is one
-- transaction, so the timeout rolled back every batch it had done).
--
-- Fixes this by bounding each call to one UTC day at a time (the oldest day
-- that still has uncollapsed non-chart rows): the day-range filter uses
-- token_metric_observations_observed_at_idx, so each call's CTEs only ever
-- scan one day's worth of rows (~15-20k, not ~487k). Repeated calls fully
-- collapse that day before moving to the next, same convergence behavior as
-- before, just bounded per call.
CREATE OR REPLACE FUNCTION public.retention_collapse_non_chart_daily_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
AS $function$
declare
  target_day timestamptz;
  deleted_count int;
begin
  select date_trunc('day', t.observed_at at time zone 'UTC')
  into target_day
  from public.token_metric_observations t
  where t.observed_at < date_trunc('day', now() at time zone 'UTC')
    and not (
      (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
      or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
    )
  order by t.observed_at
  limit 1;

  if target_day is null then
    return 0;
  end if;

  with eligible as (
    select t.id, t.token_id, t.metric_id, t.provider_id, t.observed_at
    from public.token_metric_observations t
    where t.observed_at >= (target_day at time zone 'UTC')
      and t.observed_at < ((target_day + interval '1 day') at time zone 'UTC')
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
      )
  ),
  ranked as (
    select e.id,
      row_number() over (
        partition by e.token_id, e.metric_id, e.provider_id
        order by abs(extract(epoch from (e.observed_at - (target_day at time zone 'UTC')))), e.id
      ) as rn
    from eligible e
  ),
  doomed as (
    select id from ranked where rn > 1
    order by id
    limit greatest(batch_size, 0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select count(*) into deleted_count from deleted;

  return coalesce(deleted_count, 0);
end;
$function$;
