import { NextResponse } from "next/server";
import { checkLowSupplyAlerts } from "@/lib/alerts/low-supply";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Meant to be hit hourly by an external scheduler, same as
 * app/api/cron/cleanup-jobs and check-kiosk-heartbeats — see CRON_SETUP.md.
 * Also run after each completed print, see app/api/agent/check-low-supply.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const { data: kiosks, error } = await supabaseAdmin().from("kiosk_status").select("id");
    if (error) throw new Error(error.message);

    for (const kiosk of kiosks ?? []) {
      await checkLowSupplyAlerts(kiosk.id as string);
    }

    return NextResponse.json({ checked: kiosks?.length ?? 0 });
  } catch (error) {
    console.error("check-low-supply error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not check low supply." },
      { status: 500 }
    );
  }
}
