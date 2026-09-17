"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, ListOrdered, LogOut, Tags } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import type { AdminRole } from "@/lib/admin/types";

export default function AdminShell({ children, email, role }: { children: ReactNode; email: string; role: AdminRole }) {
  const pathname = usePathname();
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/admin/login");
    router.refresh();
  };

  const navItems = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/jobs", label: "Jobs", icon: ListOrdered },
    // Pricing is revenue-adjacent — owner only, same as the rest of §4 in the write-permissions table.
    ...(role === "owner" ? [{ href: "/admin/pricing", label: "Pricing", icon: Tags }] : []),
  ];

  return (
    <div className="min-h-screen bg-[#f4f6f8] text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-[#f4f6f8]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex flex-wrap items-center gap-6">
            <Link href="/" className="block">
              <p className="text-sm font-black tracking-[0.16em] text-blue-600">OXWAY ADMIN</p>
              <p className="text-xs text-slate-500">{email} &middot; {role}</p>
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
      <main className="mx-auto max-w-6xl px-5 py-8 lg:px-8">{children}</main>
    </div>
  );
}
