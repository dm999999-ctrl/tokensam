-- Fix: get_coingecko_daily_gaps() and get_provider_daily_gaps() only checked
-- token_metric_observations for an existing value on a given day, never
-- token_metric_daily_aggregates. Retention correctly collapses each completed UTC
-- day's granular observations into one daily-average aggregate row and deletes the
-- source observations (see run-retention.ts/retention_collapse_daily_batch) -- but
-- that meant every collapsed historical day, for every token, forever, read as a
-- "gap" to these two functions. The gap-repair collectors
-- (repair-coingecko-daily-gaps.ts, repair-defillama-daily-gaps.ts) then spent every
-- refresh cycle re-fetching and re-inserting full provider history for up to 10
-- "gapped" tokens, which retention immediately re-collapsed again -- a continuous,
-- unnecessary churn cycle across all 182 canonical tokens that inflated both
-- database size (confirmed: 8,008 false-positive "gaps" on 2026-10-12, every one of
-- 20 sampled already had a token_metric_daily_aggregates row) and refresh CPU/API
-- usage. Both functions now also treat a day as covered when a daily aggregate
-- already exists for it, matching what retention actually leaves behind.

create or replace function public.get_coingecko_daily_gaps(
  p_start_date date,
  p_end_date date,
  p_metric_ids text[] default array['price_usd', 'market_cap_usd', 'volume_24h_usd']
)
returns table(token_id text, metric_id text, missing_date date)
language sql
security definer
set search_path to 'public'
as $function$
  with days as (
    select generate_series(p_start_date, p_end_date, interval '1 day')::date as missing_date
  ),
  token_metrics as (
    select t.id as token_id, t.chain_id, m.metric_id
    from public.tokens t
    cross join unnest(p_metric_ids) as m(metric_id)
  )
  select tm.token_id, tm.metric_id, d.missing_date
  from token_metrics tm
  cross join days d
  where not exists (
    select 1
    from public.token_metric_observations o
    where o.provider_id = 'coingecko'
      and o.token_id = tm.token_id
      and o.metric_id = tm.metric_id
      and o.observed_at >= d.missing_date::timestamptz
      and o.observed_at < (d.missing_date + 1)::timestamptz
  )
  and not exists (
    select 1
    from public.token_metric_daily_aggregates a
    where a.provider_id = 'coingecko'
      and a.token_id = tm.token_id
      and a.chain_id = tm.chain_id
      and a.metric_id = tm.metric_id
      and a.utc_day = d.missing_date
  )
  order by tm.token_id, tm.metric_id, d.missing_date;
$function$;

create or replace function public.get_provider_daily_gaps(
  p_provider_id text,
  p_start_date date,
  p_end_date date,
  p_metric_ids text[]
)
returns table(provider_id text, token_id text, metric_id text, missing_date date)
language sql
security definer
set search_path to 'public'
as $function$
  select p_provider_id, m.token_id, d.metric_id, days.missing_date::date
  from provider_token_mappings m
  cross join unnest(p_metric_ids) as d(metric_id)
  cross join lateral generate_series(p_start_date, p_end_date, interval '1 day') as days(missing_date)
  where m.provider_id = p_provider_id
    and not exists (
      select 1 from token_metric_observations o
      where o.provider_id = p_provider_id
        and o.token_id = m.token_id
        and o.metric_id = d.metric_id
        and o.observed_at >= (days.missing_date::date::timestamp at time zone 'UTC')
        and o.observed_at < ((days.missing_date::date + 1)::timestamp at time zone 'UTC')
    )
    and not exists (
      select 1 from token_metric_daily_aggregates a
      where a.provider_id = p_provider_id
        and a.token_id = m.token_id
        and a.chain_id = m.chain_id
        and a.metric_id = d.metric_id
        and a.utc_day = days.missing_date::date
    )
  order by m.token_id, d.metric_id, days.missing_date;
$function$;
