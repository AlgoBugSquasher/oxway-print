-- Rollback:
--   drop policy if exists "Owner reads error_logs" on error_logs;
--   drop function if exists public.can_read_error_logs();
--   drop table if exists error_logs;

-- error_logs — every error a customer, kiosk, or admin page would otherwise
-- have seen raw (Postgres text, a stack trace, a function signature) gets
-- logged here instead, with a short reference code shown to the person
-- instead of the real message. Written ONLY by the server (lib/errors.ts's
-- logError, service-role key) — never by browser code directly, same
-- append-only discipline as audit_log (see supabase/schema.sql §11).
--
-- Never store secrets, phone numbers, or payment details in `message`/
-- `details` — see lib/errors.ts's own comment at every call site.
create table error_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  reference_code text not null,
  area text not null check (area in ('upload', 'payment', 'print', 'admin', 'cron', 'kiosk')),
  message text not null,
  details jsonb,
  user_agent text
);

create index error_logs_created_at_idx on error_logs (created_at desc, id desc);
create index error_logs_reference_code_idx on error_logs (reference_code);
create index error_logs_area_idx on error_logs (area);

alter table error_logs enable row level security;

-- A dedicated function (not the bare `current_app_role() = 'owner'` check
-- every other owner-only policy inlines) so that adding a future
-- "engineer" role that should also read this table is a ONE-LINE change
-- here, not a rewrite of the policy below or of every server-side route
-- that reads this table — e.g. later: `current_app_role() in ('owner', 'engineer')`.
create or replace function public.can_read_error_logs()
returns boolean
language sql
stable
as $$
  select public.current_app_role() = 'owner';
$$;

create policy "Owner reads error_logs" on error_logs
for select using (public.can_read_error_logs());

grant select on public.error_logs to authenticated;

-- Deliberately no insert/update/delete policy or grant for any role — the
-- only way a row is ever written is logError() in lib/errors.ts, which
-- uses the service-role key and so bypasses RLS entirely, same as
-- audit_log's log_audit().
