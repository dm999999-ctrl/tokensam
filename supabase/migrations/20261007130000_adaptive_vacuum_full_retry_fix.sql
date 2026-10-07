-- 20261007120000 tried to make tokensam-retention-vacuum-full's failure recovery
-- adaptive by switching its command to CALL
-- public.retention_vacuum_full_attempt(), a procedure that would COMMIT internally and
-- then run VACUUM with a per-attempt statement_timeout/lock_timeout. That assumption
-- was wrong for this environment: calling the procedure directly failed with
-- "VACUUM cannot be executed from a function", and a minimal reproduction confirmed
-- COMMIT itself is rejected ("invalid transaction termination") in the session context
-- available here -- whatever genuinely top-level, non-atomic CALL context pg_cron's own
-- background worker may or may not provide, it could not be verified safe to rely on
-- without risking silently breaking this job again, which is exactly the failure mode
-- this mechanism exists to prevent. A follow-up attempt to adapt per-attempt timeouts by
-- switching which role runs the job (cron.alter_job's username, pointing at roles with
-- different rolconfig statement_timeout) was abandoned mid-test when DROP ROLE itself
-- hung against this live database -- not a risk worth carrying further for a failure
-- mode (statement timeout) this job has never actually hit. Every real run of this job
-- has succeeded except the one-time command-drift bug 20261006090000 already fixed, so
-- pg_cron's own default budget for it has never actually been the problem.
--
-- This replaces that attempt with something verified safe: the job's command goes back
-- to the single plain statement already proven to work via pg_cron (no procedure, no
-- role switching, no per-attempt SET). What "adapts" is the decision of whether to keep
-- retrying at all, based on the classified failure reason -- not how the retry itself
-- is tuned:
--   - command drift (the actual failure that has happened) -> self-healed, retried
--   - disk_full -> retrying cannot fix a full disk (VACUUM FULL needs free space
--     roughly equal to the table's size to rewrite into) -> stop immediately, alert
--   - lock contention / deadlock / statement timeout / unrecognized -> transient,
--     left to retry on the job's own 5-minute schedule, bounded by max_attempts,
--     then stop and alert
-- DROP PROCEDURE and DROP COLUMN both hung indefinitely against this live database
-- when applying this migration (no lock contention visible in pg_locks at the time;
-- most likely transient infrastructure latency rather than a genuine blocker, but not
-- worth another round of retries against production to find out). Neither drop is
-- functionally necessary: retention_vacuum_full_attempt() is simply never called once
-- the job command below stops referencing it, and the two unused columns are dead
-- weight, not a correctness risk. Both are left in place; a future migration can drop
-- them once this one's effect has been confirmed stable.
begin;

alter table public.retention_vacuum_state
  -- Tracks run identity (start_time), not failure message text: an early draft of
  -- this migration compared message text to decide whether a failed run had already
  -- been counted toward max_attempts, which silently stopped counting the moment two
  -- consecutive failures produced the identical message -- exactly the case
  -- max_attempts exists to catch (e.g. the same "statement timeout" error repeating).
  add column if not exists last_processed_run_at timestamptz;

create or replace function public.manage_retention_full_vacuum()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  db_bytes bigint := pg_database_size(current_database());
  threshold_bytes bigint := 470 * 1024 * 1024;
  rearm_bytes bigint := 450 * 1024 * 1024;
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
  -- for days before anyone noticed. Keep it pinned to the known-working single
  -- statement every time this function runs, not just once.
  if job_command is distinct from expected_command then
    perform cron.alter_job(full_job_id, null, expected_command, null, null, null);
  end if;

  select start_time, status, return_message
  into latest_run, latest_status, latest_message
  from cron.job_run_details
  where jobid = full_job_id
  order by start_time desc
  limit 1;

  if db_bytes < rearm_bytes then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    update public.retention_vacuum_state
    set armed = true,
        attempt_count = 0,
        exhausted = false,
        last_failure_type = null,
        last_failure_message = null,
        updated_at = now()
    where id = true;
    action := case when job_active then 'rearmed_and_deactivated' else 'rearmed' end;

  elsif not state_row.armed
        and latest_run is not null
        and state_row.last_triggered_at is not null
        and latest_run >= state_row.last_triggered_at
        and latest_status in ('succeeded', 'failed')
        and job_active then

    if latest_status = 'succeeded' then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
      update public.retention_vacuum_state
      set attempt_count = 0,
          exhausted = false,
          last_failure_type = null,
          last_failure_message = null,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'full_vacuum_completed_and_deactivated';

    elsif state_row.last_processed_run_at is null
          or latest_run > state_row.last_processed_run_at then
      -- A failed run this function has not already accounted for (guarded by run
      -- identity -- start_time -- not by message text, so two consecutive failures
      -- with the identical message still both count toward max_attempts).
      failure_type := case
        when latest_message ilike '%statement timeout%' then 'statement_timeout'
        when latest_message ilike '%lock timeout%' or latest_message ilike '%could not obtain lock%' or latest_message ilike '%could not acquire lock%' then 'lock_contention'
        when latest_message ilike '%deadlock detected%' then 'deadlock'
        when latest_message ilike '%no space left%' or latest_message ilike '%could not extend file%' or latest_message ilike '%disk full%' then 'disk_full'
        when latest_message ilike '%transaction block%' or latest_message ilike '%executed from a function%' then 'command_misconfig'
        else 'unknown'
      end;

      if failure_type = 'disk_full' or state_row.attempt_count + 1 >= max_attempts then
        -- A full disk cannot be fixed by retrying; max_attempts protects against
        -- retrying an unrecognized failure forever.
        perform cron.alter_job(full_job_id, null, null, null, null, false);
        update public.retention_vacuum_state
        set exhausted = true,
            armed = false,
            attempt_count = state_row.attempt_count + 1,
            last_failure_type = failure_type,
            last_failure_message = latest_message,
            last_processed_run_at = latest_run,
            updated_at = now()
        where id = true;
        action := 'full_vacuum_exhausted_and_deactivated:' || failure_type;
      else
        -- Job stays active: its next tick (every 5 min) retries automatically with
        -- the same, known-good command -- no per-attempt tuning is applied (see the
        -- migration header for why), just a bounded number of further tries before
        -- giving up and alerting.
        update public.retention_vacuum_state
        set attempt_count = state_row.attempt_count + 1,
            last_failure_type = failure_type,
            last_failure_message = latest_message,
            last_processed_run_at = latest_run,
            updated_at = now()
        where id = true;
        action := 'full_vacuum_failed_retry_scheduled:' || failure_type;
      end if;
    end if;

  elsif db_bytes >= threshold_bytes and state_row.armed and not state_row.exhausted then
    perform cron.alter_job(full_job_id, null, null, null, null, true);
    update public.retention_vacuum_state
    set armed = false,
        last_triggered_at = now(),
        last_triggered_bytes = db_bytes,
        attempt_count = 0,
        updated_at = now()
    where id = true;
    action := 'full_vacuum_activated';

  elsif db_bytes >= threshold_bytes and state_row.exhausted then
    action := 'waiting_for_manual_reset_exhausted';

  elsif not state_row.armed and not job_active then
    action := 'waiting_for_rearm_below_450mb';
  end if;

  return jsonb_build_object(
    'db_bytes', db_bytes,
    'db_size', pg_size_pretty(db_bytes),
    'threshold_bytes', threshold_bytes,
    'threshold', pg_size_pretty(threshold_bytes),
    'rearm_bytes', rearm_bytes,
    'rearm_threshold', pg_size_pretty(rearm_bytes),
    'job_id', full_job_id,
    'job_active', (select active from cron.job where jobid = full_job_id),
    'armed', (select armed from public.retention_vacuum_state where id = true),
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

do $$
declare
  full_job_id bigint;
begin
  select jobid into full_job_id
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full';

  if full_job_id is null then
    raise exception 'tokensam-retention-vacuum-full job is missing';
  end if;

  perform cron.alter_job(
    full_job_id,
    null,
    'VACUUM (FULL, ANALYZE) public.token_metric_observations;',
    null,
    null,
    null
  );
end $$;

update public.retention_vacuum_state
set attempt_count = 0,
    exhausted = false,
    last_failure_type = null,
    last_failure_message = null,
    updated_at = now()
where id = true;

commit;

-- Verify:
--   select command, active from cron.job where jobname = 'tokensam-retention-vacuum-full';
--   select * from public.retention_vacuum_state;
--   select public.manage_retention_full_vacuum();
