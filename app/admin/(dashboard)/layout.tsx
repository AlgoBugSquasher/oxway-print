import type { ReactNode } from "react";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminRole } from "@/lib/admin/types";
import AdminShell from "./admin-shell";

/**
 * Wraps every route under /admin except /admin/login (that page lives
 * outside this route group on purpose — this layout assumes a signed-in
 * user, and login obviously can't). proxy.ts (Next.js 16's renamed
 * middleware convention) already guarantees a session exists for anything
 * this layout renders.
 *
 * force-dynamic is required here, not optional: createSupabaseServerClient
 * checks its env vars and throws BEFORE it ever calls cookies() (see that
 * function), so Next never gets the runtime signal — a call to a dynamic
 * API like cookies() — it normally uses to auto-detect that a route can't
 * be statically prerendered. Without this export, `next build` tries to
 * prerender /admin anyway; if the Supabase env vars aren't present in the
 * build environment for any reason, that throw happens during the build
 * itself and fails the entire deployment, not just a real request. Every
 * API route that calls createSupabaseServerClient already sets this same
 * export — this layout was the one place that didn't.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const role = ((user?.app_metadata as { role?: AdminRole } | undefined)?.role) ?? "none";

  return (
    <AdminShell email={user?.email ?? ""} role={role}>
      {children}
    </AdminShell>
  );
}
