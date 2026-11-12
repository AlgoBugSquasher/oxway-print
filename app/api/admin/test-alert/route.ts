import { NextResponse } from "next/server";
import { sendTestAlert } from "@/lib/alerts";
import { routeErrorResponse } from "@/lib/errors";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return NextResponse.json({ error: "Not authorized." }, { status: 403 });

    const body = await request.json().catch(() => null);
    const kioskId = body?.kioskId;
    if (typeof kioskId !== "string" || !kioskId) return NextResponse.json({ error: "Missing kioskId." }, { status: 400 });

    const results = await sendTestAlert(kioskId);
    return NextResponse.json({ results });
  } catch (error) {
    return await routeErrorResponse(error, { area: "admin", route: "admin/test-alert" });
  }
}
