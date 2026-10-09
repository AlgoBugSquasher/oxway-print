import { MSG91_AUTH_KEY, MSG91_WHATSAPP_SENDER, MSG91_WHATSAPP_TEMPLATE_NAME } from "../config";
import type { NotifyProvider } from "./types";

const MSG91_WHATSAPP_ENDPOINT = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";

/** MSG91 WhatsApp numbers are E.164-style without a leading "+" (e.g. "919876543210"). Our stored phone is a bare 10-digit Indian mobile number (see PHONE_PATTERN in PdfPageSelector.tsx/create-order), so the country code is prepended here rather than asking the customer to type it. */
function toMsg91Number(phone: string): string {
  return `91${phone}`;
}

/**
 * MSG91's WhatsApp send API, built against their documented request shape —
 * ⚠️ NOT yet verified against a real account: no MSG91 credentials or
 * approved WhatsApp template exist at the time this was written (see
 * ROADMAP.md §2). This is the leading open risk in this file, not a detail.
 *
 * WhatsApp's own Business API requires every business-initiated message to
 * use a pre-approved template — arbitrary free text outside a customer-
 * initiated 24h session isn't allowed at all, which is a real constraint on
 * the generic `send(to, message)` shape this provider has to implement
 * (lib/notify/types.ts's NotifyProvider interface). This assumes the
 * eventual approved template has exactly ONE body variable that receives
 * the full message text built by lib/notify/index.ts's callers (e.g. "Your
 * print is ready — show pickup code #042 at the kiosk."). Once a real
 * template exists, check against MSG91's WhatsApp API docs and the
 * template's actual variable layout:
 *   - the `payload.template.name` must match the approved template's name
 *     exactly (set MSG91_WHATSAPP_TEMPLATE_NAME to it).
 *   - the `components` key structure below is a best guess at MSG91's
 *     format for a single-variable template — if the real template has a
 *     different number of variables or MSG91 expects a different key/shape
 *     here, this object needs to change to match.
 *
 * getActiveNotifyProvider() in lib/config.ts only ever selects this
 * provider when NOTIFY_PROVIDER=msg91 is explicitly set — the console
 * provider (lib/notify/console.ts) stays the default otherwise, so this
 * code has zero effect on anything until someone deliberately flips that
 * env var, which should only happen once the above has actually been
 * checked against a real MSG91 account.
 */
export const msg91Provider: NotifyProvider = {
  async send(to, message) {
    if (!MSG91_AUTH_KEY || !MSG91_WHATSAPP_TEMPLATE_NAME || !MSG91_WHATSAPP_SENDER) {
      throw new Error("MSG91_AUTH_KEY / MSG91_WHATSAPP_TEMPLATE_NAME / MSG91_WHATSAPP_SENDER are not configured.");
    }

    const response = await fetch(MSG91_WHATSAPP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: MSG91_AUTH_KEY,
      },
      body: JSON.stringify({
        integrated_number: MSG91_WHATSAPP_SENDER,
        content_type: "template",
        payload: {
          messaging_product: "whatsapp",
          type: "template",
          template: {
            name: MSG91_WHATSAPP_TEMPLATE_NAME,
            language: { code: "en", policy: "deterministic" },
            to_and_components: [
              {
                to: [toMsg91Number(to)],
                // See this file's docstring — "body_1" is a placeholder key
                // for a single-variable template, unverified against a real one.
                components: { body_1: { type: "text", value: message } },
              },
            ],
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`MSG91 WhatsApp send failed (status ${response.status}): ${body}`);
    }
  },
};
