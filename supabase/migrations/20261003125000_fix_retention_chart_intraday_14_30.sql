CREATE OR REPLACE FUNCTION public.retention_collapse_chart_intraday_batch(batch_size integer DEFAULT 40)
RETURNS integer
LANGUAGE sql
AS $$
  WITH chart_metrics(metric_id) AS (
    VALUES ('price_usd'), ('market_cap_usd'), ('volume_24h_usd'), ('tvl_usd')
  ),
  ranked AS (
    SELECT t.id,
           row_number() OVER (
             PARTITION BY t.token_id, t.metric_id, date_trunc('day', t.observed_at)
             ORDER BY t.observed_at DESC, t.id DESC
           ) AS rn
    FROM public.token_metric_observations t
    WHERE t.observed_at < now() - interval '14 days'
      AND t.observed_at >= now() - interval '30 days'
      AND t.metric_id IN (SELECT metric_id FROM chart_metrics)
  ),
  doomed AS (
    SELECT id FROM ranked WHERE rn > 1
    ORDER BY id
    LIMIT batch_size
  ),
  deleted AS (
    DELETE FROM public.token_metric_observations t
    USING doomed
    WHERE t.id = doomed.id
    RETURNING t.id
  )
  SELECT coalesce(count(*)::int, 0) FROM deleted;
$$;
