"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, ShieldAlert } from "lucide-react";
import { useAdminRole } from "@/lib/admin/role-context";
import { AUDIT_ACTIONS, describeAuditAction, hasBeforeAfter, summarizeAuditEntry } from "@/lib/admin/audit-descriptions";
import type { AuditLogRow } from "@/lib/admin/types";
import { fetchJson } from "@/lib/fetch-json";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import LiveIndicator from "../live-indicator";

/** Rows per page — a plain constant, not user-configurable, matching jobs/page.tsx's own fixed `.limit(100)` convention for this panel. */
const PAGE_SIZE = 25;

interface AuditFilters {
  action: string;
  userId: string;
  kioskId: string;
  sinceDate: string;
  untilDate: string;
}

const EMPTY_FILTERS: AuditFilters = { action: "", userId: "", kioskId: "", sinceDate: "", untilDate: "" };

export default function AdminAuditPage() {
  const role = useAdminRole();

  const [entries, setEntries] = useState<AuditLogRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);

  // Resolves actor_user_id -> email for display and for the "user" filter's
  // own dropdown options — same /api/admin/staff-users route (and same
  // "best-effort, never breaks the page" reasoning) jobs/page.tsx already
  // uses for created_by_user_id.
  const [staffEmailsById, setStaffEmailsById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetchJson<{ users: { id: string; email: string }[] }>("/api/admin/staff-users")
      .then((result) => setStaffEmailsById(new Map(result.users.map((u) => [u.id, u.email]))))
      .catch(() => {
        // Non-fatal — see this state's own comment above.
      });
  }, []);

  // Machine filter's own options — only meaningfully different from "just
  // show the filter always" once a second kiosk exists; fetched once since
  // the set of kiosks essentially never changes during a single admin
  // session.
  const [kioskIds, setKioskIds] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.from("kiosk_status_admin_view").select("id");
        setKioskIds(((data as { id: string }[] | null) ?? []).map((row) => row.id));
      } catch {
        // Non-fatal — the machine filter just won't offer any options.
      }
    })();
  }, []);

  // Draft filter values the form is bound to — typing here never touches
  // the actual query until submitted, same appliedFiltersRef pattern
  // jobs/page.tsx uses, so a background refresh re-running the last
  // *applied* filters can never clobber a half-typed one.
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const appliedFiltersRef = useRef<AuditFilters>(EMPTY_FILTERS);

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const f = appliedFiltersRef.current;

    let query = supabase
      .from("audit_log")
      .select("*", { count: "exact" })
      .order("at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (f.action) query = query.eq("action", f.action);
    if (f.userId) query = query.eq("actor_user_id", f.userId);
    if (f.kioskId) query = query.eq("kiosk_id", f.kioskId);
    if (f.sinceDate) query = query.gte("at", new Date(f.sinceDate).toISOString());
    if (f.untilDate) {
      // Inclusive of the whole selected day — the date input gives midnight
      // at the START of that day, so the end boundary is the start of the
      // NEXT day.
      const endOfDay = new Date(f.untilDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      query = query.lt("at", endOfDay.toISOString());
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    setEntries((data as AuditLogRow[]) ?? []);
    setTotalCount(count ?? 0);
  }, [page]);

  const { isRefreshing, lastUpdatedAt, error, refreshNow } = useAutoRefresh(fetchData);
  const isLoading = isRefreshing && lastUpdatedAt === null;

  const applyFilters = () => {
    appliedFiltersRef.current = draftFilters;
    setPage(0);
    void refreshNow();
  };

  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    setPage(0);
    void refreshNow();
  };

  const goToPage = (next: number) => {
    setPage(next);
    void refreshNow();
  };

  if (role !== "owner") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
        <ShieldAlert size={18} />
        <p className="text-sm font-semibold">The audit log is owner-only. Even if this page loaded, the database would refuse to return any rows — see the &quot;Owner reads audit_log&quot; policy in supabase/schema.sql.</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Audit log</p>
          <h1 className="mt-1 text-2xl font-black">Who did what, and when</h1>
        </div>
        <LiveIndicator isRefreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4"
      >
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Action</label>
          <select
            value={draftFilters.action}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, action: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
          >
            <option value="">All</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>{describeAuditAction(action)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">User</label>
          <select
            value={draftFilters.userId}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, userId: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
          >
            <option value="">Everyone</option>
            {Array.from(staffEmailsById.entries()).map(([id, email]) => (
              <option key={id} value={id}>{email}</option>
            ))}
          </select>
        </div>
        {/* Machine selector only appears once there's more than one to choose from (ROADMAP-style "only if the user can access more than one machine" rule, applied here even though every other admin surface today is single-kiosk). */}
        {kioskIds.length > 1 && (
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Machine</label>
            <select
              value={draftFilters.kioskId}
              onChange={(event) => setDraftFilters((prev) => ({ ...prev, kioskId: event.target.value }))}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">All machines</option>
              {kioskIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">From</label>
          <input
            type="date"
            value={draftFilters.sinceDate}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, sinceDate: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">To</label>
          <input
            type="date"
            value={draftFilters.untilDate}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, untilDate: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <button type="submit" className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">Apply</button>
        <button type="button" onClick={clearFilters} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Clear</button>
      </form>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 font-bold">When (IST)</th>
              <th className="px-4 py-3 font-bold">Who</th>
              <th className="px-4 py-3 font-bold">Machine</th>
              <th className="px-4 py-3 font-bold">What happened</th>
              <th className="px-4 py-3 font-bold" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const isExpanded = expandedRowId === entry.id;
              const actorLabel = entry.actor_user_id
                ? (staffEmailsById.get(entry.actor_user_id) ?? entry.actor_user_id.slice(0, 8))
                : "System";
              return (
                <Fragment key={entry.id}>
                  <tr className="border-b border-slate-50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{new Date(entry.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                    <td className="px-4 py-3 text-slate-600">{actorLabel}{entry.actor_role ? ` (${entry.actor_role})` : ""}</td>
                    <td className="px-4 py-3 text-slate-500">{entry.kiosk_id ?? "—"}</td>
                    <td className="px-4 py-3">{summarizeAuditEntry(entry)}</td>
                    <td className="px-4 py-3 text-right">
                      {entry.details && (
                        <button
                          onClick={() => setExpandedRowId(isExpanded ? null : entry.id)}
                          className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:border-blue-300 hover:text-blue-600"
                        >
                          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Details
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && entry.details && (
                    <tr className="border-b border-slate-50 bg-slate-50/60 last:border-0">
                      <td colSpan={5} className="px-4 py-3">
                        <AuditDetails details={entry.details} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!isLoading && entries.length === 0 && <p className="p-4 text-sm text-slate-500">No audit entries match this search.</p>}
        {isLoading && <p className="flex items-center gap-2 p-4 text-sm text-slate-500"><RefreshCw size={14} className="animate-spin" /> Loading...</p>}
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <p>{totalCount} entr{totalCount === 1 ? "y" : "ies"} total</p>
        <div className="flex items-center gap-2">
          <button onClick={() => goToPage(Math.max(0, page - 1))} disabled={page === 0} className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => goToPage(page + 1)} disabled={page + 1 >= totalPages} className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}

/** Before/after side by side when `details` has that shape (every toggle/setting-change action — see hasBeforeAfter); a plain key/value dump otherwise (staff_print_created, kiosk_command_requested, ...). */
function AuditDetails({ details }: { details: Record<string, unknown> }) {
  if (hasBeforeAfter(details)) {
    const extras = Object.entries(details).filter(([key]) => key !== "before" && key !== "after");
    return (
      <div className="space-y-2 text-xs">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 font-bold uppercase tracking-wide text-slate-400">Before</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-white p-2 text-slate-600">{JSON.stringify(details.before, null, 2)}</pre>
          </div>
          <div>
            <p className="mb-1 font-bold uppercase tracking-wide text-slate-400">After</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-white p-2 text-slate-600">{JSON.stringify(details.after, null, 2)}</pre>
          </div>
        </div>
        {extras.length > 0 && (
          <dl className="grid gap-1 sm:grid-cols-2">
            {extras.map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="font-bold text-slate-400">{key}:</dt>
                <dd className="text-slate-600">{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }

  return (
    <dl className="grid gap-1 text-xs sm:grid-cols-2">
      {Object.entries(details).map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <dt className="font-bold text-slate-400">{key}:</dt>
          <dd className="text-slate-600">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
