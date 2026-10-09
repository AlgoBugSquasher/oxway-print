"use client";
// Visual shell (QR layout, dark full-screen kiosk theme) ported from the
// original repo's app/kiosk-display/ — that page never made it into v2, so
// there was nothing to port from there. What's new here for v2.5 (ROADMAP.md
// §23): instead of polling print_jobs directly for one generic status
// string, this polls /api/kiosk-display/[kioskId] (a narrow server route,
// not a public table/view — see that route's own comment for why) and shows
// the actual ticket codes for what's printing now and what's up next.

import { type CSSProperties, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import BrandWordmark from "@/components/BrandWordmark";
import { fetchJson } from "@/lib/fetch-json";
import { type ConnectivityLevel, useConnectivityStatus } from "@/lib/hooks/useConnectivityStatus";

const POLL_INTERVAL_MS = 3000;

interface KioskDisplayData {
  current: { ticketNumber: number; status: "printing" | "printed" } | null;
  upcoming: { ticketNumber: number }[];
}

function formatTicket(ticketNumber: number): string {
  return `#${String(ticketNumber).padStart(3, "0")}`;
}

/**
 * This is a public, unattended, touch kiosk screen — no text should ever be
 * selectable, no image draggable, and no OS/browser long-press menu should
 * ever appear over it. `-webkit-user-drag`/`-webkit-touch-callout` aren't
 * modeled in React's CSSProperties type (they're WebKit-only), hence the
 * cast — every property here is still a real, intentional CSS property,
 * not an escape hatch for anything else.
 */
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
 * The status light itself — readable from a few steps away (large dot +
 * label, high-contrast against the kiosk screen's dark background), next to
 * the wordmark per the task spec. A plain `animate-pulse` on the dot when
 * not fully online, so a passerby staff member notices it changed state
 * without having to read the label text first.
 */
function ConnectivityLight({ level }: { level: ConnectivityLevel }) {
  const { label, dotClass, textClass } = CONNECTIVITY_COPY[level];
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
      <span className={`size-2.5 rounded-full ${dotClass} ${level !== "green" ? "animate-pulse" : ""}`} />
      <span className={`text-xs font-bold uppercase tracking-[0.2em] ${textClass}`}>{label}</span>
    </div>
  );
}

function KioskDisplayView() {
  const [data, setData] = useState<KioskDisplayData>({ current: null, upcoming: [] });
  const [isOnline, setIsOnline] = useState(true);
  // Shared across every kiosk — ?k=<kiosk-id> in the URL (matching that
  // kiosk's own Chromium autostart command) scopes it to just this
  // machine's jobs. Defaults to the original single kiosk.
  const kioskId = useSearchParams().get("k") || "oxway_01";
  const { level: connectivity, isUpdating } = useConnectivityStatus(kioskId);

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

  const { current, upcoming } = data;
  const headline = !isOnline
    ? "Reconnecting..."
    : current?.status === "printing"
      ? `Now printing ${formatTicket(current.ticketNumber)}`
      : current?.status === "printed"
        ? `${formatTicket(current.ticketNumber)} is ready — please collect`
        : "Scan the QR code to get started";
  const toneClass = !isOnline
    ? "text-slate-500"
    : current?.status === "printed"
      ? "text-emerald-400"
      : current?.status === "printing"
        ? "text-blue-400"
        : "text-slate-200";

  return (
    <div
      className="flex h-screen w-screen items-center justify-center gap-16 bg-[#0b0f14] px-16 text-white"
      style={KIOSK_LOCKDOWN_STYLE}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="flex flex-col items-center gap-6">
        <div className="rounded-[2rem] bg-white p-8 shadow-2xl">
          <Image src="/brand/qr-code.png" alt="Scan to open the print kiosk" width={420} height={420} priority draggable={false} />
        </div>
        <p className="text-xl font-bold uppercase tracking-[0.3em] text-slate-400">Scan to upload &amp; print</p>
      </div>

      <div className="flex w-[420px] flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandWordmark className="h-10" draggable={false} />
            <span className="text-sm font-bold uppercase tracking-[0.3em] text-blue-500">Print Kiosk</span>
          </div>
          <ConnectivityLight level={connectivity} />
        </div>
        {isUpdating ? (
          <div className="mt-2 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-5">
            <h1 className="text-3xl font-black leading-tight text-blue-300">Updating, back in a minute</h1>
            <p className="mt-2 text-base text-slate-400">This kiosk is installing an update. New orders will resume automatically once it&apos;s done — no need to do anything.</p>
          </div>
        ) : (
          <>
            <h1 className={`text-4xl font-black leading-tight transition-colors duration-500 ${toneClass}`}>{headline}</h1>
            {!current && isOnline && (
              <p className="text-lg text-slate-400">
                Open your camera, scan the code, upload your file, and pay — your document prints here automatically.
              </p>
            )}
            {upcoming.length > 0 && (
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Up next</p>
                <div className="flex flex-wrap gap-2">
                  {upcoming.map((job) => (
                    <span key={job.ticketNumber} className="rounded-xl bg-white/10 px-3 py-1.5 text-lg font-black text-slate-200">
                      {formatTicket(job.ticketNumber)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default KioskDisplayView;
