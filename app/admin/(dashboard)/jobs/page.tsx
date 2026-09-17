"use client";

import { useEffect, useState } from "react";
import { Ban, IndianRupee, RefreshCw, RotateCcw, Search } from "lucide-react";
import { cancelJob, forceReprintJob, markJobRefunded } from "@/lib/admin/actions";
import type { AdminJobRow, AdminRole } from "@/lib/admin/types";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import StatusBadge from "../status-badge";

const STATUS_OPTIONS = ["", "pending_payment", "paid", "printing", "printed", "print_failed", "payment_failed", "expired", "cancelled"];
const REPRINTABLE_STATUSES = ["print_failed", "printed"];
const CANCELLABLE_STATUSES = ["pending_payment", "paid", "printing"];
const REFUNDABLE_STATUSES = ["print_failed", "payment_failed"];

export default function AdminJobsPage() {
  const [role, setRole] = useState<AdminRole>("none");
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sinceDate, setSinceDate] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError("");
    try {
      const supabase = createSupabaseBrowserClient();

      const { data: { user } } = await supabase.auth.getUser();
      setRole(((user?.app_metadata as { role?: AdminRole } | undefined)?.role) ?? "none");

      let query = supabase.from("print_jobs_admin_view").select("*").order("created_at", { ascending: false }).limit(100);
      if (statusFilter) query = query.eq("status", statusFilter);
      if (sinceDate) query = query.gte("created_at", new Date(sinceDate).toISOString());
      if (search.trim()) {
        // Request ID is the job's raw uuid here (short-code display only happens client-side) — phone search is a plain substring match.
        query = query.or(`id.ilike.%${search.trim()}%,phone_number.ilike.%${search.trim()}%`);
      }

      const { data, error: queryError } = await query;
      if (queryError) throw new Error(queryError.message);
      setJobs((data as AdminJobRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load jobs.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Fetch-on-mount, reusing `load` so search/filter submits and post-action
    // reloads share the same fetch logic — not the derived-state anti-pattern
    // this compiler rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAction = async (jobId: string, action: () => Promise<void>) => {
    setActionError("");
    setPendingJobId(jobId);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setPendingJobId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Jobs</p>
        <h1 className="mt-1 text-2xl font-black">Search &amp; history</h1>
      </div>

      <form
        onSubmit={(event) => { event.preventDefault(); void load(); }}
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
              <th className="px-4 py-3 font-bold">Created</th>
              <th className="px-4 py-3 font-bold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-slate-50 last:border-0 align-top">
                <td className="max-w-[180px] truncate px-4 py-3" title={job.id}>{job.file_name}</td>
                <td className="px-4 py-3 font-bold text-blue-600">{job.ticket_number != null ? `#${String(job.ticket_number).padStart(3, "0")}` : "—"}</td>
                <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                <td className="px-4 py-3 text-slate-500">{job.phone_number}</td>
                <td className="px-4 py-3 text-slate-500">{job.kiosk_id}</td>
                <td className="px-4 py-3">
                  {job.total_price !== null ? `₹${Number(job.total_price).toFixed(2)}` : "—"}
                  {job.refunded_at && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">refunded</span>}
                </td>
                <td className="px-4 py-3 text-slate-500">{new Date(job.created_at).toLocaleString("en-IN")}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {/* !job.refunded_at guards against a real money bug (ROADMAP.md #10):
                       print-agent auto-refunds the instant a job hits print_failed, so
                       reprinting an already-refunded job would give the customer both
                       their money back and a free print. Backed by the same check in
                       force_reprint_job itself — this is a UX nicety, not the boundary. */}
                    {(role === "owner" || role === "staff") && REPRINTABLE_STATUSES.includes(job.status) && !job.refunded_at && (
                      <ActionButton
                        icon={RotateCcw}
                        label="Reprint"
                        pending={pendingJobId === job.id}
                        onClick={() => runAction(job.id, () => forceReprintJob(job.id))}
                      />
                    )}
                    {(role === "owner" || role === "staff") && CANCELLABLE_STATUSES.includes(job.status) && (
                      <ActionButton
                        icon={Ban}
                        label="Cancel"
                        pending={pendingJobId === job.id}
                        onClick={() => runAction(job.id, () => cancelJob(job.id))}
                      />
                    )}
                    {role === "owner" && REFUNDABLE_STATUSES.includes(job.status) && !job.refunded_at && (
                      <ActionButton
                        icon={IndianRupee}
                        label="Refund"
                        pending={pendingJobId === job.id}
                        onClick={() => {
                          // This now actually moves money (ROADMAP.md #10) —
                          // a confirm() before it fires is a cheap safety net
                          // against a stray click, not the real security
                          // boundary (that's the server-side owner check).
                          if (window.confirm(`Refund ₹${job.total_price?.toFixed(2) ?? "?"} for "${job.file_name}"? This charges back through ${job.provider} immediately and can't be undone from here.`)) {
                            runAction(job.id, () => markJobRefunded(job.id));
                          }
                        }}
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
    </div>
  );
}

function ActionButton({ icon: Icon, label, pending, onClick }: { icon: typeof Ban; label: string; pending: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? <RefreshCw size={11} className="animate-spin" /> : <Icon size={11} />} {label}
    </button>
  );
}
