-- retention_collapse_non_chart_daily_batch's target-day selection picked the
-- *earliest* day with any non-chart row at all, not the earliest day that
-- still has more than one row per token/metric/provider group. Every day
-- older than ~30 days was already collapsed to 1/day by the pre-existing
-- retention_collapse_daily_batch (which applies to all metrics once they
-- cross 30 days), so the function kept re-selecting the same
-- already-collapsed oldest day, returning 0 deleted, and never advancing.
-- Real duplicates only exist in the recent window where the old
-- protect_30d_chart_observations trigger used to force full granularity for
-- these metrics (now narrowed in the prior migration).
--
-- Fixes this with a bounded loop (at most 31 single-day checks, each a cheap
-- day-range scan on token_metric_observations_observed_at_idx) that finds the
-- first day actually holding excess rows, then collapses only that day.
CREATE OR REPLACE FUNCTION public.retention_collapse_non_chart_daily_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
AS $function$
declare
  day_cursor timestamptz := date_trunc('day', now() at time zone 'UTC') - interval '31 days';
  day_limit timestamptz := date_trunc('day', now() at time zone 'UTC');
  target_day timestamptz;
  has_excess boolean;
  deleted_count int;
begin
  while day_cursor < day_limit loop
    select exists (
      select 1
      from public.token_metric_observations t
      where t.observed_at >= day_cursor
        and t.observed_at < day_cursor + interval '1 day'
        and not (
          (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
          or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
        )
      group by t.token_id, t.metric_id, t.provider_id
      having count(*) > 1
      limit 1
    ) into has_excess;

    if has_excess then
      target_day := day_cursor;
      exit;
    end if;

    day_cursor := day_cursor + interval '1 day';
  end loop;

  if target_day is null then
    return 0;
  end if;

  with eligible as (
    select t.id, t.token_id, t.metric_id, t.provider_id, t.observed_at
    from public.token_metric_observations t
    where t.observed_at >= target_day
      and t.observed_at < target_day + interval '1 day'
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
      )
  ),
  ranked as (
    select e.id,
      row_number() over (
        partition by e.token_id, e.metric_id, e.provider_id
        order by abs(extract(epoch from (e.observed_at - target_day))), e.id
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
