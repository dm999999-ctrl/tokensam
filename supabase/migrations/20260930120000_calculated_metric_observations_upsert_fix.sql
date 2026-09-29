begin;

-- run-calculation.ts upserted on (token_id,chain_id,metric_id,input_fingerprint), but
-- input_fingerprint changes on almost every calculation run, so every scheduled run was
-- inserting a new row per metric instead of updating the existing one. That grew this
-- table unboundedly (218k rows / 374MB within 6 days in production before a manual
-- cleanup). The code now upserts on (token_id,chain_id,metric_id) only; this migration
-- adds the matching unique index Postgres' ON CONFLICT requires and drops the old,
-- now-redundant 4-column constraint (a unique (token_id,chain_id,metric_id) index already
-- implies uniqueness on the wider 4-column tuple).
--
-- Safe to apply as-is: a prior manual cleanup already reduced this table to one row per
-- (token_id,chain_id,metric_id), so the new unique index has nothing to conflict with.

alter table public.calculated_metric_observations
  drop constraint calculated_metric_observation_token_id_chain_id_metric_id_i_key;

create unique index calculated_metric_observations_token_chain_metric_key
  on public.calculated_metric_observations (token_id, chain_id, metric_id);

commit;

-- Verification (expected: 0 rows):
-- select token_id, chain_id, metric_id, count(*) from public.calculated_metric_observations
-- group by 1, 2, 3 having count(*) > 1;
