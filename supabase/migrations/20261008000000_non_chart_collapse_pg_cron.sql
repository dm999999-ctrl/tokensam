-- retention_collapse_non_chart_daily_batch was called from the app's /api/cron/retention
-- route via client.rpc(...) over PostgREST, whose `authenticator` role carries an ~8s
-- statement_timeout (pg_roles.rolconfig). That was workable while the table was small,
-- but by 2026-10-08 (token_metric_observations at 647K rows) even the function's
-- existence-check probe alone measured ~5.9s under the plan Postgres was actually
-- choosing for that day (EXPLAIN ANALYZE showed it picked provider_metric_history_lookup_idx
-- instead of the dedicated token_metric_observations_day_scan_idx -- the exact planner
-- instability 20261007090000 already fought once, recurring as the table grew further),
-- and the real GROUP BY/DELETE work that follows pushed every call over the 8s ceiling.
-- The resumable cursor (20261007110000) could not help: it only skips days with nothing
-- to do, so the one genuinely backlogged day just got re-probed and re-failed every
-- ~8-12 minutes indefinitely (confirmed live via cron.job_run_details: consecutive
-- "canceling statement due to statement timeout" failures going back hours), letting a
-- full day's worth of non-chart observations accumulate completely ungated and pushing
-- the database past the 500MB free-plan hard cap (measured live at 520MB).
--
-- Run directly via pg_cron instead -- the same fix already proven for VACUUM FULL
-- (20261006090000/20261007120000): a plain pg_cron job runs under a normal session's
-- default statement_timeout, not PostgREST's. Verified live: the identical query that
-- had been timing out on every attempt for hours completed in under a second once not
-- bound by PostgREST, and three manual calls cleared the entire backlog (127,239 rows)
-- in moments. run-retention.ts's RETENTION_FUNCTIONS list drops this function so the
-- app route stops making doomed 8s-bound calls to it.
begin;

select cron.schedule(
  'tokensam-non-chart-collapse',
  -- Every 2 minutes: a single call processes one day's backlog (up to 1000 groups) or
  -- advances the cursor past up to 8 already-collapsed days (see the function's own
  -- max_days_per_call), so this keeps pace with new data crossing into scope far faster
  -- than it accumulates, without needing to coordinate with the 5-minute VACUUM FULL or
  -- retention-route schedules.
  '*/2 * * * *',
  $$select public.retention_collapse_non_chart_daily_batch(1000);$$
);

commit;

-- Manual verification after applying:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'tokensam-non-chart-collapse';
--   select status, return_message, start_time, end_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'tokensam-non-chart-collapse')
--     order by start_time desc limit 5;
