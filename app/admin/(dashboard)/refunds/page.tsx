"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Check, IndianRupee, RefreshCw, ShieldAlert, X } from "lucide-react";
import { requestRefunds } from "@/lib/admin/actions";
import { useAdminRole } from "@/lib/admin/role-context";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import type { AdminJobRow, RefundRouteResultItem } from "@/lib/admin/types";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { formatTicketCode } from "@/lib/ticket-code";
import LiveIndicator from "../live-indicator";

/**
 * Owner-only approval queue for refunds — print-agent/index.ts no longer
 * refunds a failed job automatically; this is now the ONLY place any job's
 * refund actually gets approved and sent to the payment gateway (see
 * lib/refund.ts's attemptRefund). Lists every job whose refund_status is
 * 'pending' (never reviewed yet) or 'failed' (a previous attempt failed —
 * shown here specifically so an owner can retry it), oldest request first.
 * A row currently 'processing' (someone else's request mid-flight, or this
 * same page's own submission still running) simply isn't selectable —
 * clicking it would be refused by the server's own atomic claim anyway
 * (see claim_refund_for_processing's own comment), this just avoids
 * offering a button that would only ever fail.
 */
export default function AdminRefundsPage() {
  const role = useAdminRole();
  const [rows, setRows] = useState<AdminJobRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // Keyed by jobId — the most recent result for each job this page has
  // actually submitted, kept on screen until the next successful refresh
  // clears it (a refreshed row's own refund_status already tells the same
  // story going forward). Lets a bulk submission show "6 succeeded, 2
  // failed" with the two failures named, rather than nothing at all once
  // the list re-fetches and the 6 successes simply vanish from it.
  const [lastResults, setLastResults] = useState<Map<string, RefundRouteResultItem>>(new Map());

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const { data, error: queryError } = await supabase
      .from("print_jobs_admin_view")
      .select("*")
      .in("refund_status", ["pending", "failed"])
      .order("refund_requested_at", { ascending: true });
    if (queryError) throw new Error(queryError.message);
    const nextRows = (data as AdminJobRow[]) ?? [];
    setRows(nextRows);
    // Drop a selection for any job that's no longer in the actionable list
    // (it resolved to 'refunded', or has since been reprinted) — never
    // leave a stale checkbox checked for a row that's disappeared.
    const stillPresent = new Set(nextRows.map((row) => row.id));
    setSelectedIds((current) => new Set([...current].filter((id) => stillPresent.has(id))));
  }, []);

  // Paused while a submission is in flight — a background refresh mid-submit
  // could otherwise reorder/remove rows out from under the very request
  // that's processing them.
  const { isRefreshing, lastUpdatedAt, error: loadError, refreshNow } = useAutoRefresh(fetchData, {
    isPaused: () => isSubmitting,
  });
  const isLoading = isRefreshing && lastUpdatedAt === null;

  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds]);
  const selectedTotal = useMemo(() => selectedRows.reduce((sum, row) => sum + Number(row.total_price ?? 0), 0), [selectedRows]);

  const toggleRow = (jobId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((current) => (current.size === rows.length ? new Set() : new Set(rows.map((row) => row.id))));
  };

  // Shared by both the single-row "Refund" button (jobIds.length === 1) and
  // "Refund selected" — the server treats them identically (see
  // app/api/admin/refund/route.ts), this just drives the UI state around
  // the one call.
  const submitRefunds = async (jobIds: string[]) => {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      const results = await requestRefunds(jobIds);
      setLastResults((current) => {
        const next = new Map(current);
        for (const result of results) next.set(result.jobId, result);
        return next;
      });
      // Requirement: "let me retry only the failures" — after a submission,
      // the only jobs left selected are the ones that just failed, so an
      // immediate second click of "Refund selected" retries exactly those,
      // with nothing further to re-pick.
      const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.jobId));
      setSelectedIds(failedIds);
      await refreshNow();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not process the refund.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRefundOne = (row: AdminJobRow) => {
    if (!window.confirm(`Refund ₹${Number(row.total_price ?? 0).toFixed(2)} for "${row.file_name}" through ${row.provider}, at normal speed (5-7 business days)? This can't be undone from here.`)) {
      return;
    }
    void submitRefunds([row.id]);
  };

  const handleRefundSelected = () => {
    if (selectedRows.length === 0) return;
    if (!window.confirm(`Refund ${selectedRows.length} selected job${selectedRows.length === 1 ? "" : "s"}, totalling ₹${selectedTotal.toFixed(2)}, at normal speed (5-7 business days)? This can't be undone from here.`)) {
      return;
    }
    void submitRefunds(selectedRows.map((row) => row.id));
  };

  if (role !== "owner") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
        <ShieldAlert size={18} />
        <p className="text-sm font-semibold">Refunds are owner-only. Even if this page loaded, every refund_* field is masked to null for staff, and the server refuses any refund request that isn&apos;t from a signed-in owner.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Refunds</p>
          <h1 className="mt-1 text-2xl font-black">Pending approval</h1>
          <p className="mt-1 text-sm text-slate-500">A failed, already-paid job lands here instead of refunding itself — nothing is sent to the payment gateway until you approve it below, and every refund runs at normal speed (5-7 business days), never instant.</p>
        </div>
        <LiveIndicator isRefreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />
      </div>

      {(loadError || submitError) && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{loadError || submitError}</div>}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
            <input type="checkbox" checked={selectedIds.size === rows.length && rows.length > 0} onChange={toggleSelectAll} className="size-4 accent-blue-600" />
            Select all ({rows.length})
          </label>
          <button
            onClick={handleRefundSelected}
            disabled={selectedRows.length === 0 || isSubmitting}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? <RefreshCw className="animate-spin" size={15} /> : <IndianRupee size={15} />}
            Refund selected ({selectedRows.length}, total &#8377;{selectedTotal.toFixed(2)})
          </button>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((row) => {
          const result = lastResults.get(row.id);
          const isProcessing = row.refund_status === "processing";
          return (
            <div key={row.id} className={`rounded-2xl border p-4 ${result && !result.ok ? "border-red-200 bg-red-50" : result?.ok ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    disabled={isProcessing || isSubmitting}
                    onChange={() => toggleRow(row.id)}
                    className="mt-1 size-4 accent-blue-600 disabled:opacity-40"
                  />
                  <div>
                    <p className="font-bold text-blue-600">{row.ticket_number != null ? formatTicketCode(row.ticket_number) : "—"} <span className="text-slate-400">&middot;</span> <span className="text-slate-700">{row.file_name}</span></p>
                    <p className="mt-1 text-xs text-slate-500">
                      &#8377;{Number(row.total_price ?? 0).toFixed(2)} via {row.provider} &middot; failed {row.refund_requested_at ? new Date(row.refund_requested_at).toLocaleString("en-IN") : new Date(row.created_at).toLocaleString("en-IN")}
                    </p>
                    {row.error && <p className="mt-1 text-xs text-slate-500">Failure reason: {row.error}</p>}
                    {row.refund_status === "failed" && row.refund_error && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600"><AlertTriangle size={12} /> Last refund attempt failed: {row.refund_error}</p>
                    )}
                    {isProcessing && <p className="mt-1 text-xs font-medium text-blue-600">A refund for this job is already being processed.</p>}
                  </div>
                </div>
                <button
                  onClick={() => handleRefundOne(row)}
                  disabled={isProcessing || isSubmitting}
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <IndianRupee size={12} /> Refund
                </button>
              </div>
              {result && (
                <p className={`mt-2 flex items-center gap-1.5 text-xs font-bold ${result.ok ? "text-emerald-700" : "text-red-600"}`}>
                  {result.ok ? <Check size={13} /> : <X size={13} />}
                  {result.ok ? "Refunded." : result.error}
                </p>
              )}
            </div>
          );
        })}
        {!isLoading && rows.length === 0 && <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No refunds waiting on approval.</p>}
        {isLoading && <p className="flex items-center gap-2 text-sm text-slate-500"><RefreshCw size={14} className="animate-spin" /> Loading...</p>}
      </div>
    </div>
  );
}
