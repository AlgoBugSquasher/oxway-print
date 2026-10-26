"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileUp, Gift, Plus, Printer, RefreshCw, ShieldAlert } from "lucide-react";
import {
  FileBasketItemCard,
  itemActivePages,
  Segmented,
  SettingRow,
  type PageMode,
  type PaperSize,
  type PrintSettings,
} from "@/components/print-basket-ui";
import { useAdminRole } from "@/lib/admin/role-context";
import { fetchJson } from "@/lib/fetch-json";
import { MAX_COMBINED_FILE_SIZE_BYTES, MAX_FILES_PER_ORDER, MAX_FILE_SIZE_BYTES, MAX_TOTAL_PAGES_PER_BASKET, useFileBasket } from "@/lib/hooks/useFileBasket";
import { mergeSelectedPdfPages } from "@/lib/pdf-merge";
import { formatTicketCode } from "@/lib/ticket-code";
import { uploadFileWithProgress } from "@/lib/upload-with-progress";

/** Mirrors lib/store.ts JobStatus, plus a local "idle" state before any job exists — same shape the customer page tracks, just without the payment-specific states (pending_payment/payment_failed/expired never happen here, a staff job is created already-paid). */
type JobStatus = "idle" | "submitting" | "paid" | "printing" | "print_blocked" | "interrupted" | "printed" | "print_failed" | "cancelled";
const TERMINAL_STATUSES: JobStatus[] = ["printed", "print_failed", "cancelled", "interrupted"];

/** Which kiosk this print goes to — ?k=<kiosk-id> for a multi-kiosk setup, same convention the customer page and kiosk-display screen already use. Defaults to the single kiosk this build ships with. */
function readKioskIdFromUrl(): string {
  if (typeof window === "undefined") return "oxway_01";
  return new URLSearchParams(window.location.search).get("k") || "oxway_01";
}

export default function AdminPrintPage() {
  // Both owner and staff can print free — same two roles the server-side
  // check in app/api/staff-print/route.ts allows; "none" (a signed-in
  // account with no app_metadata.role at all, which shouldn't normally
  // exist) gets a notice instead, same pattern pricing/page.tsx and
  // audit/page.tsx already use for their own, stricter owner-only gate.
  const role = useAdminRole();

  const [settings, setSettings] = useState<PrintSettings>({
    copies: 1,
    layout: "portrait",
    isColor: false,
    pageMode: "all",
    customRange: "",
    paperSize: "A4",
    pagesPerSheet: 1,
  });
  const updateSettings = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const [status, setStatus] = useState<JobStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState<number | null>(null);
  const [waivedAmount, setWaivedAmount] = useState<number | null>(null);
  /** This SPECIFIC submitted job's own blocked reason, once status is print_blocked — distinct from the kiosk-wide printBlockedReason below (that one's for the banner shown before anything's even submitted yet). */
  const [jobBlockedReason, setJobBlockedReason] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [forceCoverSheet, setForceCoverSheet] = useState(false);

  const [kioskId] = useState(readKioskIdFromUrl);
  const [isKioskOnline, setIsKioskOnline] = useState(true);
  const [isKioskUpdating, setIsKioskUpdating] = useState(false);
  const [allowColor, setAllowColor] = useState(true);
  const [allowBw, setAllowBw] = useState(true);
  // Informational only here, deliberately NOT disabling "Print free" —
  // unlike the paying-customer page, staff may legitimately want to
  // submit anyway (e.g. while physically standing at the kiosk fixing the
  // exact problem this is reporting). It'll simply sit print_blocked,
  // same as any other job, until the printer's ready.
  const [printBlocked, setPrintBlocked] = useState(false);
  const [printBlockedReason, setPrintBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{ isOnline: boolean; allowColor: boolean; allowBw: boolean; isUpdating: boolean; printBlocked: boolean; printBlockedReason: string | null }>(`/api/kiosk-status/${kioskId}`);
        if (cancelled) return;
        setIsKioskOnline(data.isOnline);
        setAllowColor(data.allowColor);
        setAllowBw(data.allowBw);
        setIsKioskUpdating(data.isUpdating);
        setPrintBlocked(data.printBlocked);
        setPrintBlockedReason(data.printBlockedReason);
      } catch {
        // Best-effort — a failed check just skips this tick.
      }
    };
    void poll();
    const interval = setInterval(poll, 12_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [kioskId]);

  const canEditBasket = status === "idle";
  const basket = useFileBasket({ layout: settings.layout, enabled: canEditBasket });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const activePagesPerItem = useMemo(
    () => basket.items.map((item) => itemActivePages(item, settings.pageMode, settings.customRange)),
    [basket.items, settings.pageMode, settings.customRange]
  );
  const totalPages = useMemo(() => basket.items.reduce((sum, item) => sum + item.totalPages, 0), [basket.items]);
  const totalActivePages = useMemo(() => activePagesPerItem.reduce((sum, pages) => sum + pages.length, 0), [activePagesPerItem]);

  // Idempotency key for the current attempt — stable across a slow network
  // or a retried click so app/api/staff-print's own uniqueness check can
  // dedupe them, same reasoning the customer page's old staff-print path
  // used. A genuinely new attempt (resetJob, or this one just succeeded)
  // clears it so the next print gets a fresh key.
  const idempotencyKeyRef = useRef<string | null>(null);

  const handlePrint = async () => {
    if (basket.items.length === 0) return setError("Add at least one file before printing.");
    if (basket.isProcessing) return setError("Please wait for your files to finish preparing.");
    const notReadyItem = basket.items.find((item) => item.status !== "ready" || !item.pdfBytes);
    if (notReadyItem) return setError(`"${notReadyItem.file.name}" isn't ready — remove it or fix the error on its card before printing.`);
    if (totalActivePages === 0) return setError("Select at least one page before printing.");
    if (isKioskUpdating) return setError("This kiosk is being updated right now — please try again in a minute.");

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    setError("");
    setStatus("submitting");
    try {
      const merged = await mergeSelectedPdfPages(
        basket.items.map((item, index) => ({
          fileName: item.file.name,
          pdfBytes: item.pdfBytes!,
          selectedPages: activePagesPerItem[index] ?? [],
        }))
      );
      const mergedFileName = basket.items.length === 1 ? basket.items[0].file.name : `${basket.items.length} files (merged).pdf`;

      const pdfBlob = new Blob([merged.bytes.slice().buffer], { type: "application/pdf" });
      const uploadTarget = await fetchJson<{ path: string; token: string; signedUrl: string }>("/api/create-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: mergedFileName, fileSize: pdfBlob.size, contentType: "application/pdf" }),
      });

      setUploadProgress(0);
      await uploadFileWithProgress(uploadTarget.signedUrl, pdfBlob, (fraction) => setUploadProgress(Math.round(fraction * 100)));
      setUploadProgress(null);

      const result = await fetchJson<{ jobId: string; ticketNumber: number; waivedAmount: number }>("/api/staff-print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: uploadTarget.path,
          fileName: mergedFileName,
          selectedPages: Array.from({ length: merged.pageCount }, (_, index) => index + 1),
          settings,
          kioskId,
          idempotencyKey: idempotencyKeyRef.current,
          forceCoverSheet,
          // Same server-side MAX_FILES_PER_ORDER check create-order has —
          // the files are already merged into one PDF by this point, so
          // the original count isn't otherwise recoverable server-side.
          fileCount: basket.items.length,
        }),
      });

      idempotencyKeyRef.current = null;
      setJobId(result.jobId);
      setTicketNumber(result.ticketNumber);
      setWaivedAmount(result.waivedAmount);
      setStatus("paid");
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : "Could not start the free print.");
      setStatus("idle");
    } finally {
      setUploadProgress(null);
    }
  };

  // Polls the same route the customer page polls — a staff job is created
  // already 'paid' (never pending_payment, see createStaffPrintJob), so
  // reconcilePendingPayment just passes it through unchanged; this is
  // purely a status read, not a second payment-reconciliation path.
  useEffect(() => {
    if (!jobId || TERMINAL_STATUSES.includes(status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchJson<{ status: JobStatus; error?: string; refundedAt?: string | null; blockedReason?: string | null }>(`/api/verify-payment?jobId=${jobId}`);
        if (cancelled) return;
        setStatus(data.status);
        if (data.status === "print_failed" && data.error) setError(data.error);
        setJobBlockedReason(data.blockedReason ?? null);
      } catch {
        // Best-effort — keeps polling on the next tick regardless.
      }
    };
    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, status]);

  const resetJob = () => {
    setStatus("idle");
    setJobId(null);
    setTicketNumber(null);
    setWaivedAmount(null);
    setError("");
    setJobBlockedReason(null);
    idempotencyKeyRef.current = null;
  };

  if (role === "none") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
        <ShieldAlert size={18} />
        <p className="text-sm font-semibold">Free printing is for owner/staff accounts only. Even if this page loaded, the server would refuse the request — see app/api/staff-print/route.ts.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Print</p>
        <h1 className="mt-1 text-2xl font-black">Free staff print</h1>
        <p className="mt-1 text-sm text-slate-500">Upload a file and send it straight to the kiosk — never charged, same queue every paying customer&apos;s job goes through.</p>
      </div>

      {!isKioskOnline && <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700"><p>This kiosk isn&apos;t reachable right now — it may be powered off or offline. Printing will resume once it&apos;s back online.</p></div>}
      {isKioskUpdating && <div className="flex items-start gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm font-medium text-blue-700"><p>This kiosk is being updated right now. Try again in a minute.</p></div>}
      {/* Informational only — unlike the customer page, nothing here is
         disabled by this; see the state's own comment above for why. */}
      {printBlocked && <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700"><p>This kiosk needs attention before it can print again{printBlockedReason ? ` (${printBlockedReason})` : ""} — a submitted job will wait and resume automatically.</p></div>}

      {status === "idle" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <section className="min-w-0 space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0) basket.addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            {basket.items.length === 0 && (
              <button
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
                className={`group flex min-h-[260px] w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition ${isDragging ? "border-blue-500 bg-blue-500/10" : "border-slate-300 bg-white hover:border-blue-300"}`}
              >
                <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20 transition group-hover:-translate-y-1"><FileUp size={23} /></span>
                <span className="text-base font-bold">Drop a file here</span>
                <span className="mt-1.5 text-sm text-slate-500">PDF, image, or Word document — select or drop several at once</span>
                <span className="mt-4 rounded-full bg-slate-100 px-3 py-1 text-[11px] text-slate-500">PDF · PNG · JPG · HEIC · DOCX · max {Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB each</span>
                <span className="mt-1.5 text-[11px] text-slate-400">Up to {MAX_FILES_PER_ORDER} files · {Math.round(MAX_COMBINED_FILE_SIZE_BYTES / (1024 * 1024))} MB combined · {MAX_TOTAL_PAGES_PER_BASKET} pages combined</span>
              </button>
            )}

            {basket.items.length > 0 && (
              <div className="space-y-4">
                {basket.items.map((item, index) => (
                  <FileBasketItemCard
                    key={item.id}
                    item={item}
                    index={index}
                    itemCount={basket.items.length}
                    isDark={false}
                    muted="text-slate-500"
                    panel="border-slate-200 bg-white"
                    canEdit={canEditBasket}
                    activePages={activePagesPerItem[index] ?? []}
                    onRemove={() => basket.removeFile(item.id)}
                    onMoveUp={() => basket.moveUp(item.id)}
                    onMoveDown={() => basket.moveDown(item.id)}
                    onTogglePage={(pageNumber) => basket.togglePage(item.id, pageNumber)}
                    onSelectAll={() => basket.selectAllPages(item.id)}
                    onClearPages={() => basket.clearPages(item.id)}
                  />
                ))}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!canEditBasket || basket.items.length >= MAX_FILES_PER_ORDER}
                    className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 px-4 text-sm font-bold text-slate-600 transition hover:enabled:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={16} className="text-blue-500" /> Add more files
                  </button>
                  <span className="shrink-0 text-xs font-bold text-slate-500">{basket.items.length} / {MAX_FILES_PER_ORDER} files</span>
                </div>
                {basket.basketError && <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-600">{basket.basketError}</div>}
              </div>
            )}

            {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
          </section>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <p className="mb-4 text-sm font-black">Print settings</p>
              <div className="space-y-4">
                <SettingRow label="Copies" icon={null}>
                  <div className="flex items-center gap-1 rounded-xl border border-slate-200 p-1">
                    <button onClick={() => updateSettings("copies", Math.max(1, settings.copies - 1))} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10">−</button>
                    <span className="w-8 text-center text-sm font-black">{settings.copies}</span>
                    <button onClick={() => updateSettings("copies", settings.copies + 1)} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10">+</button>
                  </div>
                </SettingRow>
                <SettingRow label="Layout" icon={null}>
                  <Segmented value={settings.layout} options={["portrait", "landscape"]} onChange={(value) => updateSettings("layout", value as PrintSettings["layout"])} />
                </SettingRow>
                <SettingRow label="Color mode" icon={null}>
                  <Segmented
                    value={settings.isColor ? "color" : "bw"}
                    options={["bw", "color"]}
                    labels={["B&W", "Color"]}
                    disabledOptions={[...(!allowBw ? ["bw"] : []), ...(!allowColor ? ["color"] : [])]}
                    onChange={(value) => updateSettings("isColor", value === "color")}
                  />
                </SettingRow>
                <SettingRow label="Paper size" icon={null}>
                  <select value={settings.paperSize} onChange={(event) => updateSettings("paperSize", event.target.value as PaperSize)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold outline-none">
                    {(["A4", "Letter", "Legal"] as PaperSize[]).map((size) => <option key={size}>{size}</option>)}
                  </select>
                </SettingRow>
                <SettingRow label="Pages per sheet" icon={null}>
                  <Segmented value={String(settings.pagesPerSheet)} options={["1", "2", "4"]} labels={["1", "2-in-1", "4-in-1"]} onChange={(value) => updateSettings("pagesPerSheet", Number(value) as PrintSettings["pagesPerSheet"])} />
                </SettingRow>
                <div>
                  <p className="mb-2 text-xs font-bold text-slate-500">Pages</p>
                  <div className="grid grid-cols-4 gap-2">
                    {(["all", "odd", "even", "custom"] as PageMode[]).map((mode) => (
                      <button key={mode} onClick={() => updateSettings("pageMode", mode)} className={`rounded-xl border px-2 py-2 text-xs font-bold capitalize ${settings.pageMode === mode ? "border-blue-500 bg-blue-500/10 text-blue-500" : "border-slate-200"}`}>{mode}</button>
                    ))}
                  </div>
                  {settings.pageMode === "custom" && (
                    <input value={settings.customRange} onChange={(event) => updateSettings("customRange", event.target.value)} placeholder="Example: 1-5, 8" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                  )}
                </div>
                <SettingRow label="Force cover sheet" icon={null}>
                  <input type="checkbox" checked={forceCoverSheet} onChange={(event) => setForceCoverSheet(event.target.checked)} className="size-5 accent-blue-600" />
                </SettingRow>
              </div>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">
              {basket.items.length} {basket.items.length === 1 ? "file" : "files"} · {totalActivePages} of {totalPages} pages · {settings.copies} {settings.copies === 1 ? "copy" : "copies"} · free, never charged
            </div>

            <button
              onClick={handlePrint}
              disabled={status !== "idle" || basket.isProcessing || totalActivePages === 0 || isKioskUpdating}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3.5 text-sm font-black text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploadProgress !== null ? <span>Uploading... {uploadProgress}%</span> : <><Gift size={17} /> Print free</>}
            </button>
          </aside>
        </div>
      )}

      {status !== "idle" && (
        <div className="flex flex-col items-center gap-4 rounded-[2rem] border-2 border-blue-600 bg-blue-50 px-6 py-10 text-center">
          {ticketNumber !== null && (
            <div>
              <p className="text-xs font-black uppercase tracking-[0.35em] text-blue-600">Pickup code</p>
              <p className="mt-2 text-5xl font-black tracking-tight text-blue-600">{formatTicketCode(ticketNumber)}</p>
              {waivedAmount !== null && <p className="mt-2 text-xs text-blue-700">Value ₹{waivedAmount.toFixed(2)}, waived</p>}
            </div>
          )}
          {status === "submitting" && <p className="flex items-center gap-2 text-sm font-bold text-blue-600"><RefreshCw className="animate-spin" size={16} /> Submitting...</p>}
          {status === "paid" && <p className="flex items-center gap-2 text-sm font-bold text-blue-600"><RefreshCw className="animate-spin" size={16} /> Queued, starting print...</p>}
          {status === "printing" && <p className="flex items-center gap-2 text-sm font-bold text-blue-600"><Printer size={16} /> Printing...</p>}
          {status === "print_blocked" && <p className="flex items-center gap-2 text-sm font-bold text-amber-600"><Printer size={16} /> Paused — resuming automatically{jobBlockedReason ? ` (${jobBlockedReason})` : ""}.</p>}
          {status === "interrupted" && <p className="flex items-center gap-2 text-sm font-bold text-rose-600"><Printer size={16} /> Printing delayed, please wait.</p>}
          {status === "printed" && <p className="flex items-center gap-2 text-sm font-bold text-emerald-600"><Check size={16} /> Printed — collect it from the kiosk.</p>}
          {status === "print_failed" && <p className="text-sm font-bold text-red-600">{error || "Print failed."}</p>}
          {TERMINAL_STATUSES.includes(status) && (
            <button onClick={resetJob} className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-black text-white hover:bg-blue-500">Print another file</button>
          )}
        </div>
      )}
    </div>
  );
}
