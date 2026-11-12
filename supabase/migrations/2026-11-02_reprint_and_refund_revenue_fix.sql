-- Rollback:
--   drop trigger if exists print_jobs_recognize_original_revenue_on_reprint on print_jobs;
--   drop function if exists public.recognize_original_revenue_on_reprint_success();
--   restore complete_refund() and get_kiosk_period_breakdown() to their prior bodies (see git history)

-- Bug: revenue is only ever recorded in print_orders when a job actually
-- finishes PRINTING (recordCompletedPrint, called from print-agent's
-- finalizeSuccess) — never at payment time. That leaves a gap for a job
-- that was PAID but never printed (interrupted, print_failed,
-- print_blocked):
--   - Reprint it (no refund): the business keeps the money, but neither
--     the original job nor the $0 reprint row ever enters print_orders, so
--     that kept money never shows as revenue anywhere.
--   - Refund it: refund_events subtracts the full amount from revenue in
--     get_kiosk_period_breakdown, even though that job's payment was NEVER
--     added to revenue in the first place (print_failed jobs never have a
--     print_orders row) — so revenue can be pushed artificially negative
--     for money that was never counted as revenue to begin with.
--
-- Rule this migration enforces: revenue = money the business actually
-- kept. Checked against live data before writing this (0 refund_events
-- rows exist yet, so no historical revenue numbers are wrong today — this
-- closes the gap going forward).

-- ----------------------------------------------------------------------------
-- 1. Recognize the ORIGINAL job's payment as revenue once its reprint
--    actually finishes printing — exactly once, only when that money is
--    genuinely being kept (not refunded/mid-refund), and only if the
--    original was never counted before (covers a reprint of an
--    already-printed job too: that job already has its own print_orders
--    row from printing normally, so this is correctly a no-op for it).
-- ----------------------------------------------------------------------------
create or replace function public.recognize_original_revenue_on_reprint_success()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_original record;
begin
  if tg_op = 'UPDATE'
     and new.status = 'printed'
     and old.status is distinct from 'printed'
     and new.original_job_id is not null then

    -- Locks the original row for this transaction — closes the same race
    -- two reprints of the same original completing at the same moment
    -- could otherwise cause (see create_reprint_job's own `for update`
    -- for the identical reasoning).
    select * into v_original from print_jobs where id = new.original_job_id for update;

    if v_original.id is not null
       and v_original.total_price > 0
       and coalesce(v_original.payment_method, '') not in ('staff', 'reprint')
       and coalesce(v_original.refund_status, '') not in ('pending', 'processing', 'refunded')
       and not exists (select 1 from print_orders where job_id = v_original.id) then

      -- pages_printed = 0 — the ORIGINAL job never physically printed
      -- anything (the reprint's own print_orders row, written separately
      -- by recordCompletedPrint with is_reprint = true, already accounts
      -- for the real paper used). This row exists purely to recognize the
      -- money, dated today (the day the reprint completed), not the
      -- original payment day — same convention every other job's revenue
      -- already uses (counted the day it prints).
      insert into print_orders (kiosk_id, pages_printed, amount, color_mode, status, is_free, is_reprint, job_id)
      values (v_original.kiosk_id, 0, v_original.total_price, coalesce((v_original.settings->>'isColor')::boolean, false), 'completed', false, false, v_original.id)
      on conflict (job_id) where job_id is not null do nothing;

      -- Keeps the lifetime card (kiosk_status.total_revenue) consistent
      -- with the period breakdown below, same as every normal print's own
      -- recordCompletedPrint already does for both at once.
      update kiosk_status
      set total_revenue = total_revenue + v_original.total_price, updated_at = now()
      where id = v_original.kiosk_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger print_jobs_recognize_original_revenue_on_reprint
  after update on print_jobs
  for each row execute function public.recognize_original_revenue_on_reprint_success();

-- ----------------------------------------------------------------------------
-- 2. complete_refund() — only reduce the lifetime total_revenue card if
--    this job's payment was actually counted as revenue in the first
--    place (print_failed jobs never are, today — this is correct either
--    way if that ever changes).
-- ----------------------------------------------------------------------------
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

    -- Only subtract from the lifetime card if this job's payment was ever
    -- actually added to it — a refund of a job that never printed must
    -- not make total_revenue go negative for money it never counted.
    if exists (select 1 from print_orders where job_id = p_job_id and not is_free and not is_reprint) then
      update kiosk_status set total_revenue = total_revenue - v_total_price, updated_at = now() where id = v_kiosk_id;
    end if;
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

-- ----------------------------------------------------------------------------
-- 3. get_kiosk_period_breakdown() — same "only subtract a counted refund"
--    rule, for the period numbers. `refund_amount`/`refund_count` keep
--    their existing meaning (every refund resolved in the period, a pure
--    ops stat); only the `revenue` figure's own subtraction is restricted
--    to refunds that actually reduced counted revenue.
-- ----------------------------------------------------------------------------
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
      count(*) as refund_count,
      -- Only the portion of this bucket's refunds whose job was actually
      -- counted as revenue — see this migration's own header comment.
      coalesce(sum(re.amount) filter (
        where exists (select 1 from print_orders po where po.job_id = re.job_id and not po.is_free and not po.is_reprint)
      ), 0) as counted_refund_amount
    from refund_events re
    where (p_kiosk_id is null or re.kiosk_id = p_kiosk_id)
      and re.resolved_at >= v_period_start and re.resolved_at <= v_now
    group by 1
  )
  select
    b.bucket_start,
    case when v_is_owner then coalesce(o.revenue, 0) - coalesce(rf.counted_refund_amount, 0) else null end,
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
