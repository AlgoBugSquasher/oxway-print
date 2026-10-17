-- Stops the print agent from failing (and, previously, refunding) a job
-- the instant a RECOVERABLE printer problem shows up — out of paper, a
-- door/cover open, low toner, or offline. A job like that now goes to a
-- new 'print_blocked' status with a reason, and the print agent keeps
-- watching it (never cancelling the live CUPS job) up to a generous time
-- limit before finally giving up. Root cause this fixes: "a job can be
-- both failed and printed" — see print-agent/index.ts's own long comment
-- for exactly why (this printer's USB/SPL driver commonly buffers a job's
-- full data internally before discovering there's no paper, so cancelling
-- the CUPS job never actually stopped the physical printer from finishing
-- it once paper was loaded, well after the job had already been marked
-- print_failed).
--
-- Run this ONCE, in order, in the Supabase SQL editor — DEV project
-- first, then production once verified there.
--
-- Additive only: two new nullable columns on print_jobs, two new nullable
-- columns on kiosk_status, two views updated to surface them (unmasked —
-- neither is money/PII), and cancel_job's own guard extended to also
-- allow cancelling a print_blocked job. Nothing existing is dropped,
-- renamed, or narrowed.
--
-- Rollback:
--   -- restore cancel_job's WHERE to its pre-this-migration list:
--   --   status in ('pending_payment', 'paid', 'printing')
--   -- restore print_jobs_admin_view / kiosk_status_admin_view to their
--   -- pre-this-migration column lists (see supabase/schema.sql's git
--   -- history for the exact prior definitions).
--   alter table print_jobs drop column if exists blocked_reason;
--   alter table kiosk_status
--     drop column if exists print_blocked_reason,
--     drop column if exists print_blocked_at;
--   grant select (id, status, error, ticket_number, updated_at, refunded_at, refund_status) on public.print_jobs to anon; -- re-run without blocked_reason if fully reverting

-- ============================================================================
-- 1. print_jobs.blocked_reason — the human-readable "why" while status =
--    'print_blocked'. Independent of `error` (which stays reserved for a
--    genuine, final print_failed reason) and of refund_status (a blocked
--    job is still live — it never needed a refund yet, and the existing
--    set_print_job_refund_pending trigger only ever fires on a transition
--    INTO 'print_failed', never 'print_blocked').
-- ============================================================================
alter table print_jobs add column if not exists blocked_reason text;

-- ============================================================================
-- 2. kiosk_status.print_blocked_reason / print_blocked_at — the KIOSK-wide
--    signal the website reads to block new checkout and show a "temporarily
--    unavailable" message (requirement: never let a new customer pay while
--    the machine can't print). Written only by the print agent itself
--    (print-agent/index.ts), never by any website code. null means "not
--    blocked" — the normal, overwhelmingly common state.
-- ============================================================================
alter table kiosk_status add column if not exists print_blocked_reason text;
alter table kiosk_status add column if not exists print_blocked_at timestamptz;

-- ============================================================================
-- 3. print_jobs_admin_view / kiosk_status_admin_view — surface the new
--    columns (requirement: "show the blocked reason on the admin page for
--    the machine and on the job"). Neither is masked — a supply-readiness
--    problem isn't money or PII, same reasoning agent_commit/
--    last_seen_at/tray_pages etc. are already unmasked for staff.
-- ============================================================================
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
  blocked_reason
from public.print_jobs;

create or replace view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp,
  free_print_count, free_print_pages, free_print_waived_amount,
  print_blocked_reason, print_blocked_at
from public.kiosk_status;

-- ============================================================================
-- 4. Anonymous (customer status page) grant — blocked_reason alongside
--    the existing error/refund_status, same reasoning those already use:
--    a job's own customer should be able to see WHY it's currently
--    paused, via Realtime's direct payload, not just that it is. The
--    `status` column (already granted) carries the 'print_blocked' value
--    itself — no change needed there, only this one new column.
-- ============================================================================
grant select (blocked_reason) on public.print_jobs to anon;

-- ============================================================================
-- 5. cancel_job() — extend the cancellable-statuses guard to include
--    'print_blocked'. A blocked job is still fundamentally "in the active
--    queue, not yet resolved" — an owner/staff member should be able to
--    give up on it (e.g. decide to refund instead of keep waiting) the
--    same way they already can for 'printing', rather than it being a
--    dead end with zero admin action available until the agent's own
--    retry-time-limit eventually expires on its own.
-- ============================================================================
create or replace function public.cancel_job(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old_status text;
  v_updated_rows integer;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  select status into v_old_status from print_jobs where id = p_job_id;

  update print_jobs set status = 'cancelled', updated_at = now()
  where id = p_job_id and status in ('pending_payment', 'paid', 'printing', 'print_blocked');
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows > 0 then
    perform public.log_audit(
      p_action := 'job_cancelled',
      p_actor_user_id := auth.uid(),
      p_actor_role := public.current_app_role(),
      p_target_type := 'print_job',
      p_target_id := p_job_id::text,
      p_details := jsonb_build_object(
        'before', jsonb_build_object('status', v_old_status),
        'after', jsonb_build_object('status', 'cancelled')
      )
    );
  end if;
end;
$$;
