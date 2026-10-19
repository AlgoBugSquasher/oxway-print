"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Gift, RefreshCw, X } from "lucide-react";
import { FileBasketItemCard, itemActivePages, type PageMode } from "@/components/print-basket-ui";
import { requestReprint } from "@/lib/admin/actions";
import { fetchJson } from "@/lib/fetch-json";
import { useFileBasket } from "@/lib/hooks/useFileBasket";
import type { AdminJobRow } from "@/lib/admin/types";
import { formatTicketCode } from "@/lib/ticket-code";

/**
 * Owner-only "Reprint pages" (requirement #3/#4) — distinct from the
 * plain "Reprint" button (forceReprintJob), which just resubmits a job's
 * existing file as-is. This lets an owner pick a SUBSET of a job's own
 * pages and create a brand new, free, clearly-labeled REPRINT job from
 * them.
 *
 * Reuses the EXISTING page-selector building blocks (FileBasketItemCard,
 * itemActivePages, useFileBasket) rather than duplicating that logic —
 * the job's own stored PDF is downloaded into the browser (via a signed
 * URL, see app/api/admin/jobs/[jobId]/pdf-url) and fed through the SAME
 * client-side thumbnail pipeline every other page in this app already
 * uses, so the thumbnails/page-range picker below are pixel-identical to
 * the customer checkout page's own.
 *
 * Deliberately does NOT offer layout/color/paper-size/pages-per-sheet —
 * only what the task asked for: page range or thumbnails, copies (default
 * 1), and "Include cover sheet" (default off). Everything else is
 * inherited from the original job's own settings (see
 * app/api/admin/reprint/route.ts).
 */
export default function ReprintModal({ job, onClose, onDone }: { job: AdminJobRow; onClose: () => void; onDone: () => void }) {
  const basket = useFileBasket({ layout: job.settings.layout, enabled: true });
  // Requirement: "make the Reprint option explain [the file being gone]" —
  // known client-side already (print_jobs_admin_view exposes
  // pdf_deleted_at), computed once up front (this modal is remounted fresh
  // per job it's opened for) so there's no doomed-to-fail fetch to even
  // attempt, and no generic storage error to explain around.
  const pdfDeletedExplanation = job.pdf_deleted_at
    ? `The stored file was deleted on ${new Date(job.pdf_deleted_at).toLocaleDateString("en-IN")} — an unresolved refund sat for over 7 days, and the file is removed after that (the job and refund record are unaffected). This job can no longer be reprinted.`
    : "";
  const [loadError, setLoadError] = useState(pdfDeletedExplanation);
  const [isLoadingFile, setIsLoadingFile] = useState(!job.pdf_deleted_at);

  const [pageMode, setPageMode] = useState<PageMode>("all");
  const [customRange, setCustomRange] = useState("");
  const [copies, setCopies] = useState(1);
  const [forceCoverSheet, setForceCoverSheet] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState<{ jobId: string; ticketNumber: number } | null>(null);

  // basket.addFiles is itself referentially stable here (useFileBasket's
  // own useCallback deps — enabled/layout/runConversion — never change
  // across this modal's lifetime), so depending on it directly (not the
  // whole `basket` object, which is a fresh object every render) lets
  // this effect genuinely only run once per job, with no lint suppression.
  const { addFiles } = basket;
  useEffect(() => {
    if (job.pdf_deleted_at) return; // Already explained via the initial state above — nothing to fetch.
    let cancelled = false;
    (async () => {
      try {
        const { signedUrl, fileName } = await fetchJson<{ signedUrl: string; fileName: string }>(`/api/admin/jobs/${job.id}/pdf-url`);
        const response = await fetch(signedUrl);
        if (!response.ok) throw new Error("Could not download the stored file.");
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        addFiles([new File([bytes], fileName, { type: "application/pdf" })]);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load this job's file.");
      } finally {
        if (!cancelled) setIsLoadingFile(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job.id, job.pdf_deleted_at, addFiles]);

  const item = basket.items[0];
  const activePages = useMemo(() => (item ? itemActivePages(item, pageMode, customRange) : []), [item, pageMode, customRange]);

  const isRefunded = job.refund_status === "refunded";
  const isRefundPending = job.refund_status === "pending";

  const handleSubmit = async () => {
    if (activePages.length === 0) return setSubmitError("Select at least one page to reprint.");
    setSubmitError("");
    setIsSubmitting(true);
    try {
      const response = await requestReprint({
        originalJobId: job.id,
        selectedPages: activePages,
        copies,
        forceCoverSheet,
      });
      setResult(response);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not create the reprint.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-[2rem] bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Reprint pages</p>
            <h2 className="mt-1 text-xl font-black">{job.file_name}</h2>
          </div>
          <button onClick={onClose} className="grid size-9 place-items-center rounded-xl bg-slate-100"><X size={17} /></button>
        </div>

        {result ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-emerald-500 bg-emerald-50 px-6 py-8 text-center">
            <p className="text-xs font-black uppercase tracking-[0.3em] text-emerald-600">Pickup code</p>
            <p className="text-4xl font-black tracking-tight text-emerald-600">{formatTicketCode(result.ticketNumber)}</p>
            <p className="text-sm text-emerald-700">Queued — free reprint, no new payment.</p>
            <button onClick={onDone} className="mt-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white hover:bg-emerald-500">Done</button>
          </div>
        ) : (
          <>
            {isRefunded && (
              <div className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <p>This job has already been refunded — it can&apos;t be reprinted for free (the customer would keep the refund AND get a free reprint).</p>
              </div>
            )}
            {!isRefunded && isRefundPending && (
              <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <p>This job still has a refund pending review. Completing this reprint will mark that refund &quot;not needed&quot; instead.</p>
              </div>
            )}

            {isLoadingFile && <p className="flex items-center gap-2 py-10 text-sm text-slate-500"><RefreshCw className="animate-spin" size={16} /> Loading the stored file...</p>}
            {loadError && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{loadError}</div>}

            {item && item.status === "ready" && (
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-bold text-slate-500">Pages</p>
                  <div className="grid grid-cols-4 gap-2">
                    {(["all", "odd", "even", "custom"] as PageMode[]).map((mode) => (
                      <button key={mode} onClick={() => setPageMode(mode)} className={`rounded-xl border px-2 py-2 text-xs font-bold capitalize ${pageMode === mode ? "border-blue-500 bg-blue-500/10 text-blue-500" : "border-slate-200"}`}>{mode}</button>
                    ))}
                  </div>
                  {pageMode === "custom" && (
                    <input value={customRange} onChange={(event) => setCustomRange(event.target.value)} placeholder="Example: 1-5, 8" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                  )}
                </div>

                <FileBasketItemCard
                  item={item}
                  index={0}
                  itemCount={1}
                  isDark={false}
                  muted="text-slate-500"
                  panel="border-slate-200 bg-white"
                  canEdit={false}
                  activePages={activePages}
                  onRemove={() => {}}
                  onMoveUp={() => {}}
                  onMoveDown={() => {}}
                  onTogglePage={(pageNumber) => basket.togglePage(item.id, pageNumber)}
                  onSelectAll={() => basket.selectAllPages(item.id)}
                  onClearPages={() => basket.clearPages(item.id)}
                />

                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-bold text-slate-500">Copies</span>
                  <div className="flex items-center gap-1 rounded-xl border border-slate-200 p-1">
                    <button onClick={() => setCopies((value) => Math.max(1, value - 1))} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10">−</button>
                    <span className="w-8 text-center text-sm font-black">{copies}</span>
                    <button onClick={() => setCopies((value) => value + 1)} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10">+</button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-4">
                  <span className="text-sm font-bold text-slate-500">Force cover sheet</span>
                  <input type="checkbox" checked={forceCoverSheet} onChange={(event) => setForceCoverSheet(event.target.checked)} className="size-5 accent-blue-600" />
                </label>

                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold text-emerald-800">
                  <Gift size={14} className="mr-1.5 inline" /> {activePages.length} of {item.totalPages} page{item.totalPages === 1 ? "" : "s"} · {copies} {copies === 1 ? "copy" : "copies"} · Free reprint, no new payment
                </div>

                {submitError && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{submitError}</div>}

                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting || isRefunded || activePages.length === 0}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? <RefreshCw className="animate-spin" size={16} /> : <Gift size={16} />} Reprint {activePages.length} page{activePages.length === 1 ? "" : "s"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
