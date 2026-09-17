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

  -- disabled feature (§1 phone number) — column exists, checkout form's
  -- input is commented out, so every row gets this default.
  phone_number text not null default '',

  -- disabled feature (§5 banner page) — column exists, checkbox + print
  -- agent's banner-prepend step are commented out.
  include_banner_page boolean not null default false,

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
  updated_at timestamptz not null default now()
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

create or replace function public.update_kiosk_counters(
  p_kiosk_id text,
  p_tray_pages integer default null,
  p_cartridge_pages integer default null,
  p_tray_max_pages integer default null,
  p_cartridge_max_pages integer default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;
  update kiosk_status set
    tray_pages = coalesce(p_tray_pages, tray_pages),
    cartridge_pages = coalesce(p_cartridge_pages, cartridge_pages),
    tray_max_pages = coalesce(p_tray_max_pages, tray_max_pages),
    cartridge_max_pages = coalesce(p_cartridge_max_pages, cartridge_max_pages),
    updated_at = now()
  where id = p_kiosk_id;
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

grant execute on function public.mark_job_refunded(uuid) to authenticated;
grant execute on function public.force_reprint_job(uuid) to authenticated;
grant execute on function public.cancel_job(uuid) to authenticated;
grant execute on function public.update_kiosk_counters(text, integer, integer, integer, integer) to authenticated;
grant execute on function public.update_pricing(numeric, numeric) to authenticated;

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
  created_at, updated_at, error, cups_job_id, refunded_at
from public.print_jobs;

create view public.kiosk_status_admin_view as
select
  id, tray_pages, cartridge_pages, tray_max_pages, cartridge_max_pages,
  case when public.current_app_role() = 'owner' then total_revenue else null end as total_revenue,
  total_lifetime_prints, updated_at
from public.kiosk_status;

grant select on public.print_jobs_admin_view to authenticated;
grant select on public.kiosk_status_admin_view to authenticated;

-- ============================================================================
-- Not part of this file: the Storage bucket.
-- ============================================================================
-- Create it via Dashboard → Storage → New bucket:
--   name: print-jobs   (must match SUPABASE_PRINT_BUCKET in .env.local)
--   Public bucket: OFF (private — only the service-role key reads/writes it)
-- No bucket policies are needed for the same reason no print_jobs policies
-- are needed above: only the service-role key ever touches it.
