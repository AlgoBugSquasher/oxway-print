import { NextResponse } from "next/server";
import { verifyRazorpayWebhookSignature } from "@/lib/payment";
import { findJobByProviderOrderId, updateJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Only useful if this server has a public HTTPS URL Razorpay can reach.
 * If it doesn't, /api/verify-payment (polled by the browser) already covers
 * payment confirmation on its own. Either way this only ever marks the job
 * "paid" in Supabase — printing happens on the Pi's separate print agent.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";

  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  if (payload.event === "payment.captured") {
    const payment = payload?.payload?.payment?.entity;
    const orderId = payment?.order_id as string | undefined;
    const paymentId = payment?.id as string | undefined;
    if (orderId) {
      const job = await findJobByProviderOrderId(orderId);
      if (job && job.status === "pending_payment") {
        await updateJob(job.id, {
          status: "paid",
          providerMeta: { ...job.providerMeta, paymentRef: paymentId || "" },
        });
      }
    }
  }

  return NextResponse.json({ received: true });
}
