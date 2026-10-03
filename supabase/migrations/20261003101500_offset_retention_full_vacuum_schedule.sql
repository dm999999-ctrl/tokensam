-- Keep the five-minute retention cron and full-vacuum maintenance jobs from
-- starting at the same minute. VACUUM FULL takes ACCESS EXCLUSIVE on the
-- observations table, so overlapping it with retention deletes can cause the
-- retention RPC to hit its statement timeout.
--
-- Retention runs at the five-minute boundary (00,05,10,... UTC).
-- Full vacuum maintenance runs two minutes later (02,07,12,... UTC).
do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full';

  if existing_job_id is not null then
    perform cron.alter_job(
      existing_job_id,
      schedule => '2-59/5 * * * *'
    );
  else
    perform cron.schedule(
      'tokensam-retention-vacuum-full',
      '2-59/5 * * * *',
      'VACUUM FULL public.token_metric_observations;'
    );
  end if;
end $$;
