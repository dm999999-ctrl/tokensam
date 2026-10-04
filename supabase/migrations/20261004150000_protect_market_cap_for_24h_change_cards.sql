-- The new Market Snapshot "Market cap change · 24h" and "Volume / market cap
-- change · 24h" cards (src/lib/data/live-data.ts: changeOverHorizon,
-- volumeToMarketCapChangeOverHorizon) need a coingecko market_cap_usd
-- observation within CHANGE_TOLERANCE_HOURS (3h) of exactly 24 hours ago.
--
-- market_cap_usd is a non-chart metric, so retention_collapse_non_chart_daily_batch
-- (added in 20261004120000_narrow_30d_granular_scope_to_chart_metrics.sql)
-- collapses it to one observation/day as soon as each UTC day completes.
-- That leaves "yesterday" as a single point near 00:00 UTC -- for most of
-- today, that's many hours away from the true 24h-ago target, well outside
-- the 3-hour tolerance, so both cards would return null/unavailable for most
-- of the day.
--
-- Fix: give market_cap_usd (and only market_cap_usd -- every other non-chart
-- metric keeps collapsing as soon as each UTC day completes) its own short
-- exception, collapsing only once an observation is more than 48 hours old.
-- That's just enough margin to always have a point within tolerance of any
-- 24h-ago target, while still collapsing almost as early as before (one
-- extra day of granularity for this one metric, not thirty).
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
          or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
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
        or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
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
