import { NextResponse } from "next/server";
import { logAudit, maskEmail } from "@/lib/audit";
import { getClientIp, isWithinLoginRateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Always the exact same text regardless of why sign-in failed (unknown
// email, wrong password, unconfirmed account, ...) — account-hardening
// requirement #1's "generic error messages that don't reveal whether an
// account exists." Never relays Supabase's own error message to the
// client: that text is reasonably generic today ("Invalid login
// credentials") but this route doesn't want to depend on an external
// service's exact wording staying that way forever.
const GENERIC_LOGIN_ERROR = "Invalid email or password.";

/**
 * The real email/password sign-in, moved server-side (was previously a
 * direct supabase.auth.signInWithPassword() call from the browser — see
 * app/admin/login/page.tsx's own history) for two reasons that both need
 * a server checkpoint to exist at all: this is the one place "login
 * success"/"login failed" can be audited (requirement #1 of the audit-log
 * task — there is no other server code anywhere in this login path), and
 * the one place a login-attempt rate limit can actually be enforced
 * (account-hardening requirement #1) — a client-side check is trivially
 * bypassable by anyone not using the real browser UI.
 *
 * Sets the exact same session cookie createSupabaseServerClient's
 * signInWithPassword always does (via @supabase/ssr) — RLS/roles apply
 * identically to the old client-direct call; nothing about what a signed-in
 * admin can do changed, only where the sign-in itself happens.
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent");

  try {
    const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
    const email = body?.email?.trim();
    const password = body?.password;
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    // Checked per-email AND per-IP independently — see lib/rate-limit.ts's
    // own comment on why both. Fails open (never blocks a request just
    // because the rate limiter itself is unavailable), so this is abuse
    // mitigation, not the real security boundary.
    const [withinEmailLimit, withinIpLimit] = await Promise.all([
      isWithinLoginRateLimit(email.toLowerCase()),
      isWithinLoginRateLimit(ip),
    ]);
    if (!withinEmailLimit || !withinIpLimit) {
      return NextResponse.json({ error: "Too many sign-in attempts. Please wait a minute and try again." }, { status: 429 });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      await logAudit({
        action: "login_failed",
        details: { emailAttempted: maskEmail(email) },
        ip,
        userAgent,
      });
      return NextResponse.json({ error: GENERIC_LOGIN_ERROR }, { status: 401 });
    }

    const role = (data.user.app_metadata as { role?: string } | undefined)?.role ?? "none";
    await logAudit({
      action: "login_success",
      actorUserId: data.user.id,
      actorRole: role,
      ip,
      userAgent,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("admin/login error:", error);
    return NextResponse.json({ error: "Could not sign in." }, { status: 500 });
  }
}
