"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AdminRole } from "./types";

/**
 * The signed-in admin's role/email, computed exactly once per navigation by
 * the server (app/admin/(dashboard)/layout.tsx) and handed down via
 * context — so jobs/page.tsx and pricing/page.tsx (which both only need the
 * role to decide which buttons to show, never to authorize anything
 * themselves, see lib/admin/actions.ts's own comment) don't each re-fetch
 * it with their own supabase.auth.getUser() call on every mount AND on
 * every 5s auto-refresh tick. This is purely a UI convenience: the real
 * authorization boundary is still re-checked server-side by every RPC/route
 * those pages call, exactly as before — this context is never consulted by
 * any of them.
 */
const AdminRoleContext = createContext<AdminRole>("none");

export function AdminRoleProvider({ role, children }: { role: AdminRole; children: ReactNode }) {
  return <AdminRoleContext.Provider value={role}>{children}</AdminRoleContext.Provider>;
}

export function useAdminRole(): AdminRole {
  return useContext(AdminRoleContext);
}
