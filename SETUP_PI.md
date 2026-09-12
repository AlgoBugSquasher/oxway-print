# Kiosk printer setup — Raspberry Pi 5 (Pi OS Trixie)

**The Pi does not run the website.** The website (this repo's Next.js app)
can be hosted anywhere — the customer opens it on their own phone after
scanning the kiosk's QR code. The Pi's only jobs are: run the physical
printer, and run the small **print agent** script (`print-agent/index.ts`)
that watches Supabase for paid jobs and prints them. See
[SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for how the two sides connect.

## 1. Install and configure CUPS

```bash
sudo apt update
sudo apt install -y cups
sudo usermod -aG lpadmin "$USER"
# Log out/in (or reboot) for the group change to take effect.
```

Plug in the printer (USB is simplest) and add it:

```bash
lpinfo -v                       # lists detected devices, e.g. usb://Epson/L3150
sudo lpadmin -p oxway-printer -E -v usb://Epson/L3150 -m everywhere
sudo lpoptions -d oxway-printer  # sets it as the default printer
```

Print a test page to confirm it works:

```bash
lp -d oxway-printer /usr/share/cups/data/testprint
```

Set `PRINTER_NAME=oxway-printer` in `.env.local` (or leave it blank to use
whatever `lpoptions -d` reports as default).

## 2. Install Node and the print agent's dependencies

```bash
git clone <your repo> oxway-print
cd oxway-print
npm install
cp .env.example .env.local
```

Fill in `.env.local` with:
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (see SUPABASE_SETUP.md)
- `PRINTER_NAME` (from step 1)

The print agent doesn't need payment gateway credentials, LibreOffice, or
anything web-server related — it only touches Supabase and CUPS.

## 3. Run the print agent

For quick testing:

```bash
npm run print-agent
```

It logs `[print-agent] Watching for paid jobs every 4000ms...` and then
prints anything the website marks `paid` in Supabase.

For unattended operation, run it as a systemd service so it survives
reboots/crashes:

```ini
# /etc/systemd/system/oxway-print-agent.service
[Unit]
Description=OXWAY print agent
After=network.target cups.service

[Service]
WorkingDirectory=/home/pi/oxway-print
ExecStart=/usr/bin/npm run print-agent
Restart=always
User=pi
EnvironmentFile=/home/pi/oxway-print/.env.local

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now oxway-print-agent
sudo journalctl -u oxway-print-agent -f   # watch it live
```

**Permissions**: the print agent needs to run `lp`/`lpstat`. Being in the
`lpadmin` group (step 1) is normally enough on Pi OS.

## 4. The kiosk's QR code

Since the website runs elsewhere and customers reach it from their own
phones, the physical kiosk itself just needs to display a QR code pointing
at wherever the website is hosted — a printed sticker/placard, or a small
screen showing a static image, is enough. No app runs "on" the kiosk besides
the print agent. Point the QR at your public site URL (or a Cloudflare
Tunnel / your shop's own domain, depending on how you deploy the website —
that's a separate decision from anything in this file).

## 5. Switching payment gateways

Both Cashfree and Razorpay are wired up on the website side. Whichever
finishes KYC first, fill in its credentials and set:

```env
PAYMENT_PROVIDER=cashfree   # or razorpay
```

wherever the website itself is deployed (not on the Pi — the Pi doesn't care
which gateway is active, it just prints whatever Supabase marks `paid`).

## 6. Troubleshooting

- **Nothing prints, no error shown**: run `lpstat -p -d` to confirm the
  printer is idle and accepting jobs, check `lpstat -o` for stuck jobs, and
  check `sudo journalctl -u oxway-print-agent -f` for what the agent saw.
- **"Could not parse CUPS job id"**: run the same `lp` command manually
  (see `lib/print/cups.ts` for the exact flags) to see CUPS' actual output.
- **Color/mono not respected**: not all PPDs support `print-color-mode`;
  check `lpoptions -p oxway-printer -l` for the exact option name/values
  your driver exposes and adjust `lib/print/cups.ts` if needed.
- **Jobs stuck on "paid", never move to "printing"**: confirm the print
  agent is actually running (`systemctl status oxway-print-agent`) and that
  its `.env.local` has working Supabase credentials — try
  `npm run print-agent` in the foreground to see errors directly.
