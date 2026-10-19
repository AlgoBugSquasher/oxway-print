"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";

// Above this many jobs in one bulk action, a plain click is no longer
// enough — the owner has to type a confirmation word first. A single job
// (or a small handful) stays a one-click confirm; this is specifically
// about a bulk action big enough that a misclick would be costly.
export const BULK_TYPED_WORD_THRESHOLD = 5;

export interface ConfirmActionReasonOption {
  value: string;
  label: string;
}

/**
 * Shared confirmation pop-up for a money-adjacent admin action (refund,
 * refuse-a-refund) — replaces a bare window.confirm() with the full set of
 * safeguards both actions need: initial focus on Cancel (never the
 * destructive button), Escape/outside-click cancel, a confirm button
 * labelled with the actual action and amount, disabled until a reason is
 * chosen (when reasonOptions is given) and while the request is running,
 * and a typed-word requirement once a bulk action crosses
 * BULK_TYPED_WORD_THRESHOLD jobs.
 */
export default function ConfirmActionModal({
  title,
  description,
  confirmLabel,
  confirmWord,
  bulkCount,
  reasonOptions,
  isSubmitting,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  /** e.g. "Yes, refund ₹50.00" or "Yes, refuse refund of ₹50.00" — the action AND the amount, never a bare "Confirm". */
  confirmLabel: string;
  /** The exact word the owner must type for a bulk action at or above BULK_TYPED_WORD_THRESHOLD — e.g. "REFUND" or "REFUSE". Ignored (no typed-word gate) when bulkCount is below the threshold. */
  confirmWord: string;
  bulkCount: number;
  /** When given, a reason select renders and the confirm button stays disabled until one is chosen. */
  reasonOptions?: ConfirmActionReasonOption[];
  isSubmitting: boolean;
  error?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [typedWord, setTypedWord] = useState("");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const needsTypedWord = bulkCount >= BULK_TYPED_WORD_THRESHOLD;
  const needsReason = Boolean(reasonOptions && reasonOptions.length > 0);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const canConfirm = !isSubmitting
    && (!needsReason || reason !== "")
    && (!needsTypedWord || typedWord.trim().toUpperCase() === confirmWord.toUpperCase());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-action-title"
    >
      <div className="w-full max-w-md rounded-[1.5rem] bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="confirm-action-title" className="text-lg font-black">{title}</h2>
          <button onClick={onCancel} className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Cancel">
            <X size={16} />
          </button>
        </div>

        <p className="text-sm text-slate-600">{description}</p>

        {needsReason && (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-bold text-slate-500">Reason</span>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Select a reason…</option>
              {reasonOptions!.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}

        {needsTypedWord && (
          <label className="mt-4 block">
            <span className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-amber-700">
              <AlertTriangle size={13} /> This affects {bulkCount} jobs — type {confirmWord} to confirm
            </span>
            <input
              type="text"
              value={typedWord}
              onChange={(event) => setTypedWord(event.target.value)}
              placeholder={confirmWord}
              className="w-full rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm font-bold uppercase tracking-wide outline-none focus:border-amber-500"
            />
          </label>
        )}

        {error && <p className="mt-3 text-xs font-medium text-red-500">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(needsReason ? reason : undefined)}
            disabled={!canConfirm}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-black text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? <RefreshCw className="animate-spin" size={14} /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
