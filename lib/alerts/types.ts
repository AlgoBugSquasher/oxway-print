export type AlertKind = "paper_low" | "toner_low" | "kiosk_offline";

export interface AlertMessage {
  title: string;
  body: string;
}

export interface AlertChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
}
