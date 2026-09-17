"use client";
// Visual shell (QR layout, dark full-screen kiosk theme) ported from the
// original repo's app/kiosk-display/ — that page never made it into v2, so
// there was nothing to port from there. What's new here for v2.5 (ROADMAP.md
// §23): instead of polling print_jobs directly for one generic status
// string, this polls /api/kiosk-display/[kioskId] (a narrow server route,
// not a public table/view — see that route's own comment for why) and shows
// the actual ticket codes for what's printing now and what's up next.

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { fetchJson } from "@/lib/fetch-json";

const POLL_INTERVAL_MS = 3000;

interface KioskDisplayData {
  current: { ticketNumber: number; status: "printing" | "printed" } | null;
  upcoming: { ticketNumber: number }[];
}

function formatTicket(ticketNumber: number): string {
  return `#${String(ticketNumber).padStart(3, "0")}`;
}

function KioskDisplayView() {
  const [data, setData] = useState<KioskDisplayData>({ current: null, upcoming: [] });
  const [isOnline, setIsOnline] = useState(true);
  // Shared across every kiosk — ?k=<kiosk-id> in the URL (matching that
  // kiosk's own Chromium autostart command) scopes it to just this
  // machine's jobs. Defaults to the original single kiosk.
  const kioskId = useSearchParams().get("k") || "oxway_01";

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
    <div className="flex h-screen w-screen select-none items-center justify-center gap-16 bg-[#0b0f14] px-16 text-white">
      <div className="flex flex-col items-center gap-6">
        <div className="rounded-[2rem] bg-white p-8 shadow-2xl">
          <Image src="/brand/qr-code.png" alt="Scan to open the print kiosk" width={420} height={420} priority />
        </div>
        <p className="text-xl font-bold uppercase tracking-[0.3em] text-slate-400">Scan to upload &amp; print</p>
      </div>

      <div className="flex w-[420px] flex-col gap-4">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-blue-500">OXWAY Print Kiosk</p>
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
      </div>
    </div>
  );
}

export default KioskDisplayView;
