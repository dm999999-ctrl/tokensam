-- retention_collapse_non_chart_daily_batch was re-sorting and ranking every eligible
-- row in the whole target day on every single call (a WindowAgg over the day's full
-- row count), even though batch_size only bounded how many of those ranked rows got
-- deleted. On a day with a large backlog (e.g. right after UTC day-rollover, ~30K rows
-- across thousands of token/metric/provider groups), that per-call cost is high enough
-- that it now routinely exceeds the project's actual limit for this call path: Supabase's
-- PostgREST `authenticator` role carries statement_timeout=8s (see pg_roles.rolconfig),
-- not the 120s assumed earlier -- every production call goes through that role, unlike a
-- direct admin SQL connection. The result: 36/36 scheduled retention runs failed today,
-- with zero net progress on this function for hours.
--
-- Fix: bound batch_size to GROUPS (token_id/metric_id/provider_id combos with excess),
-- not rows. Each call only ranks the rows belonging to up to `batch_size` picked groups
-- (each group has at most a few dozen rows/day), instead of the entire day -- so per-call
-- cost no longer scales with how large the day's total backlog is.
create or replace function public.retention_collapse_non_chart_daily_batch(batch_size integer default 1000)
returns integer
language plpgsql
as $function$
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

  with excess_groups as (
    select t.token_id, t.metric_id, t.provider_id
    from public.token_metric_observations t
    where t.observed_at >= target_day
      and t.observed_at < target_day + interval '1 day'
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
        or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
      )
    group by t.token_id, t.metric_id, t.provider_id
    having count(*) > 1
    -- Bounds this call's work to batch_size groups, not batch_size rows: each group
    -- is a handful of rows at most, so ranking just these groups' rows stays cheap
    -- regardless of how large the day's total backlog is.
    limit greatest(batch_size, 0)
  ),
  canonical as (
    select g.token_id, g.metric_id, g.provider_id, c.id as canonical_id
    from excess_groups g
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id = g.token_id
        and t.metric_id = g.metric_id
        and t.provider_id = g.provider_id
        and t.observed_at >= target_day
        and t.observed_at < target_day + interval '1 day'
      order by abs(extract(epoch from (t.observed_at - target_day))), t.id
      limit 1
    ) c
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    join canonical c on c.token_id = t.token_id and c.metric_id = t.metric_id and c.provider_id = t.provider_id
    where t.observed_at >= target_day
      and t.observed_at < target_day + interval '1 day'
      and t.id <> c.canonical_id
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
