-- Reconciliation migration: manage_retention_full_vacuum() and retention_vacuum_state have been
-- edited directly against the live database multiple times since 20261007150000 (the last version
-- checked into this repo) -- migrations 20261008040000_gate_vacuum_full_on_dead_tuple_bloat,
-- 20261009055138_retention_vacuum_requires_bloat_and_size, 20261009060410_retention_vacuum_minimum_450_mib,
-- 20261009131124_safe_threshold_vacuum_controller, 20261009131452_lower_vacuum_bloat_threshold_to_10_mib,
-- and 20261009131507_set_vacuum_bloat_threshold_to_15_mib were all applied live and never committed
-- here (confirmed via mcp__Supabase__list_migrations against the project, which lists them; this
-- repo's supabase/migrations/ does not). This migration brings the checked-in schema/function back
-- in line with what is actually running, captured verbatim via pg_get_functiondef() against the
-- live project on 2026-10-11, rather than re-deriving it from any of those missing files (most of
-- which were superseded by later ones anyway).
--
-- Current live behavior this captures:
--  - VACUUM FULL now only fires when BOTH the database is >= 450MB AND estimated dead-tuple bloat
--    across public.* tables is >= 15MB (should_run), not on database size alone.
--  - Bloat is computed live each call from pg_stat_user_tables (n_dead_tup / (n_live_tup+n_dead_tup)
--    * relpages * block_size), summed across all public schema tables -- not hardcoded to
--    token_metric_observations/raw_provider_records specifically.
--  - When should_run and the job isn't already active, the VACUUM command is built dynamically from
--    whichever public tables currently have n_dead_tup > 0, rather than a fixed two-table command.
--  - Failures are classified by return_message (statement_timeout/lock_contention/deadlock/
--    disk_full/command_misconfig/unknown) and retried up to 6 attempts; disk_full or the 6th
--    attempt marks the state "exhausted" and deactivates the job pending manual review -- it will
--    not retry itself indefinitely.
--  - retention_vacuum_state gained attempt_count, exhausted, last_failure_type,
--    last_failure_message, last_processed_run_at, next_statement_timeout_seconds, and
--    next_lock_timeout_seconds columns (the latter two are carried on the row but not currently
--    read by this function body -- left as-is rather than guessed at, since removing columns another
--    piece of live logic might still reference would be the more dangerous ambiguity to resolve
--    silently).
--
-- This migration is additive/idempotent only (add column if not exists, create or replace
-- function) specifically so applying it against the already-patched live database is a no-op there,
-- while bringing any OTHER environment (a fresh database, another developer's local Supabase) up to
-- the same live behavior.

alter table public.retention_vacuum_state
  add column if not exists attempt_count integer not null default 0,
  add column if not exists exhausted boolean not null default false,
  add column if not exists last_failure_type text,
  add column if not exists last_failure_message text,
  add column if not exists next_statement_timeout_seconds integer not null default 120,
  add column if not exists next_lock_timeout_seconds integer not null default 10,
  add column if not exists last_processed_run_at timestamptz;

create or replace function public.manage_retention_full_vacuum()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  db_bytes bigint := pg_database_size(current_database());
  threshold_bytes bigint := 450 * 1024 * 1024;
  bloat_floor_bytes bigint := 15 * 1024 * 1024;
  max_attempts constant integer := 6;
  state_row public.retention_vacuum_state%rowtype;
  full_job_id bigint;
  latest_run timestamptz;
  latest_status text;
  latest_message text;
  job_active boolean;
  job_command text;
  vacuum_command text;
  tables_to_vacuum text;
  action text := 'none';
  failure_type text := null;
  is_new_run boolean;
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

  select start_time, status, return_message
  into latest_run, latest_status, latest_message
  from cron.job_run_details
  where jobid = full_job_id
  order by start_time desc
  limit 1;

  is_new_run := latest_run is not null
    and (state_row.last_processed_run_at is null or latest_run > state_row.last_processed_run_at);

  select coalesce(sum(
    case when coalesce(s.n_live_tup, 0) + coalesce(s.n_dead_tup, 0) > 0
      then (coalesce(s.n_dead_tup, 0)::numeric
        / (coalesce(s.n_live_tup, 0) + coalesce(s.n_dead_tup, 0)))
        * (c.relpages::bigint * current_setting('block_size')::bigint)
      else 0
    end
  ), 0)::bigint
  into bloat_bytes
  from pg_stat_user_tables s
  join pg_class c on c.oid = s.relid
  where s.schemaname = 'public';

  should_run := db_bytes >= threshold_bytes and bloat_bytes >= bloat_floor_bytes;

  if state_row.exhausted then
    action := 'waiting_for_manual_reset_exhausted';

  elsif is_new_run and latest_status = 'succeeded' then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    update public.retention_vacuum_state
    set armed = (bloat_bytes < bloat_floor_bytes),
        attempt_count = 0,
        last_failure_type = null,
        last_failure_message = null,
        last_processed_run_at = latest_run,
        updated_at = now()
    where id = true;
    action := case when bloat_bytes < bloat_floor_bytes
      then 'completed_rearmed_below_threshold'
      else 'completed_waiting_for_bloat_to_fall_below_threshold' end;

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
      if job_active then
        perform cron.alter_job(full_job_id, null, null, null, null, false);
      end if;
      update public.retention_vacuum_state
      set armed = false,
          exhausted = true,
          attempt_count = state_row.attempt_count + 1,
          last_failure_type = failure_type,
          last_failure_message = latest_message,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'stopped_after_failure_manual_review_required:' || failure_type;
    else
      update public.retention_vacuum_state
      set attempt_count = state_row.attempt_count + 1,
          last_failure_type = failure_type,
          last_failure_message = latest_message,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'retrying_after_failure:' || failure_type;
    end if;

  elsif not should_run then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    update public.retention_vacuum_state
    set armed = case when bloat_bytes < bloat_floor_bytes then true else armed end,
        attempt_count = case when bloat_bytes < bloat_floor_bytes then 0 else attempt_count end,
        last_failure_type = case when bloat_bytes < bloat_floor_bytes then null else last_failure_type end,
        last_failure_message = case when bloat_bytes < bloat_floor_bytes then null else last_failure_message end,
        updated_at = now()
    where id = true;
    action := case
      when db_bytes < threshold_bytes then 'waiting_for_database_size_and_bloat_thresholds'
      when bloat_bytes < bloat_floor_bytes then 'armed_waiting_for_bloat_threshold_crossing'
      else 'waiting_for_thresholds'
    end;

  elsif not state_row.armed then
    action := 'waiting_for_bloat_to_fall_below_threshold_before_rearming';

  elsif not job_active then
    select string_agg(format('%I.%I', s.schemaname, s.relname), ', ' order by s.schemaname, s.relname)
    into tables_to_vacuum
    from pg_stat_user_tables s
    where s.schemaname = 'public'
      and s.n_dead_tup > 0;

    if tables_to_vacuum is null then
      action := 'threshold_met_but_no_public_dead_tuple_tables_found';
    else
      vacuum_command := 'VACUUM (FULL, ANALYZE) ' || tables_to_vacuum || ';';
      perform cron.alter_job(full_job_id, null, vacuum_command, null, null, true);
      update public.retention_vacuum_state
      set last_triggered_at = now(),
          last_triggered_bytes = db_bytes,
          updated_at = now()
      where id = true;
      action := 'activated_for_public_tables';
    end if;

  else
    action := 'vacuum_job_active_waiting_for_result';
  end if;

  return jsonb_build_object(
    'db_bytes', db_bytes,
    'db_size', pg_size_pretty(db_bytes),
    'database_threshold', pg_size_pretty(threshold_bytes),
    'bloat_bytes', bloat_bytes,
    'bloat_estimate', pg_size_pretty(bloat_bytes),
    'bloat_threshold', pg_size_pretty(bloat_floor_bytes),
    'bloat_scope', 'public application tables',
    'should_run', should_run,
    'tables_to_vacuum', tables_to_vacuum,
    'job_id', full_job_id,
    'job_active', (select active from cron.job where jobid = full_job_id),
    'armed', (select armed from public.retention_vacuum_state where id = true),
    'exhausted', (select exhausted from public.retention_vacuum_state where id = true),
    'attempt_count', (select attempt_count from public.retention_vacuum_state where id = true),
    'last_failure_type', (select last_failure_type from public.retention_vacuum_state where id = true),
    'latest_run', latest_run,
    'latest_status', latest_status,
    'action', action
  );
end;
$function$;

revoke all on function public.manage_retention_full_vacuum() from public;
grant execute on function public.manage_retention_full_vacuum() to service_role;
