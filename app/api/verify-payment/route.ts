import { NextResponse } from "next/server";
import { PAYMENT_TIMEOUT_SECONDS } from "@/lib/config";
import { verifyOrder } from "@/lib/payment";
import { getJob, updateJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polled by the customer's own browser every few seconds. Confirms payment
 * directly with the gateway (an outbound call, so it works regardless of
 * where this is hosted) and flips the job to "paid" — it does NOT print
 * anything itself. The Pi's print agent (print-agent/index.ts) is a
 * completely separate process that watches Supabase for "paid" jobs and
 * takes it from there, since the website and the printer are on different
 * machines.
 *
 * Wrapped in try/catch end-to-end: a transient Supabase/gateway hiccup
 * should never produce a non-JSON response, since the browser polls this
 * every few seconds and needs a well-formed body every single time.
 */
export async function GET(request: Request) {
  try {
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

    let job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    if (job.status === "pending_payment") {
      const ageSeconds = (Date.now() - new Date(job.createdAt).getTime()) / 1000;
      if (ageSeconds > PAYMENT_TIMEOUT_SECONDS) {
        job = (await updateJob(jobId, { status: "expired" })) ?? job;
      } else {
        const result = await verifyOrder(job.provider, job.providerOrderId);
        if (result.paid) {
          job = (await updateJob(jobId, {
            status: "paid",
            providerMeta: { ...job.providerMeta, paymentRef: result.paymentRef || "" },
          })) ?? job;
        }
      }
    }

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      error: job.error,
    });
  } catch (error) {
    console.error("verify-payment error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not check payment status." },
      { status: 500 }
    );
  }
}
