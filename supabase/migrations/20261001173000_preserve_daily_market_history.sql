-- Preserve daily resolution for metrics rendered in Market History charts.
-- Older non-chart metrics continue to collapse to one observation per UTC week.
CREATE OR REPLACE FUNCTION public.retention_collapse_weekly_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE sql
AS $function$
  WITH chart_metrics(metric_id) AS (
    VALUES ('price_usd'), ('market_cap_usd'), ('volume_24h_usd'), ('tvl_usd')
  ),
  doomed AS (
    SELECT t.id
    FROM public.token_metric_observations t
    WHERE t.observed_at < now() - interval '30 days'
      AND t.observed_at >= now() - interval '90 days'
      AND (
        (
          t.metric_id IN (SELECT metric_id FROM chart_metrics)
          AND EXISTS (
            SELECT 1
            FROM public.token_metric_observations newer
            WHERE newer.token_id = t.token_id
              AND newer.metric_id = t.metric_id
              AND newer.observed_at >= date_trunc('day', t.observed_at)
              AND newer.observed_at < date_trunc('day', t.observed_at) + interval '1 day'
              AND (newer.observed_at, newer.id) > (t.observed_at, t.id)
          )
        )
        OR
        (
          t.metric_id NOT IN (SELECT metric_id FROM chart_metrics)
          AND NOT (t.provider_id = 'coingecko' AND t.metric_id = 'price_usd')
          AND EXISTS (
            SELECT 1
            FROM public.token_metric_observations newer
            WHERE newer.token_id = t.token_id
              AND newer.metric_id = t.metric_id
              AND newer.observed_at >= date_trunc('week', t.observed_at)
              AND newer.observed_at < date_trunc('week', t.observed_at) + interval '1 week'
              AND (newer.observed_at, newer.id) > (t.observed_at, t.id)
          )
        )
      )
    ORDER BY t.observed_at, t.id
    LIMIT batch_size
  ),
  deleted AS (
    DELETE FROM public.token_metric_observations t USING doomed
    WHERE t.id = doomed.id
    RETURNING t.id
  )
  SELECT coalesce(count(*)::int, 0) FROM deleted;
$function$;
