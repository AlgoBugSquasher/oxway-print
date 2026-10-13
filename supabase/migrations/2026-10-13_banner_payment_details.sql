-- OXWAY v2.5 — additive migration: payment details for the printed banner
--

alter table print_jobs add column if not exists payment_id text;
alter table print_jobs add column if not exists upi_txn_id text;
alter table print_jobs add column if not exists paid_amount numeric;
