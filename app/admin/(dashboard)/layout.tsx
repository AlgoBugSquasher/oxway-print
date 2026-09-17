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
 */
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
