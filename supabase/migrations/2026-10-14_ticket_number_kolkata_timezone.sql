-- Pickup-code hardening pass — the generation itself (kiosk_ticket_counters
-- + next_ticket_number()'s atomic INSERT...ON CONFLICT...RETURNING) was
-- already correct: per-kiosk, atomic, collision-proof (also backed by the
-- print_jobs_kiosk_ticket_idx unique index), with ticket_number fully
-- decoupled from print_jobs.id (the real internal uuid). The one real gap:
-- the daily reset used Postgres's bare `current_date`, which depends on
-- the DATABASE SESSION's configured timezone — Supabase projects default
-- to UTC, so the counter would actually reset at 05:30 IST, not midnight
-- IST. This makes the reset self-contained and correct regardless of that
-- setting, per this project's "times and days use Asia/Kolkata" rule.
--
-- Purely a function body change (same signature, same table) — safe to
-- run against a live project with existing rows.
-- Rollback: `v_ticket_date date := current_date;` in place of the
-- AT TIME ZONE expression below restores the previous (UTC-reset) behavior.
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
