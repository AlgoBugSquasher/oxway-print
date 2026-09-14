"use client";
// Renamed internal component — wrapped by page.tsx below in a Suspense boundary.

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabase";

type LiveStatus =
  | "idle"
  | "pending_payment"
  | "paid"
  | "printing"
  | "printed"
  | "print_failed"
  | "payment_failed"
  | "expired";

const STATUS_COPY: Record<LiveStatus, { headline: string; tone: "idle" | "progress" | "success" | "error" }> = {
  idle: { headline: "Scan the QR code to get started", tone: "idle" },
  pending_payment: { headline: "Waiting for payment...", tone: "progress" },
  paid: { headline: "Payment verified — starting print...", tone: "progress" },
  printing: { headline: "Printing your document...", tone: "progress" },
  printed: { headline: "Printed! Please collect your document.", tone: "success" },
  print_failed: { headline: "Print failed — please see staff.", tone: "error" },
  payment_failed: { headline: "Payment failed — please try again.", tone: "error" },
  expired: { headline: "Payment window expired.", tone: "error" },
};

// How long a finished/failed job keeps showing before the screen resets to idle.
const SETTLE_DISPLAY_MS = 20_000;
const POLL_INTERVAL_MS = 3000;

function KioskDisplayView() {
  const [status, setStatus] = useState<LiveStatus>("idle");
  // This same page is shared across every kiosk — ?k=<kiosk-id> in the URL
  // (matching this kiosk's own Chromium autostart command) scopes it to
  // just this machine's jobs. Defaults to the original single kiosk.
  const kioskId = useSearchParams().get("k") || "oxway_01";

  useEffect(() => {
    let cancelled = false;
    let settledAt: number | null = null;

    const poll = async () => {
      const { data, error } = await supabase
        .from("print_jobs")
        .select("status, updated_at")
        .eq("kiosk_id", kioskId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;
      if (error || !data) {
        setStatus("idle");
        return;
      }

      const isSettled = ["printed", "print_failed", "payment_failed", "expired"].includes(data.status);
      if (isSettled) {
        if (settledAt === null) settledAt = Date.now();
        if (Date.now() - settledAt > SETTLE_DISPLAY_MS) {
          setStatus("idle");
          return;
        }
      } else {
        settledAt = null;
      }

      setStatus(data.status as LiveStatus);
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [kioskId]);

  const copy = STATUS_COPY[status];
  const toneClass =
    copy.tone === "success"
      ? "text-emerald-400"
      : copy.tone === "error"
        ? "text-red-400"
        : copy.tone === "progress"
          ? "text-blue-400"
          : "text-slate-200";

  return (
    <div className="flex h-screen w-screen select-none items-center justify-center gap-16 bg-[#0b0f14] px-16 text-white">
      <div className="flex flex-col items-center gap-6">
        <div className="rounded-[2rem] bg-white p-8 shadow-2xl">
          {/* Place the QR PNG at public/kiosk-qr.png — generated for this site's live URL. */}
          <Image src="/kiosk-qr.png" alt="Scan to open the print kiosk" width={420} height={420} priority />
        </div>
        <p className="text-xl font-bold uppercase tracking-[0.3em] text-slate-400">Scan to upload &amp; print</p>
      </div>

      <div className="flex w-[420px] flex-col gap-4">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-blue-500">OXWAY Print Kiosk</p>
        <h1 className={`text-4xl font-black leading-tight transition-colors duration-500 ${toneClass}`}>
          {copy.headline}
        </h1>
        {status === "idle" && (
          <p className="text-lg text-slate-400">
            Open your camera, scan the code, upload your file, and pay — your document prints here automatically.
          </p>
        )}
      </div>
    </div>
  );
}

export default KioskDisplayView;
