import { NextResponse } from "next/server";
import { AGENT_API_SECRET } from "@/lib/config";
import { notifyPrintCompleted, notifyPrintFailedRefunded } from "@/lib/notify";
import { claimJobForNotification, getJob } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called by the print agent (print-agent/index.ts) whenever a job reaches a
 * terminal state it might need to notify the customer about — printed, or
 * print_failed after the agent's own auto-refund attempt (lib/refund.ts).
 * All the actual business rules live here, not on the Pi: does this job
 * even want a WhatsApp update, which terminal state is it, has one already
 * been sent. That keeps "when do we notify" in exactly one place instead
 * of duplicated across the agent's two call sites — the agent's job is
 * just "ping me, I'll work out whether anything needs sending."
 *
 * Safe to call more than once for the same job (network retry, the agent
 * calling it from more than one place) — claimJobForNotification's atomic
 * `UPDATE ... WHERE notified_at IS NULL` makes every call after the first
 * a no-op rather than a second WhatsApp message.
 *
 * Bearer-token auth (AGENT_API_SECRET) — same shared-secret pattern the
 * cron routes use for CRON_SECRET. The Pi is the only caller and has no
 * browser/RLS session to issue a real one; a plain shared secret is
 * sufficient for a trusted server-to-server call like this.
 */
export async function POST(request: Request) {
  if (!AGENT_API_SECRET) {
    return NextResponse.json({ error: "AGENT_API_SECRET is not configured." }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${AGENT_API_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { jobId } = (await request.json()) as { jobId?: string };
    if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    if (!job.notifyOptIn) return NextResponse.json({ sent: false, reason: "not_opted_in" });

    const isPrinted = job.status === "printed";
    // Deliberately NOT sent when a print_failed job's refund also failed —
    // see lib/notify/index.ts's notifyPrintFailedRefunded docstring for why
    // that case is left to staff follow-up instead of a message claiming a
    // refund that hasn't actually happened.
    const isFailedAndRefunded = job.status === "print_failed" && Boolean(job.refundedAt);
    if (!isPrinted && !isFailedAndRefunded) {
      return NextResponse.json({ sent: false, reason: "not_a_notifiable_terminal_state" });
    }

    const claimed = await claimJobForNotification(jobId);
    if (!claimed) return NextResponse.json({ sent: false, reason: "already_notified" });

    if (isPrinted) {
      await notifyPrintCompleted({ id: claimed.id, phoneNumber: claimed.phoneNumber, ticketNumber: claimed.ticketNumber });
    } else {
      await notifyPrintFailedRefunded({ id: claimed.id, phoneNumber: claimed.phoneNumber });
    }

    return NextResponse.json({ sent: true });
  } catch (error) {
    console.error("agent/notify error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process notification." },
      { status: 500 }
    );
  }
}
