import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long a just-finished job keeps showing as "current" before the screen
// falls back to idle/upcoming-only — gives the printer a moment to actually
// eject the page before the screen looks like nothing happened. Mirrors the
// same idea the original repo's single-job kiosk-display used.
const SETTLE_WINDOW_SECONDS = 20;

interface KioskDisplayJobRow {
  ticket_number: number | null;
  status: string;
  updated_at: string;
}

/**
 * ROADMAP.md §23 — narrow, unauthenticated-safe read for the screen sitting
 * next to the printer. Deliberately NOT a client-side Supabase query against
 * a public view/policy (see the discussion this was chosen over in the
 * planning pass) — this route uses the service-role key server-side and
 * returns only ticket numbers and status, nothing from print_jobs that's
 * remotely sensitive (no phone, price, file name, settings).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kioskId: string }> }) {
  try {
    const { kioskId } = await params;
    const supabase = supabaseAdmin();

    const { data: printingRows, error: printingError } = await supabase
      .from("print_jobs")
      .select("ticket_number, status, updated_at")
      .eq("kiosk_id", kioskId)
      .eq("status", "printing")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (printingError) throw new Error(`Could not load current job: ${printingError.message}`);

    let current: { ticketNumber: number; status: "printing" | "printed" } | null = null;
    const printingRow = (printingRows as KioskDisplayJobRow[])[0];
    if (printingRow?.ticket_number != null) {
      current = { ticketNumber: printingRow.ticket_number, status: "printing" };
    } else {
      // Nothing actively printing — check whether the most recent finish is
      // still within the settle window, so the screen doesn't flip straight
      // to "upcoming only" the instant CUPS reports the job done.
      const settleCutoff = new Date(Date.now() - SETTLE_WINDOW_SECONDS * 1000).toISOString();
      const { data: printedRows, error: printedError } = await supabase
        .from("print_jobs")
        .select("ticket_number, status, updated_at")
        .eq("kiosk_id", kioskId)
        .eq("status", "printed")
        .gte("updated_at", settleCutoff)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (printedError) throw new Error(`Could not load recently-printed job: ${printedError.message}`);
      const printedRow = (printedRows as KioskDisplayJobRow[])[0];
      if (printedRow?.ticket_number != null) {
        current = { ticketNumber: printedRow.ticket_number, status: "printed" };
      }
    }

    const { data: upcomingRows, error: upcomingError } = await supabase
      .from("print_jobs")
      .select("ticket_number")
      .eq("kiosk_id", kioskId)
      .eq("status", "paid")
      .order("created_at", { ascending: true })
      .limit(3);
    if (upcomingError) throw new Error(`Could not load upcoming jobs: ${upcomingError.message}`);

    const upcoming = (upcomingRows as { ticket_number: number | null }[])
      .filter((row) => row.ticket_number != null)
      .map((row) => ({ ticketNumber: row.ticket_number as number }));

    return NextResponse.json({ current, upcoming });
  } catch (error) {
    console.error("kiosk-display error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load kiosk display data." },
      { status: 500 }
    );
  }
}
