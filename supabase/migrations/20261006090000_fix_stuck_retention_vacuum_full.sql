-- The tokensam-retention-vacuum-full job's command was changed directly against the live
-- database (outside of migration history -- it no longer matched either migration that touches
-- this job) to:
--
--   SET statement_timeout = '15min'; VACUUM FULL public.token_metric_observations;
--
-- pg_cron runs a multi-statement command inside an implicit transaction block, and VACUUM (full or
-- otherwise) cannot run inside a transaction block. Every single invocation since has failed
-- immediately with "ERROR:  VACUUM cannot run inside a transaction block" (confirmed via
-- cron.job_run_details). manage_retention_full_vacuum() then saw latest_status = 'failed' on the
-- next retention-cron tick and deactivated the job (treating "ran and errored" the same as "ran
-- and finished"), and re-arming only happens once db_bytes drops back below the 450MB rearm
-- threshold -- which never happened, since VACUUM FULL never actually ran. The database has been
-- stuck above the 470MB trigger threshold (542MB at last check) with the job permanently
-- deactivated and never re-arming.
--
-- Fix: restore the job to the single statement it was in both prior migrations (no inline SET --
-- a multi-statement command is never valid for a VACUUM job under pg_cron), then re-arm and
-- immediately re-evaluate the current database size so the job reactivates without waiting for
-- the next retention-cron tick.
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
    'VACUUM FULL public.token_metric_observations;',
    null,
    null,
    null
  );
end $$;

update public.retention_vacuum_state
set armed = true,
    updated_at = now()
where id = true;

select public.manage_retention_full_vacuum();
