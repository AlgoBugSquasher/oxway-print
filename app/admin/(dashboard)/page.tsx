"use client";

import { useEffect, useState } from "react";
import { IndianRupee, Printer, RefreshCw } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import type { AdminJobRow, AdminKioskRow } from "@/lib/admin/types";
import KioskCard from "./kiosk-card";
import StatusBadge from "./status-badge";

export default function AdminOverviewPage() {
  const [kiosks, setKiosks] = useState<AdminKioskRow[]>([]);
  const [recentJobs, setRecentJobs] = useState<AdminJobRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setIsLoading(true);
    setError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const [kiosksResult, jobsResult] = await Promise.all([
        supabase.from("kiosk_status_admin_view").select("*"),
        supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(15),
      ]);
      if (kiosksResult.error) throw new Error(kiosksResult.error.message);
      if (jobsResult.error) throw new Error(jobsResult.error.message);
      setKiosks((kiosksResult.data as AdminKioskRow[]) ?? []);
      setRecentJobs((jobsResult.data as AdminJobRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard data.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Classic fetch-on-mount, reusing `load` so the refresh button and
    // action callbacks below share the same fetch logic — not the
    // derived-state/anti-pattern this compiler rule is really aimed at.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  const totalRevenueKnown = kiosks.some((kiosk) => kiosk.total_revenue !== null);
  const totalRevenue = kiosks.reduce((sum, kiosk) => sum + (kiosk.total_revenue ?? 0), 0);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Overview</p>
          <h1 className="mt-1 text-2xl font-black">Kiosk health &amp; recent activity</h1>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:border-slate-300">
          <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}

      {totalRevenueKnown && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-blue-600"><IndianRupee size={13} /> Total revenue</div>
          <p className="mt-1 text-3xl font-black text-blue-700">&#8377;{totalRevenue.toFixed(2)}</p>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-black uppercase tracking-[0.15em] text-slate-500">Kiosks</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kiosks.map((kiosk) => <KioskCard key={kiosk.id} kiosk={kiosk} onChanged={() => void load()} />)}
          {!isLoading && kiosks.length === 0 && <p className="text-sm text-slate-500">No kiosk_status rows yet — see SUPABASE_SETUP.md.</p>}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-black uppercase tracking-[0.15em] text-slate-500">Recent jobs</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-bold">File</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 font-bold">Kiosk</th>
                {totalRevenueKnown && <th className="px-4 py-3 font-bold">Price</th>}
                <th className="px-4 py-3 font-bold">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((job) => (
                <tr key={job.id} className="border-b border-slate-50 last:border-0">
                  <td className="max-w-[220px] truncate px-4 py-3">{job.file_name}</td>
                  <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                  <td className="px-4 py-3 text-slate-500">{job.kiosk_id}</td>
                  {totalRevenueKnown && <td className="px-4 py-3">{job.total_price !== null ? `₹${Number(job.total_price).toFixed(2)}` : "—"}</td>}
                  <td className="px-4 py-3 text-slate-500">{new Date(job.created_at).toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && recentJobs.length === 0 && <p className="p-4 text-sm text-slate-500">No jobs yet.</p>}
        </div>
      </section>

      {isLoading && <p className="flex items-center gap-2 text-sm text-slate-500"><Printer size={14} className="animate-pulse" /> Loading...</p>}
    </div>
  );
}
