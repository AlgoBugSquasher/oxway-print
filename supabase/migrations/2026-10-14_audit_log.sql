-- Append-only audit log — requirement #1-4 of the audit-log task.
--
-- Run this ONCE, in the Supabase SQL editor, against the EXISTING project.
-- Additive only: one new table, one new SECURITY DEFINER function
-- (log_audit), one new function (record_refund), and a `create or replace`
-- of six EXISTING functions' bodies only — none of their signatures change,
-- so every existing call site (lib/admin/actions.ts, app/api/staff-print,
-- print-agent) keeps working unmodified. Safe to run against a live
-- project with existing rows.
--
-- Rollback: `drop table audit_log cascade;` removes the table, the
-- log_audit()/record_refund() functions, and the policy together ("cascade"
-- is needed because log_audit's body references the table). The six
-- `create or replace`d functions would need restoring to their prior
-- bodies from supabase/schema.sql's git history — this migration doesn't
-- touch their signatures, so nothing else needs to change to roll back.

-- ============================================================================
-- 1. audit_log table
-- ============================================================================
--
-- bigint identity (not uuid) for `id`: this is a high-volume, strictly
-- append-only log where insertion order itself is meaningful (the viewer's
-- own "newest first" pagination needs an unambiguous tiebreaker for two
-- events landing in the same millisecond) — a monotonic integer gives that
-- for free; a uuid wouldn't.
--
-- actor_user_id is nullable: a system-initiated event (the print agent's
-- own automatic refund-on-failure, an offline alert) has no human actor.
-- kiosk_id is nullable: some actions aren't kiosk-scoped (pricing changes,
-- sign-in/out). target_type/target_id are free-form text (not a foreign
-- key) since the target varies by action (a print_jobs uuid, a kiosk_id
-- string, the fixed "default" pricing_config row, ...) — text is the only
-- type flexible enough to hold all of those without a union of nullable
-- typed columns.
--
-- Per the task's own privacy rule: never store secrets, a full phone
-- number, or payment details beyond ids — see lib/audit.ts's maskPhone()
-- and every call site below, which only ever puts payment/refund IDs (not
-- card/bank details, which this app never has access to anyway) into
-- `details`.
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

-- Read: owner only (requirement #3's viewer, and requirement #5's "staff
-- and anonymous can't read it"). Staff gets no policy at all — RLS with
-- zero matching policies defaults to deny, same discipline as every other
-- table in this schema.
create policy "Owner reads audit_log" on audit_log
for select using (public.current_app_role() = 'owner');

grant select on public.audit_log to authenticated;

-- Deliberately NO insert/update/delete policy for ANY role, owner
-- included, and NO grant to authenticated/anon at all for those
-- operations — the only way any row is ever written is log_audit() below,
-- a SECURITY DEFINER function that bypasses RLS as its owner. There is no
-- UPDATE or DELETE path anywhere, by any role, through PostgREST or
-- log_audit() — this table is genuinely append-only, not just
-- append-only-by-convention.

-- ============================================================================
-- 2. log_audit() — the one write path, called from every other RPC's own
--    body (free, no grant needed — see below) and from Node server code
--    via the service_role grant (see lib/audit.ts)
-- ============================================================================
--
-- SECURITY DEFINER + the function owner's own implicit execute rights is
-- what lets every other SECURITY DEFINER RPC below (update_pricing,
-- cancel_job, ...) call this directly from its own PL/pgSQL body with NO
-- separate grant needed — a SECURITY DEFINER function runs as its OWNER,
-- and an owner can always call its own other functions regardless of what
-- `authenticated`/`anon` are granted on them. The explicit grant at the
-- bottom is only for server_role (lib/audit.ts's Node-side callers:
-- app/api/admin/login, sign-out, refund, kiosk-update's result path, and
-- any future feature's server code) — `authenticated` and `anon` are
-- granted NOTHING on this function, so a signed-in browser client can
-- never call it directly and inject a fabricated entry.
--
-- Swallows its own failure (requirement #4: "a failed audit write must not
-- crash the action it's auditing") as a last-resort backstop for an RPC
-- that calls this inline, mid-transaction — a raised exception here would
-- otherwise roll back the ENTIRE calling transaction (e.g. a real pricing
-- change) just because the audit insert itself failed. `raise warning`
-- (not `raise notice`) so it's loud in Postgres's own logs — requirement
-- #4's "must be logged loudly server-side." lib/audit.ts's Node-side
-- logAudit() has the equivalent try/catch + console.error for callers
-- using the service_role grant directly.
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

-- ============================================================================
-- 3. record_refund() — refund state change + its audit entry, one transaction
-- ============================================================================
--
-- Requirement #4: "for refunds, write the audit entry in the same
-- transaction if possible." The gateway HTTP call itself (Razorpay/
-- Cashfree, in lib/refund.ts) can never be part of a Postgres transaction —
-- that's a hard physical limit, not a design shortcoming — but everything
-- on the DATABASE side of a refund (marking refunded_at, and recording it)
-- now genuinely is one transaction: lib/refund.ts calls this ONE RPC
-- instead of a plain updateJob(), right after the gateway confirms the
-- refund succeeded.
--
-- `refunded_at is null` in the WHERE guard is still the real idempotency
-- check (same as before this migration) — a second call for an
-- already-refunded job updates zero rows, and this still logs an audit
-- entry either way (worth recording "a refund was attempted/re-confirmed
-- for this job," even on the no-op branch) with before/after reflecting
-- whether this call actually changed anything.
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
-- 4. Hooking log_audit() into the existing write RPCs — bodies only, same
--    signatures as before, so every existing call site is untouched.
-- ============================================================================

-- update_pricing — before/after for the two price columns.
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

-- update_kiosk_counters — before/after for every field this RPC can touch
-- (paper/toner counters as well as the color/B&W toggle this task's own
-- hook list calls out) — one "Save" click on the kiosk card is one user
-- action, so one audit entry with a full before/after snapshot is more
-- useful here than splitting it by field. Same 7-argument signature as
-- before this migration (only the body changes), so no drop needed this
-- time — compare the ORIGINAL migration that introduced allow_color/
-- allow_bw, which DID need one, for why that's different.
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
  v_old kiosk_status;
begin
  if public.current_app_role() not in ('owner', 'staff') then
    raise exception 'Not authorized.';
  end if;

  select * into v_old from kiosk_status where id = p_kiosk_id;

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
        'allow_color', v_old.allow_color, 'allow_bw', v_old.allow_bw
      ),
      'after', jsonb_build_object(
        'tray_pages', coalesce(p_tray_pages, v_old.tray_pages), 'cartridge_pages', coalesce(p_cartridge_pages, v_old.cartridge_pages),
        'tray_max_pages', coalesce(p_tray_max_pages, v_old.tray_max_pages), 'cartridge_max_pages', coalesce(p_cartridge_max_pages, v_old.cartridge_max_pages),
        'allow_color', v_resulting_allow_color, 'allow_bw', v_resulting_allow_bw
      )
    )
  );
end;
$$;

-- update_kiosk_whatsapp_availability — before/after for the one toggle.
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

-- cancel_job — only logs when the UPDATE actually matched a row (a no-op
-- call — wrong status, unknown id — changed nothing, so nothing happened
-- to audit).
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
  where id = p_job_id and status in ('pending_payment', 'paid', 'printing');
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

-- request_kiosk_command — "Update kiosk"/"Restart agent" requested. The
-- RESULT half of this (requirement #2's "with result") is logged
-- separately from Node — see lib/kiosk-commands.ts's finishKioskCommand,
-- called by the print agent once the command actually finishes.
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

-- create_staff_print_job — logged only on the branch that actually creates
-- a new job (the idempotent-replay branch above it returns early with an
-- EXISTING job — nothing new happened, so nothing new to audit).
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
