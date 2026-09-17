/** One interface, swappable providers underneath — same shape as lib/payment/. */
export interface NotifyProvider {
  send(to: string, message: string): Promise<void>;
}
