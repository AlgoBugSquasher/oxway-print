"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useState } from "react";

interface PageThumbnail {
  pageNumber: number;
  dataUrl: string;
}

interface LivePrintSettings {
  isColor: boolean;
  layout: "portrait" | "landscape";
  pagesPerSheet: 1 | 2 | 4;
}

interface LivePrintPreviewProps {
  settings: LivePrintSettings;
  activePages: number[];
  thumbnails: PageThumbnail[];
  imagePreviewUrl?: string;
  fileType?: string;
  isOpen?: boolean;
  onClose?: () => void;
}

export default function LivePrintPreview({
  settings,
  activePages,
  thumbnails,
  imagePreviewUrl,
  fileType,
  isOpen = true,
  onClose,
}: LivePrintPreviewProps) {
  const [sheetIndex, setSheetIndex] = useState(0);
  if (!isOpen) return null;

  const sheetCount = Math.max(1, Math.ceil(activePages.length / settings.pagesPerSheet));
  const safeSheetIndex = Math.min(sheetIndex, sheetCount - 1);
  const previewPages = activePages.slice(
    safeSheetIndex * settings.pagesPerSheet,
    (safeSheetIndex + 1) * settings.pagesPerSheet
  );
  const isImage = Boolean(imagePreviewUrl && fileType?.startsWith("image/"));
  const previewByPage = new Map(thumbnails.map((thumbnail) => [thumbnail.pageNumber, thumbnail.dataUrl]));
  const sheetClass = settings.layout === "portrait" ? "aspect-[1/1.414]" : "aspect-[1.414/1]";
  const pageGridClass = settings.pagesPerSheet === 1
    ? "grid-cols-1"
    : settings.pagesPerSheet === 2
      ? settings.layout === "portrait" ? "grid-cols-1" : "grid-cols-2"
      : "grid-cols-2";

  return (
    <div className="relative w-full max-w-sm">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close print preview"
          className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-full bg-slate-950/70 text-white lg:hidden"
        >
          <X size={15} />
        </button>
      )}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-500">Live preview</p>
          <p className="mt-1 text-sm font-bold">Your printed sheet</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
          <span>Sheet {safeSheetIndex + 1} / {sheetCount}</span>
          {sheetCount > 1 && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous preview sheet"
                disabled={safeSheetIndex === 0}
                onClick={() => setSheetIndex((index) => Math.max(0, index - 1))}
                className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                aria-label="Next preview sheet"
                disabled={safeSheetIndex === sheetCount - 1}
                onClick={() => setSheetIndex((index) => Math.min(sheetCount - 1, index + 1))}
                className="rounded-md p-1 hover:bg-slate-100 disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </span>
          )}
        </div>
      </div>
      <div className={`relative overflow-hidden rounded-sm border border-slate-300 bg-white p-[15px] shadow-[0_18px_45px_rgba(15,23,42,0.18)] transition-all duration-300 ${sheetClass}`}>
        <div className="pointer-events-none absolute inset-[15px] rounded-[1px] border border-dashed border-blue-400/70" aria-label="Printable safe margin" />
        <div className={`relative grid h-full w-full gap-2 p-3 ${pageGridClass} ${settings.isColor ? "" : "[filter:grayscale(100%)_contrast(105%)]"}`}>
          {previewPages.length === 0 && <div className="grid place-items-center text-center text-xs text-slate-400">Upload a document to preview it</div>}
          {previewPages.map((pageNumber) => (
            <div key={pageNumber} className="flex min-h-0 items-center justify-center overflow-hidden bg-white p-2 text-center">
              {isImage && imagePreviewUrl ? (
                <img src={imagePreviewUrl} alt="Uploaded print preview" className="max-h-full max-w-full object-contain" />
              ) : previewByPage.get(pageNumber) ? (
                <img src={previewByPage.get(pageNumber)} alt={`Preview of page ${pageNumber}`} className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="px-2 text-[11px] leading-relaxed text-slate-500">Page {pageNumber} preview unavailable</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-slate-500">Dashed line marks the 20px safe print margin.</p>
    </div>
  );
}
