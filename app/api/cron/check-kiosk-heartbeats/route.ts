import { NextResponse } from "next/server";
import { evaluateAlert } from "@/lib/alerts";
import { KIOSK_SILENT_THRESHOLD_MINUTES } from "@/lib/config";
import { listKioskHeartbeats } from "@/lib/kiosk-stats";
// ROADMAP.md §2 (WhatsApp notifications) is disabled for v2.5 — see
// lib/alerts/ for the Telegram/email/banner channels actually used below.
// import { notifyKioskSilent } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ROADMAP.md #8 — a kiosk's own print agent can't alert on its own silence
 * (if it's down, nothing runs to send the alert), so this has to be an
 * independent, server-side check, same reasoning as #9's payment recheck.
 * Reads kiosk_status.last_seen_at, which the print agent touches on its own
 * heartbeat timer (see print-agent/index.ts), independent of print activity.
 *
 * Dedupe/reminder/recovery (one alert per outage, a reminder after
 * ALERT_REMINDER_HOURS, auto-cleared once the kiosk checks in again) is
 * handled by evaluateAlert — see lib/alerts/index.ts.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const kiosks = await listKioskHeartbeats();
    const now = Date.now();
    const kiosksWithStatus = kiosks.map((kiosk) => ({
      ...kiosk,
      minutesSinceLastSeen: kiosk.lastSeenAt ? Math.round((now - new Date(kiosk.lastSeenAt).getTime()) / 60_000) : Number.POSITIVE_INFINITY,
    }));

    for (const kiosk of kiosksWithStatus) {
      const isSilent = kiosk.minutesSinceLastSeen >= KIOSK_SILENT_THRESHOLD_MINUTES;
      await evaluateAlert(kiosk.id, "kiosk_offline", isSilent, {
        title: `OXWAY — ${kiosk.id} is offline`,
        body: `Hasn't checked in for ${kiosk.minutesSinceLastSeen} minutes — the print agent may be down.`,
      });
    }
    const silentCount = kiosksWithStatus.filter((k) => k.minutesSinceLastSeen >= KIOSK_SILENT_THRESHOLD_MINUTES).length;

    return NextResponse.json({ checked: kiosks.length, silent: silentCount });
  } catch (error) {
    console.error("check-kiosk-heartbeats error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not check kiosk heartbeats." },
      { status: 500 }
    );
  }
}
