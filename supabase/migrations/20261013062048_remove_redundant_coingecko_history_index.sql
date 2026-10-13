-- Lossless storage reduction: the latest lookup index also supports CoinGecko
-- history/gap lookups with equality on token, provider, and metric followed by
-- an observed_at range. Its timestamp order can be scanned in either direction.
-- No observations, provenance, retention windows, views, or RPCs change.
set local lock_timeout = '250ms';
set local statement_timeout = '15s';

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.token_metric_latest_lookup_idx')
      and i.indrelid = 'public.token_metric_observations'::regclass
      and i.indisvalid and i.indisready
      and pg_catalog.pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX token_metric_latest_lookup_idx ON public.token_metric_observations USING btree (token_id, provider_id, metric_id, observed_at DESC, collected_at DESC, id DESC)'
  ) then
    raise exception 'Refusing index removal: compatible latest lookup index is missing or changed';
  end if;

  if exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.token_metric_coingecko_gap_lookup_idx')
      and (
        i.indisunique or i.indisprimary
        or pg_catalog.pg_get_indexdef(i.indexrelid) <>
          'CREATE INDEX token_metric_coingecko_gap_lookup_idx ON public.token_metric_observations USING btree (token_id, metric_id, observed_at) WHERE (provider_id = ''coingecko''::text)'
        or exists (select 1 from pg_catalog.pg_constraint c where c.conindid = i.indexrelid)
      )
  ) then
    raise exception 'Refusing index removal: gap index definition or constraints changed';
  end if;
end;
$migration$;

drop index if exists public.token_metric_coingecko_gap_lookup_idx;
