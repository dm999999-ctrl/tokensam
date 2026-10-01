begin;

create or replace function public.get_database_size_bytes()
returns bigint
language sql
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

revoke all on function public.get_database_size_bytes() from public;
grant execute on function public.get_database_size_bytes() to service_role;

create table if not exists public.database_monitor_state (
  id boolean primary key default true check (id = true),
  alert_active boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.database_monitor_state (id, alert_active)
values (true, false)
on conflict (id) do nothing;

alter table public.database_monitor_state enable row level security;
revoke all on table public.database_monitor_state from anon, authenticated;
grant select, insert, update, delete on table public.database_monitor_state to service_role;

commit;
