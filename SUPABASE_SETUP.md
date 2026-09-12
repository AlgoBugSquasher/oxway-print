# Supabase setup

Supabase is the shared coordination layer between the website (wherever it's
hosted) and the Pi's print agent — they never talk to each other directly.

## 1. Create a project

If you don't already have one: [supabase.com](https://supabase.com) → New
Project. Grab three values from **Project Settings → API**:

- `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
- `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (safe to expose to the browser; used by the admin dashboard's read-only views)
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**secret** — bypasses Row Level Security; only ever used server-side: the website's API routes and the Pi's print agent, never the browser)

## 2. Create the `print_jobs` table

SQL editor → run:

```sql
create table print_jobs (
  id uuid primary key,
  status text not null default 'pending_payment',
  file_name text not null,
  selected_pages jsonb not null,
  settings jsonb not null,
  total_price numeric not null,
  provider text not null,
  provider_order_id text not null default '',
  provider_meta jsonb,
  pdf_storage_path text not null,
  cups_job_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index print_jobs_provider_order_id_idx on print_jobs (provider_order_id);
create index print_jobs_status_idx on print_jobs (status);

-- The website and print agent both use the service_role key, which bypasses
-- RLS entirely, so no policies are strictly required. If you'd rather turn
-- RLS on for defense in depth, that's fine — service_role ignores it anyway.
alter table print_jobs enable row level security;
```

## 3. Create the Storage bucket

Storage → New bucket → name it `print-jobs` (or set `SUPABASE_PRINT_BUCKET`
to whatever you name it) → **private** (not public — the print agent
downloads via the service role key, no need for public URLs).

## 4. Existing dashboard tables

Your collaborator's `/admin` dashboard already expects two tables —
`print_orders` (a log of completed prints) and `kiosk_status` (the running
tray/cartridge/revenue counters, one row per physical kiosk). If those don't
exist yet:

```sql
create table print_orders (
  id uuid primary key default gen_random_uuid(),
  pages_printed integer not null,
  amount numeric not null,
  color_mode boolean not null,
  status text not null default 'completed',
  created_at timestamptz not null default now()
);

create table kiosk_status (
  id text primary key,
  tray_pages integer not null default 0,
  cartridge_pages integer not null default 0,
  total_revenue numeric not null default 0,
  total_lifetime_prints integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into kiosk_status (id) values ('oxway_01');
```

(`oxway_01` is the id `lib/kiosk-stats.ts` and `app/admin/page.tsx` both look
for — if you rename it, update both.)

## 5. Env vars

Both the website and the Pi's print agent need the same three values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```
