-- Rollback: recreate the old overload —
--   create or replace function public.create_staff_print_job(
--     p_job_id uuid, p_file_name text, p_selected_pages jsonb, p_settings jsonb,
--     p_waived_amount numeric, p_content_hash text, p_provider text,
--     p_pdf_storage_path text, p_kiosk_id text, p_idempotency_key text,
--     p_created_by uuid, p_daily_cap integer
--   ) ...  (see git history for the body, e.g. 2026-10-14_staff_print.sql)

-- Bug: Admin Print page failed with "Could not choose the best candidate
-- function between public.create_staff_print_job(...) and
-- public.create_staff_print_job(..., p_force_cover_sheet boolean)".
--
-- Cause: 2026-10-19_cover_sheet_and_tray.sql added a p_force_cover_sheet
-- parameter with `create or replace function`, but Postgres only replaces a
-- function with the EXACT same argument list — a different parameter list
-- creates a second, separate overload instead of replacing the first. So
-- both the old 12-argument version and the new 13-argument version existed
-- at once, and Postgres can't tell which one a call meant (a default value
-- doesn't help it decide). The real website code (lib/store.ts) only ever
-- calls the 13-argument version, so the old one is just dead weight — drop
-- it by its exact old signature, leaving the one real overload in place.
drop function if exists public.create_staff_print_job(
  uuid, text, jsonb, jsonb, numeric, text, text, text, text, text, uuid, integer
);
