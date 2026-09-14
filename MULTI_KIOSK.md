# Adding a second (or third...) kiosk

The system is built to support multiple physical kiosks from day one, even
though only one exists right now. Every job is tagged with a `kiosk_id`, and
everything defaults to `"oxway_01"` — today's single kiosk — so nothing
about your current setup needs to change until you actually add a second
machine.

## 1. Run this once, in Supabase's SQL Editor

```sql
alter table print_jobs add column if not exists kiosk_id text not null default 'oxway_01';
create index if not exists print_jobs_kiosk_id_idx on print_jobs (kiosk_id);
```

Safe to run even with existing rows/jobs already in the table — they all get
`kiosk_id = 'oxway_01'` automatically, matching your current single kiosk.

## 2. When you add kiosk #2 (or #3, #4...)

Pick a short id for it — `oxway_02`, `oxway_03`, etc.

**On that kiosk's Pi**, in `.env.local`, add:
```env
KIOSK_ID=oxway_02
```
Its print agent will now only ever pick up jobs tagged for `oxway_02` —
never jobs meant for a different kiosk, even though every Pi is reading from
the same shared Supabase project.

**Generate that kiosk's QR code** pointing at:
```
https://your-site.com/?k=oxway_02
```
(the `?k=` query param — not a different domain/page, the same website).
When a customer scans it, the site tags their order with that kiosk id
automatically, so it only ever gets printed at kiosk #2's printer.

**Point that kiosk's on-screen display** (the `chromium --kiosk` autostart
command, see SETUP_PI.md) at:
```
https://your-site.com/kiosk-display?k=oxway_02
```
so it only shows that kiosk's own job status, not every kiosk's activity
mixed together.

**Optional**: give it its own `kiosk_status` row too (for separate
paper-tray/cartridge/revenue tracking per machine, instead of one shared
total across all kiosks):
```sql
insert into kiosk_status (id) values ('oxway_02');
```
This is only worth doing once you actually want per-kiosk admin stats —
until then, all kiosks quietly share the one `oxway_01` counters row, which
is harmless but not very meaningful once there's more than one machine.

## That's the whole migration

No code changes needed for any of this — it's all configuration (one env
var per Pi, one query param per QR code/display URL). The code was written
once to support it from the start.
