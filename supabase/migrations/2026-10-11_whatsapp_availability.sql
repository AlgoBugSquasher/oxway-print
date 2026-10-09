alter table kiosk_status add column if not exists allow_whatsapp boolean not null default false;

create or replace function public.update_kiosk_whatsapp_availability(p_kiosk_id text, p_allow_whatsapp boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can change WhatsApp availability.';
  end if;
  update kiosk_status set allow_whatsapp = p_allow_whatsapp, updated_at = now() where id = p_kiosk_id;
end;
$$;

grant execute on function public.update_kiosk_whatsapp_availability(text, boolean) to authenticated;

-- Dropped and recreated rather than CREATE OR REPLACE — see the
-- 2026-10-09 migration's own comment for why.
drop view if exists public.kiosk_status_admin_view;
create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp
from public.kiosk_status;

grant select on public.kiosk_status_admin_view to authenticated;
