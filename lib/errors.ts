import { NextResponse } from "next/server";
import { type ErrorArea } from "./error-areas";
import { supabaseAdmin } from "./supabase-admin";

/**
 * The one place every server-side error becomes a short, friendly message
 * plus a reference code, instead of raw Postgres/library text reaching a
 * customer, kiosk screen, or admin page. See supabase/migrations/
 * 2026-10-29_error_logs.sql for the table this writes to and lib/
 * report-error.ts for the client-side (browser) counterpart — that one
 * can't import this file directly since it needs the service-role key,
 * which must never reach browser code. Server-only — never import this
 * from a "use client" file (see lib/error-areas.ts for the client-safe
 * area constants alone).
 */
export type { ErrorArea };

const FRIENDLY_MESSAGE = "Something went wrong. Please try again.";

// Excludes visually-confusable characters (0/O, 1/I/L) — this code is read
// off a screen and typed into the admin Error Log's search box, never
// copy-pasted from a clipboard.
const REFERENCE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REFERENCE_CODE_LENGTH = 4;

export function generateReferenceCode(): string {
  let code = "";
  for (let i = 0; i < REFERENCE_CODE_LENGTH; i++) {
    code += REFERENCE_CODE_ALPHABET[Math.floor(Math.random() * REFERENCE_CODE_ALPHABET.length)];
  }
  return code;
}

export interface LogErrorInput {
  area: ErrorArea;
  error: unknown;
  /** Route or function name this happened in — purely diagnostic, goes in `details`, never shown to the user. */
  route?: string;
  jobId?: string;
  kioskId?: string;
  userAgent?: string | null;
  /** Any other non-sensitive diagnostic context — never a secret, phone number, or payment detail (see this file's own header comment). */
  extra?: Record<string, unknown>;
}

export interface LoggedError {
  referenceCode: string;
  /** Ready to show directly: the generic friendly text plus "Ref: <code>". */
  friendlyMessage: string;
}

/**
 * Logs the real error to error_logs (best-effort — a failed insert here
 * must never turn into a SECOND, unrelated failure on top of whatever this
 * is reporting) and returns a reference code plus a ready-to-show friendly
 * message. Always logs the real error to the server console too, same as
 * every route already did before this existed, so a failed DB write still
 * leaves a trace in the platform's own logs.
 */
export async function logError(input: LogErrorInput): Promise<LoggedError> {
  const referenceCode = generateReferenceCode();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const stack = input.error instanceof Error ? input.error.stack : undefined;

  console.error(`[${input.area}] Ref ${referenceCode}${input.route ? ` (${input.route})` : ""}:`, input.error);

  try {
    await supabaseAdmin().from("error_logs").insert({
      reference_code: referenceCode,
      area: input.area,
      message,
      details: { stack, route: input.route, jobId: input.jobId, kioskId: input.kioskId, ...input.extra },
      user_agent: input.userAgent ?? null,
    });
  } catch (loggingError) {
    console.error(`[errors] Could not write error_logs row for Ref ${referenceCode}:`, loggingError);
  }

  return { referenceCode, friendlyMessage: `${FRIENDLY_MESSAGE} Ref: ${referenceCode}` };
}

/**
 * The one-call version for an API route's catch block: logs the error (see
 * logError above) and returns the JSON response to return directly —
 * `return routeErrorResponse(error, { area: "payment", route: "create-order" });`
 *
 * Pass `noStore: true` for any route a client polls expecting live data
 * (kiosk-display, kiosk-status, verify-payment) — same reasoning as
 * lib/api-response.ts's jsonNoStore, which this mirrors for the error path:
 * Vercel's default Cache-Control would otherwise let a stale error response
 * (or a stale success response) get served from the edge.
 */
export async function routeErrorResponse(error: unknown, input: Omit<LogErrorInput, "error"> & { status?: number; noStore?: boolean }): Promise<NextResponse> {
  const { status = 500, noStore = false, ...logInput } = input;
  const { friendlyMessage } = await logError({ ...logInput, error });
  return NextResponse.json(
    { error: friendlyMessage },
    { status, headers: noStore ? { "Cache-Control": "no-store, must-revalidate" } : undefined }
  );
}
