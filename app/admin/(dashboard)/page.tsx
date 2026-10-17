"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Gift, IndianRupee, Printer, RefreshCw, RotateCcw } from "lucide-react";
import { Segmented } from "@/components/print-basket-ui";
import { fetchJson } from "@/lib/fetch-json";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { formatBucketLabel, PERIOD_LABELS, summarizePeriodBreakdown } from "@/lib/admin/period-stats";
import { colorShare, findBusiestWeekday, findDayExtremes, findPeakHour, formatHourLabel, hourlyBarHeights, WEEKDAY_LABELS } from "@/lib/admin/sales-stats";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import type {
  AdminJobRow,
  AdminKioskCommandRow,
  AdminKioskRow,
  AlertRow,
  DailyPatternRow,
  HourlyPatternRow,
  OverviewPeriod,
  PendingRefundSummary,
  PeriodBreakdownRow,
  SalesSummaryRow,
  WeekdayPatternRow,
} from "@/lib/admin/types";
import KioskCard from "./kiosk-card";
import LiveIndicator from "./live-indicator";
import StatusBadge from "./status-badge";

const PERIOD_OPTIONS: OverviewPeriod[] = ["today", "week", "month", "year"];

/** A short synthesized beep (Web Audio API, no asset file) for the low-supply/offline banner — browsers refuse autoplay before a user gesture, so this only ever runs after "Enable alert sound" has been clicked once. */
function playAlertSound() {
  try {
    const context = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
  } catch {
    // Best-effort — a missing/blocked AudioContext should never crash the page.
  }
}

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
  const [trayCounts, setTrayCounts] = useState<Map<string, number>>(new Map());
  const [recentJobs, setRecentJobs] = useState<AdminJobRow[]>([]);
  const [latestCommands, setLatestCommands] = useState<Map<string, AdminKioskCommandRow>>(new Map());
  // Default TODAY per task requirement — switching persists for as long as
  // this page stays mounted (plain React state, untouched by background
  // refresh ticks, which only ever re-fetch using whatever `period` already
  // is).
  const [period, setPeriod] = useState<OverviewPeriod>("today");
  const [periodRows, setPeriodRows] = useState<PeriodBreakdownRow[]>([]);
  // Pending refunds are reported independently of the period selector — a
  // refund stays pending until an owner resolves it regardless of which
  // period the original job falls in (see get_pending_refund_summary's own
  // comment in supabase/schema.sql).
  const [pendingRefund, setPendingRefund] = useState<PendingRefundSummary>({ pending_refund_amount: null, pending_refund_count: null });
  // Statistics & Sales section — reuses the same `period` selector above.
  const [hourlyRows, setHourlyRows] = useState<HourlyPatternRow[]>([]);
  const [weekdayRows, setWeekdayRows] = useState<WeekdayPatternRow[]>([]);
  const [dailyRows, setDailyRows] = useState<DailyPatternRow[]>([]);
  const [salesSummary, setSalesSummary] = useState<SalesSummaryRow | null>(null);
  const [activeAlerts, setActiveAlerts] = useState<AlertRow[]>([]);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const [alertSoundEnabled, setAlertSoundEnabled] = useState(false);
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
    const [
      kiosksResult,
      jobsResult,
      commandsResult,
      notifyProviderResult,
      periodResult,
      pendingRefundResult,
      hourlyResult,
      weekdayResult,
      dailyResult,
      salesSummaryResult,
      activeAlertsResult,
      trayResult,
    ] = await Promise.all([
      supabase.from("kiosk_status_admin_view").select("*"),
      supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(15),
      supabase.from("kiosk_commands_admin_view").select("*").order("requested_at", { ascending: false }).limit(50),
      fetchJson<{ provider: "console" | "msg91" }>("/api/admin/notify-provider").catch(() => ({ provider: "console" as const })),
      // p_kiosk_id omitted (null) — every kiosk combined, same "whole
      // business" framing the existing all-time total_revenue card below
      // already uses. Every Statistics & Sales RPC below shares that same
      // "every kiosk combined" framing for the same reason.
      supabase.rpc("get_kiosk_period_breakdown", { p_period: period }),
      supabase.rpc("get_pending_refund_summary", { p_kiosk_id: null }),
      supabase.rpc("get_kiosk_hourly_pattern", { p_period: period, p_kiosk_id: null }),
      supabase.rpc("get_kiosk_weekday_pattern", { p_period: period, p_kiosk_id: null }),
      supabase.rpc("get_kiosk_daily_pattern", { p_period: period, p_kiosk_id: null }),
      supabase.rpc("get_kiosk_sales_summary", { p_period: period, p_kiosk_id: null }),
      supabase.rpc("get_active_alerts", { p_kiosk_id: null }),
      supabase.from("print_jobs_admin_view").select("kiosk_id, ready_at").eq("status", "printed").is("collected_at", null),
    ]);
    if (kiosksResult.error) throw new Error(kiosksResult.error.message);
    if (jobsResult.error) throw new Error(jobsResult.error.message);
    if (commandsResult.error) throw new Error(commandsResult.error.message);
    if (periodResult.error) throw new Error(periodResult.error.message);
    if (pendingRefundResult.error) throw new Error(pendingRefundResult.error.message);
    if (hourlyResult.error) throw new Error(hourlyResult.error.message);
    if (weekdayResult.error) throw new Error(weekdayResult.error.message);
    if (dailyResult.error) throw new Error(dailyResult.error.message);
    if (salesSummaryResult.error) throw new Error(salesSummaryResult.error.message);
    if (activeAlertsResult.error) throw new Error(activeAlertsResult.error.message);
    if (trayResult.error) throw new Error(trayResult.error.message);
    const nextKiosks = (kiosksResult.data as AdminKioskRow[]) ?? [];
    setKiosks(nextKiosks);
    setRecentJobs((jobsResult.data as AdminJobRow[]) ?? []);
    setLatestCommands(latestCommandPerKiosk((commandsResult.data as AdminKioskCommandRow[]) ?? []));
    setNotifyProviderIsConsole(notifyProviderResult.provider !== "msg91");
    setPeriodRows((periodResult.data as PeriodBreakdownRow[]) ?? []);
    setPendingRefund((pendingRefundResult.data?.[0] as PendingRefundSummary) ?? { pending_refund_amount: null, pending_refund_count: null });
    setHourlyRows((hourlyResult.data as HourlyPatternRow[]) ?? []);
    setWeekdayRows((weekdayResult.data as WeekdayPatternRow[]) ?? []);
    setDailyRows((dailyResult.data as DailyPatternRow[]) ?? []);
    setSalesSummary((salesSummaryResult.data?.[0] as SalesSummaryRow) ?? null);
    const nextAlerts = (activeAlertsResult.data as AlertRow[]) ?? [];
    setActiveAlerts(nextAlerts);
    const unseenAlerts = nextAlerts.filter((a) => !seenAlertIdsRef.current.has(a.id));
    for (const alert of nextAlerts) seenAlertIdsRef.current.add(alert.id);
    if (unseenAlerts.length > 0 && alertSoundEnabled) playAlertSound();

    const uncollected = (trayResult.data as { kiosk_id: string; ready_at: string | null }[]) ?? [];
    const nextTrayCounts = new Map<string, number>();
    for (const kiosk of nextKiosks) {
      const count = uncollected.filter((row) => row.kiosk_id === kiosk.id && (!kiosk.tray_cleared_at || (row.ready_at ?? "") > kiosk.tray_cleared_at)).length;
      nextTrayCounts.set(kiosk.id, count);
    }
    setTrayCounts(nextTrayCounts);
  }, [period, alertSoundEnabled]);

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

  const peakHour = findPeakHour(hourlyRows);
  const busiestWeekday = findBusiestWeekday(weekdayRows);
  const share = colorShare(salesSummary?.color_jobs ?? 0, salesSummary?.bw_jobs ?? 0);
  const dayExtremes = findDayExtremes(dailyRows);

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

      {activeAlerts.length > 0 && (
        <div className="rounded-2xl border-2 border-red-500 bg-red-50 p-4" role="alert">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-black text-red-700">
              <AlertTriangle size={16} /> {activeAlerts.length} active alert{activeAlerts.length === 1 ? "" : "s"}
            </div>
            {!alertSoundEnabled && (
              <button onClick={() => setAlertSoundEnabled(true)} className="rounded-full border border-red-300 bg-white px-2.5 py-1 text-[11px] font-bold text-red-600 hover:bg-red-100">
                Enable alert sound
              </button>
            )}
          </div>
          <ul className="mt-2 space-y-1 text-xs font-medium text-red-700">
            {activeAlerts.map((alert) => (
              <li key={alert.id}>
                {alert.kiosk_id} — {alert.kind === "paper_low" ? "low on paper" : alert.kind === "toner_low" ? "low on toner" : "offline"} since {new Date(alert.created_at).toLocaleString("en-IN")}
              </li>
            ))}
          </ul>
        </div>
      )}

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
        {totals.reprintCount > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-500"><RotateCcw size={13} /> Reprints</div>
            <p className="mt-1 text-lg font-black">{totals.reprintCount} {totals.reprintCount === 1 ? "job" : "jobs"}, {totals.reprintPages} {totals.reprintPages === 1 ? "page" : "pages"}</p>
          </div>
        )}
        {moneyKnown && (pendingRefund.pending_refund_count ?? 0) > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-amber-700">Pending refunds</div>
            <p className="mt-1 text-lg font-black text-amber-800">
              &#8377;{(pendingRefund.pending_refund_amount ?? 0).toFixed(2)} across {pendingRefund.pending_refund_count} {pendingRefund.pending_refund_count === 1 ? "job" : "jobs"}
            </p>
            <p className="mt-1 text-xs font-medium text-amber-700">Not yet subtracted from revenue above — resolve from the Refunds page.</p>
          </div>
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Separators / covers printed</div>
          <p className="mt-1 text-lg font-black">{totals.separatorsPrinted} separators, {totals.coversPrinted} covers</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Tray state</div>
          <p className="mt-1 text-lg font-black">
            {kiosks.map((kiosk) => `${kiosk.id}: likely ${trayCounts.get(kiosk.id) ?? 0} ${(trayCounts.get(kiosk.id) ?? 0) === 1 ? "stack" : "stacks"}`).join(", ") || "—"}
          </p>
        </div>
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
        <h2 className="mb-3 text-sm font-black uppercase tracking-[0.15em] text-slate-500">Statistics &amp; sales — {PERIOD_LABELS[period].toLowerCase()}</h2>
        {hourlyRows.every((row) => row.job_count === 0) && weekdayRows.every((row) => row.job_count === 0) ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-400">No activity yet for {PERIOD_LABELS[period].toLowerCase()}.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Peak hours (IST)</div>
              <div className="mt-3 flex h-20 items-end gap-0.5" role="img" aria-label={peakHour ? `Busiest hour: ${formatHourLabel(peakHour.hour_of_day)}, ${peakHour.job_count} jobs` : "No activity yet"}>
                {hourlyBarHeights(hourlyRows).map((height, hour) => (
                  <div key={hour} className="flex-1 rounded-sm bg-blue-500" style={{ height: `${Math.max(height * 100, 2)}%` }} title={`${formatHourLabel(hour)}: ${hourlyRows[hour]?.job_count ?? 0} jobs`} />
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {peakHour ? `Busiest: ${formatHourLabel(peakHour.hour_of_day)} (${peakHour.job_count} ${peakHour.job_count === 1 ? "job" : "jobs"})` : "No activity yet."}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Busiest day of the week</div>
              {busiestWeekday ? (
                <>
                  <p className="mt-1 text-2xl font-black">{WEEKDAY_LABELS[busiestWeekday.day_of_week]}</p>
                  <p className="mt-1 text-xs text-slate-400">{busiestWeekday.job_count} {busiestWeekday.job_count === 1 ? "job" : "jobs"}, {busiestWeekday.pages_printed} {busiestWeekday.pages_printed === 1 ? "page" : "pages"}</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-400">No activity yet.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Colour vs. black &amp; white</div>
              {share ? (
                <>
                  <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
                    <div className="bg-indigo-500" style={{ width: `${share.colorPercent}%` }} />
                    <div className="bg-slate-400" style={{ width: `${share.bwPercent}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{share.colorPercent}% colour &middot; {share.bwPercent}% black &amp; white</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-400">No activity yet.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Averages</div>
              <p className="mt-1 text-sm font-bold">{(salesSummary?.avg_pages_per_job ?? 0).toFixed(1)} pages / job</p>
              {moneyKnown && salesSummary?.avg_order_value !== null && salesSummary?.avg_order_value !== undefined && (
                <p className="mt-1 text-sm font-bold">&#8377;{salesSummary.avg_order_value.toFixed(2)} / order</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Reliability</div>
              <p className="mt-1 text-sm font-bold">{((salesSummary?.failure_rate ?? 0) * 100).toFixed(1)}% failure rate ({salesSummary?.failed_jobs ?? 0} {salesSummary?.failed_jobs === 1 ? "job" : "jobs"})</p>
              <p className="mt-1 text-sm font-bold">{((salesSummary?.refund_rate ?? 0) * 100).toFixed(1)}% refund rate ({salesSummary?.refunded_jobs ?? 0} {salesSummary?.refunded_jobs === 1 ? "job" : "jobs"})</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Best &amp; quietest days</div>
              {dayExtremes.busiest && dayExtremes.quietest ? (
                <>
                  <p className="mt-1 text-sm font-bold">Busiest: {new Date(dayExtremes.busiest.day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} ({dayExtremes.busiest.job_count} {dayExtremes.busiest.job_count === 1 ? "job" : "jobs"})</p>
                  <p className="mt-1 text-sm font-bold">Quietest: {new Date(dayExtremes.quietest.day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} ({dayExtremes.quietest.job_count} {dayExtremes.quietest.job_count === 1 ? "job" : "jobs"})</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-400">Not enough days in this period to compare.</p>
              )}
            </div>
          </div>
        )}
      </section>

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
