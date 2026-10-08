-- tokensam-retention-vacuum-full currently runs VACUUM FULL once when triggered and
-- treats "ran and errored" the same as "ran and finished": manage_retention_full_vacuum
-- deactivates the job either way (see 20261003090441), which is exactly the bug
-- 20261006090000 fixed once already (a hand-edited multi-statement job command made
-- every attempt fail with "VACUUM cannot run inside a transaction block", and the job
-- went permanently inert because failure and success were handled identically). There
-- is still no mechanism for "it failed, diagnose why, retry differently" -- any future
-- failure (a timeout, lock contention, a full disk) permanently disarms the job again
-- until someone notices and re-arms it by hand.
--
-- This replaces the single raw VACUUM FULL command with CALL
-- public.retention_vacuum_full_attempt(), pg_cron's documented pattern for commands
-- that cannot run inside a transaction block: a procedure invoked by a top-level CALL
-- is not wrapped in pg_cron's usual implicit transaction, so it can COMMIT internally
-- and then run VACUUM as the first statement of a fresh transaction -- with a
-- statement_timeout/lock_timeout set just before it, chosen per-attempt from state
-- instead of fixed. An EXCEPTION block cannot wrap the VACUUM call itself (PL/pgSQL's
-- EXCEPTION clause opens an implicit subtransaction, which VACUUM is equally forbidden
-- inside), so a failure still aborts the CALL the same way the raw command did before;
-- what changes is manage_retention_full_vacuum now classifies that failure's
-- return_message (already captured by cron.job_run_details) and adapts the next
-- attempt's budget instead of just giving up.
begin;

alter table public.retention_vacuum_state
  add column if not exists attempt_count int not null default 0,
  add column if not exists exhausted boolean not null default false,
  add column if not exists last_failure_type text,
  add column if not exists last_failure_message text,
  add column if not exists next_statement_timeout_seconds int not null default 120,
  add column if not exists next_lock_timeout_seconds int not null default 10;

create or replace procedure public.retention_vacuum_full_attempt()
language plpgsql
as $procedure$
declare
  timeout_s int;
  lock_s int;
begin
  select coalesce(next_statement_timeout_seconds, 120), coalesce(next_lock_timeout_seconds, 10)
  into timeout_s, lock_s
  from public.retention_vacuum_state
  where id = true;

  update public.retention_vacuum_state
  set attempt_count = attempt_count + 1,
      updated_at = now()
  where id = true;

  -- Ends the implicit transaction this top-level CALL started. The attempt-count
  -- increment above is now durable regardless of whether VACUUM below succeeds --
  -- required because VACUUM cannot run inside a transaction block at all (an
  -- EXCEPTION handler here would not help either; see the migration header).
  commit;

  execute format('set statement_timeout = %L', (timeout_s * 1000)::text || 'ms');
  execute format('set lock_timeout = %L', (lock_s * 1000)::text || 'ms');
  execute 'vacuum (full, analyze) public.token_metric_observations';

  -- Reached only if VACUUM above succeeded; an error aborts the CALL before this runs,
  -- and pg_cron records that as this job run's own failed status + return_message.
  update public.retention_vacuum_state
  set attempt_count = 0,
      exhausted = false,
      last_failure_type = null,
      last_failure_message = null,
      next_statement_timeout_seconds = 120,
      next_lock_timeout_seconds = 10,
      updated_at = now()
  where id = true;
end;
$procedure$;

grant execute on procedure public.retention_vacuum_full_attempt() to service_role;

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
  max_statement_timeout_s constant int := 900;
  max_lock_timeout_s constant int := 60;
  expected_command constant text := 'CALL public.retention_vacuum_full_attempt()';
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
  -- until someone noticed the database had been stuck above threshold for days. Keep
  -- it pinned to the procedure call every time this function runs, not just once.
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
        next_statement_timeout_seconds = 120,
        next_lock_timeout_seconds = 10,
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
          next_statement_timeout_seconds = 120,
          next_lock_timeout_seconds = 10,
          updated_at = now()
      where id = true;
      action := 'full_vacuum_completed_and_deactivated';

    else
      -- latest_status = 'failed': classify the reason instead of treating every
      -- failure identically (the bug this whole mechanism exists to not repeat).
      failure_type := case
        when latest_message ilike '%statement timeout%' then 'statement_timeout'
        when latest_message ilike '%lock timeout%' or latest_message ilike '%could not obtain lock%' or latest_message ilike '%could not acquire lock%' then 'lock_contention'
        when latest_message ilike '%deadlock detected%' then 'deadlock'
        when latest_message ilike '%no space left%' or latest_message ilike '%could not extend file%' or latest_message ilike '%disk full%' then 'disk_full'
        when latest_message ilike '%transaction block%' then 'transaction_block_misconfig'
        else 'unknown'
      end;

      if failure_type = 'disk_full' or state_row.attempt_count >= max_attempts then
        -- A full disk cannot be fixed by retrying (VACUUM FULL needs free space
        -- roughly equal to the table's current size to rewrite into); max_attempts
        -- protects against retrying an unrecognized failure forever.
        perform cron.alter_job(full_job_id, null, null, null, null, false);
        update public.retention_vacuum_state
        set exhausted = true,
            armed = false,
            last_failure_type = failure_type,
            last_failure_message = latest_message,
            updated_at = now()
        where id = true;
        action := 'full_vacuum_exhausted_and_deactivated';
      else
        -- Job stays active: its next tick (every 5 min, see the offset migration)
        -- retries with the adjusted budget below, which the procedure reads for itself.
        update public.retention_vacuum_state
        set last_failure_type = failure_type,
            last_failure_message = latest_message,
            next_statement_timeout_seconds = case
              when failure_type = 'statement_timeout'
                then least(greatest(state_row.next_statement_timeout_seconds, 120) * 2, max_statement_timeout_s)
              else state_row.next_statement_timeout_seconds
            end,
            next_lock_timeout_seconds = case
              when failure_type = 'lock_contention'
                then least(greatest(state_row.next_lock_timeout_seconds, 10) + 10, max_lock_timeout_s)
              else state_row.next_lock_timeout_seconds
            end,
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
    'next_statement_timeout_seconds', (select next_statement_timeout_seconds from public.retention_vacuum_state where id = true),
    'next_lock_timeout_seconds', (select next_lock_timeout_seconds from public.retention_vacuum_state where id = true),
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
    'CALL public.retention_vacuum_full_attempt()',
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
    next_statement_timeout_seconds = 120,
    next_lock_timeout_seconds = 10,
    updated_at = now()
where id = true;

commit;

-- Verify:
--   select * from public.retention_vacuum_state;
--   call public.retention_vacuum_full_attempt(); -- direct smoke test, outside the threshold gate
--   select public.manage_retention_full_vacuum();
