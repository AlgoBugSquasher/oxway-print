import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logDuration, withTiming } from "@/lib/server-timing";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves owner/staff account ids to emails for the jobs list's "who
 * created it" column (ROADMAP-style staff-print feature, §13) — print_jobs
 * only ever stores created_by_user_id (a bare uuid, see
 * print_jobs_admin_view), and auth.users itself is never queryable
 * directly from the browser (no PostgREST access to the auth schema), so
 * this small service-role-backed route is the only way to turn that id
 * into something a human reads. Gated to any signed-in admin (owner or
 * staff), same spirit as /api/admin/notify-provider — this never returns
 * anything more sensitive than the handful of pre-created staff emails
 * every admin here already knows about.
 *
 * Supabase's listUsers() is paginated (1000/page by default) — fine for
 * this prototype's handful of owner/staff accounts; would need real
 * pagination if this ever grew into a large user base, which the
 * dual-passcode prototype login (ROADMAP.md §26) was never designed for.
 */
export async function GET() {
  // Full getUser() kept here deliberately — this route hands back real
  // staff emails (PII), so unlike the pure "is there a session" gates
  // elsewhere, this one stays fully server-verified against the Auth
  // server on every call rather than switched to getClaims().
  const supabase = await createSupabaseServerClient();
  const { result: { data: { user } }, tookMs: getUserTookMs } = await withTiming(() => supabase.auth.getUser());
  logDuration("staff-users.getUser", getUserTookMs);
  const role = (user?.app_metadata as { role?: string } | undefined)?.role;
  if (!user || (role !== "owner" && role !== "staff")) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  try {
    const { result: { data, error }, tookMs: listUsersTookMs } = await withTiming(() => supabaseAdmin().auth.admin.listUsers());
    logDuration("staff-users.listUsers", listUsersTookMs);
    if (error) throw new Error(error.message);

    const staffUsers = data.users
      .filter((u) => {
        const r = (u.app_metadata as { role?: string } | undefined)?.role;
        return r === "owner" || r === "staff";
      })
      .map((u) => ({ id: u.id, email: u.email ?? u.id }));

    return NextResponse.json({ users: staffUsers });
  } catch (error) {
    console.error("admin/staff-users error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list staff users." },
      { status: 500 }
    );
  }
}
