-- Remove previously generated 5-minute timestamps from the live 30-day chart window.
-- These rows did not represent real provider observation timestamps and therefore
-- must not participate in charts or rolling retention.
--
-- We intentionally do not rewrite them to another timestamp: without a source
-- observation timestamp, inventing one would corrupt the chart and retention age.

begin;

alter table public.token_metric_observations
  disable trigger trg_protect_30d_chart_observations;

delete from public.token_metric_observations
where observed_at >= now() - interval '30 days'
  and note like '%[BACKFILL-5M]%';

alter table public.token_metric_observations
  enable trigger trg_protect_30d_chart_observations;

commit;
