-- Rollback:
--   drop function if exists public.mark_job_printed_no_refund_needed(uuid, text, uuid, text, text, text);
--   drop index if exists print_orders_job_id_idx;
--   alter table print_orders drop column if exists job_id;
--   alter table print_jobs drop column if exists failure_evidence;

alter table print_jobs add column if not exists failure_evidence jsonb;

alter table print_orders add column if not exists job_id uuid;
create unique index if not exists print_orders_job_id_idx on print_orders (job_id) where job_id is not null;

-- Appends failure_evidence at the END of the existing column list — a bare
-- `create or replace view` refuses to reorder/remove existing columns, only
-- append new ones.
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
  pickup_mode, force_cover_sheet, sheet_kind, collected_via,
  failure_evidence
from public.print_jobs;

grant select on public.print_jobs_admin_view to authenticated;

-- Corrective action for a job that actually printed (confirmed by staff/
-- owner looking at it) but got marked print_failed anyway — e.g. the
-- fixed-timeout bug (see lib/print/ready-timing.ts's STUCK_JOB_TIMEOUT_CONFIG).
-- Does ONLY the authoritative print_jobs state flip here; the caller
-- (app/api/admin/mark-printed) is responsible for calling the SAME
-- recordCompletedPrint (lib/kiosk-stats.ts) the print agent's own success
-- path already uses, so the revenue/print_orders/tray-cartridge bookkeeping
-- this job missed the first time is the exact same code path, not a second,
-- separately-maintained copy of it.
--
-- The WHERE guard is the real enforcement, not the UI: status must still be
-- 'print_failed' (never usable on a job that's still live, or already
-- fixed), and refund_status must be neither 'refunded' (money already went
-- back — requirement: "impossible to use on a job that was already
-- refunded") nor 'processing' (a gateway call is live right now).
create or replace function public.mark_job_printed_no_refund_needed(
  p_job_id uuid,
  p_reason text,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before print_jobs;
  v_updated_rows integer;
begin
  -- Owner-only, same as every other refund-adjacent action (claim_refund_
  -- for_processing, complete_refund) — this touches refund_status and
  -- revenue, which staff can't even see (refund_status is masked to null
  -- for staff everywhere else in this schema).
  if public.current_app_role() <> 'owner' then
    raise exception 'Not authorized.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;

  select * into v_before from print_jobs where id = p_job_id;
  if v_before.id is null then
    raise exception 'Job not found.';
  end if;
  if v_before.status <> 'print_failed' then
    raise exception 'This job is not currently marked print_failed (it is "%").', v_before.status;
  end if;
  if v_before.refund_status = 'refunded' then
    raise exception 'This job has already been refunded — cannot mark it printed instead.';
  end if;
  if v_before.refund_status = 'processing' then
    raise exception 'A refund for this job is currently being processed — try again once it resolves.';
  end if;

  update print_jobs set
    status = 'printed',
    refund_status = 'not_needed',
    ready_at = coalesce(ready_at, now()),
    updated_at = now()
  where id = p_job_id and status = 'print_failed'
    and coalesce(refund_status, '') not in ('refunded', 'processing');
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows = 0 then
    raise exception 'Could not update this job — it may have changed state just now. Please refresh and try again.';
  end if;

  perform public.log_audit(
    p_action := 'job_marked_printed_no_refund',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object(
      'reason', p_reason,
      'previous_error', v_before.error,
      'previous_refund_status', v_before.refund_status
    ),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

grant execute on function public.mark_job_printed_no_refund_needed(uuid, text, uuid, text, text, text) to service_role;
