"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Gift, IndianRupee, Printer, RefreshCw } from "lucide-react";
import { Segmented } from "@/components/print-basket-ui";
import { fetchJson } from "@/lib/fetch-json";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { formatBucketLabel, PERIOD_LABELS, summarizePeriodBreakdown } from "@/lib/admin/period-stats";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import type { AdminJobRow, AdminKioskCommandRow, AdminKioskRow, OverviewPeriod, PeriodBreakdownRow } from "@/lib/admin/types";
import KioskCard from "./kiosk-card";
import LiveIndicator from "./live-indicator";
import StatusBadge from "./status-badge";

const PERIOD_OPTIONS: OverviewPeriod[] = ["today", "week", "month", "year"];

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
  // Default TODAY per task requirement — switching persists for as long as
  // this page stays mounted (plain React state, untouched by background
  // refresh ticks, which only ever re-fetch using whatever `period` already
  // is).
  const [period, setPeriod] = useState<OverviewPeriod>("today");
  const [periodRows, setPeriodRows] = useState<PeriodBreakdownRow[]>([]);
  // Server-only env var (lib/config.ts) — fetched via a small authenticated
  // route rather than imported directly, same reasoning kiosk-card.tsx
  // already documents for why client code in this codebase never pulls
  // that module in. Defaults to true (assume console/not-sending) so the
  // "messages are only logged" warning fails toward being shown rather than
  // silently hidden before this resolves.
  const [notifyProviderIsConsole, setNotifyProviderIsConsole] = useState(true);
  // Resolves a refill_events.by_user_id to a readable email for
  // kiosk-card.tsx's refill history list — same route/pattern jobs/page.tsx
  // already uses for print_jobs.created_by_user_id. Fetched once here
  // (rather than once per kiosk card) and passed down.
  const [staffEmailsById, setStaffEmailsById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetchJson<{ users: { id: string; email: string }[] }>("/api/admin/staff-users")
      .then((result) => setStaffEmailsById(new Map(result.users.map((u) => [u.id, u.email]))))
      .catch(() => {
        // Non-fatal — see jobs/page.tsx's identical comment.
      });
  }, []);

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
    const [kiosksResult, jobsResult, commandsResult, notifyProviderResult, periodResult] = await Promise.all([
      supabase.from("kiosk_status_admin_view").select("*"),
      supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(15),
      supabase.from("kiosk_commands_admin_view").select("*").order("requested_at", { ascending: false }).limit(50),
      fetchJson<{ provider: "console" | "msg91" }>("/api/admin/notify-provider").catch(() => ({ provider: "console" as const })),
      // p_kiosk_id omitted (null) — every kiosk combined, same "whole
      // business" framing the existing all-time total_revenue card below
      // already uses.
      supabase.rpc("get_kiosk_period_breakdown", { p_period: period }),
    ]);
    if (kiosksResult.error) throw new Error(kiosksResult.error.message);
    if (jobsResult.error) throw new Error(jobsResult.error.message);
    if (commandsResult.error) throw new Error(commandsResult.error.message);
    if (periodResult.error) throw new Error(periodResult.error.message);
    setKiosks((kiosksResult.data as AdminKioskRow[]) ?? []);
    setRecentJobs((jobsResult.data as AdminJobRow[]) ?? []);
    setLatestCommands(latestCommandPerKiosk((commandsResult.data as AdminKioskCommandRow[]) ?? []));
    setNotifyProviderIsConsole(notifyProviderResult.provider !== "msg91");
    setPeriodRows((periodResult.data as PeriodBreakdownRow[]) ?? []);
  }, [period]);

  // See lib/hooks/useAutoRefresh.ts for the shared polling behavior (every
  // admin page under /admin uses this same hook) — 5s normal cadence,
  // paused while any kiosk card is busy or the tab is hidden, backing off
  // to 15s after repeated failures.
  const { isRefreshing, lastUpdatedAt, error, refreshNow } = useAutoRefresh(fetchData, {
    isPaused: () => busyKioskIdsRef.current.size > 0,
  });
  const isLoading = isRefreshing && lastUpdatedAt === null;

  // Switching the period selector should change the figures immediately,
  // not wait for the next background tick — but skip this on the very
  // first render, since useAutoRefresh's own initial load already covers
  // it (this would otherwise double-fetch on mount).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    void refreshNow();
  }, [period, refreshNow]);

  const totalRevenueKnown = kiosks.some((kiosk) => kiosk.total_revenue !== null);
  const totalRevenue = kiosks.reduce((sum, kiosk) => sum + (kiosk.total_revenue ?? 0), 0);
  const totalLifetimePrints = kiosks.reduce((sum, kiosk) => sum + kiosk.total_lifetime_prints, 0);

  const totals = summarizePeriodBreakdown(periodRows);
  const moneyKnown = totals.revenue !== null;

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

      <Segmented
        value={period}
        options={PERIOD_OPTIONS}
        labels={PERIOD_OPTIONS.map((option) => PERIOD_LABELS[option])}
        onChange={(value) => setPeriod(value as OverviewPeriod)}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {moneyKnown && (
          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-blue-600"><IndianRupee size={13} /> Revenue — {PERIOD_LABELS[period]}</div>
            <p className="mt-1 text-3xl font-black text-blue-700">&#8377;{(totals.revenue ?? 0).toFixed(2)}</p>
            {(totals.refundAmount ?? 0) > 0 && (
              <p className="mt-1 text-xs font-medium text-slate-500">
                &#8377;{(totals.refundAmount ?? 0).toFixed(2)} refunded ({totals.refundCount} {totals.refundCount === 1 ? "job" : "jobs"})
              </p>
            )}
          </div>
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Pages printed</div>
          <p className="mt-1 text-3xl font-black">{totals.pagesPrinted}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Prints completed</div>
          <p className="mt-1 text-3xl font-black">{totals.printsCompleted}</p>
        </div>
        {totals.freePrintCount > 0 && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-emerald-700"><Gift size={13} /> Free staff prints</div>
            <p className="mt-1 text-lg font-black text-emerald-800">
              {totals.freePrintCount} {totals.freePrintCount === 1 ? "job" : "jobs"}, {totals.freePrintPages} {totals.freePrintPages === 1 ? "page" : "pages"}
              {moneyKnown && totals.freePrintWaivedAmount !== null ? `, ₹${totals.freePrintWaivedAmount.toFixed(2)} waived` : ""}
            </p>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex gap-2">
          {periodRows.map((row) => (
            <div key={row.bucket_start} className="flex min-w-[68px] flex-col items-center gap-1 rounded-xl bg-slate-50 px-2.5 py-2.5 text-center">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{formatBucketLabel(row.bucket_start, period)}</span>
              {moneyKnown && <span className="text-xs font-black text-blue-700">&#8377;{(row.revenue ?? 0).toFixed(0)}</span>}
              <span className="text-[11px] font-bold text-slate-500">{row.pages_printed}p</span>
            </div>
          ))}
          {periodRows.length === 0 && !isLoading && <p className="py-2 text-sm text-slate-400">No activity yet for {PERIOD_LABELS[period].toLowerCase()}.</p>}
        </div>
      </div>

      <p className="text-xs text-slate-400">
        {totalRevenueKnown && <>All time: &#8377;{totalRevenue.toFixed(2)}, </>}
        {totalLifetimePrints} {totalLifetimePrints === 1 ? "print" : "prints"}
      </p>

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
              staffEmailsById={staffEmailsById}
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
