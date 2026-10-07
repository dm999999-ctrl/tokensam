-- 20261007080000_non_chart_collapse_day_scan_index.sql added
-- token_metric_observations_day_scan_idx (observed_at, provider_id, metric_id, token_id)
-- to let the day-finder loop's existence check range-scan one day instead of walking
-- the whole token_metric_latest_lookup_idx. The index alone doesn't help: the check was
-- written as
--
--   group by token_id, metric_id, provider_id
--   having count(*) > 1
--   limit 1
--
-- and Postgres won't use the new index for that shape. GROUP BY/HAVING/LIMIT 1 lets the
-- planner pick token_metric_latest_lookup_idx (already sorted to match the group key) on
-- the bet that the first qualifying group appears early and LIMIT 1 short-circuits
-- cheaply -- it never considers the new index, because using it would mean an explicit
-- sort before any group is known, which can't be cut short by LIMIT 1 and so looks
-- "unsafe" by comparison, even though it's usually far cheaper. Confirmed with
-- enable_bitmapscan=off: the plan still picks the old index unconditionally.
--
-- That bet is exactly wrong for the ~24-30 already-collapsed historical days the loop
-- has to rule out before it ever reaches a backlogged day: there's no group to find
-- early, so LIMIT 1 can't short-circuit and the full, expensive walk always runs.
--
-- Fix: replace the existence check with an equivalent scalar comparison that has no
-- LIMIT-shaped shortcut to tempt the planner toward the old index:
--
--   count(*) <> count(distinct (token_id, metric_id, provider_id))
--
-- True exactly when some group has more than one row (and false, correctly, on a day
-- with zero matching rows, since both counts are 0). EXPLAIN on this shape picks the new
-- index with a true Index Cond bounding both ends of the day, dropping cost from 17429 to
-- 1851 for the same day. The excess-group selection and deletion logic below the loop is
-- unchanged.
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
    select count(*) <> count(distinct (t.token_id, t.metric_id, t.provider_id))
    from public.token_metric_observations t
    where t.observed_at >= day_cursor
      and t.observed_at < day_cursor + interval '1 day'
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
        or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
      )
    into has_excess;

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

-- Verify:
--   select public.retention_collapse_non_chart_daily_batch(1000);
--   -- should now return promptly instead of timing out, and deleted_count should be > 0
--   -- while the Oct 6 backlog is being worked through.
