begin;

-- The Risk Profile chart's rolling volatility needs 8 *consecutive* daily closes with no
-- gaps (see src/lib/data/historical-series.ts's rollingVolatility). retention_collapse_weekly_batch
-- collapsing every metric to 1 row/week beyond day 30 made that structurally impossible past
-- day ~30 for every token -- drawdown also renders as sparse weekly dots next to dense daily
-- points for the recent month. price_usd is cheap enough (238 tokens x 90 days x ~620 bytes
-- =~ 13 MB) to simply exempt from the weekly collapse and keep at daily resolution all the way
-- to the 90-day expiry, restoring the chart's full window going forward. This does not
-- retroactively restore days already collapsed to weekly before this migration -- the 90-day
-- window becomes fully dense again only after ~90 days of new data accumulates past this point.

create or replace function public.retention_collapse_weekly_batch(batch_size int default 1000)
returns int
language sql
as $$
  with doomed as (
    select t.id
    from public.token_metric_observations t
    where t.observed_at < now() - interval '30 days'
      and t.observed_at >= now() - interval '90 days'
      and not (t.provider_id = 'coingecko' and t.metric_id = 'price_usd')
      and exists (
        select 1 from public.token_metric_observations newer
        where newer.token_id = t.token_id and newer.metric_id = t.metric_id
          and date_trunc('week', newer.observed_at) = date_trunc('week', t.observed_at)
          and (newer.observed_at, newer.id) > (t.observed_at, t.id)
      )
    limit batch_size
  ),
  deleted as (
    delete from public.token_metric_observations t using doomed where t.id = doomed.id returning t.id
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

commit;

-- Verification:
-- select proname, prosrc like '%price_usd%' as excludes_price_usd from pg_proc where proname = 'retention_collapse_weekly_batch';
