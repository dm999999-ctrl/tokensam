create or replace function public.get_coingecko_daily_gaps(
  p_start_date date,
  p_end_date date,
  p_metric_ids text[] default array['price_usd','market_cap_usd','volume_24h_usd']
)
returns table(token_id text, metric_id text, missing_date date)
language sql
security definer
set search_path = public
as $$
  with days as (
    select generate_series(p_start_date, p_end_date, interval '1 day')::date as missing_date
  ),
  token_metrics as (
    select t.id as token_id, m.metric_id
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
  order by tm.token_id, tm.metric_id, d.missing_date;
$$;

revoke all on function public.get_coingecko_daily_gaps(date, date, text[]) from public;
grant execute on function public.get_coingecko_daily_gaps(date, date, text[]) to service_role;
