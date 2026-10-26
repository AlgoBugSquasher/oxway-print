-- OXWAY v2.5 — complete database schema
--
-- Run this ONCE, in order, against a brand-new empty Supabase project's SQL
-- editor. This file is the single source of truth for the schema — it is
-- deliberately complete up front (including columns for features that are
-- disabled in this build's application code) so that re-enabling a disabled
-- feature later is a pure code change, never a new migration. See
-- ROADMAP.md's Ground Rules section for why.
--
-- Columns/tables marked "disabled feature" below have real application code
-- pointed at them ported into this repo, just commented out. Columns marked
-- "reserved, unused" have no application code at all yet — they exist only
-- so a later feature doesn't require a migration.

-- ============================================================================
-- 1. print_jobs — the single table every part of the system reads/writes
-- ============================================================================

create table print_jobs (
  id uuid primary key,
  status text not null default 'pending_payment',
  file_name text not null,
  selected_pages jsonb not null,
  settings jsonb not null,
  total_price numeric not null,

  -- Customer's phone number, only ever populated when notify_opt_in is
  -- true (WhatsApp "print ready" updates) — the checkout form never
  -- collects or sends it otherwise, and the server re-enforces that
  -- regardless of what a request claims (see app/api/create-order).
  phone_number text not null default '',
  -- WhatsApp opt-in — gates both whether phone_number is ever collected
  -- and whether lib/notify/'s MSG91 provider sends anything for this job
  -- at all (see notified_at below for the send-exactly-once guard).
  notify_opt_in boolean not null default false,
  -- Set the instant a terminal-state WhatsApp notification is actually
  -- sent for this job (print completion, or print_failed-and-refunded) —
  -- the atomic claim app/api/agent/notify's UPDATE ... WHERE notified_at
  -- IS NULL relies on, so a job can never get notified twice even if the
  -- print agent calls that endpoint more than once for the same job.
  notified_at timestamptz,

  -- Pickup-ID banner page — mandatory on every job (the opt-in checkbox
  -- was removed from the checkout form; app/api/create-order hardcodes
  -- this true server-side regardless of what a request sends). The column
  -- stays boolean rather than being dropped, in case it's ever made
  -- optional again — see lib/print/sheets.ts and lib/print/banner.ts,
  -- which already branch on this value rather than assuming it's always true.
  include_banner_page boolean not null default true,

  content_hash text not null default '',
  provider text not null,
  provider_order_id text not null default '',
  kiosk_id text not null default 'oxway_01',
  provider_meta jsonb,
  pdf_storage_path text not null,
  cups_job_id text,
  error text,

  -- Human-readable reason while status = 'print_blocked' (e.g.
  -- "media-empty") — see lib/print/cups.ts's classification and
  -- print-agent/index.ts's print loop. Independent of `error` above,
  -- which stays reserved for a genuine, FINAL print_failed reason — a
  -- blocked job hasn't failed, it's still live and expected to resume.
  blocked_reason text,

  -- Set once, the instant a print-agent RESTART discovers CUPS has no
  -- memory at all of a job that was still 'printing'/'print_blocked' when
  -- the agent last died (see print-agent/index.ts's
  -- reconcileInFlightJobsOnBoot and lib/print/cups.ts's isCupsJobKnown).
  -- Deliberately never cleared/changed again afterward — it's a
  -- historical fact about what happened at that restart, not a live
  -- condition like blocked_reason above.
  interrupted_reason text,
  interrupted_at timestamptz,

  -- Set only on a job created by the admin "Reprint pages" feature —
  -- points back at the job it's reprinting pages from. This is the single
  -- source of truth for "is this job a reprint" (drives the REPRINT badge
  -- in the admin Jobs list, skips Razorpay-enrichment and the
  -- refund-pending trigger the same way payment_method = 'staff' already
  -- does, and tells recordCompletedPrint to skip both revenue AND
  -- free_print_* bookkeeping — see lib/kiosk-stats.ts's isReprint).
  original_job_id uuid references print_jobs(id),
  -- Written on the ORIGINAL job the moment a reprint is created from it
  -- (requirement: "Add a note on the original job ('reprinted pages X to
  -- Y')") — see lib/print/reprint-note.ts's formatReprintNote. Purely
  -- informational, never read by any code.
  reprint_note text,

  -- set once a refund genuinely completes at the payment gateway — see
  -- refund_status below for the fuller lifecycle this is now one part of.
  refunded_at timestamptz,

  -- Refund approval workflow (v2.5) — a job that fails after being paid no
  -- longer refunds itself automatically (see print-agent/index.ts); it
  -- lands here as 'pending' instead (set by the
  -- set_print_job_refund_pending trigger in §7 below) and an owner reviews
  -- it from the admin "Refunds" page. null means "never needed a refund"
  -- (still live, or a free staff print — see that trigger's own comment
  -- for why payment_method, not provider, decides that). 'processing'
  -- exists specifically so a double click or two open tabs can never both
  -- reach the payment gateway for the same job (see
  -- claim_refund_for_processing). refund_requested_at is stamped once, the
  -- instant this first becomes 'pending', and never touched again by a
  -- later retry. refunded_by/refund_provider_id are only ever set once
  -- refund_status reaches 'refunded'. refund_error holds the most recent
  -- attempt's own failure message if refund_status is 'failed'. All five
  -- owner-masked in print_jobs_admin_view the same way total_price already
  -- is — staff cannot see any of this. 'not_needed' means a refund WAS
  -- pending but an owner reprinted the job instead and that reprint went
  -- on to print successfully (see set_original_job_refund_not_needed) —
  -- distinct from null ("never needed one in the first place").
  refund_status text check (refund_status in ('pending', 'processing', 'refunded', 'failed', 'not_needed')),
  refund_requested_at timestamptz,
  refunded_by uuid references auth.users(id),
  refund_provider_id text,
  refund_error text,

  -- new for v2.5 (§21) — the short pickup code, e.g. "#042". Assigned once,
  -- atomically, at job creation via next_ticket_number() below. ticket_date
  -- is stored alongside (not derived from created_at) so the pairing with
  -- kiosk_ticket_counters' own date-keyed row is unambiguous even for a job
  -- created right around midnight.
  ticket_number integer,
  ticket_date date,

  -- Payment details for the printed banner's "Total paid" / "UPI Txn ID"
  -- lines (see lib/print/banner.ts) — populated best-effort when a
  -- Razorpay payment is confirmed (lib/payment-reconciliation.ts). Always
  -- null for Cashfree jobs. Deliberately NOT included in the anon grant
  -- (§10 below) or in print_jobs_admin_view (§9) — never exposed to the
  -- customer-facing status page, Realtime, or the admin panel.
  payment_id text,
  upi_txn_id text,
  paid_amount numeric,

  -- Free staff/owner prints — see §6c/§6d below for the atomic RPCs that
  -- actually write these. `provider` above is still set to a real value
  -- ('razorpay'/'cashfree') on a staff job too, even though it's never
  -- meaningful for one (no gateway order exists) — payment_method is the
  -- real source of truth for "how did this job get paid," checked FIRST by
  -- every refund/banner/enrichment call site before it ever looks at
  -- provider. waived_amount is the price the job WOULD have cost a paying
  -- customer, computed server-side from the same pricing rules — never
  -- from anything the client claims. idempotency_key makes a retried staff
  -- submission resolve to the same job instead of creating a duplicate.
  -- queue_time is stamped automatically (§6e's trigger) the instant a job's
  -- status becomes 'paid' — what the print agent's queue is actually
  -- ordered by, not created_at, so neither a customer job nor a staff job
  -- ever gets priority over the other. 'reprint' is a THIRD free-job kind
  -- (see original_job_id above) — deliberately distinct from 'staff': a
  -- reprint isn't a discretionary staff favor, it's compensating for the
  -- agent's own earlier failure/interruption on a different (the
  -- original) job, and every refund/banner/enrichment call site that
  -- already checks for 'staff' first also checks for this.
  payment_method text check (payment_method in ('razorpay', 'cashfree', 'staff', 'reprint')),
  created_by_user_id uuid references auth.users(id),
  is_free boolean default false,
  waived_amount numeric,
  idempotency_key text,
  queue_time timestamptz,

  -- Per-job print-stage timestamps (added for the minimum-print-time floor
  -- — see lib/print/ready-timing.ts), stamped as the job moves through the
  -- print agent: claimed_at by claim_next_paid_job() itself (§6e below,
  -- using Postgres's own now(), same clock-consistency reasoning as
  -- queue_time's trigger), the rest by the agent as it progresses.
  -- Diagnostic only — never exposed to the anon role, Realtime, or either
  -- customer-facing "is it ready" surface, which still only ever reads
  -- `status` itself. Exposed on print_jobs_admin_view (§9) for diagnosing a
  -- slow/stuck print from the admin panel.
  claimed_at timestamptz,
  spooled_at timestamptz,
  printer_idle_at timestamptz,
  ready_at timestamptz,

  collected_at timestamptz,
  collected_via text check (collected_via in ('customer', 'staff')),
  pickup_mode text not null default 'here' check (pickup_mode in ('here', 'later')),
  force_cover_sheet boolean not null default false,
  sheet_kind text check (sheet_kind in ('none', 'separator', 'cover')),

  -- The CUPS/elapsed-time evidence finalizeFailure (print-agent/index.ts)
  -- saw at the moment it decided this job failed — the raw material behind
  -- `error`'s own short message, kept separately since `error` is a plain
  -- string shown to staff/owner as-is, while this is for admin job-detail
  -- debugging (added 2026-10-23, see that migration's own comment for why).
  failure_evidence jsonb,

  -- Set the instant lib/store.ts's deleteJobPdfOnly removes just the
  -- stored PDF for a print_failed job whose refund is still unresolved
  -- after REFUND_PENDING_FILE_RETENTION_DAYS (lib/config.ts, added
  -- 2026-10-24) — null means the file (if any) is still there. The job
  -- row, total_price, and refund_status are never touched by this; only
  -- Reprint stops being possible.
  pdf_deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index print_jobs_provider_order_id_idx on print_jobs (provider_order_id);
create index print_jobs_status_idx on print_jobs (status);
create index print_jobs_updated_at_idx on print_jobs (updated_at);
create index print_jobs_created_at_idx on print_jobs (created_at);
create index print_jobs_content_hash_idx on print_jobs (content_hash);
create index print_jobs_kiosk_id_idx on print_jobs (kiosk_id);

-- Backs the admin Jobs page's status-filtered query
-- (print_jobs_admin_view, status eq + created_at desc) directly, instead
-- of Postgres bitmap-AND-ing the two single-column indexes above.
create index print_jobs_status_created_at_idx on print_jobs (status, created_at desc);

-- Idempotency (a retried/double-clicked staff-print submission with the same
-- key must resolve to the same job, never a second one) — partial so every
-- row with a null key (every non-staff job) never collides with another.
create unique index print_jobs_idempotency_key_idx
  on print_jobs (idempotency_key) where idempotency_key is not null;

-- Backs claim_next_paid_job()'s atomic "pick the oldest ready job" query
-- (§6e below) — status/kiosk_id first (its WHERE clause), queue_time second
-- (its ORDER BY), matching that query's own shape exactly.
create index print_jobs_queue_claim_idx on print_jobs (status, kiosk_id, queue_time);

-- Backs the Refunds admin page's own query (print_jobs_admin_view filtered
-- to refund_status = 'pending') — partial since almost every row will have
-- a null refund_status forever (every job that never failed, or never had
-- money move at all).
create index print_jobs_refund_status_idx on print_jobs (refund_status) where refund_status is not null;
create index print_jobs_tray_lookup_idx on print_jobs (kiosk_id, ready_at) where status = 'printed' and collected_at is null;

-- Guards against two jobs on the same kiosk/day ever getting the same
-- ticket number. NULLs (jobs that fail before ticket assignment, if that
-- ever happens) don't collide with each other under a unique index.
create unique index print_jobs_kiosk_ticket_idx
  on print_jobs (kiosk_id, ticket_date, ticket_number);

alter table print_jobs enable row level security;
-- No policies here on purpose: the website's API routes and the Pi's print
-- agent both use the service-role key, which bypasses RLS entirely. The
-- print_jobs_admin_view below (not this table directly) is what the admin
-- panel's `authenticated` users read — see §9 (Views) for why direct table
-- access from `authenticated` is intentionally left with zero grants.

-- ============================================================================
-- 2. print_orders — owner-only revenue history
-- ============================================================================

create table print_orders (
  id uuid primary key default gen_random_uuid(),
  pages_printed integer not null,
  amount numeric not null,
  color_mode boolean not null,
  status text not null default 'completed',
  created_at timestamptz not null default now(),

  -- Added 2026-10-20 (supabase/migrations/2026-10-20_revenue_durable_ledger.sql)
  -- so this table can fully replace print_jobs as the source for
  -- get_kiosk_period_breakdown() below — print_jobs rows are hard-deleted
  -- by /api/cron/cleanup-jobs a few hours after printing, so "this
  -- week/month/year" can never be computed from it. This table is never
  -- touched by that cleanup, so every completed print (including a free
  -- staff print or a reprint) is now logged here unconditionally — see
  -- lib/kiosk-stats.ts's recordCompletedPrint. is_free/is_reprint let
  -- get_kiosk_period_breakdown() exclude them from the revenue sum without
  -- having skipped inserting the row at all; waived_amount mirrors
  -- print_jobs.waived_amount for a free print; sheet_kind mirrors
  -- print_jobs.sheet_kind.
  kiosk_id text,
  is_free boolean not null default false,
  is_reprint boolean not null default false,
  waived_amount numeric,
  sheet_kind text check (sheet_kind in ('none', 'separator', 'cover')),
  -- Added 2026-10-23 — lets a row be traced back to its job (debugging,
  -- and a defense-in-depth duplicate guard: the corrective action in
  -- mark_job_printed_no_refund_needed below calls the same
  -- recordCompletedPrint() a normal print already does, and this is what
  -- stops that from ever double-inserting the same job's revenue if it
  -- somehow ran twice). Null for every row written before this column
  -- existed — never backfilled, since there's no reliable way to match an
  -- old row back to a job after the fact.
  job_id uuid
);

create index print_orders_kiosk_created_idx on print_orders (kiosk_id, created_at);
create unique index print_orders_job_id_idx on print_orders (job_id) where job_id is not null;

alter table print_orders enable row level security;
-- Policy created in §9 below, after current_app_role() exists — a CREATE
-- POLICY's USING clause is resolved immediately, unlike a view or function
-- body, so the function it calls must already exist at this point.

-- ============================================================================
-- 2b. refund_events — durable, append-only record of a refund actually
-- resolving (complete_refund() below inserts one the instant its own
-- atomic claim succeeds). print_jobs' own refund_status/refunded_at are
-- hard-deleted along with the rest of the job a few hours after it
-- resolves (same cleanup cron as print_orders above), so
-- get_kiosk_period_breakdown() reads this table instead for "refunds
-- actually processed in period X" — independent of which period the
-- original payment fell in. kiosk_id/job_id are stored for completeness
-- even though no query currently filters by job_id.
-- ============================================================================

create table refund_events (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  job_id uuid not null,
  amount numeric not null,
  resolved_at timestamptz not null default now()
);

create index refund_events_kiosk_resolved_idx on refund_events (kiosk_id, resolved_at);

alter table refund_events enable row level security;
-- Policy created in §9 below, same reasoning as print_orders' own policy
-- comment just above.

-- ============================================================================
-- 2c. print_failures — durable, append-only record of a job reaching
-- print_failed (added 2026-10-21, supabase/migrations/2026-10-21_sales_stats.sql)
-- so get_kiosk_sales_summary() below can report a failure rate without
-- depending on print_jobs, which is cleaned up a few hours after this
-- resolves (see refund_events' own comment above for the identical
-- reasoning). Written from lib/store.ts's failPrintingJob — the one place
-- a job is ever actually marked print_failed.
-- ============================================================================

create table print_failures (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  job_id uuid not null,
  created_at timestamptz not null default now()
);

create index print_failures_kiosk_created_idx on print_failures (kiosk_id, created_at);

alter table print_failures enable row level security;
-- Policy created in §9 below, same reasoning as print_orders' own policy
-- comment above.

-- ============================================================================
-- 2d. print_job_archive — a slim, PERMANENT record of every job that ever
-- reached a terminal state (added 2026-10-24,
-- supabase/migrations/2026-10-24_stuck_job_archive_and_pdf_retention.sql).
-- Survives the full-row delete the cleanup cron does after
-- TERMINAL_JOB_RETENTION_HOURS — see lib/store.ts's deleteJob, which
-- writes one of these in the SAME pass it removes the job's row and
-- Storage object. Carries only what's needed for a "what happened to job
-- X" lookup months later: never the file name, phone number, or any
-- uploaded content, so nothing personal outlives the job's own row.
-- Never read by any revenue/stats function (get_kiosk_period_breakdown and
-- friends already read print_orders/refund_events, not print_jobs) — this
-- is a historical archive only, so it can never double-count or disturb
-- an existing revenue figure.
-- ============================================================================

create table print_job_archive (
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

create index print_job_archive_kiosk_created_idx on print_job_archive (kiosk_id, created_at);

alter table print_job_archive enable row level security;
-- Policy created in §9 below, same reasoning as print_orders' own policy
-- comment above.

-- ============================================================================
-- 3. kiosk_status — one row per physical kiosk
-- ============================================================================

create table kiosk_status (
  id text primary key,
  tray_pages integer not null default 0,
  cartridge_pages integer not null default 0,
  tray_max_pages integer not null default 150,       -- Samsung ML-1866W tray max
  cartridge_max_pages integer not null default 1500,  -- standard MLT-D104S yield
  -- "Remaining <= this %" triggers a low-supply alert (lib/alerts/) — editable from the kiosk card.
  low_supply_threshold_percent integer not null default 10 check (low_supply_threshold_percent between 1 and 99),
  total_revenue numeric not null default 0,
  total_lifetime_prints integer not null default 0,
  -- Free staff/owner prints — incremented alongside total_revenue/
  -- total_lifetime_prints above, at the exact same moment (print
  -- COMPLETION, in recordCompletedPrint — not at payment/creation time),
  -- for the same reason those two are: a job that never actually finished
  -- printing shouldn't count toward "how many free prints have we done"
  -- any more than a job that never finished should count toward revenue.
  -- Running counters, not summed from print_jobs on every dashboard load,
  -- so this stays cheap regardless of how large that table grows over the
  -- kiosk's lifetime — same reasoning total_revenue itself already
  -- established.
  free_print_count integer not null default 0,
  free_print_pages integer not null default 0,
  free_print_waived_amount numeric not null default 0,
  updated_at timestamptz not null default now(),

  -- Online/offline heartbeat (§10 below) — nullable, written by the print
  -- agent's own 20s timer, deliberately separate from updated_at (which also
  -- moves on every print-counter update) so "last alive" and "last printed"
  -- can never be confused with each other.
  last_seen_at timestamptz,

  -- Per-kiosk admin control over which color modes customers can select —
  -- e.g. toner running low, temporarily disable color without taking the
  -- whole kiosk offline. Both default true (nothing disabled until an
  -- owner/staff explicitly turns one off via update_kiosk_counters below).
  -- update_kiosk_counters itself refuses a write that would leave both
  -- false — there is no server-side invariant enforcing that here at the
  -- column level, intentionally, since a CHECK constraint can't see the
  -- *other* column's about-to-be-written value in the same statement as
  -- cleanly as the RPC's own pre-update guard can.
  allow_color boolean not null default true,
  allow_bw boolean not null default true,

  -- Owner-only (it controls messaging spend, see update_kiosk_whatsapp_
  -- availability below) — whether the WhatsApp "print ready" opt-in is
  -- even offered at this kiosk at all. Defaults false (off) rather than
  -- true like allow_color/allow_bw above: those two gate an existing,
  -- always-available choice, this one gates a feature that costs real
  -- money per message the moment a real MSG91 provider is wired up, so the
  -- safe default is "not offered" until an owner deliberately turns it on.
  allow_whatsapp boolean not null default false,

  -- Remote "Update kiosk" command — written by the print agent itself (never
  -- by the website), on every boot, so the admin panel can confirm which
  -- code a kiosk is actually running and when it last restarted. Nullable
  -- because a kiosk that has never booted the updated agent code has
  -- nothing to report yet.
  agent_commit text,
  agent_updated_at timestamptz,

  -- Kiosk-wide "can't print right now" signal — written only by the print
  -- agent (never the website) the instant it detects a RECOVERABLE
  -- printer problem (out of paper, door open, low toner, offline), and
  -- cleared the moment it's ready again. null means not blocked, the
  -- normal state. The website reads this (via /api/kiosk-status) to block
  -- new checkout and show a "temporarily unavailable" banner — requirement:
  -- never let a new customer pay while the machine can't actually print.
  print_blocked_reason text,
  print_blocked_at timestamptz,

  separator_mode text not null default 'auto' check (separator_mode in ('auto', 'always', 'never')),
  recent_job_minutes integer not null default 5,
  later_hold_hours integer not null default 2,
  large_job_pages integer not null default 15,
  tray_cleared_at timestamptz
);

insert into kiosk_status (id) values ('oxway_01');

alter table kiosk_status enable row level security;
-- Same as print_jobs: no policies, service-role key only, admin panel reads
-- via kiosk_status_admin_view instead.

-- ============================================================================
-- 4. create_order_rate_limits — §13 abuse protection on /api/create-order
-- ============================================================================

create table create_order_rate_limits (
  ip text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

alter table create_order_rate_limits enable row level security;
-- No policies — only ever touched server-side via increment_rate_limit(),
-- called with the service-role key from /api/create-order.

-- ============================================================================
-- 5. pricing_config — owner-only, single row, per-page pricing
-- ============================================================================

create table pricing_config (
  id text primary key default 'default',
  price_bw numeric(10,2) not null,
  price_color numeric(10,2) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into pricing_config (id, price_bw, price_color) values ('default', 2.00, 10.00);

alter table pricing_config enable row level security;
-- Policy created in §9 below, same reason as print_orders above.

-- ============================================================================
-- 6. kiosk_ticket_counters — new for v2.5 (§21), backs next_ticket_number()
-- ============================================================================

create table kiosk_ticket_counters (
  kiosk_id text not null,
  ticket_date date not null,
  last_number integer not null default 0,
  primary key (kiosk_id, ticket_date)
);

alter table kiosk_ticket_counters enable row level security;
-- No policies — only touched via next_ticket_number(), called server-side
-- with the service-role key from /api/create-order.

-- ============================================================================
-- 6b. kiosk_commands — remote "Update kiosk" / "Restart agent" commands
-- ============================================================================
--
-- One row per admin-requested command. The print agent polls for its own
-- kiosk's pending rows in its existing loop (print-agent/kiosk-update.ts) —
-- it never executes anything from `command`'s text directly, it only ever
-- switches on the two whitelisted values enforced by the check constraint
-- below and maps each to a fixed code path. status moves pending (just
-- requested) -> running (the agent claimed it, atomically, same UPDATE ...
-- WHERE pattern as print_jobs' claim functions) -> done | failed.

create table kiosk_commands (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  command text not null check (command in ('update', 'restart')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  result text
);

create index kiosk_commands_kiosk_status_idx on kiosk_commands (kiosk_id, status);
create index kiosk_commands_kiosk_requested_idx on kiosk_commands (kiosk_id, requested_at desc);

alter table kiosk_commands enable row level security;
-- No policies — the print agent polls/claims/finishes rows with the
-- service-role key (bypasses RLS, same as print_jobs/kiosk_status above);
-- the admin panel only ever reads via kiosk_commands_admin_view and writes
-- via the role-gated request_kiosk_command() RPC below, never this table
-- directly.

-- ============================================================================
-- 6c. staff_daily_page_usage — atomic per-(user, day) page counter
-- ============================================================================
--
-- Backs the daily page cap check in create_staff_print_job() below. Same
-- atomic INSERT...ON CONFLICT...RETURNING pattern kiosk_ticket_counters /
-- next_ticket_number() already use, for the identical reason documented
-- there: a read-then-write here would let two concurrent staff prints both
-- read the same starting count and both slip past the cap.

create table staff_daily_page_usage (
  user_id uuid not null references auth.users(id),
  usage_date date not null,
  pages_printed integer not null default 0,
  primary key (user_id, usage_date)
);

alter table staff_daily_page_usage enable row level security;
-- No policies — only ever touched inside create_staff_print_job() below,
-- itself only ever called with the service-role key from app/api/staff-print
-- (never granted to authenticated/anon), same reasoning as print_jobs/
-- kiosk_ticket_counters having zero policies.

-- ============================================================================
-- 7. Functions
-- ============================================================================

-- Atomic per-IP rate-limit counter for /api/create-order (§13). Reused
-- unchanged from v2 — the same INSERT ... ON CONFLICT ... RETURNING pattern
-- next_ticket_number() below deliberately copies for the same reason
-- (a read-then-write here would let two concurrent requests both read the
-- same starting count and both "win").
create or replace function increment_rate_limit(p_ip text, p_window_seconds integer)
returns integer
language plpgsql
as $$
declare
  current_count integer;
begin
  insert into create_order_rate_limits (ip, window_start, count)
  values (p_ip, now(), 1)
  on conflict (ip) do update
    set count = case
        when create_order_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
          then 1
        else create_order_rate_limits.count + 1
      end,
      window_start = case
        when create_order_rate_limits.window_start < now() - (p_window_seconds || ' seconds')::interval
          then now()
        else create_order_rate_limits.window_start
      end
  returning count into current_count;
  return current_count;
end;
$$;

-- Reads the caller's role out of the JWT's app_metadata (server-side only,
-- never client-editable — see ROADMAP.md §6). Every RLS policy and RPC
-- below checks for the specific allowed role, never "!= 'owner'", so a
-- role-less/misconfigured account defaults to zero access.
create or replace function public.current_app_role()
returns text
language sql stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', 'none');
$$;

-- New for v2.5 (§21) — atomically assigns the next short ticket number for
-- a kiosk's current day, resetting automatically once the day rolls over
-- in Asia/Kolkata (a new (kiosk_id, ticket_date) row just starts back at
-- 1) — computed via `now() at time zone 'Asia/Kolkata'`, not bare
-- `current_date`, so the reset happens at actual IST midnight regardless
-- of the database session's own configured timezone (Supabase projects
-- default to UTC, which would otherwise reset at 05:30 IST instead).
-- Returns the date it actually used alongside the number, rather than
-- making the caller independently compute "today" — if the app server's
-- clock and the database's clock ever drifted even slightly around
-- midnight, an app-computed date could mismatch the row this function
-- actually incremented. Returning both from the same source eliminates
-- that class of bug entirely rather than relying on clocks staying in sync.
--
-- Dropped first because Postgres refuses CREATE OR REPLACE when the return
-- type changes — safe to re-run this file from scratch even if an earlier
-- version of this function (a plain `returns integer`) already exists.
--
-- ON CONFLICT targets the primary key BY NAME (kiosk_ticket_counters_pkey,
-- Postgres's default name for an unnamed inline `primary key (...)`) rather
-- than by column list `(kiosk_id, ticket_date)` — that column-list form is
-- parsed as an expression list (it has to be, since Postgres also allows
-- expression-based unique indexes there), and `RETURNS TABLE(..., ticket_date
-- date)` makes `ticket_date` an implicit PL/pgSQL variable for this whole
-- function body. The two together made every bare `ticket_date` in an
-- expression position ambiguous — which column list isn't, so it never
-- showed up until Postgres actually tried to resolve the ON CONFLICT target.
drop function if exists public.next_ticket_number(text);
create or replace function public.next_ticket_number(p_kiosk_id text)
returns table(ticket_number integer, ticket_date date)
language plpgsql
as $$
declare
  v_ticket_date date := (now() at time zone 'Asia/Kolkata')::date;
  v_number integer;
begin
  insert into kiosk_ticket_counters (kiosk_id, ticket_date, last_number)
  values (p_kiosk_id, v_ticket_date, 1)
  on conflict on constraint kiosk_ticket_counters_pkey do update
    set last_number = kiosk_ticket_counters.last_number + 1
  returning last_number into v_number;
  return query select v_number, v_ticket_date;
end;
$$;

-- ============================================================================
-- 6d. set_print_job_queue_time() trigger — stamps queue_time atomically
-- ============================================================================
--
-- Structural, not something every write path has to remember to set itself:
-- fires on the customer path's existing claimJobAsPaid UPDATE (lib/store.ts
-- — no application code change needed there at all) exactly the same way it
-- fires on create_staff_print_job's direct INSERT-as-paid below, so both
-- entry paths get their queue_time from the exact same clock (Postgres's
-- own now()) with no possibility of app-server/database clock skew ever
-- biasing the queue order toward one path over the other.
--
-- `new.queue_time is null` additionally makes this a no-op on any later
-- UPDATE that merely keeps an already-paid job's status at 'paid' while
-- changing something else (cups_job_id, etc.) — queue_time is set exactly
-- once, the instant a row first becomes 'paid', never re-stamped afterward.
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

create trigger print_jobs_set_queue_time
  before insert or update on print_jobs
  for each row execute function public.set_print_job_queue_time();

-- ============================================================================
-- 6f. set_print_job_refund_pending() trigger — stamps refund_status
--     atomically the instant a paid job becomes print_failed
-- ============================================================================
--
-- Structural, same reasoning set_print_job_queue_time above already
-- established. Fires only on the one real transition that ever matters: a
-- job that was NOT already print_failed becomes print_failed.
-- `coalesce(new.payment_method, '') not in ('staff', 'reprint')` is the
-- SAME check lib/refund.ts's own attemptRefund already used before this
-- feature existed (payment_method, not provider — a staff/reprint job's
-- `provider` column still holds a real-looking gateway name even though
-- no gateway order ever existed for one) — a free staff print or a free
-- reprint must never get a refund_status at all, since there was never
-- any money to refund for either one specifically (a REPRINT job's own
-- ORIGINAL job's refund situation, if any, is handled separately — see
-- set_original_job_refund_not_needed below).
-- `new.refund_status is null` makes this a no-op if refund_status somehow
-- already has a value — specifically what lets a reprint-then-fail-again
-- cycle re-enter 'pending' cleanly (force_reprint_job resets it to null
-- first on a successful reprint — see §7 below).
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

create trigger print_jobs_set_refund_pending
  before update on print_jobs
  for each row execute function public.set_print_job_refund_pending();

-- ============================================================================
-- 6g. set_original_job_refund_not_needed() trigger — requirement: "when
--     the reprint completes set that refund to 'not_needed'." AFTER
--     UPDATE (unlike the BEFORE triggers above) because this writes a
--     DIFFERENT row (the original job), not the row this statement is
--     itself updating. Only ever moves 'pending' -> 'not_needed' — any
--     other refund_status on the original ('processing', 'refunded',
--     'failed') is left exactly as it is.
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
-- 6e. create_staff_print_job() / claim_next_paid_job()
-- ============================================================================
--
-- Neither is granted to authenticated/anon below — the real authorization
-- boundary for create_staff_print_job is app/api/staff-print's own
-- server-side session check (reads role from the verified Supabase
-- session's app_metadata, never from anything client-sent), exactly the
-- same split of responsibility app/api/admin/refund already has with
-- RAZORPAY_KEY_SECRET; claim_next_paid_job is only ever called by the print
-- agent, always with the service-role key. The role check inside
-- create_staff_print_job below is still real defense-in-depth (not merely a
-- UX nicety) in case its grants are ever loosened later — it's just not the
-- ONLY thing standing between a customer and a free print; the missing
-- grant already is.
--
-- One atomic transaction: idempotency check, daily-cap check + increment,
-- ticket number, job row — all or nothing. Idempotency is checked (and, if
-- it matches, short-circuits) BEFORE the daily-cap increment and ticket
-- assignment, so a retried submission with the same key never double-counts
-- the cap or burns a second ticket number for what is, to the staff member,
-- one single print.
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
  p_daily_cap integer,
  p_force_cover_sheet boolean default false
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
    pickup_mode, force_cover_sheet,
    created_at, updated_at
  ) values (
    p_job_id, 'paid', p_file_name, p_selected_pages, p_settings, 0,
    '', false, true, p_content_hash,
    p_provider, '', p_pdf_storage_path, p_kiosk_id,
    v_ticket_number, v_ticket_date,
    'staff', p_created_by, true, p_waived_amount, p_idempotency_key,
    'here', p_force_cover_sheet,
    v_now, v_now
  );

  perform public.log_audit(
    p_action := 'staff_print_created',
    p_actor_user_id := p_created_by,
    p_actor_role := 'staff',
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object('file_name', p_file_name, 'pages', v_pages, 'waived_amount', p_waived_amount)
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

-- ============================================================================
-- 6h. create_reprint_job() — owner-only, atomic "Reprint pages" creation
--     (requirement #4/#5 of the restart/reprint feature): inserts the new
--     linked job, writes the "reprinted pages X to Y" note onto the
--     original, and logs one audit entry, all or nothing.
-- ============================================================================
--
-- NOT granted to authenticated — unlike force_reprint_job/cancel_job
-- (owner OR staff, reachable directly from the browser), this is
-- owner-only AND needs real server-side work first (downloading the
-- original PDF, extracting the selected pages, re-uploading the result,
-- validating the selection against the real page count) that doesn't
-- belong inside a Postgres function — the real authorization boundary is
-- app/api/admin/reprint's own server-side session check, service-role
-- key, same split create_staff_print_job's own comment describes for its
-- (looser) check. `p_selected_pages`/`p_settings` are trusted here because
-- the CALLER has already validated every page number against the
-- original's own real page count before ever calling this — that
-- requires actually parsing the PDF, a Node-side operation this function
-- has no way to do.
create or replace function public.create_reprint_job(
  p_job_id uuid,
  p_original_job_id uuid,
  p_selected_pages jsonb,
  p_settings jsonb,
  p_include_banner_page boolean,
  p_content_hash text,
  p_pdf_storage_path text,
  p_reprint_note text,
  p_created_by uuid,
  p_force_cover_sheet boolean default false
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

  -- `for update` locks the original row for the rest of this transaction
  -- — closes the same kind of race claim_refund_for_processing's own
  -- atomic claim exists to close: an owner approving a refund and an
  -- owner reprinting the same job, at the same moment, from two tabs.
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
    pickup_mode, force_cover_sheet,
    created_at, updated_at
  ) values (
    p_job_id, 'paid', v_original.file_name, p_selected_pages, p_settings, 0,
    '', false, p_include_banner_page, p_content_hash,
    v_original.provider, '', p_pdf_storage_path, v_original.kiosk_id,
    v_ticket_number, v_ticket_date,
    'reprint', p_created_by, p_original_job_id,
    'here', p_force_cover_sheet,
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

grant execute on function public.create_reprint_job(uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid, boolean) to service_role;

-- The print agent's atomic "pick the oldest ready job" claim, replacing the
-- old list-then-claim-each pattern (listPaidJobs + a per-row claimJobForPrinting
-- loop). FOR UPDATE SKIP LOCKED means two concurrent callers (two agent
-- processes, or an agent mid-restart briefly overlapping its own old
-- process) can never both select the same row — one locks it, the other's
-- SELECT simply skips past it to the next-oldest ready job instead of
-- blocking or double-claiming. The UPDATE's own status='paid' guard (same
-- discipline as every other atomic claim in lib/store.ts) is still what
-- actually prevents a double PRINT even in the near-impossible case two
-- callers somehow raced past the SKIP LOCKED itself.
--
-- `queue_time asc nulls first` processes any job with a null queue_time
-- (there shouldn't be one going forward — the trigger above sets it
-- unconditionally — but a job already sitting 'paid' from before this
-- feature existed would have one) BEFORE every job with a real timestamp,
-- since a null-queue_time job has necessarily been waiting the longest.
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

  -- claimed_at uses Postgres's own now(), same single-clock reasoning as
  -- queue_time's trigger. The other three stage timestamps are reset to
  -- null here (not just left as-is) so a REPRINT (force_reprint_job sets
  -- status back to 'paid', routing the job through this same claim path
  -- again) never carries stale spooled_at/printer_idle_at/ready_at from a
  -- previous, failed attempt into this one's stage-duration log.
  update print_jobs
  set status = 'printing', updated_at = now(), claimed_at = now(),
      spooled_at = null, printer_idle_at = null, ready_at = null
  where id = v_job_id and status = 'paid';

  return query select * from print_jobs where id = v_job_id;
end;
$$;

-- --- Owner/staff write RPCs ------------------------------------------------
-- Writes from the admin panel go through these, not direct table UPDATEs —
-- each checks the caller's role itself, so even a hidden-but-technically-
-- reachable UI action still gets refused server-side.

create or replace function public.mark_job_refunded(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can mark a job refunded.';
  end if;
  update print_jobs set refunded_at = now() where id = p_job_id and refunded_at is null;
end;
$$;

create or replace function public.force_reprint_job(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  -- refunded_at is null guards against a real money bug: reprinting an
  -- already-refunded job would give the customer both their money back
  -- and a free print. coalesce(refund_status, '') <> 'processing' closes a
  -- related gap: without it, a reprint could race an in-flight refund
  -- claim (money possibly already sent to the gateway, refunded_at not
  -- set yet) and the job could still get reprinted during that window.
  --
  -- Also resets refund_status/refund_requested_at/refund_error to null on
  -- a successful reprint — once a job is back in the live queue, "needs a
  -- refund" is no longer true; if it fails again, set_print_job_refund_pending
  -- fires again from this same clean null, exactly as if it were a first
  -- failure. Without this, the Refunds admin page would keep showing an
  -- already-resolved-by-reprint job forever.
  update print_jobs set
    status = 'paid', updated_at = now(),
    refund_status = null, refund_requested_at = null, refund_error = null
  where id = p_job_id and status in ('print_failed', 'printed')
    and refunded_at is null and coalesce(refund_status, '') <> 'processing';
end;
$$;

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

  -- 'print_blocked' included — a blocked job is still "in the active
  -- queue, not yet resolved," and an owner/staff member should be able to
  -- give up on it deliberately (e.g. to refund instead) rather than it
  -- being a dead end until the print agent's own retry-time-limit expires
  -- on its own.
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

-- Dropped first because adding the two new trailing parameters changes this
-- function's argument-type signature — CREATE OR REPLACE only actually
-- replaces a function when its parameter *types* match exactly; otherwise
-- Postgres creates a second, overloaded version instead of replacing the
-- old 5-arg one, leaving both reachable. Same reasoning next_ticket_number
-- above already documents for its own return-type change.
drop function if exists public.update_kiosk_counters(text, integer, integer, integer, integer);
create or replace function public.update_kiosk_counters(
  p_kiosk_id text,
  p_tray_pages integer default null,
  p_cartridge_pages integer default null,
  p_tray_max_pages integer default null,
  p_cartridge_max_pages integer default null,
  p_allow_color boolean default null,
  p_allow_bw boolean default null,
  p_low_supply_threshold_percent integer default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_resulting_allow_color boolean;
  v_resulting_allow_bw boolean;
  v_old kiosk_status;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_low_supply_threshold_percent is not null and (p_low_supply_threshold_percent < 1 or p_low_supply_threshold_percent > 99) then
    raise exception 'Low-supply threshold must be between 1 and 99.';
  end if;

  select * into v_old from kiosk_status where id = p_kiosk_id;

  -- Refuse a write that would leave both color and B&W disabled — the
  -- customer page would have nothing sellable left to offer. Computed
  -- against what the row would actually end up as (coalesce of the new
  -- value or whatever's already there), not just the raw params, so this
  -- still catches e.g. "turn color off" when B&W is already off from an
  -- earlier edit.
  select coalesce(p_allow_color, allow_color), coalesce(p_allow_bw, allow_bw)
    into v_resulting_allow_color, v_resulting_allow_bw
  from kiosk_status where id = p_kiosk_id;

  if v_resulting_allow_color is false and v_resulting_allow_bw is false then
    raise exception 'At least one of Color or B&W must stay enabled.';
  end if;

  update kiosk_status set
    tray_pages = coalesce(p_tray_pages, tray_pages),
    cartridge_pages = coalesce(p_cartridge_pages, cartridge_pages),
    tray_max_pages = coalesce(p_tray_max_pages, tray_max_pages),
    cartridge_max_pages = coalesce(p_cartridge_max_pages, cartridge_max_pages),
    allow_color = coalesce(p_allow_color, allow_color),
    allow_bw = coalesce(p_allow_bw, allow_bw),
    low_supply_threshold_percent = coalesce(p_low_supply_threshold_percent, low_supply_threshold_percent),
    updated_at = now()
  where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'kiosk_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object(
      'before', jsonb_build_object(
        'tray_pages', v_old.tray_pages, 'cartridge_pages', v_old.cartridge_pages,
        'tray_max_pages', v_old.tray_max_pages, 'cartridge_max_pages', v_old.cartridge_max_pages,
        'allow_color', v_old.allow_color, 'allow_bw', v_old.allow_bw,
        'low_supply_threshold_percent', v_old.low_supply_threshold_percent
      ),
      'after', jsonb_build_object(
        'tray_pages', coalesce(p_tray_pages, v_old.tray_pages), 'cartridge_pages', coalesce(p_cartridge_pages, v_old.cartridge_pages),
        'tray_max_pages', coalesce(p_tray_max_pages, v_old.tray_max_pages), 'cartridge_max_pages', coalesce(p_cartridge_max_pages, v_old.cartridge_max_pages),
        'allow_color', v_resulting_allow_color, 'allow_bw', v_resulting_allow_bw,
        'low_supply_threshold_percent', coalesce(p_low_supply_threshold_percent, v_old.low_supply_threshold_percent)
      )
    )
  );
end;
$$;

-- Owner-only, separate from update_kiosk_counters above (which is owner
-- AND staff) rather than a third parameter on it — this one controls real
-- messaging spend once a paid provider is wired up, so it gets its own
-- single-purpose RPC with its own stricter role check, same split as
-- update_pricing being its own owner-only RPC rather than a parameter on
-- update_kiosk_counters.
create or replace function public.update_kiosk_whatsapp_availability(p_kiosk_id text, p_allow_whatsapp boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old_allow_whatsapp boolean;
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can change WhatsApp availability.';
  end if;

  select allow_whatsapp into v_old_allow_whatsapp from kiosk_status where id = p_kiosk_id;

  update kiosk_status set allow_whatsapp = p_allow_whatsapp, updated_at = now() where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'kiosk_whatsapp_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object(
      'before', jsonb_build_object('allow_whatsapp', v_old_allow_whatsapp),
      'after', jsonb_build_object('allow_whatsapp', p_allow_whatsapp)
    )
  );
end;
$$;

create or replace function public.update_pricing(p_price_bw numeric, p_price_color numeric)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_old_price_bw numeric;
  v_old_price_color numeric;
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can edit pricing.';
  end if;
  if p_price_bw <= 0 or p_price_color <= 0 then
    raise exception 'Prices must be positive.';
  end if;

  select price_bw, price_color into v_old_price_bw, v_old_price_color from pricing_config where id = 'default';

  update pricing_config set
    price_bw = p_price_bw, price_color = p_price_color,
    updated_at = now(), updated_by = auth.uid()
  where id = 'default';

  perform public.log_audit(
    p_action := 'pricing_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_target_type := 'pricing_config',
    p_target_id := 'default',
    p_details := jsonb_build_object(
      'before', jsonb_build_object('price_bw', v_old_price_bw, 'price_color', v_old_price_color),
      'after', jsonb_build_object('price_bw', p_price_bw, 'price_color', p_price_color)
    )
  );
end;
$$;

-- Remote "Update kiosk" / "Restart agent" — inserts the command row the
-- print agent's own poll loop picks up. Refuses a second command while one
-- is still pending/running for the same kiosk (the admin UI also disables
-- the button for this, but that's a UX nicety, not the real guard — same
-- division of responsibility as update_kiosk_counters' both-disabled check
-- above).
create or replace function public.request_kiosk_command(p_kiosk_id text, p_command text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_command not in ('update', 'restart') then
    raise exception 'Unknown command.';
  end if;
  if exists (
    select 1 from kiosk_commands
    where kiosk_id = p_kiosk_id and status in ('pending', 'running')
  ) then
    raise exception 'A command is already pending or running for this kiosk.';
  end if;
  insert into kiosk_commands (kiosk_id, command, requested_by)
  values (p_kiosk_id, p_command, auth.uid());

  perform public.log_audit(
    p_action := 'kiosk_command_requested',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object('command', p_command)
  );
end;
$$;

grant execute on function public.mark_job_refunded(uuid) to authenticated;
grant execute on function public.force_reprint_job(uuid) to authenticated;
grant execute on function public.cancel_job(uuid) to authenticated;
grant execute on function public.update_kiosk_counters(text, integer, integer, integer, integer, boolean, boolean, integer) to authenticated;
grant execute on function public.update_pricing(numeric, numeric) to authenticated;
grant execute on function public.request_kiosk_command(text, text) to authenticated;
grant execute on function public.update_kiosk_whatsapp_availability(text, boolean) to authenticated;

create or replace function public.update_kiosk_separator_settings(
  p_kiosk_id text,
  p_separator_mode text,
  p_recent_job_minutes integer,
  p_later_hold_hours integer,
  p_large_job_pages integer
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  if p_separator_mode not in ('auto', 'always', 'never') then
    raise exception 'Unknown separator_mode "%".', p_separator_mode;
  end if;
  if p_recent_job_minutes < 0 or p_later_hold_hours < 0 or p_large_job_pages < 1 then
    raise exception 'Invalid setting value.';
  end if;

  update kiosk_status set
    separator_mode = p_separator_mode,
    recent_job_minutes = p_recent_job_minutes,
    later_hold_hours = p_later_hold_hours,
    large_job_pages = p_large_job_pages,
    updated_at = now()
  where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'kiosk_separator_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object(
      'separator_mode', p_separator_mode,
      'recent_job_minutes', p_recent_job_minutes,
      'later_hold_hours', p_later_hold_hours,
      'large_job_pages', p_large_job_pages
    )
  );
end;
$$;

grant execute on function public.update_kiosk_separator_settings(text, text, integer, integer, integer) to authenticated;

create or replace function public.clear_kiosk_tray(p_kiosk_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  update kiosk_status set tray_cleared_at = now() where id = p_kiosk_id;

  perform public.log_audit(
    p_action := 'tray_cleared',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id
  );
end;
$$;

grant execute on function public.clear_kiosk_tray(text) to authenticated;

-- ============================================================================
-- 8. Policies that depend on current_app_role() existing (§7 above)
-- ============================================================================

create policy "Owner reads print_orders" on print_orders
for select using (public.current_app_role() = 'owner');

create policy "Owner reads refund_events" on refund_events
for select using (public.current_app_role() = 'owner');

create policy "Owner reads print_failures" on print_failures
for select using (public.current_app_role() = 'owner');

create policy "Owner reads print_job_archive" on print_job_archive
for select using (public.current_app_role() = 'owner');

create policy "Owner reads pricing" on pricing_config
for select using (public.current_app_role() = 'owner');

-- ============================================================================
-- 9. Views — the role-based column-masking layer for the admin panel
-- ============================================================================
--
-- Staff can read these views (job queue, kiosk health) but the financial
-- columns come back null for them. Direct SELECT on the underlying tables
-- is not granted to `authenticated` at all (see §1/§3's RLS blocks above) —
-- so a technically-savvy staff member querying the raw table over the REST
-- API still can't recover the real values. Writes never go through these
-- views; they go through the RPCs in §7.

-- Staff-print columns (payment_method, created_by_user_id, is_free,
-- waived_amount) are included unmasked for every role — none are
-- financial-masked the way total_price is: staff can already see who
-- printed what at their own kiosk, and waived_amount isn't real revenue.
--
-- The five refund_* columns ARE masked, same as total_price — the Refunds
-- admin page is owner-only, and this is the real enforcement of that (not
-- just which admin page links where): a staff session querying this view
-- directly gets null for every one of these, same as it already gets null
-- for total_price.
create view public.print_jobs_admin_view as
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

-- free_print_* are NOT masked for staff the way total_revenue is — waived
-- revenue isn't real revenue, and staff already know what they themselves
-- printed for free; there's no privacy reason to hide the aggregate.
-- print_blocked_reason/print_blocked_at are likewise unmasked — a supply/
-- readiness problem isn't money or PII.
create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp,
  free_print_count, free_print_pages, free_print_waived_amount,
  print_blocked_reason, print_blocked_at,
  separator_mode, recent_job_minutes, later_hold_hours, large_job_pages, tray_cleared_at,
  low_supply_threshold_percent
from public.kiosk_status;

-- Nothing in kiosk_commands is financial/sensitive — no column masking
-- needed, this view exists purely so `authenticated` never gets a direct
-- table grant (same reasoning as the two views above).
create view public.kiosk_commands_admin_view as
select id, kiosk_id, command, status, requested_by, requested_at, finished_at, result
from public.kiosk_commands;

grant select on public.print_jobs_admin_view to authenticated;
grant select on public.kiosk_status_admin_view to authenticated;
grant select on public.kiosk_commands_admin_view to authenticated;

-- ============================================================================
-- 10. Anonymous read access for the customer status page's Realtime signal
-- ============================================================================
--
-- print_jobs otherwise has zero policies (service-role only, see §1) — the
-- customer's own browser needs to subscribe directly via Supabase Realtime
-- (postgres_changes) to get an instant "printed" update, and Realtime
-- authorizes each subscription the same way PostgREST does: a real SELECT
-- grant plus a passing RLS policy for the connecting role (`anon` here,
-- since kiosk customers never sign in).
--
-- Scoped tightly on both axes:
--   - column grant: only the columns the status page actually needs, never
--     total_price/phone_number/file_name/settings/pdf_storage_path.
--     refunded_at included so a print_failed job can tell the customer
--     whether their auto-refund (lib/refund.ts) actually succeeded, rather
--     than showing a generic "failed" message that silently hides a
--     refund that also failed.
--   - policy: `using (true)` reads broad, but combined with the column grant
--     above the only way to ever address a matching row is to already know
--     its `id` (an unguessable uuid, never enumerated anywhere) — the exact
--     same trust model /api/verify-payment already uses (whoever holds the
--     id can read that job's status), just enforced by the database instead
--     of the API route so Realtime can check it independently.
--   - refund_status included alongside refunded_at for the same reason —
--     a print_failed job's own customer needs to know a refund is pending/
--     processing/refunded/failed via Realtime's direct payload, not just
--     the one-shot verify-payment poll (which reads it server-side with
--     the service-role key regardless of any grant). Just an enum — no
--     amount, no provider id, no payment details.
-- blocked_reason included alongside refund_status/error for the same
-- reason those are — a job's own customer should be able to see WHY it's
-- currently paused via Realtime's direct payload, not just that it is.
grant select (id, status, error, ticket_number, updated_at, refunded_at, refund_status, blocked_reason) on public.print_jobs to anon;

create policy "Anyone holding a job id can read its own status" on public.print_jobs
for select using (true);

-- ============================================================================
-- 11. audit_log — append-only, owner-only read
-- ============================================================================
--
-- bigint identity (not uuid) for `id`: this is a high-volume, strictly
-- append-only log where insertion order itself is meaningful (the viewer's
-- own "newest first" pagination needs an unambiguous tiebreaker for two
-- events landing in the same millisecond) — a monotonic integer gives that
-- for free; a uuid wouldn't.
--
-- actor_user_id is nullable: a system-initiated event (the print agent's
-- own automatic refund-on-failure) has no human actor. kiosk_id is
-- nullable: some actions aren't kiosk-scoped (pricing changes, sign-in/
-- out). target_type/target_id are free-form text (not a foreign key)
-- since the target varies by action (a print_jobs uuid, a kiosk_id
-- string, the fixed "default" pricing_config row, ...).
--
-- Never store secrets, a full phone number, or payment details beyond
-- ids — see lib/audit.ts's maskPhone()/maskEmail() and every call site
-- that writes into `details`.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id),
  actor_role text,
  kiosk_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb,
  ip text,
  user_agent text
);

create index audit_log_at_idx on audit_log (at desc, id desc);
create index audit_log_action_idx on audit_log (action);
create index audit_log_actor_user_id_idx on audit_log (actor_user_id);
create index audit_log_kiosk_id_idx on audit_log (kiosk_id);
create index audit_log_target_idx on audit_log (target_type, target_id);

alter table audit_log enable row level security;

create policy "Owner reads audit_log" on audit_log
for select using (public.current_app_role() = 'owner');

grant select on public.audit_log to authenticated;

-- Deliberately NO insert/update/delete policy for ANY role, owner
-- included, and NO grant to authenticated/anon at all for those
-- operations — the only way any row is ever written is log_audit() below,
-- a SECURITY DEFINER function that bypasses RLS as its owner. There is no
-- UPDATE or DELETE path anywhere, by any role — this table is genuinely
-- append-only, not just append-only-by-convention.
--
-- SECURITY DEFINER + the function owner's own implicit execute rights is
-- what lets every other SECURITY DEFINER RPC above (update_pricing,
-- cancel_job, ...) call this directly from its own PL/pgSQL body with NO
-- separate grant needed. The explicit grant below is only for
-- service_role (Node-side callers via lib/audit.ts: app/api/admin/login,
-- sign-out, refund, kiosk-update's result path, and any future feature's
-- server code) — `authenticated` and `anon` get NOTHING on this function,
-- so a signed-in browser client can never call it directly and inject a
-- fabricated entry.
--
-- Swallows its own failure as a last-resort backstop for an RPC that
-- calls this inline, mid-transaction — a raised exception here would
-- otherwise roll back the ENTIRE calling transaction (e.g. a real pricing
-- change) just because the audit insert itself failed. `raise warning`
-- so it's loud in Postgres's own logs; lib/audit.ts's Node-side logAudit()
-- has the equivalent try/catch + console.error for service_role callers.
create or replace function public.log_audit(
  p_action text,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_kiosk_id text default null,
  p_target_type text default null,
  p_target_id text default null,
  p_details jsonb default null,
  p_ip text default null,
  p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (action, actor_user_id, actor_role, kiosk_id, target_type, target_id, details, ip, user_agent)
  values (p_action, p_actor_user_id, p_actor_role, p_kiosk_id, p_target_type, p_target_id, p_details, p_ip, p_user_agent);
exception when others then
  raise warning 'log_audit failed for action "%": %', p_action, sqlerrm;
end;
$$;

grant execute on function public.log_audit(text, uuid, text, text, text, text, jsonb, text, text) to service_role;

-- Refund state change + its audit entry, one transaction — the gateway
-- HTTP call itself (Razorpay/Cashfree, in lib/refund.ts) can never be part
-- of a Postgres transaction, but everything on the DATABASE side of a
-- refund now genuinely is one: lib/refund.ts calls this ONE RPC right
-- after the gateway confirms the refund succeeded, instead of a plain
-- update. `refunded_at is null` in the WHERE guard is still the real
-- idempotency check — a second call for an already-refunded job updates
-- zero rows but still logs (worth recording "a refund was re-confirmed
-- for this job"), with before/after reflecting whether this call actually
-- changed anything.
create or replace function public.record_refund(
  p_job_id uuid,
  p_refund_id text,
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
  v_already_refunded_at timestamptz;
  v_updated_rows integer;
begin
  select total_price, provider, refunded_at into v_total_price, v_provider, v_already_refunded_at
  from print_jobs where id = p_job_id;

  update print_jobs set refunded_at = now() where id = p_job_id and refunded_at is null;
  get diagnostics v_updated_rows = row_count;

  perform public.log_audit(
    p_action := 'job_refunded',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object(
      'before', jsonb_build_object('refunded_at', v_already_refunded_at),
      'after', jsonb_build_object('refunded_at', case when v_updated_rows > 0 then now() else v_already_refunded_at end),
      'refund_id', p_refund_id,
      'amount', v_total_price,
      'provider', v_provider
    ),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );
end;
$$;

grant execute on function public.record_refund(uuid, text, uuid, text, text, text) to service_role;

-- ============================================================================
-- 11b. Refund approval workflow — claim_refund_for_processing() /
--      complete_refund() / fail_refund() / record_refund_bulk_action().
--      record_refund above stays as-is (dead code now that lib/refund.ts
--      no longer calls it, but kept rather than dropped — additive only).
-- ============================================================================
--
-- All four below: SECURITY DEFINER, granted to service_role ONLY, same
-- split as record_refund above — the real authorization boundary is
-- app/api/admin/refund's own signed-in-owner check, done server-side with
-- the service-role key, never a direct RLS/current_app_role() check
-- reachable from a browser session. No grant to authenticated/anon at all.

-- The atomic claim (requirement: "claim the job atomically so a double
-- click or two tabs cannot refund twice", and "re-check the job's current
-- state and refuse if it actually printed after the failure"). The single
-- atomic UPDATE is the whole claim: it can only ever match a row that is
-- STILL status = 'print_failed' (refuses a job that's since been
-- reprinted) AND still refund_status IN ('pending', 'failed') (refuses a
-- job someone else is already mid-refund on, or one already refunded).
-- Zero rows updated means the claim lost — the SELECT below exists purely
-- to report back PRECISELY why, in plain language.
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
    -- resets refund_status to null the instant a reprint starts, so a job
    -- that printed successfully after its earlier failure would otherwise
    -- fall into the much less informative "never needed a refund" branch.
    -- Whenever status has moved off 'print_failed' at all, THIS is always
    -- the real, relevant explanation, regardless of whatever refund_status
    -- happens to read at that exact moment.
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

-- Resolves a claimed ('processing') refund as successful. `refund_status =
-- 'processing'` in the WHERE guard means this can only ever resolve a
-- refund THIS SAME claim started — it is not a generic "mark any job
-- refunded" function. `p_already_refunded_at_provider` records whether
-- THIS call's own gateway response said "the money had already moved"
-- rather than this call being the one that actually moved it — kept in the
-- audit details purely for a human reviewing the trail later. Reuses the
-- existing 'job_refunded' audit action (same label already in
-- lib/admin/audit-descriptions.ts) — same action, same meaning, just
-- reached through this claim-then-complete path instead of record_refund's
-- older one-step path.
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

  -- Only a genuinely successful claim gets a durable ledger entry — see
  -- refund_events' own table comment above for why this exists at all
  -- (get_kiosk_period_breakdown() reads it instead of print_jobs, which
  -- gets cleaned up a few hours after a refund resolves).
  if v_updated_rows > 0 then
    insert into refund_events (kiosk_id, job_id, amount) values (v_kiosk_id, p_job_id, v_total_price);
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

grant execute on function public.complete_refund(uuid, text, boolean, uuid, text, text, text) to service_role;

-- Resolves a claimed ('processing') refund as failed. Same `refund_status
-- = 'processing'` guard as complete_refund above. `left(p_error, 500)`
-- bounds how much of a gateway error message ever lands in the database —
-- never trust an upstream string's length. Never pass a secret into
-- p_error — see lib/refund.ts's own comment on why a thrown gateway
-- error's .message is safe to log (it never includes API keys).
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

-- Corrective action (added 2026-10-23) for a job that actually printed
-- (confirmed by an owner looking at it) but got marked print_failed anyway
-- — e.g. the fixed-timeout bug, see lib/print/ready-timing.ts's
-- STUCK_JOB_TIMEOUT_CONFIG. Does ONLY the authoritative print_jobs state
-- flip here; the caller (app/api/admin/mark-printed) calls the SAME
-- recordCompletedPrint (lib/kiosk-stats.ts) the print agent's own success
-- path already uses for the revenue/print_orders/tray-cartridge bookkeeping
-- this job missed the first time, rather than a second copy of that logic.
-- The WHERE guard is the real enforcement, not the UI: status must still be
-- 'print_failed', and refund_status must be neither 'refunded' (requirement:
-- "impossible to use on a job that was already refunded") nor 'processing'
-- (a gateway call is live right now).
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
  -- Owner-only — but enforced by the grant below (service_role only, same
  -- as claim_refund_for_processing/complete_refund/fail_refund) plus the
  -- calling route's own session check (app/api/admin/mark-printed),
  -- never by current_app_role() here: that reads auth.jwt(), which is
  -- empty for a service-role call with no user JWT attached, so a check
  -- here would reject every legitimate call regardless of who the real
  -- actor is — exactly the "Not authorized" bug this fixes.
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

  -- Only a genuinely PAID customer job gets refund_status 'not_needed' —
  -- a free staff print or a reprint never had one to begin with (the
  -- set_print_job_refund_pending trigger never fires for either), and
  -- stays null here too, exactly as if it had simply printed normally.
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

-- One summary audit entry per bulk "Refund selected" click, separate from
-- the per-job job_refunded/refund_failed entries complete_refund/
-- fail_refund above already write for each job in the batch.
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
-- 10. Admin Overview dashboard (period revenue/pages) + paper/toner refill
--     tracking. Mirrored from
--     supabase/migrations/2026-10-14_overview_dashboard_and_refills.sql —
--     see that file for the full reasoning behind every design choice
--     below (bucketing timestamps, quantity semantics, masking, etc.).
-- ============================================================================

-- 10a. physical_sheets_for_job() — the one formula for "how many physical
-- sheets did this job use," shared by both features below. Mirrors
-- lib/print/sheets.ts's physicalSheetsForJob exactly: ceil(selected pages /
-- pagesPerSheet) * copies, plus the banner once. greatest(...,1) guards
-- against a malformed settings row ever dividing by zero in a dashboard
-- aggregate — defensive only, every real job always has valid settings.
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

-- 10b. get_kiosk_period_breakdown() — dense, zero-filled buckets for the
-- Overview page's period selector (Today/Week/Month/Year). Reads from
-- print_orders/refund_events (added 2026-10-20), NOT print_jobs — print_jobs
-- rows are hard-deleted by /api/cron/cleanup-jobs a few hours after reaching
-- a terminal state, so any period wider than that retention window could
-- never be computed from it; print_orders/refund_events are never touched
-- by that cleanup. revenue/pages are bucketed by print_orders.created_at
-- (stamped right as the job finishes printing — see
-- lib/kiosk-stats.ts's recordCompletedPrint, called right after
-- print-agent marks a job 'printed'); refunds are bucketed independently by
-- refund_events.resolved_at, so a refund resolved in a LATER period than
-- its original payment correctly reduces that later period's own revenue
-- figure, not the original one's. Money fields masked to null for
-- non-owners, same convention print_jobs_admin_view/kiosk_status_admin_view
-- already use. Bucket boundaries always computed via the
-- `date_trunc(unit, <ts> at time zone 'Asia/Kolkata') at time zone
-- 'Asia/Kolkata'` double-conversion so they land on real Kolkata wall-clock
-- boundaries regardless of the database session's own timezone; stepping a
-- generated series by a fixed interval from that aligned start is safe
-- because Asia/Kolkata has no DST.
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
    -- date_trunc('week', ...) is ISO 8601: Monday — exactly the "weeks
    -- start Monday" rule.
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
      count(*) as refund_count
    from refund_events re
    where (p_kiosk_id is null or re.kiosk_id = p_kiosk_id)
      and re.resolved_at >= v_period_start and re.resolved_at <= v_now
    group by 1
  )
  select
    b.bucket_start,
    case when v_is_owner then coalesce(o.revenue, 0) - coalesce(rf.refund_amount, 0) else null end,
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

grant execute on function public.get_kiosk_period_breakdown(text, text) to authenticated;

-- 10b-2. get_pending_refund_summary() — "pending" is deliberately NOT a
-- period: a refund stays pending until an owner resolves it regardless of
-- when the original job was created, so it has to be reported separately
-- from the bucketed breakdown above, never subtracted from any period's own
-- revenue (see the standing requirement: "Pending refunds shown separately,
-- not subtracted yet"). Safe to read live from print_jobs — a job with
-- refund_status in ('pending','processing','failed') is explicitly excluded
-- from /api/cron/cleanup-jobs until it resolves, so these rows are
-- guaranteed to still exist. Both fields null for staff, same masking
-- convention as get_kiosk_period_breakdown's own revenue fields.
create or replace function public.get_pending_refund_summary(p_kiosk_id text default null)
returns table (pending_refund_amount numeric, pending_refund_count integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_owner constant boolean := public.current_app_role() = 'owner';
begin
  return query
  select
    case when v_is_owner then coalesce(sum(total_price), 0) else null end,
    case when v_is_owner then count(*)::integer else null end
  from print_jobs
  where (p_kiosk_id is null or kiosk_id = p_kiosk_id)
    and refund_status in ('pending', 'processing', 'failed');
end;
$$;

grant execute on function public.get_pending_refund_summary(text) to authenticated;

-- 10b-3. period_start_for() — the same today/week/month/year branch
-- get_kiosk_period_breakdown() above already computes inline (left as-is
-- there, since it's already live and tested); every stats function added
-- from here on (10b-4 through 10b-7) calls this instead of repeating that
-- branch a fifth time.
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

-- 10b-4. get_kiosk_hourly_pattern() — "peak hours" for the Overview's
-- Statistics section: jobs/pages by hour of day (Kolkata wall-clock,
-- 0-23), dense zero-filled across all 24 hours so the bar chart never has
-- a gap. Reads print_orders, same durable-ledger reasoning as
-- get_kiosk_period_breakdown. No money — counts only, visible to staff.
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

-- 10b-5. get_kiosk_weekday_pattern() — "busiest days of the week" (the
-- weekday pattern, aggregated across the whole period — NOT specific
-- calendar dates, see get_kiosk_daily_pattern below for that). day_of_week
-- follows extract(dow ...)'s own convention: 0 = Sunday .. 6 = Saturday,
-- same as JavaScript's Date.getDay(), so the admin panel needs no
-- day-number translation.
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

-- 10b-6. get_kiosk_daily_pattern() — one row per calendar day (Kolkata) in
-- the period, dense zero-filled. The admin panel finds the busiest/
-- quietest day in the selected period by taking the max/min of what this
-- returns client-side, rather than that being computed in SQL, since
-- "best" vs "quietest" needs tie-breaking and date-formatting the client
-- already does for every other period view (see
-- lib/admin/period-stats.ts's formatBucketLabel).
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

-- 10b-7. get_kiosk_sales_summary() — single-row summary for the period:
-- color/B&W split, averages, and the two reliability rates. failure_rate is
-- an operational metric (how often a print attempt of ANY kind — paying,
-- free, or reprint — fails), so its denominator is every completed OR
-- failed attempt. refund_rate's denominator is paid attempts only (paying
-- completed + failed) — a free or reprint job never has anything to refund
-- (see print_orders.is_free/is_reprint's own reasoning above). Both rates
-- are counts, not money, so visible to staff same as everything else in
-- this function except avg_order_value, which is masked to null for staff
-- the same way every other money field in this file already is.
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

-- 10c. refill_events — append-ish history of "paper refilled" / "toner
-- replaced" actions, the baseline every supply estimate is computed
-- against. quantity's meaning differs by kind, by design: for 'paper', how
-- many sheets are in the tray AS OF this event (counts DOWN from here as
-- jobs print); for 'toner', how many pages this cartridge had ALREADY
-- printed as of this event (counts UP from here toward cartridge_max_pages
-- as the configurable yield). Both are "the starting count," just counted
-- in opposite directions.
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
-- Read: any signed-in owner/staff — the history list (who/when/quantity) is
-- useful to both roles, same as the kiosk card itself; nothing in this
-- table is money or PII (by_user_id is a bare uuid, resolved to an email
-- client-side via the existing /api/admin/staff-users route).
create policy "Signed-in admins read refill_events" on refill_events
for select using (public.current_app_role() in ('owner', 'staff'));

grant select on public.refill_events to authenticated;

-- No insert/update/delete policy or grant at all — the only way a row is
-- ever written is record_refill() below, SECURITY DEFINER, so this is
-- genuinely append-only, same discipline as audit_log.

-- 10d. record_refill() — the one write path for both buttons. Both owner
-- and staff can record a refill — there's no money/revenue-control angle
-- to a refill the way there is to pricing or WhatsApp spend, so the
-- broader of the two existing patterns (update_kiosk_counters' "owner or
-- staff") applies here too. Logs an audit entry in the same transaction as
-- the insert itself.
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

-- 10e. get_kiosk_supply_status() — the raw numbers the "Paper left"/"Toner
-- left" cards are built from. Deliberately returns RAW inputs (not a
-- finished percentage) — lib/admin/supply-estimate.ts's pure
-- computeSupplyEstimate() does the remaining/percentage/clamping math from
-- these, so that logic has a real unit test that doesn't need a database
-- at all; this function's own job is just "sum what's been consumed since
-- the last baseline," which does need one. Reads print_orders, not
-- print_jobs (fixed 2026-10-22) — print_jobs is cleaned up a few hours
-- after a job prints, so a baseline older than that would undercount.
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
      select coalesce(sum(po.pages_printed), 0)::integer
      from print_orders po
      where po.kiosk_id = p_kiosk_id and po.created_at >= v_paper.at
    ) end,
    v_paper.at,
    v_paper.by_user_id,
    v_toner.id is not null,
    v_toner.quantity,
    case when v_toner.id is not null then (
      select coalesce(sum(po.pages_printed), 0)::integer
      from print_orders po
      where po.kiosk_id = p_kiosk_id and po.created_at >= v_toner.at
    ) end,
    v_toner.at,
    v_toner.by_user_id;
end;
$$;

grant execute on function public.get_kiosk_supply_status(text) to authenticated;

-- 10f. Low-supply / offline alerts (lib/alerts/) — Telegram + email + a
-- banner, never WhatsApp. kiosk_alert_settings holds the per-kiosk
-- Telegram chat id (owner-only); alerts is the dedupe/reminder/recovery
-- ledger, one active row per (kiosk_id, kind) enforced by the partial
-- unique index below.
create table kiosk_alert_settings (
  kiosk_id text primary key references kiosk_status(id),
  telegram_chat_id text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table kiosk_alert_settings enable row level security;
create policy "Owner reads kiosk_alert_settings" on kiosk_alert_settings
for select using (public.current_app_role() = 'owner');

create or replace function public.update_kiosk_alert_settings(p_kiosk_id text, p_telegram_chat_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Not authorized.';
  end if;

  insert into kiosk_alert_settings (kiosk_id, telegram_chat_id, updated_by)
  values (p_kiosk_id, p_telegram_chat_id, auth.uid())
  on conflict (kiosk_id) do update set telegram_chat_id = excluded.telegram_chat_id, updated_at = now(), updated_by = excluded.updated_by;

  perform public.log_audit(
    p_action := 'alert_settings_updated',
    p_actor_user_id := auth.uid(),
    p_actor_role := public.current_app_role(),
    p_kiosk_id := p_kiosk_id,
    p_target_type := 'kiosk',
    p_target_id := p_kiosk_id,
    p_details := jsonb_build_object('telegram_chat_id_set', p_telegram_chat_id is not null)
  );
end;
$$;

grant execute on function public.update_kiosk_alert_settings(text, text) to authenticated;

create table alerts (
  id uuid primary key default gen_random_uuid(),
  kiosk_id text not null,
  kind text not null check (kind in ('paper_low', 'toner_low', 'kiosk_offline')),
  status text not null default 'active' check (status in ('active', 'resolved')),
  created_at timestamptz not null default now(),
  last_reminded_at timestamptz,
  resolved_at timestamptz
);

create unique index alerts_active_kiosk_kind_idx on alerts (kiosk_id, kind) where status = 'active';
create index alerts_kiosk_status_idx on alerts (kiosk_id, status);

alter table alerts enable row level security;
create policy "Signed-in admins read alerts" on alerts
for select using (public.current_app_role() in ('owner', 'staff'));

create or replace function public.get_active_alerts(p_kiosk_id text default null)
returns setof alerts
language sql
stable
security definer
set search_path = public
as $$
  select * from alerts
  where status = 'active' and (p_kiosk_id is null or kiosk_id = p_kiosk_id)
  order by created_at desc;
$$;

grant execute on function public.get_active_alerts(text) to authenticated;

-- ============================================================================
-- Not part of this file: the Storage bucket.
-- ============================================================================
-- Create it via Dashboard → Storage → New bucket:
--   name: print-jobs   (must match SUPABASE_PRINT_BUCKET in .env.local)
--   Public bucket: OFF (private — only the service-role key reads/writes it)
-- No bucket policies are needed for the same reason no print_jobs policies
-- are needed above: only the service-role key ever touches it.
