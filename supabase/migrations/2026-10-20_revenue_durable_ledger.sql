-- Rollback:
--   drop function if exists public.get_pending_refund_summary(text);
--   drop index if exists print_orders_kiosk_created_idx;
--   drop index if exists refund_events_kiosk_resolved_idx;
--   drop table if exists refund_events;
--   alter table print_orders
--     drop column if exists kiosk_id,
--     drop column if exists is_free,
--     drop column if exists is_reprint,
--     drop column if exists waived_amount,
--     drop column if exists sheet_kind;
--   restore get_kiosk_period_breakdown's prior body and complete_refund's prior body (see git history)

alter table print_orders add column if not exists kiosk_id text;
alter table print_orders add column if not exists is_free boolean not null default false;
alter table print_orders add column if not exists is_reprint boolean not null default false;
alter table print_orders add column if not exists waived_amount numeric;
alter table print_orders add column if not exists sheet_kind text check (sheet_kind in ('none', 'separator', 'cover'));

create index if not exists print_orders_kiosk_created_idx on print_orders (kiosk_id, created_at);

create table if not exists refund_events (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  job_id uuid not null,
  amount numeric not null,
  resolved_at timestamptz not null default now()
);

create index if not exists refund_events_kiosk_resolved_idx on refund_events (kiosk_id, resolved_at);

alter table refund_events enable row level security;
drop policy if exists "Owner reads refund_events" on refund_events;
create policy "Owner reads refund_events" on refund_events
for select using (public.current_app_role() = 'owner');

create or replace function public.complete_refund(
  p_job_id uuid,
  p_refund_id text,
  p_already_refunded_at_provider boolean default false,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_ip text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_price numeric;
  v_provider text;
  v_kiosk_id text;
  v_updated_rows integer;
begin
  select total_price, provider, kiosk_id into v_total_price, v_provider, v_kiosk_id from print_jobs where id = p_job_id;

  update print_jobs set
    refund_status = 'refunded',
    refunded_at = now(),
    refunded_by = p_actor_user_id,
    refund_provider_id = p_refund_id,
    refund_error = null,
    updated_at = now()
  where id = p_job_id and refund_status = 'processing';
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows > 0 then
    insert into refund_events (kiosk_id, job_id, amount) values (v_kiosk_id, p_job_id, v_total_price);
  end if;

  perform public.log_audit(
    p_action := 'job_refunded',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object(
      'refund_id', p_refund_id,
      'amount', v_total_price,
      'provider', v_provider,
      'already_refunded_at_provider', p_already_refunded_at_provider,
      'updated', v_updated_rows > 0
    ),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );
end;
$$;

grant execute on function public.complete_refund(uuid, text, boolean, uuid, text, text, text) to service_role;

-- Adds reprint_count/reprint_pages to the returns table — Postgres refuses
-- a bare `create or replace` when the OUT-parameter row type changes
-- (42P13), so drop the old signature first.
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
  reprint_count integer,
  reprint_pages integer,
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
  order_rows as (
    select
      (date_trunc(v_trunc_unit, po.created_at at time zone v_tz)) at time zone v_tz as bucket_start,
      count(*) filter (where not po.is_free and not po.is_reprint) as prints_completed,
      coalesce(sum(po.pages_printed) filter (where not po.is_free and not po.is_reprint), 0) as pages_printed,
      coalesce(sum(po.amount) filter (where not po.is_free and not po.is_reprint), 0) as revenue,
      count(*) filter (where po.is_free) as free_print_count,
      coalesce(sum(po.pages_printed) filter (where po.is_free), 0) as free_print_pages,
      coalesce(sum(po.waived_amount) filter (where po.is_free), 0) as free_print_waived_amount,
      count(*) filter (where po.is_reprint) as reprint_count,
      coalesce(sum(po.pages_printed) filter (where po.is_reprint), 0) as reprint_pages,
      count(*) filter (where po.sheet_kind = 'separator') as separators_printed,
      count(*) filter (where po.sheet_kind = 'cover') as covers_printed
    from print_orders po
    where (p_kiosk_id is null or po.kiosk_id = p_kiosk_id)
      and po.created_at >= v_period_start and po.created_at <= v_now
    group by 1
  ),
  refund_rows as (
    select
      (date_trunc(v_trunc_unit, re.resolved_at at time zone v_tz)) at time zone v_tz as bucket_start,
      coalesce(sum(re.amount), 0) as refund_amount,
      count(*) as refund_count
    from refund_events re
    where (p_kiosk_id is null or re.kiosk_id = p_kiosk_id)
      and re.resolved_at >= v_period_start and re.resolved_at <= v_now
    group by 1
  )
  select
    b.bucket_start,
    case when v_is_owner then coalesce(o.revenue, 0) - coalesce(rf.refund_amount, 0) else null end,
    case when v_is_owner then coalesce(rf.refund_amount, 0) else null end,
    case when v_is_owner then coalesce(rf.refund_count, 0)::integer else null end,
    coalesce(o.pages_printed, 0)::integer,
    coalesce(o.prints_completed, 0)::integer,
    coalesce(o.free_print_count, 0)::integer,
    coalesce(o.free_print_pages, 0)::integer,
    case when v_is_owner then coalesce(o.free_print_waived_amount, 0) else null end,
    coalesce(o.reprint_count, 0)::integer,
    coalesce(o.reprint_pages, 0)::integer,
    coalesce(o.separators_printed, 0)::integer,
    coalesce(o.covers_printed, 0)::integer
  from buckets b
  left join order_rows o on o.bucket_start = b.bucket_start
  left join refund_rows rf on rf.bucket_start = b.bucket_start
  order by b.bucket_start;
end;
$$;

grant execute on function public.get_kiosk_period_breakdown(text, text) to authenticated;

create or replace function public.get_pending_refund_summary(p_kiosk_id text default null)
returns table (pending_refund_amount numeric, pending_refund_count integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_owner constant boolean := public.current_app_role() = 'owner';
begin
  return query
  select
    case when v_is_owner then coalesce(sum(total_price), 0) else null end,
    case when v_is_owner then count(*)::integer else null end
  from print_jobs
  where (p_kiosk_id is null or kiosk_id = p_kiosk_id)
    and refund_status in ('pending', 'processing', 'failed');
end;
$$;

grant execute on function public.get_pending_refund_summary(text) to authenticated;
