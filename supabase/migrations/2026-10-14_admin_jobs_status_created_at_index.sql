-- Admin-pages performance pass — see the rest of that work for the
-- dominant fix (removing redundant auth round trips); this is the one real
-- missing-index gap found while auditing: the Jobs page
-- (app/admin/(dashboard)/jobs/page.tsx) filters print_jobs_admin_view by
-- status and orders by created_at desc when a status filter is applied,
-- but only single-column indexes existed on each (status) and
-- (created_at) separately — a composite covers that exact shape directly
-- instead of Postgres bitmap-AND-ing two separate indexes.
--
-- (Audited, but NOT adding here: a (kiosk_id, created_at) index — no admin
-- query actually filters print_jobs by kiosk_id; every admin view spans
-- all kiosks. That shape would help the customer-facing kiosk-display
-- route and listJobsAheadInQueue instead, which is outside this task's
-- "admin login/pages" scope.)
--
-- Additive-only: a new index, nothing dropped or altered. Safe to run
-- against a live project with existing rows.
-- Rollback: drop index if exists print_jobs_status_created_at_idx;
create index if not exists print_jobs_status_created_at_idx
  on print_jobs (status, created_at desc);
