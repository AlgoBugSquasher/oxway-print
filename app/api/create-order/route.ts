import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getActiveProvider } from "@/lib/config";
import { createOrder } from "@/lib/payment";
import { extractSelectedPages } from "@/lib/print/pdf";
import { createJob, updateJob, uploadJobPdf, type PrintJobRecord, type PrintSettingsSnapshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Uploads the final print-ready PDF to Supabase Storage and writes a job row,
 * then creates an order with the active payment gateway. The website and the
 * Pi's print agent only ever talk to each other through that Supabase row —
 * see SUPABASE_SETUP.md.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const fileName = String(formData.get("fileName") || "");
    const selectedPages = JSON.parse(String(formData.get("selectedPages") || "[]")) as number[];
    const settings = JSON.parse(String(formData.get("settings") || "{}")) as PrintSettingsSnapshot;
    const totalPrice = Number(formData.get("totalPrice") || 0);

    if (!(file instanceof File)) return jsonError("Missing print-ready PDF.");
    if (!fileName) return jsonError("Missing file name.");
    if (!Array.isArray(selectedPages) || selectedPages.length === 0) return jsonError("Select at least one page.");
    if (!totalPrice || totalPrice <= 0) return jsonError("Invalid order total.");

    const jobId = crypto.randomUUID();
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const finalPdfBytes = await extractSelectedPages(originalBytes, selectedPages);
    const pdfStoragePath = await uploadJobPdf(jobId, finalPdfBytes);

    const now = new Date().toISOString();
    const provider = getActiveProvider();

    // Create the job first so it exists even if gateway order creation fails,
    // then attach the gateway's order id.
    const job: PrintJobRecord = {
      id: jobId,
      status: "pending_payment",
      fileName,
      selectedPages,
      settings,
      totalPrice,
      provider,
      providerOrderId: "",
      pdfStoragePath,
      createdAt: now,
      updatedAt: now,
    };
    await createJob(job);

    const order = await createOrder({ jobId, amountRupees: totalPrice, fileName });
    await updateJob(jobId, {
      providerOrderId: order.providerOrderId,
      providerMeta: order.provider === "cashfree"
        ? { paymentSessionId: order.paymentSessionId }
        : { keyId: order.keyId, amount: String(order.amount) },
    });

    return NextResponse.json({ jobId, ...order });
  } catch (error) {
    console.error("create-order error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create the payment order." },
      { status: 500 }
    );
  }
}
