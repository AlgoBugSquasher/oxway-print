import { ALERT_FROM_EMAIL, RESEND_API_KEY } from "../config";
import type { AlertChannelResult, AlertMessage } from "./types";

export async function sendEmail(to: string[], message: AlertMessage): Promise<AlertChannelResult> {
  if (!RESEND_API_KEY) return { channel: "email", ok: false, error: "RESEND_API_KEY not configured" };
  if (to.length === 0) return { channel: "email", ok: false, error: "no recipient emails" };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: ALERT_FROM_EMAIL, to, subject: message.title, text: message.body }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { channel: "email", ok: false, error: `Resend API ${response.status}: ${text.slice(0, 200)}` };
    }
    return { channel: "email", ok: true };
  } catch (error) {
    return { channel: "email", ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
