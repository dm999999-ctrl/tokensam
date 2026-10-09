do $migration$
declare
  aggregate_job_id bigint;
begin
  select jobid into aggregate_job_id
  from cron.job
  where jobname = 'tokensam-non-chart-daily-aggregation'
  limit 1;

  if aggregate_job_id is null then
    perform cron.schedule(
      'tokensam-non-chart-daily-aggregation',
      '*/5 * * * *',
      'select public.retention_collapse_non_chart_daily_batch(80);'
    );
  else
    perform cron.alter_job(
      aggregate_job_id,
      '*/5 * * * *',
      'select public.retention_collapse_non_chart_daily_batch(80);',
      null,
      null,
      true
    );
  end if;
end;
$migration$;