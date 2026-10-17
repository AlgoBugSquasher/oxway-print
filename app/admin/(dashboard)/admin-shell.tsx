"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ClipboardList, Gift, IndianRupee, LayoutDashboard, ListOrdered, LogOut, Tags } from "lucide-react";
import BrandWordmark from "@/components/BrandWordmark";
import { AdminRoleProvider } from "@/lib/admin/role-context";
import { fetchJson } from "@/lib/fetch-json";
import type { AdminRole } from "@/lib/admin/types";

export default function AdminShell({ children, email, role }: { children: ReactNode; email: string; role: AdminRole }) {
  const pathname = usePathname();
  const router = useRouter();

  // Server-side now (app/api/admin/sign-out) — not a direct
  // supabase.auth.signOut() call from here — so it can be audited; see
  // that route's own docstring.
  const handleSignOut = async () => {
    await fetchJson("/api/admin/sign-out", { method: "POST" }).catch(() => {
      // Best-effort — even if the audit write or the route itself fails,
      // the admin still expects to land back on the login page.
    });
    router.push("/admin/login");
    router.refresh();
  };

  const navItems = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/jobs", label: "Jobs", icon: ListOrdered },
    // Free printing — owner AND staff, same two roles app/api/staff-print's
    // own server-side check allows (never gated to owner-only like Pricing
    // below).
    ...(role === "owner" || role === "staff" ? [{ href: "/admin/print", label: "Print", icon: Gift }] : []),
    // Owner-only — approving a refund is real money movement, and
    // print_jobs_admin_view already masks every refund_* column to null
    // for staff, so this page would only ever render an empty/useless
    // queue for them anyway even if they found the URL directly.
    ...(role === "owner" ? [{ href: "/admin/refunds", label: "Refunds", icon: IndianRupee }] : []),
    // Pricing is revenue-adjacent — owner only, same as the rest of §4 in the write-permissions table.
    ...(role === "owner" ? [{ href: "/admin/pricing", label: "Pricing", icon: Tags }] : []),
    // Audit log — owner only (the RLS policy backing it refuses staff/anon
    // regardless, this just avoids showing a nav link to a page that would
    // only ever render empty/403 for them).
    ...(role === "owner" ? [{ href: "/admin/audit", label: "Audit log", icon: ClipboardList }] : []),
  ];

  return (
    <div className="min-h-screen bg-[#f4f6f8] text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-[#f4f6f8]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex flex-wrap items-center gap-6">
            <Link href="/" className="block">
              <div className="flex items-center gap-2">
                <BrandWordmark className="h-6" />
                <span className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Admin</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{email} &middot; {role}</p>
            </Link>
            <nav className="flex items-center gap-1">
              {navItems.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition ${pathname === href ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  <Icon size={14} /> {label}
                </Link>
              ))}
            </nav>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
        <AdminRoleProvider role={role}>{children}</AdminRoleProvider>
      </main>
    </div>
  );
}
