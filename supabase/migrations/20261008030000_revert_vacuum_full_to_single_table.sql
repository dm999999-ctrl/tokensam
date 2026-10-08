-- 20261007150000 widened the level-triggered VACUUM FULL job to cover both
-- token_metric_observations and raw_provider_records in one statement, to reclaim
-- raw_provider_records' dead-tuple bloat too. That turned out to jeopardize the far more
-- critical token_metric_observations vacuum: caught live on 2026-10-08, the combined job
-- started repeatedly failing -- one attempt ran a full 10 minutes (after an earlier fix
-- raised statement_timeout from 2 to 5 to 10 minutes trying to give it enough room) and
-- still hit the timeout, with attempt_count climbing toward the 6-attempt exhaustion
-- limit while the database sat at or above the 500MB free-plan hard cap.
--
-- pg_stat_activity showed no lock-blocking on the VACUUM FULL backend itself, but a
-- concurrent autovacuum ANALYZE on raw_provider_records had been running for over an
-- hour at the same time, competing for I/O/CPU on the same tables VACUUM FULL now also
-- needed to rewrite in the same statement. Before the widening, this job reliably
-- finished in 20-47 seconds covering token_metric_observations alone.
--
-- Reverted: the job goes back to token_metric_observations only, the one actually
-- bounded by the 500MB hard cap. raw_provider_records' dead-tuple bloat is a much
-- smaller problem (its own ordinary autovacuum keeps it from growing unbounded; it just
-- won't be returned to the OS as aggressively) and not worth risking the job that
-- protects the real constraint. Reapplied directly against veyvdpypbuguydldhnwq via
-- cron.alter_job (not a plain UPDATE on cron.job -- that has hung through this session's
-- SQL tool all day the same way DELETE has) and a matching update to
-- manage_retention_full_vacuum()'s expected_command, so its own self-heal does not
-- revert this back to the wide command on its next run.
begin;

select cron.alter_job(
  (select jobid from cron.job where jobname = 'tokensam-retention-vacuum-full'),
  null,
  'VACUUM (FULL, ANALYZE) public.token_metric_observations;',
  null, null, null
);

create or replace function public.manage_retention_full_vacuum()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  db_bytes bigint := pg_database_size(current_database());
  threshold_bytes bigint := 450 * 1024 * 1024;
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
      perform cron.alter_job(full_job_id, null, null, null, null, true);
      update public.retention_vacuum_state
      set last_triggered_at = now(),
          last_triggered_bytes = db_bytes,
          attempt_count = 0,
          updated_at = now()
      where id = true;
      action := 'activated';

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
--   select command from cron.job where jobname = 'tokensam-retention-vacuum-full';
--   select public.manage_retention_full_vacuum();
