/**
 * The customer-facing pickup ticket code shown on the banner, the kiosk
 * screen, the admin Jobs table and the WhatsApp "print ready" message
 * (lib/notify/index.ts) — one place so all four always agree on the exact
 * same string for the same number, and a future format change (padding
 * width, prefix) only ever happens here.
 *
 * `MIN_DIGITS` is a MINIMUM display width, not a cap — `padStart` never
 * truncates, so ticket 1000 and 10000 print as "#1000"/"#10000" (one/two
 * digits wider than the usual "#042"), never silently cut down to 3
 * digits. See lib/print/banner.ts's own TICKET_CODE_ABSOLUTE_MIN_FONT_PT
 * for how the banner specifically guarantees that longer string still
 * never gets clipped or ellipsis-truncated on the printed page.
 */
const MIN_DIGITS = 3;

export function formatTicketCode(ticketNumber: number): string {
  return `#${String(ticketNumber).padStart(MIN_DIGITS, "0")}`;
}
