"use client";

// Shared between the customer checkout page (PdfPageSelector.tsx) and the
// admin "Print" page (app/admin/(dashboard)/print/page.tsx) — both let
// someone upload files, pick pages, and tune the same print settings; only
// what happens once they click the final button (pay vs. print free)
// differs. Pulled out here so neither page has to duplicate ~150 lines of
// file-card/settings JSX, and so a layout/behavior fix only has to happen
// in one place.

import { AlertTriangle, ChevronDown, ChevronUp, CheckCircle2, Circle, FileText, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { isDocx } from "@/lib/client-file-converter";
import type { FileBasketItem } from "@/lib/hooks/useFileBasket";

export type PageMode = "all" | "odd" | "even" | "custom";
export type PaperSize = "A4" | "Letter" | "Legal";
export type Layout = "portrait" | "landscape";

export interface PrintSettings {
  copies: number;
  layout: Layout;
  isColor: boolean;
  pageMode: PageMode;
  customRange: string;
  paperSize: PaperSize;
  pagesPerSheet: 1 | 2 | 4;
}

export function parsePageRange(value: string, totalPages: number): number[] {
  const pages = new Set<number>();
  for (const token of value.split(",")) {
    const [startText, endText] = token.trim().split("-").map((part) => part.trim());
    const start = Number(startText);
    const end = endText ? Number(endText) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    for (let page = start; page <= Math.min(end, totalPages); page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Applies the global pageMode/customRange filter to one basket item's own selectedPages — each file is filtered independently (there's no merged document yet to number pages across). */
export function itemActivePages(item: FileBasketItem, pageMode: PageMode, customRange: string): number[] {
  if (pageMode === "all") return item.selectedPages;
  if (pageMode === "odd") return item.selectedPages.filter((page) => page % 2 === 1);
  if (pageMode === "even") return item.selectedPages.filter((page) => page % 2 === 0);
  return parsePageRange(customRange, item.totalPages).filter((page) => item.selectedPages.includes(page));
}

export function SettingRow({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-sm font-bold text-slate-500">{icon}{label}</span>{children}</div>;
}

export function Segmented({ value, options, labels = options, disabledOptions = [], onChange }: { value: string; options: string[]; labels?: string[]; disabledOptions?: string[]; onChange: (value: string) => void }) {
  return <div className="flex rounded-xl border border-slate-200 p-1 dark:border-white/10">{options.map((option, index) => {
    const isDisabled = disabledOptions.includes(option);
    return <button
      key={option}
      disabled={isDisabled}
      onClick={() => onChange(option)}
      className={`rounded-lg px-2.5 py-2 text-[11px] font-bold transition ${isDisabled ? "cursor-not-allowed text-slate-300 dark:text-slate-600" : value === option ? "bg-blue-600 text-white" : "text-slate-500"}`}
    >
      {labels[index]}
    </button>;
  })}</div>;
}

/**
 * One row in the file basket — name/size/page-count, its own page-selection
 * grid, and the per-file controls (reorder, remove). All disabled together
 * via `canEdit` once the caller's own flow is past the "still editing"
 * stage (a payment in progress, or a staff print already submitted).
 */
export function FileBasketItemCard({
  item,
  index,
  itemCount,
  isDark,
  muted,
  panel,
  canEdit,
  activePages,
  onRemove,
  onMoveUp,
  onMoveDown,
  onTogglePage,
  onSelectAll,
  onClearPages,
}: {
  item: FileBasketItem;
  index: number;
  itemCount: number;
  isDark: boolean;
  muted: string;
  panel: string;
  canEdit: boolean;
  activePages: number[];
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onTogglePage: (pageNumber: number) => void;
  onSelectAll: () => void;
  onClearPages: () => void;
}) {
  const controlButtonClass = "grid size-11 shrink-0 place-items-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-30";

  return <div className={`rounded-2xl border p-4 ${panel}`}>
    <div className="flex items-center gap-3">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-500"><FileText size={21} /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold">{item.file.name}</p>
        <p className={`mt-1 text-xs ${muted}`}>
          {(item.file.size / (1024 * 1024)).toFixed(2)} MB
          {item.status === "ready" && ` · ${item.totalPages} ${item.totalPages === 1 ? "page" : "pages"}`}
          {item.status === "converting" && " · Preparing..."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={onMoveUp} disabled={!canEdit || index === 0} aria-label={`Move ${item.file.name} up`} className={`${controlButtonClass} text-blue-500 focus-visible:ring-blue-500 ${isDark ? "hover:enabled:bg-blue-500/10" : "hover:enabled:bg-blue-50"}`}><ChevronUp size={18} /></button>
        <button type="button" onClick={onMoveDown} disabled={!canEdit || index === itemCount - 1} aria-label={`Move ${item.file.name} down`} className={`${controlButtonClass} text-blue-500 focus-visible:ring-blue-500 ${isDark ? "hover:enabled:bg-blue-500/10" : "hover:enabled:bg-blue-50"}`}><ChevronDown size={18} /></button>
        <button type="button" onClick={onRemove} disabled={!canEdit} aria-label={`Remove ${item.file.name}`} className={`${controlButtonClass} text-red-500 focus-visible:ring-red-500 ${isDark ? "hover:enabled:bg-red-500/10" : "hover:enabled:bg-red-50"}`}><X size={18} /></button>
      </div>
    </div>

    {item.status === "error" && <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">{item.error}</div>}

    {item.status === "converting" && <div className={`mt-3 flex items-center gap-2 text-xs ${muted}`}><RefreshCw className="animate-spin text-blue-500" size={14} /> Converting to a printable PDF...</div>}

    {isDocx(item.file) && item.status !== "error" && (
      <div className="mt-3 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-700">
        Word files can change layout when printed. For best results upload a PDF — in Word, use File &rarr; Save As &rarr; PDF.
      </div>
    )}

    {item.status === "ready" && item.conversionWarnings.length > 0 && (
      <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <p>This document had some elements (tables, images, or formatting) that may not have converted cleanly. Please check the preview below before paying.</p>
      </div>
    )}

    {item.status === "ready" && <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className={`text-xs ${muted}`}>{activePages.length} active pages · tap a page to include or exclude</p>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onSelectAll} className="text-xs font-bold text-blue-500">All</button>
          <button type="button" onClick={onClearPages} className={`text-xs font-bold ${muted}`}>Clear</button>
        </div>
      </div>
      <div className={`grid max-h-80 grid-cols-3 gap-2 overflow-y-auto rounded-2xl border p-2 sm:grid-cols-4 ${isDark ? "border-white/10 bg-white/[0.03]" : "border-slate-200 bg-slate-100/70"}`}>
        {item.thumbnails.map((thumbnail) => {
          const selected = item.selectedPages.includes(thumbnail.pageNumber);
          return <button key={thumbnail.pageNumber} type="button" onClick={() => onTogglePage(thumbnail.pageNumber)} className={`relative overflow-hidden rounded-xl border-2 bg-white p-1 text-left transition hover:-translate-y-0.5 ${selected ? "border-blue-500 shadow-lg shadow-blue-500/10" : "border-transparent opacity-45 grayscale"}`}>
            <img src={thumbnail.dataUrl} alt={`Page ${thumbnail.pageNumber}`} className="aspect-[1/1.35] w-full object-contain" />
            <span className="absolute left-2 top-2 rounded-md bg-white/90 px-1.5 py-1 text-[10px] font-black text-slate-600">{thumbnail.pageNumber}</span>
            <span className="absolute right-2 top-2 text-blue-600">{selected ? <CheckCircle2 size={16} fill="white" /> : <Circle size={16} />}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
