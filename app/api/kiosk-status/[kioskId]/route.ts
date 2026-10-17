import { jsonNoStore } from "@/lib/api-response";
import { ONLINE_THRESHOLD_SECONDS } from "@/lib/config";
import { getKioskColorModes, getKioskLastSeenAt, getKioskPrintBlockedState, getKioskUpdateState, getKioskWhatsappAvailability } from "@/lib/kiosk-stats";
import { getPricingConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polled by the customer's browser (upload/configure page and post-payment
 * status page) every ~10-15s to drive the "kiosk isn't reachable" banner,
 * (allowColor/allowBw) to grey out a color mode the admin has disabled, and
 * (isUpdating) to block starting a new order while a remote "Update kiosk"
 * command is in flight — see components/PdfPageSelector.tsx. The kiosk
 * display's own connectivity hook also polls this same route (see
 * lib/hooks/useKioskConnectivity.ts), both for the same isOnline signal and
 * for isUpdating's maintenance-screen trigger — one source of truth for
 * "is this kiosk fit to take an order right now," read by both screens.
 * allowWhatsapp (owner-only admin toggle) hides the WhatsApp opt-in
 * checkbox and phone field entirely when false, not just disables them.
 * priceBw/priceColor mirror the admin-editable pricing_config row (not
 * actually kiosk-specific — there's one global row — but returned from
 * here anyway since the customer page already polls this route and
 * create-order already treats pricing_config as the single source of
 * truth server-side; the customer-facing "Estimated total" used to be a
 * hardcoded constant that never reflected an admin's price change at all,
 * only the amount actually charged did, which is exactly backwards.
 * printBlocked/printBlockedReason (requirement: "do not let new customers
 * pay while the machine cannot print") mirror isUpdating's own role — a
 * UI block here, re-enforced for real in app/api/create-order and
 * app/api/staff-print, which both independently re-check
 * getKioskPrintBlockedState rather than trusting this response alone.
 * Clears on its own the moment the print agent clears it — no admin
 * action needed either way.
 * Narrow, unauthenticated-safe read — same reasoning as
 * app/api/kiosk-display/[kioskId]/route.ts: service-role key server-side,
 * returns only what a customer needs, nothing from kiosk_status that's
 * sensitive (no revenue, no supply counters).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kioskId: string }> }) {
  try {
    const { kioskId } = await params;
    const [lastSeenAt, colorModes, updateState, whatsappAvailability, pricing, printBlockedState] = await Promise.all([
      getKioskLastSeenAt(kioskId),
      getKioskColorModes(kioskId),
      getKioskUpdateState(kioskId),
      getKioskWhatsappAvailability(kioskId),
      getPricingConfig(),
      getKioskPrintBlockedState(kioskId),
    ]);
    const isOnline = lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_SECONDS * 1000;

    return jsonNoStore({
      isOnline,
      lastSeenAt,
      allowColor: colorModes.allowColor,
      allowBw: colorModes.allowBw,
      isUpdating: updateState.isUpdating,
      allowWhatsapp: whatsappAvailability.allowWhatsapp,
      priceBw: pricing.priceBw,
      priceColor: pricing.priceColor,
      printBlocked: printBlockedState.printBlocked,
      printBlockedReason: printBlockedState.printBlockedReason,
    });
  } catch (error) {
    console.error("kiosk-status error:", error);
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Could not check kiosk status." },
      { status: 500 }
    );
  }
}
