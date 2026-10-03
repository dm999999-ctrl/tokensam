-- Retention maintenance jobs:
-- - every 5 minutes: normal VACUUM/ANALYZE of retention-heavy tables
-- - full VACUUM is managed separately by manage_retention_full_vacuum()
--   and is activated only when the physical DB reaches 470 MB.
create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'tokensam-retention-vacuum';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'tokensam-retention-vacuum',
    '*/5 * * * *',
    'VACUUM (ANALYZE) public.token_metric_observations;'
  );
end $$;
