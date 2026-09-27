-- Fixes a Phase A correctness bug found during live-validation review:
-- absence from a single CoinGecko catalog fetch was being treated as
-- immediate, permanent deprecation evidence, which conflates "fell outside
-- this run's ranked top-N window" (meaningless) and "the catalog fetch itself
-- failed" (a provider outage) with "genuinely delisted" (AGENTS.md #14, #25).
--
-- This column lets duplicates.ts require several *consecutive* confirmed
-- absences from CoinGecko's near-complete `/coins/list` catalog before a
-- candidate is marked `deprecated`; a single occurrence now only raises
-- `needs_review`, and the streak resets the moment the candidate reappears.

alter table public.universe_candidates
  add column if not exists absent_from_source_streak integer not null default 0;
