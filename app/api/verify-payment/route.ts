import { jsonNoStore } from "@/lib/api-response";
import { estimateMinutesUntilReady } from "@/lib/eta";
import { reconcilePendingPayment } from "@/lib/payment-reconciliation";
import { getJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polled by the customer's own browser every few seconds. Delegates the
 * actual pending_payment -> paid/expired transition to
 * lib/payment-reconciliation.ts, which is shared with the scheduled recheck
 * (app/api/cron/recheck-payments) so both callers use the exact same atomic
 * logic — see that file and ROADMAP.md §11.
 *
 * Wrapped in try/catch end-to-end: a transient Supabase/gateway hiccup
 * should never produce a non-JSON response, since the browser polls this
 * every few seconds and needs a well-formed body every single time.
 */
export async function GET(request: Request) {
  try {
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return jsonNoStore({ error: "Missing jobId" }, { status: 400 });

    const job = await getJob(jobId);
    if (!job) return jsonNoStore({ error: "Job not found" }, { status: 404 });

    const reconciled = await reconcilePendingPayment(job);

    // ROADMAP.md #3 — only meaningful while the job is still in the queue;
    // best-effort so a transient ETA failure never breaks the status poll
    // the customer's whole payment flow depends on.
    let etaMinutes: number | undefined;
    if (reconciled.status === "paid" || reconciled.status === "printing") {
      try {
        etaMinutes = await estimateMinutesUntilReady(reconciled);
      } catch (etaError) {
        console.error("estimateMinutesUntilReady failed:", etaError);
      }
    }

    return jsonNoStore({
      jobId: reconciled.id,
      status: reconciled.status,
      error: reconciled.error,
      etaMinutes,
      // ROADMAP.md §22 — the customer's own pickup code, once payment is
      // confirmed. Present from job creation onward (§21 assigns it up
      // front), but only meaningful to show the customer from here, since
      // pending_payment is included in this same poll and showing a ticket
      // code before they've paid would be misleading.
      ticketNumber: reconciled.status === "pending_payment" ? undefined : reconciled.ticketNumber,
      // Lets the status page distinguish "print_failed, refund issued" from
      // "print_failed, refund itself also failed" (attemptRefund in
      // lib/refund.ts only sets this once the refund genuinely succeeded at
      // the gateway) — a double-failure the customer needs to see, not one
      // silently masked behind a generic "failed" message.
      refundedAt: reconciled.refundedAt,
    });
  } catch (error) {
    console.error("verify-payment error:", error);
    return jsonNoStore(
      { error: error instanceof Error ? error.message : "Could not check payment status." },
      { status: 500 }
    );
  }
}
