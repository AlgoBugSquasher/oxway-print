# OXWAY — Project Brief & Feature Roadmap (v2.5 — Interim Prototype Build)

**Read this whole document before writing any code.** This file is meant
to be fully self-contained — written so that a fresh Claude Code session,
with zero memory of any prior conversation, can pick up this project and
know exactly what it is, what already exists, and what to build next.

**This is a deliberately simplified interim version**, requested by the
team lead, built on top of an already-completed fuller version (`v2` —
see the reference section below). The full version isn't abandoned —
phone number collection, SMS/WhatsApp notifications, and the physical
banner/pickup-ID page all still exist as real, working code, they're just
**intentionally disabled for this build**, not deleted, because the plan
is to re-enable them later once direction settles. Every instruction in
this document about those three features says "disable" specifically
because "delete" would be the wrong instruction — don't delete them even
if it seems tidier.

---

## What this project is

OXWAY is a self-service print kiosk system for a college campus (a
stationery/print point students use for assignments, TCs, certificates,
lab files, admit cards, etc.). The physical setup:

- A kiosk (currently a Raspberry Pi 5, 8GB, running Pi OS Trixie) sits
  next to a physical printer (Samsung ML-1866W, monochrome laser, USB,
  150-sheet paper tray max, MLT-D104S toner cartridge ~1,500 page yield
  standard / ~700 if still on the box's starter cartridge).
- The kiosk displays a QR code and a live status screen — it does **not**
  run the website itself.
- A customer scans the QR **on their own phone**, which opens the actual
  website (hosted separately, e.g. Vercel — not on the Pi).
- They upload a file, configure print settings, pay (Razorpay live;
  Cashfree pending KYC, both should stay supported), and the Pi
  automatically prints it the moment payment is confirmed — no manual
  intervention, no button on the kiosk itself.
- The website and the Pi never talk to each other directly. **Supabase is
  the entire coordination layer** between them — the website writes job
  records + uploads the PDF to Supabase Storage; a small standalone script
  on the Pi (the "print agent") polls Supabase for paid jobs and prints
  them via CUPS.

## Tech stack — do not introduce a new one

TypeScript, Next.js (App Router), Tailwind CSS, Supabase (Postgres +
Storage + eventually Auth), pdf-lib for PDF manipulation, CUPS for
printing on the Pi. Payment via Razorpay and/or Cashfree SDKs. The
existing visual style (OXWAY branding, the current card/typography
language already in the codebase) should be matched, not redesigned.

## Ground rules

- **Clean code, SOLID principles, recognizable patterns.** The person
  maintaining this is a student who wants to actually understand and
  extend the code themselves — optimize for readability and clear
  separation of concerns over cleverness. Explain *why* something's
  structured a certain way in comments where it's not obvious.
- **No AI attribution anywhere** — no mention of Claude/AI authorship in
  commit messages, code comments, or docs. The person applies/commits all
  changes under their own name.
- **This is a college project.** Favor solutions that are genuinely
  understandable and defensible in front of an evaluator over ones that
  are merely clever or maximally "enterprise."
- **Schema is built complete, up front — feature flags live in code, never
  in the database schema.** Every column/table needed for the *full*
  feature set (phone number, notifications, banner page) gets created now,
  with safe defaults, even though the code paths using some of them are
  disabled. This is deliberate: re-enabling a disabled feature later must
  be a pure code change (uncomment, remove a flag check) — it must never
  require a new migration. Building the schema piecemeal, only adding
  columns when a feature is actively enabled, is exactly what to avoid
  here — it recreates the toggle-this-later problem at the database layer
  instead of solving it.

## Where the previous working versions live (reference, not a base to build from)

**This is a genuinely separate, new repository — not a branch of an old
one.** Three sibling folders on disk now, two of them are reference only:

```
D:\oxway-print       ← the ORIGINAL repo (github.com/AlgoBugSquasher/oxway-print,
                         branch print-auto). Live in production. Historical
                         reference only, lower priority than v2 below — most
                         of what's genuinely useful in it has already been
                         cleaned up and carried into v2.
D:\oxway-print-v2    ← The PRIMARY reference for this build. A full, working
                         rebuild completed in a prior session — real
                         Supabase Auth, RLS-enforced owner/staff roles, a
                         pricing editor, the phone number field,
                         notifications, and the banner page all exist here,
                         genuinely built and tested. Most of what v2.5 needs
                         should port forward from here nearly directly, not
                         from the original repo.
D:\oxway-print-v2.5  ← THIS project. New repo, new git history, where this
                         file lives and where all new work happens.
```

If you're Claude Code reading this and either reference folder isn't
visible in your working directory, ask the person to relaunch with
`claude --add-dir D:\oxway-print --add-dir D:\oxway-print-v2` so all three
folders are readable in the same session.

**What's different in v2.5 vs. v2 — read this before porting anything:**
- Phone number collection, SMS/WhatsApp notifications, and the physical
  banner/pickup-ID page all exist in v2, fully working. **Port the code,
  but disable it** (comment out the active code paths — the input field,
  the send calls, the banner-prepend step) rather than leaving it fully
  active. See the Ground Rules section above on why the database schema
  still needs to support all of it regardless.
- v2.5 replaces the physical banner page with a different pickup
  mechanism entirely: a short ticket code (e.g. `#042`) shown on the
  customer's own phone and on the kiosk screen, plus a pickup-confirmation
  gate before the next job starts printing. This is **new work, not
  something to find in v2** — see the new items at the end of this
  document's feature list.
- Everything else — the payment pipeline, `lib/store.ts`'s atomic claim
  patterns, `lib/print/cups.ts`, the admin panel (auth, RLS, pricing
  editor, tray/cartridge editing), multi-kiosk `kiosk_id` design — ports
  forward from v2 essentially as-is.

**Rebuild rather than port, from the *original* repo specifically** (v2
already fixed these, so this note mostly matters if you're looking at the
original repo instead of v2 for some reason):
- The admin panel — the original repo's hardcoded PIN is not real auth;
  v2's Supabase Auth + RLS version is what to actually reference.
- The payment-handling section of the main upload component — v2's
  version is the clean rewrite; the original grew through a lot of live
  patch-on-patch debugging.

## Suggested clean module structure

Not gospel, but a reasonable starting shape reflecting single-
responsibility separation:

```
app/
  api/                    — thin route handlers, delegate to lib/, no business logic inline
  admin/                  — rebuilt admin panel (see #6)
  kiosk-display/          — QR + live status screen for the Pi's monitor
lib/
  payment/                — gateway abstraction (port from reference)
  print/                  — PDF composition (page extraction, rotation, banner) + CUPS integration
  notify/                 — new: SMS/WhatsApp abstraction, same pattern as payment/
  store/                  — data access layer (jobs, kiosks) — consider splitting
                             the current single store.ts by responsibility
  config.ts
  supabase-admin.ts
print-agent/
  index.ts                — the Pi's standalone polling script
components/                — customer-facing UI
```

## Styling & brand guidelines

- **Logo/brand assets — registered trademark, never modify.** Two
  reference images live at `public/brand/`:
  - `oxway-icon-full.jpeg` — the ox/bull head icon (black silhouette, red
    eye) with "OXWAY / PRIVATE LIMITED" below it in a plain bold sans
    wordmark, plus the ™ mark. **Use the icon from this file.**
  - `oxway-wordmark.jpeg` — a standalone "OXWAY" wordmark in the *correct*
    stylized typography: angular lettering where the horns integrate
    directly into the "W," with the "X" split black/red. **Use this file's
    typography whenever the wordmark text appears** — the plain bold font
    in `oxway-icon-full.jpeg` is not the correct wordmark style, only that
    file's ox-head icon is canonical.
  - In short: **icon from image 1, lettering style from image 2** — they
    were never meant to be combined as shown; treat them as two reference
    assets for two different elements of the same brand mark.
  - No recoloring, no redrawing, no "AI-cleaned-up" version of either.
    If a combined, production-ready lockup (icon + correct wordmark) is
    needed and doesn't already exist as a clean vector, that's worth
    getting properly designed/vectorized (e.g. as an SVG) rather than
    guessed at in code from these two reference photos.
- **Color palette — keep exactly as-is, this is settled, not open for
  refinement.** Confirmed from the actual current codebase:
  - Primary/brand: Tailwind `blue` (500/600) — buttons, links, active states.
  - Neutral: Tailwind `slate` — backgrounds, borders, body text, scales
    across both light and dark mode.
  - Alerts/logo glow: Tailwind `red` (500) — the logo's entrance/glow
    animation specifically uses `rgba(239, 68, 68, ...)`, i.e. `red-500`.
  - Success states: Tailwind `emerald` (500).
  - No custom hex values or a separate design-token file exist yet — it's
    all direct Tailwind utility classes today.
- **Overall page style/layout/spacing is open to refinement** — logo and
  colors are fixed, but component layout, spacing, and visual polish can
  be improved during this rebuild.
- **Build a proper shared component library** (`Button`, `Card`, `Input`,
  `Badge`, etc.) rather than continuing the current pattern of ad-hoc
  Tailwind classes repeated per-component. This matters more now than it
  did originally, since this rebuild adds several new UI surfaces (admin
  login, admin dashboard, notification settings, ETA display) that should
  all draw from one consistent source rather than each reinventing its own
  button/card styling. Use the confirmed palette above as the component
  library's token set.
- **Admin panel needs a real login screen**, not just the dashboard itself
  — see §6 (admin panel rebuild) for the full spec (Supabase Auth,
  replacing the hardcoded PIN).
- **Light and dark mode are equal priority** — both already exist
  (`isDark` toggling throughout the current codebase) and must both keep
  working, not just one treated as primary.

---

## Prerequisites before writing any code

- Node.js installed, `git` installed.
- **A brand new, separate Supabase project for this build** — do not
  reuse v2's project. A previous incident this session involved sharing
  one Supabase project between an actively-developed version and a
  still-live production site, and a schema change broke live production
  as a result. This project gets its own, from a completely empty state
  — ask for the *complete* schema needed (all tables/columns from v2 that
  carry forward, plus the new ones for §21-25) rather than piecing it
  together incrementally.
- `.env.local` configured for the new project — see `D:\oxway-print-v2`'s
  `.env.example` for the full variable list (Supabase URL/keys,
  Razorpay/Cashfree keys, `PAYMENT_PROVIDER`, `PRINTER_NAME`, `KIOSK_ID`).
- A live Razorpay account (test mode credentials strongly preferred for
  development — live keys process real money with no sandbox).

## Everything below this line is the actual feature-by-feature spec

Status legend: 🔲 not started · 🟡 designed, not built · ⏸️ built in v2, intentionally disabled for v2.5 · ✅ built

---

## 1. Phone number collection ⏸️ built in v2, disabled for v2.5

**Status for this build**: fully built and working in v2 — port the code,
but comment out the active field/usage (the `<input>` in the checkout
form, the values passed to `createCashfreeOrder`/`createRazorpayOrder`).
The `phone_number` column still gets created on `print_jobs` with a safe
default (empty string), per the Ground Rules schema-stability principle —
Cashfree's `customer_phone` field reverts to a placeholder value the way
it worked before this feature existed, since Cashfree requires *something*
in that field regardless.

**What it was for** (kept for whoever re-enables this later): collecting
the customer's phone number so there's somewhere to send notifications,
regardless of which payment gateway is active. A single field added to the
checkout form beats reading it from Razorpay's payment object after the
fact, because it works identically across both gateways and fixes
`createCashfreeOrder`'s hardcoded fake number problem for free.

---

## 2. Customer notifications (WhatsApp/SMS) ⏸️ built in v2, disabled for v2.5

**Status for this build**: `lib/notify/` (the interface + provider stub)
ports forward from v2 as-is, but the actual call sites — the trigger from
payment confirmation, the trigger from print completion — get commented
out, not deleted. In v2.5, the customer's own ticket code (see the new
items at the end of this document) replaces what this would have texted
them; no real provider was ever wired up in v2 anyway, so there's little
active behavior to disable beyond the trigger calls themselves.

**What it was for** (kept for whoever re-enables this later): texting the
customer their Request ID + ETA when payment's confirmed, and a "ready for
pickup" message when printing completes, via a pluggable `lib/notify/`
module (MSG91 was the leading provider candidate for India).

---

## 3. ETA calculation ⏸️ built in v2 — port forward as-is

**Status for this build**: built in v2 (the simple version — fixed
per-page estimate + queue depth), port directly.

**What it does**: Tell the customer roughly when their print will be
ready. Track actual print durations over time and calibrate the estimate
from real data eventually, rather than guessing precisely now.

---

## 4. Auto-delete old files ⏸️ built in v2 — port forward as-is

**Status for this build**: fully built and working in v2, no changes
needed for v2.5 — unlike phone/notifications/banner, this feature has
nothing to do with what's being disabled, port it directly.

**What it does**: Uploaded PDFs and their job rows should disappear once
they're no longer needed, so storage doesn't grow forever.

**Design**: Status-aware, not a flat age cutoff. Supabase's native storage
lifecycle feature only expires old *versions* of a file under bucket
versioning — doesn't fit this use case (we don't version files), so this
is its own small scheduled job (Supabase Edge Function on `pg_cron`, or a
Vercel Cron Job hitting a cleanup API route), running on a schedule (e.g.
hourly), applying two different rules:
- **Completed jobs** (`printed`, `print_failed`, `payment_failed`,
  `expired`) — delete the Storage object + row ~6 hours after reaching
  that state. Most jobs finish printing within minutes of payment, so
  there's no reason to hold the file for a full day+ "just in case" — 6h
  is enough buffer for a reprint request or a complaint investigation
  without holding data longer than it's useful.
- **Abandoned jobs** stuck in `pending_payment` (uploaded, never paid) —
  a longer safety-net cutoff, 24h, so genuinely abandoned uploads still
  get cleaned up even though nothing else ever happened to them.

This also directly avoids the race flagged in §11: never delete a file
whose job is still actively `paid`/`printing` — only the two states above
are eligible.

Capacity math for reference (Supabase free tier = 1GB file storage,
confirmed current as of writing): a typical job PDF runs roughly 0.5–2MB.
Even at a genuinely busy day (100–300 jobs), that's only ~100–300MB/day
accumulating — comfortable headroom under this design. Worth noting this
1GB budget is shared across the *entire* Supabase project, not per kiosk —
once running several kiosks, usage adds up faster and Pro tier (~$25/mo,
100GB) may be worth it regardless of whether free-tier limits are the
actual trigger, since it also unlocks daily backups.

---

## 5. Pickup banner page ⏸️ built in v2, disabled for v2.5 — see new items below for the replacement

**Status for this build**: fully built and working in v2 (the opt-in
checkbox, the `pdf-lib` banner composition, the `includeBannerPage`
field). Port the code, but comment out the active path — the checkbox in
the frontend, the banner-prepend step in the print agent. `includeBannerPage`
stays on `print_jobs` with a safe default (`false`), per the schema-
stability rule.

**v2.5 replaces this mechanism entirely with a different one** — see
"Ticket code + kiosk pickup flow" in the new items at the end of this
document. Don't build both active at once; this item exists purely as a
disabled, portable-forward feature for later.

**What it was for, and the sheet-counting dependency it had** (kept for
whoever re-enables this later): a physical cover page with the Request ID
printed on it, opt-in by checkbox (auto-checked ≥10 sheets), which needed
the print agent's sheet-count math to add `+1` when included, or the
paper/toner low-supply counters would silently under-report. **This `+1`
must be removed for v2.5**, not just left dormant — since the banner is
disabled, the sheet count should reflect only the customer's actual
content again. Make sure this reversion actually happens, it's an easy
detail to miss since the surrounding code is otherwise unchanged.

---

## 6. Admin panel rebuild ⏸️ built in v2 — port forward, this is the full spec of what was actually built

**What**: Replace the current PIN-gated dashboard with something real.
**Fully designed and built in v2** — this section reflects the actual
final design, port it directly rather than re-deriving it.

**Auth**:
- Real Supabase Auth, **email + password** (not magic link — chosen
  specifically for speed with routine multi-person daily use; magic link's
  email round-trip is slower in practice for frequent logins).
- **No self-signup, no invite flow** — accounts created manually in
  Supabase's dashboard by the owner. Fine for a handful of known accounts.
- Server-side session gating via `middleware.ts` on every `/admin/*`
  request (using `@supabase/ssr`), not just a client-side redirect —
  actual protection, not a UI-only gate.

**Two roles — owner and staff — enforced at the database level, not just
hidden in the UI:**
- Role lives in Supabase Auth's `app_metadata` (server-side only, embedded
  into the issued JWT, never editable by the signed-in user themselves —
  critically different from `user_metadata`, which the client *can* edit).
- A `current_app_role()` Postgres helper reads it from the JWT for RLS
  policies to check. **Policies always check for the specific allowed role
  (`= 'owner'`), never `!= 'owner'`** — a role-less or misconfigured
  account should default to zero access everywhere, not accidental staff
  access.
- **Column-level restriction** (staff sees the job queue, but not the
  price column) can't be done with RLS alone — RLS is row-level. The
  actual mechanism: a view that nulls sensitive columns with a `CASE`
  based on `current_app_role()`, with direct table `SELECT` **revoked**
  from `authenticated` so a technically-savvy staff member can't just
  query the raw table over the REST API and get the real values back.
  Writes go through `SECURITY DEFINER` RPC functions, not direct table
  updates — each one checks the role itself, server-side, so even a
  hidden-but-technically-reachable UI action still gets refused correctly.
- **Owner-only**: revenue figures, `print_orders` history, mark-refunded,
  per-page pricing (below).
- **Staff-visible/operational**: job queue/search (Request ID, phone,
  date, status — price column just returns null), kiosk health
  (online/offline, paper/toner %, last-seen), force-reprint/cancel,
  tray/cartridge refill amounts **and** max capacity (staff physically
  swaps cartridges, so staff sets the number — worth a code comment
  flagging this as a deliberate tradeoff, since a wrong max capacity
  silently skews the low-supply alert threshold rather than failing
  loudly).

**Job search/history** — by Request ID, phone number, date, status.

**Editable paper/toner tracking — both current amount and max capacity,
not just a "reset to full" button.** Today's "Reset Tray"/"Reset
Cartridge" buttons assume every refill tops all the way back up, which
isn't reality. Replace with type-in fields for actual current amount.
**Max capacity is editable too, not hardcoded** — the code previously
assumed 200 sheets / 1100 prints, but the actual Samsung ML-1865W/1866W
tray holds **150 sheets maximum**, and toner depends on which cartridge is
installed (**~1,500 pages** for a standard MLT-D104S replacement, **~700**
for the box's starter cartridge) — editable capacity means staff sets the
right number whenever a cartridge gets swapped, rather than the code
guessing.

**Per-page pricing, owner-only, with a real security fix bundled in:**
- A `pricing_config` table (single row, owner-only read *and* write via
  RLS — pricing is financial data, staff has no reason to see it even
  read-only).
- **This surfaced a real pre-existing gap, fixed as part of the same
  change**: `/api/create-order` previously trusted the client-submitted
  `totalPrice` with only a `> 0` check — never recalculated it
  server-side. A tampered request could pay less than it should,
  regardless of whether pricing is editable. The fix: the server
  recomputes the true price itself from `pricing_config` and the **real,
  post-extraction page count** (not the client's claimed page count —
  out-of-range pages silently get dropped during extraction, so pricing
  off the client's number could both under- and over-charge), rejecting
  the order on any mismatch. The server-computed value, not the client's
  echo of it, is what actually gets charged and persisted.

Keep the existing visual style (same cards/typography/color language as
the current dashboard) — this is a functional rebuild, not a restyle.

---

## 7. Real multi-kiosk isolation 🔲

**What**: Today, every Pi's print agent authenticates with the same
all-powerful Supabase service-role key, which bypasses Row Level Security
entirely. The `kiosk_id` filtering added earlier works because the code is
well-behaved, not because the system enforces it — a bug or a compromised
Pi could technically touch any kiosk's data.

**Recommended approach**, two options in increasing robustness:
- **(a) Minimum viable**: give each kiosk its own scoped Supabase JWT
  (not the master service-role key), with RLS enforcing
  `kiosk_id = <that kiosk's claim>` at the database level.
- **(b) Recommended once past demo stage**: Pis don't talk to Supabase
  directly at all. Each calls a small authenticated API you own (one API
  key per kiosk), and that server enforces scoping, logs everything, and
  becomes the natural home for centralized notification-sending (see #2)
  and monitoring (see #8) too.

---

## 8. Monitoring & heartbeat 🔲

**What**: Know when a kiosk or printer has a problem *before* a customer
complains.

**Recommended approach**: Each Pi updates a `last_seen_at` timestamp every
few minutes. Admin dashboard (#6) flags any kiosk silent past a threshold.
Alert the owner via the same notification pipe built for #2, not a
separate system.

**Low paper/toner alerts — already half-built, needs finishing.**
`lib/kiosk-stats.ts` already computes this and fires a warning at 90% tray
capacity and 100% cartridge capacity — but both currently only do
`console.warn()`, which nobody sees unless they're actively watching that
Pi's terminal. **Note for v2.5 specifically**: the plan below routes this
alert through #2's notification pipe — but #2 is disabled in this version
(see its own entry). Either re-enable #2 first, or give this its own
simple alert path for now (e.g. logging somewhere staff actually checks)
— don't silently build this assuming #2 is active when it isn't. Two
fixes needed together once a real send path exists:
1. **Actually send the alert** through the notification pipe from #2 (SMS/
   WhatsApp to the owner) instead of a console log that goes nowhere.
2. **Fix the inconsistent threshold** — cartridge only warns at 100%
   (already fully depleted, too late to act), while tray warns at 90%
   (proactive, time to refill before running out). Bring cartridge in line
   with a proactive threshold too, e.g. 90%.
3. **Compute thresholds as a percentage of the (now editable, per §6)
   max capacity, not a fixed sheet count.** Once max capacity is a value
   staff can change (e.g., after swapping a starter cartridge for a
   standard one), a hardcoded "warn at 1350 pages" breaks the moment that
   number changes — the check needs to be `current / max >= 0.9`, not a
   fixed threshold.

Remember §5's dependency: sheet counts feeding these thresholds must
include banner pages when they were printed, or this alert fires later
than it should.

---

## 9. Payment confirmation independent of the browser tab ⏸️ built in v2 — port forward, one real gap remains

**Status for this build**: the actual reconciliation logic is genuinely
built and working — `lib/payment-reconciliation.ts`'s shared
`reconcilePendingPayment()`, the atomic `claimJobAsPaid()`/
`expireJobIfPending()` fix from §11, and the `/api/cron/recheck-payments`
route itself all port forward directly. **What's still missing: the route
was never actually scheduled to run.** It works fine if you hit it
manually, but nothing calls it automatically yet. Vercel's free/Hobby tier
only allows daily cron (too infrequent for this purpose) — the working
plan was an external scheduler (cron-job.org) hitting the route every few
minutes with the `CRON_SECRET` bearer token. **This still needs to
actually be set up**, it wasn't finished.

**What it solves**: Right now, payment only gets confirmed because the
customer's own browser is actively polling. If they close the tab right
after paying, nothing server-side independently re-checks — a paid job
could sit forever with nothing printed and no automatic way to catch it.
This was the single most important reliability gap identified all
session.

---

## 10. Auto-refund on print failure 🔲

**What**: If a print genuinely fails after payment succeeded, there's
currently no automated recovery.

**Recommended approach**: Razorpay has a refund API. Even a semi-automated
version (one-click from the rebuilt admin panel, #6) beats today's
"manually figure it out."

---

## 11. Synchronization & race conditions — audit 🟡

Worth a dedicated pass since this system has multiple independent things
touching the same data at once: several Pis, a browser polling, and soon a
scheduled job (#9) too. Going through what's already safe vs. what isn't:

**Already handled correctly:**
- **Two agents claiming the same print job** — `claimJobForPrinting()` uses
  an atomic `UPDATE ... WHERE status = 'paid'`, so even if two Pi processes
  (or a misconfigured duplicate) see the same job at the same instant, only
  one can actually win the claim. This is the right pattern and it's
  already in place.
- **Misconfigured duplicate `KIOSK_ID`** — if two Pis were ever accidentally
  set to the same kiosk id, the claim above still prevents double-printing
  at the data layer; the only symptom would be a confusing log line on the
  losing agent, not an actual double-print. Still worth a clear warning in
  `MULTI_KIOSK.md` against doing this on purpose.

**Real, not-yet-fixed gap:**
- **`/api/verify-payment`'s status transition isn't atomic.** It reads the
  job, checks `status === "pending_payment"` in application code, *then*
  writes `status: "paid"` — a classic read-then-write race. Right now the
  actual damage is minor (two overlapping browser tabs might both call the
  gateway redundantly, both end up writing the same "paid" status — wasteful
  but not corrupting). **It becomes a real problem the moment #9 (scheduled
  independent payment re-check) exists**, because then two *different*
  processes (a browser's poll and the scheduled job) could both detect
  "payment just confirmed" and both fire the "payment confirmed" SMS/WhatsApp
  message from #2 — a duplicate text to the customer. Fix: same atomic
  `UPDATE ... WHERE status = 'pending_payment'` pattern already used for
  claiming print jobs, and only the caller whose update actually succeeded
  sends the notification. Should be built together with #9, not after it.

**Worth designing in from the start, not bolted on later:**
- **Pi clock reliability.** Raspberry Pis have no battery-backed real-time
  clock by default — if a Pi boots without network access, its clock can
  be significantly wrong until NTP syncs. The print agent's own queue
  timeout logic (`watchUntilPrinted`) uses the Pi's local clock, and HTTPS
  calls to Supabase can fail outright if the clock is too far off for TLS
  certificate validation. Worth confirming NTP sync is reliable/fast on
  boot as part of the Pi setup, especially once unattended kiosks are
  rebooting on their own after power blips.
- **File cleanup (#4) vs. a stuck job.** The auto-delete cron shouldn't
  be a blind "anything older than X" — it needs to skip jobs still in an
  active state (`pending_payment`, `paid`, `printing`), only targeting
  terminal states (`printed`, `print_failed`, `payment_failed`,
  `expired`) — this is exactly what #4's actual 6h/24h status-aware design
  already does, described in full there; noting it here too since this is
  the section explaining *why* that design matters, not just what it is.

---

## 12. Database backups / disaster recovery 🔲

**What**: Supabase's free tier has zero automatic backups — if data got
corrupted, wrongly deleted, or a migration went bad, there's no undo. This
session had several close calls (an RLS policy that briefly blocked all
reads, a rebase that nearly shipped the wrong file version) that were
recoverable *because* the mistakes were caught quickly by a person
watching closely — that safety net doesn't exist for the actual data once
this is running unattended.

**Recommended approach**: not urgent to build anything — this is really an
infrastructure/billing decision, not a code change. Worth moving to
Supabase's paid tier before real unattended deployment, partly for the
storage headroom already discussed in §4, partly for this. Confirm current
backup terms on whichever tier is chosen before relying on it — exact
backup frequency/retention varies by plan and is worth verifying directly
rather than assuming.

---

## 13. Rate limiting & idempotent order creation ⏸️ built in v2 — port forward as-is

**Status for this build**: fully built and working in v2, no changes
needed for v2.5 — port directly, same as #4. Includes the atomic
`increment_rate_limit` Postgres function (the same pattern §21's ticket
counter reuses) and the settings-comparison fix (comparing via
field-by-field checks, not `JSON.stringify` after a jsonb round-trip,
since Postgres doesn't preserve key order through jsonb).

**What it solves**: Two related gaps around abuse/mistakes at the
order-creation step — nothing stopping a script from flooding
`/api/create-order`, and no protection against a double-clicked "Pay"
button creating two separate paid orders for the same upload.

---

## 14. Automated tests for the highest-risk logic 🔲

**What**: This session found two real, silent bugs purely through manual
testing — `providerOrderId` never being saved (payment could never
verify), and an unhandled exception producing a non-JSON response that
crashed the polling loop. Both are exactly the kind of thing a small test
suite catches immediately instead of days of manual debugging.

**Recommended approach**: not full coverage everywhere — targeted tests
for the job status state machine specifically (`lib/store.ts`'s update/
claim functions, the atomic-transition fix from §11) and the payment
verification logic in `lib/payment/`, since those are where a silent bug
has the highest cost (lost payments, double prints). Skip testing UI
styling/layout — low value for the effort here.

---

## 15. Landscape orientation bug ⏸️ fixed in v2 — port forward as-is

**Status for this build**: fixed and working in v2, port directly — the
`pdf-lib` page-rotation approach described below.

**What it was**: Landscape-oriented print jobs didn't come out correctly,
because the print pipeline only set CUPS's `orientation-requested` option
— which mostly instructs the printer how paper feeds, and doesn't
reliably rotate the actual page content, especially with a community
driver like splix. The fix rotates the actual PDF content when building
the final print-ready file (`page.setRotation()`), driver-independent.

---

## 16. File format conversion reliability 🔲

**What**: DOCX (and possibly other formats) don't convert properly.

**Known limitation, likely the main cause for DOCX**: the current
client-side conversion (`lib/client-file-converter.ts`, via `mammoth`)
only extracts plain text and re-lays it into a fresh PDF with `jsPDF` —
tables, images, precise formatting, and page breaks from the original
document are not preserved. Fine for simple text-only Word docs, likely to
produce garbled/incorrect output for anything with tables or images —
which, given the actual use case (assignments, certificates), is probably
common. HEIC/image conversion has its own separate library-reliability
quirks worth checking independently.

**Needs more specifics before designing a fix** — which formats, and what
the broken output actually looked like.

---

## 17. Kiosk display: wait for real network before launching 🔲

**What**: the Pi's screen sometimes shows blank white after boot, because
Chromium launches on desktop login before the network is actually up.

**Recommended approach**: replace the direct Chromium autostart with a
small wrapper script that blocks on a real connectivity check (e.g.
polling the live site with `curl` until it responds) before launching
Chromium, rather than assuming "desktop loaded" means "network's ready."
Pair with either an auto-relaunch-on-failure in the wrapper script, or a
retry-on-load-failure behavior in the kiosk-display page itself, as a
second layer of defense.

---

## 18. University captive portal handling 🔲

**What**: campus WiFi often requires an interactive login page, which an
unattended kiosk can't click through itself.

**Recommended approach, in order of preference**:
1. **Ask the college IT department for a MAC-address exemption** for the
   kiosk's Pi — the correct fix, not a workaround. Most university
   networks already support this for other headless devices (printers,
   smart TVs). Worth trying first, costs nothing.
2. **A small travel router bridging the connection** — authenticate
   through the portal once via the router's own session, and have the Pi
   connect to the router's private network instead, never seeing the
   portal itself.
3. **A dedicated cellular data dongle/SIM** — sidesteps campus networking
   entirely. Recurring cost, but genuinely the most reliable option long
   term, and standard practice for real-world unattended kiosks precisely
   because venue WiFi is never fully dependable for something that must
   run unattended.
4. **Scripting the portal login itself** — last resort only; fragile,
   breaks whenever the portal page changes, possibly against acceptable-use
   policy. Not something to build the real solution on.

---

## 19. Defensive JSON parsing on every frontend fetch call ⏸️ fixed in v2 — port forward as-is

**Status for this build**: fixed and working in v2, port directly.

**What it was**: the frontend's `create-order` call (and others) blindly
did `await response.json()` with no defense against the server ever
returning something that isn't valid JSON — a platform-level timeout
page, a crash before the route's own try/catch could respond, etc. This
produced a raw `"Unexpected end of JSON input"`-style error surfacing
directly to the user — the actual cause of a real bug report during this
project ("something JSON related" on a PDF upload), likely a large/
malformed PDF pushing server-side processing past a time or memory limit.
The fix audited every `fetch(...).json()` call, checking `response.ok`
and wrapping each parse in its own try/catch with a readable message,
paired with server-side file-size limits and a dedicated try/catch around
PDF processing.

---

## 20. Bulk/load testing 🔲

**What**: confirm the system behaves correctly under a real burst of
orders (e.g. 50+ near-simultaneous), not just one-at-a-time manual testing.

**Important framing**: the printer's physical speed (18 ppm) is a hard
floor no software change can improve — 50 single-page jobs takes at least
~3 minutes of pure print time regardless of architecture. The actual goal
of this testing isn't "prevent it from being slow," it's confirming the
queue drains correctly, in order, with nothing silently dropped or
double-claimed under real concurrent load — and using the real timing
data to calibrate the ETA feature (#3) instead of guessing at it.

**Recommended approach**: a test script simulating 50 near-simultaneous
order creations, watching: whether `/api/create-order` holds up under
burst Supabase/Razorpay calls, whether the print agent works through the
resulting queue correctly, and how long the full batch actually takes
end-to-end.

---

## 21. Ticket code generation — new for v2.5 🔲

**What**: replaces the banner page as the pickup-identification mechanism.
Every job gets a short, friendly code (`#042`-style, not a raw job
ID/UUID) — shown to the customer on their own phone and on the kiosk
screen, so they can match the two visually.

**Must be assigned atomically, per kiosk, resetting daily** — two jobs
paid within the same second must never collide on the same number, and
numbers should stay short (reset each day) rather than growing
unboundedly over the kiosk's lifetime. Reuse the exact atomic-counter
pattern already proven correct for #13's `increment_rate_limit` function
(an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, not a
read-then-write) — this is the same class of problem, don't design a new
pattern from scratch. Roughly:

```sql
create table kiosk_ticket_counters (
  kiosk_id text not null,
  ticket_date date not null,
  last_number integer not null default 0,
  primary key (kiosk_id, ticket_date)
);
-- next_ticket_number(kiosk_id) atomically increments and returns the
-- current day's counter for that kiosk, same pattern as increment_rate_limit.
```

Assign the ticket number at job creation (`/api/create-order`), not later
— simplest, and avoids extra logic tied to payment-confirmation timing.

---

## 22. Customer-facing ticket code display — new for v2.5 🔲

**What**: the customer's own post-payment status screen (currently shows
"Waiting for payment" → "Printing your document...") needs to prominently
show their ticket code once assigned — this is the entire replacement for
what notifications (§2) would have texted them, no SMS needed for this
version since they already have their phone open right there.

**Where it lives**: `components/PdfPageSelector.tsx`'s status display —
show the code large and clearly labeled ("Your pickup code") alongside
the existing status text, not buried in fine print.

---

## 23. Kiosk display: current job + upcoming queue — new for v2.5 🔲

**What**: extends the existing `/kiosk-display` page (built in a prior
session) to show which ticket code is currently printing, plus a short
list of what's coming up next (2-3 codes), not just a generic status
message like it has today.

**Data needed**: the kiosk display already polls `print_jobs` scoped to
its `kiosk_id` — extend that query to also pull the next few `paid`/
`printing` jobs in order, and surface each one's ticket code (§21)
prominently rather than just a job count or generic "printing" text.

---

## 24. Pickup confirmation — new for v2.5, hardware-pending 🔲

**What**: the team lead wants the next job to not start printing until the
previous person has actually picked theirs up — not just "printing
finished," but "confirmed collected." Something has to trigger that
confirmation.

**Status: split into two tracks, deliberately.** There's a physical flap
sensor idea (detecting the flap closing after pickup) that could
eventually trigger this automatically, but **that hardware isn't
confirmed yet** — unclear if it's built, wired to the Pi, or what
interface it exposes. Don't guess at integrating it now.

**Build now**: a generic endpoint, `/api/kiosk/confirm-pickup`, that marks
a job `collected` and lets the print agent release the next one. It
doesn't care what calls it. **For this prototype phase specifically**,
trigger it via a simple staff-operated button (on the staff admin panel,
or a discreet on-screen tap on the kiosk's touchscreen while handing over
the paper — the touchscreen exists, even though customers aren't expected
to interact with it normally). The real sensor, once its hardware
interface is actually known, plugs into this exact same endpoint later —
zero changes needed to the print agent's queue logic when that happens.

---

## 25. Print agent: gate on pickup confirmation — new for v2.5 🔲

**What**: the print agent's queue must not claim/start the next `paid` job
for a kiosk while a previous job for that same kiosk is sitting `printed`
but not yet `collected` (§24).

**Recommended approach**: a new job status, `printed` → `collected` (via
§24's endpoint) as a distinct step, not folded into `printed` itself. The
agent's polling loop checks for any `printed`-but-not-`collected` job for
its kiosk before claiming a new one from the `paid` queue — if one exists,
it waits, it doesn't proceed. This is a real change to the loop's
condition, not just a new status value sitting unused.

---

## 26. Prototype-only quick-access login — new for v2.5, temporary 🔲

**What**: alongside the real Supabase Auth login (§6), two simple
passcodes for fast access **during the prototype/testing phase only** —
one unlocks the owner view, one unlocks the staff view, without typing a
full email/password each time.

**Critical: this must not weaken the real security model §6 already
built.** A passcode that just flips a client-side "unlocked" flag would
recreate the exact problem the original PIN-based admin had — RLS
enforcement only means something if the actual session behind it is real.
The correct way to build this: each passcode maps to a real, pre-created
test account's email/password (one `owner` role account, one `staff` role
account, created the normal way in Supabase's dashboard). Entering the
passcode triggers the genuine `signInWithPassword()` flow behind the
scenes with that account's real credentials — so RLS still applies exactly
as designed, this is purely a UI convenience layer, not a bypass.

**Must be trivially removable later** — gate the whole passcode-entry UI
behind a single flag (e.g. `NEXT_PUBLIC_PROTOTYPE_MODE=true`), so removing
it later is deleting one component/guard, not hunting through the
codebase.

---

## Hardware note (Pi 5 → future custom PCB)

The Pi 5 8GB is heavily over-specced for this workload — nothing here
needs optimizing for it. If a future custom PCB has ≥1-2GB RAM, everything
above still works unchanged. Only if RAM drops meaningfully below that
would the print agent's runtime be worth reconsidering (a compiled
Go/Rust binary instead of Node+tsx). Not worth planning around until an
actual PCB spec exists.

---

## Suggested build order (v2.5-specific — supersedes the phase list below for this build)

This build's actual priority, given most of the original Phase 1-3 work
already exists in v2 and just needs porting (mostly disabled) rather than
building fresh:

1. **Port the core from v2, mostly as-is**: the payment pipeline, admin
   panel (#6, including auth/roles/pricing), `print-agent/`'s CUPS
   integration and atomic claim logic, multi-kiosk `kiosk_id` design. Set
   up the fresh Supabase project and run the *complete* schema up front
   (per the Ground Rules schema-stability principle) — including the
   phone/banner columns even though their code paths are disabled.
2. **Port and disable, don't skip**: phone number (#1), notifications
   (#2), banner page (#5) — comment out the active code paths, keep
   everything else.
3. **Build what's actually new for this version**: ticket code generation
   (#21), the customer-facing display of it (#22), the kiosk screen's
   current+queue view (#23), the pickup-confirmation endpoint and staff
   trigger (#24), the print agent's gate on it (#25), and revert the
   sheet-count `+1` that the now-disabled banner page needed (called out
   again in #5's own entry — easy to miss).
4. **The prototype-only quick-login** (#26) can happen any time after #6's
   real auth exists — order doesn't matter much for this one.
5. Everything genuinely not yet built — #7, #8, #10, #12, #14, #16, #17,
   #18, #20 — is lower priority for this specific interim build. Pick up
   from there once this version is stable, following the original phase
   order that follows (which already accounts for most of Phase 1-3 being
   done via v2 — see each item's own status marker above for exactly
   what's built vs. not).

---

### Original phase order (historical — Phases 1-3 already executed via v2; kept for context on Phase 4-5, which are genuinely still ahead)

1. **Phase 1** (cheap, contained, no new infra): phone number field (#1),
   banner page with opt-in checkbox (#5), auto-delete cron (#4, built with
   the terminal-state guard from §11 from day one), rate limiting +
   duplicate-order protection (#13, cheap and contained enough to do now
   rather than wait).
2. **Phase 2**: notifications (#2) and payment confirmation without a
   browser (#9) **built together**, with the atomic status-transition fix
   from §11 as part of the same change — building them separately risks
   shipping the duplicate-notification race described there. ETA (#3) and
   the low-supply alert fix (#8's alert-sending half) fit naturally here
   too, since they're the same notification pipe.
3. **Phase 3**: admin panel rebuild (#6).
4. **Phase 4**: real multi-kiosk isolation (#7) + heartbeat monitoring
   (#8's remaining half), plus confirming Pi NTP reliability (§11) as part
   of the same hardening pass.
5. **Phase 5**: auto-refund (#10), targeted automated tests (#14) for the
   state-machine logic touched across the earlier phases.

**Not a build phase, a decision to revisit**: database backups (#12) —
worth acting on once moving to a paid Supabase tier, whenever that happens
to align with funding, rather than tied to a specific phase above.
