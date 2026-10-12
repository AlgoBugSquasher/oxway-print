"use client";

import { useSyncExternalStore } from "react";

// Same cached-clock pattern as kiosk-card.tsx's own silence indicator (see
// that file's long comment on why Date.now() can't be read directly inside
// useSyncExternalStore's snapshot function) — ticking every 1s here instead
// of every 30s, since "Updated Xs ago" needs to actually move visibly.
let cachedNow = Date.now();
function subscribeToClock(callback: () => void) {
  const interval = setInterval(() => {
    cachedNow = Date.now();
    callback();
  }, 1000);
  return () => clearInterval(interval);
}
function getClockSnapshot() {
  return cachedNow;
}
// Server-rendered once with a fixed snapshot to avoid a hydration mismatch —
// irrelevant here in practice (every admin page using this is already
// "use client" with its own loading state before real data exists), but
// matches the same safe-default convention as kiosk-card.tsx.
function getServerClockSnapshot() {
  return 0;
}

/**
 * Small, shared "is this page actually live" readout — every admin page
 * polling via lib/hooks/useAutoRefresh.ts renders one of these next to its
 * own manual Refresh button, so there's one consistent way to see the
 * dashboard is updating itself rather than needing to trust that silently.
 */
export default function LiveIndicator({ isRefreshing, lastUpdatedAt }: { isRefreshing: boolean; lastUpdatedAt: number | null }) {
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const secondsAgo = lastUpdatedAt !== null ? Math.max(0, Math.floor((now - lastUpdatedAt) / 1000)) : null;

  return (
    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
      <span className={`size-1.5 rounded-full ${isRefreshing ? "animate-pulse bg-blue-500" : "bg-emerald-500"}`} />
      {isRefreshing && secondsAgo === null ? "Loading…" : isRefreshing ? "Updating…" : secondsAgo !== null ? `Updated ${secondsAgo}s ago` : "Live"}
    </span>
  );
}
