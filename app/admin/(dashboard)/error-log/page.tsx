"use client";

import { Fragment, useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, ShieldAlert } from "lucide-react";
import { useAdminRole } from "@/lib/admin/role-context";
import { ERROR_AREAS, type ErrorArea } from "@/lib/error-areas";
import { useAutoRefresh } from "@/lib/hooks/useAutoRefresh";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import LiveIndicator from "../live-indicator";

/** Rows per page — same fixed convention as the audit log page. */
const PAGE_SIZE = 25;

interface ErrorLogRow {
  id: number;
  created_at: string;
  reference_code: string;
  area: ErrorArea;
  message: string;
  details: Record<string, unknown> | null;
  user_agent: string | null;
}

interface ErrorLogFilters {
  area: string;
  referenceCode: string;
}

const EMPTY_FILTERS: ErrorLogFilters = { area: "", referenceCode: "" };

export default function AdminErrorLogPage() {
  const role = useAdminRole();

  const [entries, setEntries] = useState<ErrorLogRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);

  // Same draft/applied split as the audit log page — typing in the search
  // box never touches the actual query until submitted, so a background
  // refresh re-running the last *applied* search can't clobber a half-typed one.
  const [draftFilters, setDraftFilters] = useState<ErrorLogFilters>(EMPTY_FILTERS);
  const appliedFiltersRef = useRef<ErrorLogFilters>(EMPTY_FILTERS);

  const fetchData = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const f = appliedFiltersRef.current;

    let query = supabase
      .from("error_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (f.area) query = query.eq("area", f.area);
    // Reference codes are short and case-insensitive to the person reading
    // them off a screen — ilike matches regardless of how they typed it.
    if (f.referenceCode.trim()) query = query.ilike("reference_code", f.referenceCode.trim());

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    setEntries((data as ErrorLogRow[]) ?? []);
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
        <p className="text-sm font-semibold">The error log is owner-only. Even if this page loaded, the database would refuse to return any rows — see the &quot;Owner reads error_logs&quot; policy in supabase/schema.sql.</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Error log</p>
          <h1 className="mt-1 text-2xl font-black">What actually went wrong, by reference code</h1>
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
          <label className="mb-1 block text-xs font-bold text-slate-500">Area</label>
          <select
            value={draftFilters.area}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, area: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500"
          >
            <option value="">All</option>
            {ERROR_AREAS.map((area) => (
              <option key={area} value={area}>{area}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Reference code</label>
          <input
            type="text"
            placeholder="e.g. A7K2"
            value={draftFilters.referenceCode}
            onChange={(event) => setDraftFilters((prev) => ({ ...prev, referenceCode: event.target.value }))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm uppercase outline-none focus:border-blue-500"
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
              <th className="px-4 py-3 font-bold">Ref</th>
              <th className="px-4 py-3 font-bold">Area</th>
              <th className="px-4 py-3 font-bold">Message</th>
              <th className="px-4 py-3 font-bold" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const isExpanded = expandedRowId === entry.id;
              return (
                <Fragment key={entry.id}>
                  <tr className="border-b border-slate-50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{new Date(entry.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                    <td className="px-4 py-3 font-mono font-bold text-slate-700">{entry.reference_code}</td>
                    <td className="px-4 py-3 text-slate-500">{entry.area}</td>
                    <td className="px-4 py-3">{entry.message}</td>
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
                        <pre className="whitespace-pre-wrap rounded-lg bg-white p-2 text-xs text-slate-600">{JSON.stringify(entry.details, null, 2)}</pre>
                        {entry.user_agent && <p className="mt-2 text-xs text-slate-400">{entry.user_agent}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!isLoading && entries.length === 0 && <p className="p-4 text-sm text-slate-500">No errors match this search.</p>}
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
