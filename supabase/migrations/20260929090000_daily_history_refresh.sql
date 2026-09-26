-- Allow the automated refresh orchestrator to record two new step kinds:
-- 'coingecko_daily' and 'defillama_daily'. These are the scheduled daily-history
-- steps (src/lib/refresh/orchestrator.ts) that fetch the newest genuine
-- completed-UTC-day observation for Technical Analysis, separate from the
-- existing 'coingecko'/'defillama' steps which only refresh the current snapshot.
alter table public.data_refresh_steps drop constraint if exists data_refresh_steps_step_check;
alter table public.data_refresh_steps add constraint data_refresh_steps_step_check
  check (step in ('coingecko', 'defillama', 'dexscreener', 'defillama_coins', 'coingecko_daily', 'defillama_daily', 'metrics'));
