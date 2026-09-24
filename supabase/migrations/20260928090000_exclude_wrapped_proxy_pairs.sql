-- Token-centric follow-up: retire the legacy DEX pair links for native assets.
--
-- 20260927090000_token_centric_scope.sql excluded the wrapped-proxy observations
-- and raw records for ETH, SOL, BNB, and AVAX (WETH, wSOL, WBNB, WAVAX) and
-- deleted their mappings, but it left their rows in provider_pairs. Nothing
-- reads provider_pairs today, and the collectors no longer write pairs for
-- these tokens. Mark the rows excluded here, the same way as the raw records,
-- so no future reader can treat a wrapped asset's pair as the native asset's.
-- Rows are kept, not deleted, to preserve provenance. Idempotent.

alter table public.provider_pairs
  add column if not exists excluded_reason text;

update public.provider_pairs
set excluded_reason = 'retired_wrapped_asset_proxy_mapping'
where provider_id = 'dexscreener'
  and token_id in ('ethereum-eth', 'solana-sol', 'bnb-bnb', 'avalanche-avax')
  and excluded_reason is null;

-- Verification (expected: active = 0, excluded = 26 as of 2026-09-24):
-- select count(*) filter (where excluded_reason is null) as active,
--        count(*) filter (where excluded_reason is not null) as excluded
-- from public.provider_pairs
-- where token_id in ('ethereum-eth', 'solana-sol', 'bnb-bnb', 'avalanche-avax');
