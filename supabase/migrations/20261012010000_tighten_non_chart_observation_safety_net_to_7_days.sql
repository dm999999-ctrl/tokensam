-- Tighten retention_expire_observations_batch's safety-net backstop for raw
-- (non-chart-history) token_metric_observations from 90 days down to 7 days.
--
-- This function is a ceiling, not the normal retention path: non-chart observations
-- are supposed to be collapsed into a single daily aggregate by
-- retention_aggregate_daily_observations(_, 'non_chart') same-day or next-day (see
-- that function), so under normal operation this backstop should rarely delete
-- anything older than a day or two. It only matters when collapse has fallen behind
-- (e.g. the false-positive gap-repair backfill loop fixed in
-- 20261012000000_gap_detection_excludes_collapsed_daily_aggregates.sql, which could
-- keep re-inserting non-chart-scoped raw rows faster than collapse could clear them).
--
-- Applied live on 2026-10-12 while the project was over its Supabase free-plan 500MB
-- database-size quota (0.539/0.5 GB, 108%) and VACUUM FULL had no further bloat left
-- to reclaim (confirmed: reclaimable bloat was down to ~185KB across the whole
-- public schema after the prior manual vacuum). Shrinking this backstop reduces the
-- worst-case exposure of any future collapse backlog, independent of whether the
-- gap-repair fix fully resolves the growth on its own.

create or replace function public.retention_expire_observations_batch(batch_size integer default 200)
returns integer
language sql
as $function$
  with doomed as (
    select id from public.token_metric_observations
    where observed_at < now() - interval '7 days'
    order by observed_at,id
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
