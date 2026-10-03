create extension if not exists pg_cron;

create table if not exists public.retention_vacuum_state (
  id boolean primary key default true check (id),
  armed boolean not null default true,
  last_triggered_at timestamptz,
  last_triggered_bytes bigint,
  updated_at timestamptz not null default now()
);

insert into public.retention_vacuum_state (id)
values (true)
on conflict (id) do nothing;

do $$
declare
  existing_job_id bigint;
  new_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  select cron.schedule(
    'tokensam-retention-vacuum-full',
    '*/5 * * * *',
    'VACUUM FULL public.token_metric_observations;'
  )
  into new_job_id;

  perform cron.alter_job(
    new_job_id,
    null,
    null,
    null,
    null,
    false
  );
end $$;

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
  state_row public.retention_vacuum_state%rowtype;
  full_job_id bigint;
  latest_run timestamptz;
  latest_status text;
  job_active boolean;
  action text := 'none';
begin
  select * into state_row
  from public.retention_vacuum_state
  where id = true
  for update;

  select jobid, active
  into full_job_id, job_active
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full'
  limit 1;

  if full_job_id is null then
    raise exception 'tokensam-retention-vacuum-full job is missing';
  end if;

  select start_time, status
  into latest_run, latest_status
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
        updated_at = now()
    where id = true;

    action := case when job_active then 'rearmed_and_deactivated' else 'rearmed' end;
  elsif not state_row.armed
        and latest_run is not null
        and state_row.last_triggered_at is not null
        and latest_run >= state_row.last_triggered_at
        and latest_status in ('succeeded', 'failed')
        and job_active then
    perform cron.alter_job(full_job_id, null, null, null, null, false);
    action := case when latest_status = 'succeeded'
      then 'full_vacuum_completed_and_deactivated'
      else 'full_vacuum_failed_and_deactivated'
    end;
  elsif db_bytes >= threshold_bytes and state_row.armed then
    perform cron.alter_job(full_job_id, null, null, null, null, true);

    update public.retention_vacuum_state
    set armed = false,
        last_triggered_at = now(),
        last_triggered_bytes = db_bytes,
        updated_at = now()
    where id = true;

    action := 'full_vacuum_activated';
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
    'last_triggered_at', (select last_triggered_at from public.retention_vacuum_state where id = true),
    'last_triggered_bytes', (select last_triggered_bytes from public.retention_vacuum_state where id = true),
    'latest_run', latest_run,
    'latest_status', latest_status,
    'action', action
  );
end;
$function$;

revoke all on function public.manage_retention_full_vacuum() from public;
grant execute on function public.manage_retention_full_vacuum() to service_role;
