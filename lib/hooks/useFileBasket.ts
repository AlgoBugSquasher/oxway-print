"use client";

// Must stay the very first import — it's a side-effect-only polyfill that
// has to be in place before pdfjs-dist's own code ever runs (this hook is
// now the only place in the app that touches pdfjs-dist — see the
// workerSrc setup below). See that file's own docstring for why this
// exists alongside (not instead of) the pdfjs-dist/legacy import just below.
import "@/lib/polyfills/map-get-or-insert";

import { useCallback, useEffect, useRef, useState } from "react";
// The "legacy" build, not the bare `pdfjs-dist` (which resolves to the
// modern build) — fixes a real iPhone 15/15 Plus Safari crash: pdf.js's own
// transport/message-handler code calls `Map.prototype.getOrInsertComputed`,
// a method new enough (2024/2025 TC39) that plenty of iOS Safari installs
// still don't have it natively. The legacy build bundles its own core-js
// polyfill for it; the modern build doesn't.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertFileInBrowser, isImageFile, isSupportedClientFile } from "@/lib/client-file-converter";
import { reportClientError } from "@/lib/client-log";

// Resolved by the bundler (new URL(..., import.meta.url)) rather than a CDN
// URL, so Next.js copies the real worker file into the production build and
// serves it from this app's own domain — see PdfPageSelector.tsx's history
// for why a CDN URL (always the *modern* build) caused a main-thread/worker
// build mismatch.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

type Layout = "portrait" | "landscape";

export interface BasketPageThumbnail {
  pageNumber: number;
  dataUrl: string;
}

export type FileBasketItemStatus = "converting" | "ready" | "error";

export interface FileBasketItem {
  id: string;
  file: File;
  status: FileBasketItemStatus;
  /** Only meaningful when status is "error" — empty string otherwise. */
  error: string;
  totalPages: number;
  thumbnails: BasketPageThumbnail[];
  /** Object URL for a browser-previewable image (not HEIC/HEIF) — "" otherwise. Caller-visible so the UI can show it while this item is still converting. */
  previewUrl: string;
  selectedPages: number[];
  /** The converted, print-ready PDF bytes — null until status is "ready". */
  pdfBytes: Uint8Array | null;
  /** Non-empty only for a converted .docx with a reported conversion problem (mammoth's own warnings, or a wildly-off page-count estimate) — see lib/client-file-converter.ts's docxToPdf. Always empty for a PDF/image. */
  conversionWarnings: string[];
}

/** Same per-file ceiling the kiosk has always had — matches MAX_UPLOAD_FILE_SIZE_BYTES in lib/config.ts (server-side, re-checked there against the actual uploaded bytes). */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
/**
 * New, multi-file-only limits. Deliberately modest for now: the actual
 * submit step (PdfPageSelector.tsx's handleStartPayment) still only ever
 * uploads/charges for the first file in the basket until a later merge step
 * connects the rest — see this hook's own module docstring note there isn't
 * one; search handleStartPayment instead. These limits bound what the UI
 * lets a customer *build up* in the meantime, not what gets billed today.
 */
export const MAX_FILES_PER_BASKET = 10;
export const MAX_COMBINED_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_PAGES_PER_BASKET = 300;

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isBrowserPreviewableImage(file: File): boolean {
  return file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name) && !["image/heic", "image/heif"].includes(file.type);
}

function formatMb(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

function makeConvertingItem(file: File): FileBasketItem {
  return {
    id: makeId(),
    file,
    status: "converting",
    error: "",
    totalPages: 0,
    thumbnails: [],
    previewUrl: isBrowserPreviewableImage(file) ? URL.createObjectURL(file) : "",
    selectedPages: [],
    pdfBytes: null,
    conversionWarnings: [],
  };
}

function makeErrorItem(file: File, error: string): FileBasketItem {
  return { id: makeId(), file, status: "error", error, totalPages: 0, thumbnails: [], previewUrl: "", selectedPages: [], pdfBytes: null, conversionWarnings: [] };
}

/** Friendlier messages for the two pdf.js failure modes worth telling apart from a generic "couldn't read this file" — both confirmed exported from pdfjs-dist's own public API, not assumed. */
function describePdfjsError(error: unknown): string {
  if (error instanceof pdfjsLib.PasswordException) return "This PDF is password-protected — remove the password and try again.";
  if (error instanceof pdfjsLib.InvalidPDFException) return "This file appears to be corrupted or isn't a valid PDF.";
  return "Couldn't read this file, please try another.";
}

interface ConversionResult {
  totalPages: number;
  thumbnails: BasketPageThumbnail[];
  pdfBytes: Uint8Array;
  conversionWarnings: string[];
}
type ConversionOutcome = { ok: true; result: ConversionResult } | { ok: false; error: string };

/**
 * Converts one already-accepted file into print-ready thumbnails — the same
 * work PdfPageSelector.tsx's old single-file processFile did, now run per
 * basket item. Never throws: callers always get a result or a friendly
 * error message.
 *
 * `stage`/`stallTimer` are diagnostic context for reportClientError, added
 * to debug iPhone 15/15 Plus Safari PDF-upload failures that can't be
 * reproduced on desktop: `stage` records how far processing got before it
 * broke, `stallTimer` catches the failure shape a thrown error can't —
 * pdf.js's worker hanging instead of rejecting.
 */
async function convertOneFile(file: File, layout: Layout): Promise<ConversionOutcome> {
  const fileMeta = { name: file.name, type: file.type, size: file.size };
  let stage = "convert";
  let settled = false;
  const stallTimer = setTimeout(() => {
    if (!settled) reportClientError("basket-upload-stalled", new Error(`Still stuck at "${stage}" after 15s`), fileMeta);
  }, 15000);

  try {
    stage = "convert";
    const { bytes: pdfBytes, warnings: conversionWarnings } = await convertFileInBrowser(file, layout);
    stage = "pdfjs-load";
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    const thumbnails: BasketPageThumbnail[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      stage = `render-page-${pageNumber}`;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 0.38 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      const devicePixelRatio = window.devicePixelRatio || 2;
      canvas.width = Math.floor(viewport.width * devicePixelRatio);
      canvas.height = Math.floor(viewport.height * devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      if (!context) continue;
      context.scale(devicePixelRatio, devicePixelRatio);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      thumbnails.push({ pageNumber, dataUrl: canvas.toDataURL("image/jpeg", 0.8) });
    }
    return { ok: true, result: { totalPages: pdf.numPages, thumbnails, pdfBytes, conversionWarnings } };
  } catch (loadError) {
    reportClientError(`basket-upload-failed:${stage}`, loadError, fileMeta);
    // pdf.js itself (getDocument/getPage/render) is the one stage whose
    // thrown errors are internal engine details, not something written for
    // a customer to read. convertFileInBrowser's own errors (HEIC/DOCX
    // conversion), by contrast, are already written in plain language, so
    // those surface as-is.
    const isPdfjsStage = stage === "pdfjs-load" || stage.startsWith("render-page");
    const error = isPdfjsStage
      ? describePdfjsError(loadError)
      : loadError instanceof Error ? loadError.message : "We could not read this file. Please try another one.";
    return { ok: false, error };
  } finally {
    settled = true;
    clearTimeout(stallTimer);
  }
}

function swap<T>(array: T[], i: number, j: number): T[] {
  const copy = [...array];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

export interface UseFileBasketOptions {
  /** The global Layout setting — only matters for image files, which bake their canvas shape in at conversion time (see imageToPdf in lib/client-file-converter.ts). Every image item is re-converted whenever this changes. */
  layout: Layout;
  /** Mirrors `orderStatus === "idle"` in the host component — add/remove/reorder and layout-triggered re-conversion all become no-ops once a payment is in progress or has succeeded, so a file an order was already created from can't be swapped out from under it. */
  enabled: boolean;
}

export interface UseFileBasketResult {
  items: FileBasketItem[];
  /** True while any item is still converting — callers typically use this to disable "Pay" the same way the old single-file isLoading did. */
  isProcessing: boolean;
  /** Set when addFiles rejects one or more files outright (basket full, or would exceed the combined size limit) — distinct from a per-item error, which shows inline on that item's own card instead. */
  basketError: string;
  addFiles: (files: FileList | File[]) => void;
  removeFile: (id: string) => void;
  moveUp: (id: string) => void;
  moveDown: (id: string) => void;
  togglePage: (id: string, pageNumber: number) => void;
  selectAllPages: (id: string) => void;
  clearPages: (id: string) => void;
}

/**
 * Owns the customer page's multi-file state: the list of files, each one's
 * client-side conversion to a print-ready PDF (and its thumbnails/page
 * selection), reordering, and the three basket-wide limits (file count,
 * combined size, combined page count) — everything PdfPageSelector.tsx used
 * to track as half a dozen separate useState calls for a single file.
 *
 * Deliberately does NOT own global print settings (layout/color/paper/
 * copies/pagesPerSheet) — those stay a single shared PrintSettings object
 * in the host component, same as before; only `layout` is read here,
 * because only it affects client-side conversion. It also does not decide
 * price or which pages are "active" under the pageMode/customRange filters
 * — that logic already lives in the host component and keeps working the
 * same way per item.
 */
export function useFileBasket({ layout, enabled }: UseFileBasketOptions): UseFileBasketResult {
  const [items, setItems] = useState<FileBasketItem[]>([]);
  const [basketError, setBasketError] = useState("");

  // Kept in sync via the effect below so callbacks/effects that only care
  // about "the current list" (adding new items, re-converting on layout
  // change) don't need `items` in their own dependency arrays — that would
  // either cause stale reads or re-run far more often than the change
  // they're actually reacting to.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const runConversion = useCallback((id: string, file: File, targetLayout: Layout) => {
    void convertOneFile(file, targetLayout).then((outcome) => {
      setItems((current) => current.map((item) => {
        if (item.id !== id) return item;
        if (!outcome.ok) return { ...item, status: "error", error: outcome.error };

        const othersTotal = current.filter((other) => other.id !== id).reduce((sum, other) => sum + other.totalPages, 0);
        if (othersTotal + outcome.result.totalPages > MAX_TOTAL_PAGES_PER_BASKET) {
          return { ...item, status: "error", error: `Adding this file would put the basket over the ${MAX_TOTAL_PAGES_PER_BASKET}-page limit — remove another file first.` };
        }

        return {
          ...item,
          status: "ready",
          error: "",
          totalPages: outcome.result.totalPages,
          thumbnails: outcome.result.thumbnails,
          pdfBytes: outcome.result.pdfBytes,
          conversionWarnings: outcome.result.conversionWarnings,
          selectedPages: Array.from({ length: outcome.result.totalPages }, (_, index) => index + 1),
        };
      }));
    });
  }, []);

  const addFiles = useCallback((fileListOrArray: FileList | File[]) => {
    if (!enabled) return;
    const incoming = Array.from(fileListOrArray);
    if (incoming.length === 0) return;

    const accepted: FileBasketItem[] = [];
    const toConvert: FileBasketItem[] = [];
    const rejectionNotes: string[] = [];

    let combinedSize = itemsRef.current.reduce((sum, item) => sum + item.file.size, 0);
    let slotsLeft = MAX_FILES_PER_BASKET - itemsRef.current.length;

    for (const file of incoming) {
      if (slotsLeft <= 0) {
        rejectionNotes.push(`"${file.name}" (basket limit of ${MAX_FILES_PER_BASKET} files reached)`);
        continue;
      }
      if (!isSupportedClientFile(file)) {
        accepted.push(makeErrorItem(file, "Unsupported file. Upload a PDF, PNG, JPG, JPEG, WEBP, HEIC, HEIF, or DOCX file."));
        slotsLeft -= 1;
        combinedSize += file.size;
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        accepted.push(makeErrorItem(file, `This file is larger than the ${formatMb(MAX_FILE_SIZE_BYTES)} MB per-file limit.`));
        slotsLeft -= 1;
        combinedSize += file.size;
        continue;
      }
      if (combinedSize + file.size > MAX_COMBINED_FILE_SIZE_BYTES) {
        rejectionNotes.push(`"${file.name}" (would exceed the ${formatMb(MAX_COMBINED_FILE_SIZE_BYTES)} MB combined basket limit)`);
        continue;
      }

      slotsLeft -= 1;
      combinedSize += file.size;
      const item = makeConvertingItem(file);
      accepted.push(item);
      toConvert.push(item);
    }

    setBasketError(rejectionNotes.length > 0 ? `Couldn't add ${rejectionNotes.join(", ")}.` : "");
    if (accepted.length > 0) setItems((current) => [...current, ...accepted]);
    toConvert.forEach((item) => runConversion(item.id, item.file, layout));
  }, [enabled, layout, runConversion]);

  const removeFile = useCallback((id: string) => {
    if (!enabled) return;
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, [enabled]);

  const moveUp = useCallback((id: string) => {
    if (!enabled) return;
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      return index <= 0 ? current : swap(current, index, index - 1);
    });
  }, [enabled]);

  const moveDown = useCallback((id: string) => {
    if (!enabled) return;
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      return index === -1 || index >= current.length - 1 ? current : swap(current, index, index + 1);
    });
  }, [enabled]);

  const togglePage = useCallback((id: string, pageNumber: number) => {
    setItems((current) => current.map((item) => item.id !== id ? item : {
      ...item,
      selectedPages: item.selectedPages.includes(pageNumber)
        ? item.selectedPages.filter((page) => page !== pageNumber)
        : [...item.selectedPages, pageNumber].sort((a, b) => a - b),
    }));
  }, []);

  const selectAllPages = useCallback((id: string) => {
    setItems((current) => current.map((item) => item.id !== id ? item : { ...item, selectedPages: Array.from({ length: item.totalPages }, (_, index) => index + 1) }));
  }, []);

  const clearPages = useCallback((id: string) => {
    setItems((current) => current.map((item) => item.id !== id ? item : { ...item, selectedPages: [] }));
  }, []);

  // Re-converts every image item whenever Layout changes — mirrors the old
  // single-file effect exactly (narrow deps on purpose: only a Layout
  // change should trigger this, not every basket mutation, which is why
  // itemsRef/enabled are read via refs rather than listed as deps).
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabledRef.current) return;
    itemsRef.current.forEach((item) => {
      if (!isImageFile(item.file)) return;
      setItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: "converting", error: "" } : it)));
      runConversion(item.id, item.file, layout);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return {
    items,
    isProcessing: items.some((item) => item.status === "converting"),
    basketError,
    addFiles,
    removeFile,
    moveUp,
    moveDown,
    togglePage,
    selectAllPages,
    clearPages,
  };
}
