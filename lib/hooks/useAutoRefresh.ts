"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_INTERVAL_MS = 5_000;
// Kicks in once the SAME failure streak has lasted this many consecutive
// ticks — a lone dropped request shouldn't slow everything else down, only
// a genuinely sustained problem should.
const DEFAULT_BACKOFF_INTERVAL_MS = 15_000;
const CONSECUTIVE_FAILURES_BEFORE_BACKOFF = 2;

export interface UseAutoRefreshOptions {
  intervalMs?: number;
  backoffIntervalMs?: number;
  /**
   * Checked fresh before every *background* tick (not before the initial
   * load or a `refreshNow()` call) — return true to skip that tick
   * entirely, e.g. a form is mid-edit, a confirm() dialog is open, or a
   * save/action is in flight. Prevents a quiet background refresh from
   * overwriting input the admin hasn't saved yet.
   */
  isPaused?: () => boolean;
}

export interface UseAutoRefreshResult {
  /** True while a refresh (of any kind — scheduled, visibility-triggered, or manual) is actually in flight. */
  isRefreshing: boolean;
  /** When the last refresh *succeeded*. Null until the very first one completes — callers typically use that to show a one-time loading skeleton, never again afterward. */
  lastUpdatedAt: number | null;
  /** Only ever set by refreshNow() (the initial load counts as one) — a background tick that fails just counts toward the backoff below, it never pops an error banner for something the admin didn't directly ask for. */
  error: string | null;
  /** Runs `refresh` immediately, outside the normal schedule, and (unlike a background tick) surfaces any failure via `error`. Use for the initial load, a manual "Refresh" click, or right after the admin's own action succeeds. Still a no-op if a refresh is already running — it never stacks either. */
  refreshNow: () => Promise<void>;
}

/**
 * One reusable polling hook for every admin page (ROADMAP-style: "auto
 * dashboard" task) — each page hands it its own data-fetching function and
 * gets back the same refresh lifecycle: an interval, pause-while-hidden,
 * resume-on-visible, no stacked requests, and failure backoff. Deliberately
 * plain polling, not Supabase Realtime — see this task's own instructions
 * for why; a single shared mechanism here is simpler to reason about than
 * a mix of two update channels.
 *
 * `refresh` itself owns zero UI state (no isLoading/setError calls inside
 * it) — it should just fetch and call the page's own setState, then either
 * resolve or throw. This hook is the only thing that decides what a
 * success/failure means for isRefreshing/lastUpdatedAt/error, so every page
 * gets the exact same behavior instead of five slightly different copies.
 */
export function useAutoRefresh(refresh: () => Promise<void>, options: UseAutoRefreshOptions = {}): UseAutoRefreshResult {
  const { intervalMs = DEFAULT_INTERVAL_MS, backoffIntervalMs = DEFAULT_BACKOFF_INTERVAL_MS, isPaused } = options;

  // Refs, not state — `refresh`/`isPaused` are read from inside a
  // setTimeout callback that outlives any single render, so they need the
  // latest closure without re-running the scheduling effect every time the
  // caller passes a new function reference. Written in an effect (not
  // directly in the render body) since mutating a ref during render itself
  // isn't allowed — this still keeps both refs current before anything
  // that reads them (the scheduled timeout, a later event handler) ever
  // runs, which is all this actually needs.
  const refreshRef = useRef(refresh);
  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    refreshRef.current = refresh;
    isPausedRef.current = isPaused;
  });

  const isRunningRef = useRef(false);
  const failureStreakRef = useRef(0);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTick = useCallback(async (surfaceErrors: boolean) => {
    if (isRunningRef.current) return; // Never stack — a slow previous refresh just means this tick is skipped.
    isRunningRef.current = true;
    setIsRefreshing(true);
    try {
      await refreshRef.current();
      failureStreakRef.current = 0;
      setLastUpdatedAt(Date.now());
      if (surfaceErrors) setError(null);
    } catch (err) {
      failureStreakRef.current += 1;
      if (surfaceErrors) setError(err instanceof Error ? err.message : "Could not refresh.");
    } finally {
      isRunningRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  const refreshNow = useCallback(() => runTick(true), [runTick]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = failureStreakRef.current >= CONSECUTIVE_FAILURES_BEFORE_BACKOFF ? backoffIntervalMs : intervalMs;
      timeoutId = setTimeout(async () => {
        // Hidden tabs skip the tick outright (not just "pause the timer") —
        // simpler than tearing down/rebuilding the schedule on every
        // visibility flicker, and `document.visibilityState` is re-checked
        // fresh on every tick regardless of how long the tab was hidden for.
        if (document.visibilityState === "visible" && !isPausedRef.current?.()) {
          await runTick(false);
        }
        scheduleNext();
      }, delay);
    };

    // The very first load behaves like a manual refresh (errors do surface,
    // and it ignores isPaused — there's nothing an admin could be mid-edit
    // of before any data has even loaded once). queueMicrotask defers past
    // this effect's own synchronous body — runTick's setIsRefreshing(true)
    // would otherwise be a same-tick setState-in-effect, same reasoning as
    // the identical pattern elsewhere in this codebase (e.g.
    // components/PdfPageSelector.tsx's queueMicrotask-wrapped effects).
    queueMicrotask(() => void runTick(true));
    scheduleNext();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !isPausedRef.current?.()) void runTick(false);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runTick, intervalMs, backoffIntervalMs]);

  return { isRefreshing, lastUpdatedAt, error, refreshNow };
}
