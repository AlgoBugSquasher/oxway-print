import { NextResponse } from "next/server";
import { AGENT_API_SECRET } from "@/lib/config";
import { checkLowSupplyAlerts } from "@/lib/alerts/low-supply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Called by the print agent right after a completed print, same Bearer AGENT_API_SECRET pattern as app/api/agent/notify. */
export async function POST(request: Request) {
  if (!AGENT_API_SECRET) return NextResponse.json({ error: "AGENT_API_SECRET is not configured." }, { status: 500 });
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${AGENT_API_SECRET}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { kioskId } = (await request.json()) as { kioskId?: string };
    if (!kioskId) return NextResponse.json({ error: "Missing kioskId" }, { status: 400 });

    await checkLowSupplyAlerts(kioskId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("agent/check-low-supply error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not check low supply." }, { status: 500 });
  }
}
