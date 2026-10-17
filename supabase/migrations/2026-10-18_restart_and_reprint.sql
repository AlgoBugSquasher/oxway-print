-- Two related fixes:
--
-- Part A — a print-agent RESTART must never fail or refund a job it was
-- mid-printing when it died, and must never silently auto-reprint one
-- either. A job like that now goes to a new 'interrupted' status instead
-- (see print-agent/index.ts's reconcileInFlightJobsOnBoot) — never
-- print_failed, so it never triggers the refund-pending trigger.
--
-- Part B — owner/admin can reprint a SUBSET of any job's pages (a fresh
-- page-range pick, not just "retry the whole thing again," which
-- force_reprint_job already does) as a new, free, clearly-marked REPRINT
-- job linked back to the original.
--
-- Run this ONCE, in order, in the Supabase SQL editor — DEV project
-- first, then production once verified there.
--
-- Additive only: four new nullable columns on print_jobs, two existing
-- CHECK constraints widened (new allowed values added, nothing removed),
-- one existing trigger function's body updated (same trigger, same
-- columns, just also excludes the new 'reprint' payment_method — exactly
-- like it already excludes 'staff'), one new trigger + function, one new
-- RPC, and print_jobs_admin_view extended with the four new columns.
-- Nothing existing is dropped, renamed, or narrowed.
--
-- Rollback:
--   drop trigger if exists print_jobs_set_original_refund_not_needed on print_jobs;
--   drop function if exists public.set_original_job_refund_not_needed();
--   drop function if exists public.create_reprint_job(uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid);
--   -- restore set_print_job_refund_pending()'s body to check only <> 'staff'
--   --   (see supabase/schema.sql's git history for the exact prior body)
--   -- restore print_jobs_admin_view to its pre-this-migration column list
--   alter table print_jobs drop constraint if exists print_jobs_payment_method_check;
--   alter table print_jobs add constraint print_jobs_payment_method_check check (payment_method in ('razorpay', 'cashfree', 'staff'));
--   alter table print_jobs drop constraint if exists print_jobs_refund_status_check;
--   alter table print_jobs add constraint print_jobs_refund_status_check check (refund_status in ('pending', 'processing', 'refunded', 'failed'));
--   alter table print_jobs
--     drop column if exists interrupted_reason,
--     drop column if exists interrupted_at,
--     drop column if exists original_job_id,
--     drop column if exists reprint_note;

-- ============================================================================
-- 1. print_jobs — four new nullable columns
-- ============================================================================
alter table print_jobs add column if not exists interrupted_reason text;
alter table print_jobs add column if not exists interrupted_at timestamptz;
alter table print_jobs add column if not exists original_job_id uuid references print_jobs(id);
alter table print_jobs add column if not exists reprint_note text;

create index if not exists print_jobs_original_job_id_idx on print_jobs (original_job_id) where original_job_id is not null;

-- ============================================================================
-- 2. Widen payment_method's CHECK to allow 'reprint' — a free "Reprint
--    pages" job (requirement: "marked REPRINT in lists") is deliberately
--    its OWN value, not folded into 'staff': it isn't a discretionary
--    staff favor, it's compensating for the agent's own earlier failure/
--    interruption on a DIFFERENT (the original) job, and showing a
--    reprinted customer order with a "STAFF" badge would be actively
--    misleading.
-- ============================================================================
alter table print_jobs drop constraint if exists print_jobs_payment_method_check;
alter table print_jobs add constraint print_jobs_payment_method_check
  check (payment_method in ('razorpay', 'cashfree', 'staff', 'reprint'));

-- ============================================================================
-- 3. Widen refund_status's CHECK to allow 'not_needed' — requirement: "if
--    its refund is pending ... when the reprint completes set that refund
--    to 'not_needed'." Distinct from null ("never needed a refund in the
--    first place") so an owner reviewing history later can tell the two
--    apart.
-- ============================================================================
alter table print_jobs drop constraint if exists print_jobs_refund_status_check;
alter table print_jobs add constraint print_jobs_refund_status_check
  check (refund_status in ('pending', 'processing', 'refunded', 'failed', 'not_needed'));

-- ============================================================================
-- 4. set_print_job_refund_pending() — exclude 'reprint' too, same
--    reasoning 'staff' is already excluded for (see supabase/schema.sql's
--    own comment on the original function): a reprint job's total_price
--    is always 0, so even if ONE somehow failed, there's nothing to
--    refund for IT specifically (the ORIGINAL job's own refund situation,
--    if any, is handled separately below).
-- ============================================================================
create or replace function public.set_print_job_refund_pending()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'print_failed'
     and old.status is distinct from 'print_failed'
     and coalesce(new.payment_method, '') not in ('staff', 'reprint')
     and new.refund_status is null then
    new.refund_status := 'pending';
    new.refund_requested_at := now();
  end if;
  return new;
end;
$$;

-- ============================================================================
-- 5. set_original_job_refund_not_needed() trigger — requirement: "when the
--    reprint completes set that refund to 'not_needed'." AFTER UPDATE (not
--    BEFORE, unlike the triggers above) because this writes a DIFFERENT
--    row (the original job), not the row this statement itself is
--    updating — that only ever needs a real UPDATE statement, not a NEW
--    mutation, so there's no reason to run it before the reprint job's own
--    write has committed. Only ever moves 'pending' -> 'not_needed' — a
--    refund that's already 'processing', 'refunded', or 'failed' is left
--    exactly as it is, per the task's own "if its refund is pending" wording.
-- ============================================================================
create or replace function public.set_original_job_refund_not_needed()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'printed'
     and old.status is distinct from 'printed'
     and new.original_job_id is not null then
    update print_jobs
    set refund_status = 'not_needed', updated_at = now()
    where id = new.original_job_id and refund_status = 'pending';
  end if;
  return new;
end;
$$;

create trigger print_jobs_set_original_refund_not_needed
  after update on print_jobs
  for each row execute function public.set_original_job_refund_not_needed();

-- ============================================================================
-- 6. create_reprint_job() — requirement #4/#5: owner-only, atomically
--    inserts the new linked job, writes the "reprinted pages X to Y" note
--    onto the original, and logs one audit entry — all in one transaction.
-- ============================================================================
--
-- NOT granted to authenticated — unlike force_reprint_job/cancel_job
-- (owner OR staff, and reachable directly from the browser), this is
-- owner-only (requirement: "Part B: Reprint pages (owner/admin only)")
-- AND needs real server-side work first (downloading the original PDF,
-- extracting the selected pages, re-uploading the result, validating the
-- selection against the real page count) that doesn't belong inside a
-- Postgres function — so the real authorization boundary is
-- app/api/admin/reprint's own server-side session check, service-role key,
-- same split of responsibility app/api/admin/refund already has. The role
-- check here is still real defense-in-depth, same reasoning
-- create_staff_print_job's own comment gives for its (looser) check.
--
-- `p_selected_pages`/`p_settings` are trusted here because the CALLER
-- (the Next.js route) has ALREADY validated every page number against the
-- original job's own real page count before ever calling this — this
-- function's own job is atomicity (the refund-conflict re-check, the
-- insert, the note, the audit entry, all-or-nothing), not re-deriving a
-- page count it has no way to check against (that requires actually
-- parsing the PDF, a Node-side operation).
create or replace function public.create_reprint_job(
  p_job_id uuid,
  p_original_job_id uuid,
  p_selected_pages jsonb,
  p_settings jsonb,
  p_include_banner_page boolean,
  p_content_hash text,
  p_pdf_storage_path text,
  p_reprint_note text,
  p_created_by uuid
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

  -- `for update` locks the original row for the rest of this transaction —
  -- closes the same kind of race claim_refund_for_processing's own atomic
  -- claim exists to close: an owner approving a refund and an owner
  -- reprinting the same job, at the same moment, from two different tabs.
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
    created_at, updated_at
  ) values (
    p_job_id, 'paid', v_original.file_name, p_selected_pages, p_settings, 0,
    '', false, p_include_banner_page, p_content_hash,
    v_original.provider, '', p_pdf_storage_path, v_original.kiosk_id,
    v_ticket_number, v_ticket_date,
    'reprint', p_created_by, p_original_job_id,
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

grant execute on function public.create_reprint_job(uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid) to service_role;

-- ============================================================================
-- 7. print_jobs_admin_view — surface the four new columns (requirement:
--    "marked REPRINT in lists", "Add a note on the original job",
--    "Interrupted jobs appear ... with a badge"). None of these are
--    money/PII — unmasked for both owner and staff, same reasoning
--    blocked_reason/print_blocked_reason already use.
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
  blocked_reason,
  interrupted_reason, interrupted_at, original_job_id, reprint_note
from public.print_jobs;
