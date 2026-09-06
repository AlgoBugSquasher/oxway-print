"use client";

import { X } from "lucide-react";

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
  if (!isOpen) return null;

  const previewPages = activePages.slice(0, settings.pagesPerSheet);
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
        <span className="text-[11px] font-semibold text-slate-500">{settings.pagesPerSheet} per sheet</span>
      </div>
      <div className={`relative overflow-hidden rounded-sm border border-slate-300 bg-white p-[15px] shadow-[0_18px_45px_rgba(15,23,42,0.18)] transition-all duration-300 ${sheetClass}`}>
        <div className="pointer-events-none absolute inset-[15px] rounded-[1px] border border-dashed border-blue-400/70" aria-label="Printable safe margin" />
        <div className={`relative grid h-full w-full gap-2 ${pageGridClass} ${settings.isColor ? "" : "[filter:grayscale(100%)_contrast(105%)]"}`}>
          {previewPages.length === 0 && <div className="grid place-items-center text-center text-xs text-slate-400">Upload a document to preview it</div>}
          {previewPages.map((pageNumber) => (
            <div key={pageNumber} className="flex min-h-0 items-center justify-center overflow-hidden bg-white">
              {isImage && imagePreviewUrl ? (
                <img src={imagePreviewUrl} alt="Uploaded print preview" className="max-h-full max-w-full object-contain" />
              ) : previewByPage.get(pageNumber) ? (
                <img src={previewByPage.get(pageNumber)} alt={`Preview of page ${pageNumber}`} className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-[10px] text-slate-400">Page {pageNumber}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-slate-500">Dashed line marks the 20px safe print margin.</p>
    </div>
  );
}
