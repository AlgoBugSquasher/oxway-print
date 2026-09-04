"use client";

import React, { useState } from "react";
import { CheckCircle2, Circle, Copy, FileUp, Printer, RefreshCw } from "lucide-react";
import confetti from "canvas-confetti";

import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface PageThumbnail {
  pageNumber: number;
  dataUrl: string;
}

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  handler: (response: RazorpayPaymentResponse) => void;
  modal?: {
    ondismiss?: () => void;
  };
  theme?: {
    color?: string;
  };
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => { open: () => void };
  }
}

const loadRazorpayScript = () =>
  new Promise<boolean>((resolve) => {
    const existingScript = document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
    );

    if (existingScript) {
      resolve(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

export default function SmartPrintKiosk() {
  const [file, setFile] = useState<File | null>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [copies, setCopies] = useState<number>(1);
  const [isColor, setIsColor] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  const [isPaid, setIsPaid] = useState<boolean>(false);
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [printSuccess, setPrintSuccess] = useState<boolean>(false);

  const PRICE_BW = 2;
  const PRICE_COLOR = 10;
  const unitPrice = isColor ? PRICE_COLOR : PRICE_BW;
  const totalPrice = selectedPages.length * copies * unitPrice;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile || uploadedFile.type !== "application/pdf") {
      alert("Sirf PDF file upload karein!");
      return;
    }

    setFile(uploadedFile);
    setLoading(true);
    setThumbnails([]);
    setSelectedPages([]);
    setIsPaid(false);
    setPrintSuccess(false);

    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const numPages = pdf.numPages;
      setTotalPages(numPages);
      setSelectedPages(Array.from({ length: numPages }, (_, i) => i + 1));

      const thumbs: PageThumbnail[] = [];
      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 0.35 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          thumbs.push({ pageNumber: i, dataUrl: canvas.toDataURL() });
        }
      }
      setThumbnails(thumbs);
    } catch (err) {
      console.error(err);
      alert("PDF load karne me issue aaya!");
    } finally {
      setLoading(false);
    }
  };

  const togglePage = (pageNumber: number) => {
    setSelectedPages((prev) =>
      prev.includes(pageNumber)
        ? prev.filter((p) => p !== pageNumber)
        : [...prev, pageNumber].sort((a, b) => a - b)
    );
  };

  const handlePayment = async () => {
    if (selectedPages.length === 0) {
      alert("Kam se kam 1 page select hona chahiye!");
      return;
    }

    setLoading(true);

    try {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded || !window.Razorpay) {
        alert("Razorpay checkout load nahi ho paya. Internet connection check karein.");
        setLoading(false);
        return;
      }

      const orderResponse = await fetch("/api/razorpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: totalPrice }),
      });

      if (!orderResponse.ok) {
        const err = await orderResponse.json();
        console.error("Order creation failed:", err);
        alert(err.error || err.message || "Failed to create order");
        setLoading(false);
        return;
      }

      const orderData = await orderResponse.json();

      const targetOrderId = orderData.orderId || orderData.id;
      if (!targetOrderId) {
        alert("Server se Order ID nahi mili!");
        setLoading(false);
        return;
      }

      const razorpay = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency || "INR",
        order_id: targetOrderId,
        name: "OXWAY Smart Kiosk",
        description: "Document Printing",
        handler: (response: RazorpayPaymentResponse) => {
          setIsPaid(true);
          alert(`Payment Successful! Payment ID: ${response.razorpay_payment_id}`);
          setLoading(false);
          confetti({ particleCount: 60, spread: 60, origin: { y: 0.8 } });
        },
        modal: {
          ondismiss: () => {
            setLoading(false);
          },
        },
        theme: {
          color: "#2563eb",
        },
      });

      setLoading(false);
      razorpay.open();
    } catch (error: unknown) {
      console.error("Payment flow error:", error);
      setLoading(false);
      alert(
        "Payment Error: " +
          (error instanceof Error ? error.message : "Something went wrong")
      );
    }
  };

  const handlePrint = async () => {
    setIsPrinting(true);

    try {
      const response = await fetch("/api/print-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file?.name,
          selectedPages,
          copies,
          isColor,
          totalPrice,
        }),
      });

      if (!response.ok) {
        throw new Error("Print job request failed");
      }

      await response.json();
      setIsPrinting(false);
      setPrintSuccess(true);
      window.print();
      alert("Your document has been sent to the printer successfully.");
      confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
    } catch (error) {
      console.error(error);
      setIsPrinting(false);
      alert("Unable to send the document to the printer. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 pb-32">
      <header className="bg-white border-b px-4 py-3 sticky top-0 z-20 flex justify-between items-center shadow-sm">
        <div>
          <h1 className="text-base font-black text-blue-600 tracking-tight">OXWAY PRINT</h1>
          <p className="text-[11px] text-slate-500">Scan • Upload • Print</p>
        </div>
        <span className="text-[11px] bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">
          ● Online
        </span>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-4">
        {!file && (
          <div className="border-2 border-dashed border-blue-300 bg-white rounded-2xl p-8 text-center shadow-sm">
            <input
              type="file"
              accept=".pdf"
              id="file-upload"
              className="hidden"
              onChange={handleFileUpload}
            />
            <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
              <div className="w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center mb-3 shadow-md">
                <FileUp className="w-7 h-7" />
              </div>
              <span className="font-bold text-slate-800 text-sm">Upload Document</span>
              <span className="text-xs text-slate-500 mt-1">Tap karke PDF select karo</span>
            </label>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 text-blue-600 animate-spin mb-2" />
            <p className="text-xs text-slate-600 font-medium">Processing...</p>
          </div>
        )}

        {file && !loading && (
          <>
            <div className="bg-white rounded-xl p-3.5 border shadow-sm flex items-center justify-between">
              <div className="truncate pr-2">
                <p className="font-semibold text-xs text-slate-800 truncate">{file.name}</p>
                <p className="text-[11px] text-slate-500">Total {totalPages} Pages</p>
              </div>
              <label
                htmlFor="change-file"
                className="text-[11px] font-bold text-blue-600 cursor-pointer bg-blue-50 px-2.5 py-1 rounded-lg shrink-0"
              >
                Change
              </label>
              <input type="file" accept=".pdf" id="change-file" className="hidden" onChange={handleFileUpload} />
            </div>

            <div className="bg-white rounded-xl p-4 border shadow-sm space-y-3">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Print Settings</span>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setIsColor(false)}
                  className={`py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 ${
                    !isColor ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-900 inline-block"></span>
                  B & W (₹{PRICE_BW}/p)
                </button>
                <button
                  type="button"
                  onClick={() => setIsColor(true)}
                  className={`py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 ${
                    isColor ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-r from-red-500 via-green-500 to-blue-500 inline-block"></span>
                  Color (₹{PRICE_COLOR}/p)
                </button>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                  <Copy className="w-3.5 h-3.5 text-slate-400" /> Copies:
                </span>
                <div className="flex items-center border rounded-lg bg-slate-50 overflow-hidden">
                  <button
                    onClick={() => setCopies(Math.max(1, copies - 1))}
                    className="px-2.5 py-0.5 text-slate-700 font-bold hover:bg-slate-200"
                  >
                    -
                  </button>
                  <span className="px-2.5 py-0.5 font-bold text-xs bg-white min-w-[28px] text-center">
                    {copies}
                  </span>
                  <button
                    onClick={() => setCopies(copies + 1)}
                    className="px-2.5 py-0.5 text-slate-700 font-bold hover:bg-slate-200"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                  Pages ({selectedPages.length}/{totalPages})
                </span>
                <div className="flex gap-2 text-[11px]">
                  <button
                    onClick={() => setSelectedPages(Array.from({ length: totalPages }, (_, i) => i + 1))}
                    className="text-blue-600 font-semibold"
                  >
                    Select All
                  </button>
                  <span className="text-slate-300">|</span>
                  <button onClick={() => setSelectedPages([])} className="text-slate-500 font-semibold">
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5 max-h-[320px] overflow-y-auto p-1.5 border rounded-xl bg-slate-200/50">
                {thumbnails.map((thumb) => {
                  const isSelected = selectedPages.includes(thumb.pageNumber);
                  return (
                    <div
                      key={thumb.pageNumber}
                      onClick={() => togglePage(thumb.pageNumber)}
                      className={`relative cursor-pointer rounded-lg border-2 overflow-hidden bg-white shadow-sm aspect-[1/1.4] flex flex-col justify-between p-1 transition ${
                        isSelected ? "border-blue-600 ring-2 ring-blue-500/20" : "border-transparent opacity-50"
                      }`}
                    >
                      <div className="absolute top-1.5 right-1.5 z-10">
                        {isSelected ? (
                          <CheckCircle2 className="w-5 h-5 text-blue-600 fill-white" />
                        ) : (
                          <Circle className="w-5 h-5 text-slate-400 bg-white/80 rounded-full" />
                        )}
                      </div>
                      <img
                        src={thumb.dataUrl}
                        alt={`Page ${thumb.pageNumber}`}
                        className="w-full h-full object-contain pointer-events-none"
                      />
                      <div className="text-center text-[10px] font-bold text-slate-600 bg-slate-100 py-0.5 rounded mt-0.5">
                        P. {thumb.pageNumber}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>

      {file && !loading && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-3.5 shadow-2xl z-30">
          <div className="max-w-md mx-auto flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] text-slate-400 font-semibold">TOTAL</p>
              <p className="text-xl font-black text-slate-900 leading-none">₹{totalPrice}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {selectedPages.length} pgs • {copies} copy
              </p>
            </div>

            {!isPaid ? (
              <button
                onClick={handlePayment}
                disabled={selectedPages.length === 0}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold py-3 px-4 rounded-xl shadow-md text-xs transition"
              >
                Pay ₹{totalPrice}
              </button>
            ) : !printSuccess ? (
              <button
                onClick={handlePrint}
                disabled={isPrinting}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-4 rounded-xl shadow-md text-xs flex items-center justify-center gap-2 transition"
              >
                <Printer className="w-4 h-4" />
                {isPrinting ? "Sending..." : "Print Document"}
              </button>
            ) : (
              <div className="flex-1 bg-slate-900 text-white font-bold py-3 px-3 rounded-xl text-[11px] text-center">
                Printing in Progress! Slot check karein.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}