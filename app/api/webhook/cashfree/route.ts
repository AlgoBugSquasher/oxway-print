import { NextResponse } from "next/server";
import { verifyCashfreeWebhookSignature } from "@/lib/payment";
import { findJobByProviderOrderId, updateJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Only useful if this server has a public HTTPS URL Cashfree can reach.
 * If it doesn't, /api/verify-payment (polled by the browser) already covers
 * payment confirmation on its own. Either way this only ever marks the job
 * "paid" in Supabase — printing happens on the Pi's separate print agent.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-webhook-signature") || "";
  const timestamp = request.headers.get("x-webhook-timestamp") || "";

  if (!verifyCashfreeWebhookSignature(rawBody, signature, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const orderId = payload?.data?.order?.order_id as string | undefined;
  const orderStatus = payload?.data?.order?.order_status as string | undefined;
  const paymentRef = payload?.data?.payment?.cf_payment_id as string | undefined;

  if (orderId && orderStatus === "PAID") {
    const job = await findJobByProviderOrderId(orderId);
    if (job && job.status === "pending_payment") {
      await updateJob(job.id, {
        status: "paid",
        providerMeta: { ...job.providerMeta, paymentRef: paymentRef ? String(paymentRef) : "" },
      });
    }
  }

  return NextResponse.json({ received: true });
}
