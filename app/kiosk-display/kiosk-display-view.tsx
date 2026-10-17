"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { AlertTriangle, PauseCircle, WifiOff, Wrench } from "lucide-react";
import BrandWordmark from "@/components/BrandWordmark";
import { fetchJson } from "@/lib/fetch-json";
import { type ConnectivityLevel, useConnectivityStatus } from "@/lib/hooks/useConnectivityStatus";
import { formatTicketCode } from "@/lib/ticket-code";

const POLL_INTERVAL_MS = 3000;
const MAX_UPCOMING_SHOWN = 2;

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

function ConnectivityLight({ level }: { level: ConnectivityLevel }) {
  const { label, dotClass, textClass } = CONNECTIVITY_COPY[level];
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
      <span className={`size-2.5 rounded-full ${dotClass} ${level !== "green" ? "animate-pulse" : ""}`} />
      <span className={`text-sm font-bold uppercase tracking-[0.2em] ${textClass}`}>{label}</span>
    </div>
  );
}

type Overlay = { icon: typeof WifiOff; tone: string; title: string; body: string } | null;

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

function KioskDisplayView() {
  const [data, setData] = useState<KioskDisplayData>({ current: null, upcoming: [], trayCount: 0 });
  const [isOnline, setIsOnline] = useState(true);
  const kioskId = useSearchParams().get("k") || "oxway_01";
  const { level: connectivity, isUpdating, printBlocked } = useConnectivityStatus(kioskId);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await fetchJson<KioskDisplayData>(`/api/kiosk-display/${kioskId}`);
        if (cancelled) return;
        setData(result);
        setIsOnline(true);
      } catch {
        if (cancelled) return;
        setIsOnline(false);
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
  const isOffline = !isOnline || connectivity === "red";

  const refundOverlayCopy = current?.status === "print_failed" && current.refundStatus
    ? current.refundStatus === "refunded"
      ? { title: "Refunded", body: `${formatTicketCode(current.ticketNumber)} — your refund has been sent to your original payment method.` }
      : { title: "Refund pending", body: `${formatTicketCode(current.ticketNumber)} — this print didn't complete; a refund is under review.` }
    : null;

  const overlay: Overlay = isOffline
    ? { icon: WifiOff, tone: "bg-red-700 text-white", title: "Kiosk Offline", body: "We're reconnecting — please try again shortly." }
    : printBlocked
      ? { icon: AlertTriangle, tone: "bg-amber-600 text-white", title: "Printer Unavailable", body: "Out of paper or a door is open. Staff have been notified." }
      : isUpdating
        ? { icon: Wrench, tone: "bg-blue-700 text-white", title: "Maintenance", body: "This kiosk is installing an update — back in a minute." }
        : refundOverlayCopy
          ? { icon: PauseCircle, tone: "bg-slate-700 text-white", title: refundOverlayCopy.title, body: refundOverlayCopy.body }
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

      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        {current?.status === "printing" && (
          <>
            <p className="text-7xl font-black tracking-tight text-blue-400 sm:text-8xl">{formatTicketCode(current.ticketNumber)} printing</p>
            {upcoming.length > 0 && (
              <p className="text-3xl font-bold text-slate-300">
                Next: {upcoming.slice(0, MAX_UPCOMING_SHOWN).map((job) => formatTicketCode(job.ticketNumber)).join(", ")}
              </p>
            )}
            <p className="text-2xl font-medium text-slate-400">{trayCount} {trayCount === 1 ? "stack" : "stacks"} likely in tray</p>
          </>
        )}

        {current?.status === "printed" && (
          <p className="text-6xl font-black leading-tight text-emerald-400 sm:text-7xl">{formatTicketCode(current.ticketNumber)} ready, please take your pages</p>
        )}

        {current?.status === "print_blocked" && (
          <p className="text-5xl font-black leading-tight text-amber-400">{formatTicketCode(current.ticketNumber)} is paused — needs attention</p>
        )}

        {current?.status === "interrupted" && (
          <p className="text-5xl font-black leading-tight text-rose-400">Printing delayed, please wait</p>
        )}

        {!current && !overlay && (
          <div className="flex flex-col items-center gap-5">
            <div className="rounded-[2rem] bg-white p-6 shadow-2xl">
              <Image src="/brand/qr-code.png" alt="Scan to open the print kiosk" width={260} height={260} priority draggable={false} />
            </div>
            <p className="text-3xl font-black uppercase tracking-[0.2em] text-slate-200">Scan to print</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default KioskDisplayView;
