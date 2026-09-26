import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Diagnostic-only — generous enough for a real stack trace, small enough
// that this can't be turned into a meaningful log-flooding vector.
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Receives best-effort error reports from lib/client-log.ts (see that
 * file's comment for why this exists — debugging the iPhone 15/15 Plus
 * Safari PDF-upload failures without physical device access). Just logs to
 * the server console; there's deliberately no database write or alerting
 * here — this is a temporary diagnostic aid, not a permanent telemetry
 * pipeline, so it stays as simple as the thing it's investigating allows.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Report too large." }, { status: 413 });
    }

    const report = JSON.parse(raw) as { stage?: unknown; message?: unknown; stack?: unknown; meta?: unknown; userAgent?: unknown; url?: unknown };
    console.error("[client-log]", {
      stage: report.stage,
      message: report.message,
      stack: report.stack,
      meta: report.meta,
      userAgent: report.userAgent,
      url: report.url,
      ip: getClientIp(request),
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // A malformed report is itself just diagnostic noise — log it and move
    // on rather than surfacing a 500 back to a client that's already failing.
    console.error("client-log: could not parse report:", error);
    return new NextResponse(null, { status: 204 });
  }
}
