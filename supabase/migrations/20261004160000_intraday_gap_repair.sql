-- Fully-missing-UTC-day detection (get_coingecko_daily_gaps) is blind to a partial-day
-- outage: if a token/metric has at least one row on both the day the outage started and
-- the day it ended, neither day registers as "missing" even though many hours of real
-- data were lost in between (e.g. a multi-hour Cloudflare Worker outage that still
-- leaves a few points before/after it). This function finds that shape directly: for
-- each token/metric, look at every pair of consecutive observations within the window
-- and flag any pair spaced further apart than p_min_gap_hours.
--
-- Scoped to CoinGecko only, and only called with price_usd/volume_24h_usd (see
-- INTRADAY_METRICS in repair-coingecko-daily-gaps.ts): every other provider/metric
-- combination in this system is deliberately collapsed to one observation per UTC day
-- once it's no longer "today" (see run-retention.ts), so this same check against them
-- would flag that intentional daily collapse as a "gap" every single day, forever, with
-- no real outage involved. Only metrics retained continuously granular (not just the
-- latest-of-day) have a meaningful intraday gap to detect in the first place.
create or replace function public.get_coingecko_intraday_gaps(
  p_start_date date,
  p_end_date date,
  p_min_gap_hours numeric,
  p_metric_ids text[] default array['price_usd','market_cap_usd','volume_24h_usd']
)
returns table(token_id text, metric_id text, gap_start timestamptz, gap_end timestamptz)
language sql
security definer
set search_path to 'public'
as $function$
  with ordered as (
    select
      o.token_id,
      o.metric_id,
      o.observed_at,
      lag(o.observed_at) over (partition by o.token_id, o.metric_id order by o.observed_at) as previous_observed_at
    from public.token_metric_observations o
    where o.provider_id = 'coingecko'
      and o.metric_id = any(p_metric_ids)
      and o.observed_at >= p_start_date::timestamptz
      and o.observed_at < (p_end_date + 1)::timestamptz
  )
  select token_id, metric_id, previous_observed_at as gap_start, observed_at as gap_end
  from ordered
  where previous_observed_at is not null
    and observed_at - previous_observed_at > (p_min_gap_hours || ' hours')::interval
  order by token_id, metric_id, gap_start;
$function$;

revoke all on function public.get_coingecko_intraday_gaps(date,date,numeric,text[]) from public;
grant execute on function public.get_coingecko_intraday_gaps(date,date,numeric,text[]) to service_role;
