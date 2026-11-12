-- Rollback: recreate the old overloads —
--   create or replace function public.create_reprint_job(
--     p_job_id uuid, p_original_job_id uuid, p_selected_pages jsonb, p_settings jsonb,
--     p_include_banner_page boolean, p_content_hash text, p_pdf_storage_path text,
--     p_reprint_note text, p_created_by uuid
--   ) ...  (see git history, e.g. 2026-10-18_restart_and_reprint.sql)
--   create or replace function public.update_kiosk_counters(
--     p_kiosk_id text, p_tray_pages integer, p_cartridge_pages integer,
--     p_tray_max_pages integer, p_cartridge_max_pages integer,
--     p_allow_color boolean, p_allow_bw boolean
--   ) ...  (see git history, e.g. 2026-10-09_color_bw_banner_notify.sql)

-- Same duplicate-overload mistake as create_staff_print_job (see
-- 2026-10-29_drop_duplicate_create_staff_print_job.sql): a later migration
-- added one new parameter with `create or replace function` instead of
-- dropping and recreating, which left the OLD, shorter signature as a
-- second live overload next to the new one. The website (lib/store.ts,
-- lib/admin/actions.ts) only ever calls the newer, longer signature, so the
-- old one is dead weight — drop each by its exact old signature.

-- create_reprint_job: 9-arg original (2026-10-18_restart_and_reprint.sql)
-- vs. 10-arg with p_force_cover_sheet added (2026-10-19_cover_sheet_and_tray.sql).
drop function if exists public.create_reprint_job(
  uuid, uuid, jsonb, jsonb, boolean, text, text, text, uuid
);

-- update_kiosk_counters: 7-arg original (2026-10-09_color_bw_banner_notify.sql)
-- vs. 8-arg with p_low_supply_threshold_percent added (2026-10-22_low_supply_alerts.sql).
drop function if exists public.update_kiosk_counters(
  text, integer, integer, integer, integer, boolean, boolean
);
