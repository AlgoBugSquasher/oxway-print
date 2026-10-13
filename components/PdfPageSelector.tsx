"use client";

// Must stay the very first import — it's a side-effect-only polyfill that
// has to be in place before pdfjs-dist's own code ever runs. See that
// file's own docstring for why this exists alongside (not instead of) the
// pdfjs-dist/legacy import just below.
import "@/lib/polyfills/map-get-or-insert";

import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { load as loadCashfree } from "@cashfreepayments/cashfree-js";
import confetti from "canvas-confetti";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  FileText,
  FileUp,
  LayoutGrid,
  Minus,
  Moon,
  Palette,
  Phone,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Sun,
  WifiOff,
  X,
} from "lucide-react";
// The "legacy" build, not the bare `pdfjs-dist` (which resolves to the
// modern build) — ROADMAP-style fix for a real iPhone 15/15 Plus Safari
// crash: pdf.js's own transport/message-handler code calls
// `Map.prototype.getOrInsertComputed`, a method new enough (2024/2025 TC39)
// that plenty of iOS Safari installs still don't have it natively. The
// modern build assumes it's always there; the legacy build bundles its own
// core-js polyfill for it (confirmed directly in pdfjs-dist's own published
// files — the modern build has zero such polyfill code at all). Android
// Chrome was never affected, which is exactly consistent with this: V8
// shipped the method earlier than Safari's WebKit did.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RealtimeChannel } from "@supabase/supabase-js";
import BrandWatermark from "@/components/BrandWatermark";
import BrandWordmark from "@/components/BrandWordmark";
import LivePrintPreview from "@/components/LivePrintPreview";
import { convertFileInBrowser, isImageFile, isSupportedClientFile } from "@/lib/client-file-converter";
import { reportClientError } from "@/lib/client-log";
import { fetchJson } from "@/lib/fetch-json";
import { loadRazorpayCheckout } from "@/lib/loadRazorpay";
import type { CreateOrderOutput } from "@/lib/payment";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { uploadFileWithProgress } from "@/lib/upload-with-progress";

// Resolved by the bundler (new URL(..., import.meta.url), the standard
// pattern pdf.js itself documents for Webpack-family bundlers, Turbopack
// included) rather than a CDN URL — the CDN previously served the file at
// a version-matched path, but always the *modern* build, meaning switching
// just the main thread to legacy while the worker stayed on the CDN would
// have reintroduced the exact mismatch this task warned against (main
// thread and worker must be the same build, not just the same version).
// Resolving it this way also means Next.js copies the real file into the
// production build output and serves it from this app's own domain — no
// dependency on a third-party CDN being reachable/correctly configured on
// Vercel, which is the real answer to "bundled and served correctly in
// production," not just "works in dev."
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

interface PageThumbnail {
  pageNumber: number;
  dataUrl: string;
}

type PageMode = "all" | "odd" | "even" | "custom";
type PaperSize = "A4" | "Letter" | "Legal";
type Layout = "portrait" | "landscape";

/** Mirrors lib/store.ts JobStatus, plus a local "idle" state before any order exists. */
type OrderStatus =
  | "idle"
  | "pending_payment"
  | "paid"
  | "printing"
  | "printed"
  | "print_failed"
  | "payment_failed"
  | "expired"
  | "cancelled";

type PrintSettings = {
  copies: number;
  layout: Layout;
  isColor: boolean;
  pageMode: PageMode;
  customRange: string;
  paperSize: PaperSize;
  pagesPerSheet: 1 | 2 | 4;
};

// Matches MAX_UPLOAD_FILE_SIZE_BYTES in lib/config.ts (server-side, re-checked
// there against the actual uploaded bytes — this is only ever a fast local
// check). Raised from the old 25MB now that the file uploads directly to
// Supabase Storage (see handleStartPayment below) instead of through a
// Vercel serverless function's request body, which is what actually
// capped uploads around ~4.5MB regardless of what this constant said.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PRICE_BW = 1;
const PRICE_COLOR = 10;
// Once a job reaches one of these, nothing about it changes again — no point
// still polling or staying subscribed to Realtime for it.
const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["printed", "print_failed", "payment_failed", "expired", "cancelled"];
// Not latency-sensitive (see the kiosk online/offline signal's own doc) — a
// device outage or recovery showing up within ~15s is plenty responsive for
// a banner, so this stays a plain poll rather than Realtime.
const KIOSK_STATUS_POLL_INTERVAL_MS = 12_000;

/**
 * Short beep via the Web Audio API rather than shipping/loading an audio
 * file — one self-contained function, nothing to fetch or fail to load.
 */
function playPrintReadySound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.onended = () => void context.close();
  } catch {
    // Web Audio unavailable/blocked — the desktop notification below still gets through.
  }
}

/** Fires the "your print is ready" browser notification + sound. Permission is requested once on mount (see the effect below); if it was never granted, this just skips the Notification and the sound still plays. */
function notifyPrintReady() {
  playPrintReadySound();
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("Your print is ready", { body: "Please collect it from the kiosk." });
  }
}
// WhatsApp opt-in re-enables ROADMAP.md §1's phone collection, now gated
// behind an explicit checkbox rather than always collected — same 10-digit
// Indian mobile pattern §1 already validated against.
const PHONE_PATTERN = /^[6-9]\d{9}$/;

function parsePageRange(value: string, totalPages: number) {
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

export default function PdfPageSelector() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [settings, setSettings] = useState<PrintSettings>({
    copies: 1,
    layout: "portrait",
    isColor: false,
    pageMode: "all",
    customRange: "",
    paperSize: "A4",
    pagesPerSheet: 1,
  });
  // WhatsApp opt-in — re-enabled ROADMAP.md §1 phone collection, but only
  // collected/validated when notifyOptIn is checked. The server ignores
  // both regardless of what the client sends when it's false (see
  // app/api/create-order/route.ts) — this UI is only a mirror of that.
  const [notifyOptIn, setNotifyOptIn] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [orderStatus, setOrderStatus] = useState<OrderStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  // ROADMAP.md §22 — the customer's own pickup code, filled in from the
  // status poll below once payment's confirmed (never shown before that —
  // see the ticketNumber comment in app/api/verify-payment/route.ts).
  const [ticketNumber, setTicketNumber] = useState<number | null>(null);
  // Set only once an auto-refund for this job genuinely succeeded (see
  // lib/refund.ts) — distinguishes "print_failed, refunded" from the much
  // worse "print_failed, and the refund itself failed too" for the
  // print_failed messaging further down.
  const [refundedAt, setRefundedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 0-100 while the raw file itself is uploading directly to Supabase
  // Storage (see handleStartPayment) — null the rest of the time,
  // including during the brief order-creation/gateway step right after,
  // which isLoading alone already covers.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // Holds the converted PDF's bytes so the final file can be uploaded again at
  // payment time — pdfjs consumes the response body when rendering thumbnails.
  const pdfBytesRef = useRef<Uint8Array | null>(null);

  // Which kiosk this customer scanned (?k=<kiosk-id> in the QR URL) — a lazy
  // initializer rather than an effect+setState, since it never needs to
  // change after mount (matches how handleStartPayment already reads the
  // same param below, both avoiding next/navigation's useSearchParams so
  // this component doesn't need a Suspense boundary just for this).
  const [kioskId] = useState(() => (typeof window === "undefined" ? "oxway_01" : new URLSearchParams(window.location.search).get("k") || "oxway_01"));

  // Device online/offline heartbeat signal — polled independently of order
  // status, since it's relevant both before and after payment. The same
  // response also carries the admin's color/B&W availability toggle, so
  // both live on this one poll rather than a second interval hitting the
  // same route.
  const [isKioskOnline, setIsKioskOnline] = useState(true);
  const [allowColor, setAllowColor] = useState(true);
  const [allowBw, setAllowBw] = useState(true);
  // Remote "Update kiosk" command in flight (pending or running) — new
  // orders are blocked while this is true, both here (UI mirror) and
  // server-side in app/api/create-order/route.ts, same pattern as the
  // color-mode gate just above.
  const [isKioskUpdating, setIsKioskUpdating] = useState(false);
  // Owner-only admin toggle — defaults false (matching allow_whatsapp's own
  // schema default) rather than true like allowColor/allowBw above, so the
  // opt-in section never flashes on screen for a kiosk where it's actually
  // off, only to disappear a moment later once the first poll resolves.
  const [allowWhatsapp, setAllowWhatsapp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{ isOnline: boolean; allowColor: boolean; allowBw: boolean; isUpdating: boolean; allowWhatsapp: boolean }>(`/api/kiosk-status/${kioskId}`);
        if (cancelled) return;
        setIsKioskOnline(data.isOnline);
        setAllowColor(data.allowColor);
        setAllowBw(data.allowBw);
        setIsKioskUpdating(data.isUpdating);
        setAllowWhatsapp(data.allowWhatsapp);
      } catch {
        // Best-effort — a failed check just skips this tick rather than flipping the banner on.
      }
    };
    void poll();
    const interval = setInterval(poll, KIOSK_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [kioskId]);

  // If the admin disables the color mode the customer currently has
  // selected, switch them to whichever mode is still allowed — never leave
  // them sitting on a mode that create-order will now reject. No-ops (same
  // settings object returned) once already on an allowed mode, so this
  // doesn't fight the customer's own choice on every poll tick.
  useEffect(() => {
    // queueMicrotask defers past this effect's own synchronous body, same
    // reason/pattern as the Layout-reconversion effect above.
    queueMicrotask(() => {
      setSettings((current) => {
        if (current.isColor && !allowColor && allowBw) return { ...current, isColor: false };
        if (!current.isColor && !allowBw && allowColor) return { ...current, isColor: true };
        return current;
      });
    });
  }, [allowColor, allowBw]);

  // If the owner turns WhatsApp off for this kiosk while the customer
  // already had the opt-in checked, clear it (and whatever phone they'd
  // typed) rather than leaving a hidden, no-longer-visible "opted in" state
  // sitting in memory — the opt-in section itself stops rendering below the
  // moment allowWhatsapp is false, so nothing here is ever shown to undo.
  useEffect(() => {
    if (allowWhatsapp) return;
    queueMicrotask(() => {
      setNotifyOptIn(false);
      setPhone("");
      setPhoneTouched(false);
    });
  }, [allowWhatsapp]);

  // Guards the "printed" notification/sound so it fires exactly once per job,
  // not on every subsequent update while status stays "printed".
  const notifiedPrintedForJobRef = useRef<string | null>(null);

  // Notification permission is requested once, non-blockingly, on load — the
  // customer never has to do anything for the payment/print flow to keep
  // working even if they dismiss or ignore the browser's prompt.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  const isPhoneValid = PHONE_PATTERN.test(phone);

  const activePages = useMemo(() => {
    if (settings.pageMode === "all") return selectedPages;
    if (settings.pageMode === "odd") return selectedPages.filter((page) => page % 2 === 1);
    if (settings.pageMode === "even") return selectedPages.filter((page) => page % 2 === 0);
    return parsePageRange(settings.customRange, totalPages).filter((page) => selectedPages.includes(page));
  }, [selectedPages, settings.customRange, settings.pageMode, totalPages]);

  const billableSheets = Math.ceil(activePages.length / settings.pagesPerSheet) * settings.copies;
  // Never includes the pickup-ID banner — it's mandatory on every job (see
  // app/api/create-order/route.ts, which hardcodes includeBannerPage: true
  // server-side regardless of what the client sends) but absorbed as a
  // business cost, not itemized into the customer's price.
  const totalPrice = billableSheets * (settings.isColor ? PRICE_COLOR : PRICE_BW);
  const updateSettings = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const processFile = async (uploadedFile: File) => {
    setError("");
    if (!isSupportedClientFile(uploadedFile)) return setError("Unsupported file. Upload a PDF, PNG, JPG, JPEG, WEBP, HEIC, HEIF, or DOCX file.");
    if (uploadedFile.size > MAX_FILE_SIZE) return setError("This file is larger than the 50 MB kiosk limit.");
    setFile(uploadedFile);
    setIsLoading(true);
    setThumbnails([]);
    const isBrowserPreviewableImage = uploadedFile.type.startsWith("image/") && !/\.(heic|heif)$/i.test(uploadedFile.name) && !["image/heic", "image/heif"].includes(uploadedFile.type);
    setPreviewUrl(isBrowserPreviewableImage ? URL.createObjectURL(uploadedFile) : "");
    setOrderStatus("idle");
    setJobId(null);
    pdfBytesRef.current = null;

    // Diagnostic context for reportClientError below — added specifically to
    // debug iPhone 15/15 Plus Safari PDF-upload failures that can't be
    // reproduced on desktop. `stage` records how far processing got before
    // it broke, `stallTimer` catches the other failure shape a thrown error
    // can't: pdf.js's worker (see the workerSrc setup at the top of this
    // file) hanging instead of rejecting, which would otherwise leave the
    // "Preparing your document..." spinner running forever with nothing in
    // any log at all.
    const fileMeta = { name: uploadedFile.name, type: uploadedFile.type, size: uploadedFile.size };
    let stage = "convert";
    let settled = false;
    const stallTimer = setTimeout(() => {
      if (!settled) reportClientError("upload-stalled", new Error(`Still stuck at "${stage}" after 15s`), fileMeta);
    }, 15000);

    try {
      stage = "convert";
      const normalizedPdfBytes = await convertFileInBrowser(uploadedFile, settings.layout);
      pdfBytesRef.current = normalizedPdfBytes;
      stage = "pdfjs-load";
      const pdf = await pdfjsLib.getDocument({ data: normalizedPdfBytes.slice() }).promise;
      setTotalPages(pdf.numPages);
      setSelectedPages(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
      const renderedPages: PageThumbnail[] = [];
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
        renderedPages.push({ pageNumber, dataUrl: canvas.toDataURL("image/jpeg", 0.8) });
      }
      setThumbnails(renderedPages);
    } catch (loadError) {
      reportClientError(`upload-failed:${stage}`, loadError, fileMeta);
      setFile(null);
      setPreviewUrl("");
      // pdf.js itself (getDocument/getPage/render) is the one stage whose
      // thrown errors are internal engine details, not something written
      // for a customer to read — e.g. the exact "getOrInsertComputed is
      // not a function" crash this file's pdfjs-dist import was fixed for.
      // convertFileInBrowser's own errors (lib/client-file-converter.ts),
      // by contrast, are already written in plain language, so those still
      // surface as-is.
      const isPdfjsStage = stage === "pdfjs-load" || stage.startsWith("render-page");
      setError(
        isPdfjsStage
          ? "Couldn't read this file, please try another."
          : loadError instanceof Error ? loadError.message : "We could not read this file. Please try another one."
      );
    } finally {
      settled = true;
      clearTimeout(stallTimer);
      setIsLoading(false);
    }
  };

  // Images bake their canvas shape (portrait vs landscape) in at conversion
  // time (see imageToPdf in lib/client-file-converter.ts) rather than
  // relying on the server's later whole-page rotation — necessary so a wide
  // photo actually fills a landscape page instead of being pre-shrunk into
  // a narrow portrait frame first. That means an image upload has to be
  // re-converted if the customer changes Layout after uploading, unlike a
  // PDF/DOCX upload, where the server-side rotation step still has the
  // real page shape to work with and never needs this. Skipped once an
  // order exists (orderStatus !== "idle") so a stray Layout change can
  // never reset jobId/orderStatus out from under an order already in
  // flight — reaching the settings panel at that point isn't a real UI
  // path today, but this guard costs nothing and removes the question.
  useEffect(() => {
    if (!file || !isImageFile(file) || orderStatus !== "idle") return;
    // queueMicrotask defers past processFile's own synchronous setState
    // calls (setError/setFile/setIsLoading, before its first await) — those
    // are the whole point of calling it here, just not synchronously within
    // this effect's own body.
    queueMicrotask(() => void processFile(file));
    // Intentionally narrow — only a Layout change should trigger a
    // reconversion; processFile/file/orderStatus in this list would turn
    // every processFile call (including this one) into another effect run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.layout]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (uploadedFile) void processFile(uploadedFile);
    event.target.value = "";
  };

  const togglePage = (pageNumber: number) => setSelectedPages((pages) => pages.includes(pageNumber) ? pages.filter((page) => page !== pageNumber) : [...pages, pageNumber].sort((a, b) => a - b));

  const handlePhoneChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/\D/g, "").slice(0, 10);
    setPhone(digitsOnly);
  };

  // Creates the order with whichever gateway is live (PAYMENT_PROVIDER env var
  // on the server) and opens that gateway's own checkout modal — Card /
  // Netbanking / UPI (with its own QR), for both Cashfree and Razorpay.
  // Actual payment confirmation and printing happen server-side: this
  // component never trusts the modal's own success callback by itself, it
  // just kicks off polling (see the effect below) which asks the server,
  // which asks the gateway directly.
  const handleStartPayment = async () => {
    if (!file || !pdfBytesRef.current || activePages.length === 0) return setError("Select at least one page before paying.");
    if (isKioskUpdating) return setError("This kiosk is being updated right now — please try again in a minute.");
    // Phone is only required when the customer opted into WhatsApp updates.
    if (notifyOptIn && !isPhoneValid) {
      setPhoneTouched(true);
      return setError("Enter a valid 10-digit phone number, or untick WhatsApp updates.");
    }
    setError("");
    setIsLoading(true);
    try {
      // kioskId (state, above) is read from the QR's ?k=<kiosk-id> param on
      // mount; only sent when explicitly present so the server's own
      // single-kiosk default still applies otherwise.
      const paramKioskId = new URLSearchParams(window.location.search).get("k");

      // Step 1: ask for a place to put the file — the file itself never
      // goes through our own server's request body, only this tiny JSON
      // call does (see app/api/create-upload-url/route.ts for why: a
      // multi-MB body sent straight to a Vercel serverless function used
      // to come back as an opaque 413, well under this kiosk's own stated
      // size limit).
      const pdfBlob = new Blob([pdfBytesRef.current.slice().buffer], { type: "application/pdf" });
      const uploadTarget = await fetchJson<{ path: string; token: string; signedUrl: string }>("/api/create-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: pdfBlob.size, contentType: "application/pdf" }),
      });

      // Step 2: upload directly to Supabase Storage with that signed URL —
      // this is the request that actually carries the file's bytes, and it
      // never touches our own server at all.
      setUploadProgress(0);
      await uploadFileWithProgress(uploadTarget.signedUrl, pdfBlob, (fraction) => setUploadProgress(Math.round(fraction * 100)));
      setUploadProgress(null);

      // Step 3: create the order from the storage path alone — this
      // request is just metadata (page selection, settings, price), tiny
      // regardless of how large the actual file was.
      const order = await fetchJson<{ jobId: string } & CreateOrderOutput>("/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: uploadTarget.path,
          fileName: file.name,
          selectedPages: activePages,
          settings,
          totalPrice,
          notifyOptIn,
          // Only sent when opted in — the server never collects/stores a
          // phone number otherwise, regardless of whatever stale value
          // might be in this field (e.g. typed, then the checkbox
          // unticked again).
          phone: notifyOptIn ? phone : undefined,
          kioskId: paramKioskId || undefined,
        }),
      });

      setJobId(order.jobId);
      setOrderStatus("pending_payment");

      if (order.provider === "cashfree") {
        const cashfree = await loadCashfree({ mode: "sandbox" });
        if (!cashfree) throw new Error("Cashfree Checkout could not be loaded");
        void cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: "_modal" });
      } else {
        await loadRazorpayCheckout();
        if (!window.Razorpay) throw new Error("Razorpay Checkout could not be loaded");
        const razorpay = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: "INR",
          name: "OXWAY Print Kiosk",
          description: file.name,
          order_id: order.providerOrderId,
          theme: { color: "#2563eb" },
          // Only pre-fills when the customer actually opted in and gave a
          // valid number — Razorpay's own prefill field, nothing sent to
          // our server differently either way.
          prefill: notifyOptIn && isPhoneValid ? { contact: phone } : undefined,
          // Intentionally a no-op — polling below confirms with Razorpay directly.
          handler: () => {},
          modal: {},
        });
        razorpay.open();
      }
    } catch (paymentError) {
      console.error("Payment order error:", paymentError);
      setError(paymentError instanceof Error ? paymentError.message : "Payment could not be started.");
      setOrderStatus("idle");
    } finally {
      setIsLoading(false);
      setUploadProgress(null);
    }
  };

  // Shared by both the poll effect and the Realtime subscription below, so
  // "what a status change means for the UI" (confetti, error text, the
  // print-ready notification) lives in exactly one place regardless of which
  // path delivered it.
  const applyStatusUpdate = (forJobId: string, next: { status: OrderStatus; error?: string | null; ticketNumber?: number | null; refundedAt?: string | null }) => {
    if (next.ticketNumber !== undefined) setTicketNumber(next.ticketNumber ?? null);
    if (next.refundedAt !== undefined) setRefundedAt(next.refundedAt ?? null);
    setOrderStatus((current) => {
      if (next.status === current) return current;
      if (next.status === "paid" || next.status === "printed") {
        confetti({ particleCount: next.status === "printed" ? 100 : 80, spread: 75, origin: { y: 0.7 } });
      }
      if (next.status === "print_failed" || next.status === "payment_failed") {
        setError(next.error || "Something went wrong. Please see kiosk staff.");
      }
      if (next.status === "printed" && notifiedPrintedForJobRef.current !== forJobId) {
        notifiedPrintedForJobRef.current = forJobId;
        notifyPrintReady();
      }
      return next.status;
    });
  };

  // Polls the server for real payment/print status. While pending_payment,
  // this is what actually triggers the server-side gateway reconciliation
  // (not just a status read) so it has to keep running regardless of
  // Realtime. Once paid, the Realtime subscription below is the *instant*
  // path, but this keeps running too — always, not just when Realtime
  // looks disconnected. A Realtime channel reporting "SUBSCRIBED" only
  // means the websocket handshake succeeded; it does NOT mean print_jobs
  // is actually in the Supabase Realtime publication, which is a separate,
  // easy-to-forget dashboard setting. Gating this poll on "Realtime looks
  // connected" meant a channel that subscribes fine but is silently
  // misconfigured (never added to the publication) left the customer stuck
  // on a stale "starting print" status forever, with nothing visibly
  // wrong — exactly the bug this was rewritten to stop being able to
  // happen. Realtime is still what makes updates feel instant when it's
  // actually working; this is just the guarantee that they arrive at all
  // either way.
  useEffect(() => {
    if (!jobId) return;
    if (TERMINAL_ORDER_STATUSES.includes(orderStatus)) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{ jobId: string; status: OrderStatus; error?: string; etaMinutes?: number; ticketNumber?: number; refundedAt?: string | null }>(`/api/verify-payment?jobId=${jobId}`);
        if (cancelled) return;
        setEtaMinutes(data.etaMinutes ?? null);
        applyStatusUpdate(jobId, { status: data.status, error: data.error, ticketNumber: data.ticketNumber, refundedAt: data.refundedAt });
      } catch (pollError) {
        console.error("Status poll error:", pollError);
      }
    };
    const interval = setInterval(poll, orderStatus === "pending_payment" ? 3000 : 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, orderStatus]);

  // Instant print-ready signal (ROADMAP.md-style CUPS-spool -> Realtime
  // wiring): the print agent updates the job's row the moment CUPS confirms
  // completion, and this subscription pushes that straight into the UI
  // instead of waiting on the next poll tick. Requires print_jobs to be
  // added to the Realtime publication in the Supabase dashboard — see this
  // repo's setup notes. If that's never been done (or the socket drops),
  // this channel can still silently report itself "subscribed" without ever
  // receiving a row change — the poll effect above no longer trusts that
  // status for anything, it just keeps running regardless, so this is purely
  // an accelerator, never a single point of failure for status updates.
  useEffect(() => {
    if (!jobId) return;
    if (TERMINAL_ORDER_STATUSES.includes(orderStatus)) return;

    let channel: RealtimeChannel | null = null;
    try {
      const supabase = createSupabaseBrowserClient();
      channel = supabase
        .channel(`print-job-${jobId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "print_jobs", filter: `id=eq.${jobId}` },
          (payload) => {
            const row = payload.new as { status: OrderStatus; error: string | null; ticket_number: number | null; refunded_at: string | null };
            applyStatusUpdate(jobId, { status: row.status, error: row.error, ticketNumber: row.ticket_number, refundedAt: row.refunded_at });
          }
        )
        .subscribe();
    } catch (realtimeError) {
      // Missing Supabase env vars, etc. — non-fatal, the poll fallback above covers it.
      console.error("Realtime subscription error:", realtimeError);
    }

    return () => {
      if (channel) void channel.unsubscribe();
    };
  }, [jobId, orderStatus]);

  const resetOrder = () => {
    setOrderStatus("idle");
    setJobId(null);
    setEtaMinutes(null);
    setTicketNumber(null);
    setRefundedAt(null);
    setError("");
  };

  const theme = isDark ? "bg-[#101419] text-slate-100" : "bg-[#f4f6f8] text-slate-950";
  const panel = isDark ? "border-white/10 bg-white/[0.06]" : "border-slate-200 bg-white";
  const muted = isDark ? "text-slate-400" : "text-slate-500";

  return <div className={`min-h-screen pb-36 transition-colors duration-300 ${theme}`}>
    <header className={`sticky top-0 z-20 border-b backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/85" : "border-slate-200/80 bg-[#f4f6f8]/85"}`}><div className="mx-auto flex max-w-6xl flex-wrap items-center gap-y-2 px-5 py-4 lg:px-8"><div className="flex items-center gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20"><Printer size={19} /></div><div><BrandWordmark className="h-10" /><p className={`mt-1.5 text-xs ${muted}`}>Smart print kiosk</p></div></div><div className="ml-auto flex items-center gap-2">{isKioskOnline
      ? <span className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-500"><span className="size-1.5 rounded-full bg-emerald-500" />Online</span>
      : <span className="flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-500"><span className="size-1.5 rounded-full bg-amber-500" />Offline</span>}<Link href="/admin" className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${isDark ? "border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/10" : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100"}`}>Admin</Link><button aria-label="Toggle color theme" onClick={() => setIsDark((value) => !value)} className={`grid size-10 place-items-center rounded-xl border ${panel}`}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</button></div></div></header>
    {!isKioskOnline && <div className="mx-auto max-w-6xl px-5 pt-4 lg:px-8"><div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-600"><WifiOff size={18} className="mt-0.5 shrink-0" /><p>This kiosk isn&apos;t reachable right now — it may be powered off or have no network connection. Printing will resume once it&apos;s back online.</p></div></div>}
    {isKioskUpdating && <div className="mx-auto max-w-6xl px-5 pt-4 lg:px-8"><div className="flex items-start gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm font-medium text-blue-600"><RefreshCw size={18} className="mt-0.5 shrink-0" /><p>This kiosk is being updated right now. New orders will resume automatically in a minute or two.</p></div></div>}
    {/* The entire replacement for what an SMS would have told the customer
       (ROADMAP.md §22) — deliberately the single biggest, highest-contrast
       thing on this whole screen once it exists, not just a slightly bigger
       number tucked into the status bar. Readable at arm's length is the
       actual design requirement here, not a nice-to-have. */}
    {ticketNumber !== null && orderStatus !== "idle" && orderStatus !== "pending_payment" && (
      <div className="mx-auto max-w-6xl px-5 pt-6 lg:px-8">
        <div className={`flex flex-col items-center rounded-[2rem] border-2 border-blue-600 px-6 py-8 text-center shadow-xl shadow-blue-600/10 ${isDark ? "bg-blue-600/15" : "bg-blue-50"}`}>
          <p className="text-xs font-black uppercase tracking-[0.35em] text-blue-600">Your pickup code</p>
          <p className="mt-2 text-[5.5rem] font-black leading-none tracking-tight text-blue-600 sm:text-[8rem]">#{String(ticketNumber).padStart(3, "0")}</p>
        </div>
      </div>
    )}
    <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1fr_330px] lg:px-8"><section className="min-w-0"><div className="mb-7 flex items-end justify-between gap-4"><div><p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-500">01 / Upload</p><h1 className="text-3xl font-black tracking-tight sm:text-4xl">Print without the queue.</h1><p className={`mt-2 text-sm ${muted}`}>Upload a PDF, tune your print settings, and send it straight to the kiosk.</p></div>{file && <button onClick={() => fileInputRef.current?.click()} className="hidden rounded-xl border border-blue-500/30 px-3 py-2 text-xs font-bold text-blue-500 sm:block">Change file</button>}</div><button type="button" onClick={() => setIsPreviewOpen(true)} className={`mb-4 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-bold ${panel}`}><span>Preview print</span><span className="text-blue-500">View sheet</span></button>
      <input ref={fileInputRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={handleFileInput} />
      {!file && !isLoading && <button type="button" onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={(event) => { event.preventDefault(); setIsDragging(false); const droppedFile = event.dataTransfer.files[0]; if (droppedFile) void processFile(droppedFile); }} className={`group flex min-h-[320px] w-full flex-col items-center justify-center rounded-[2rem] border-2 border-dashed p-8 text-center transition ${isDragging ? "border-blue-500 bg-blue-500/10" : `${isDark ? "border-white/15 bg-white/[0.04]" : "border-slate-300 bg-white/70 hover:border-blue-300 hover:bg-white"}`}`}><span className="mb-5 grid size-16 place-items-center rounded-3xl bg-blue-600 text-white shadow-xl shadow-blue-600/20 transition group-hover:-translate-y-1"><FileUp size={27} /></span><span className="text-lg font-bold">Drop your file here</span><span className={`mt-2 text-sm ${muted}`}>PDF, image, or Word document</span><span className={`mt-6 rounded-full px-3 py-1 text-[11px] ${isDark ? "bg-white/10 text-slate-300" : "bg-slate-100 text-slate-500"}`}>PDF · PNG · JPG · HEIC · DOCX · max 50 MB</span></button>}
      {isLoading && <div className={`flex min-h-[320px] flex-col items-center justify-center rounded-[2rem] border p-8 ${panel}`}>{previewUrl && <img src={previewUrl} alt="Uploaded image preview" className="mb-5 max-h-48 max-w-full rounded-xl object-contain shadow-md" />}<RefreshCw className="mb-4 animate-spin text-blue-500" size={30} /><p className="font-semibold">Preparing your document...</p><p className={`mt-1 text-sm ${muted}`}>Converting to a printable A4 PDF</p></div>}
      {file && !isLoading && <><div className={`mb-5 flex items-center gap-4 rounded-2xl border p-4 ${panel}`}><div className="grid size-11 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-500"><FileText size={21} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{file.name}</p><p className={`mt-1 text-xs ${muted}`}>{(file.size / (1024 * 1024)).toFixed(2)} MB · {totalPages} pages</p></div><button onClick={() => fileInputRef.current?.click()} className="rounded-xl p-2 text-blue-500 sm:hidden"><RefreshCw size={17} /></button></div><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">02 / Select pages</p><p className={`mt-1 text-sm ${muted}`}>{activePages.length} active pages · tap a page to include or exclude</p></div><div className="flex gap-2"><button onClick={() => setSelectedPages(Array.from({ length: totalPages }, (_, index) => index + 1))} className="text-xs font-bold text-blue-500">All</button><button onClick={() => setSelectedPages([])} className={`text-xs font-bold ${muted}`}>Clear</button></div></div><div className={`grid max-h-[560px] grid-cols-2 gap-3 overflow-y-auto rounded-3xl border p-3 sm:grid-cols-3 xl:grid-cols-4 ${isDark ? "border-white/10 bg-white/[0.03]" : "border-slate-200 bg-slate-100/70"}`}>{thumbnails.map((thumbnail) => { const selected = selectedPages.includes(thumbnail.pageNumber); return <button key={thumbnail.pageNumber} onClick={() => togglePage(thumbnail.pageNumber)} className={`relative overflow-hidden rounded-2xl border-2 bg-white p-1 text-left transition hover:-translate-y-0.5 ${selected ? "border-blue-500 shadow-lg shadow-blue-500/10" : "border-transparent opacity-45 grayscale"}`}><img src={thumbnail.dataUrl} alt={`Page ${thumbnail.pageNumber}`} className="aspect-[1/1.35] w-full object-contain" /><span className="absolute left-3 top-3 rounded-md bg-white/90 px-1.5 py-1 text-[10px] font-black text-slate-600">{thumbnail.pageNumber}</span><span className="absolute right-3 top-3 text-blue-600">{selected ? <CheckCircle2 size={19} fill="white" /> : <Circle size={19} />}</span></button>; })}</div></>}
      {error && <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
    </section><aside className="lg:pt-[86px]"><div className={`rounded-[2rem] border p-5 shadow-xl shadow-slate-900/5 ${panel}`}><div className="mb-5 flex items-center justify-between"><div><p className={`text-xs font-bold uppercase tracking-[0.2em] ${muted}`}>Print order</p><p className="mt-1 text-lg font-black">Configure output</p></div><Settings2 className="text-blue-500" size={19} /></div><div className={`mb-4 rounded-2xl p-4 ${isDark ? "bg-blue-500/10" : "bg-blue-50"}`}><div className="flex items-center justify-between"><span className={`text-xs font-semibold ${muted}`}>Estimated total</span><span className="text-2xl font-black text-blue-600">₹{totalPrice}</span></div><div className={`mt-2 text-xs ${muted}`}>{billableSheets} billable sheets · {activePages.length} pages · {settings.copies} {settings.copies === 1 ? "copy" : "copies"}</div></div>
      {allowWhatsapp && (
        <div className={`mb-4 rounded-xl border p-3 ${isDark ? "border-white/10" : "border-slate-200"}`}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={notifyOptIn}
              onChange={(event) => setNotifyOptIn(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-blue-600"
            />
            <span className="text-sm font-bold">Going far from the kiosk?</span>
          </label>
          <p className={`mt-1.5 ml-6 text-xs ${muted}`}>We&apos;ll WhatsApp you when your print is ready.</p>
          {notifyOptIn && (
            <div className="ml-6 mt-3">
              <label htmlFor="phone" className={`mb-1.5 flex items-center gap-1.5 text-xs font-bold ${muted}`}><Phone size={13} className="text-blue-500" /> WhatsApp number</label>
              <input
                id="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={phone}
                onChange={handlePhoneChange}
                onBlur={() => setPhoneTouched(true)}
                placeholder="98765 43210"
                className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-blue-500 ${phoneTouched && !isPhoneValid ? "border-red-500/60" : isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`}
              />
              {phoneTouched && !isPhoneValid && <p className="mt-1.5 text-xs font-medium text-red-500">Enter a valid 10-digit phone number.</p>}
            </div>
          )}
        </div>
      )}
      <button onClick={() => setIsSettingsOpen(true)} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-bold ${isDark ? "border-white/10" : "border-slate-200"}`}><span className="flex items-center gap-2"><LayoutGrid size={16} className="text-blue-500" /> Print settings</span><ChevronDown size={16} className={muted} /></button><div className={`mt-4 space-y-3 text-xs ${muted}`}><div className="flex justify-between"><span>Color mode</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.isColor ? "Color" : "B&W"}</b></div><div className="flex justify-between"><span>Paper</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.paperSize} · {settings.layout}</b></div><div className="flex justify-between"><span>Pages per sheet</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.pagesPerSheet}</b></div></div></div></aside></main>
    <BrandWatermark isDark={isDark} />
    {file && <div className={`fixed bottom-0 left-0 right-0 z-30 border-t backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/90" : "border-slate-200 bg-white/90"}`}><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 lg:px-8">
      {/* The ticket code itself now lives in the big hero banner above
         <main> (see ticketNumber !== null below) — this slot stays on
         price throughout, rather than duplicating the same number twice
         on screen at two very different sizes. */}
      <div><p className={`text-xs font-bold uppercase tracking-[0.15em] ${muted}`}>Total payable</p><p className="text-2xl font-black">₹{totalPrice}</p></div>
      {orderStatus === "idle" && <button onClick={handleStartPayment} disabled={isLoading || activePages.length === 0 || isKioskUpdating} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">{uploadProgress !== null ? <span>Uploading... {uploadProgress}%</span> : isLoading ? <RefreshCw className="animate-spin" size={17} /> : <span>Pay ₹{totalPrice}</span>}</button>}
      {orderStatus === "pending_payment" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Waiting for payment...</div>}
      {orderStatus === "paid" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Payment confirmed, starting print{etaMinutes ? ` · ~${etaMinutes} min` : "..."}</div>}
      {orderStatus === "printing" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><Printer size={17} /> Printing your document{etaMinutes ? ` · ~${etaMinutes} min` : "..."}</div>}
      {orderStatus === "printed" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-5 py-3.5 text-sm font-black text-emerald-500"><Check size={17} /> Your print is ready — please collect it</div>}
      {orderStatus === "expired" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3.5 text-sm font-black text-white">Payment expired — try again</button>}
      {orderStatus === "payment_failed" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-red-500 px-5 py-3.5 text-sm font-black text-white">Failed — try again</button>}
      {/* print_failed always triggers an auto-refund attempt (lib/refund.ts)
         — "try again" is misleading here regardless (the failure was
         physical, not something resubmitting fixes), and a bare "Failed"
         silently hides whether the customer actually got their money back.
         refundedAt (only set once the refund genuinely succeeded at the
         gateway) is what tells these two apart. */}
      {orderStatus === "print_failed" && (refundedAt
        ? <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3.5 text-sm font-black text-white"><Check size={17} /> Refunded — see kiosk staff to try again</button>
        : <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-red-500 px-5 py-3.5 text-sm font-black text-white">Failed — see kiosk staff for a refund</button>)}
      {orderStatus === "cancelled" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-slate-500 px-5 py-3.5 text-sm font-black text-white">Cancelled — see kiosk staff</button>}
    </div></div>}
    {isSettingsOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSettingsOpen(false); }}><div className={`w-full max-w-lg rounded-t-[2rem] p-6 shadow-2xl sm:rounded-[2rem] ${isDark ? "bg-[#171d24]" : "bg-white"}`}><div className="mb-6 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Print settings</p><h2 className="mt-1 text-xl font-black">Tune your document</h2></div><button onClick={() => setIsSettingsOpen(false)} className={`grid size-9 place-items-center rounded-xl ${isDark ? "bg-white/10" : "bg-slate-100"}`}><X size={17} /></button></div><div className="space-y-5"><SettingRow label="Copies" icon={<Copy size={16} />}><div className={`flex items-center gap-1 rounded-xl border p-1 ${isDark ? "border-white/10" : "border-slate-200"}`}><button onClick={() => updateSettings("copies", Math.max(1, settings.copies - 1))} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Minus size={15} /></button><span className="w-8 text-center text-sm font-black">{settings.copies}</span><button onClick={() => updateSettings("copies", settings.copies + 1)} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Plus size={15} /></button></div></SettingRow><SettingRow label="Layout" icon={<LayoutGrid size={16} />}><Segmented value={settings.layout} options={["portrait", "landscape"]} onChange={(value) => updateSettings("layout", value as Layout)} /></SettingRow><SettingRow label="Color mode" icon={<Palette size={16} />}><Segmented value={settings.isColor ? "color" : "bw"} options={["bw", "color"]} labels={["B&W · ₹1", "Color · ₹10"]} disabledOptions={[...(!allowBw ? ["bw"] : []), ...(!allowColor ? ["color"] : [])]} onChange={(value) => updateSettings("isColor", value === "color")} /></SettingRow><div><p className={`mb-2 text-sm font-bold ${muted}`}>Pages</p><div className="grid grid-cols-4 gap-2">{(["all", "odd", "even", "custom"] as PageMode[]).map((mode) => <button key={mode} onClick={() => updateSettings("pageMode", mode)} className={`rounded-xl border px-2 py-2.5 text-xs font-bold capitalize ${settings.pageMode === mode ? "border-blue-500 bg-blue-500/10 text-blue-500" : isDark ? "border-white/10" : "border-slate-200"}`}>{mode}</button>)}</div>{settings.pageMode === "custom" && <input value={settings.customRange} onChange={(event) => updateSettings("customRange", event.target.value)} placeholder="Example: 1-5, 8" className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-blue-500 ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`} />}</div><SettingRow label="Paper size" icon={<FileText size={16} />}><select value={settings.paperSize} onChange={(event) => updateSettings("paperSize", event.target.value as PaperSize)} className={`rounded-xl border px-3 py-2 text-xs font-bold outline-none ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`}>{(["A4", "Letter", "Legal"] as PaperSize[]).map((size) => <option key={size}>{size}</option>)}</select></SettingRow><SettingRow label="Pages per sheet" icon={<LayoutGrid size={16} />}><Segmented value={String(settings.pagesPerSheet)} options={["1", "2", "4"]} labels={["1", "2 in 1", "4 in 1"]} onChange={(value) => updateSettings("pagesPerSheet", Number(value) as 1 | 2 | 4)} /></SettingRow></div><button onClick={() => setIsSettingsOpen(false)} className="mt-7 w-full rounded-xl bg-blue-600 py-3.5 text-sm font-black text-white">Apply settings</button></div></div>}
    {/* Preview used to also render as an always-open floating panel on
       desktop, sitting over the page-selection grid whether you wanted it
       or not. Now button-triggered on every screen size, same as it
       already was on mobile — one modal, one behavior. */}
    {isPreviewOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-5"><div className="max-h-[90vh] overflow-y-auto rounded-[2rem] bg-white p-5"><LivePrintPreview settings={settings} activePages={activePages} thumbnails={thumbnails} imagePreviewUrl={previewUrl} fileType={file?.type} isOpen onClose={() => setIsPreviewOpen(false)} /></div></div>}
  </div>;
}

function SettingRow({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-sm font-bold text-slate-500">{icon}{label}</span>{children}</div>;
}

function Segmented({ value, options, labels = options, disabledOptions = [], onChange }: { value: string; options: string[]; labels?: string[]; disabledOptions?: string[]; onChange: (value: string) => void }) {
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
