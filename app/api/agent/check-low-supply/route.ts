import { NextResponse } from "next/server";
import { checkLowSupplyAlerts } from "@/lib/alerts/low-supply";
import { AGENT_API_SECRET } from "@/lib/config";
import { routeErrorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Called by the print agent right after a completed print, same Bearer AGENT_API_SECRET pattern as app/api/agent/notify. */
export async function POST(request: Request) {
  if (!AGENT_API_SECRET) return NextResponse.json({ error: "AGENT_API_SECRET is not configured." }, { status: 500 });
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${AGENT_API_SECRET}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let kioskId: string | undefined;
  try {
    ({ kioskId } = (await request.json()) as { kioskId?: string });
    if (!kioskId) return NextResponse.json({ error: "Missing kioskId" }, { status: 400 });

    await checkLowSupplyAlerts(kioskId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return await routeErrorResponse(error, { area: "cron", route: "agent/check-low-supply", kioskId });
  }
}
