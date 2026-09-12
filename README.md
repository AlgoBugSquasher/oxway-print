# OXWAY Smart Print Kiosk

A Next.js self-service printing kiosk for PDF, image, and Word document uploads.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supported Uploads

The kiosk accepts PDF, PNG, JPG/JPEG, WEBP, HEIC/HEIF, and DOCX files up to 25 MB. Images are converted in the browser to centered A4 PDFs with 20px-equivalent safe margins. Existing PDFs keep their actual page count. DOCX files are converted in the browser with Mammoth and jsPDF before thumbnails are rendered.

The Node dependency for image-to-PDF conversion is `pdf-lib`:

```bash
npm install pdf-lib heic2any mammoth jspdf
```

No Python package, LibreOffice installation, or server binary is required. DOCX conversion extracts document text in the browser and lays it out into an A4 PDF. HEIC/HEIF camera photos are converted to JPEG with `heic2any` before image fitting.

## Architecture: the website ≠ the kiosk

The kiosk is a Raspberry Pi with a printer attached. It does **not** run this
website. Instead:

1. The kiosk displays a QR code pointing at wherever this website is
   deployed (could be anywhere with internet access).
2. A customer scans it on their own phone, uploads their file, and pays —
   all in their own browser.
3. The website confirms payment directly with the gateway, uploads the
   print-ready PDF to Supabase Storage, and marks the job `paid` in a
   Supabase table.
4. A separate, small script — the **print agent** (`print-agent/index.ts`) —
   runs on the Pi as its own process. It watches that same Supabase table,
   and the moment a job is `paid`, downloads the PDF and prints it via CUPS.

The website and the Pi never talk to each other directly — Supabase is the
only thing connecting them, which means the website can be hosted anywhere
and the Pi just needs outbound internet access (no public IP, no port
forwarding, no matter where either one lives).

## Payment (both gateways supported)

Copy `.env.example` to `.env.local` and fill in credentials for whichever
gateway is live — set `PAYMENT_PROVIDER=cashfree` or `PAYMENT_PROVIDER=razorpay`.
Both are wired up with a standard checkout modal (Card / Netbanking / UPI,
UPI shows its own QR) — switching is a one-line env change once KYC clears
for either one.

Flow:

1. `POST /api/create-order` — uploads the final PDF to Supabase Storage,
   writes a job row, and creates an order with the active gateway.
2. The customer's browser polls `GET /api/verify-payment?jobId=...` every
   few seconds. This checks payment status **directly with the gateway**,
   and the moment it's confirmed, marks the Supabase job `paid`.
3. The Pi's print agent (see [SETUP_PI.md](./SETUP_PI.md)) picks it up from
   there — no manual "print" button, no trusting the checkout modal's own
   success callback.

Webhook endpoints (`/api/webhook/cashfree`, `/api/webhook/razorpay`) are also
included as an optional faster path once the website has a public HTTPS URL
— the polling flow works fine without them.

See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for the shared database/storage
setup, and [SETUP_PI.md](./SETUP_PI.md) for the printer + print agent.
