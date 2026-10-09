alter table kiosk_status add column if not exists agent_commit text;
alter table kiosk_status add column if not exists agent_updated_at timestamptz;

create table if not exists kiosk_commands (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  command text not null check (command in ('update', 'restart')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  result text
);

create index if not exists kiosk_commands_kiosk_status_idx on kiosk_commands (kiosk_id, status);
create index if not exists kiosk_commands_kiosk_requested_idx on kiosk_commands (kiosk_id, requested_at desc);

alter table kiosk_commands enable row level security;

create or replace function public.request_kiosk_command(p_kiosk_id text, p_command text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_command not in ('update', 'restart') then
    raise exception 'Unknown command.';
  end if;
  if exists (
    select 1 from kiosk_commands
    where kiosk_id = p_kiosk_id and status in ('pending', 'running')
  ) then
    raise exception 'A command is already pending or running for this kiosk.';
  end if;
  insert into kiosk_commands (kiosk_id, command, requested_by)
  values (p_kiosk_id, p_command, auth.uid());
end;
$$;

grant execute on function public.request_kiosk_command(text, text) to authenticated;

-- Dropped and recreated rather than CREATE OR REPLACE — see the
-- 2026-10-09 migration's own comment for why; same reasoning applies to
-- every view touched below.
drop view if exists public.kiosk_status_admin_view;
create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at
from public.kiosk_status;

drop view if exists public.kiosk_commands_admin_view;
create view public.kiosk_commands_admin_view as
select id, kiosk_id, command, status, requested_by, requested_at, finished_at, result
from public.kiosk_commands;

grant select on public.kiosk_status_admin_view to authenticated;
grant select on public.kiosk_commands_admin_view to authenticated;
