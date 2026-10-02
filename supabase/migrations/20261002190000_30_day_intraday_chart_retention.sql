-- Preserve full intraday chart history for 30 days, then retain daily chart history through 91 days.
-- Non-chart metrics keep their existing shorter retention/collapse behavior.
CREATE OR REPLACE FUNCTION public.retention_collapse_series_intraday_batch(batch_size integer DEFAULT 1000)
RETURNS integer LANGUAGE sql AS $function$
  WITH retained_series(metric_id) AS (VALUES ('revenue_24h_usd'), ('fees_24h_usd')),
  doomed AS (
    SELECT t.id FROM public.token_metric_observations t
    JOIN retained_series s ON s.metric_id = t.metric_id
    WHERE t.observed_at < now() - interval '14 days' AND t.observed_at >= now() - interval '30 days'
      AND EXISTS (SELECT 1 FROM public.token_metric_observations newer
        WHERE newer.token_id=t.token_id AND newer.metric_id=t.metric_id
          AND newer.observed_at >= date_trunc('day',t.observed_at)
          AND newer.observed_at < date_trunc('day',t.observed_at)+interval '1 day'
          AND (newer.observed_at,newer.id)>(t.observed_at,t.id))
    ORDER BY t.observed_at,t.id LIMIT batch_size),
  deleted AS (DELETE FROM public.token_metric_observations t USING doomed WHERE t.id=doomed.id RETURNING t.id)
  SELECT coalesce(count(*)::int,0) FROM deleted;
$function$;

CREATE OR REPLACE FUNCTION public.retention_collapse_other_intraday_batch(batch_size integer DEFAULT 1000)
RETURNS integer LANGUAGE sql AS $function$
  WITH chart_metrics(metric_id) AS (VALUES ('price_usd'),('market_cap_usd'),('volume_24h_usd'),('tvl_usd')),
  series_metrics(metric_id) AS (VALUES ('price_usd'),('market_cap_usd'),('tvl_usd'),('revenue_24h_usd'),('fees_24h_usd')),
  doomed AS (
    SELECT t.id FROM public.token_metric_observations t
    WHERE t.metric_id NOT IN (SELECT metric_id FROM series_metrics)
      AND t.metric_id NOT IN (SELECT metric_id FROM chart_metrics)
      AND t.observed_at < now()-interval '1 day' AND t.observed_at >= now()-interval '30 days'
      AND EXISTS (SELECT 1 FROM public.token_metric_observations newer
        WHERE newer.token_id=t.token_id AND newer.metric_id=t.metric_id
          AND newer.observed_at >= date_trunc('day',t.observed_at)
          AND newer.observed_at < date_trunc('day',t.observed_at)+interval '1 day'
          AND (newer.observed_at,newer.id)>(t.observed_at,t.id))
    ORDER BY t.observed_at,t.id LIMIT batch_size),
  deleted AS (DELETE FROM public.token_metric_observations t USING doomed WHERE t.id=doomed.id RETURNING t.id)
  SELECT coalesce(count(*)::int,0) FROM deleted;
$function$;

CREATE OR REPLACE FUNCTION public.retention_collapse_weekly_batch(batch_size integer DEFAULT 1000)
RETURNS integer LANGUAGE sql AS $function$
  WITH chart_metrics(metric_id) AS (VALUES ('price_usd'),('market_cap_usd'),('volume_24h_usd'),('tvl_usd')),
  doomed AS (
    SELECT t.id FROM public.token_metric_observations t
    WHERE t.observed_at < now()-interval '30 days' AND t.observed_at >= now()-interval '91 days'
      AND ((t.metric_id IN (SELECT metric_id FROM chart_metrics) AND EXISTS (
        SELECT 1 FROM public.token_metric_observations newer
        WHERE newer.token_id=t.token_id AND newer.metric_id=t.metric_id
          AND newer.observed_at >= date_trunc('day',t.observed_at)
          AND newer.observed_at < date_trunc('day',t.observed_at)+interval '1 day'
          AND (newer.observed_at,newer.id)>(t.observed_at,t.id)))
      OR (t.metric_id NOT IN (SELECT metric_id FROM chart_metrics)
          AND NOT (t.provider_id='coingecko' AND t.metric_id='price_usd') AND EXISTS (
        SELECT 1 FROM public.token_metric_observations newer
        WHERE newer.token_id=t.token_id AND newer.metric_id=t.metric_id
          AND newer.observed_at >= date_trunc('week',t.observed_at)
          AND newer.observed_at < date_trunc('week',t.observed_at)+interval '1 week'
          AND (newer.observed_at,newer.id)>(t.observed_at,t.id))))
    ORDER BY t.observed_at,t.id LIMIT batch_size),
  deleted AS (DELETE FROM public.token_metric_observations t USING doomed WHERE t.id=doomed.id RETURNING t.id)
  SELECT coalesce(count(*)::int,0) FROM deleted;
$function$;

CREATE OR REPLACE FUNCTION public.retention_expire_observations_batch(batch_size integer DEFAULT 1000)
RETURNS integer LANGUAGE sql AS $function$
  WITH cutoff AS (SELECT ((now() AT TIME ZONE 'UTC')::date-91)::date AS oldest_kept_day),
  doomed AS (SELECT t.id FROM public.token_metric_observations t,cutoff c
    WHERE (t.observed_at AT TIME ZONE 'UTC')::date < c.oldest_kept_day
    ORDER BY t.observed_at,t.id LIMIT batch_size),
  deleted AS (DELETE FROM public.token_metric_observations t USING doomed WHERE t.id=doomed.id RETURNING t.id)
  SELECT coalesce(count(*)::int,0) FROM deleted;
$function$;