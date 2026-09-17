"use client";

import { type FormEvent, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Pencil, RefreshCw, Save, WifiOff } from "lucide-react";
import { updateKioskCounters } from "@/lib/admin/actions";
import type { AdminKioskRow } from "@/lib/admin/types";

const LOW_SUPPLY_THRESHOLD = 0.9;
// Mirrors lib/config.ts's KIOSK_SILENT_THRESHOLD_MINUTES — kept as a plain
// constant rather than importing that module client-side, since it also
// exports functions that touch payment-provider env vars this bundle has no
// reason to carry.
const SILENT_THRESHOLD_MINUTES = 10;

// The current time is a classic external, self-changing value — not
// something to compute with Date.now() during render (impure, breaks
// React's concurrent-rendering assumptions). useSyncExternalStore is the
// React-recommended tool for exactly this case, rather than an effect that
// setStates a clock tick.
//
// getClockSnapshot must NOT call Date.now() itself — useSyncExternalStore
// calls the snapshot function on every render (not just after subscribe's
// callback fires) to check whether a re-render is actually needed, and
// Date.now() is a different value on essentially every call. That made
// React see "the store changed" on every single check, forever — an
// infinite render loop ("Maximum update depth exceeded"), not just a
// theoretical risk. The fix: only capture a new value when the interval
// actually ticks; snapshot reads just return that cached value.
let cachedNow = Date.now();
function subscribeToClock(callback: () => void) {
  const interval = setInterval(() => {
    cachedNow = Date.now();
    callback();
  }, 30_000);
  return () => clearInterval(interval);
}
function getClockSnapshot() {
  return cachedNow;
}
// Server-rendered once with a fixed snapshot to avoid a hydration mismatch;
// 0 always reads as "not silent" (a huge negative minutesSinceLastSeen),
// which is the safe default until the client's real clock takes over.
function getServerClockSnapshot() {
  return 0;
}

export default function KioskCard({ kiosk, onChanged }: { kiosk: AdminKioskRow; onChanged: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [trayPages, setTrayPages] = useState(String(kiosk.tray_pages));
  const [trayMaxPages, setTrayMaxPages] = useState(String(kiosk.tray_max_pages));
  const [cartridgePages, setCartridgePages] = useState(String(kiosk.cartridge_pages));
  const [cartridgeMaxPages, setCartridgeMaxPages] = useState(String(kiosk.cartridge_max_pages));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const trayRatio = kiosk.tray_pages / kiosk.tray_max_pages;
  const cartridgeRatio = kiosk.cartridge_pages / kiosk.cartridge_max_pages;
  const lowSupply = trayRatio >= LOW_SUPPLY_THRESHOLD || cartridgeRatio >= LOW_SUPPLY_THRESHOLD;

  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const minutesSinceLastSeen = (now - new Date(kiosk.updated_at).getTime()) / 60_000;
  const isSilent = minutesSinceLastSeen >= SILENT_THRESHOLD_MINUTES;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsSaving(true);
    try {
      await updateKioskCounters({
        kioskId: kiosk.id,
        trayPages: Number(trayPages),
        trayMaxPages: Number(trayMaxPages),
        cartridgePages: Number(cartridgePages),
        cartridgeMaxPages: Number(cartridgeMaxPages),
      });
      setIsEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update counters.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`rounded-2xl border p-5 ${isSilent ? "border-amber-300 bg-amber-50" : lowSupply ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-black">{kiosk.id}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isSilent && <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-700"><WifiOff size={11} /> Silent {Math.round(minutesSinceLastSeen)}m</span>}
          {lowSupply && <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-600"><AlertTriangle size={11} /> Low supply</span>}
          <button onClick={() => setIsEditing((value) => !value)} className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Edit counters">
            <Pencil size={13} />
          </button>
        </div>
      </div>

      {!isEditing ? (
        <div className="space-y-2 text-xs">
          <div className="flex justify-between"><span className="text-slate-500">Tray</span><b>{kiosk.tray_pages} / {kiosk.tray_max_pages} sheets ({Math.round(trayRatio * 100)}%)</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Cartridge</span><b>{kiosk.cartridge_pages} / {kiosk.cartridge_max_pages} pages ({Math.round(cartridgeRatio * 100)}%)</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Lifetime prints</span><b>{kiosk.total_lifetime_prints}</b></div>
          {kiosk.total_revenue !== null && <div className="flex justify-between"><span className="text-slate-500">Revenue</span><b>&#8377;{Number(kiosk.total_revenue).toFixed(2)}</b></div>}
          <div className="flex justify-between"><span className="text-slate-500">Last updated</span><b>{new Date(kiosk.updated_at).toLocaleString("en-IN")}</b></div>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <CounterField label="Tray — pages used" value={trayPages} onChange={setTrayPages} />
          <CounterField label="Tray — max capacity" value={trayMaxPages} onChange={setTrayMaxPages} />
          <CounterField label="Cartridge — pages used" value={cartridgePages} onChange={setCartridgePages} />
          <CounterField label="Cartridge — max capacity" value={cartridgeMaxPages} onChange={setCartridgeMaxPages} />
          {error && <p className="text-xs font-medium text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={isSaving} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">
              {isSaving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />} Save
            </button>
            <button type="button" onClick={() => setIsEditing(false)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function CounterField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-slate-500">{label}</span>
      <input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs outline-none focus:border-blue-500" />
    </label>
  );
}
