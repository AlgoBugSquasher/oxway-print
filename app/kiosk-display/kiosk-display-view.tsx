"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { AlertTriangle, Wrench } from "lucide-react";
import BrandWordmark from "@/components/BrandWordmark";
import { fetchJson } from "@/lib/fetch-json";
import { type ConnectivityLevel, useConnectivityStatus } from "@/lib/hooks/useConnectivityStatus";
import { formatTicketCode } from "@/lib/ticket-code";

const POLL_INTERVAL_MS = 3000;
const MAX_UPCOMING_SHOWN = 2;

// QR physical size on a ~7" (800x480) kiosk screen — big enough to scan
// from about 30cm away (roughly 1px ≈ 0.19mm at this resolution, so 210px
// prints at ~4cm, comfortably over the ~3cm a 30cm scan distance needs).
const QR_SIZE_PX = 210;

type CurrentJobStatus = "printing" | "print_blocked" | "interrupted" | "printed" | "print_failed";

interface KioskDisplayData {
  current: { ticketNumber: number; status: CurrentJobStatus; refundStatus?: string | null } | null;
  upcoming: { ticketNumber: number }[];
  trayCount: number;
}

const KIOSK_LOCKDOWN_STYLE = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitUserDrag: "none",
  WebkitTouchCallout: "none",
  touchAction: "none",
  overscrollBehavior: "none",
} as unknown as CSSProperties;

const CONNECTIVITY_COPY: Record<ConnectivityLevel, { label: string; dotClass: string; textClass: string }> = {
  green: { label: "Online", dotClass: "bg-emerald-400", textClass: "text-emerald-400" },
  amber: { label: "Unstable", dotClass: "bg-amber-400", textClass: "text-amber-400" },
  red: { label: "Offline", dotClass: "bg-red-500", textClass: "text-red-500" },
};

/**
 * The small top-right connectivity pill — the ONLY visual change this
 * screen ever makes for the kiosk going offline (fed by `connectivity`,
 * from useConnectivityStatus below). A full-screen "Kiosk Offline"
 * takeover briefly replaced this and has been removed on request — the QR
 * and the rest of the screen stay exactly as normal while offline; this
 * pill turning red is the only indicator.
 */
function ConnectivityLight({ level }: { level: ConnectivityLevel }) {
  const { label, dotClass, textClass } = CONNECTIVITY_COPY[level];
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
      <span className={`size-2.5 rounded-full ${dotClass} ${level !== "green" ? "animate-pulse" : ""}`} />
      <span className={`text-sm font-bold uppercase tracking-[0.2em] ${textClass}`}>{label}</span>
    </div>
  );
}

type Overlay = { icon: typeof AlertTriangle; tone: string; title: string; body: string } | null;

/**
 * Full-screen takeover — reserved for an actual checkout-blocking
 * condition (the printer itself can't print, or a maintenance update is
 * running), never for kiosk network connectivity. See the `overlay`
 * computation below for exactly which two conditions reach this.
 */
function AttentionOverlay({ overlay }: { overlay: NonNullable<Overlay> }) {
  const Icon = overlay.icon;
  return (
    <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 px-10 text-center ${overlay.tone}`}>
      <Icon size={72} strokeWidth={2.5} />
      <h1 className="text-5xl font-black leading-tight sm:text-6xl">{overlay.title}</h1>
      <p className="text-2xl font-medium leading-snug opacity-90">{overlay.body}</p>
    </div>
  );
}

/** QR block — always rendered (see KioskDisplayView's own comment on why), with its "Scan to print" label directly underneath, unconditionally. */
function QrBlock() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-[1.5rem] bg-white p-5 shadow-2xl">
        <Image src="/brand/qr-code.png" alt="Scan to open the print kiosk" width={QR_SIZE_PX} height={QR_SIZE_PX} priority draggable={false} />
      </div>
      <p className="text-xl font-black uppercase tracking-[0.2em] text-slate-300">Scan to print</p>
    </div>
  );
}

function KioskDisplayView() {
  const [data, setData] = useState<KioskDisplayData>({ current: null, upcoming: [], trayCount: 0 });
  const kioskId = useSearchParams().get("k") || "oxway_01";
  const { level: connectivity, isUpdating, printBlocked } = useConnectivityStatus(kioskId);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await fetchJson<KioskDisplayData>(`/api/kiosk-display/${kioskId}`);
        if (cancelled) return;
        setData(result);
      } catch {
        // Best-effort — a failed poll just leaves `data` showing whatever
        // it last successfully fetched, rather than clearing the screen
        // over one bad request. Kiosk network connectivity itself is
        // already surfaced separately by ConnectivityLight, fed from
        // useConnectivityStatus below.
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [kioskId]);

  const { current, upcoming, trayCount } = data;

  const refundStatusCopy = current?.status === "print_failed" && current.refundStatus
    ? current.refundStatus === "refunded"
      ? { title: "Refunded", body: `${formatTicketCode(current.ticketNumber)} — your refund has been sent to your original payment method.` }
      : { title: "Refund pending", body: `${formatTicketCode(current.ticketNumber)} — this print didn't complete; a refund is under review.` }
    : null;

  // Only a genuine checkout-blocking condition takes over the whole screen
  // and hides the QR (requirement: "Hide the QR only when checkout is
  // blocked — printer offline, out of paper, or maintenance"): the printer
  // itself can't print right now (printBlocked — out of paper, a jam, a
  // door open, or the printer reporting itself offline, see
  // lib/print/cups.ts's "blocked" classification), or this kiosk is
  // installing an update (isUpdating — left exactly as-is on request).
  // Kiosk NETWORK connectivity (isOffline) deliberately does NOT reach
  // here — that used to produce a full-screen "Kiosk Offline" overlay
  // here; removed on request, see ConnectivityLight's own comment for
  // what represents it now instead. A refund being pending/resolved also
  // doesn't block a NEW customer from checking out, so it isn't here
  // either — see refundStatusCopy above, shown inline next to the QR
  // instead, below.
  const overlay: Overlay = printBlocked
    ? { icon: AlertTriangle, tone: "bg-amber-600 text-white", title: "Printer Unavailable", body: "Out of paper or a door is open. Staff have been notified." }
    : isUpdating
      ? { icon: Wrench, tone: "bg-blue-700 text-white", title: "Maintenance", body: "This kiosk is installing an update — back in a minute." }
      : null;

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#0b0f14] px-8 py-6 text-white"
      style={KIOSK_LOCKDOWN_STYLE}
      onContextMenu={(event) => event.preventDefault()}
    >
      {overlay && <AttentionOverlay overlay={overlay} />}

      <div className="flex items-center justify-between">
        <BrandWordmark className="h-9" draggable={false} />
        <ConnectivityLight level={connectivity} />
      </div>

      {/* Requirement: "The QR must stay visible in every state" — printing,
         waiting, and while print IDs are showing. Laid out side-by-side
         (QR | current status) rather than mutually exclusive, so neither
         ever has to be hidden to show the other on this ~800x480 screen. */}
      <div className="flex flex-1 items-center justify-center gap-12">
        <QrBlock />

        <div className="flex max-w-[380px] flex-col items-start gap-3">
          {current?.status === "printing" && (
            <>
              <p className="text-5xl font-black leading-tight text-blue-400">{formatTicketCode(current.ticketNumber)} printing</p>
              {upcoming.length > 0 && (
                <p className="text-xl font-bold text-slate-300">
                  Next: {upcoming.slice(0, MAX_UPCOMING_SHOWN).map((job) => formatTicketCode(job.ticketNumber)).join(", ")}
                </p>
              )}
              <p className="text-lg font-medium text-slate-400">{trayCount} {trayCount === 1 ? "stack" : "stacks"} likely in tray</p>
            </>
          )}

          {current?.status === "printed" && (
            <p className="text-5xl font-black leading-tight text-emerald-400">{formatTicketCode(current.ticketNumber)} ready, please take your pages</p>
          )}

          {current?.status === "print_blocked" && (
            <p className="text-5xl font-black leading-tight text-amber-400">{formatTicketCode(current.ticketNumber)} is paused — needs attention</p>
          )}

          {current?.status === "interrupted" && (
            <p className="text-5xl font-black leading-tight text-rose-400">Printing delayed, please wait</p>
          )}

          {refundStatusCopy && (
            <>
              <p className="text-5xl font-black leading-tight text-slate-200">{refundStatusCopy.title}</p>
              <p className="text-lg font-medium text-slate-400">{refundStatusCopy.body}</p>
            </>
          )}

          {!current && (
            <p className="text-3xl font-black leading-tight text-slate-200">Upload &amp; print your document here</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default KioskDisplayView;
