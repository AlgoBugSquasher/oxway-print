-- OXWAY v2.5 — additive migration: per-job print-stage timestamps, backing
-- the minimum-print-time floor the print agent now enforces before marking
-- a job "printed" (see lib/print/ready-timing.ts). Also documents the
-- banner-order flip (banner first, not last) — a pure application-code
-- change, nothing here depends on it, but see that file's own note.
--
-- Run this ONCE, in the Supabase SQL editor, against the EXISTING project —
-- supabase/schema.sql already has this folded in for anyone setting up a
-- brand-new project after this point.
--
-- Additive and nullable per ROADMAP.md's Ground Rules: four new columns, no
-- backfill, nothing existing narrowed or dropped. Safe to run against a
-- live project with existing rows and an already-running print agent.

-- ============================================================================
-- 1. print_jobs — four new per-job stage timestamps
-- ============================================================================
--
-- Deliberately NOT added to the anon grant (schema.sql §10) or to the
-- Realtime-relevant column list there — the customer-facing status page and
-- kiosk display both only ever need `status` itself (see
-- app/api/verify-payment and app/api/kiosk-display, neither of which reads
-- any of these four), so there's no reason either one would ever need
-- read access to them. They ARE added to print_jobs_admin_view below, for
-- diagnosing a slow/stuck print from the admin panel.
--
--   claimed_at      — the instant claim_next_paid_job() atomically moved
--                      this job from 'paid' to 'printing' (set by that RPC
--                      itself, using Postgres's own now() — same
--                      single-clock reasoning queue_time's trigger already
--                      established).
--   spooled_at       — the instant the print agent finished handing the
--                      fully-composed PDF to CUPS (`lp` returned a job id).
--   printer_idle_at  — the instant the agent FIRST observed CUPS report the
--                      job completed AND the printer itself idle (see
--                      getCupsJobQueueState) — may be well before ready_at,
--                      if the minimum-print-time floor hadn't elapsed yet.
--   ready_at         — the instant the job was actually marked 'printed' —
--                      always >= printer_idle_at, by however long the floor
--                      still needed.
alter table print_jobs add column if not exists claimed_at timestamptz;
alter table print_jobs add column if not exists spooled_at timestamptz;
alter table print_jobs add column if not exists printer_idle_at timestamptz;
alter table print_jobs add column if not exists ready_at timestamptz;

-- ============================================================================
-- 2. claim_next_paid_job() — also stamps claimed_at, resets the other three
-- ============================================================================
--
-- The reset (not just claimed_at's own stamp) matters specifically for a
-- REPRINT (force_reprint_job sets status back to 'paid', which routes the
-- job through this same claim path again): without it, spooled_at/
-- printer_idle_at/ready_at would still hold stale values from the job's
-- PREVIOUS (failed) attempt, which would make the stage-duration log for
-- the new attempt nonsensical (a "ready_at" from an attempt that never
-- actually finished this time). A job claimed for the first time already
-- has all three null, so this is a no-op for the normal case.
create or replace function public.claim_next_paid_job(p_kiosk_id text)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  select id into v_job_id
  from print_jobs
  where status = 'paid' and kiosk_id = p_kiosk_id
  order by queue_time asc nulls first, created_at asc
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update print_jobs
  set status = 'printing', updated_at = now(), claimed_at = now(),
      spooled_at = null, printer_idle_at = null, ready_at = null
  where id = v_job_id and status = 'paid';

  return query select * from print_jobs where id = v_job_id;
end;
$$;

-- ============================================================================
-- 3. print_jobs_admin_view — surface the four new timing columns
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
  claimed_at, spooled_at, printer_idle_at, ready_at
from public.print_jobs;
