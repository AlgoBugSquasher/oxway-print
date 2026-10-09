
alter table kiosk_status add column if not exists allow_color boolean not null default true;
alter table kiosk_status add column if not exists allow_bw boolean not null default true;


alter table print_jobs add column if not exists notify_opt_in boolean not null default false;
alter table print_jobs add column if not exists notified_at timestamptz;


alter table print_jobs alter column include_banner_page set default true;


drop function if exists public.update_kiosk_counters(text, integer, integer, integer, integer);
create or replace function public.update_kiosk_counters(
  p_kiosk_id text,
  p_tray_pages integer default null,
  p_cartridge_pages integer default null,
  p_tray_max_pages integer default null,
  p_cartridge_max_pages integer default null,
  p_allow_color boolean default null,
  p_allow_bw boolean default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_resulting_allow_color boolean;
  v_resulting_allow_bw boolean;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  select coalesce(p_allow_color, allow_color), coalesce(p_allow_bw, allow_bw)
    into v_resulting_allow_color, v_resulting_allow_bw
  from kiosk_status where id = p_kiosk_id;

  if v_resulting_allow_color is false and v_resulting_allow_bw is false then
    raise exception 'At least one of Color or B&W must stay enabled.';
  end if;

  update kiosk_status set
    tray_pages = coalesce(p_tray_pages, tray_pages),
    cartridge_pages = coalesce(p_cartridge_pages, cartridge_pages),
    tray_max_pages = coalesce(p_tray_max_pages, tray_max_pages),
    cartridge_max_pages = coalesce(p_cartridge_max_pages, cartridge_max_pages),
    allow_color = coalesce(p_allow_color, allow_color),
    allow_bw = coalesce(p_allow_bw, allow_bw),
    updated_at = now()
  where id = p_kiosk_id;
end;
$$;

grant execute on function public.update_kiosk_counters(text, integer, integer, integer, integer, boolean, boolean) to authenticated;

-- 5. Admin views widened by one column each -------------------------------
-- Dropped and recreated rather than CREATE OR REPLACE: that requires the
-- existing columns to keep the exact same name/position, which depends on
-- how the view was actually deployed (may not match schema.sql's history
-- verbatim) — dropping first sidesteps that entirely. Safe: these are plain
-- read-only SELECT views with grants re-applied right after, and nothing in
-- Postgres can depend on a view the way it can on a table.
drop view if exists public.print_jobs_admin_view;
create view public.print_jobs_admin_view as
select
  id, status, file_name, selected_pages, settings,
  case when public.current_app_role() = 'owner' then total_price else null end as total_price,
  phone_number, notify_opt_in, notified_at, include_banner_page, provider, provider_order_id, pdf_storage_path,
  kiosk_id, ticket_number, ticket_date, collected_at,
  created_at, updated_at, error, cups_job_id, refunded_at
from public.print_jobs;

drop view if exists public.kiosk_status_admin_view;
create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw
from public.kiosk_status;

grant select on public.print_jobs_admin_view to authenticated;
grant select on public.kiosk_status_admin_view to authenticated;
