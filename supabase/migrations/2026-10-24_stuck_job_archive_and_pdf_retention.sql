-- Rollback:
--   drop table if exists print_job_archive;
--   alter table print_jobs drop column if exists pdf_deleted_at;
--   restore print_jobs_admin_view and mark_job_printed_no_refund_needed to their prior bodies (see git history)

-- Fix: mark_job_printed_no_refund_needed previously set refund_status to
-- 'not_needed' unconditionally. A free staff print or a reprint never had
-- a refund_status to begin with (the trigger that sets 'pending' never
-- fires for either — see set_print_job_refund_pending's own comment) — it
-- should stay null for those, exactly as if this job had simply printed
-- normally. Only a genuinely PAID customer job gets 'not_needed'.
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
    refund_status = case when v_before.is_free or v_before.original_job_id is not null then null else 'not_needed' end,
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

-- Set the instant lib/store.ts's deleteJobPdfOnly removes just the stored
-- PDF for a print_failed job whose refund is STILL unresolved after
-- REFUND_PENDING_FILE_RETENTION_DAYS (lib/config.ts) — null means the file
-- (if any) is still there. The job row, total_price, and refund_status are
-- never touched by this; only Reprint stops being possible.
alter table print_jobs add column if not exists pdf_deleted_at timestamptz;

-- Appends pdf_deleted_at at the END of the existing column list — a bare
-- `create or replace view` refuses to reorder/remove existing columns.
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
  failure_evidence,
  pdf_deleted_at
from public.print_jobs;

grant select on public.print_jobs_admin_view to authenticated;

-- A slim, PERMANENT record of every job that ever reached a terminal
-- state — survives the full-row delete the cleanup cron does after
-- TERMINAL_JOB_RETENTION_HOURS. Deliberately carries only what's needed
-- for a "what happened to job X" lookup months later, never the file name,
-- phone number, or any uploaded content — the cleanup that writes this
-- (see lib/store.ts's deleteJob) removes the Storage object in the SAME
-- pass, so nothing personal outlives this row.
--
-- Never read by any revenue/stats function (get_kiosk_period_breakdown and
-- friends already read print_orders/refund_events, not print_jobs — see
-- that migration's own comments) — this table exists purely as a
-- historical archive, so it can't ever double-count or otherwise disturb
-- an existing revenue figure.
create table if not exists print_job_archive (
  id uuid primary key,
  kiosk_id text not null,
  created_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  pages integer,
  copies integer,
  color_mode boolean,
  amount numeric,
  refund_status text,
  refund_provider_id text,
  provider_order_id text,
  archived_at timestamptz not null default now()
);

create index if not exists print_job_archive_kiosk_created_idx on print_job_archive (kiosk_id, created_at);

alter table print_job_archive enable row level security;
drop policy if exists "Owner reads print_job_archive" on print_job_archive;
create policy "Owner reads print_job_archive" on print_job_archive
for select using (public.current_app_role() = 'owner');

-- One-time backfill for every terminal job that already exists right now
-- (anything deleted by the cleanup cron BEFORE this migration ran is
-- permanently gone — there's no recovering that), so the archive isn't
-- empty for history going back further than TERMINAL_JOB_RETENTION_HOURS
-- from today. Every future terminal job gets archived by deleteJob itself,
-- at the moment it's actually removed, never by this.
insert into print_job_archive (id, kiosk_id, created_at, finished_at, status, pages, copies, color_mode, amount, refund_status, refund_provider_id, provider_order_id)
select
  pj.id, pj.kiosk_id, pj.created_at, coalesce(pj.ready_at, pj.updated_at), pj.status,
  public.physical_sheets_for_job(pj),
  greatest((pj.settings->>'copies')::integer, 1),
  (pj.settings->>'isColor')::boolean,
  pj.total_price, pj.refund_status, pj.refund_provider_id, pj.provider_order_id
from print_jobs pj
where pj.status in ('printed', 'print_failed', 'payment_failed', 'expired', 'cancelled', 'interrupted')
on conflict (id) do nothing;
