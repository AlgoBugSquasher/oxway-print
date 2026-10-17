-- Rollback:
--   drop function if exists public.get_active_alerts(text);
--   drop function if exists public.update_kiosk_alert_settings(text, text);
--   drop table if exists alerts;
--   drop table if exists kiosk_alert_settings;
--   alter table kiosk_status drop column if exists low_supply_threshold_percent;
--   restore update_kiosk_counters / get_kiosk_supply_status / kiosk_status_admin_view to prior bodies (see git history)

alter table kiosk_status add column if not exists low_supply_threshold_percent integer not null default 10 check (low_supply_threshold_percent between 1 and 99);

-- Adds a new trailing parameter — `create or replace` matches a function
-- by its exact argument-type list, so without dropping the old 7-arg
-- signature first this would silently create a second, overloaded
-- version instead of replacing it.
drop function if exists public.update_kiosk_counters(text, integer, integer, integer, integer, boolean, boolean);

create or replace function public.update_kiosk_counters(
  p_kiosk_id text,
  p_tray_pages integer default null,
  p_cartridge_pages integer default null,
  p_tray_max_pages integer default null,
  p_cartridge_max_pages integer default null,
  p_allow_color boolean default null,
  p_allow_bw boolean default null,
  p_low_supply_threshold_percent integer default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_resulting_allow_color boolean;
  v_resulting_allow_bw boolean;
  v_old kiosk_status;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_low_supply_threshold_percent is not null and (p_low_supply_threshold_percent < 1 or p_low_supply_threshold_percent > 99) then
    raise exception 'Low-supply threshold must be between 1 and 99.';
  end if;

  select * into v_old from kiosk_status where id = p_kiosk_id;

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
    low_supply_threshold_percent = coalesce(p_low_supply_threshold_percent, low_supply_threshold_percent),
    updated_at = now()
  where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'kiosk_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object(
      'before', jsonb_build_object(
        'tray_pages', v_old.tray_pages, 'cartridge_pages', v_old.cartridge_pages,
        'tray_max_pages', v_old.tray_max_pages, 'cartridge_max_pages', v_old.cartridge_max_pages,
        'allow_color', v_old.allow_color, 'allow_bw', v_old.allow_bw,
        'low_supply_threshold_percent', v_old.low_supply_threshold_percent
      ),
      'after', jsonb_build_object(
        'tray_pages', coalesce(p_tray_pages, v_old.tray_pages), 'cartridge_pages', coalesce(p_cartridge_pages, v_old.cartridge_pages),
        'tray_max_pages', coalesce(p_tray_max_pages, v_old.tray_max_pages), 'cartridge_max_pages', coalesce(p_cartridge_max_pages, v_old.cartridge_max_pages),
        'allow_color', v_resulting_allow_color, 'allow_bw', v_resulting_allow_bw,
        'low_supply_threshold_percent', coalesce(p_low_supply_threshold_percent, v_old.low_supply_threshold_percent)
      )
    )
  );
end;
$$;

grant execute on function public.update_kiosk_counters(text, integer, integer, integer, integer, boolean, boolean, integer) to authenticated;

create or replace view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp,
  free_print_count, free_print_pages, free_print_waived_amount,
  print_blocked_reason, print_blocked_at,
  separator_mode, recent_job_minutes, later_hold_hours, large_job_pages, tray_cleared_at,
  low_supply_threshold_percent
from public.kiosk_status;

grant select on public.kiosk_status_admin_view to authenticated;

create or replace function public.get_kiosk_supply_status(p_kiosk_id text)
returns table (
  cartridge_max_pages integer,
  has_paper_baseline boolean,
  paper_quantity integer,
  paper_consumed_since integer,
  paper_refilled_at timestamptz,
  paper_refilled_by uuid,
  has_toner_baseline boolean,
  toner_starting_pages integer,
  toner_consumed_since integer,
  toner_refilled_at timestamptz,
  toner_refilled_by uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_paper refill_events;
  v_toner refill_events;
  v_cartridge_max_pages integer;
begin
  select * into v_paper from refill_events where kiosk_id = p_kiosk_id and kind = 'paper' order by at desc limit 1;
  select * into v_toner from refill_events where kiosk_id = p_kiosk_id and kind = 'toner' order by at desc limit 1;
  select ks.cartridge_max_pages into v_cartridge_max_pages from kiosk_status ks where ks.id = p_kiosk_id;

  return query select
    v_cartridge_max_pages,
    v_paper.id is not null,
    v_paper.quantity,
    case when v_paper.id is not null then (
      select coalesce(sum(po.pages_printed), 0)::integer
      from print_orders po
      where po.kiosk_id = p_kiosk_id and po.created_at >= v_paper.at
    ) end,
    v_paper.at,
    v_paper.by_user_id,
    v_toner.id is not null,
    v_toner.quantity,
    case when v_toner.id is not null then (
      select coalesce(sum(po.pages_printed), 0)::integer
      from print_orders po
      where po.kiosk_id = p_kiosk_id and po.created_at >= v_toner.at
    ) end,
    v_toner.at,
    v_toner.by_user_id;
end;
$$;

grant execute on function public.get_kiosk_supply_status(text) to authenticated;

create table if not exists kiosk_alert_settings (
  kiosk_id text primary key references kiosk_status(id),
  telegram_chat_id text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table kiosk_alert_settings enable row level security;
drop policy if exists "Owner reads kiosk_alert_settings" on kiosk_alert_settings;
create policy "Owner reads kiosk_alert_settings" on kiosk_alert_settings
for select using (public.current_app_role() = 'owner');

create or replace function public.update_kiosk_alert_settings(p_kiosk_id text, p_telegram_chat_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Not authorized.';
  end if;

  insert into kiosk_alert_settings (kiosk_id, telegram_chat_id, updated_by)
  values (p_kiosk_id, p_telegram_chat_id, auth.uid())
  on conflict (kiosk_id) do update set telegram_chat_id = excluded.telegram_chat_id, updated_at = now(), updated_by = excluded.updated_by;

  perform public.log_audit(
    p_action := 'alert_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object('telegram_chat_id_set', p_telegram_chat_id is not null)
  );
end;
$$;

grant execute on function public.update_kiosk_alert_settings(text, text) to authenticated;

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  kind text not null check (kind in ('paper_low', 'toner_low', 'kiosk_offline')),
  status text not null default 'active' check (status in ('active', 'resolved')),
  created_at timestamptz not null default now(),
  last_reminded_at timestamptz,
  resolved_at timestamptz
);

create unique index if not exists alerts_active_kiosk_kind_idx on alerts (kiosk_id, kind) where status = 'active';
create index if not exists alerts_kiosk_status_idx on alerts (kiosk_id, status);

alter table alerts enable row level security;
drop policy if exists "Signed-in admins read alerts" on alerts;
create policy "Signed-in admins read alerts" on alerts
for select using (public.current_app_role() in ('owner', 'staff'));

create or replace function public.get_active_alerts(p_kiosk_id text default null)
returns setof alerts
language sql
stable
security definer
set search_path = public
as $$
  select * from alerts
  where status = 'active' and (p_kiosk_id is null or kiosk_id = p_kiosk_id)
  order by created_at desc;
$$;

grant execute on function public.get_active_alerts(text) to authenticated;
