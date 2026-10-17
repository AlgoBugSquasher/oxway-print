-- Refund approval workflow — stops the print agent's automatic refund-on-
-- print-failure (that call is removed from print-agent/index.ts in this
-- same change). A failed, previously-paid job now goes to refund_status =
-- 'pending' instead, and an owner reviews/approves it from a new "Refunds"
-- admin page before any money actually moves. Refunds always run at the
-- payment gateway's NORMAL speed — see lib/payment/razorpay.ts /
-- lib/payment/cashfree.ts for where that's now set explicitly.
--
-- Run this ONCE, in order, in the Supabase SQL editor — DEV project first,
-- then production once verified there.
--
-- Additive only: five new nullable columns on print_jobs, one new index,
-- one new trigger, four new functions (plus two existing functions
-- updated: force_reprint_job gets a tighter guard, print_jobs_admin_view
-- gains the five new columns, owner-masked same as total_price). Nothing
-- existing is dropped, renamed, or narrowed. The one-time backfill UPDATE
-- at the bottom only ever sets refund_status on rows that already have
-- refunded_at — it never touches any other column on any row.
--
-- Rollback:
--   drop trigger if exists print_jobs_set_refund_pending on print_jobs;
--   drop function if exists public.set_print_job_refund_pending();
--   drop function if exists public.claim_refund_for_processing(uuid);
--   drop function if exists public.complete_refund(uuid, text, boolean, uuid, text, text, text);
--   drop function if exists public.fail_refund(uuid, text, uuid, text, text, text);
--   drop function if exists public.record_refund_bulk_action(uuid[], numeric, integer, integer, uuid, text, text, text);
--   drop index if exists print_jobs_refund_status_idx;
--   alter table print_jobs
--     drop column if exists refund_status,
--     drop column if exists refund_requested_at,
--     drop column if exists refunded_by,
--     drop column if exists refund_provider_id,
--     drop column if exists refund_error;
--   -- print_jobs_admin_view and force_reprint_job would need restoring to
--   -- their pre-this-migration bodies too — see supabase/schema.sql's git
--   -- history for those exact definitions if a full rollback is ever needed.

-- ============================================================================
-- 1. print_jobs — five new nullable columns tracking the refund lifecycle
-- ============================================================================
--
-- refund_status is independent of `status` (same reasoning refunded_at's
-- own original comment already gives: a job's print outcome and its
-- refund state are two separate facts) and independent of refunded_at
-- (which stays exactly what it always was — "when the money actually
-- moved" — now just one of five fields describing the fuller lifecycle):
--   null       — this job never needed a refund (still live, or a free
--                staff print, which never had money move in the first
--                place — see set_print_job_refund_pending below).
--   'pending'  — failed after being paid; waiting for an owner to review.
--   'processing' — an owner has started a refund attempt; money may or may
--                not have moved yet at the gateway. Exists specifically so
--                a double click or two open tabs can never both reach the
--                gateway for the same job — see claim_refund_for_processing.
--   'refunded' — the gateway confirmed the money moved (or had already
--                moved on an earlier attempt whose own DB write failed —
--                see complete_refund's own comment). refunded_at is set
--                the same moment this is.
--   'failed'   — the gateway refused or errored on the most recent
--                attempt. refund_error holds why. An owner can retry,
--                which re-claims it back to 'processing'.
alter table print_jobs add column if not exists refund_status text
  check (refund_status in ('pending', 'processing', 'refunded', 'failed'));
alter table print_jobs add column if not exists refund_requested_at timestamptz;
alter table print_jobs add column if not exists refunded_by uuid references auth.users(id);
alter table print_jobs add column if not exists refund_provider_id text;
alter table print_jobs add column if not exists refund_error text;

-- Backs the Refunds admin page's own query (print_jobs_admin_view filtered
-- to refund_status = 'pending') — partial since almost every row will have
-- a null refund_status forever (every job that never failed, or never had
-- money move at all).
create index if not exists print_jobs_refund_status_idx
  on print_jobs (refund_status) where refund_status is not null;

-- ============================================================================
-- 2. set_print_job_refund_pending() trigger — structural, not something
--    application code has to remember to set itself (same reasoning
--    set_print_job_queue_time already established for queue_time).
-- ============================================================================
--
-- Fires only on the one real transition that ever matters: a job that was
-- NOT already print_failed becomes print_failed. `coalesce(new.payment_method,
-- '') <> 'staff'` is deliberately the SAME check lib/refund.ts's own
-- attemptRefund already used before this migration (payment_method, not
-- provider — see that file's own comment for why: a staff job's `provider`
-- column still holds a real-looking gateway name even though no gateway
-- order ever existed for one) — a free staff print must never get a
-- refund_status at all, since there was never any money to refund.
-- `new.refund_status is null` additionally makes this a no-op if refund_status
-- somehow already has a value (e.g. a reprint-then-fail-again cycle where
-- force_reprint_job already reset it to null first — this guard just means
-- "only set it from a true null," which is exactly what that reset is for).
create or replace function public.set_print_job_refund_pending()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'print_failed'
     and old.status is distinct from 'print_failed'
     and coalesce(new.payment_method, '') <> 'staff'
     and new.refund_status is null then
    new.refund_status := 'pending';
    new.refund_requested_at := now();
  end if;
  return new;
end;
$$;

create trigger print_jobs_set_refund_pending
  before update on print_jobs
  for each row execute function public.set_print_job_refund_pending();

-- ============================================================================
-- 3. claim_refund_for_processing() — the atomic claim (requirement #5:
--    "claim the job atomically so a double click or two tabs cannot refund
--    twice", and "re-check the job's current state and refuse if it
--    actually printed after the failure").
-- ============================================================================
--
-- SECURITY DEFINER, granted to service_role ONLY (same split as the
-- existing record_refund below it, and the same reasoning app/api/admin/
-- refund's own comment already gives: the real authorization boundary is
-- that route's own signed-in-owner check, done server-side with the
-- service-role key, never a direct RLS/current_app_role() check reachable
-- from a browser session — there is deliberately no grant to
-- `authenticated` on any of the four functions in this section).
--
-- The single atomic UPDATE is the whole claim: it can only ever match a row
-- that is STILL status = 'print_failed' (refuses a job that's since been
-- reprinted — force_reprint_job moves status away from 'print_failed' the
-- moment a reprint starts, and now also resets refund_status to null, see
-- §6 below — and refuses a job that's since actually finished printing,
-- which also only happens after a reprint) AND still refund_status IN
-- ('pending', 'failed') (refuses a job someone else is already mid-refund
-- on, or one already refunded). Zero rows updated means the claim lost —
-- the SELECT below exists purely to report back PRECISELY why, in plain
-- language, rather than a generic "could not refund."
create or replace function public.claim_refund_for_processing(p_job_id uuid)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_count integer;
  v_current record;
begin
  update print_jobs
  set refund_status = 'processing', updated_at = now()
  where id = p_job_id and status = 'print_failed' and refund_status in ('pending', 'failed');
  get diagnostics v_updated_count = row_count;

  if v_updated_count = 0 then
    select status, refund_status into v_current from print_jobs where id = p_job_id;

    if v_current is null then
      raise exception 'Job not found.';
    -- Checked BEFORE refund_status below, deliberately: force_reprint_job
    -- (see §6 above) resets refund_status to null the instant a reprint
    -- starts, so a job that printed successfully after its earlier failure
    -- would otherwise fall into the much less informative "never needed a
    -- refund" branch below. Whenever status has moved off 'print_failed'
    -- at all, THIS is always the real, relevant explanation, regardless of
    -- whatever refund_status happens to read at that exact moment.
    elsif v_current.status <> 'print_failed' then
      raise exception 'This job is no longer print_failed (now "%") — it looks like it was reprinted or already printed. Refund cannot proceed.', v_current.status;
    elsif v_current.refund_status is null then
      raise exception 'This job never needed a refund.';
    elsif v_current.refund_status = 'processing' then
      raise exception 'This refund is already being processed — try again in a moment.';
    elsif v_current.refund_status = 'refunded' then
      raise exception 'This job was already refunded.';
    else
      raise exception 'Could not claim this refund right now — try again.';
    end if;
  end if;

  return query select * from print_jobs where id = p_job_id;
end;
$$;

grant execute on function public.claim_refund_for_processing(uuid) to service_role;

-- ============================================================================
-- 4. complete_refund() / fail_refund() — the two ways a claimed ('processing')
--    refund resolves. Mirrors record_refund's own existing split of
--    responsibility exactly: the gateway HTTP call itself (lib/refund.ts)
--    can never be part of a Postgres transaction, but everything on the
--    DATABASE side of "the gateway call just succeeded/failed" is now one.
-- ============================================================================

-- `p_already_refunded_at_provider` records whether THIS call's own gateway
-- response said "the money had already moved" (see lib/payment/razorpay.ts
-- and lib/payment/cashfree.ts's own pre-refund checks) rather than this
-- call being the one that actually moved it — kept in the audit details
-- purely for a human reviewing the trail later, never used for any logic
-- here. The `refund_status = 'processing'` guard means this can only ever
-- resolve a refund THIS SAME claim started — it is not a generic
-- "mark any job refunded" function.
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
  v_updated_rows integer;
begin
  select total_price, provider into v_total_price, v_provider from print_jobs where id = p_job_id;

  update print_jobs set
    refund_status = 'refunded',
    refunded_at = now(),
    refunded_by = p_actor_user_id,
    refund_provider_id = p_refund_id,
    refund_error = null,
    updated_at = now()
  where id = p_job_id and refund_status = 'processing';
  get diagnostics v_updated_rows = row_count;

  -- Reusing the existing 'job_refunded' action name (not a new one) — same
  -- action, same meaning, same label already in
  -- lib/admin/audit-descriptions.ts, just reached through the new
  -- claim-then-complete path instead of record_refund's older one-step path.
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

-- `refund_status = 'processing'` guard, same reasoning as complete_refund
-- above — this can only ever fail a refund THIS SAME claim started.
-- `left(p_error, 500)` bounds how much of a gateway error message ever
-- lands in the database — defensive truncation, not because gateway error
-- messages are expected to be huge, just never trust an upstream string's
-- length. Never pass a secret into p_error — see lib/refund.ts's own
-- comment on why a thrown gateway error's .message is safe to log (it
-- never includes API keys).
create or replace function public.fail_refund(
  p_job_id uuid,
  p_error text,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_ip text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update print_jobs set
    refund_status = 'failed',
    refund_error = left(p_error, 500),
    updated_at = now()
  where id = p_job_id and refund_status = 'processing';

  perform public.log_audit(
    p_action := 'refund_failed',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object('error', left(p_error, 500)),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );
end;
$$;

grant execute on function public.fail_refund(uuid, text, uuid, text, text, text) to service_role;

-- ============================================================================
-- 5. record_refund_bulk_action() — one summary audit entry per bulk
--    "Refund selected" click (requirement #5: "one for each bulk action
--    (who, which jobs, total)"), separate from the per-job job_refunded/
--    refund_failed entries complete_refund/fail_refund above already write.
-- ============================================================================
create or replace function public.record_refund_bulk_action(
  p_job_ids uuid[],
  p_total numeric,
  p_succeeded integer,
  p_failed integer,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_ip text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_audit(
    p_action := 'refund_bulk_requested',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job_bulk',
    p_target_id := null,
    p_details := jsonb_build_object(
      'job_ids', to_jsonb(p_job_ids),
      'count', coalesce(array_length(p_job_ids, 1), 0),
      'succeeded', p_succeeded,
      'failed', p_failed,
      'total', p_total
    ),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );
end;
$$;

grant execute on function public.record_refund_bulk_action(uuid[], numeric, integer, integer, uuid, text, text, text) to service_role;

-- ============================================================================
-- 6. force_reprint_job() — tightened guard
-- ============================================================================
--
-- Added `and coalesce(refund_status, '') <> 'processing'`: without it, a
-- reprint and an in-flight refund claim could race — the OLD guard
-- (`refunded_at is null`) only ever blocked a reprint once a refund had
-- fully COMPLETED, leaving the entire window while refund_status =
-- 'processing' (money possibly already sent to the gateway, DB not updated
-- yet) wide open for someone to also send the job back into the print
-- queue, which would mean a customer could get both their money back AND a
-- free reprint. This closes that gap.
--
-- Also resets refund_status/refund_requested_at/refund_error to null on a
-- successful reprint: once a job is back in the live queue, "needs a
-- refund" is no longer true (assuming it prints this time — and if it
-- fails AGAIN, set_print_job_refund_pending above fires again from this
-- same clean null, exactly as if it were a first failure). Without this,
-- the Refunds admin page would keep showing an already-resolved-by-reprint
-- job forever.
create or replace function public.force_reprint_job(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  update print_jobs set
    status = 'paid', updated_at = now(),
    refund_status = null, refund_requested_at = null, refund_error = null
  where id = p_job_id and status in ('print_failed', 'printed')
    and refunded_at is null and coalesce(refund_status, '') <> 'processing';
end;
$$;

-- ============================================================================
-- 7. print_jobs_admin_view — surface the five new columns, owner-masked the
--    same way total_price already is (requirement #4: "owner/admin only,
--    staff cannot see it" — enforced here, at the real boundary, not just
--    by which admin page links to which route; a staff session querying
--    this view directly over the REST API gets null for every one of these
--    five columns, same as it already gets null for total_price).
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
  case when public.current_app_role() = 'owner' then refund_error else null end as refund_error
from public.print_jobs;

-- ============================================================================
-- 8. Anonymous (customer status page) grant — add refund_status alongside
--    the existing refunded_at, same reasoning that column's own comment in
--    supabase/schema.sql §10 already gives: a print_failed job's own
--    customer needs to know whether a refund has happened yet, now via
--    Realtime's direct postgres_changes payload (app/api/verify-payment's
--    own poll already reads this server-side with the service-role key
--    regardless of any grant, so this grant only matters for the Realtime
--    subscription path). Just an enum (pending/processing/refunded/failed)
--    — no amount, no provider id, no payment details.
-- ============================================================================
grant select (refund_status) on public.print_jobs to anon;

-- ============================================================================
-- 9. One-time backfill — requirement #2: "Back-fill existing jobs that were
--    already refunded as refunded, using whatever refund data already
--    exists." The only data that already exists for a historical refund is
--    refunded_at itself (record_refund, the pre-this-migration path, never
--    wrote a refund_provider_id/refunded_by column because neither existed
--    yet) — so this sets refund_status alone and touches NOTHING else on
--    any row, exactly as asked. Safe to run more than once: the
--    `refund_status is null` guard makes a second run touch zero rows.
-- ============================================================================
update print_jobs
set refund_status = 'refunded'
where refunded_at is not null and refund_status is null;
