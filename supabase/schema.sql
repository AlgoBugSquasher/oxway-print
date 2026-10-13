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

  -- set by the owner-only "mark refunded" admin action.
  refunded_at timestamptz,

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

  -- reserved, unused this build — see ROADMAP.md §24/§25. The real
  -- pickup-confirmation trigger (customer self-confirm? flap sensor? a
  -- timeout?) isn't decided yet, so no code sets this column. It exists now
  -- purely so that wiring it up later never requires a migration.
  collected_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index print_jobs_provider_order_id_idx on print_jobs (provider_order_id);
create index print_jobs_status_idx on print_jobs (status);
create index print_jobs_updated_at_idx on print_jobs (updated_at);
create index print_jobs_created_at_idx on print_jobs (created_at);
create index print_jobs_content_hash_idx on print_jobs (content_hash);
create index print_jobs_kiosk_id_idx on print_jobs (kiosk_id);

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
  created_at timestamptz not null default now()
);

alter table print_orders enable row level security;
-- Policy created in §9 below, after current_app_role() exists — a CREATE
-- POLICY's USING clause is resolved immediately, unlike a view or function
-- body, so the function it calls must already exist at this point.

-- ============================================================================
-- 3. kiosk_status — one row per physical kiosk
-- ============================================================================

create table kiosk_status (
  id text primary key,
  tray_pages integer not null default 0,
  cartridge_pages integer not null default 0,
  tray_max_pages integer not null default 150,       -- Samsung ML-1866W tray max
  cartridge_max_pages integer not null default 1500,  -- standard MLT-D104S yield
  total_revenue numeric not null default 0,
  total_lifetime_prints integer not null default 0,
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
  agent_updated_at timestamptz
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
-- a kiosk's current day, resetting automatically once current_date rolls
-- over (a new (kiosk_id, ticket_date) row just starts back at 1). Returns
-- the date it actually used alongside the number, rather than making the
-- caller independently compute "today" — if the app server's clock and the
-- database's clock ever drifted even slightly around midnight, an
-- app-computed date could mismatch the row this function actually
-- incremented. Returning both from the same source eliminates that class
-- of bug entirely rather than relying on clocks staying in sync.
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
  v_ticket_date date := current_date;
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
  -- refunded_at is null guards against a real money bug (ROADMAP.md #10):
  -- print-agent auto-refunds the instant a job hits print_failed, so
  -- without this check, reprinting an already-refunded job would give the
  -- customer both their money back and a free print.
  update print_jobs set status = 'paid', updated_at = now()
  where id = p_job_id and status in ('print_failed', 'printed') and refunded_at is null;
end;
$$;

create or replace function public.cancel_job(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  update print_jobs set status = 'cancelled', updated_at = now()
  where id = p_job_id and status in ('pending_payment', 'paid', 'printing');
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
  p_allow_bw boolean default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_resulting_allow_color boolean;
  v_resulting_allow_bw boolean;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

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
    updated_at = now()
  where id = p_kiosk_id;
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
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can change WhatsApp availability.';
  end if;
  update kiosk_status set allow_whatsapp = p_allow_whatsapp, updated_at = now() where id = p_kiosk_id;
end;
$$;

create or replace function public.update_pricing(p_price_bw numeric, p_price_color numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() <> 'owner' then
    raise exception 'Only an owner can edit pricing.';
  end if;
  if p_price_bw <= 0 or p_price_color <= 0 then
    raise exception 'Prices must be positive.';
  end if;
  update pricing_config set
    price_bw = p_price_bw, price_color = p_price_color,
    updated_at = now(), updated_by = auth.uid()
  where id = 'default';
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
end;
$$;

grant execute on function public.mark_job_refunded(uuid) to authenticated;
grant execute on function public.force_reprint_job(uuid) to authenticated;
grant execute on function public.cancel_job(uuid) to authenticated;
grant execute on function public.update_kiosk_counters(text, integer, integer, integer, integer, boolean, boolean) to authenticated;
grant execute on function public.update_pricing(numeric, numeric) to authenticated;
grant execute on function public.request_kiosk_command(text, text) to authenticated;
grant execute on function public.update_kiosk_whatsapp_availability(text, boolean) to authenticated;

-- ============================================================================
-- 8. Policies that depend on current_app_role() existing (§7 above)
-- ============================================================================

create policy "Owner reads print_orders" on print_orders
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

create view public.print_jobs_admin_view as
select
  id, status, file_name, selected_pages, settings,
  case when public.current_app_role() = 'owner' then total_price else null end as total_price,
  phone_number, include_banner_page, provider, provider_order_id, pdf_storage_path,
  kiosk_id, ticket_number, ticket_date, collected_at,
  created_at, updated_at, error, cups_job_id, refunded_at,
  notify_opt_in, notified_at
from public.print_jobs;

create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at, allow_color, allow_bw,
  agent_commit, agent_updated_at, allow_whatsapp
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
grant select (id, status, error, ticket_number, updated_at, refunded_at) on public.print_jobs to anon;

create policy "Anyone holding a job id can read its own status" on public.print_jobs
for select using (true);

-- ============================================================================
-- Not part of this file: the Storage bucket.
-- ============================================================================
-- Create it via Dashboard → Storage → New bucket:
--   name: print-jobs   (must match SUPABASE_PRINT_BUCKET in .env.local)
--   Public bucket: OFF (private — only the service-role key reads/writes it)
-- No bucket policies are needed for the same reason no print_jobs policies
-- are needed above: only the service-role key ever touches it.
