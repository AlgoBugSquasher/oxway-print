import { jsonNoStore } from "@/lib/api-response";
import { getKioskTrayClearedAt } from "@/lib/kiosk-stats";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { countUncollectedPrintedJobs } from "@/lib/store";

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
  refund_status: string | null;
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

    // print_blocked/interrupted included alongside printing — the job is
    // still the one physically at the printer (or was, for interrupted),
    // just not actively "printing" this instant; the screen shows a
    // different message for each below, but each is still "current," not
    // simply absent. An interrupted job naturally stops showing here the
    // moment a NEWER job starts printing (this query is ordered by
    // updated_at desc) — it never gets stuck on screen once something
    // else is actually happening.
    const { data: printingRows, error: printingError } = await supabase
      .from("print_jobs")
      .select("ticket_number, status, updated_at, refund_status")
      .eq("kiosk_id", kioskId)
      .in("status", ["printing", "print_blocked", "interrupted"])
      .order("updated_at", { ascending: false })
      .limit(1);
    if (printingError) throw new Error(`Could not load current job: ${printingError.message}`);

    let current: { ticketNumber: number; status: "printing" | "print_blocked" | "interrupted" | "printed" | "print_failed"; refundStatus?: string | null } | null = null;
    const printingRow = (printingRows as KioskDisplayJobRow[])[0];
    if (printingRow?.ticket_number != null) {
      current = { ticketNumber: printingRow.ticket_number, status: printingRow.status as "printing" | "print_blocked" | "interrupted" };
    } else {
      const settleCutoff = new Date(Date.now() - SETTLE_WINDOW_SECONDS * 1000).toISOString();
      const { data: settledRows, error: settledError } = await supabase
        .from("print_jobs")
        .select("ticket_number, status, updated_at, refund_status")
        .eq("kiosk_id", kioskId)
        .in("status", ["printed", "print_failed"])
        .gte("updated_at", settleCutoff)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (settledError) throw new Error(`Could not load recently-settled job: ${settledError.message}`);
      const settledRow = (settledRows as KioskDisplayJobRow[])[0];
      if (settledRow?.ticket_number != null) {
        current = {
          ticketNumber: settledRow.ticket_number,
          status: settledRow.status as "printed" | "print_failed",
          refundStatus: settledRow.status === "print_failed" ? settledRow.refund_status : undefined,
        };
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

    const trayClearedAt = await getKioskTrayClearedAt(kioskId);
    const trayCount = await countUncollectedPrintedJobs(kioskId, trayClearedAt);

    return jsonNoStore({ current, upcoming, trayCount });
  } catch (error) {
    console.error("kiosk-display error:", error);
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Could not load kiosk display data." },
      { status: 500 }
    );
  }
}
