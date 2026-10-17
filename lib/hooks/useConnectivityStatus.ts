"use client";

import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5000;
// AbortController timeout — must be comfortably shorter than POLL_INTERVAL_MS
// so a hung request is always given up on before the next tick would fire
// anyway, and short enough that the UI never visibly freezes waiting on it.
const FETCH_TIMEOUT_MS = 4000;
// A response that technically succeeded but took this long is treated the
// same as a stale heartbeat — amber, not green, since something's clearly
// not healthy even though it didn't outright fail.
const SLOW_RESPONSE_MS = 1500;
// If no poll has succeeded this recently, the light goes red even if the
// most recent *attempt* technically hasn't come back yet — a kiosk screen
// should never sit on a green dot on the strength of a success from a while
// ago.
const SUCCESS_STALE_AFTER_MS = 10_000;

export type ConnectivityLevel = "green" | "amber" | "red";

export interface ConnectivityStatus {
  level: ConnectivityLevel;
  /** True while a remote "Update kiosk" command is pending/running for this kiosk — see app/api/kiosk-status/[kioskId]. */
  isUpdating: boolean;
  /** True while the print agent has flagged a recoverable printer problem (out of paper, door open, low toner, offline) — see app/api/kiosk-status/[kioskId]. Clears on its own once the printer's ready again. */
  printBlocked: boolean;
  printBlockedReason: string | null;
}

interface KioskStatusResponse {
  isOnline: boolean;
  isUpdating: boolean;
  printBlocked: boolean;
  printBlockedReason: string | null;
}

interface PollOutcome {
  at: number;
  succeeded: boolean;
  /** Server-reported heartbeat freshness (kiosk_status.last_seen_at) — only meaningful when succeeded is true. */
  heartbeatFresh: boolean;
  /** Took longer than SLOW_RESPONSE_MS to come back — only meaningful when succeeded is true. */
  slow: boolean;
}

/**
 * One poll attempt, with its own timeout so a hung request can never freeze
 * this hook (or, by extension, the page) waiting on it — AbortController
 * guarantees this resolves within FETCH_TIMEOUT_MS no matter what the
 * network is doing. Deliberately bypasses lib/fetch-json.ts: this needs the
 * raw elapsed time to judge "slow," which that shared helper doesn't expose,
 * and this hook is meant to be fully self-contained to this page.
 */
async function pollOnce(kioskId: string): Promise<{ succeeded: boolean; data: KioskStatusResponse | null; tookMs: number }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`/api/kiosk-status/${kioskId}`, { signal: controller.signal, cache: "no-store" });
    const tookMs = Date.now() - startedAt;
    if (!response.ok) return { succeeded: false, data: null, tookMs };
    const data = (await response.json()) as KioskStatusResponse;
    return { succeeded: true, data, tookMs };
  } catch {
    // Covers a genuine network failure AND the AbortController timeout
    // above — both are "the poll failed" as far as this hook is concerned.
    return { succeeded: false, data: null, tookMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeoutId);
  }
}

function computeLevel(outcome: PollOutcome | null, isBrowserOnline: boolean): ConnectivityLevel {
  if (!isBrowserOnline) return "red";
  if (!outcome || !outcome.succeeded) return "red";
  if (Date.now() - outcome.at > SUCCESS_STALE_AFTER_MS) return "red";
  if (!outcome.heartbeatFresh || outcome.slow) return "amber";
  return "green";
}

/**
 * Drives the kiosk display's connectivity light. Polls
 * /api/kiosk-status/[kioskId] (the same narrow, service-role-backed route
 * the customer page already polls) on its own timer, independent of the
 * page's own ticket/queue poll — a dropped network connection shouldn't
 * depend on that other poll's timing to be noticed.
 *
 * Every poll attempt is wrapped in try/catch (inside pollOnce above) and
 * bounded by a timeout, so a failure or a hung request only ever updates
 * state — it can never throw out of this hook, crash the component, or
 * freeze the page. Nothing here ever reloads or navigates; the interval
 * just keeps ticking regardless of outcome, so connectivity returning on
 * its own is picked up on the very next scheduled poll (or sooner — see the
 * "online" listener below) with no reload needed.
 *
 *   - green  "Online"   — the most recent poll succeeded, recently (within
 *                          SUCCESS_STALE_AFTER_MS), with a fresh heartbeat
 *                          and a fast response.
 *   - amber  "Unstable" — the poll succeeded, but either the print agent's
 *                          own heartbeat has gone stale (server-computed
 *                          isOnline) or the response itself was slow.
 *   - red    "Offline"  — the poll failed outright, the browser itself
 *                          reports no network (navigator.onLine / the
 *                          "offline" window event), or it's simply been too
 *                          long since anything last succeeded.
 */
export function useConnectivityStatus(kioskId: string): ConnectivityStatus {
  const [lastOutcome, setLastOutcome] = useState<PollOutcome | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [printBlocked, setPrintBlocked] = useState(false);
  const [printBlockedReason, setPrintBlockedReason] = useState<string | null>(null);
  const [isBrowserOnline, setIsBrowserOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const { succeeded, data, tookMs } = await pollOnce(kioskId);
      if (cancelled) return;
      if (succeeded && data) {
        setIsUpdating(data.isUpdating);
        setPrintBlocked(data.printBlocked);
        setPrintBlockedReason(data.printBlockedReason);
        setLastOutcome({ at: Date.now(), succeeded: true, heartbeatFresh: data.isOnline, slow: tookMs > SLOW_RESPONSE_MS });
      } else {
        setLastOutcome({ at: Date.now(), succeeded: false, heartbeatFresh: false, slow: false });
      }
    };

    // Instant update the moment the browser itself regains a network link,
    // rather than waiting for the next scheduled tick — "offline" needs no
    // such kick, the light should already be red by then regardless.
    const handleOnline = () => {
      setIsBrowserOnline(true);
      void poll();
    };
    const handleOffline = () => setIsBrowserOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [kioskId]);

  return { level: computeLevel(lastOutcome, isBrowserOnline), isUpdating, printBlocked, printBlockedReason };
}
