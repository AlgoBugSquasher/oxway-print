import { TELEGRAM_BOT_TOKEN } from "../config";
import type { AlertChannelResult, AlertMessage } from "./types";

export async function sendTelegram(chatId: string | null, message: AlertMessage): Promise<AlertChannelResult> {
  if (!TELEGRAM_BOT_TOKEN) return { channel: "telegram", ok: false, error: "TELEGRAM_BOT_TOKEN not configured" };
  if (!chatId) return { channel: "telegram", ok: false, error: "no telegram_chat_id set for this kiosk" };

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${message.title}\n\n${message.body}` }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { channel: "telegram", ok: false, error: `Telegram API ${response.status}: ${text.slice(0, 200)}` };
    }
    return { channel: "telegram", ok: true };
  } catch (error) {
    return { channel: "telegram", ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}
