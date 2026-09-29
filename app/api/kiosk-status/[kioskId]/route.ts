import { jsonNoStore } from "@/lib/api-response";
import { ONLINE_THRESHOLD_SECONDS } from "@/lib/config";
import { getKioskLastSeenAt } from "@/lib/kiosk-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polled by the customer's browser (upload/configure page and post-payment
 * status page) every ~10-15s to drive the "kiosk isn't reachable" banner.
 * Narrow, unauthenticated-safe read — same reasoning as
 * app/api/kiosk-display/[kioskId]/route.ts: service-role key server-side,
 * returns only what a customer needs (online/offline), nothing from
 * kiosk_status that's sensitive (no revenue, no supply counters).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kioskId: string }> }) {
  try {
    const { kioskId } = await params;
    const lastSeenAt = await getKioskLastSeenAt(kioskId);
    const isOnline = lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_SECONDS * 1000;

    return jsonNoStore({ isOnline, lastSeenAt });
  } catch (error) {
    console.error("kiosk-status error:", error);
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Could not check kiosk status." },
      { status: 500 }
    );
  }
}
