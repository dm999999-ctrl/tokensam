create or replace function public.get_provider_daily_gaps(
  p_provider_id text,
  p_start_date date,
  p_end_date date,
  p_metric_ids text[]
)
returns table (
  provider_id text,
  token_id text,
  metric_id text,
  missing_date date
)
language sql
security definer
set search_path = public
as $$
  select
    p_provider_id,
    m.token_id,
    d.metric_id,
    days.missing_date::date
  from provider_token_mappings m
  cross join unnest(p_metric_ids) as d(metric_id)
  cross join lateral generate_series(p_start_date, p_end_date, interval '1 day') as days(missing_date)
  where m.provider_id = p_provider_id
    and not exists (
      select 1
      from token_metric_observations o
      where o.provider_id = p_provider_id
        and o.token_id = m.token_id
        and o.metric_id = d.metric_id
        and o.observed_at >= (days.missing_date::date::timestamp at time zone 'UTC')
        and o.observed_at < ((days.missing_date::date + 1)::timestamp at time zone 'UTC')
    )
  order by m.token_id, d.metric_id, days.missing_date;
$$;

revoke all on function public.get_provider_daily_gaps(text,date,date,text[]) from public;
grant execute on function public.get_provider_daily_gaps(text,date,date,text[]) to service_role;
