import { NextResponse } from "next/server";
import { recordCompletedPrint } from "@/lib/kiosk-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual/external entry point for logging a completed print to Supabase.
 * The Pi's print agent (print-agent/index.ts) already calls
 * recordCompletedPrint() directly once a job finishes printing — this route
 * stays around for any other caller.
 */
export async function POST(request: Request) {
  try {
    const { pagesPrinted, amount, colorMode } = await request.json();
    if (!Number.isFinite(pagesPrinted) || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "pagesPrinted and amount must be numbers" }, { status: 400 });
    }

    const counters = await recordCompletedPrint({ pagesPrinted, amount, colorMode: Boolean(colorMode) });
    if (!counters) return NextResponse.json({ error: "Kiosk record not found" }, { status: 404 });

    return NextResponse.json({ success: true, trayPages: counters.trayPages, cartridgePages: counters.cartridgePages });
  } catch {
    return NextResponse.json({ error: "Failed to update kiosk status" }, { status: 500 });
  }
}
