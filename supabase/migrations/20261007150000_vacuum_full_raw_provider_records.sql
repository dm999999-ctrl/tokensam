-- raw_provider_records holds only short-lived raw collector payloads (2-day retention,
-- see 20261001194500) and nothing on the dashboard, its charts, or the technical-indicator
-- / AI analysis engines reads from it -- confirmed by grep across src/lib before this
-- migration. Its deletes are already happening on schedule, but ordinary (non-FULL)
-- autovacuum only marks that space reusable for future inserts on the same table, it
-- never shrinks the file on disk, so ~10-20% of this table's measured size (115MB at
-- last check) was dead-tuple bloat sitting there permanently uncollected.
--
-- VACUUM accepts multiple tables in one statement (still a single statement, not the
-- semicolon-separated multi-statement form that broke this job silently before --
-- 20261006090000), so the existing level-triggered job is simply widened to cover both
-- tables instead of adding a second job.
begin;

update cron.job
set command = 'VACUUM (FULL, ANALYZE) public.token_metric_observations, public.raw_provider_records;'
where jobname = 'tokensam-retention-vacuum-full';

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
  expected_command constant text := 'VACUUM (FULL, ANALYZE) public.token_metric_observations, public.raw_provider_records;';
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

  -- Defensive self-heal: this job's command has been hand-edited directly against the
  -- live database before (20261006090000) in a way that broke every attempt silently
  -- for days before anyone noticed. Keep it pinned to the known-working statement every
  -- time this function runs, not just once.
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
