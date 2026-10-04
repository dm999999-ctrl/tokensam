-- The risk profile's volatility is a rolling 7-day window of hourly price
-- log returns ending at each displayed point (RISK_VOLATILITY_WINDOW_DAYS in
-- src/lib/indicators/series.ts). For a 30D chart, the volatility value shown
-- near the START of that 30-day window still needs hourly price_usd data
-- going back a further 7 days before it -- i.e. the true requirement is 37
-- days of hourly data, not 30. Below that, hourlyRiskSamples() finds only
-- the daily-collapsed data (1 point/day) from the 30-90 day window,
-- rollingVolatility()'s consecutive-hourly-run logic resets on every gap,
-- and the volatility curve degrades to warm-up noise for roughly the first
-- week of the displayed 30D window.
--
-- This extends ONLY coingecko price_usd's granular protection to 37 days.
-- volume_24h_usd and defillama tvl_usd are untouched (still 30 days): the
-- volume chart and TVL chart show only their own display window with no
-- extra lookback, and drawdown (the risk profile's other series) only ever
-- reads the display window itself, never beyond it.

CREATE OR REPLACE FUNCTION public.protect_30d_chart_observations()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
begin
  if (
    (OLD.provider_id = 'coingecko' and OLD.metric_id = 'price_usd' and OLD.observed_at >= now() - interval '37 days')
    or (OLD.provider_id = 'coingecko' and OLD.metric_id = 'volume_24h_usd' and OLD.observed_at >= now() - interval '30 days')
    or (OLD.provider_id = 'defillama' and OLD.metric_id = 'tvl_usd' and OLD.observed_at >= now() - interval '30 days')
  ) then
    raise exception 'RETENTION_GUARD: cannot delete %/% observation inside its granular chart window', OLD.provider_id, OLD.metric_id;
  end if;
  return OLD;
end;
$function$;

CREATE OR REPLACE FUNCTION public.retention_collapse_daily_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE sql
AS $function$
  with eligible as (
    select t.id,t.token_id,t.metric_id,t.provider_id,t.observed_at,
           date_trunc('day', t.observed_at at time zone 'UTC') as utc_day
    from public.token_metric_observations t
    where t.observed_at >= now() - interval '90 days'
      and (
        (t.provider_id = 'coingecko' and t.metric_id = 'price_usd' and t.observed_at < now() - interval '37 days')
        or (
          not (t.provider_id = 'coingecko' and t.metric_id = 'price_usd')
          and t.observed_at < now() - interval '30 days'
        )
      )
  ),
  days as (
    select distinct token_id, metric_id, provider_id, utc_day
    from eligible
  ),
  canonical as (
    select d.token_id,d.metric_id,d.provider_id,d.utc_day,c.id as canonical_id
    from days d
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id=d.token_id
        and t.metric_id=d.metric_id
        and t.provider_id=d.provider_id
        and t.observed_at >= (d.utc_day at time zone 'UTC')
        and t.observed_at < ((d.utc_day + interval '1 day') at time zone 'UTC')
      order by abs(extract(epoch from (t.observed_at-(d.utc_day at time zone 'UTC')))),t.id
      limit 1
    ) c
  ),
  doomed as (
    select e.id from eligible e
    join canonical c on c.token_id=e.token_id and c.metric_id=e.metric_id
      and c.provider_id=e.provider_id and c.utc_day=e.utc_day
    where e.id<>c.canonical_id
    order by e.observed_at,e.id
    limit greatest(batch_size,0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id=doomed.id
    returning t.id
  )
  select coalesce(count(*)::int,0) from deleted;
$function$;
