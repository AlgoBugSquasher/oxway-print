"use client";

import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Download, MessageCircle, Pencil, RefreshCw, RotateCw, Save, WifiOff } from "lucide-react";
import { requestKioskCommand, updateKioskCounters, updateKioskWhatsappAvailability } from "@/lib/admin/actions";
import type { AdminKioskCommandRow, AdminKioskRow } from "@/lib/admin/types";

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

export default function KioskCard({
  kiosk,
  latestCommand,
  isOwner,
  notifyProviderIsConsole,
  onBusyChange,
  onChanged,
}: {
  kiosk: AdminKioskRow;
  latestCommand: AdminKioskCommandRow | null;
  /** Mirrors page.tsx's own totalRevenueKnown signal — the view already nulls owner-only columns for staff, so "did a real value come back" is the same role check RLS already enforces, not a separate client-side guess. */
  isOwner: boolean;
  notifyProviderIsConsole: boolean;
  /** Reports whether this card has an edit/save/command in flight right now — page.tsx feeds this into its useAutoRefresh's isPaused check, so a background refresh never overwrites counters someone's mid-typing or a toggle that's mid-save. */
  onBusyChange: (isBusy: boolean) => void;
  onChanged: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [trayPages, setTrayPages] = useState(String(kiosk.tray_pages));
  const [trayMaxPages, setTrayMaxPages] = useState(String(kiosk.tray_max_pages));
  const [cartridgePages, setCartridgePages] = useState(String(kiosk.cartridge_pages));
  const [cartridgeMaxPages, setCartridgeMaxPages] = useState(String(kiosk.cartridge_max_pages));
  const [allowColor, setAllowColor] = useState(kiosk.allow_color);
  const [allowBw, setAllowBw] = useState(kiosk.allow_bw);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [requestingCommand, setRequestingCommand] = useState<"update" | "restart" | null>(null);
  const [allowWhatsapp, setAllowWhatsapp] = useState(kiosk.allow_whatsapp);
  const [isSavingWhatsapp, setIsSavingWhatsapp] = useState(false);
  const [whatsappError, setWhatsappError] = useState("");

  // Reported up to page.tsx so its background auto-refresh skips this card
  // entirely while there's something here it could clobber — editing the
  // counters form, or any of the three independent saves in flight.
  //
  // One effect, not two — page.tsx passes a fresh `onBusyChange` closure on
  // every one of its own re-renders (including every successful background
  // poll), so this effect's dependency array changes constantly even when
  // `isBusy` itself hasn't. Deliberately set-then-cleanup within the SAME
  // effect: on any re-run, React calls this effect's own previous cleanup
  // (onBusyChange(false)) immediately followed by its new body
  // (onBusyChange(isBusy)), in that order, so the net result after every
  // commit is always correct. Splitting "set" and "unmount cleanup" into
  // two separate effects was tried and is actually wrong: because effects
  // run in declaration order, the second effect's stale cleanup would fire
  // *after* the first effect's fresh update on the very same render,
  // silently resetting busy back to false while still mid-edit.
  const isBusy = isEditing || isSaving || isSavingWhatsapp || requestingCommand !== null;
  useEffect(() => {
    onBusyChange(isBusy);
    return () => onBusyChange(false);
  }, [isBusy, onBusyChange]);

  // Owner-only write, immediate (not folded into the counters form's Save
  // button) — separate RPC, separate concern, see
  // update_kiosk_whatsapp_availability's own comment in supabase/schema.sql
  // for why this isn't just a third parameter on updateKioskCounters.
  const handleToggleWhatsapp = async (nextValue: boolean) => {
    setWhatsappError("");
    setAllowWhatsapp(nextValue); // Optimistic — reverted below on failure.
    setIsSavingWhatsapp(true);
    try {
      await updateKioskWhatsappAvailability(kiosk.id, nextValue);
      onChanged();
    } catch (err) {
      setAllowWhatsapp(!nextValue);
      setWhatsappError(err instanceof Error ? err.message : "Could not update WhatsApp availability.");
    } finally {
      setIsSavingWhatsapp(false);
    }
  };

  // A command still pending or running blocks starting a new one — the
  // request_kiosk_command RPC enforces this for real; this is just the same
  // guard mirrored into the button's disabled state.
  const isCommandInFlight = latestCommand?.status === "pending" || latestCommand?.status === "running";

  const handleRequestCommand = async (command: "update" | "restart") => {
    setCommandError("");
    setRequestingCommand(command);
    try {
      await requestKioskCommand(kiosk.id, command);
      onChanged();
    } catch (err) {
      setCommandError(err instanceof Error ? err.message : `Could not request a ${command}.`);
    } finally {
      setRequestingCommand(null);
    }
  };

  // Client-side pre-check so the customer-facing reason (nothing left to
  // sell) shows up instantly instead of only after a round trip — the RPC's
  // own guard (supabase/schema.sql's update_kiosk_counters) is still the
  // real boundary, this is purely a UX nicety mirroring it.
  const bothDisabled = !allowColor && !allowBw;

  const trayRatio = kiosk.tray_pages / kiosk.tray_max_pages;
  const cartridgeRatio = kiosk.cartridge_pages / kiosk.cartridge_max_pages;
  const lowSupply = trayRatio >= LOW_SUPPLY_THRESHOLD || cartridgeRatio >= LOW_SUPPLY_THRESHOLD;

  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const minutesSinceLastSeen = (now - new Date(kiosk.updated_at).getTime()) / 60_000;
  const isSilent = minutesSinceLastSeen >= SILENT_THRESHOLD_MINUTES;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (bothDisabled) {
      setError("At least one of Color or B&W must stay enabled.");
      return;
    }
    setIsSaving(true);
    try {
      await updateKioskCounters({
        kioskId: kiosk.id,
        trayPages: Number(trayPages),
        trayMaxPages: Number(trayMaxPages),
        cartridgePages: Number(cartridgePages),
        cartridgeMaxPages: Number(cartridgeMaxPages),
        allowColor,
        allowBw,
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
          <div className="flex justify-between"><span className="text-slate-500">Available modes</span><b>{kiosk.allow_color && kiosk.allow_bw ? "Color & B&W" : kiosk.allow_color ? "Color only" : "B&W only"}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Last updated</span><b>{new Date(kiosk.updated_at).toLocaleString("en-IN")}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Agent version</span><b>{kiosk.agent_commit ? kiosk.agent_commit.slice(0, 7) : "not reported yet"}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Agent last booted</span><b>{kiosk.agent_updated_at ? new Date(kiosk.agent_updated_at).toLocaleString("en-IN") : "—"}</b></div>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <label className={`flex items-center gap-1.5 text-xs font-medium ${isOwner ? "text-slate-700" : "text-slate-400"}`}>
              <input
                type="checkbox"
                checked={allowWhatsapp}
                disabled={!isOwner || isSavingWhatsapp}
                onChange={(event) => void handleToggleWhatsapp(event.target.checked)}
                className="size-3.5 accent-blue-600"
              />
              <MessageCircle size={12} className="text-blue-500" /> WhatsApp opt-in {!isOwner && "(owner only)"}
            </label>
            {allowWhatsapp && notifyProviderIsConsole && (
              <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-600">
                <AlertTriangle size={11} /> Messages are only logged, not sent — set NOTIFY_PROVIDER=msg91 to actually deliver them.
              </p>
            )}
            {whatsappError && <p className="mt-1 text-[11px] font-medium text-red-500">{whatsappError}</p>}
          </div>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="flex gap-2">
              <button
                onClick={() => void handleRequestCommand("update")}
                disabled={isCommandInFlight || requestingCommand !== null}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {requestingCommand === "update" || (latestCommand?.status === "running" && latestCommand.command === "update")
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <Download size={12} />}
                Update kiosk
              </button>
              <button
                onClick={() => void handleRequestCommand("restart")}
                disabled={isCommandInFlight || requestingCommand !== null}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                {requestingCommand === "restart" || (latestCommand?.status === "running" && latestCommand.command === "restart")
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <RotateCw size={12} />}
                Restart agent
              </button>
            </div>
            {commandError && <p className="mt-1.5 text-[11px] font-medium text-red-500">{commandError}</p>}
            {latestCommand && !isCommandInFlight && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Last {latestCommand.command}: <span className={latestCommand.status === "failed" ? "font-bold text-red-500" : "font-bold text-emerald-600"}>{latestCommand.status}</span>
                {latestCommand.result ? ` — ${latestCommand.result}` : ""}
                {latestCommand.finished_at ? ` (${new Date(latestCommand.finished_at).toLocaleString("en-IN")})` : ""}
              </p>
            )}
            {isCommandInFlight && <p className="mt-1.5 text-[11px] font-medium text-blue-600">{latestCommand?.command === "update" ? "Updating…" : "Restarting…"} the agent will come back on its own.</p>}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <CounterField label="Tray — pages used" value={trayPages} onChange={setTrayPages} />
          <CounterField label="Tray — max capacity" value={trayMaxPages} onChange={setTrayMaxPages} />
          <CounterField label="Cartridge — pages used" value={cartridgePages} onChange={setCartridgePages} />
          <CounterField label="Cartridge — max capacity" value={cartridgeMaxPages} onChange={setCartridgeMaxPages} />
          <div>
            <span className="mb-1 block text-[11px] font-bold text-slate-500">Available to customers</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <input type="checkbox" checked={allowColor} onChange={(event) => setAllowColor(event.target.checked)} className="size-3.5 accent-blue-600" /> Color
              </label>
              <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <input type="checkbox" checked={allowBw} onChange={(event) => setAllowBw(event.target.checked)} className="size-3.5 accent-blue-600" /> B&amp;W
              </label>
            </div>
            {bothDisabled && <p className="mt-1 text-[11px] font-medium text-red-500">At least one must stay enabled.</p>}
          </div>
          {error && <p className="text-xs font-medium text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={isSaving || bothDisabled} className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50">
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
