-- Admin Overview dashboard (period revenue/pages) + paper/toner refill
-- tracking. Additive only: one new table, three new functions, nothing
-- existing dropped/renamed/altered. Safe to run against a live project.
--
-- Run this ONCE, in the Supabase SQL editor, against the DEV project first.
-- Rollback: `drop table refill_events cascade;` (cascades to record_refill
-- and get_kiosk_supply_status, which both reference it) and
-- `drop function get_kiosk_period_breakdown(text, text);` and
-- `drop function physical_sheets_for_job(print_jobs);` — nothing else
-- needs to change, since no existing signature was touched.

-- ============================================================================
-- 1. physical_sheets_for_job() — the one formula for "how many physical
--    sheets did this job use," shared by both features below. Mirrors
--    lib/print/sheets.ts's physicalSheetsForJob exactly: ceil(selected
--    pages / pagesPerSheet) * copies, plus the banner once. greatest(...,1)
--    guards against a malformed settings row (pagesPerSheet/copies <= 0)
--    ever dividing by zero or zeroing out a whole job's count in a
--    dashboard aggregate — defensive only, every real job always has valid
--    settings.
-- ============================================================================
create or replace function public.physical_sheets_for_job(p_job print_jobs)
returns integer
language sql
immutable
as $$
  select ceil(
           jsonb_array_length(p_job.selected_pages)::numeric
           / greatest((p_job.settings->>'pagesPerSheet')::numeric, 1)
         )::integer
         * greatest((p_job.settings->>'copies')::integer, 1)
       + case when p_job.include_banner_page then 1 else 0 end;
$$;

-- ============================================================================
-- 2. get_kiosk_period_breakdown() — dense, zero-filled buckets for the
--    Overview page's period selector (Today/Week/Month/Year).
-- ============================================================================
--
-- Two different "which day does this row belong to" timestamps, on
-- purpose: revenue/refunds are bucketed by queue_time (the instant a job
-- first became 'paid' — the moment money was actually received, stamped
-- once by the existing set_print_job_queue_time trigger and never moved
-- afterward, so it's stable even if the job's own status keeps changing
-- later); pages/prints/free-print stats are bucketed by
-- coalesce(ready_at, updated_at) (the instant a job actually finished
-- printing — ready_at is the precise stamp from lib/print/ready-timing.ts
-- once that migration lands; updated_at is the correct fallback for any
-- job printed before it did, since a terminal 'printed' row's updated_at
-- is exactly the last time it changed, which for a terminal row is "when
-- it finished"). A job paid at 11:58pm and printed at 12:02am the next day
-- genuinely belongs to two different buckets for these two different
-- metrics — that's correct, not a bug, and is exactly the "job just before
-- and after midnight IST" case this is built to handle.
--
-- "Revenue, net of refunds" per bucket: queue_time is NOT NULL on every
-- row that was ever actually paid (staff or customer), regardless of its
-- CURRENT status, so filtering on queue_time alone (not status) correctly
-- includes a job that's since moved to print_failed-and-refunded within
-- its ORIGINAL paid-on day's bucket, net of whatever was refunded for it —
-- refunds only ever happen on a failed job in this system (see
-- REFUNDABLE_STATUSES in app/api/admin/refund/route.ts), so a job that
-- reaches 'printed' can never also be refunded; this still nets correctly
-- either way without needing to special-case that.
--
-- Money fields (revenue, refund_amount, free_print_waived_amount) are
-- masked to null for non-owners, same column-masking convention
-- print_jobs_admin_view/kiosk_status_admin_view already use — "owners see
-- money, staff see pages and prints only" enforced here, server-side, not
-- left to the client to merely hide a field it already received.
--
-- Period/bucket boundaries always computed via the
-- `date_trunc(unit, <ts> at time zone 'Asia/Kolkata') at time zone
-- 'Asia/Kolkata'` double-conversion — never bare date_trunc(ts) or
-- current_date, which both silently use whatever timezone the DATABASE
-- SESSION happens to be in (Supabase defaults to UTC) rather than actual
-- Kolkata wall-clock boundaries. Stepping the generated bucket series by a
-- fixed interval from that Kolkata-aligned start is safe regardless of
-- session timezone specifically because Asia/Kolkata has no DST — every
-- step lands on the next Kolkata-aligned boundary with no ambiguity.
-- p_kiosk_id is nullable — null means "every kiosk combined," which is what
-- the Overview page actually needs (it already sums total_revenue across
-- every kiosk for its existing all-time card; the new period totals keep
-- that same "whole business" framing, not a single kiosk's own numbers).
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
  free_print_waived_amount numeric
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
    -- date_trunc('week', ...) is ISO 8601: Monday — exactly the "weeks
    -- start Monday" rule, with no separate named constant needed since
    -- it's Postgres's own built-in behavior, not a number this app chose.
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
      coalesce(sum(pj.waived_amount) filter (where pj.is_free), 0) as free_print_waived_amount
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
    case when v_is_owner then coalesce(c.free_print_waived_amount, 0) else null end
  from buckets b
  left join revenue_rows r on r.bucket_start = b.bucket_start
  left join completion_rows c on c.bucket_start = b.bucket_start
  order by b.bucket_start;
end;
$$;

grant execute on function public.get_kiosk_period_breakdown(text, text) to authenticated;

-- ============================================================================
-- 3. refill_events — append-ish history of "paper refilled" / "toner
--    replaced" actions, the baseline every supply estimate is computed
--    against.
-- ============================================================================
--
-- quantity's meaning differs by kind, by design (matches exactly how an
-- owner/staff member would naturally answer each question):
--   - 'paper': how many sheets are in the tray AS OF this event (counts
--     DOWN from here as jobs print — see get_kiosk_supply_status below).
--   - 'toner': how many pages this cartridge had ALREADY printed as of
--     this event — 0 for a genuinely fresh "Toner replaced," but can be
--     >0 the first time an already-partially-used cartridge is registered
--     (counts UP from here, compared against cartridge_max_pages as the
--     configurable yield).
-- Both are "the starting count," just counted in opposite directions —
-- the one thing every refill event actually resets is `at`, the instant
-- consumption-since starts being measured from again.
create table refill_events (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  kind text not null check (kind in ('paper', 'toner')),
  quantity integer not null check (quantity >= 0),
  at timestamptz not null default now(),
  by_user_id uuid references auth.users(id),
  note text
);

create index refill_events_kiosk_kind_at_idx on refill_events (kiosk_id, kind, at desc);

alter table refill_events enable row level security;
-- Read: any signed-in owner/staff — the history list (who/when/quantity)
-- is useful to both roles, same as the kiosk card itself; nothing in this
-- table is money or PII (by_user_id is a bare uuid, resolved to an email
-- client-side via the existing /api/admin/staff-users route, same pattern
-- print_jobs.created_by_user_id already uses).
create policy "Signed-in admins read refill_events" on refill_events
for select using (public.current_app_role() in ('owner', 'staff'));

grant select on public.refill_events to authenticated;

-- No insert/update/delete policy or grant at all — the only way a row is
-- ever written is record_refill() below, SECURITY DEFINER, so this is
-- genuinely append-only, same discipline as audit_log.

-- ============================================================================
-- 4. record_refill() — the one write path for both buttons.
-- ============================================================================
--
-- Both owner and staff can record a refill (task's own requirement #4),
-- unlike most other write RPCs in this schema which split owner-only vs.
-- owner-and-staff — there's no money/revenue-control angle to a refill the
-- way there is to pricing or WhatsApp spend, so the broader of the two
-- existing patterns (update_kiosk_counters' "owner or staff") applies here
-- too. Logs an audit entry in the SAME transaction as the insert itself —
-- requirement #4 of the refill task, same "same transaction if possible"
-- reasoning record_refund() (the money one, confusingly similar name —
-- this is the SUPPLY refill, unrelated) already established.
create or replace function public.record_refill(p_kiosk_id text, p_kind text, p_quantity integer, p_note text default null)
returns setof refill_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_kind not in ('paper', 'toner') then
    raise exception 'Unknown refill kind "%" — expected paper or toner.', p_kind;
  end if;
  if p_quantity < 0 then
    raise exception 'Quantity must be zero or more.';
  end if;

  insert into refill_events (kiosk_id, kind, quantity, by_user_id, note)
  values (p_kiosk_id, p_kind, p_quantity, auth.uid(), p_note)
  returning id into v_id;

  perform public.log_audit(
    p_action := case p_kind when 'paper' then 'paper_refilled' else 'toner_replaced' end,
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object('kind', p_kind, 'quantity', p_quantity, 'note', p_note)
  );

  return query select * from refill_events where id = v_id;
end;
$$;

grant execute on function public.record_refill(text, text, integer, text) to authenticated;

-- ============================================================================
-- 5. get_kiosk_supply_status() — the raw numbers the "Paper left"/"Toner
--    left" cards are built from. Deliberately returns RAW inputs (not a
--    finished percentage) — lib/admin/supply-estimate.ts's pure
--    computeSupplyEstimate() does the remaining/percentage/clamping math
--    from these, so that logic has a real unit test that doesn't need a
--    database at all; this function's own job is just "sum what's been
--    consumed since the last baseline," which DOES need one.
-- ============================================================================
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
      select coalesce(sum(public.physical_sheets_for_job(pj)), 0)::integer
      from print_jobs pj
      where pj.kiosk_id = p_kiosk_id and pj.status = 'printed'
        and coalesce(pj.ready_at, pj.updated_at) >= v_paper.at
    ) end,
    v_paper.at,
    v_paper.by_user_id,
    v_toner.id is not null,
    v_toner.quantity,
    case when v_toner.id is not null then (
      select coalesce(sum(public.physical_sheets_for_job(pj)), 0)::integer
      from print_jobs pj
      where pj.kiosk_id = p_kiosk_id and pj.status = 'printed'
        and coalesce(pj.ready_at, pj.updated_at) >= v_toner.at
    ) end,
    v_toner.at,
    v_toner.by_user_id;
end;
$$;

grant execute on function public.get_kiosk_supply_status(text) to authenticated;
