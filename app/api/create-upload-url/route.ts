import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { MAX_UPLOAD_FILE_SIZE_BYTES } from "@/lib/config";
import { getClientIp, isWithinCreateOrderRateLimit } from "@/lib/rate-limit";
import { createTempUploadUrl, tempUploadStoragePath } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * First step of checkout (components/PdfPageSelector.tsx's handleStartPayment):
 * the browser asks for a place to put the file, then uploads it straight to
 * Supabase Storage with the signed URL this returns — never through
 * /api/create-order's own request body, which is what hit Vercel's ~4.5MB
 * serverless function request-body limit for anything much bigger than a
 * few pages (a flat 413, before any application code ran at all). This
 * route's own request body is tiny regardless of the actual file's size —
 * just metadata — so it's never at risk of that same limit.
 *
 * Validates what it can up front (declared size, declared content type) so
 * an obviously-bad request never gets a signed URL at all, but this is a
 * convenience check, not the real boundary — /api/create-order re-validates
 * the actual downloaded bytes (magic header, a real pdf-lib parse, and size
 * again) once the upload has actually happened, since a client's own
 * declared metadata is never trustworthy by itself.
 */
export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    if (!(await isWithinCreateOrderRateLimit(clientIp))) {
      return jsonError("Too many print orders from this connection — please wait a minute and try again.", 429);
    }

    const body = (await request.json()) as { fileName?: unknown; fileSize?: unknown; contentType?: unknown };
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : NaN;
    const contentType = typeof body.contentType === "string" ? body.contentType : "";

    if (!fileName) return jsonError("Missing file name.");
    if (!Number.isFinite(fileSize) || fileSize <= 0) return jsonError("Missing or invalid file size.");
    if (fileSize > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return jsonError(`This file is larger than the ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} MB kiosk limit.`);
    }
    // The browser always converts to a PDF client-side before uploading
    // (lib/client-file-converter.ts) regardless of the original file's own
    // type/extension, so the declared content type here is always our own
    // label, not whatever the original upload reported — this check is
    // really just confirming the client is calling this route the way it's
    // meant to be called, not doing the original-file MIME detection
    // (that already falls back to the .pdf/.docx/image extension — see
    // isPdf/isDocx/isImageFile in lib/client-file-converter.ts).
    if (contentType !== "application/pdf") return jsonError("Only PDF uploads are accepted.");

    const uploadId = crypto.randomUUID();
    const path = tempUploadStoragePath(uploadId);
    const { signedUrl, token } = await createTempUploadUrl(path);

    return NextResponse.json({ path, token, signedUrl });
  } catch (error) {
    console.error("create-upload-url error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare the upload." },
      { status: 500 }
    );
  }
}
