"use client";

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
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import LivePrintPreview from "@/components/LivePrintPreview";
import { convertFileInBrowser, isSupportedClientFile } from "@/lib/client-file-converter";
import { loadRazorpayCheckout } from "@/lib/loadRazorpay";

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

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
  | "expired";

type PrintSettings = {
  copies: number;
  layout: Layout;
  isColor: boolean;
  pageMode: PageMode;
  customRange: string;
  paperSize: PaperSize;
  pagesPerSheet: 1 | 2 | 4;
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const PRICE_BW = 2;
const PRICE_COLOR = 10;

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
  const [isDark, setIsDark] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [orderStatus, setOrderStatus] = useState<OrderStatus>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Holds the converted PDF's bytes so the final file can be uploaded again at
  // payment time — pdfjs consumes the response body when rendering thumbnails.
  const pdfBytesRef = useRef<Uint8Array | null>(null);

  const activePages = useMemo(() => {
    if (settings.pageMode === "all") return selectedPages;
    if (settings.pageMode === "odd") return selectedPages.filter((page) => page % 2 === 1);
    if (settings.pageMode === "even") return selectedPages.filter((page) => page % 2 === 0);
    return parsePageRange(settings.customRange, totalPages).filter((page) => selectedPages.includes(page));
  }, [selectedPages, settings.customRange, settings.pageMode, totalPages]);

  const billableSheets = Math.ceil(activePages.length / settings.pagesPerSheet) * settings.copies;
  const totalPrice = billableSheets * (settings.isColor ? PRICE_COLOR : PRICE_BW);
  const updateSettings = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const processFile = async (uploadedFile: File) => {
    setError("");
    if (!isSupportedClientFile(uploadedFile)) return setError("Unsupported file. Upload a PDF, PNG, JPG, JPEG, WEBP, HEIC, HEIF, or DOCX file.");
    if (uploadedFile.size > MAX_FILE_SIZE) return setError("This file is larger than the 25 MB kiosk limit.");
    setFile(uploadedFile);
    setIsLoading(true);
    setThumbnails([]);
    const isBrowserPreviewableImage = uploadedFile.type.startsWith("image/") && !/\.(heic|heif)$/i.test(uploadedFile.name) && !["image/heic", "image/heif"].includes(uploadedFile.type);
    setPreviewUrl(isBrowserPreviewableImage ? URL.createObjectURL(uploadedFile) : "");
    setOrderStatus("idle");
    setJobId(null);
    pdfBytesRef.current = null;
    try {
      const normalizedPdfBytes = await convertFileInBrowser(uploadedFile);
      pdfBytesRef.current = normalizedPdfBytes;
      const pdf = await pdfjsLib.getDocument({ data: normalizedPdfBytes.slice() }).promise;
      setTotalPages(pdf.numPages);
      setSelectedPages(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
      const renderedPages: PageThumbnail[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
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
      console.error(loadError);
      setFile(null);
      setPreviewUrl("");
      setError(loadError instanceof Error ? loadError.message : "We could not read this file. Please try another one.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (uploadedFile) void processFile(uploadedFile);
    event.target.value = "";
  };

  const togglePage = (pageNumber: number) => setSelectedPages((pages) => pages.includes(pageNumber) ? pages.filter((page) => page !== pageNumber) : [...pages, pageNumber].sort((a, b) => a - b));

  // Creates the order with whichever gateway is live (PAYMENT_PROVIDER env var
  // on the server) and opens that gateway's own checkout modal — Card /
  // Netbanking / UPI (with its own QR), for both Cashfree and Razorpay.
  // Actual payment confirmation and printing happen server-side: this
  // component never trusts the modal's own success callback by itself, it
  // just kicks off polling (see the effect below) which asks the server,
  // which asks the gateway directly.
  const handleStartPayment = async () => {
    if (!file || !pdfBytesRef.current || activePages.length === 0) return setError("Select at least one page before paying.");
    setError("");
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", new Blob([pdfBytesRef.current.slice().buffer], { type: "application/pdf" }), file.name);
      formData.append("fileName", file.name);
      formData.append("selectedPages", JSON.stringify(activePages));
      formData.append("settings", JSON.stringify(settings));
      formData.append("totalPrice", String(totalPrice));

      const response = await fetch("/api/create-order", { method: "POST", body: formData });
      const order = await response.json();
      if (!response.ok) throw new Error(order.error || "Could not create payment order");

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
    }
  };

  // Polls the server for real payment/print status. The server verifies
  // payment directly with the gateway (outbound call, works from anywhere)
  // and the kiosk's separate print agent picks up "paid" jobs and prints
  // them — this just reflects that status back to the customer.
  useEffect(() => {
    if (!jobId) return;
    if (["printed", "print_failed", "payment_failed", "expired"].includes(orderStatus)) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/verify-payment?jobId=${jobId}`);
        const data = await response.json();
        if (!response.ok || cancelled) return;
        setOrderStatus((current) => {
          if (data.status === current) return current;
          if (data.status === "paid" || data.status === "printed") {
            confetti({ particleCount: data.status === "printed" ? 100 : 80, spread: 75, origin: { y: 0.7 } });
          }
          if (data.status === "print_failed" || data.status === "payment_failed") {
            setError(data.error || "Something went wrong. Please see kiosk staff.");
          }
          return data.status;
        });
      } catch (pollError) {
        console.error("Status poll error:", pollError);
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, orderStatus]);

  const resetOrder = () => {
    setOrderStatus("idle");
    setJobId(null);
    setError("");
  };

  const theme = isDark ? "bg-[#101419] text-slate-100" : "bg-[#f4f6f8] text-slate-950";
  const panel = isDark ? "border-white/10 bg-white/[0.06]" : "border-slate-200 bg-white";
  const muted = isDark ? "text-slate-400" : "text-slate-500";

  return <div className={`min-h-screen pb-36 transition-colors duration-300 ${theme}`}>
    <header className={`sticky top-0 z-20 border-b backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/85" : "border-slate-200/80 bg-[#f4f6f8]/85"}`}><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 lg:px-8"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20"><Printer size={19} /></div><div><p className="text-sm font-black tracking-[0.16em] text-blue-600">OXWAY</p><p className={`text-xs ${muted}`}>Smart print kiosk</p></div></div><div className="flex items-center gap-2"><span className="hidden items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-500 sm:flex"><span className="size-1.5 rounded-full bg-emerald-500" />Online</span><Link href="/admin" className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${isDark ? "border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/10" : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100"}`}>Admin</Link><button aria-label="Toggle color theme" onClick={() => setIsDark((value) => !value)} className={`grid size-10 place-items-center rounded-xl border ${panel}`}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</button></div></div></header>
    <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1fr_330px] lg:px-8"><section className="min-w-0"><div className="mb-7 flex items-end justify-between gap-4"><div><p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-500">01 / Upload</p><h1 className="text-3xl font-black tracking-tight sm:text-4xl">Print without the queue.</h1><p className={`mt-2 text-sm ${muted}`}>Upload a PDF, tune your print settings, and send it straight to the kiosk.</p></div>{file && <button onClick={() => fileInputRef.current?.click()} className="hidden rounded-xl border border-blue-500/30 px-3 py-2 text-xs font-bold text-blue-500 sm:block">Change file</button>}</div><button type="button" onClick={() => setIsPreviewOpen(true)} className={`mb-4 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-bold lg:hidden ${panel}`}><span>Preview print</span><span className="text-blue-500">View sheet</span></button>
      <input ref={fileInputRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={handleFileInput} />
      {!file && !isLoading && <button type="button" onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={(event) => { event.preventDefault(); setIsDragging(false); const droppedFile = event.dataTransfer.files[0]; if (droppedFile) void processFile(droppedFile); }} className={`group flex min-h-[320px] w-full flex-col items-center justify-center rounded-[2rem] border-2 border-dashed p-8 text-center transition ${isDragging ? "border-blue-500 bg-blue-500/10" : `${isDark ? "border-white/15 bg-white/[0.04]" : "border-slate-300 bg-white/70 hover:border-blue-300 hover:bg-white"}`}`}><span className="mb-5 grid size-16 place-items-center rounded-3xl bg-blue-600 text-white shadow-xl shadow-blue-600/20 transition group-hover:-translate-y-1"><FileUp size={27} /></span><span className="text-lg font-bold">Drop your file here</span><span className={`mt-2 text-sm ${muted}`}>PDF, image, or Word document</span><span className={`mt-6 rounded-full px-3 py-1 text-[11px] ${isDark ? "bg-white/10 text-slate-300" : "bg-slate-100 text-slate-500"}`}>PDF · PNG · JPG · HEIC · DOCX · max 25 MB</span></button>}
      {isLoading && <div className={`flex min-h-[320px] flex-col items-center justify-center rounded-[2rem] border p-8 ${panel}`}>{previewUrl && <img src={previewUrl} alt="Uploaded image preview" className="mb-5 max-h-48 max-w-full rounded-xl object-contain shadow-md" />}<RefreshCw className="mb-4 animate-spin text-blue-500" size={30} /><p className="font-semibold">Preparing your document...</p><p className={`mt-1 text-sm ${muted}`}>Converting to a printable A4 PDF</p></div>}
      {file && !isLoading && <><div className={`mb-5 flex items-center gap-4 rounded-2xl border p-4 ${panel}`}><div className="grid size-11 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-500"><FileText size={21} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{file.name}</p><p className={`mt-1 text-xs ${muted}`}>{(file.size / (1024 * 1024)).toFixed(2)} MB · {totalPages} pages</p></div><button onClick={() => fileInputRef.current?.click()} className="rounded-xl p-2 text-blue-500 sm:hidden"><RefreshCw size={17} /></button></div><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">02 / Select pages</p><p className={`mt-1 text-sm ${muted}`}>{activePages.length} active pages · tap a page to include or exclude</p></div><div className="flex gap-2"><button onClick={() => setSelectedPages(Array.from({ length: totalPages }, (_, index) => index + 1))} className="text-xs font-bold text-blue-500">All</button><button onClick={() => setSelectedPages([])} className={`text-xs font-bold ${muted}`}>Clear</button></div></div><div className={`grid max-h-[560px] grid-cols-2 gap-3 overflow-y-auto rounded-3xl border p-3 sm:grid-cols-3 xl:grid-cols-4 ${isDark ? "border-white/10 bg-white/[0.03]" : "border-slate-200 bg-slate-100/70"}`}>{thumbnails.map((thumbnail) => { const selected = selectedPages.includes(thumbnail.pageNumber); return <button key={thumbnail.pageNumber} onClick={() => togglePage(thumbnail.pageNumber)} className={`relative overflow-hidden rounded-2xl border-2 bg-white p-1 text-left transition hover:-translate-y-0.5 ${selected ? "border-blue-500 shadow-lg shadow-blue-500/10" : "border-transparent opacity-45 grayscale"}`}><img src={thumbnail.dataUrl} alt={`Page ${thumbnail.pageNumber}`} className="aspect-[1/1.35] w-full object-contain" /><span className="absolute left-3 top-3 rounded-md bg-white/90 px-1.5 py-1 text-[10px] font-black text-slate-600">{thumbnail.pageNumber}</span><span className="absolute right-3 top-3 text-blue-600">{selected ? <CheckCircle2 size={19} fill="white" /> : <Circle size={19} />}</span></button>; })}</div></>}
      {error && <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
    </section><aside className="lg:pt-[86px]"><div className={`rounded-[2rem] border p-5 shadow-xl shadow-slate-900/5 ${panel}`}><div className="mb-5 flex items-center justify-between"><div><p className={`text-xs font-bold uppercase tracking-[0.2em] ${muted}`}>Print order</p><p className="mt-1 text-lg font-black">Configure output</p></div><Settings2 className="text-blue-500" size={19} /></div><div className={`mb-4 rounded-2xl p-4 ${isDark ? "bg-blue-500/10" : "bg-blue-50"}`}><div className="flex items-center justify-between"><span className={`text-xs font-semibold ${muted}`}>Estimated total</span><span className="text-2xl font-black text-blue-600">₹{totalPrice}</span></div><div className={`mt-2 text-xs ${muted}`}>{billableSheets} billable sheets · {activePages.length} pages · {settings.copies} {settings.copies === 1 ? "copy" : "copies"}</div></div><button onClick={() => setIsSettingsOpen(true)} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-bold ${isDark ? "border-white/10" : "border-slate-200"}`}><span className="flex items-center gap-2"><LayoutGrid size={16} className="text-blue-500" /> Print settings</span><ChevronDown size={16} className={muted} /></button><div className={`mt-4 space-y-3 text-xs ${muted}`}><div className="flex justify-between"><span>Color mode</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.isColor ? "Color" : "B&W"}</b></div><div className="flex justify-between"><span>Paper</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.paperSize} · {settings.layout}</b></div><div className="flex justify-between"><span>Pages per sheet</span><b className={isDark ? "text-slate-200" : "text-slate-700"}>{settings.pagesPerSheet}</b></div></div></div></aside></main>
    {file && <div className={`fixed bottom-0 left-0 right-0 z-30 border-t backdrop-blur-xl ${isDark ? "border-white/10 bg-[#101419]/90" : "border-slate-200 bg-white/90"}`}><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 lg:px-8"><div><p className={`text-xs font-bold uppercase tracking-[0.15em] ${muted}`}>Total payable</p><p className="text-2xl font-black">₹{totalPrice}</p></div>{orderStatus === "idle" && <button onClick={handleStartPayment} disabled={isLoading || activePages.length === 0} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">{isLoading ? <RefreshCw className="animate-spin" size={17} /> : <span>Pay ₹{totalPrice}</span>}</button>}
      {orderStatus === "pending_payment" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Waiting for payment...</div>}
      {orderStatus === "paid" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><RefreshCw className="animate-spin" size={17} /> Payment confirmed, starting print...</div>}
      {orderStatus === "printing" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-blue-500/10 px-5 py-3.5 text-sm font-black text-blue-500"><Printer size={17} /> Printing your document...</div>}
      {orderStatus === "printed" && <div className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-5 py-3.5 text-sm font-black text-emerald-500"><Check size={17} /> Printed — please collect it</div>}
      {orderStatus === "expired" && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3.5 text-sm font-black text-white">Payment expired — try again</button>}
      {(orderStatus === "print_failed" || orderStatus === "payment_failed") && <button onClick={resetOrder} className="flex min-w-[180px] items-center justify-center gap-2 rounded-xl bg-red-500 px-5 py-3.5 text-sm font-black text-white">Failed — try again</button>}
    </div></div>}
    {isSettingsOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSettingsOpen(false); }}><div className={`w-full max-w-lg rounded-t-[2rem] p-6 shadow-2xl sm:rounded-[2rem] ${isDark ? "bg-[#171d24]" : "bg-white"}`}><div className="mb-6 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Print settings</p><h2 className="mt-1 text-xl font-black">Tune your document</h2></div><button onClick={() => setIsSettingsOpen(false)} className={`grid size-9 place-items-center rounded-xl ${isDark ? "bg-white/10" : "bg-slate-100"}`}><X size={17} /></button></div><div className="space-y-5"><SettingRow label="Copies" icon={<Copy size={16} />}><div className={`flex items-center gap-1 rounded-xl border p-1 ${isDark ? "border-white/10" : "border-slate-200"}`}><button onClick={() => updateSettings("copies", Math.max(1, settings.copies - 1))} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Minus size={15} /></button><span className="w-8 text-center text-sm font-black">{settings.copies}</span><button onClick={() => updateSettings("copies", settings.copies + 1)} className="grid size-8 place-items-center rounded-lg hover:bg-blue-500/10"><Plus size={15} /></button></div></SettingRow><SettingRow label="Layout" icon={<LayoutGrid size={16} />}><Segmented value={settings.layout} options={["portrait", "landscape"]} onChange={(value) => updateSettings("layout", value as Layout)} /></SettingRow><SettingRow label="Color mode" icon={<Palette size={16} />}><Segmented value={settings.isColor ? "color" : "bw"} options={["bw", "color"]} labels={["B&W · ₹2", "Color · ₹10"]} onChange={(value) => updateSettings("isColor", value === "color")} /></SettingRow><div><p className={`mb-2 text-sm font-bold ${muted}`}>Pages</p><div className="grid grid-cols-4 gap-2">{(["all", "odd", "even", "custom"] as PageMode[]).map((mode) => <button key={mode} onClick={() => updateSettings("pageMode", mode)} className={`rounded-xl border px-2 py-2.5 text-xs font-bold capitalize ${settings.pageMode === mode ? "border-blue-500 bg-blue-500/10 text-blue-500" : isDark ? "border-white/10" : "border-slate-200"}`}>{mode}</button>)}</div>{settings.pageMode === "custom" && <input value={settings.customRange} onChange={(event) => updateSettings("customRange", event.target.value)} placeholder="Example: 1-5, 8" className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:border-blue-500 ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`} />}</div><SettingRow label="Paper size" icon={<FileText size={16} />}><select value={settings.paperSize} onChange={(event) => updateSettings("paperSize", event.target.value as PaperSize)} className={`rounded-xl border px-3 py-2 text-xs font-bold outline-none ${isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-slate-50"}`}>{(["A4", "Letter", "Legal"] as PaperSize[]).map((size) => <option key={size}>{size}</option>)}</select></SettingRow><SettingRow label="Pages per sheet" icon={<LayoutGrid size={16} />}><Segmented value={String(settings.pagesPerSheet)} options={["1", "2", "4"]} labels={["1", "2 in 1", "4 in 1"]} onChange={(value) => updateSettings("pagesPerSheet", Number(value) as 1 | 2 | 4)} /></SettingRow></div><button onClick={() => setIsSettingsOpen(false)} className="mt-7 w-full rounded-xl bg-blue-600 py-3.5 text-sm font-black text-white">Apply settings</button></div></div>}
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-20 hidden justify-center px-5 lg:flex">
      <div className="pointer-events-auto rounded-[2rem] border border-slate-200 bg-white p-5 shadow-2xl">
        <LivePrintPreview settings={settings} activePages={activePages} thumbnails={thumbnails} imagePreviewUrl={previewUrl} fileType={file?.type} />
      </div>
    </div>
    {isPreviewOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-5 lg:hidden"><div className="max-h-[90vh] overflow-y-auto rounded-[2rem] bg-white p-5"><LivePrintPreview settings={settings} activePages={activePages} thumbnails={thumbnails} imagePreviewUrl={previewUrl} fileType={file?.type} isOpen onClose={() => setIsPreviewOpen(false)} /></div></div>}
  </div>;
}

function SettingRow({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-sm font-bold text-slate-500">{icon}{label}</span>{children}</div>;
}

function Segmented({ value, options, labels = options, onChange }: { value: string; options: string[]; labels?: string[]; onChange: (value: string) => void }) {
  return <div className="flex rounded-xl border border-slate-200 p-1 dark:border-white/10">{options.map((option, index) => <button key={option} onClick={() => onChange(option)} className={`rounded-lg px-2.5 py-2 text-[11px] font-bold transition ${value === option ? "bg-blue-600 text-white" : "text-slate-500"}`}>{labels[index]}</button>)}</div>;
}
