-- Phase 12: stored Gemini Deep AI Analysis results.
-- Additive only and safe to re-run. One append-only row per successful, validated
-- generation; the Token Profile reads the newest row per token and never calls
-- Gemini on page load. The table also backs generation cooldowns and hourly caps.

create table if not exists public.token_ai_analyses (
  id bigint generated always as identity primary key,
  token_id text not null,
  chain_id text not null,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  generated_at timestamptz not null default now(),
  -- Newest provider collection / calculation time included in the research context.
  context_as_of timestamptz,
  context_hash text not null,
  analysis jsonb not null,
  validation jsonb not null default '{}'::jsonb,
  foreign key (token_id, chain_id) references public.tokens(id, chain_id) on update cascade on delete cascade
);

create index if not exists token_ai_analyses_latest_idx
  on public.token_ai_analyses (token_id, generated_at desc);
create index if not exists token_ai_analyses_generated_idx
  on public.token_ai_analyses (generated_at desc);

alter table public.token_ai_analyses enable row level security;
revoke all on table public.token_ai_analyses from anon, authenticated;
grant select, insert, update, delete on table public.token_ai_analyses to service_role;
grant usage, select on sequence public.token_ai_analyses_id_seq to service_role;
