-- Rollback:
--   drop function if exists public.get_kiosk_sales_summary(text, text);
--   drop function if exists public.get_kiosk_daily_pattern(text, text);
--   drop function if exists public.get_kiosk_weekday_pattern(text, text);
--   drop function if exists public.get_kiosk_hourly_pattern(text, text);
--   drop function if exists public.period_start_for(text, timestamptz, text);
--   drop index if exists print_failures_kiosk_created_idx;
--   drop table if exists print_failures;
--   restore lib/store.ts's failPrintingJob to its prior body (see git history)

-- Shared by every stats function below (get_kiosk_period_breakdown already
-- shipped with its own copy of this same branch in the 2026-10-20
-- migration — left as-is there rather than refactored, since it's already
-- live and tested; every function added from here on calls this instead of
-- repeating the branch a fifth time).
create or replace function public.period_start_for(p_period text, p_now timestamptz, p_tz text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if p_period = 'today' then
    return (date_trunc('day', p_now at time zone p_tz)) at time zone p_tz;
  elsif p_period = 'week' then
    return (date_trunc('week', p_now at time zone p_tz)) at time zone p_tz;
  elsif p_period = 'month' then
    return (date_trunc('month', p_now at time zone p_tz)) at time zone p_tz;
  elsif p_period = 'year' then
    return (date_trunc('year', p_now at time zone p_tz)) at time zone p_tz;
  else
    raise exception 'Unknown period "%" — expected today, week, month, or year.', p_period;
  end if;
end;
$$;

create table if not exists print_failures (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  job_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists print_failures_kiosk_created_idx on print_failures (kiosk_id, created_at);

alter table print_failures enable row level security;
-- Same convention as print_orders/refund_events: owner-only RLS on the raw
-- table even though staff can see failure counts — that access only ever
-- happens through get_kiosk_sales_summary (a security definer function,
-- which bypasses this), never a direct table read.
drop policy if exists "Owner reads print_failures" on print_failures;
create policy "Owner reads print_failures" on print_failures
for select using (public.current_app_role() = 'owner');

create or replace function public.get_kiosk_hourly_pattern(p_period text, p_kiosk_id text default null)
returns table (hour_of_day integer, job_count integer, pages_printed integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz constant text := 'Asia/Kolkata';
  v_now constant timestamptz := now();
  v_period_start timestamptz;
begin
  v_period_start := public.period_start_for(p_period, v_now, v_tz);

  return query
  with hours as (
    select generate_series(0, 23) as hour_of_day
  ),
  activity as (
    select
      extract(hour from po.created_at at time zone v_tz)::integer as hour_of_day,
      count(*) as job_count,
      coalesce(sum(po.pages_printed), 0) as pages_printed
    from print_orders po
    where (p_kiosk_id is null or po.kiosk_id = p_kiosk_id)
      and po.created_at >= v_period_start and po.created_at <= v_now
    group by 1
  )
  select h.hour_of_day, coalesce(a.job_count, 0)::integer, coalesce(a.pages_printed, 0)::integer
  from hours h
  left join activity a on a.hour_of_day = h.hour_of_day
  order by h.hour_of_day;
end;
$$;

grant execute on function public.get_kiosk_hourly_pattern(text, text) to authenticated;

-- day_of_week follows extract(dow ...)'s own convention: 0 = Sunday .. 6 =
-- Saturday, same as JavaScript's Date.getDay() — chosen so the admin
-- panel's own formatting code needs no day-number translation.
create or replace function public.get_kiosk_weekday_pattern(p_period text, p_kiosk_id text default null)
returns table (day_of_week integer, job_count integer, pages_printed integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz constant text := 'Asia/Kolkata';
  v_now constant timestamptz := now();
  v_period_start timestamptz;
begin
  v_period_start := public.period_start_for(p_period, v_now, v_tz);

  return query
  with weekdays as (
    select generate_series(0, 6) as day_of_week
  ),
  activity as (
    select
      extract(dow from po.created_at at time zone v_tz)::integer as day_of_week,
      count(*) as job_count,
      coalesce(sum(po.pages_printed), 0) as pages_printed
    from print_orders po
    where (p_kiosk_id is null or po.kiosk_id = p_kiosk_id)
      and po.created_at >= v_period_start and po.created_at <= v_now
    group by 1
  )
  select w.day_of_week, coalesce(a.job_count, 0)::integer, coalesce(a.pages_printed, 0)::integer
  from weekdays w
  left join activity a on a.day_of_week = w.day_of_week
  order by w.day_of_week;
end;
$$;

grant execute on function public.get_kiosk_weekday_pattern(text, text) to authenticated;

-- One row per calendar day (Kolkata) in the period — the admin panel finds
-- the busiest/quietest day in the selected period by taking the max/min of
-- what this returns, rather than that being computed in SQL, since "best"
-- vs "quietest" needs tie-breaking and date-formatting the client already
-- does for every other period view.
create or replace function public.get_kiosk_daily_pattern(p_period text, p_kiosk_id text default null)
returns table (day date, job_count integer, pages_printed integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz constant text := 'Asia/Kolkata';
  v_now constant timestamptz := now();
  v_period_start timestamptz;
begin
  v_period_start := public.period_start_for(p_period, v_now, v_tz);

  return query
  with days as (
    select generate_series((v_period_start at time zone v_tz)::date, (v_now at time zone v_tz)::date, interval '1 day')::date as day
  ),
  activity as (
    select
      (po.created_at at time zone v_tz)::date as day,
      count(*) as job_count,
      coalesce(sum(po.pages_printed), 0) as pages_printed
    from print_orders po
    where (p_kiosk_id is null or po.kiosk_id = p_kiosk_id)
      and po.created_at >= v_period_start and po.created_at <= v_now
    group by 1
  )
  select d.day, coalesce(a.job_count, 0)::integer, coalesce(a.pages_printed, 0)::integer
  from days d
  left join activity a on a.day = d.day
  order by d.day;
end;
$$;

grant execute on function public.get_kiosk_daily_pattern(text, text) to authenticated;

-- Single-row summary for the period: color/B&W split, averages, and the
-- two reliability rates. failure_rate is an operational metric (how often a
-- print attempt of ANY kind — paying, free, or reprint — fails), so its
-- denominator is every completed OR failed attempt. refund_rate's
-- denominator is paid attempts only (paying completed + failed) — a free
-- or reprint job never has anything to refund (see Goal 1's own
-- print_orders.is_free/is_reprint reasoning). avg_order_value is the only
-- money field here, masked to null for staff the same way every other
-- money field in this file already is.
create or replace function public.get_kiosk_sales_summary(p_period text, p_kiosk_id text default null)
returns table (
  color_jobs integer,
  bw_jobs integer,
  avg_pages_per_job numeric,
  avg_order_value numeric,
  failed_jobs integer,
  failure_rate numeric,
  refunded_jobs integer,
  refund_rate numeric
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
  v_is_owner constant boolean := public.current_app_role() = 'owner';
  v_completed_jobs integer;
  v_paying_jobs integer;
  v_failed_jobs integer;
  v_refunded_jobs integer;
begin
  v_period_start := public.period_start_for(p_period, v_now, v_tz);

  select
    count(*)::integer,
    count(*) filter (where not is_free and not is_reprint)::integer,
    count(*) filter (where color_mode)::integer,
    count(*) filter (where not color_mode)::integer,
    coalesce(avg(pages_printed), 0),
    coalesce(avg(amount) filter (where not is_free and not is_reprint), 0)
  into v_completed_jobs, v_paying_jobs, color_jobs, bw_jobs, avg_pages_per_job, avg_order_value
  from print_orders
  where (p_kiosk_id is null or kiosk_id = p_kiosk_id)
    and created_at >= v_period_start and created_at <= v_now;

  select count(*)::integer into v_failed_jobs
  from print_failures
  where (p_kiosk_id is null or kiosk_id = p_kiosk_id)
    and created_at >= v_period_start and created_at <= v_now;

  select count(*)::integer into v_refunded_jobs
  from refund_events
  where (p_kiosk_id is null or kiosk_id = p_kiosk_id)
    and resolved_at >= v_period_start and resolved_at <= v_now;

  failed_jobs := v_failed_jobs;
  refunded_jobs := v_refunded_jobs;
  failure_rate := case when v_completed_jobs + v_failed_jobs > 0 then v_failed_jobs::numeric / (v_completed_jobs + v_failed_jobs) else 0 end;
  refund_rate := case when v_paying_jobs + v_failed_jobs > 0 then v_refunded_jobs::numeric / (v_paying_jobs + v_failed_jobs) else 0 end;
  if not v_is_owner then
    avg_order_value := null;
  end if;

  return next;
end;
$$;

grant execute on function public.get_kiosk_sales_summary(text, text) to authenticated;
