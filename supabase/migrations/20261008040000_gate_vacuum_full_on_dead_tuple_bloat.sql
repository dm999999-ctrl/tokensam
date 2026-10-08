-- VACUUM FULL was firing purely on db_bytes >= 450MB, regardless of whether there was
-- actually anything to reclaim. Checked live, repeatedly, on 2026-10-08:
-- token_metric_observations' n_dead_tup was consistently low (0-3,396 rows) across most
-- checks -- meaning most triggered runs had almost no dead-tuple bloat to remove, so the
-- expensive full table+index rewrite (confirmed via pg_stat_activity: genuine
-- wait_event_type=IO/DataFileRead, not lock contention) bought very little size
-- reduction for its cost. The database kept re-crossing 450MB right after a vacuum
-- precisely because the size pressure was from live data growth, which VACUUM FULL
-- cannot address at all -- only retention can.
--
-- Gate the actual run on estimated dead-tuple bloat, not just size: the job arms at
-- 450MB as before, but only activates once a cheap estimate of reclaimable bytes
-- (n_dead_tup x average live row width) crosses a meaningful floor. A safety override
-- still forces a run regardless of bloat if size gets close to the 500MB hard cap, so
-- this can never wait indefinitely while genuinely running out of room.
--
-- Two deliberate choices to keep this safe to call while a VACUUM FULL is already
-- running (manage_retention_full_vacuum is invoked every 5 minutes by the retention
-- cron route regardless of job state):
--   - The bloat estimate is computed from pg_class.relpages (a plain catalog column,
--     last updated by ANALYZE) rather than pg_relation_size(), which needs a lock
--     compatibility check against the table and was confirmed live to hang while VACUUM
--     FULL holds its ACCESS EXCLUSIVE lock -- an earlier version of this migration used
--     pg_relation_size() and blocked this function's own routine calls while a vacuum
--     was in progress, discovered applying it live.
--   - The whole bloat computation only happens in the branch that actually needs it
--     (db_bytes >= threshold and the job isn't already active), not unconditionally at
--     the top of the function, so a call made while VACUUM FULL is running never touches
--     table-dependent catalog state it doesn't need.
begin;

create or replace function public.manage_retention_full_vacuum()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  db_bytes bigint := pg_database_size(current_database());
  threshold_bytes bigint := 450 * 1024 * 1024;
  -- Minimum estimated dead-tuple bloat worth paying for a full rewrite.
  bloat_floor_bytes bigint := 25 * 1024 * 1024;
  -- Independent of bloat: never let size alone get this close to the 500MB hard cap
  -- without forcing a run, however little there is to reclaim.
  safety_bytes bigint := 490 * 1024 * 1024;
  max_attempts constant int := 6;
  expected_command constant text := 'VACUUM (FULL, ANALYZE) public.token_metric_observations;';
  state_row public.retention_vacuum_state%rowtype;
  full_job_id bigint;
  latest_run timestamptz;
  latest_status text;
  latest_message text;
  job_active boolean;
  job_command text;
  action text := 'none';
  failure_type text := null;
  is_new_run boolean;
  n_live bigint;
  n_dead bigint;
  heap_bytes bigint;
  bloat_bytes bigint;
  should_run boolean;
begin
  select * into state_row
  from public.retention_vacuum_state
  where id = true
  for update;

  select jobid, active, command
  into full_job_id, job_active, job_command
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full'
  limit 1;

  if full_job_id is null then
    raise exception 'tokensam-retention-vacuum-full job is missing';
  end if;

  if job_command is distinct from expected_command then
    perform cron.alter_job(full_job_id, null, expected_command, null, null, null);
  end if;

  select start_time, status, return_message
  into latest_run, latest_status, latest_message
  from cron.job_run_details
  where jobid = full_job_id
  order by start_time desc
  limit 1;

  is_new_run := latest_run is not null
    and (state_row.last_processed_run_at is null or latest_run > state_row.last_processed_run_at);

  if state_row.exhausted then
    action := 'waiting_for_manual_reset_exhausted';

  elsif db_bytes < threshold_bytes then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    if state_row.attempt_count <> 0 then
      update public.retention_vacuum_state
      set attempt_count = 0,
          last_failure_type = null,
          last_failure_message = null,
          updated_at = now()
      where id = true;
    end if;
    action := case when job_active then 'deactivated_below_threshold' else 'below_threshold' end;

  else
    if not job_active then
      -- Only computed here: a plain catalog read (pg_class.relpages, last updated by
      -- ANALYZE), never pg_relation_size(), so this never needs to wait on the table's
      -- own lock -- safe even if called while a VACUUM FULL on it happens to be running.
      select coalesce(s.n_live_tup, 0), coalesce(s.n_dead_tup, 0), c.relpages::bigint * current_setting('block_size')::bigint
      into n_live, n_dead, heap_bytes
      from pg_class c
      left join pg_stat_user_tables s on s.relid = c.oid
      where c.oid = 'public.token_metric_observations'::regclass;

      bloat_bytes := case when n_live + n_dead > 0
        then (n_dead::numeric / (n_live + n_dead) * heap_bytes)::bigint
        else 0
      end;
      should_run := bloat_bytes >= bloat_floor_bytes or db_bytes >= safety_bytes;

      if should_run then
        perform cron.alter_job(full_job_id, null, null, null, null, true);
        update public.retention_vacuum_state
        set last_triggered_at = now(),
            last_triggered_bytes = db_bytes,
            attempt_count = 0,
            updated_at = now()
        where id = true;
        action := 'activated:' || (case when db_bytes >= safety_bytes then 'safety_override' else 'bloat_floor_met' end);
      else
        action := 'armed_waiting_for_bloat';
      end if;

    elsif is_new_run and latest_status = 'succeeded' then
      update public.retention_vacuum_state
      set attempt_count = 0,
          last_failure_type = null,
          last_failure_message = null,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'tick_succeeded_still_above_threshold';

    elsif is_new_run and latest_status = 'failed' then
      failure_type := case
        when latest_message ilike '%statement timeout%' then 'statement_timeout'
        when latest_message ilike '%lock timeout%' or latest_message ilike '%could not obtain lock%' or latest_message ilike '%could not acquire lock%' then 'lock_contention'
        when latest_message ilike '%deadlock detected%' then 'deadlock'
        when latest_message ilike '%no space left%' or latest_message ilike '%could not extend file%' or latest_message ilike '%disk full%' then 'disk_full'
        when latest_message ilike '%transaction block%' or latest_message ilike '%executed from a function%' then 'command_misconfig'
        else 'unknown'
      end;

      if failure_type = 'disk_full' or state_row.attempt_count + 1 >= max_attempts then
        perform cron.alter_job(full_job_id, null, null, null, null, false);
        update public.retention_vacuum_state
        set exhausted = true,
            attempt_count = state_row.attempt_count + 1,
            last_failure_type = failure_type,
            last_failure_message = latest_message,
            last_processed_run_at = latest_run,
            updated_at = now()
        where id = true;
        action := 'full_vacuum_exhausted_and_deactivated:' || failure_type;
      else
        update public.retention_vacuum_state
        set attempt_count = state_row.attempt_count + 1,
            last_failure_type = failure_type,
            last_failure_message = latest_message,
            last_processed_run_at = latest_run,
            updated_at = now()
        where id = true;
        action := 'full_vacuum_failed_retry_scheduled:' || failure_type;
      end if;

    else
      action := 'already_running_above_threshold';
    end if;
  end if;

  return jsonb_build_object(
    'db_bytes', db_bytes,
    'db_size', pg_size_pretty(db_bytes),
    'threshold_bytes', threshold_bytes,
    'threshold', pg_size_pretty(threshold_bytes),
    'bloat_bytes', bloat_bytes,
    'bloat_size', case when bloat_bytes is not null then pg_size_pretty(bloat_bytes) else null end,
    'bloat_floor_bytes', bloat_floor_bytes,
    'bloat_floor', pg_size_pretty(bloat_floor_bytes),
    'safety_bytes', safety_bytes,
    'safety_threshold', pg_size_pretty(safety_bytes),
    'job_id', full_job_id,
    'job_active', (select active from cron.job where jobid = full_job_id),
    'exhausted', (select exhausted from public.retention_vacuum_state where id = true),
    'attempt_count', (select attempt_count from public.retention_vacuum_state where id = true),
    'last_failure_type', (select last_failure_type from public.retention_vacuum_state where id = true),
    'last_failure_message', (select last_failure_message from public.retention_vacuum_state where id = true),
    'last_triggered_at', (select last_triggered_at from public.retention_vacuum_state where id = true),
    'last_triggered_bytes', (select last_triggered_bytes from public.retention_vacuum_state where id = true),
    'latest_run', latest_run,
    'latest_status', latest_status,
    'latest_message', latest_message,
    'action', action
  );
end;
$function$;

revoke all on function public.manage_retention_full_vacuum() from public;
grant execute on function public.manage_retention_full_vacuum() to service_role;

commit;

-- Manual verification after applying:
--   select public.manage_retention_full_vacuum();
-- action should read "armed_waiting_for_bloat" while db_bytes >= 450MB but bloat_bytes
-- stays under bloat_floor_bytes (25MB), and "activated:bloat_floor_met" or
-- "activated:safety_override" once it actually starts the job. bloat_size/bloat_bytes
-- are null in the response whenever the job is already active, since that branch never
-- computes them (by design -- see the migration header).
