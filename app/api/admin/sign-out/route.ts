import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign-out, moved server-side (was previously a direct
 * supabase.auth.signOut() call from the browser) so it can be audited —
 * same reasoning as app/api/admin/login's own docstring. Reads the
 * signed-in user BEFORE signing out (there's nothing left to read
 * afterward), so a sign-out with no active session at all (a stale
 * client retrying, a double-click) just no-ops rather than logging a
 * fabricated event for nobody.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase.auth.signOut();

    if (user) {
      const role = (user.app_metadata as { role?: string } | undefined)?.role ?? "none";
      await logAudit({
        action: "sign_out",
        actorUserId: user.id,
        actorRole: role,
        ip: getClientIp(request),
        userAgent: request.headers.get("user-agent"),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("admin/sign-out error:", error);
    return NextResponse.json({ error: "Could not sign out." }, { status: 500 });
  }
}
