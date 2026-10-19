"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Check, IndianRupee, Printer, RefreshCw, ShieldAlert, X } from "lucide-react";
import { markJobsPrintedNoRefundNeeded, requestRefunds } from "@/lib/admin/actions";
import { useAdminRole } from "@/lib/admin/role-context";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import type { AdminJobRow, MarkPrintedResultItem, RefundRouteResultItem } from "@/lib/admin/types";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { formatTicketCode } from "@/lib/ticket-code";
import ConfirmActionModal, { type ConfirmActionReasonOption } from "../confirm-action-modal";
import LiveIndicator from "../live-indicator";

/** Options for the "Printed fine — no refund needed" confirmation's required reason field. */
const MARK_PRINTED_REASONS: ConfirmActionReasonOption[] = [
  { value: "confirmed_at_tray", label: "Confirmed printed — found it at the tray" },
  { value: "cups_shows_completed", label: "CUPS/printer history shows it completed" },
  { value: "customer_confirmed", label: "Customer confirmed they received it" },
  { value: "other", label: "Other (see audit log for context)" },
];

/**
 * Owner-only approval queue for refunds — print-agent/index.ts no longer
 * refunds a failed job automatically; this is now the ONLY place any job's
 * refund actually gets approved and sent to the payment gateway (see
 * lib/refund.ts's attemptRefund). Lists every print_failed job that hasn't
 * been resolved yet: refund_status 'pending' (never reviewed yet) or
 * 'failed' (a previous refund attempt failed, shown so an owner can retry
 * it), AND a print_failed job with NO refund_status at all — a free staff
 * print or a reprint that failed, which never gets a refund_status (see
 * set_print_job_refund_pending's own trigger) but still deserves a look
 * (there's nothing to refund, only the "Printed fine" corrective action
 * applies). A row currently 'processing' (someone else's request mid-
 * flight, or this same page's own submission still running) simply isn't
 * selectable — clicking it would be refused by the server's own atomic
 * claim anyway.
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
  const [lastResults, setLastResults] = useState<Map<string, RefundRouteResultItem | MarkPrintedResultItem>>(new Map());
  // Which confirmation pop-up is open, if any, and for which job(s) — null
  // means no pop-up is showing. "kind" distinguishes the two destructive
  // actions this page offers, since they share one ConfirmActionModal.
  const [pendingAction, setPendingAction] = useState<{ kind: "refund" | "mark_printed"; jobIds: string[] } | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const { data, error: queryError } = await supabase
      .from("print_jobs_admin_view")
      .select("*")
      .eq("status", "print_failed")
      .or("refund_status.is.null,refund_status.eq.pending,refund_status.eq.failed")
      .order("refund_requested_at", { ascending: true });
    if (queryError) throw new Error(queryError.message);
    const nextRows = (data as AdminJobRow[]) ?? [];
    setRows(nextRows);
    // Drop a selection for any job that's no longer in the actionable list
    // (it resolved to 'refunded'/'not_needed', or has since been reprinted)
    // — never leave a stale checkbox checked for a row that's disappeared.
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
  // Only a job that genuinely HAS a refund_status of pending/failed can be
  // refunded — a free staff print / reprint failure (refund_status null)
  // has nothing to refund, only "Printed fine" applies to it.
  const refundableSelectedRows = useMemo(() => selectedRows.filter((row) => row.refund_status === "pending" || row.refund_status === "failed"), [selectedRows]);
  const refundableSelectedTotal = useMemo(() => refundableSelectedRows.reduce((sum, row) => sum + Number(row.total_price ?? 0), 0), [refundableSelectedRows]);

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
      setPendingAction(null);
      await refreshNow();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not process the refund.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitMarkPrinted = async (jobIds: string[], reason?: string) => {
    if (!reason) return; // Confirm button is disabled until a reason is chosen — defensive only.
    setSubmitError("");
    setIsSubmitting(true);
    try {
      const results = await markJobsPrintedNoRefundNeeded(jobIds, reason);
      setLastResults((current) => {
        const next = new Map(current);
        for (const result of results) next.set(result.jobId, result);
        return next;
      });
      const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.jobId));
      setSelectedIds(failedIds);
      setPendingAction(null);
      await refreshNow();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not mark this job printed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const openRefundConfirm = (jobIds: string[]) => jobIds.length > 0 && setPendingAction({ kind: "refund", jobIds });
  const openMarkPrintedConfirm = (jobIds: string[]) => jobIds.length > 0 && setPendingAction({ kind: "mark_printed", jobIds });

  if (role !== "owner") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
        <ShieldAlert size={18} />
        <p className="text-sm font-semibold">Refunds are owner-only. Even if this page loaded, every refund_* field is masked to null for staff, and the server refuses any refund or printed-correction request that isn&apos;t from a signed-in owner.</p>
      </div>
    );
  }

  const pendingRows = pendingAction ? rows.filter((row) => pendingAction.jobIds.includes(row.id)) : [];
  const pendingTotal = pendingRows.reduce((sum, row) => sum + Number(row.total_price ?? 0), 0);

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
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => openMarkPrintedConfirm(selectedRows.map((row) => row.id))}
              disabled={selectedRows.length === 0 || isSubmitting}
              className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-black text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Printer size={15} /> Printed fine — no refund needed ({selectedRows.length})
            </button>
            <button
              onClick={() => openRefundConfirm(refundableSelectedRows.map((row) => row.id))}
              disabled={refundableSelectedRows.length === 0 || isSubmitting}
              className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? <RefreshCw className="animate-spin" size={15} /> : <IndianRupee size={15} />}
              Refund selected ({refundableSelectedRows.length}, total &#8377;{refundableSelectedTotal.toFixed(2)})
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((row) => {
          const result = lastResults.get(row.id);
          const isProcessing = row.refund_status === "processing";
          const isRefundable = row.refund_status === "pending" || row.refund_status === "failed";
          const cupsReportedCompleted = row.failure_evidence?.cupsState === "completed";
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
                      {isRefundable ? <>&#8377;{Number(row.total_price ?? 0).toFixed(2)} via {row.provider} &middot; </> : null}
                      failed {row.refund_requested_at ? new Date(row.refund_requested_at).toLocaleString("en-IN") : new Date(row.created_at).toLocaleString("en-IN")}
                    </p>
                    {/* Requirement: "show the failure reason next to each job" */}
                    {row.error && <p className="mt-1 text-xs text-slate-500">Failure reason: {row.error}</p>}
                    {cupsReportedCompleted && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-bold text-amber-700">
                        <AlertTriangle size={12} /> CUPS reported this job as completed — it likely printed fine.
                      </p>
                    )}
                    {row.refund_status === "failed" && row.refund_error && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600"><AlertTriangle size={12} /> Last refund attempt failed: {row.refund_error}</p>
                    )}
                    {!row.refund_status && <p className="mt-1 text-xs text-slate-400">Free staff print / reprint — nothing to refund, only &quot;Printed fine&quot; applies.</p>}
                    {isProcessing && <p className="mt-1 text-xs font-medium text-blue-600">A refund for this job is already being processed.</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => openMarkPrintedConfirm([row.id])}
                    disabled={isProcessing || isSubmitting}
                    className="flex items-center gap-1.5 rounded-full border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Printer size={12} /> Printed fine
                  </button>
                  {isRefundable && (
                    <button
                      onClick={() => openRefundConfirm([row.id])}
                      disabled={isProcessing || isSubmitting}
                      className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <IndianRupee size={12} /> Refund
                    </button>
                  )}
                </div>
              </div>
              {result && (
                <p className={`mt-2 flex items-center gap-1.5 text-xs font-bold ${result.ok ? "text-emerald-700" : "text-red-600"}`}>
                  {result.ok ? <Check size={13} /> : <X size={13} />}
                  {result.ok ? "Done." : result.error}
                </p>
              )}
            </div>
          );
        })}
        {!isLoading && rows.length === 0 && <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No failed jobs waiting on review.</p>}
        {isLoading && <p className="flex items-center gap-2 text-sm text-slate-500"><RefreshCw size={14} className="animate-spin" /> Loading...</p>}
      </div>

      {pendingAction && pendingAction.kind === "refund" && (
        <ConfirmActionModal
          title="Confirm refund"
          description={`Refund ${pendingRows.length} job${pendingRows.length === 1 ? "" : "s"} (₹${pendingTotal.toFixed(2)} total) at normal speed (5-7 business days)? This can't be undone from here.`}
          confirmLabel={`Yes, refund ₹${pendingTotal.toFixed(2)}`}
          confirmWord="REFUND"
          bulkCount={pendingAction.jobIds.length}
          isSubmitting={isSubmitting}
          onConfirm={() => void submitRefunds(pendingAction.jobIds)}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction && pendingAction.kind === "mark_printed" && (
        <ConfirmActionModal
          title="Confirm — printed fine, no refund"
          description={`Mark ${pendingRows.length} job${pendingRows.length === 1 ? "" : "s"} as printed and set its refund to "not needed"? Only do this once you've confirmed the document actually came out.`}
          confirmLabel={`Yes, refuse refund of ₹${pendingTotal.toFixed(2)}`}
          confirmWord="REFUSE"
          bulkCount={pendingAction.jobIds.length}
          reasonOptions={MARK_PRINTED_REASONS}
          isSubmitting={isSubmitting}
          onConfirm={(reason) => void submitMarkPrinted(pendingAction.jobIds, reason)}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}
