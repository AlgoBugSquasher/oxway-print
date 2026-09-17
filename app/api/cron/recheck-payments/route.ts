import { NextResponse } from "next/server";
import { reconcilePendingPayment } from "@/lib/payment-reconciliation";
import { listPendingPaymentJobs } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Independent of any customer's browser tab — see ROADMAP.md #9. If a
 * customer closes the tab right after paying, nothing else re-checks that
 * job with the gateway; this route is what catches it. Meant to be hit on a
 * schedule (Vercel Cron, or any external scheduler) — not by the frontend.
 *
 * Protected by CRON_SECRET so it can't be spammed publicly (each check is an
 * outbound call to Razorpay/Cashfree). Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set on the
 * project and the request genuinely comes from Vercel's own Cron
 * infrastructure; an external scheduler needs the same header set manually.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const pendingJobs = await listPendingPaymentJobs();
    const results = await Promise.allSettled(pendingJobs.map((job) => reconcilePendingPayment(job)));
    const failed = results.filter((result) => result.status === "rejected").length;
    return NextResponse.json({ checked: pendingJobs.length, failed });
  } catch (error) {
    console.error("recheck-payments error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not recheck pending payments." },
      { status: 500 }
    );
  }
}
