import type { NotifyProvider } from "./types";

/**
 * Placeholder provider used until a real SMS/WhatsApp provider is chosen
 * (see ROADMAP.md #2 — MSG91, Gupshup, Interakt, Fast2SMS are the
 * candidates). Logs instead of sending, so every trigger call site and the
 * job wiring around it can be built and tested now; swapping in a real
 * provider later only touches lib/notify/index.ts.
 */
export const consoleProvider: NotifyProvider = {
  async send(to, message) {
    console.log(`[notify:console] to=${to} :: ${message}`);
  },
};
