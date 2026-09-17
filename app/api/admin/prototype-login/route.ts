import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PasscodeMatch {
  email: string;
  password: string;
}

/**
 * Maps a passcode to a real pre-created account's real credentials, both
 * read from server-only env vars — never exposed to the browser. See
 * ROADMAP.md §26: this route's whole job is to turn a passcode into a
 * genuine signInWithPassword() call below, not to invent a second,
 * weaker auth path alongside the real one.
 */
function matchPasscode(passcode: string): PasscodeMatch | null {
  const ownerPasscode = process.env.PROTOTYPE_OWNER_PASSCODE;
  if (ownerPasscode && passcode === ownerPasscode) {
    const email = process.env.PROTOTYPE_OWNER_EMAIL;
    const password = process.env.PROTOTYPE_OWNER_PASSWORD;
    if (email && password) return { email, password };
  }

  const staffPasscode = process.env.PROTOTYPE_STAFF_PASSCODE;
  if (staffPasscode && passcode === staffPasscode) {
    const email = process.env.PROTOTYPE_STAFF_EMAIL;
    const password = process.env.PROTOTYPE_STAFF_PASSWORD;
    if (email && password) return { email, password };
  }

  return null;
}

export async function POST(request: Request) {
  try {
    // Server-side gate, independent of the client-side NEXT_PUBLIC flag that
    // hides the UI — without this, a visitor who finds the route directly
    // could still use it even with the passcode form hidden.
    if (process.env.NEXT_PUBLIC_PROTOTYPE_MODE !== "true") {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as { passcode?: string } | null;
    const passcode = body?.passcode?.trim();
    if (!passcode) return NextResponse.json({ error: "Missing passcode." }, { status: 400 });

    const match = matchPasscode(passcode);
    if (!match) return NextResponse.json({ error: "Unrecognized passcode." }, { status: 401 });

    // The real sign-in — identical to what the email/password form on
    // /admin/login does, just with credentials resolved from the passcode
    // instead of typed directly. Sets the same session cookie, so RLS/roles
    // apply exactly as they would for a normal login.
    const supabase = await createSupabaseServerClient();
    const { error: signInError } = await supabase.auth.signInWithPassword(match);
    if (signInError) return NextResponse.json({ error: signInError.message }, { status: 401 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("prototype-login error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not sign in." },
      { status: 500 }
    );
  }
}
