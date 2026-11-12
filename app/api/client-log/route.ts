import { NextResponse } from "next/server";
import { ERROR_AREAS, type ErrorArea } from "@/lib/error-areas";
import { logError } from "@/lib/errors";
import { getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Diagnostic-only — generous enough for a real stack trace, small enough
// that this can't be turned into a meaningful log-flooding vector.
const MAX_BODY_BYTES = 8 * 1024;

function isErrorArea(value: unknown): value is ErrorArea {
  return typeof value === "string" && (ERROR_AREAS as readonly string[]).includes(value);
}

/**
 * Receives best-effort error reports from the browser — originally just
 * lib/client-log.ts (debugging the iPhone 15/15 Plus Safari PDF-upload
 * failures without physical device access), now also lib/report-error.ts
 * (any client component that caught a raw Supabase/Postgres error directly,
 * e.g. an admin page's own `supabase.from(...)` call). Logs to error_logs
 * via lib/errors.ts and hands back a reference code — lib/client-log.ts's
 * existing fire-and-forget callers ignore the response body entirely, so
 * this stays backward compatible for them.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Report too large." }, { status: 413 });
    }

    const report = JSON.parse(raw) as { stage?: unknown; area?: unknown; message?: unknown; stack?: unknown; meta?: unknown; userAgent?: unknown; url?: unknown };
    // lib/client-log.ts's older callers send `stage`, never `area` — those
    // are all upload-flow diagnostics, so "upload" is the right default.
    const area: ErrorArea = isErrorArea(report.area) ? report.area : "upload";

    // Rebuilt as a real Error (with the browser's own stack re-attached) so
    // logError's own `error.stack` extraction picks it up directly, rather
    // than passing the same stack twice via `extra`.
    const error = typeof report.message === "string" ? new Error(report.message) : report.message;
    if (error instanceof Error && typeof report.stack === "string") error.stack = report.stack;

    const { referenceCode } = await logError({
      area,
      error,
      route: typeof report.stage === "string" ? report.stage : undefined,
      userAgent: typeof report.userAgent === "string" ? report.userAgent : request.headers.get("user-agent"),
      extra: {
        meta: report.meta,
        url: report.url,
        ip: getClientIp(request),
      },
    });

    return NextResponse.json({ referenceCode });
  } catch (error) {
    // A malformed report is itself just diagnostic noise — log it and move
    // on rather than surfacing a 500 back to a client that's already failing.
    console.error("client-log: could not parse report:", error);
    return new NextResponse(null, { status: 204 });
  }
}
