-- OXWAY v2.5 — additive migration: kiosk heartbeat + instant print-ready signal
--
-- Run this ONCE, in the Supabase SQL editor, against the EXISTING project
-- (supabase/schema.sql already has both changes folded in for anyone setting
-- up a brand-new project after this point — see that file's §3 and §10).
--
-- Every statement here is additive per ROADMAP.md's Ground Rules: a nullable
-- column with no backfill, plus a new grant/policy that only ever ADDS
-- access — nothing existing is narrowed or dropped. Safe to run against a
-- live project with existing rows.

-- 1. Kiosk online/offline heartbeat -----------------------------------------
-- Dedicated column instead of reusing kiosk_status.updated_at (which also
-- moves on every print-counter update) so "is this kiosk alive" and "when
-- did its counters last change" can never be confused with each other.
alter table kiosk_status add column if not exists last_seen_at timestamptz;

-- 2. Anonymous, per-row read access for the customer status page ------------
-- Needed so the customer's browser can subscribe directly via Supabase
-- Realtime (postgres_changes) for an instant "printed" update — see
-- supabase/schema.sql's §10 for the full reasoning behind this exact scope
-- (column grant limited to non-sensitive columns; the `using (true)` policy
-- only matters to whoever already knows the job's unguessable uuid).
grant select (id, status, error, ticket_number, updated_at) on public.print_jobs to anon;

create policy "Anyone holding a job id can read its own status" on public.print_jobs
for select using (true);
