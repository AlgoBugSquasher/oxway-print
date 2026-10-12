"use client";

import { useCallback, useRef, useState } from "react";
import { IndianRupee, Printer, RefreshCw } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import type { AdminJobRow, AdminKioskCommandRow, AdminKioskRow } from "@/lib/admin/types";
import KioskCard from "./kiosk-card";
import LiveIndicator from "./live-indicator";
import StatusBadge from "./status-badge";

/**
 * kiosk_commands_admin_view has one row per request ever made, not one per
 * kiosk — this reduces it to "the most recent command for each kiosk,"
 * which is all kiosk-card.tsx needs (to disable its buttons while
 * pending/running, and to show the last result). Ordering by requested_at
 * descending before this runs means the first row seen per kiosk_id is
 * already the latest.
 */
function latestCommandPerKiosk(commands: AdminKioskCommandRow[]): Map<string, AdminKioskCommandRow> {
  const latest = new Map<string, AdminKioskCommandRow>();
  for (const command of commands) {
    if (!latest.has(command.kiosk_id)) latest.set(command.kiosk_id, command);
  }
  return latest;
}

export default function AdminOverviewPage() {
  const [kiosks, setKiosks] = useState<AdminKioskRow[]>([]);
  const [recentJobs, setRecentJobs] = useState<AdminJobRow[]>([]);
  const [latestCommands, setLatestCommands] = useState<Map<string, AdminKioskCommandRow>>(new Map());
  // Server-only env var (lib/config.ts) — fetched via a small authenticated
  // route rather than imported directly, same reasoning kiosk-card.tsx
  // already documents for why client code in this codebase never pulls
  // that module in. Defaults to true (assume console/not-sending) so the
  // "messages are only logged" warning fails toward being shown rather than
  // silently hidden before this resolves.
  const [notifyProviderIsConsole, setNotifyProviderIsConsole] = useState(true);

  // Which kiosk cards currently have an edit/save/command in flight — a
  // Set kept in a ref (not state) since it only needs to be read inside
  // useAutoRefresh's isPaused callback, never rendered itself; each
  // KioskCard reports its own busy state in via onBusyChange below so a
  // background refresh never quietly overwrites counters someone's
  // mid-typing or a toggle that's mid-save (task requirement #5).
  const busyKioskIdsRef = useRef<Set<string>>(new Set());
  const setKioskBusy = useCallback((kioskId: string, isBusy: boolean) => {
    if (isBusy) busyKioskIdsRef.current.add(kioskId);
    else busyKioskIdsRef.current.delete(kioskId);
  }, []);

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const [kiosksResult, jobsResult, commandsResult, notifyProviderResult] = await Promise.all([
      supabase.from("kiosk_status_admin_view").select("*"),
      supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(15),
      supabase.from("kiosk_commands_admin_view").select("*").order("requested_at", { ascending: false }).limit(50),
      fetchJson<{ provider: "console" | "msg91" }>("/api/admin/notify-provider").catch(() => ({ provider: "console" as const })),
    ]);
    if (kiosksResult.error) throw new Error(kiosksResult.error.message);
    if (jobsResult.error) throw new Error(jobsResult.error.message);
    if (commandsResult.error) throw new Error(commandsResult.error.message);
    setKiosks((kiosksResult.data as AdminKioskRow[]) ?? []);
    setRecentJobs((jobsResult.data as AdminJobRow[]) ?? []);
    setLatestCommands(latestCommandPerKiosk((commandsResult.data as AdminKioskCommandRow[]) ?? []));
    setNotifyProviderIsConsole(notifyProviderResult.provider !== "msg91");
  }, []);

  // See lib/hooks/useAutoRefresh.ts for the shared polling behavior (every
  // admin page under /admin uses this same hook) — 5s normal cadence,
  // paused while any kiosk card is busy or the tab is hidden, backing off
  // to 15s after repeated failures.
  const { isRefreshing, lastUpdatedAt, error, refreshNow } = useAutoRefresh(fetchData, {
    isPaused: () => busyKioskIdsRef.current.size > 0,
  });
  const isLoading = isRefreshing && lastUpdatedAt === null;

  const totalRevenueKnown = kiosks.some((kiosk) => kiosk.total_revenue !== null);
  const totalRevenue = kiosks.reduce((sum, kiosk) => sum + (kiosk.total_revenue ?? 0), 0);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Overview</p>
          <h1 className="mt-1 text-2xl font-black">Kiosk health &amp; recent activity</h1>
        </div>
        <div className="flex items-center gap-3">
          <LiveIndicator isRefreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />
          <button onClick={() => void refreshNow()} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:border-slate-300">
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
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
          {kiosks.map((kiosk) => (
            <KioskCard
              key={kiosk.id}
              kiosk={kiosk}
              latestCommand={latestCommands.get(kiosk.id) ?? null}
              isOwner={totalRevenueKnown}
              notifyProviderIsConsole={notifyProviderIsConsole}
              onBusyChange={(isBusy) => setKioskBusy(kiosk.id, isBusy)}
              onChanged={() => void refreshNow()}
            />
          ))}
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
