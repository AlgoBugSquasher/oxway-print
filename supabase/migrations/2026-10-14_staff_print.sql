-- OXWAY v2.5 — additive migration: free staff/owner prints, sharing the
-- same queue as paid customer jobs with no priority and no race conditions.
--
-- Run this ONCE, in the Supabase SQL editor, against the EXISTING project —
-- supabase/schema.sql already has this folded in for anyone setting up a
-- brand-new project after this point.
--
-- Every statement here is additive per ROADMAP.md's Ground Rules: nullable
-- columns with no backfill, a new standalone table, a trigger, and two new
-- RPCs — nothing existing is narrowed, dropped, or renamed. Safe to run
-- against a live project with existing rows and an already-running print
-- agent (the agent itself needs the matching code deploy to actually call
-- the new RPCs — see this migration's own closing note).

-- ============================================================================
-- 1. print_jobs — new nullable columns for staff/free prints
-- ============================================================================
--
-- `provider` (existing, NOT NULL) is left untouched and still gets a real
-- value ('razorpay' or 'cashfree', whichever is actually active) on a staff
-- job too — it's never meaningful for one (no gateway order exists), but
-- changing a NOT NULL column's own allowed values/meaning everywhere it's
-- read (refund routing, banner payment lines, Razorpay enrichment) is a far
-- bigger blast radius than introducing one new, purpose-built column.
-- `payment_method` is the real source of truth for "how did this job get
-- paid" from here on — every one of those call sites now checks it FIRST.
alter table print_jobs add column if not exists payment_method text
  check (payment_method in ('razorpay', 'cashfree', 'staff'));
alter table print_jobs add column if not exists created_by_user_id uuid references auth.users(id);
alter table print_jobs add column if not exists is_free boolean default false;
-- The price the job WOULD have cost at checkout, computed server-side from
-- the same pricing rules as a paying customer (lib/pricing.ts) — never from
-- anything the client claims. Null for every non-staff job.
alter table print_jobs add column if not exists waived_amount numeric;
alter table print_jobs add column if not exists idempotency_key text;
-- Set automatically by the trigger below the instant a job's status becomes
-- 'paid' — the single moment "ready to print" actually means, for either a
-- customer job (claimJobAsPaid's existing atomic UPDATE) or a staff job
-- (create_staff_print_job below, which inserts directly as 'paid'). This is
-- what the print agent orders its queue by, NOT created_at — a job that sat
-- in pending_payment for 3 minutes before paying shouldn't queue-jump a
-- staff print that was ready to print 10 seconds ago.
alter table print_jobs add column if not exists queue_time timestamptz;

-- Idempotency (#5): a retried/double-clicked staff-print submission with the
-- same key must resolve to the SAME job row, never a second one. Partial
-- (where idempotency_key is not null) so every existing/non-staff row — all
-- of which have a null key — never collides with each other under this
-- constraint.
create unique index if not exists print_jobs_idempotency_key_idx
  on print_jobs (idempotency_key) where idempotency_key is not null;

-- Backs the print agent's new atomic "claim the oldest ready job" query
-- (claim_next_paid_job below) — status/kiosk_id first (the WHERE clause),
-- queue_time second (the ORDER BY), matching that query's own shape exactly.
create index if not exists print_jobs_queue_claim_idx
  on print_jobs (status, kiosk_id, queue_time);

-- ============================================================================
-- 1b. kiosk_status — running counters for the dashboard's free-print summary
-- ============================================================================
--
-- Incremented alongside total_revenue/total_lifetime_prints at the exact
-- same moment (print COMPLETION, in recordCompletedPrint — not at
-- payment/creation time) and for the same reason those two are: a job that
-- never actually finished printing shouldn't count toward "how many free
-- prints have we done" any more than a job that never finished should
-- count toward revenue. Running counters, not summed from print_jobs on
-- every dashboard load, so the admin dashboard stays cheap regardless of
-- how large that table grows over the kiosk's lifetime.
alter table kiosk_status add column if not exists free_print_count integer not null default 0;
alter table kiosk_status add column if not exists free_print_pages integer not null default 0;
alter table kiosk_status add column if not exists free_print_waived_amount numeric not null default 0;

-- free_print_* are NOT masked for staff the way total_revenue is — waived
-- revenue isn't real revenue, and staff already know what they themselves
-- printed for free; there's no privacy reason to hide the aggregate.
create or replace view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp,
  free_print_count, free_print_pages, free_print_waived_amount
from public.kiosk_status;

-- ============================================================================
-- 2. staff_daily_page_usage — atomic per-(user, day) page counter
-- ============================================================================
--
-- Backs the daily page cap check in create_staff_print_job() below. Same
-- atomic INSERT...ON CONFLICT...RETURNING pattern kiosk_ticket_counters /
-- next_ticket_number() already use, for the identical reason documented
-- there: a read-then-write here would let two concurrent staff prints both
-- read the same starting count and both slip past the cap.
create table if not exists staff_daily_page_usage (
  user_id uuid not null references auth.users(id),
  usage_date date not null,
  pages_printed integer not null default 0,
  primary key (user_id, usage_date)
);

alter table staff_daily_page_usage enable row level security;
-- No policies — only ever touched inside create_staff_print_job() below,
-- itself only ever called with the service-role key from app/api/staff-print
-- (never granted to authenticated/anon — see that function's own comment),
-- same reasoning as print_jobs/kiosk_ticket_counters having zero policies.

-- ============================================================================
-- 3. Trigger — stamps queue_time the instant a job becomes 'paid'
-- ============================================================================
--
-- Structural, not something every write path has to remember to set itself:
-- fires on the customer path's existing claimJobAsPaid UPDATE (lib/store.ts
-- — unchanged, no application code edit needed) exactly the same way it
-- fires on create_staff_print_job's direct INSERT-as-paid below, so both
-- entry paths get their queue_time from the exact same clock (Postgres's
-- own now()) with no possibility of app-server/database clock skew ever
-- biasing the ordering toward one path over the other.
--
-- `new.queue_time is null` additionally makes this a no-op on any later
-- UPDATE that merely keeps an already-paid job's status at 'paid' while
-- changing something else (cups_job_id, etc.) — queue_time is set exactly
-- once, the moment a row first becomes 'paid', never re-stamped afterward.
create or replace function public.set_print_job_queue_time()
returns trigger language plpgsql as $$
begin
  if new.status = 'paid'
     and (tg_op = 'INSERT' or old.status is distinct from 'paid')
     and new.queue_time is null then
    new.queue_time := now();
  end if;
  return new;
end;
$$;

drop trigger if exists print_jobs_set_queue_time on print_jobs;
create trigger print_jobs_set_queue_time
  before insert or update on print_jobs
  for each row execute function public.set_print_job_queue_time();

-- ============================================================================
-- 4. create_staff_print_job() — one atomic transaction: idempotency check,
--    daily-cap check + increment, ticket number, job row, all or nothing.
-- ============================================================================
--
-- Never granted to authenticated/anon (no GRANT EXECUTE below) — the real
-- authorization boundary is app/api/staff-print's own server-side session
-- check (reads role from the verified Supabase session's app_metadata,
-- never from anything client-sent), exactly the same split of
-- responsibility app/api/admin/refund already has with RAZORPAY_KEY_SECRET.
-- This function is only ever called with the service-role key from that
-- route. The role check below is still real defense-in-depth (not a UX
-- nicety) in case this function's grants are ever loosened later — it's
-- just not the ONLY thing standing between a customer and a free print,
-- the missing grant already is.
create or replace function public.create_staff_print_job(
  p_job_id uuid,
  p_file_name text,
  p_selected_pages jsonb,
  p_settings jsonb,
  p_waived_amount numeric,
  p_content_hash text,
  p_provider text,
  p_pdf_storage_path text,
  p_kiosk_id text,
  p_idempotency_key text,
  p_created_by uuid,
  p_daily_cap integer
)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_ticket_number integer;
  v_ticket_date date;
  v_usage_date date := current_date;
  v_pages integer;
  v_used integer;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' and public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  -- Idempotency (#5) — must be checked (and must short-circuit) BEFORE the
  -- daily-cap increment and ticket assignment below, so a retried
  -- submission with the same key never double-counts the cap or burns a
  -- second ticket number for what is, to the staff member, one single print.
  if p_idempotency_key is not null then
    select id into v_existing_id from print_jobs where idempotency_key = p_idempotency_key;
    if found then
      return query select * from print_jobs where id = v_existing_id;
      return;
    end if;
  end if;

  v_pages := coalesce(jsonb_array_length(p_selected_pages), 0);
  if v_pages = 0 then
    raise exception 'No pages selected to print.';
  end if;

  insert into staff_daily_page_usage (user_id, usage_date, pages_printed)
  values (p_created_by, v_usage_date, v_pages)
  on conflict (user_id, usage_date) do update
    set pages_printed = staff_daily_page_usage.pages_printed + v_pages
  returning pages_printed into v_used;

  if v_used > p_daily_cap then
    -- Raising here rolls back the increment above too (same transaction) —
    -- a rejected-for-the-cap attempt never leaves a partial charge against
    -- tomorrow's allowance.
    raise exception 'Daily staff print cap reached (% of % pages used today).', v_used, p_daily_cap;
  end if;

  select ticket_number, ticket_date into v_ticket_number, v_ticket_date
  from public.next_ticket_number(p_kiosk_id);

  insert into print_jobs (
    id, status, file_name, selected_pages, settings, total_price,
    phone_number, notify_opt_in, include_banner_page, content_hash,
    provider, provider_order_id, pdf_storage_path, kiosk_id,
    ticket_number, ticket_date,
    payment_method, created_by_user_id, is_free, waived_amount, idempotency_key,
    created_at, updated_at
  ) values (
    p_job_id, 'paid', p_file_name, p_selected_pages, p_settings, 0,
    '', false, true, p_content_hash,
    p_provider, '', p_pdf_storage_path, p_kiosk_id,
    v_ticket_number, v_ticket_date,
    'staff', p_created_by, true, p_waived_amount, p_idempotency_key,
    v_now, v_now
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

-- ============================================================================
-- 5. claim_next_paid_job() — the print agent's atomic "pick the oldest
--    ready job" claim, replacing the old list-then-claim-each pattern.
-- ============================================================================
--
-- FOR UPDATE SKIP LOCKED means two concurrent callers (two agent processes,
-- or an agent mid-restart overlapping its own old process) can never both
-- select the same row — one locks it, the other's SELECT simply skips past
-- it to the next-oldest ready job instead of blocking or double-claiming.
-- The UPDATE's own status='paid' guard (same discipline as every other
-- atomic claim in lib/store.ts) is still what actually prevents a double
-- PRINT even in the near-impossible case two callers somehow raced past the
-- SKIP LOCKED itself.
--
-- `queue_time asc nulls first` processes any job that somehow has a null
-- queue_time (there shouldn't be one going forward — the trigger above sets
-- it unconditionally — but a job that was already sitting 'paid' from
-- before this migration ran would have one) BEFORE every job with a real
-- timestamp, since a null-queue_time job has necessarily been waiting the
-- longest. created_at is the tie-break for two jobs with the exact same
-- queue_time (vanishingly rare, but a deterministic order is still better
-- than an unspecified one).
--
-- Never granted to authenticated/anon — print-agent/index.ts is the only
-- caller, always with the service-role key.
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

  update print_jobs set status = 'printing', updated_at = now()
  where id = v_job_id and status = 'paid';

  return query select * from print_jobs where id = v_job_id;
end;
$$;

-- ============================================================================
-- 6. print_jobs_admin_view — surface the new staff-print columns
-- ============================================================================
--
-- Dropped and recreated rather than CREATE OR REPLACE — same reasoning (and
-- same fix) as 2026-10-09_color_bw_banner_notify.sql's own identical note:
-- CREATE OR REPLACE VIEW requires every existing column to keep the exact
-- same name AND position, and this SELECT list reorders include_banner_page
-- ahead of notify_opt_in/notified_at relative to that migration's live view
-- (phone_number, notify_opt_in, notified_at, include_banner_page, ...) —
-- Postgres reads that as an attempted rename of column 7 and refuses it
-- ("cannot change name of view column ... to ..."). Dropping first
-- sidesteps that entirely. Safe: a plain read-only SELECT view, grant
-- re-applied right after, and nothing in Postgres can depend on a view the
-- way it can on a table.
--
-- None of the four new columns are financial-masked (unlike total_price) —
-- staff can already see who printed what at their own kiosk; waived_amount
-- isn't real revenue and isn't sensitive the way total_price is.
drop view if exists public.print_jobs_admin_view;
create view public.print_jobs_admin_view as
select
  id, status, file_name, selected_pages, settings,
  case when public.current_app_role() = 'owner' then total_price else null end as total_price,
  phone_number, include_banner_page, provider, provider_order_id, pdf_storage_path,
  kiosk_id, ticket_number, ticket_date, collected_at,
  created_at, updated_at, error, cups_job_id, refunded_at,
  notify_opt_in, notified_at,
  payment_method, created_by_user_id, is_free, waived_amount
from public.print_jobs;

grant select on public.print_jobs_admin_view to authenticated;

-- ============================================================================
-- Not covered by a SQL grant: idempotency_key and queue_time are internal
-- plumbing — deliberately left OUT of print_jobs_admin_view above (no admin
-- UI reason to see either) and were never in the anon grant (§10 of
-- schema.sql) to begin with, same as payment_id/upi_txn_id/paid_amount
-- before them. payment_method/created_by_user_id/is_free/waived_amount are
-- likewise NOT added to the anon grant — review that grant statement in
-- schema.sql §10 if this migration is ever adapted; it must keep listing
-- only (id, status, error, ticket_number, updated_at, refunded_at).
-- ============================================================================

-- ============================================================================
-- Deploy order note (not SQL — read before running in production)
-- ============================================================================
-- Run this migration BEFORE deploying the matching application code. The
-- print agent's old list-then-claim code keeps working unmodified against
-- the new columns (they're all nullable/additive) until the new agent code
-- rolls out and switches to claim_next_paid_job() — there is no window
-- where the database alone can cause a double-print or a stuck queue.
