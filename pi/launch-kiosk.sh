#!/bin/bash
# ROADMAP.md §17 — the kiosk's screen sometimes showed blank white after
# boot, because Chromium was launching straight off the desktop's own
# autostart the moment the Pi's desktop session came up, which is not the
# same thing as the network actually being ready. Run THIS script from the
# Pi's autostart instead of launching chromium-browser directly — it blocks
# on a real connectivity check first, then launches, then auto-relaunches
# Chromium if it ever exits (crash, hang, manual close).
#
# Setup: point your Pi's autostart entry (e.g.
# ~/.config/lxsession/LXDE-pi/autostart, or a systemd user service) at this
# script instead of chromium-browser. Make it executable first:
#   chmod +x pi/launch-kiosk.sh
#
# This is a second, independent layer alongside the kiosk-display page's own
# fetch-retry logic (app/kiosk-display/kiosk-display-view.tsx, which shows
# "Reconnecting..." and keeps polling through a transient API hiccup once
# the page has already loaded) — that logic can't help if the network isn't
# up yet at all, since the page itself never loads far enough to run any
# JavaScript. This script handles that earlier failure mode instead.

set -u

# --- configuration -----------------------------------------------------
# Reads from this Pi's own environment/.env — same KIOSK_ID print-agent
# already uses (see lib/config.ts), so both stay in sync automatically.
# Override either by exporting them before running this script, or by
# editing the defaults below directly.
BASE_URL="${NEXT_PUBLIC_BASE_URL:-http://localhost:3000}"
KIOSK_ID="${KIOSK_ID:-oxway_01}"
KIOSK_URL="${BASE_URL}/kiosk-display?k=${KIOSK_ID}"

CHECK_INTERVAL_SECONDS=3
RELAUNCH_DELAY_SECONDS=2

# --- wait for the site to actually respond, not just "network up" ------
# A Pi can have a network link before DNS/DHCP has fully settled, or before
# the deployed site itself is reachable — polling the real URL (not just
# pinging a gateway) is the only check that actually means "safe to load."
echo "[launch-kiosk] Waiting for ${KIOSK_URL} to respond..."
until curl --silent --fail --max-time 5 --output /dev/null "${KIOSK_URL}"; do
  sleep "${CHECK_INTERVAL_SECONDS}"
done
echo "[launch-kiosk] Site is reachable — launching Chromium."

# --- keep the screen actually on and the cursor out of the way ---------
# Without this the display blanks/sleeps after the desktop's default idle
# timeout, and a visible mouse cursor sits on top of the kiosk-display page
# — both make an unattended kiosk look broken even though nothing's wrong.
# `xset` failures are non-fatal (e.g. running under Wayland instead of X);
# `unclutter` needs `sudo apt install unclutter` once, ahead of time.
xset s off || true
xset s noblank || true
xset -dpms || true
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

# --- launch, and relaunch automatically if Chromium ever exits ---------
while true; do
  chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --incognito \
    "${KIOSK_URL}"

  echo "[launch-kiosk] Chromium exited — relaunching in ${RELAUNCH_DELAY_SECONDS}s."
  sleep "${RELAUNCH_DELAY_SECONDS}"
done
