"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { load as loadCashfree } from "@cashfreepayments/cashfree-js";
import confetti from "canvas-confetti";
import {
  AlertTriangle,
  Check,
  ChevronDown,
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
import type { RealtimeChannel } from "@supabase/supabase-js";
import BrandWatermark from "@/components/BrandWatermark";
import BrandWordmark from "@/components/BrandWordmark";
import LivePrintPreview from "@/components/LivePrintPreview";
import {
  FileBasketItemCard,
  itemActivePages,
  Segmented,
  SettingRow,
  type Layout,
  type PageMode,
  type PaperSize,
  type PrintSettings,
} from "@/components/print-basket-ui";
import { fetchJson } from "@/lib/fetch-json";
import {
  MAX_COMBINED_FILE_SIZE_BYTES,
  MAX_FILES_PER_BASKET,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_PAGES_PER_BASKET,
  useFileBasket,
} from "@/lib/hooks/useFileBasket";
import { detectInAppBrowser } from "@/lib/in-app-browser";
import { reportClientDiagnostic } from "@/lib/client-log";
import { loadRazorpayCheckout } from "@/lib/loadRazorpay";
import type { CreateOrderOutput } from "@/lib/payment";
import { mergeSelectedPdfPages } from "@/lib/pdf-merge";
import { INSTAGRAM_HANDLE, INSTAGRAM_URL } from "@/lib/social-links";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { formatTicketCode } from "@/lib/ticket-code";
import { uploadFileWithProgress } from "@/lib/upload-with-progress";

/** Mirrors lib/store.ts JobStatus, plus a local "idle" state before any order exists. */
type OrderStatus =
  | "idle"
  | "pending_payment"
  | "paid"
  | "printing"
  | "print_blocked"
  | "printed"
  | "print_failed"
  | "payment_failed"
  | "expired"
  | "cancelled"
  /**
   * The print agent restarted while this job was mid-print and, on
   * reboot, CUPS had no record of it — see print-agent/index.ts's
   * reconcileInFlightJobsOnBoot. Unlike print_blocked, nothing will ever
   * change this status again on its own (no watcher is tracking it), so
   * it's included in TERMINAL_ORDER_STATUSES below — there's no point
   * polling/staying subscribed for a status that will never move.
   */
  | "interrupted";

// Once a job reaches one of these, nothing about it changes again — no point
// still polling or staying subscribed to Realtime for it. 'interrupted'
// included for that same reason, not because it "completed" anything.
const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["printed", "print_failed", "payment_failed", "expired", "cancelled", "interrupted"];
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

export default function PdfPageSelector() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickupCardRef = useRef<HTMLDivElement>(null);
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
  const [pickupMode, setPickupMode] = useState<"here" | "later">("here");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // True only while a payment is actually being submitted (upload +
  // create-order + opening the gateway modal) — file conversion no longer
  // sets this; each basket item tracks its own "converting" status instead
  // (see useFileBasket).
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
  // Distinguishes "print_failed, refunded" from "print_failed, still under
  // review" for the print_failed messaging further down. Refunds are no
  // longer automatic: most print_failed jobs sit with refundStatus
  // "pending" for a while before an owner approves one from the admin
  // Refunds page.
  const [refundStatus, setRefundStatus] = useState<string | null>(null);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [stackPosition, setStackPosition] = useState<number | null>(null);
  const [sheetsAhead, setSheetsAhead] = useState<number | null>(null);
  const [isCollecting, setIsCollecting] = useState(false);
  const [error, setError] = useState("");
  // 0-100 while the raw file itself is uploading directly to Supabase
  // Storage (see handleStartPayment) — null the rest of the time,
  // including during the brief order-creation/gateway step right after,
  // which isLoading alone already covers.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // Owns the list of selected files, their client-side conversion, page
  // selection and reordering — see lib/hooks/useFileBasket.ts. Disabled
  // (add/remove/reorder/reconversion all become no-ops) once a payment is
  // in progress or has succeeded, same reasoning as the old single-file
  // "Change file" button's own guard had.
  const basket = useFileBasket({ layout: settings.layout, enabled: orderStatus === "idle" });

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
  // Requirement: do not let a new customer pay while the machine cannot
  // print. Mirrors isKioskUpdating's own role exactly — a UI block here,
  // re-enforced for real server-side in app/api/create-order, which
  // independently re-checks the same signal rather than trusting this.
  // Clears on its own once the print agent reports the printer ready
  // again — no admin action needed either way. The raw reason text
  // (printBlockedReason, in the API response) is deliberately never shown
  // here — a customer-facing message should stay in plain language, not
  // a raw CUPS string; that detail is admin/staff-facing only (see
  // kiosk-card.tsx and the admin print page).
  const [printBlocked, setPrintBlocked] = useState(false);
  // Owner-only admin toggle — defaults false (matching allow_whatsapp's own
  // schema default) rather than true like allowColor/allowBw above, so the
  // opt-in section never flashes on screen for a kiosk where it's actually
  // off, only to disappear a moment later once the first poll resolves.
  const [allowWhatsapp, setAllowWhatsapp] = useState(false);
  // Owner-editable per-sheet pricing (admin's Pricing page) — these two
  // defaults only matter for the first render before the poll below
  // resolves; they used to be hardcoded module-level constants that never
  // changed no matter what an owner saved in the admin panel, which is the
  // actual bug this fixes. The price the customer is actually CHARGED was
  // never wrong — app/api/create-order/route.ts always recomputes it from
  // pricing_config server-side — only this on-screen estimate was stale,
  // and a mismatch between the two is exactly what produces "Price
  // mismatch — please refresh and try again." at checkout.
  const [priceBw, setPriceBw] = useState(2);
  const [priceColor, setPriceColor] = useState(10);
  // Goal 4 (UPI missing on some phones) — a friendly, non-blocking notice
  // when the page is open inside an in-app browser (Instagram/WhatsApp/
  // Facebook/Google Lens views/MIUI Browser), since UPI apps often can't
  // deep-link out of those webviews. Computed once on mount (navigator is
  // client-only); never hidden behind a loading state, never blocks Pay.
  const [inAppBrowser, setInAppBrowser] = useState<{ isInAppBrowser: boolean; label: string | null }>({ isInAppBrowser: false, label: null });
  const [copiedLink, setCopiedLink] = useState(false);
  useEffect(() => {
    // navigator.userAgent doesn't exist during SSR — this can only run once mounted, not computed during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInAppBrowser(detectInAppBrowser(navigator.userAgent));
  }, []);
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Clipboard access can be denied/unsupported — the link is still visible for a manual copy.
    }
  };
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{ isOnline: boolean; allowColor: boolean; allowBw: boolean; isUpdating: boolean; allowWhatsapp: boolean; priceBw: number; priceColor: number; printBlocked: boolean; printBlockedReason: string | null }>(`/api/kiosk-status/${kioskId}`);
        if (cancelled) return;
        setIsKioskOnline(data.isOnline);
        setAllowColor(data.allowColor);
        setAllowBw(data.allowBw);
        setIsKioskUpdating(data.isUpdating);
        setAllowWhatsapp(data.allowWhatsapp);
        setPriceBw(data.priceBw);
        setPriceColor(data.priceColor);
        setPrintBlocked(data.printBlocked);
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
    // reason/pattern as the Layout-reconversion effect inside useFileBasket.
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

  // Each basket item's own selectedPages, filtered by the shared
  // pageMode/customRange setting — see itemActivePages' own comment on why
  // that's applied per file rather than across some not-yet-existing merged
  // document.
  const activePagesPerItem = useMemo(
    () => basket.items.map((item) => itemActivePages(item, settings.pageMode, settings.customRange)),
    [basket.items, settings.pageMode, settings.customRange]
  );
  const totalPages = useMemo(() => basket.items.reduce((sum, item) => sum + item.totalPages, 0), [basket.items]);
  const totalActivePages = useMemo(() => activePagesPerItem.reduce((sum, pages) => sum + pages.length, 0), [activePagesPerItem]);

  const billableSheets = Math.ceil(totalActivePages / settings.pagesPerSheet) * settings.copies;
  // Never includes the pickup-ID banner — it's mandatory on every job (see
  // app/api/create-order/route.ts, which hardcodes includeBannerPage: true
  // server-side regardless of what the client sends) but absorbed as a
  // business cost, not itemized into the customer's price.
  const totalPrice = billableSheets * (settings.isColor ? priceColor : priceBw);
  const updateSettings = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) basket.addFiles(event.target.files);
    event.target.value = "";
  };

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
  //
  // Multi-file: every basket file's own selected pages are combined into
  // ONE PDF, in basket order, by mergeSelectedPdfPages (lib/pdf-merge.ts) —
  // entirely in-browser, so only the pages actually chosen ever get
  // uploaded. From there on this is the exact same single-file upload →
  // create-order flow the kiosk has always had: one PDF, one job. The
  // server never trusts totalPrice/selectedPages sent here — see
  // app/api/create-order/route.ts, which re-derives the real page count,
  // sheets and price from the merged PDF it actually receives.
  const handleCollect = async () => {
    if (!jobId || isCollecting) return;
    setIsCollecting(true);
    try {
      const result = await fetchJson<{ collectedAt: string }>("/api/collect-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      setCollectedAt(result.collectedAt);
    } catch (collectError) {
      console.error("collect-job error:", collectError);
    } finally {
      setIsCollecting(false);
    }
  };

  const handleStartPayment = async () => {
    if (basket.items.length === 0) return setError("Add at least one file before paying.");
    if (basket.isProcessing) return setError("Please wait for your files to finish preparing.");
    const notReadyItem = basket.items.find((item) => item.status !== "ready" || !item.pdfBytes);
    if (notReadyItem) return setError(`"${notReadyItem.file.name}" isn't ready — remove it or fix the error on its card before paying.`);
    if (totalActivePages === 0) return setError("Select at least one page before paying.");
    if (isKioskUpdating) return setError("This kiosk is being updated right now — please try again in a minute.");
    if (printBlocked) return setError("This kiosk can't print right now (it needs attention) — please try again shortly.");
    // Phone is only required when the customer opted into WhatsApp updates.
    if (notifyOptIn && !isPhoneValid) {
      setPhoneTouched(true);
      return setError("Enter a valid 10-digit phone number, or untick WhatsApp updates.");
    }
    setError("");
    setIsLoading(true);
    try {
      const merged = await mergeSelectedPdfPages(
        basket.items.map((item, index) => ({
          fileName: item.file.name,
          pdfBytes: item.pdfBytes!,
          selectedPages: activePagesPerItem[index] ?? [],
        }))
      );
      const mergedFileName = basket.items.length === 1 ? basket.items[0].file.name : `${basket.items.length} files (merged).pdf`;

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
      const pdfBlob = new Blob([merged.bytes.slice().buffer], { type: "application/pdf" });
      const uploadTarget = await fetchJson<{ path: string; token: string; signedUrl: string }>("/api/create-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: mergedFileName, fileSize: pdfBlob.size, contentType: "application/pdf" }),
      });

      // Step 2: upload directly to Supabase Storage with that signed URL —
      // this is the request that actually carries the file's bytes, and it
      // never touches our own server at all.
      setUploadProgress(0);
      await uploadFileWithProgress(uploadTarget.signedUrl, pdfBlob, (fraction) => setUploadProgress(Math.round(fraction * 100)));
      setUploadProgress(null);

      // Step 3: create the order from the storage path alone — this
      // request is just metadata (page selection, settings, price), tiny
      // regardless of how large the actual file was. selectedPages is every
      // page of the merged upload: the real selection already happened
      // above, per file, before merging — the server re-derives its own
      // authoritative page count from the uploaded bytes regardless (see
      // that route's own comment), this is just "print everything in the
      // file you were just given."
      const order = await fetchJson<{ jobId: string } & CreateOrderOutput>("/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: uploadTarget.path,
          fileName: mergedFileName,
          selectedPages: Array.from({ length: merged.pageCount }, (_, index) => index + 1),
          settings,
          totalPrice,
          notifyOptIn,
          // Only sent when opted in — the server never collects/stores a
          // phone number otherwise, regardless of whatever stale value
          // might be in this field (e.g. typed, then the checkbox
          // unticked again).
          phone: notifyOptIn ? phone : undefined,
          kioskId: paramKioskId || undefined,
          pickupMode,
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
        const inAppBrowser = detectInAppBrowser(navigator.userAgent);
        reportClientDiagnostic("razorpay-checkout-open", { isInAppBrowser: inAppBrowser.isInAppBrowser, inAppLabel: inAppBrowser.label });
        const razorpay = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: "INR",
          name: "OXWAY Print Kiosk",
          description: mergedFileName,
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
        // Diagnostic only (Goal 4) — error.code/description, no payment or
        // personal data. Never blocks or alters the actual checkout flow.
        razorpay.on("payment.failed", (response) => {
          reportClientDiagnostic("razorpay-payment-failed", {
            errorCode: response.error?.code,
            errorDescription: response.error?.description,
            errorSource: response.error?.source,
            errorStep: response.error?.step,
            errorReason: response.error?.reason,
            isInAppBrowser: inAppBrowser.isInAppBrowser,
            inAppLabel: inAppBrowser.label,
          });
        });
        razorpay.open();
      }
    } catch (paymentError) {
      console.error("Payment order error:", paymentError);
      reportClientDiagnostic("razorpay-checkout-open-failed", { message: paymentError instanceof Error ? paymentError.message : String(paymentError) });
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
  const applyStatusUpdate = (forJobId: string, next: { status: OrderStatus; error?: string | null; ticketNumber?: number | null; refundStatus?: string | null }) => {
    if (next.ticketNumber !== undefined) setTicketNumber(next.ticketNumber ?? null);
    if (next.refundStatus !== undefined) setRefundStatus(next.refundStatus ?? null);
    setOrderStatus((current) => {
      if (next.status === current) return current;
      if (next.status === "paid" || next.status === "printed") {
        confetti({ particleCount: next.status === "printed" ? 100 : 80, spread: 75, origin: { y: 0.7 } });
      }
      // print_failed gets its own dedicated banner below (refund under
      // review / refunded) instead of the generic `error` state — showing
      // this job's raw internal failure reason (e.g. a CUPS error) to the
      // customer alongside "we're reviewing a refund" would undercut that
      // message, not clarify anything for them. payment_failed (the
      // payment itself never went through) is unrelated to a refund and
      // keeps the generic message.
      if (next.status === "payment_failed") {
        setError(next.error || "Something went wrong. Please see kiosk staff.");
      }
      if (next.status === "printed" && notifiedPrintedForJobRef.current !== forJobId) {
        notifiedPrintedForJobRef.current = forJobId;
        notifyPrintReady();
      }
      return next.status;
    });
  };

  // print_failed is listed in TERMINAL_ORDER_STATUSES (nothing about the
  // PRINT itself will ever change again), but a refund now resolves well
  // after that — minutes to hours later, whenever an owner approves it —
  // not synchronously in the same moment the way the old auto-refund did.
  // Both effects below stay running through print_failed specifically
  // while refundStatus hasn't reached "refunded" yet, so a customer who
  // leaves this tab open actually finds out once a refund is approved,
  // instead of the page freezing forever on "under review" the instant
  // print_failed is first observed.
  const isWaitingOnRefundResolution = orderStatus === "print_failed" && refundStatus !== "refunded";

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
    if (TERMINAL_ORDER_STATUSES.includes(orderStatus) && !isWaitingOnRefundResolution) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{
          jobId: string; status: OrderStatus; error?: string; etaMinutes?: number; ticketNumber?: number; refundStatus?: string | null;
          collectedAt?: string | null; stackPosition?: number; sheetsAhead?: number;
        }>(`/api/verify-payment?jobId=${jobId}`);
        if (cancelled) return;
        setEtaMinutes(data.etaMinutes ?? null);
        setCollectedAt(data.collectedAt ?? null);
        setStackPosition(data.stackPosition ?? null);
        setSheetsAhead(data.sheetsAhead ?? null);
        applyStatusUpdate(jobId, { status: data.status, error: data.error, ticketNumber: data.ticketNumber, refundStatus: data.refundStatus });
      } catch (pollError) {
        console.error("Status poll error:", pollError);
      }
    };
    // A refund being reviewed is in no hurry — this slower cadence avoids
    // polling every 10s for however long a tab is left open waiting on one.
    const interval = setInterval(poll, orderStatus === "pending_payment" ? 3000 : isWaitingOnRefundResolution ? 30000 : 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, orderStatus, isWaitingOnRefundResolution]);

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
    if (TERMINAL_ORDER_STATUSES.includes(orderStatus) && !isWaitingOnRefundResolution) return;

    let channel: RealtimeChannel | null = null;
    try {
      const supabase = createSupabaseBrowserClient();
      channel = supabase
        .channel(`print-job-${jobId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "print_jobs", filter: `id=eq.${jobId}` },
          (payload) => {
            const row = payload.new as { status: OrderStatus; error: string | null; ticket_number: number | null; refund_status: string | null };
            applyStatusUpdate(jobId, { status: row.status, error: row.error, ticketNumber: row.ticket_number, refundStatus: row.refund_status });
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
  }, [jobId, orderStatus, isWaitingOnRefundResolution]);

  const resetOrder = () => {
    setOrderStatus("idle");
    setJobId(null);
    setEtaMinutes(null);
    setTicketNumber(null);
    setRefundStatus(null);
    setError("");
  };

  useEffect(() => {
    if (ticketNumber === null) return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
    pickupCardRef.current?.focus();
  }, [ticketNumber]);

  const theme = isDark ? "bg-[#101419] text-slate-100" : "bg-[#f4f6f8] text-slate-950";
  const panel = isDark ? "border-white/10 bg-white/[0.06]" : "border-slate-200 bg-white";
  const muted = isDark ? "text-slate-400" : "text-slate-500";
  const canEditBasket = orderStatus === "idle";
  const primaryItem = basket.items[0];

  return <div className={`min-h-screen pb-36 transition-colors duration-300 ${theme}`}>
    <header className={`sticky top-0 z-20 border-b backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/85" : "border-slate-200/80 bg-[#f4f6f8]/85"}`}><div className="mx-auto flex max-w-6xl flex-wrap items-center gap-y-2 px-5 py-4 lg:px-8"><div className="flex items-center gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20"><Printer size={19} /></div><div><BrandWordmark className="h-10" /><p className={`mt-1.5 text-xs ${muted}`}>Smart print kiosk</p></div></div><div className="ml-auto flex items-center gap-2">{isKioskOnline
      ? <span className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-500"><span className="size-1.5 rounded-full bg-emerald-500" />Online</span>
      : <span className="flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-500"><span className="size-1.5 rounded-full bg-amber-500" />Offline</span>}<Link href="/admin" className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${isDark ? "border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/10" : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100"}`}>Admin</Link><button aria-label="Toggle color theme" onClick={() => setIsDark((value) => !value)} className={`grid size-10 place-items-center rounded-xl border ${panel}`}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</button></div></div></header>
    {/* Goal: "nobody can pay while the kiosk is offline" — shown up front
       (uploading/choosing options still works) so a customer knows before
       they get all the way to Pay. The Pay button itself is separately
       replaced by its own large message further down, same isKioskOnline
       signal, polled via the same /api/kiosk-status call below — no page
       refresh needed either way for this to clear once the kiosk returns. */}
    {!isKioskOnline && <div className="mx-auto max-w-6xl px-5 pt-4 lg:px-8"><div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-600"><WifiOff size={18} className="mt-0.5 shrink-0" /><p>This kiosk is offline right now, so payment is turned off. You can still upload your file and choose print options — the Pay button will turn on automatically once the kiosk is back online.</p></div></div>}
    {isKioskUpdating && <div className="mx-auto max-w-6xl px-5 pt-4 lg:px-8"><div className="flex items-start gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm font-medium text-blue-600"><RefreshCw size={18} className="mt-0.5 shrink-0" /><p>This kiosk is being updated right now. New orders will resume automatically in a minute or two.</p></div></div>}
    {/* Requirement: block new checkout with a clear temporary-unavailable
       message while the printer can't print, clearing on its own once the
       print agent reports it's ready again — never a technical reason
       string (printBlockedReason stays internal/admin-facing only). */}
    {!isKioskUpdating && printBlocked && <div className="mx-auto max-w-6xl px-5 pt-4 lg:px-8"><div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><p>This kiosk is temporarily unavailable — it needs attention before it can print again. New orders will resume automatically once it&apos;s ready; there&apos;s no need to try again manually.</p></div></div>}
    {/* The entire replacement for what an SMS would have told the customer
       (ROADMAP.md §22) — deliberately the single biggest, highest-contrast
       thing on this whole screen once it exists, not just a slightly bigger
       number tucked into the status bar. Readable at arm's length is the
       actual design requirement here, not a nice-to-have. */}
    {ticketNumber !== null && orderStatus !== "idle" && orderStatus !== "pending_payment" && (
      <div className="mx-auto max-w-6xl px-5 pt-6 lg:px-8">
        <div ref={pickupCardRef} tabIndex={-1} className={`flex flex-col items-center rounded-[2rem] border-2 border-blue-600 px-6 py-8 text-center shadow-xl shadow-blue-600/10 outline-none focus-visible:ring-4 focus-visible:ring-blue-500/40 ${isDark ? "bg-blue-600/15" : "bg-blue-50"}`}>
          <p className="text-xs font-black uppercase tracking-[0.35em] text-blue-600">Your pickup code</p>
          {/* Fixed sizing (text-[5.5rem]/text-[8rem]) was hand-tuned for the
             usual 3-digit code ("#042") and never shrinks for a longer one —
             on a narrow phone screen, a 4-5 digit code ("#1000"/"#10000") at
             that same size would run wider than the viewport. A smaller
             fixed size once the code itself is longer keeps this readable
             without ever overflowing, on any digit count this kiosk will
             realistically ever reach. */}
          <p className={`mt-2 font-black leading-none tracking-tight text-blue-600 ${String(ticketNumber).length >= 4 ? "text-[4rem] sm:text-[6rem]" : "text-[5.5rem] sm:text-[8rem]"}`}>
            {formatTicketCode(ticketNumber)}
          </p>
        </div>
      </div>
    )}
    <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1fr_330px] lg:px-8"><section className="min-w-0"><div className="mb-7"><p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-500">01 / Upload</p><h1 className="text-3xl font-black tracking-tight sm:text-4xl">Print without the queue.</h1><p className={`mt-2 text-sm ${muted}`}>Upload one or more files, tune your print settings, and send them straight to the kiosk.</p></div><button type="button" onClick={() => setIsPreviewOpen(true)} className={`mb-4 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-bold ${panel}`}><span>Preview print</span><span className="text-blue-500">View sheet</span></button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={handleFileInput}
      />
      {basket.items.length === 0 && <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (event.dataTransfer.files.length > 0) basket.addFiles(event.dataTransfer.files);
        }}
        className={`group flex min-h-[320px] w-full flex-col items-center justify-center rounded-[2rem] border-2 border-dashed p-8 text-center transition ${isDragging ? "border-blue-500 bg-blue-500/10" : `${isDark ? "border-white/15 bg-white/[0.04]" : "border-slate-300 bg-white/70 hover:border-blue-300 hover:bg-white"}`}`}
      >
        <span className="mb-5 grid size-16 place-items-center rounded-3xl bg-blue-600 text-white shadow-xl shadow-blue-600/20 transition group-hover:-translate-y-1"><FileUp size={27} /></span>
        <span className="text-lg font-bold">Drop your files here</span>
        <span className={`mt-2 text-sm ${muted}`}>PDF, image, or Word document — select or drop several at once</span>
        <span className={`mt-6 rounded-full px-3 py-1 text-[11px] ${isDark ? "bg-white/10 text-slate-300" : "bg-slate-100 text-slate-500"}`}>PDF · PNG · JPG · HEIC · DOCX · max {Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB each</span>
        <span className={`mt-1.5 text-[11px] ${muted}`}>Up to {MAX_FILES_PER_BASKET} files · {Math.round(MAX_COMBINED_FILE_SIZE_BYTES / (1024 * 1024))} MB combined · {MAX_TOTAL_PAGES_PER_BASKET} pages combined</span>
      </button>}

      {basket.items.length > 0 && <div className="space-y-4">
        {basket.items.map((item, index) => <FileBasketItemCard
          key={item.id}
          item={item}
          index={index}
          itemCount={basket.items.length}
          isDark={isDark}
          muted={muted}
          panel={panel}
          canEdit={canEditBasket}
          activePages={activePagesPerItem[index] ?? []}
          onRemove={() => basket.removeFile(item.id)}
          onMoveUp={() => basket.moveUp(item.id)}
          onMoveDown={() => basket.moveDown(item.id)}
          onTogglePage={(pageNumber) => basket.togglePage(item.id, pageNumber)}
          onSelectAll={() => basket.selectAllPages(item.id)}
          onClearPages={() => basket.clearPages(item.id)}
        />)}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canEditBasket || basket.items.length >= MAX_FILES_PER_BASKET}
          className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${isDark ? "border-white/15 text-slate-300 hover:enabled:bg-white/5" : "border-slate-300 text-slate-600 hover:enabled:bg-white"}`}
        >
          <Plus size={16} className="text-blue-500" /> Add more files
        </button>

        {basket.basketError && <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-600">{basket.basketError}</div>}
      </div>}

      {error && <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
      {orderStatus === "printed" && !collectedAt && (
        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700">
          {stackPosition !== null && (
            <p className="mb-2">
              Your print is the {stackPosition === 1 ? "1st" : stackPosition === 2 ? "2nd" : stackPosition === 3 ? "3rd" : `${stackPosition}th`} stack from the top
              {sheetsAhead !== null && sheetsAhead > 0 ? ` (about ${sheetsAhead} sheets)` : ""} — estimate only.
            </p>
          )}
          <button onClick={handleCollect} disabled={isCollecting} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
            {isCollecting ? "Marking as collected..." : "I've collected my print"}
          </button>
        </div>
      )}
      {orderStatus === "printed" && collectedAt && (
        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700">Thanks — marked as collected.</div>
      )}
      {/* Requirement: a clear message that the print didn't complete and a
         refund is under review, with a non-exact timeline — never a raw
         internal failure reason (CUPS error, etc.), which the pre-refund-
         workflow version of this page used to show here via the generic
         `error` state above. Switches to the short "Refunded" confirmation
         once refundStatus actually reaches "refunded" — the poll/Realtime
         effects above keep running specifically so that transition is seen
         live if this tab is still open when an owner approves it. */}
      {orderStatus === "print_failed" && (refundStatus === "refunded"
        ? <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-600">Your refund has been approved and sent to your original payment method.</div>
        : <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700">We&apos;re sorry — this print didn&apos;t complete. We&apos;re reviewing a refund for this order; once approved, it will reach your original payment method in about 5–7 business days.</div>)}
    </section><aside className="lg:pt-[86px]"><div className={`rounded-[2rem] border p-5 shadow-xl shadow-slate-900/5 ${panel}`}><div className="mb-5 flex items-center justify-between"><div><p className={`text-xs font-bold uppercase tracking-[0.2em] ${muted}`}>Print order</p><p className="mt-1 text-lg font-black">Configure output</p></div><Settings2 className="text-blue-500" size={19} /></div><div className={`mb-4 rounded-2xl p-4 ${isDark ? "bg-blue-500/10" : "bg-blue-50"}`}><div className="flex items-center justify-between"><span className={`text-xs font-semibold ${muted}`}>Estimated total</span><span className="text-2xl font-black text-blue-600">₹{totalPrice}</span></div><div className={`mt-2 text-xs ${muted}`}>{basket.items.length} {basket.items.length === 1 ? "file" : "files"} · {billableSheets} billable sheets · {totalActivePages} of {totalPages} pages · {settings.copies} {settings.copies === 1 ? "copy" : "copies"}</div></div>
      <div className={`mb-4 rounded-xl border p-3 ${isDark ? "border-white/10" : "border-slate-200"}`}>
        <p className="mb-2 text-sm font-bold">When will you collect?</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPickupMode("here")}
            className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${pickupMode === "here" ? "border-blue-500 bg-blue-500/10 text-blue-500" : isDark ? "border-white/10" : "border-slate-200"}`}
          >
            I&apos;m at the kiosk now
          </button>
          <button
            type="button"
            onClick={() => setPickupMode("later")}
            className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${pickupMode === "later" ? "border-blue-500 bg-blue-500/10 text-blue-500" : isDark ? "border-white/10" : "border-slate-200"}`}
          >
            I&apos;ll collect later
          </button>
        </div>
      </div>
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
    <footer className="mx-auto max-w-6xl px-5 pb-8 lg:px-8">
      <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className={`flex w-fit items-center gap-2 text-sm font-semibold ${muted} hover:text-blue-500`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
          <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
          <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
        </svg>
        {INSTAGRAM_HANDLE}
      </a>
    </footer>
    {basket.items.length > 0 && orderStatus === "idle" && inAppBrowser.isInAppBrowser && (
      <div className="fixed bottom-[88px] left-0 right-0 z-30 mx-auto max-w-6xl px-5 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 text-xs font-medium text-amber-700">
          <span>For UPI, open this page in Chrome or Safari — {inAppBrowser.label ?? "this browser"} may not support it.</span>
          <button type="button" onClick={handleCopyLink} className="flex items-center gap-1 rounded-lg border border-amber-400/50 bg-white px-2.5 py-1 font-bold text-amber-700 hover:bg-amber-50">
            <Copy size={12} /> {copiedLink ? "Copied!" : "Copy link"}
          </button>
        </div>
      </div>
    )}
    {basket.items.length > 0 && <div className={`fixed bottom-0 left-0 right-0 z-30 border-t backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/90" : "border-slate-200 bg-white/90"}`}><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 lg:px-8">
      {/* The ticket code itself now lives in the big hero banner above
         <main> (see ticketNumber !== null below) — this slot stays on
         price throughout, rather than duplicating the same number twice
         on screen at two very different sizes. */}
      <div><p className={`text-xs font-bold uppercase tracking-[0.15em] ${muted}`}>Total payable</p><p className="text-2xl font-black">₹{totalPrice}</p></div>
      {orderStatus === "idle" && !isKioskOnline && (
        // Goal: "the Pay button is disabled and a large, clear message
        // replaces it" — icon + words, not color alone. isKioskOnline comes
        // from the same /api/kiosk-status poll already driving the top
        // banner above, so this clears on its own the moment the kiosk's
        // heartbeat is fresh again, no page refresh needed.
        <div className="flex min-w-[180px] max-w-sm items-center gap-2.5 rounded-xl bg-amber-500/10 px-4 py-3.5 text-sm font-bold text-amber-700">
          <WifiOff size={20} className="shrink-0" />
          <span>This kiosk is offline right now, so payment is turned off. Please try again in a few minutes.</span>
        </div>
      )}
      {orderStatus === "idle" && isKioskOnline && <div className="flex items-center gap-2">
        <button onClick={handleStartPayment} disabled={isLoading || basket.isProcessing || totalActivePages === 0 || isKioskUpdating || printBlocked || !isKioskOnline} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">{uploadProgress !== null ? <span>Uploading... {uploadProgress}%</span> : isLoading ? <RefreshCw className="animate-spin" size={17} /> : <span>Pay ₹{totalPrice}</span>}</button>
      </div>}
      {orderStatus === "pending_payment" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Waiting for payment...</div>}
      {orderStatus === "paid" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Payment confirmed, starting print{etaMinutes ? ` · ~${etaMinutes} min` : "..."}</div>}
      {orderStatus === "printing" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><Printer size={17} /> Printing your document{etaMinutes ? ` · ~${etaMinutes} min` : "..."}</div>}
      {/* This specific job hit a recoverable printer problem (out of
         paper, etc.) — never failed, just paused. The kiosk-wide banner
         above already explains the situation in plain language; this
         pill just needs to say "still in progress, not stuck." Resumes
         automatically — no action for the customer to take. */}
      {orderStatus === "print_blocked" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-amber-500/10 px-5 py-3.5 text-sm font-black text-amber-600"><AlertTriangle size={17} /> Print paused — resuming shortly</div>}
      {/* Requirement (restart handling, Part A): literal copy "Printing
         delayed, please wait" for an interrupted job. */}
      {orderStatus === "interrupted" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-rose-500/10 px-5 py-3.5 text-sm font-black text-rose-600"><AlertTriangle size={17} /> Printing delayed, please wait</div>}
      {orderStatus === "printed" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-5 py-3.5 text-sm font-black text-emerald-500"><Check size={17} /> Your print is ready — please collect it</div>}
      {orderStatus === "expired" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3.5 text-sm font-black text-white">Payment expired — try again</button>}
      {orderStatus === "payment_failed" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-red-500 px-5 py-3.5 text-sm font-black text-white">Failed — try again</button>}
      {/* "try again" is misleading here regardless (the failure was
         physical, not something resubmitting fixes). Refunds are no longer
         automatic/instant (see lib/refund.ts) — refundStatus reaching
         "refunded" (not just refundedAt being set at all) is what actually
         tells these two states apart now; the longer explanation (and the
         5-7 business day timeline) lives in the banner above, this pill
         just needs to be short. */}
      {orderStatus === "print_failed" && (refundStatus === "refunded"
        ? <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3.5 text-sm font-black text-white"><Check size={17} /> Refunded — start a new print</button>
        : <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3.5 text-sm font-black text-white">Refund under review</button>)}
      {orderStatus === "cancelled" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-slate-500 px-5 py-3.5 text-sm font-black text-white">Cancelled — see kiosk staff</button>}
    </div></div>}
    {isSettingsOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSettingsOpen(false); }}><div className={`w-full max-w-lg rounded-t-[2rem] p-6 shadow-2xl sm:rounded-[2rem] ${isDark ? "bg-[#171d24]" : "bg-white"}`}><div className="mb-6 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Print settings</p><h2 className="mt-1 text-xl font-black">Tune your document</h2></div><button onClick={() => setIsSettingsOpen(false)} className={`grid size-9 place-items-center rounded-xl ${isDark ? "bg-white/10" : "bg-slate-100"}`}><X size={17} /></button></div><div className="space-y-5"><SettingRow label="Copies" icon={<Copy size={16} />}><div className={`flex items-center gap-1 rounded-xl border p-1 ${isDark ? "border-white/10" : "border-slate-200"}`}><button onClick={() => updateSettings("copies", Math.max(1, settings.copies - 1))} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Minus size={15} /></button><span className="w-8 text-center text-sm font-black">{settings.copies}</span><button onClick={() => updateSettings("copies", settings.copies + 1)} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Plus size={15} /></button></div></SettingRow><SettingRow label="Layout" icon={<LayoutGrid size={16} />}><Segmented value={settings.layout} options={["portrait", "landscape"]} onChange={(value) => updateSettings("layout", value as Layout)} /></SettingRow><SettingRow label="Color mode" icon={<Palette size={16} />}><Segmented value={settings.isColor ? "color" : "bw"} options={["bw", "color"]} labels={[`B&W · ₹${priceBw}`, `Color · ₹${priceColor}`]} disabledOptions={[...(!allowBw ? ["bw"] : []), ...(!allowColor ? ["color"] : [])]} onChange={(value) => updateSettings("isColor", value === "color")} /></SettingRow>{(!allowColor || !allowBw) && <p className="text-xs font-medium text-amber-600">{!allowColor ? "Color is unavailable right now." : "B&W is unavailable right now."}</p>}<div><p className={`mb-2 text-sm font-bold ${muted}`}>Pages</p><div className="grid grid-cols-4 gap-2">{(["all", "odd", "even", "custom"] as PageMode[]).map((mode) => <button key={mode} onClick={() => updateSettings("pageMode", mode)} className={`rounded-xl border px-2 py-2.5 text-xs font-bold capitalize ${settings.pageMode === mode ? "border-blue-500 bg-blue-500/10 text-blue-500" : isDark ? "border-white/10" : "border-slate-200"}`}>{mode}</button>)}</div>{settings.pageMode === "custom" && <input value={settings.customRange} onChange={(event) => updateSettings("customRange", event.target.value)} placeholder="Example: 1-5, 8" className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-blue-500 ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`} />}</div><SettingRow label="Paper size" icon={<FileText size={16} />}><select value={settings.paperSize} onChange={(event) => updateSettings("paperSize", event.target.value as PaperSize)} className={`rounded-xl border px-3 py-2 text-xs font-bold outline-none ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`}>{(["A4", "Letter", "Legal"] as PaperSize[]).map((size) => <option key={size}>{size}</option>)}</select></SettingRow><SettingRow label="Pages per sheet" icon={<LayoutGrid size={16} />}><Segmented value={String(settings.pagesPerSheet)} options={["1", "2", "4"]} labels={["1", "2 in 1", "4 in 1"]} onChange={(value) => updateSettings("pagesPerSheet", Number(value) as 1 | 2 | 4)} /></SettingRow></div><button onClick={() => setIsSettingsOpen(false)} className="mt-7 w-full rounded-xl bg-blue-600 py-3.5 text-sm font-black text-white">Apply settings</button></div></div>}
    {/* Preview used to also render as an always-open floating panel on
       desktop, sitting over the page-selection grid whether you wanted it
       or not. Now button-triggered on every screen size, same as it
       already was on mobile — one modal, one behavior. Still only ever
       shows the FIRST basket file's own preview (not the merged print job
       handleStartPayment submits) — live-merging every file just to render
       a preview on every keystroke isn't worth the cost; out of scope for
       now. */}
    {isPreviewOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-5"><div className="max-h-[90vh] overflow-y-auto rounded-[2rem] bg-white p-5"><LivePrintPreview settings={settings} activePages={activePagesPerItem[0] ?? []} thumbnails={primaryItem?.thumbnails ?? []} imagePreviewUrl={primaryItem?.previewUrl} fileType={primaryItem?.file.type} isOpen onClose={() => setIsPreviewOpen(false)} /></div></div>}
  </div>;
}
