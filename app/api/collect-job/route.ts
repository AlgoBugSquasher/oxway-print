import { NextResponse } from "next/server";
import { getClientIp, isWithinCollectJobRateLimit } from "@/lib/rate-limit";
import { getJob, markJobCollected } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface CollectJobRequestBody {
  jobId?: unknown;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CollectJobRequestBody;
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) return jsonError("Missing jobId.");

    if (!(await isWithinCollectJobRateLimit(getClientIp(request)))) {
      return jsonError("Too many requests — please wait a minute and try again.", 429);
    }

    const job = await getJob(jobId);
    if (!job) return jsonError("Job not found.", 404);

    const updated = await markJobCollected(jobId, "customer");
    return NextResponse.json({ collectedAt: (updated ?? job).collectedAt ?? new Date().toISOString() });
  } catch (error) {
    console.error("collect-job error:", error);
    return jsonError(error instanceof Error ? error.message : "Could not record collection.", 500);
  }
}
