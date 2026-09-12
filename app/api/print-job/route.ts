import { NextResponse } from "next/server";
import { listJobs } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only admin view of the print queue/history. Jobs are created via
 * /api/create-order and move through their lifecycle automatically:
 * pending_payment -> paid (see /api/verify-payment) -> printing -> printed,
 * driven by the Pi's separate print agent (print-agent/index.ts). Nothing
 * should POST here anymore.
 */
export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json(jobs);
}
