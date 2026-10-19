"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Ban, Copy, RefreshCw, RotateCcw, Search } from "lucide-react";
import { cancelJob, forceReprintJob } from "@/lib/admin/actions";
import { useAdminRole } from "@/lib/admin/role-context";
import { fetchJson } from "@/lib/fetch-json";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import type { AdminJobRow } from "@/lib/admin/types";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { formatTicketCode } from "@/lib/ticket-code";
import LiveIndicator from "../live-indicator";
import StatusBadge from "../status-badge";
import ReprintModal from "./reprint-modal";

const STATUS_OPTIONS = ["", "pending_payment", "paid", "printing", "print_blocked", "interrupted", "printed", "print_failed", "payment_failed", "expired", "cancelled"];
const REPRINTABLE_STATUSES = ["print_failed", "printed"];
// print_blocked included — still "in the active queue, not yet
// resolved," same reasoning cancel_job's own SQL guard was extended for
// (supabase/schema.sql) — an owner/staff member can give up on a job
// that's been waiting a while rather than it being a dead end until the
// print agent's own retry-time-limit expires on its own.
const CANCELLABLE_STATUSES = ["pending_payment", "paid", "printing", "print_blocked"];

/** Small, non-interactive label for a job's refund_status — refunding itself only ever happens from the dedicated /admin/refunds queue now (owner-only, with its own review/approval step), never a direct click from this list. */
const REFUND_STATUS_LABELS: Record<string, { text: string; className: string }> = {
  pending: { text: "refund pending", className: "bg-amber-100 text-amber-700" },
  processing: { text: "refund processing", className: "bg-blue-100 text-blue-700" },
  refunded: { text: "refunded", className: "bg-slate-100 text-slate-500" },
  failed: { text: "refund failed", className: "bg-red-100 text-red-600" },
  // Set by set_original_job_refund_not_needed once a reprint of this job
  // prints successfully — a refund WAS pending, but the customer got their
  // document after all.
  not_needed: { text: "refund not needed (reprinted)", className: "bg-slate-100 text-slate-500" },
};

interface JobFilters {
  search: string;
  statusFilter: string;
  sinceDate: string;
}

export default function AdminJobsPage() {
  // From the server-rendered layout (see lib/admin/role-context.tsx) —
  // never re-fetched here. A role-gated button is a UX nicety, not the real
  // security boundary (every action below re-checks server-side), so there
  // was never a reason for this page to pay for its own
  // supabase.auth.getUser() network round trip on mount AND on every 5s
  // auto-refresh tick just to decide which buttons to show.
  const role = useAdminRole();
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  // Resolves a staff job's created_by_user_id to a readable email for the
  // "Created by" column — print_jobs_admin_view can't join auth.users
  // directly (no PostgREST access to that schema), so this is fetched once
  // from a small dedicated route instead (see that route's own comment).
  // Best-effort: a failure here just leaves "Created by" showing the raw id
  // for staff jobs rather than breaking the whole jobs list.
  const [staffEmailsById, setStaffEmailsById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetchJson<{ users: { id: string; email: string }[] }>("/api/admin/staff-users")
      .then((result) => setStaffEmailsById(new Map(result.users.map((u) => [u.id, u.email]))))
      .catch(() => {
        // Non-fatal — see this state's own comment above.
      });
  }, []);
  // The form's own draft values — typing here never touches the actual
  // query (see appliedFiltersRef below), so a background refresh re-running
  // the last *submitted* search can never clobber a half-typed one.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sinceDate, setSinceDate] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  // The job currently open in the "Reprint pages" modal — null when closed.
  const [reprintJob, setReprintJob] = useState<AdminJobRow | null>(null);

  // What the table is actually querying by — only ever updated on submit
  // (handleSearchSubmit below). A ref, not state: fetchData reads it fresh
  // on every call, so its own identity can stay stable (no dependency on
  // filter state), and updating it ahead of a manual refreshNow() call is
  // immediate rather than waiting on React's next render the way a state
  // update would.
  const appliedFiltersRef = useRef<JobFilters>({ search: "", statusFilter: "", sinceDate: "" });

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();

    const { search: appliedSearch, statusFilter: appliedStatusFilter, sinceDate: appliedSinceDate } = appliedFiltersRef.current;
    let query = supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(100);
    if (appliedStatusFilter) query = query.eq("status", appliedStatusFilter);
    if (appliedSinceDate) query = query.gte("created_at", new Date(appliedSinceDate).toISOString());
    if (appliedSearch.trim()) {
      // Request ID is the job's raw uuid here (short-code display only happens client-side) — phone search is a plain substring match.
      query = query.or(`id.ilike.%${appliedSearch.trim()}%,phone_number.ilike.%${appliedSearch.trim()}%`);
    }

    const { data, error: queryError } = await query;
    if (queryError) throw new Error(queryError.message);
    const rows = (data as AdminJobRow[]) ?? [];
    // Requirement: "Interrupted jobs appear at the top of the admin Jobs
    // list" — a stable partition (Array.prototype.sort has been
    // guaranteed stable since ES2019), so interrupted rows move to the
    // front without disturbing the created_at-desc order within either
    // group.
    rows.sort((a, b) => Number(b.status === "interrupted") - Number(a.status === "interrupted"));
    setJobs(rows);
  }, []);

  // Paused while an action (reprint/cancel/refund) is in flight — not for
  // merely typing in the search form, which never touches the query until
  // submitted anyway (see appliedFiltersRef above).
  const { isRefreshing, lastUpdatedAt, error, refreshNow } = useAutoRefresh(fetchData, {
    isPaused: () => pendingJobId !== null,
  });
  const isLoading = isRefreshing && lastUpdatedAt === null;

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    appliedFiltersRef.current = { search, statusFilter, sinceDate };
    void refreshNow();
  };

  const runAction = async (jobId: string, action: () => Promise<void>) => {
    setActionError("");
    setPendingJobId(jobId);
    try {
      await action();
      await refreshNow();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setPendingJobId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Jobs</p>
          <h1 className="mt-1 text-2xl font-black">Search &amp; history</h1>
        </div>
        <LiveIndicator isRefreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />
      </div>

      <form
        onSubmit={handleSearchSubmit}
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4"
      >
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs font-bold text-slate-500">Request ID or phone</label>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search..." className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Status</label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500">
            {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status ? status.replace("_", " ") : "All"}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Since</label>
          <input type="date" value={sinceDate} onChange={(event) => setSinceDate(event.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <button type="submit" className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">
          <Search size={14} /> Search
        </button>
      </form>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
      {actionError && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{actionError}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 font-bold">File</th>
              <th className="px-4 py-3 font-bold">Ticket</th>
              <th className="px-4 py-3 font-bold">Status</th>
              <th className="px-4 py-3 font-bold">Phone</th>
              <th className="px-4 py-3 font-bold">Kiosk</th>
              <th className="px-4 py-3 font-bold">Price</th>
              <th className="px-4 py-3 font-bold">Created by</th>
              <th className="px-4 py-3 font-bold">Created</th>
              <th className="px-4 py-3 font-bold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-slate-50 last:border-0 align-top">
                <td className="max-w-[180px] truncate px-4 py-3" title={job.id}>
                  {job.is_free && <span className="mr-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">STAFF</span>}
                  {/* original_job_id is the single source of truth for "is this a reprint" — requirement: "marked REPRINT in lists." */}
                  {job.original_job_id && <span className="mr-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">REPRINT</span>}
                  {job.file_name}
                  {/* Requirement #6: "Add a note on the original job." */}
                  {job.reprint_note && <p className="mt-1 text-[11px] font-normal text-violet-600">{job.reprint_note}</p>}
                </td>
                <td className="px-4 py-3 font-bold text-blue-600">{job.ticket_number != null ? formatTicketCode(job.ticket_number) : "—"}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={job.status} />
                  {/* Requirement: "Show the blocked reason ... on the job." */}
                  {job.status === "print_blocked" && job.blocked_reason && <p className="mt-1 text-[11px] text-orange-600">{job.blocked_reason}</p>}
                  {job.status === "interrupted" && job.interrupted_reason && <p className="mt-1 text-[11px] text-rose-600">{job.interrupted_reason}</p>}
                  {/* Requirement: "store the actual failure reason and the evidence ... show it in the admin job detail." */}
                  {job.status === "print_failed" && job.error && <p className="mt-1 text-[11px] text-red-600">{job.error}</p>}
                  {job.status === "print_failed" && job.failure_evidence && (
                    <p className="mt-1 text-[11px] text-slate-400">
                      CUPS: {job.failure_evidence.cupsState}{job.failure_evidence.cupsReason ? ` (${job.failure_evidence.cupsReason})` : ""}
                      {" · "}{Math.round(job.failure_evidence.elapsedMs / 1000)}s elapsed · {job.failure_evidence.physicalSheets} sheets
                      {job.failure_evidence.cupsState === "completed" && <span className="ml-1 font-bold text-amber-600">— likely printed anyway</span>}
                    </p>
                  )}
                  {/* Requirement: "Show in admin when the file is gone." Only the stored PDF was removed (an unresolved refund held past REFUND_PENDING_FILE_RETENTION_DAYS) — the job and its refund record are untouched. */}
                  {job.pdf_deleted_at && (
                    <p className="mt-1 text-[11px] font-bold text-slate-400">File deleted {new Date(job.pdf_deleted_at).toLocaleDateString("en-IN")} — can&apos;t be reprinted.</p>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">{job.phone_number}</td>
                <td className="px-4 py-3 text-slate-500">{job.kiosk_id}</td>
                <td className="px-4 py-3">
                  {/* A staff job's own total_price is always 0 — waived_amount (what it
                     WOULD have cost) is the number actually worth showing here. A reprint
                     job's total_price is also always 0, but nothing was "waived" for it —
                     see original_job_id's own comment in lib/store.ts. */}
                  {job.is_free
                    ? <span className="text-emerald-700">FREE{job.waived_amount !== null && ` (₹${Number(job.waived_amount).toFixed(2)} waived)`}</span>
                    : job.original_job_id
                      ? <span className="text-violet-700">FREE (reprint)</span>
                      : job.total_price !== null ? `₹${Number(job.total_price).toFixed(2)}` : "—"}
                  {/* refund_status (owner-masked — null for staff) drives this now,
                     not the old binary refunded_at badge — see the Refunds admin page
                     (owner-only) for the actual approve/retry action. */}
                  {job.refund_status && REFUND_STATUS_LABELS[job.refund_status] && (
                    <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${REFUND_STATUS_LABELS[job.refund_status].className}`}>
                      {REFUND_STATUS_LABELS[job.refund_status].text}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">{job.created_by_user_id ? (staffEmailsById.get(job.created_by_user_id) ?? job.created_by_user_id.slice(0, 8)) : "—"}</td>
                <td className="px-4 py-3 text-slate-500">{new Date(job.created_at).toLocaleString("en-IN")}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {/* !job.refunded_at guards against a real money bug: reprinting an
                       already-refunded job would give the customer both their money
                       back and a free print. refund_status !== "processing" additionally
                       hints that a refund is actively in flight right now. Both are
                       backed by the same two checks in force_reprint_job itself — this
                       is a UX nicety, not the boundary. */}
                    {(role === "owner" || role === "staff") && REPRINTABLE_STATUSES.includes(job.status) && !job.refunded_at && job.refund_status !== "processing" && (
                      <ActionButton
                        icon={RotateCcw}
                        label="Reprint"
                        pending={pendingJobId === job.id}
                        onClick={() => runAction(job.id, () => forceReprintJob(job.id))}
                        disabled={Boolean(job.pdf_deleted_at)}
                        title={job.pdf_deleted_at ? "The stored file was deleted after 7+ days with an unresolved refund — it can't be reprinted." : undefined}
                      />
                    )}
                    {/* Requirement #3: "Each job in the admin Jobs list gets
                       a 'Reprint pages' button," owner/admin only — distinct
                       from the plain "Reprint" button above, which only ever
                       resubmits the whole stored file as-is. Available
                       regardless of status (unlike REPRINTABLE_STATUSES
                       above) — an owner might want extra copies of a job
                       that printed fine, or specific pages from one that
                       didn't; app/api/admin/reprint's own validation (file
                       still exists, already-refunded block) is the real
                       guard, not a status filter here. */}
                    {role === "owner" && (
                      <ActionButton icon={Copy} label="Reprint pages" pending={false} onClick={() => setReprintJob(job)} />
                    )}
                    {(role === "owner" || role === "staff") && CANCELLABLE_STATUSES.includes(job.status) && (
                      <ActionButton
                        icon={Ban}
                        label="Cancel"
                        pending={pendingJobId === job.id}
                        onClick={() => runAction(job.id, () => cancelJob(job.id))}
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && jobs.length === 0 && <p className="p-4 text-sm text-slate-500">No jobs match this search.</p>}
        {isLoading && <p className="flex items-center gap-2 p-4 text-sm text-slate-500"><RefreshCw size={14} className="animate-spin" /> Loading...</p>}
      </div>

      {reprintJob && (
        <ReprintModal
          job={reprintJob}
          onClose={() => setReprintJob(null)}
          onDone={() => {
            setReprintJob(null);
            void refreshNow();
          }}
        />
      )}
    </div>
  );
}

function ActionButton({ icon: Icon, label, pending, onClick, disabled, title }: { icon: typeof Ban; label: string; pending: boolean; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={pending || disabled}
      title={title}
      className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? <RefreshCw size={11} className="animate-spin" /> : <Icon size={11} />} {label}
    </button>
  );
}
