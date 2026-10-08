-- retention_collapse_non_chart_daily_batch's day-finder loop still fails in
-- production, even after 20261007080000 (the covering index) and 20261007090000
-- (rewriting the existence check to use it). Both were verified against an admin SQL
-- session with a 2-minute statement_timeout; the actual production call path goes
-- through PostgREST as the `authenticator` role, which pg_roles.rolconfig shows has
-- a hard 8-second statement_timeout -- much tighter than what was tested against.
--
-- Worse, the query planner's choice between the new index and the old ones turns out
-- to be unstable: EXPLAIN ANALYZE on the same historical day's existence check picked
-- the new index (cost 1851) immediately after the index was created, then picked the
-- old token_metric_observations_observed_at_idx (445ms, scanning and discarding 8760
-- rows) hours later as table statistics shifted with ongoing inserts/deletes. The
-- day-finder loop checks up to 31 days per call; a handful of unlucky plan choices
-- is enough to blow an 8-second budget regardless of which index exists.
--
-- Fighting the planner again is not a durable fix. The actual fix is architectural:
-- stop re-proving "this day is already clean" from scratch on every call. A resumable
-- cursor remembers the oldest day not yet confirmed clean and the loop starts there
-- instead of 31 days back, so an already-collapsed day is checked (and paid for)
-- exactly once, ever -- not once per call for as long as it stays collapsed.
--
-- An earlier draft of this fix persisted the cursor with an UPDATE inside the loop,
-- once per day confirmed clean, reasoning that later work timing out should not lose
-- earlier progress in the same call. That does not work: a plpgsql function body runs
-- inside its caller's transaction (here, the single transaction PostgREST wraps each
-- RPC call in), so a statement_timeout cancellation aborts that whole transaction --
-- every UPDATE already run inside it rolls back too, cursor advance included. The fix
-- actually used instead: cap how many days a single call will check
-- (MAX_DAYS_PER_CALL) to a number whose worst-case total time (all of them hitting
-- the slow, wrong-index path) still comfortably fits the 8-second budget, and persist
-- the cursor exactly once, after the loop, as part of the call's own normal
-- (non-timeout) commit. retention_collapse_non_chart_daily_batch already runs every
-- 5-10 minutes (see run-retention.ts / the tokensam-retention pg_cron job), so a
-- 31-day backlog catches up within a handful of calls even bounded this way.
begin;

create table if not exists public.retention_collapse_cursor_state (
  id boolean primary key default true check (id = true),
  -- The oldest UTC day this job has not yet confirmed clean (no excess rows). Starts
  -- 31 days back, same as the loop's old fixed starting point, so the first run after
  -- this migration behaves identically to before -- it just remembers its progress
  -- afterward instead of repeating it.
  cursor_day date not null default (current_date - 31),
  updated_at timestamptz not null default now()
);

insert into public.retention_collapse_cursor_state (id)
values (true)
on conflict (id) do nothing;

alter table public.retention_collapse_cursor_state enable row level security;
revoke all on table public.retention_collapse_cursor_state from anon, authenticated;
grant select, insert, update, delete on table public.retention_collapse_cursor_state to service_role;

create or replace function public.retention_collapse_non_chart_daily_batch(batch_size integer default 1000)
returns integer
language plpgsql
as $function$
declare
  -- 8 days worst-case at ~450ms/day (the slow, wrong-index path measured in
  -- production) is ~3.6s -- comfortably inside the authenticator role's 8s
  -- statement_timeout even with the excess_groups/delete step on top of it.
  max_days_per_call constant int := 8;
  day_limit timestamptz := date_trunc('day', now() at time zone 'UTC');
  floor_day timestamptz := day_limit - interval '31 days';
  day_cursor timestamptz;
  days_checked int := 0;
  target_day timestamptz;
  has_excess boolean;
  deleted_count int;
begin
  select greatest(floor_day, (cursor_day::timestamptz))
  into day_cursor
  from public.retention_collapse_cursor_state
  where id = true;

  -- Not a real condition in production (the seed row is inserted by this same
  -- migration and never deleted) -- keeps this function total if it is ever missing.
  if day_cursor is null then
    day_cursor := floor_day;
  end if;

  while day_cursor < day_limit and days_checked < max_days_per_call loop
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
    days_checked := days_checked + 1;
  end loop;

  -- Persisted once, as part of this call's own normal commit -- not inside the loop
  -- (see the note above on why a mid-loop UPDATE does not survive a timeout).
  -- Reflects exactly how far this call actually got: up to target_day if an excess
  -- day was found (not advanced past it, so the next call rechecks it), or as far as
  -- max_days_per_call/day_limit allowed otherwise.
  update public.retention_collapse_cursor_state
  set cursor_day = day_cursor::date, updated_at = now()
  where id = true;

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

commit;

-- Verify:
--   select cursor_day from public.retention_collapse_cursor_state;
--   select public.retention_collapse_non_chart_daily_batch(1000);
--   -- repeated calls should advance cursor_day forward (select cursor_day ... again)
--   -- without re-scanning days already confirmed clean, and complete in well under 8s
--   -- (set statement_timeout = '8s'; before the call to reproduce the production budget).
