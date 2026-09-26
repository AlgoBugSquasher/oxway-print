import { NextResponse } from "next/server";
import { KIOSK_SILENT_THRESHOLD_MINUTES } from "@/lib/config";
import { listKioskHeartbeats } from "@/lib/kiosk-stats";
// ROADMAP.md §2 (notifications) is disabled for v2.5 — see the call site
// below, which falls back to a console log (still checked by the admin
// dashboard's kiosk cards showing last-seen) rather than assuming §2 is wired up.
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
 * KNOWN LIMITATION, not an oversight: unlike the low-supply alert in
 * lib/kiosk-stats.ts, there's no "alert once, not every cycle" debounce here
 * — every run while a kiosk stays silent re-sends the alert. Doing better
 * would need somewhere to persist "already alerted," which means a new
 * column; left out deliberately rather than touching the shared DB schema
 * for this. In practice this just means repeat alerts for an ongoing
 * outage, which most monitoring setups do on purpose anyway — tune the
 * cron schedule (see CRON_SETUP.md) if that's too noisy.
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
    const silentKiosks = kiosks
      // A kiosk that has never sent a heartbeat (null last_seen_at — e.g. right
      // after last_seen_at was added, before its print agent restarted) counts
      // as silent rather than being skipped.
      .map((kiosk) => ({
        ...kiosk,
        minutesSinceLastSeen: kiosk.lastSeenAt ? Math.round((now - new Date(kiosk.lastSeenAt).getTime()) / 60_000) : Number.POSITIVE_INFINITY,
      }))
      .filter((kiosk) => kiosk.minutesSinceLastSeen >= KIOSK_SILENT_THRESHOLD_MINUTES);

    // Disabled for v2.5 — see the §2 note in this file's imports above.
    // const results = await Promise.allSettled(
    //   silentKiosks.map((kiosk) => notifyKioskSilent(kiosk.id, kiosk.minutesSinceLastSeen))
    // );
    // const failed = results.filter((result) => result.status === "rejected").length;
    for (const kiosk of silentKiosks) {
      console.warn(`[ALERT] Kiosk "${kiosk.id}" hasn't checked in for ${kiosk.minutesSinceLastSeen} minutes.`);
    }

    return NextResponse.json({ checked: kiosks.length, silent: silentKiosks.length });
  } catch (error) {
    console.error("check-kiosk-heartbeats error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not check kiosk heartbeats." },
      { status: 500 }
    );
  }
}
