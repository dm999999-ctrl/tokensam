-- The metrics-calculation step (run-calculation.ts) was the single largest driver of
-- this project's Supabase egress overage. Measured live on 2026-10-07: its two reads
-- (readLatestObservations across all 238 tokens x 5 providers, and readObservationWindow's
-- multi-day window across 5 series inputs x 238 tokens) transferred ~40,588 and ~82,974
-- rows respectively on a single run, even after the lookback window was already cut from
-- 14 to 3 days (20261007122046-adjacent commit) -- because both reads fetch every row in
-- a bounded time window over the wire and only THEN collapse to the few rows actually
-- needed (latest-per-group; two-most-recent-points-per-series) in application memory.
-- Metrics runs roughly as often as CoinGecko's 15-minute refresh cadence, so this ran
-- ~96 times/day, well over an order of magnitude past the derived daily egress budget
-- from this read alone.
--
-- Both RPCs below do the exact same collapse Postgres was already capable of, server
-- side, so only the rows actually needed cross the wire:
--   - latest_observations_bounded: one row per (token_id, provider_id, metric_id) within
--     a bounded window -- the same "newest row wins" rule latestPerMetric (observation-
--     reads.ts) already implements in JS, now done with a window function instead.
--   - metrics_series_recent_points: per (token_id, provider_id, metric_id) in a fixed
--     series list, the two most recent distinct observations (all growthCalculation,
--     engine.ts, ever compares) plus the single observation nearest ~24h earlier within a
--     6h tolerance (all alignedCrossChange ever needs) -- everything else in a 3-day
--     window was never read by any calculation, only transferred and discarded.
-- Both are read-only (language sql, stable) and granted only to service_role, same as
-- every other RPC this project has added for the refresh/retention pipeline.
begin;

create or replace function public.latest_observations_bounded(
  p_token_ids text[],
  p_provider_ids text[],
  p_since timestamptz
)
returns setof public.token_metric_observations
language sql
stable
as $$
  select id, token_id, chain_id, metric_id, provider_id, raw_record_id, value, window_days,
         status, observed_at, collected_at, source_field, note, created_at, scope,
         provider_asset_id, mapping_id, excluded_reason
  from (
    select o.*,
      row_number() over (
        partition by o.token_id, o.provider_id, o.metric_id
        order by o.observed_at desc, o.id desc
      ) as rn
    from public.token_metric_observations o
    where o.token_id = any(p_token_ids)
      and o.provider_id = any(p_provider_ids)
      and o.excluded_reason is null
      and o.observed_at >= p_since
  ) ranked
  where rn = 1;
$$;

revoke all on function public.latest_observations_bounded(text[], text[], timestamptz) from public;
grant execute on function public.latest_observations_bounded(text[], text[], timestamptz) to service_role;

create or replace function public.metrics_series_recent_points(
  p_token_ids text[],
  p_providers text[],
  p_metrics text[],
  p_now timestamptz,
  p_horizon_hours int default 24,
  p_tolerance_hours int default 6,
  p_max_lookback_days int default 30
)
returns setof public.token_metric_observations
language sql
stable
as $$
  with series(provider_id, metric_id) as (
    select * from unnest(p_providers, p_metrics) as u(provider_id, metric_id)
  ),
  targets as (
    select t.token_id, s.provider_id, s.metric_id
    from unnest(p_token_ids) as t(token_id)
    cross join series s
  ),
  -- The two most recent distinct observations per series: all growthCalculation
  -- (engine.ts) ever compares. token_metric_latest_lookup_idx (token_id, provider_id,
  -- metric_id, observed_at desc, collected_at desc, id desc) makes each of these a pure
  -- index-ordered scan.
  recent2 as (
    select o.*
    from targets tg
    cross join lateral (
      select o.*
      from public.token_metric_observations o
      where o.token_id = tg.token_id
        and o.provider_id = tg.provider_id
        and o.metric_id = tg.metric_id
        and o.excluded_reason is null
        and o.observed_at >= p_now - (p_max_lookback_days || ' days')::interval
      order by o.observed_at desc, o.id desc
      limit 2
    ) o
  ),
  anchors as (
    select token_id, provider_id, metric_id, max(observed_at) as latest_at
    from recent2
    group by token_id, provider_id, metric_id
  ),
  -- The single observation nearest p_horizon_hours before the series' own latest point,
  -- within p_tolerance_hours -- all alignedCrossChange (engine.ts) ever needs for its
  -- cross-provider divergence/cross-change calculations.
  horizon_point as (
    select o.*
    from anchors a
    cross join lateral (
      select o.*
      from public.token_metric_observations o
      where o.token_id = a.token_id
        and o.provider_id = a.provider_id
        and o.metric_id = a.metric_id
        and o.excluded_reason is null
        and o.observed_at between
          a.latest_at - ((p_horizon_hours + p_tolerance_hours) || ' hours')::interval
          and a.latest_at - ((p_horizon_hours - p_tolerance_hours) || ' hours')::interval
      order by abs(extract(epoch from (o.observed_at - (a.latest_at - (p_horizon_hours || ' hours')::interval))))
      limit 1
    ) o
  )
  select distinct on (id) *
  from (
    select * from recent2
    union all
    select * from horizon_point
  ) combined
  order by id;
$$;

revoke all on function public.metrics_series_recent_points(text[], text[], text[], timestamptz, int, int, int) from public;
grant execute on function public.metrics_series_recent_points(text[], text[], text[], timestamptz, int, int, int) to service_role;

commit;

-- Manual verification after applying:
--   select count(*) from public.latest_observations_bounded(
--     (select array_agg(id) from public.tokens), array['coingecko','binance','defillama','dexscreener','defillama_coins'],
--     now() - interval '6 hours');
--   select count(*) from public.metrics_series_recent_points(
--     (select array_agg(id) from public.tokens),
--     array['coingecko','coingecko','defillama','defillama','defillama'],
--     array['price_usd','market_cap_usd','tvl_usd','revenue_24h_usd','fees_24h_usd'],
--     now(), 24, 6, 3);
