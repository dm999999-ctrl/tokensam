-- Keep raw provider payloads for two days instead of seven.
-- Normalized token_metric_observations remain the durable historical dataset.
CREATE OR REPLACE FUNCTION public.retention_expire_raw_provider_records_batch(batch_size integer DEFAULT 1000)
RETURNS integer
LANGUAGE sql
AS $function$
  WITH doomed AS (
    SELECT id
    FROM public.raw_provider_records
    WHERE collected_at < now() - interval '2 days'
    ORDER BY collected_at, id
    LIMIT batch_size
  ),
  deleted AS (
    DELETE FROM public.raw_provider_records t
    USING doomed
    WHERE t.id = doomed.id
    RETURNING t.id
  )
  SELECT coalesce(count(*)::int, 0) FROM deleted;
$function$;
