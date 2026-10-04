-- Narrow the 30-day fully-granular retention window to only the metrics the
-- 30D charts (Price, Volume, Risk profile, TVL) actually read. Risk profile is
-- derived from price_usd at render time, so it needs no metric of its own.
--
-- Everything else currently held granular for 30 days (market_cap_usd, supply
-- fields, price_change_*_pct, defillama_coins price_usd, all dexscreener and
-- geckoterminal metrics, defillama fees/revenue) is only ever read as the
-- single latest observation (dashboard rows, Tokenomics, Market Structure,
-- on-chain markets) or reduced to one UTC-midnight sample per day before use
-- (technical indicators, via dailySamples()/SERIES_RULES in
-- src/lib/indicators/series.ts). Collapsing it to one observation/day as soon
-- as each UTC day completes -- instead of waiting the existing 30 days --
-- changes no chart, indicator, or live value; it only removes same-day
-- intraday duplicates nothing reads.
--
-- See src/lib/retention/run-retention.ts and
-- supabase/migrations/20260930130000_retention_framework.sql for the
-- surrounding retention framework this extends.

-- The chart-required scope: exactly what src/lib/indicators/series.ts
-- (SERIES_RULES.price / .volume) and the TVL chart (coingecko price_usd,
-- coingecko volume_24h_usd, defillama tvl_usd) read at full granularity.
-- market_cap_usd is deliberately dropped from the protected set: it is not
-- rendered as a chart (MARKET_HISTORY in src/lib/ui/profile-model.ts omits
-- it), and technical indicators already reduce it to one UTC-midnight sample
-- per day via dailySamples(), so granular market_cap_usd history serves
-- nothing. The guard is also scoped to the coingecko/defillama providers the
-- charts actually use, instead of blanket-protecting every provider's
-- price_usd/volume_24h_usd (e.g. dexscreener, geckoterminal).
CREATE OR REPLACE FUNCTION public.protect_30d_chart_observations()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
begin
  if (
    (OLD.provider_id = 'coingecko' and OLD.metric_id in ('price_usd', 'volume_24h_usd'))
    or (OLD.provider_id = 'defillama' and OLD.metric_id = 'tvl_usd')
  )
     and OLD.observed_at >= now() - interval '30 days' then
    raise exception 'RETENTION_GUARD: cannot delete %/% observation inside 30-day granular chart window', OLD.provider_id, OLD.metric_id;
  end if;
  return OLD;
end;
$function$;

-- Collapses every *non*-chart-required observation down to one row/day (the
-- one closest to UTC midnight, same selection rule as
-- retention_collapse_daily_batch), as soon as its UTC day is complete.
-- Today's still-forming UTC day is always excluded, so the single latest
-- observation any "current value" read relies on (dashboard rows, Tokenomics,
-- Market Structure, on-chain markets -- all read via the newest row only, see
-- src/lib/data/live-data.ts) is never at risk of being removed mid-day.
CREATE OR REPLACE FUNCTION public.retention_collapse_non_chart_daily_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE sql
AS $function$
  with eligible as (
    select t.id, t.token_id, t.metric_id, t.provider_id, t.observed_at,
           date_trunc('day', t.observed_at at time zone 'UTC') as utc_day
    from public.token_metric_observations t
    where t.observed_at < date_trunc('day', now() at time zone 'UTC')
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
      )
  ),
  days as (
    select distinct token_id, metric_id, provider_id, utc_day
    from eligible
  ),
  canonical as (
    select d.token_id, d.metric_id, d.provider_id, d.utc_day, c.id as canonical_id
    from days d
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id = d.token_id
        and t.metric_id = d.metric_id
        and t.provider_id = d.provider_id
        and t.observed_at >= (d.utc_day at time zone 'UTC')
        and t.observed_at < ((d.utc_day + interval '1 day') at time zone 'UTC')
      order by abs(extract(epoch from (t.observed_at - (d.utc_day at time zone 'UTC')))), t.id
      limit 1
    ) c
  ),
  doomed as (
    select e.id
    from eligible e
    join canonical c on c.token_id = e.token_id and c.metric_id = e.metric_id
      and c.provider_id = e.provider_id and c.utc_day = e.utc_day
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
  select coalesce(count(*)::int, 0) from deleted;
$function$;
