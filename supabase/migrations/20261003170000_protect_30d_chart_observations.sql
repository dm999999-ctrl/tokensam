-- Protect the three metrics required by the 30-day granular charts.
-- Retention may only collapse these metrics after they leave the rolling 30-day chart window.
-- This database guard is an additional safety net against accidental retention regressions.

create or replace function public.protect_30d_chart_observations()
returns trigger
language plpgsql
as $$
begin
  if OLD.metric_id in ('price_usd', 'market_cap_usd', 'volume_24h_usd')
     and OLD.observed_at >= now() - interval '30 days' then
    raise exception
      'RETENTION_GUARD: cannot delete % observation inside 30-day granular chart window',
      OLD.metric_id;
  end if;

  return OLD;
end;
$$;

drop trigger if exists trg_protect_30d_chart_observations
  on public.token_metric_observations;

create trigger trg_protect_30d_chart_observations
before delete on public.token_metric_observations
for each row
execute function public.protect_30d_chart_observations();
