-- Rollback:
--   drop function if exists public.update_kiosk_separator_settings(text, text, integer, integer, integer);
--   drop function if exists public.clear_kiosk_tray(text);
--   restore prior bodies of create_staff_print_job / create_reprint_job (drop the p_force_cover_sheet param), see git history
--   create or replace view public.print_jobs_admin_view as ...  (restore prior column list, see git history)
--   create or replace view public.kiosk_status_admin_view as ...  (restore prior column list, see git history)
--   create or replace function public.get_kiosk_period_breakdown(...) ...  (restore prior body, see git history)
--   drop function public.create_reprint_job(uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid, boolean); then recreate the 9-arg version
--   alter table print_jobs
--     drop column if exists pickup_mode,
--     drop column if exists force_cover_sheet,
--     drop column if exists sheet_kind,
--     drop column if exists collected_via;
--   alter table kiosk_status
--     drop column if exists separator_mode,
--     drop column if exists recent_job_minutes,
--     drop column if exists later_hold_hours,
--     drop column if exists large_job_pages,
--     drop column if exists tray_cleared_at;
--   drop index if exists print_jobs_tray_lookup_idx;

alter table print_jobs add column if not exists pickup_mode text not null default 'here' check (pickup_mode in ('here', 'later'));
alter table print_jobs add column if not exists force_cover_sheet boolean not null default false;
alter table print_jobs add column if not exists sheet_kind text check (sheet_kind in ('none', 'separator', 'cover'));
alter table print_jobs add column if not exists collected_via text check (collected_via in ('customer', 'staff'));

alter table kiosk_status add column if not exists separator_mode text not null default 'auto' check (separator_mode in ('auto', 'always', 'never'));
alter table kiosk_status add column if not exists recent_job_minutes integer not null default 5;
alter table kiosk_status add column if not exists later_hold_hours integer not null default 2;
alter table kiosk_status add column if not exists large_job_pages integer not null default 15;
alter table kiosk_status add column if not exists tray_cleared_at timestamptz;

create index if not exists print_jobs_tray_lookup_idx
  on print_jobs (kiosk_id, ready_at)
  where status = 'printed' and collected_at is null;

create or replace function public.update_kiosk_separator_settings(
  p_kiosk_id text,
  p_separator_mode text,
  p_recent_job_minutes integer,
  p_later_hold_hours integer,
  p_large_job_pages integer
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_separator_mode not in ('auto', 'always', 'never') then
    raise exception 'Unknown separator_mode "%".', p_separator_mode;
  end if;
  if p_recent_job_minutes < 0 or p_later_hold_hours < 0 or p_large_job_pages < 1 then
    raise exception 'Invalid setting value.';
  end if;

  update kiosk_status set
    separator_mode = p_separator_mode,
    recent_job_minutes = p_recent_job_minutes,
    later_hold_hours = p_later_hold_hours,
    large_job_pages = p_large_job_pages,
    updated_at = now()
  where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'kiosk_separator_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object(
      'separator_mode', p_separator_mode,
      'recent_job_minutes', p_recent_job_minutes,
      'later_hold_hours', p_later_hold_hours,
      'large_job_pages', p_large_job_pages
    )
  );
end;
$$;

grant execute on function public.update_kiosk_separator_settings(text, text, integer, integer, integer) to authenticated;

create or replace function public.clear_kiosk_tray(p_kiosk_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  update kiosk_status set tray_cleared_at = now() where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'tray_cleared',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id
  );
end;
$$;

grant execute on function public.clear_kiosk_tray(text) to authenticated;

create or replace function public.create_staff_print_job(
  p_job_id uuid,
  p_file_name text,
  p_selected_pages jsonb,
  p_settings jsonb,
  p_waived_amount numeric,
  p_content_hash text,
  p_provider text,
  p_pdf_storage_path text,
  p_kiosk_id text,
  p_idempotency_key text,
  p_created_by uuid,
  p_daily_cap integer,
  p_force_cover_sheet boolean default false
)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_ticket_number integer;
  v_ticket_date date;
  v_usage_date date := current_date;
  v_pages integer;
  v_used integer;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' and public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_id from print_jobs where idempotency_key = p_idempotency_key;
    if found then
      return query select * from print_jobs where id = v_existing_id;
      return;
    end if;
  end if;

  v_pages := coalesce(jsonb_array_length(p_selected_pages), 0);
  if v_pages = 0 then
    raise exception 'No pages selected to print.';
  end if;

  insert into staff_daily_page_usage (user_id, usage_date, pages_printed)
  values (p_created_by, v_usage_date, v_pages)
  on conflict (user_id, usage_date) do update
    set pages_printed = staff_daily_page_usage.pages_printed + v_pages
  returning pages_printed into v_used;

  if v_used > p_daily_cap then
    raise exception 'Daily staff print cap reached (% of % pages used today).', v_used, p_daily_cap;
  end if;

  select ticket_number, ticket_date into v_ticket_number, v_ticket_date
  from public.next_ticket_number(p_kiosk_id);

  insert into print_jobs (
    id, status, file_name, selected_pages, settings, total_price,
    phone_number, notify_opt_in, include_banner_page, content_hash,
    provider, provider_order_id, pdf_storage_path, kiosk_id,
    ticket_number, ticket_date,
    payment_method, created_by_user_id, is_free, waived_amount, idempotency_key,
    pickup_mode, force_cover_sheet,
    created_at, updated_at
  ) values (
    p_job_id, 'paid', p_file_name, p_selected_pages, p_settings, 0,
    '', false, true, p_content_hash,
    p_provider, '', p_pdf_storage_path, p_kiosk_id,
    v_ticket_number, v_ticket_date,
    'staff', p_created_by, true, p_waived_amount, p_idempotency_key,
    'here', p_force_cover_sheet,
    v_now, v_now
  );

  perform public.log_audit(
    p_action := 'staff_print_created',
    p_actor_user_id := p_created_by,
    p_actor_role := 'staff',
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object('file_name', p_file_name, 'pages', v_pages, 'waived_amount', p_waived_amount)
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

create or replace function public.create_reprint_job(
  p_job_id uuid,
  p_original_job_id uuid,
  p_selected_pages jsonb,
  p_settings jsonb,
  p_include_banner_page boolean,
  p_content_hash text,
  p_pdf_storage_path text,
  p_reprint_note text,
  p_created_by uuid,
  p_force_cover_sheet boolean default false
)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original record;
  v_ticket_number integer;
  v_ticket_date date;
  v_now timestamptz := now();
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Not authorized.';
  end if;

  select * into v_original from print_jobs where id = p_original_job_id for update;
  if v_original is null then
    raise exception 'Original job not found.';
  end if;
  if v_original.refund_status = 'refunded' then
    raise exception 'This job has already been refunded — a free reprint would mean the customer keeps the refund AND gets a free reprint.';
  end if;

  if coalesce(jsonb_array_length(p_selected_pages), 0) = 0 then
    raise exception 'No pages selected to reprint.';
  end if;

  select ticket_number, ticket_date into v_ticket_number, v_ticket_date
  from public.next_ticket_number(v_original.kiosk_id);

  insert into print_jobs (
    id, status, file_name, selected_pages, settings, total_price,
    phone_number, notify_opt_in, include_banner_page, content_hash,
    provider, provider_order_id, pdf_storage_path, kiosk_id,
    ticket_number, ticket_date,
    payment_method, created_by_user_id, original_job_id,
    pickup_mode, force_cover_sheet,
    created_at, updated_at
  ) values (
    p_job_id, 'paid', v_original.file_name, p_selected_pages, p_settings, 0,
    '', false, p_include_banner_page, p_content_hash,
    v_original.provider, '', p_pdf_storage_path, v_original.kiosk_id,
    v_ticket_number, v_ticket_date,
    'reprint', p_created_by, p_original_job_id,
    'here', p_force_cover_sheet,
    v_now, v_now
  );

  update print_jobs set reprint_note = p_reprint_note, updated_at = v_now where id = p_original_job_id;

  perform public.log_audit(
    p_action := 'job_reprinted',
    p_actor_user_id := p_created_by,
    p_actor_role := 'owner',
    p_kiosk_id := v_original.kiosk_id,
    p_target_type := 'print_job',
    p_target_id := p_original_job_id::text,
    p_details := jsonb_build_object(
      'new_job_id', p_job_id,
      'pages', p_selected_pages,
      'copies', coalesce((p_settings->>'copies')::int, 1)
    )
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

grant execute on function public.create_reprint_job(uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid, boolean) to service_role;

create or replace view public.print_jobs_admin_view as
select
  id, status, file_name, selected_pages, settings,
  case when public.current_app_role() = 'owner' then total_price else null end as total_price,
  phone_number, include_banner_page, provider, provider_order_id, pdf_storage_path,
  kiosk_id, ticket_number, ticket_date, collected_at,
  created_at, updated_at, error, cups_job_id, refunded_at,
  notify_opt_in, notified_at,
  payment_method, created_by_user_id, is_free, waived_amount,
  claimed_at, spooled_at, printer_idle_at, ready_at,
  case when public.current_app_role() = 'owner' then refund_status else null end as refund_status,
  case when public.current_app_role() = 'owner' then refund_requested_at else null end as refund_requested_at,
  case when public.current_app_role() = 'owner' then refunded_by else null end as refunded_by,
  case when public.current_app_role() = 'owner' then refund_provider_id else null end as refund_provider_id,
  case when public.current_app_role() = 'owner' then refund_error else null end as refund_error,
  blocked_reason,
  interrupted_reason, interrupted_at, original_job_id, reprint_note,
  pickup_mode, force_cover_sheet, sheet_kind, collected_via
from public.print_jobs;

create or replace view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp,
  free_print_count, free_print_pages, free_print_waived_amount,
  print_blocked_reason, print_blocked_at,
  separator_mode, recent_job_minutes, later_hold_hours, large_job_pages, tray_cleared_at
from public.kiosk_status;

-- The returns table shape below adds separators_printed/covers_printed to
-- what this function returned before this migration — Postgres refuses a
-- bare `create or replace` when the OUT-parameter row type changes
-- (42P13: "cannot change return type of existing function"), so the old
-- signature has to be dropped first.
drop function if exists public.get_kiosk_period_breakdown(text, text);

create or replace function public.get_kiosk_period_breakdown(p_period text, p_kiosk_id text default null)
returns table (
  bucket_start timestamptz,
  revenue numeric,
  refund_amount numeric,
  refund_count integer,
  pages_printed integer,
  prints_completed integer,
  free_print_count integer,
  free_print_pages integer,
  free_print_waived_amount numeric,
  separators_printed integer,
  covers_printed integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz constant text := 'Asia/Kolkata';
  v_now constant timestamptz := now();
  v_period_start timestamptz;
  v_trunc_unit text;
  v_step interval;
  v_is_owner constant boolean := public.current_app_role() = 'owner';
begin
  if p_period = 'today' then
    v_period_start := (date_trunc('day', v_now at time zone v_tz)) at time zone v_tz;
    v_trunc_unit := 'hour';
    v_step := interval '1 hour';
  elsif p_period = 'week' then
    v_period_start := (date_trunc('week', v_now at time zone v_tz)) at time zone v_tz;
    v_trunc_unit := 'day';
    v_step := interval '1 day';
  elsif p_period = 'month' then
    v_period_start := (date_trunc('month', v_now at time zone v_tz)) at time zone v_tz;
    v_trunc_unit := 'day';
    v_step := interval '1 day';
  elsif p_period = 'year' then
    v_period_start := (date_trunc('year', v_now at time zone v_tz)) at time zone v_tz;
    v_trunc_unit := 'month';
    v_step := interval '1 month';
  else
    raise exception 'Unknown period "%" — expected today, week, month, or year.', p_period;
  end if;

  return query
  with buckets as (
    select generate_series(v_period_start, v_now, v_step) as bucket_start
  ),
  revenue_rows as (
    select
      (date_trunc(v_trunc_unit, pj.queue_time at time zone v_tz)) at time zone v_tz as bucket_start,
      sum(case when pj.refunded_at is null then pj.total_price else 0 end) as revenue,
      sum(case when pj.refunded_at is not null then pj.total_price else 0 end) as refund_amount,
      count(*) filter (where pj.refunded_at is not null) as refund_count
    from print_jobs pj
    where (p_kiosk_id is null or pj.kiosk_id = p_kiosk_id)
      and coalesce(pj.is_free, false) = false
      and pj.queue_time is not null
      and pj.queue_time >= v_period_start and pj.queue_time <= v_now
    group by 1
  ),
  completion_rows as (
    select
      (date_trunc(v_trunc_unit, coalesce(pj.ready_at, pj.updated_at) at time zone v_tz)) at time zone v_tz as bucket_start,
      count(*) filter (where coalesce(pj.is_free, false) = false) as prints_completed,
      coalesce(sum(public.physical_sheets_for_job(pj)) filter (where coalesce(pj.is_free, false) = false), 0) as pages_printed,
      count(*) filter (where pj.is_free) as free_print_count,
      coalesce(sum(public.physical_sheets_for_job(pj)) filter (where pj.is_free), 0) as free_print_pages,
      coalesce(sum(pj.waived_amount) filter (where pj.is_free), 0) as free_print_waived_amount,
      count(*) filter (where pj.sheet_kind = 'separator') as separators_printed,
      count(*) filter (where pj.sheet_kind = 'cover') as covers_printed
    from print_jobs pj
    where (p_kiosk_id is null or pj.kiosk_id = p_kiosk_id)
      and pj.status = 'printed'
      and coalesce(pj.ready_at, pj.updated_at) >= v_period_start and coalesce(pj.ready_at, pj.updated_at) <= v_now
    group by 1
  )
  select
    b.bucket_start,
    case when v_is_owner then coalesce(r.revenue, 0) else null end,
    case when v_is_owner then coalesce(r.refund_amount, 0) else null end,
    case when v_is_owner then coalesce(r.refund_count, 0)::integer else null end,
    coalesce(c.pages_printed, 0)::integer,
    coalesce(c.prints_completed, 0)::integer,
    coalesce(c.free_print_count, 0)::integer,
    coalesce(c.free_print_pages, 0)::integer,
    case when v_is_owner then coalesce(c.free_print_waived_amount, 0) else null end,
    coalesce(c.separators_printed, 0)::integer,
    coalesce(c.covers_printed, 0)::integer
  from buckets b
  left join revenue_rows r on r.bucket_start = b.bucket_start
  left join completion_rows c on c.bucket_start = b.bucket_start
  order by b.bucket_start;
end;
$$;

grant execute on function public.get_kiosk_period_breakdown(text, text) to authenticated;
